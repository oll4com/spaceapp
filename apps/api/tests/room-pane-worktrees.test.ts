import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { type AgentRuntimeRegistry, type RoomPaneBatchItem, type SpaceWorktree } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomPaneCommands } from "../src/room-pane-commands.js";
import { execGit, WorktreeError, WorktreeService } from "../src/worktrees/worktree-service.js";
import { defaultWorktreeBaseBranch } from "../src/worktrees/default-base-branch.js";
import * as gitTransport from "../src/group-writable-git.js";

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

function gate() {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return { ready, release };
}

// A held worktree registration exposes an incomplete sibling to any concurrent
// enumeration, just as Git's existing-but-empty commondir reader fails closed.
async function metadataFixture(failBranch?: string) {
  const root = await scratchRoot();
  const repo = join(root, "repo"), alias = join(root, "alias"), other = join(root, "other");
  const common = join(repo, ".git"), commonAlias = join(root, "common-alias");
  await Promise.all([mkdir(common, { recursive: true }), mkdir(alias), mkdir(join(other, ".git"), { recursive: true })]);
  await symlink(common, commonAlias, process.platform === "win32" ? "junction" : "dir");
  const commonDirs = new Map([[repo, common], [alias, commonAlias], [other, join(other, ".git")]]);
  const services = ["first", "second", "other"].map(name => new WorktreeService(join(root, name)));
  for (const service of services) vi.spyOn(service, "validateGitRepository").mockImplementation(async path => path);
  const held = gate(), started = gate();
  const active = new Set<string>(), addressed = new Set<string>(), collisions: string[] = [];
  const calls: Array<{ root: string; args: string[] }> = [];
  function reply(stdout: string, stderr = "", code = 0, wait = Promise.resolve(), done = () => {}) {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true
    });
    void wait.then(() => {
      child.stdout.end(stdout); child.stderr.end(stderr); done(); child.emit("close", code);
    });
    return child as ChildProcessWithoutNullStreams;
  }
  vi.spyOn(gitTransport, "spawnGroupWritableGit").mockImplementation(args => {
    const at = args.indexOf("-C"), directory = args[at + 1]!, command = args.slice(at + 2);
    calls.push({ root: directory, args: command });
    if (command[0] === "rev-parse" && command.includes("--git-common-dir")) {
      addressed.add(directory);
      return reply(`${commonDirs.get(directory)}\n`);
    }
    if (command[0] === "show-ref") return reply("", "", command.at(-1) === "refs/heads/main" ? 0 : 1);
    if (command[0] !== "worktree") return reply(`${"a".repeat(40)}\n`);
    const key = directory === alias ? resolve(common) : resolve(commonDirs.get(directory)!);
    if (active.has(key)) {
      collisions.push(command.join(" "));
      return reply("", "fatal: failed to read .git/worktrees/publishing/commondir: empty metadata", 128);
    }
    if (command[1] !== "add") return reply("");
    const branch = command[command.indexOf("-b") + 1];
    active.add(key);
    const wait = branch === "test/held" ? held.ready : Promise.resolve();
    if (branch === "test/held") started.release();
    return reply("", branch === failBranch ? "fixture add failure" : "", branch === failBranch ? 128 : 0,
      wait, () => { active.delete(key); });
  });
  const create = (service: WorktreeService, path: string, branch: string, linkModules = false) =>
    service.createWorktree({ repoPath: path, roomId: "room:metadata", branchName: branch, baseBranch: "main", linkModules });
  return { repo, alias, other, services, held, started, addressed, collisions, calls, create };
}

it("protects shared Git metadata across service and common-directory aliases while other repositories overlap", async () => {
  const f = await metadataFixture();
  const [first, second, other] = f.services as [WorktreeService, WorktreeService, WorktreeService];
  const pending = [f.create(first, f.repo, "test/held")];
  await f.started.ready;
  const errors: unknown[] = [];
  pending.push(f.create(second, f.alias, "test/second"));
  const listed = second.listWorktrees(f.alias).catch(error => { errors.push(error); return []; });
  for (const work of pending) void work.catch(error => { errors.push(error); });
  try {
    await f.create(other, f.other, "test/other");
    await expect.poll(() => f.addressed.has(f.alias) || f.collisions.length > 0).toBe(true);
    expect(f.collisions).toEqual([]);
  } finally {
    f.held.release();
    await Promise.allSettled([...pending, listed]);
  }
  expect(errors).toEqual([]);
  expect((await pending[1]!).branch).toBe("test/second");
});

it("releases a failed metadata operation without replacing its error or poisoning the next creation", async () => {
  const f = await metadataFixture("test/fail");
  const [first, second] = f.services as [WorktreeService, WorktreeService, WorktreeService];
  const results = await Promise.allSettled([
    f.create(first, f.repo, "test/fail"), f.create(second, f.alias, "test/next")
  ]);
  expect(results[0]).toMatchObject({ status: "rejected", reason: { code: "WORKTREE_ADD_FAILED", message: "Failed to add worktree: fixture add failure" } });
  expect(results[1]).toMatchObject({ status: "fulfilled", value: { branch: "test/next" } });
  expect(f.collisions).toEqual([]);
});

it("releases shared metadata before slow module linking", async () => {
  const f = await metadataFixture();
  const [first, second] = f.services as [WorktreeService, WorktreeService, WorktreeService];
  await mkdir(join(f.repo, "node_modules"));
  const linking = gate(), entered = gate();
  vi.spyOn(WorktreeService, "linkNodeModulesOverlay").mockImplementation(async () => {
    entered.release(); await linking.ready;
  });
  const pending = f.create(first, f.repo, "test/linking", true);
  await entered.ready;
  let completed = false;
  const next = f.create(second, f.alias, "test/next").then(value => { completed = true; return value; });
  try {
    await expect.poll(() => completed, { timeout: 2000 }).toBe(true);
  } finally {
    linking.release(); await Promise.allSettled([pending, next]);
  }
  await expect(next).resolves.toMatchObject({ branch: "test/next" });
  await expect(pending).resolves.toMatchObject({ branch: "test/linking" });
});
