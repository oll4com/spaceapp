import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { execGit, WorktreeService } from "../src/worktrees/worktree-service.js";

let temporaryRoot: string;
let base: string;
let seed: string;

async function git(root: string, args: string[]) {
  const result = await execGit(root, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout.trim();
}

beforeAll(async () => {
  temporaryRoot = await realpath(tmpdir());
  base = await realpath(await mkdtemp(join(temporaryRoot, "space-wt-metadata-")));
  seed = join(base, "seed");
  await mkdir(seed);
  await git(seed, ["init", "-b", "main"]);
  await git(seed, ["config", "user.name", "Worktree Test"]);
  await git(seed, ["config", "user.email", "worktree@example.invalid"]);
  await writeFile(join(seed, "keep.txt"), "keep\n");
  await git(seed, ["add", "keep.txt"]);
  await git(seed, ["commit", "-m", "fixture"]);
});

afterAll(async () => {
  if (!base) return;
  expect(dirname(base)).toBe(temporaryRoot);
  expect(await realpath(base)).toBe(base);
  await rm(base, { recursive: true, force: true });
});

it.each(["normal", "bare", "dotgit-bare"])(
  "removes a clean linked worktree from a %s repository without removing its sibling or Git metadata",
  async (kind) => {
    let repo = seed;
    if (kind !== "normal") {
      const parent = join(base, kind);
      await mkdir(parent);
      repo = join(parent, kind === "bare" ? "repository.git" : ".git");
      await git(base, ["clone", "--bare", seed, repo]);
    }
    const head = await git(repo, ["rev-parse", "HEAD"]);
    const storage = join(base, "managed-" + kind);
    const target = join(storage, "remove");
    const sibling = join(storage, "keep");
    await mkdir(storage);
    await git(repo, ["worktree", "add", "--detach", target, "HEAD"]);
    await git(repo, ["worktree", "add", "--detach", sibling, "HEAD"]);
    const service = new WorktreeService(storage);
    await service.recordWorktree({ worktreePath: target, repoPath: repo, status: "ACTIVE" });

    await expect(service.removeWorktree(target)).resolves.toBeUndefined();

    expect(await stat(target).then(() => true, () => false)).toBe(false);
    expect(await readFile(join(sibling, "keep.txt"), "utf8")).toBe("keep\n");
    expect(await git(repo, ["rev-parse", "HEAD"])).toBe(head);
    const worktrees = await git(repo, ["worktree", "list", "--porcelain"]);
    expect(worktrees.replaceAll("\\", "/")).not.toContain(target.replaceAll("\\", "/"));
    expect(worktrees.replaceAll("\\", "/")).toContain(sibling.replaceAll("\\", "/"));
    expect(await service.getRecordedWorktree(target)).toMatchObject({ status: "DISCARDED" });
  }
);
