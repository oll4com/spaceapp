import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGit, WorktreeService } from "../src/worktrees/worktree-service.js";

// REV1127-002: cleanup removes a merged managed worktree whose only change is a file mode, never one holding other uncommitted work.
describe("cleaning completed worktrees", () => {
  let base: string;
  let repo: string;
  let managed: string;
  let service: WorktreeService;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "space-wt-clean-"));
    repo = join(base, "repo");
    managed = join(base, "var", "worktrees");
    await mkdir(repo);
    await mkdir(managed, { recursive: true });
    service = new WorktreeService(join(base, "registry")); // never the live registry
    await execGit(repo, ["init", "-b", "main"]);
    await execGit(repo, ["config", "user.name", "Clean Test"]);
    await execGit(repo, ["config", "user.email", "clean@space.local"]);
    await writeFile(join(repo, "run.sh"), "echo hi\n");
    await writeFile(join(repo, "logo.bin"), Buffer.from([0, 1, 2, 3]));
    await execGit(repo, ["add", "."]);
    await execGit(repo, ["commit", "-m", "init"]);
  });
  afterAll(async () => { await rm(base, { recursive: true, force: true }); });

  async function worktree(name: string, change: (path: string) => Promise<void>): Promise<string> {
    const path = join(managed, name);
    await execGit(repo, ["worktree", "add", "-b", `feat/${name}`, path, "main"]);
    await chmod(join(path, "run.sh"), 0o755);
    await change(path);
    return path;
  }

  it("keeps untracked, staged and binary work next to a mode change", async () => {
    const modeOnly = await worktree("mode-only", async () => undefined);
    const untracked = await worktree("untracked", (path) => writeFile(join(path, "notes.md"), "work\n"));
    const staged = await worktree("staged", async (path) => { await writeFile(join(path, "new.ts"), "export {};\n"); await execGit(path, ["add", "new.ts"]); });
    const binary = await worktree("binary", (path) => writeFile(join(path, "logo.bin"), Buffer.from([9, 9, 9, 9])));

    const result = await service.cleanCompletedWorktrees(repo, { excludePaths: [] });
    expect(result.cleaned.map((entry) => entry.path)).toEqual([modeOnly]);
    const kept = Object.fromEntries(result.preserved.map((entry) => [entry.path, entry.reason]));
    for (const path of [untracked, staged, binary]) expect(kept[path]).toBe("uncommitted changes (dirty)");
    expect(await stat(join(untracked, "notes.md")).then(() => true, () => false)).toBe(true);
  });
});
