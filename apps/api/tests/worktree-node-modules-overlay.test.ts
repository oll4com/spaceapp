import { lstat, mkdir, mkdtemp, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execGit, WorktreeService } from "../src/worktrees/worktree-service.js";

describe("worktree node_modules overlay", () => {
  let base: string;
  let repo: string;
  let service: WorktreeService;

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), "space-wt-overlay-"));
    repo = join(base, "repo");
    await mkdir(join(repo, "node_modules", "left-pad"), { recursive: true });
    await mkdir(join(repo, "node_modules", ".bin"), { recursive: true });
    await writeFile(join(repo, "node_modules", ".package-lock.json"), "{}\n");
    await writeFile(join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    await mkdir(join(repo, "apps", "api", "node_modules", "nanoid"), { recursive: true });
    await writeFile(join(repo, "apps", "api", "node_modules", "nanoid", "index.js"), "module.exports = 2;\n");
    await writeFile(join(repo, ".gitignore"), "node_modules/\n");
    await execGit(repo, ["init", "-b", "main"]);
    await execGit(repo, ["config", "user.name", "Overlay Test"]);
    await execGit(repo, ["config", "user.email", "overlay@space.local"]);
    await writeFile(join(repo, "apps", "api", "package.json"), "{}\n");
    await execGit(repo, ["add", "."]);
    await execGit(repo, ["commit", "-m", "init"]);
    service = new WorktreeService(join(base, "managed"));
  });

  afterAll(async () => {
    await rm(base, { recursive: true, force: true });
  });

  it("links every entry individually so npm inside the worktree cannot rewrite the source tree", async () => {
    const worktree = await service.createWorktree({
      repoPath: repo,
      roomId: "room:overlay",
      branchName: "feat/overlay",
      baseBranch: "main",
      linkModules: true
    });
    const root = join(worktree.worktreePath, "node_modules");
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    expect((await lstat(root)).isDirectory()).toBe(true);
    expect((await readdir(root)).sort()).toEqual([".bin", ".package-lock.json", "left-pad"]);
    expect(await readlink(join(root, "left-pad"))).toBe(join(repo, "node_modules", "left-pad"));
    expect((await lstat(join(root, ".package-lock.json"))).isSymbolicLink()).toBe(true);

    const nested = join(worktree.worktreePath, "apps", "api", "node_modules");
    expect((await lstat(nested)).isDirectory()).toBe(true);
    expect(await readlink(join(nested, "nanoid"))).toBe(join(repo, "apps", "api", "node_modules", "nanoid"));

    // Replacing a package inside the worktree (what npm does) must leave the source tree intact.
    await rm(join(nested, "nanoid"), { recursive: true, force: true });
    await mkdir(join(nested, "nanoid"));
    await writeFile(join(nested, "nanoid", "index.js"), "module.exports = 3;\n");
    expect((await lstat(join(repo, "apps", "api", "node_modules", "nanoid", "index.js"))).isFile()).toBe(true);
    expect((await readdir(join(repo, "apps", "api", "node_modules", "nanoid")))).toEqual(["index.js"]);
  });
});
