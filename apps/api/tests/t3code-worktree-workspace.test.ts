import { tmpdir } from "node:os";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { execGit } from "../src/worktrees/worktree-service.js";

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture() {
  const module = await import("../src/t3code/worktree-workspace.js").catch(() => ({} as any));
  expect(typeof module.t3WorktreeWorkspace, "T3 worktree workspace check is missing").toBe("function");
  const root = await mkdtemp(join(tmpdir(), "t3-worktree-workspace-"));
  cleanup.push(root);
  const repo = join(root, "repo"), other = join(root, "other"), worktrees = join(root, "worktrees");
  for (const path of [repo, other, worktrees]) await mkdir(path);
  for (const path of [repo, other]) {
    expect((await execGit(path, ["init", "-q", "-b", "main"])).code).toBe(0);
    await writeFile(join(path, "fixture.txt"), "owned fixture\n");
    expect((await execGit(path, ["add", "."])).code).toBe(0);
    expect((await execGit(path, ["-c", "user.name=Test", "-c", "user.email=test@local", "commit", "-q", "-m", "fixture"])).code).toBe(0);
  }
  const owned = join(worktrees, "space", "wt-owned"), foreign = join(worktrees, "other", "wt-foreign"), outside = join(root, "wt-outside");
  expect((await execGit(repo, ["worktree", "add", "-q", "-b", "space/wt-owned", owned])).code).toBe(0);
  expect((await execGit(other, ["worktree", "add", "-q", "-b", "space/wt-foreign", foreign])).code).toBe(0);
  expect((await execGit(repo, ["worktree", "add", "-q", "-b", "space/wt-outside", outside])).code).toBe(0);
  const check = (candidate: string) => module.t3WorktreeWorkspace(candidate, worktrees) as Promise<string | null>;
  return { module, root, repo, other, worktrees, owned, foreign, outside, check };
}

it("accepts the root of a managed linked worktree of any room repository, as CLI panes use", async () => {
  const f = await fixture();
  expect(await f.check(f.owned)).toBe(f.owned);
  expect(await f.check(f.owned + "/")).toBe(f.owned);
  expect(await f.check(f.foreign)).toBe(f.foreign);
});

it("refuses the main checkout, subdirectories and unmanaged locations", async () => {
  const f = await fixture();
  await mkdir(join(f.owned, "src"));
  await mkdir(join(f.worktrees, "space", "plain"));
  await symlink(f.owned, join(f.worktrees, "space", "alias"));
  for (const candidate of [f.repo, join(f.owned, "src"), f.outside, join(f.worktrees, "space", "plain"),
    f.worktrees, join(f.worktrees, "space", "missing"), "relative/path", "/etc", f.owned + "\u0000"]) {
    expect(await f.check(candidate), candidate).toBeNull();
  }
  // A symlink resolves to the same real worktree; it is not a second workspace.
  expect(await f.check(join(f.worktrees, "space", "alias"))).toBe(f.owned);
});

it("refuses a forged .git pointer that the repository does not link back to", async () => {
  const f = await fixture();
  const forged = join(f.worktrees, "space", "wt-forged");
  await mkdir(forged);
  const gitDir = (await execGit(f.owned, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
  await writeFile(join(forged, ".git"), `gitdir: ${gitDir}\n`);
  expect(await f.check(forged)).toBeNull();
  expect(await f.check(f.owned)).toBe(f.owned);
});

it("accepts a room's own project directory under the CLI-writable roots, never the live checkout", async () => {
  const f = await fixture();
  const project = (candidate: string, projectPath: string | null, roots = [f.root]) =>
    f.module.t3RoomProjectWorkspace(candidate, projectPath, roots) as Promise<string | null>;
  expect(await project(f.other, f.other)).toBe(f.other);
  expect(await project(f.other + "/", f.other)).toBe(f.other);
  // Only the room's configured project, an existing directory inside the roots.
  expect(await project(f.other, f.repo)).toBeNull();
  expect(await project(f.other, null)).toBeNull();
  expect(await project(join(f.root, "missing"), join(f.root, "missing"))).toBeNull();
  expect(await project("/etc", "/etc")).toBeNull();
  expect(await project(f.root, f.root)).toBeNull();
  await symlink("/etc", join(f.root, "escape"));
  expect(await project(join(f.root, "escape"), join(f.root, "escape"))).toBeNull();
  expect(await project("/opt/spaceapp", "/opt/spaceapp", ["/srv"])).toBeNull();
  expect(f.module.T3_WRITABLE_ROOTS).toEqual(["/srv", "/var/lib/spaceapp-user"]);
});
