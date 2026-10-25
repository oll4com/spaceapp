import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { WorktreeService } from "../src/worktrees/worktree-service.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

it("retains every concurrent registry update across services sharing a storage directory", async () => {
  const scratch = join(homedir(), "agent-workspace", "active");
  await mkdir(scratch, { recursive: true });
  const root = await mkdtemp(join(scratch, "worktree-registry-test-"));
  roots.push(root);
  const services = [new WorktreeService(root), new WorktreeService(join(root, "."))];
  const paths = Array.from({ length: 16 }, (_, index) => join(root, `wt-test-${index}`));
  await Promise.all(paths.map((worktreePath, index) => services[index % 2]!.recordWorktree({
    worktreePath, branch: `test/${index}`, baseCommit: "original-base", status: "ACTIVE"
  })));
  await Promise.all(paths.map((worktreePath, index) => services[index % 2]!.recordWorktree({
    worktreePath, status: "MERGED", mergeCommitSha: `merge-${index}`
  })));
  for (const [index, path] of paths.entries()) {
    expect(await services[0]!.getRecordedWorktree(path)).toMatchObject({
      worktreePath: path, branch: `test/${index}`, baseCommit: "original-base",
      status: "MERGED", mergeCommitSha: `merge-${index}`
    });
  }
  expect(Object.keys((await services[0]!.readRegistry()).worktrees)).toHaveLength(32);
});
