import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { type AgentRuntimeRegistry, type RoomPaneBatchItem, type SpaceWorktree } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomPaneCommands } from "../src/room-pane-commands.js";
import { execGit, WorktreeError, WorktreeService } from "../src/worktrees/worktree-service.js";
import { defaultWorktreeBaseBranch } from "../src/worktrees/default-base-branch.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function scratchRoot() {
  const base = join(homedir(), "agent-workspace", "active");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "pane-worktrees-test-"));
  roots.push(root);
  return root;
}

function setup(service: WorktreeService, projectPath: string) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Provisioning", projectPath, initialPaneCount: 0 });
  const registry: AgentRuntimeRegistry = {
    checkedAt: new Date().toISOString(),
    data: ["codex", "opencode"].map(id => ({
      id: `cli:${id}`, providerId: id, providerName: id, agentId: id, agentName: id, displayName: id,
      capabilities: ["CLI"], adapterStatus: "ENABLED", authMode: "NONE", authState: "READY",
      authReason: "Test fixture", canStartLogin: false, status: "ENABLED", statusReason: "Test fixture",
      commandName: id, detectedCommandPath: null, defaultModelId: null, supportedReasoningEfforts: [],
      checkedAt: new Date().toISOString()
    }))
  };
  return { room, commands: createRoomPaneCommands({ store, worktreeService: service,
    discover: async () => registry, enabledRuntimeIds: async () => registry.data.map(runtime => runtime.id),
    harnessAvailable: async () => true }) };
}

function items(count: number): RoomPaneBatchItem[] {
  return Array.from({ length: count }, (_, index) => ({ mode: "TERMINAL",
    terminalRuntimeId: index % 2 ? "cli:opencode" : "cli:codex", useWorktree: true,
    worktreeBranch: `test/pane-${index}` }));
}

it("overlaps slow cold provisioning within a bound, preserving order and failure fallback", async () => {
  const service = new WorktreeService(await scratchRoot());
  const { room, commands } = setup(service, "/test/project");
  let active = 0, peak = 0, released = false;
  const release: Array<() => void> = [];
  vi.spyOn(service, "createWorktree").mockImplementation(async input => {
    active++;
    peak = Math.max(peak, active);
    try {
      if (!released) await new Promise<void>(resolve => release.push(resolve));
      if (input.branchName === "test/pane-2") throw new Error("fixture failure");
      return { worktreePath: `/test/${input.branchName}` } as SpaceWorktree;
    } finally { active--; }
  });
  const result = commands.resolve(room.id, [...items(12), { mode: "FILES" }]);
  try {
    await expect.poll(() => active, { timeout: 500 }).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
  } finally {
    released = true;
    release.reverse().forEach(resolve => resolve());
    await result;
  }
  expect((await result).map(pane => pane.cwd)).toEqual([
    "/test/test/pane-0", "/test/test/pane-1", "/test/project", "/test/test/pane-3",
    "/test/test/pane-4", "/test/test/pane-5", "/test/test/pane-6", "/test/test/pane-7",
    "/test/test/pane-8", "/test/test/pane-9", "/test/test/pane-10", "/test/test/pane-11", "/test/project"
  ]);
  expect((await result).slice(0, 4).map(pane => pane.terminalRuntimeId))
    .toEqual(["cli:codex", "cli:opencode", "cli:codex", "cli:opencode"]);
  expect(active).toBe(0);
  expect(peak).toBeLessThanOrEqual(4);
});

it("validates the whole batch before creating any worktree", async () => {
  const service = new WorktreeService(await scratchRoot());
  const { room, commands } = setup(service, "/test/project");
  const create = vi.spyOn(service, "createWorktree").mockResolvedValue({ worktreePath: "/test/new" } as SpaceWorktree);
  await expect(commands.resolve(room.id, [...items(1), { mode: "TERMINAL", terminalRuntimeId: "cli:missing" }]))
    .rejects.toThrow("Pane type is not in the room command catalog.");
  expect(create).not.toHaveBeenCalled();
});

it.each([false, true])("creates sixteen isolated and recorded Git worktrees (unborn repository: %s)", async unborn => {
  const root = await scratchRoot();
  const repo = join(root, "repo");
  await mkdir(repo);
  expect((await execGit(repo, ["init", "-b", "main"])).code).toBe(0);
  await writeFile(join(repo, "fixture.txt"), "owned fixture\n");
  if (!unborn) {
    expect((await execGit(repo, ["add", "."])).code).toBe(0);
    expect((await execGit(repo, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-m", "fixture"])).code).toBe(0);
  }
  const service = new WorktreeService(join(root, "worktrees"));
  const { room, commands } = setup(service, repo);
  const createWorktree = service.createWorktree.bind(service);
  const provisioningErrors: Array<{ branch: string | null; code: string | null; message: string; truncated: boolean }> = [];
  vi.spyOn(service, "createWorktree").mockImplementation(async input => {
    try {
      return await createWorktree(input);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      provisioningErrors.push({ branch: input.branchName ?? null, code: error instanceof WorktreeError ? error.code : null,
        message: message.slice(0, 4096), truncated: message.length > 4096 });
      throw error;
    }
  });
  const panes = await commands.resolve(room.id, items(16));
  expect(provisioningErrors).toEqual([]);
  expect(new Set(panes.map(pane => pane.cwd)).size).toBe(16);
  for (const [index, pane] of panes.entries()) {
    expect(pane.cwd).not.toBe(repo);
    expect(await readFile(join(pane.cwd!, "fixture.txt"), "utf8")).toBe("owned fixture\n");
    expect(await service.getRecordedWorktree(pane.cwd!)).toMatchObject({ branch: `test/pane-${index}`, status: "ACTIVE" });
  }
  expect(Object.keys((await service.readRegistry()).worktrees)).toHaveLength(32);
  if (unborn) expect((await execGit(repo, ["rev-list", "--count", "main"])).stdout.trim()).toBe("1");
}, 30_000);

it("gives a T3 Code pane its own worktree of the room project, as for CLI panes", async () => {
  const service = new WorktreeService(await scratchRoot());
  const create = vi.spyOn(service, "createWorktree").mockImplementation(async input =>
    ({ worktreePath: `/opt/spaceapp/var/worktrees/wt-t3-${input.repoPath.split("/").pop()}` }) as SpaceWorktree);
  for (const [projectPath, repoPath] of [["/opt/spaceapp", "/opt/spaceapp"], [null, "/opt/spaceapp"], ["/test/project", "/test/project"]] as const) {
    const { room, commands } = setup(service, projectPath as string);
    const [isolated, shared] = await commands.resolve(room.id, [{ mode: "T3CODE", useWorktree: true }, { mode: "T3CODE" }]);
    expect(isolated).toMatchObject({ mode: "T3CODE", cwd: `/opt/spaceapp/var/worktrees/wt-t3-${repoPath.split("/").pop()}` });
    expect(shared!.cwd).toBeUndefined();
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ repoPath, baseBranch: defaultWorktreeBaseBranch(repoPath), linkModules: true, branchName: undefined }));
  }
  expect(create).toHaveBeenCalledTimes(3);
});
