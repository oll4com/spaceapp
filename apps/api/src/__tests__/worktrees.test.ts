import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execGit, WorktreeService } from "../worktrees/worktree-service.js";

describe("WorktreeService", () => {
  let tempRepo: string;
  let tempStorage: string;
  let service: WorktreeService;

  beforeAll(async () => {
    tempRepo = await mkdtemp(join(tmpdir(), "space-wt-test-repo-"));
    tempStorage = await mkdtemp(join(tmpdir(), "space-wt-test-storage-"));
    service = new WorktreeService(tempStorage);

    // Initialize test git repo
    await execGit(tempRepo, ["init", "-b", "main"]);
    await execGit(tempRepo, ["config", "user.name", "Test Runner"]);
    await execGit(tempRepo, ["config", "user.email", "test@space.local"]);

    await writeFile(join(tempRepo, "README.md"), "# Test Project\n");
    await execGit(tempRepo, ["add", "README.md"]);
    await execGit(tempRepo, ["commit", "-m", "Initial commit"]);
  });

  afterAll(async () => {
    await rm(tempRepo, { recursive: true, force: true }).catch(() => {});
    await rm(tempStorage, { recursive: true, force: true }).catch(() => {});
  });

  it("validates a real git repository correctly", async () => {
    const root = await service.validateGitRepository(tempRepo);
    expect(root).toBe(tempRepo);
  });

  it("creates an isolated worktree with custom branch", async () => {
    const wt = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:test-1",
      branchName: "feat/isolated-agent-task",
      baseBranch: "main",
      linkModules: false
    });

    expect(wt.id).toMatch(/^wt-/);
    expect(wt.branch).toBe("feat/isolated-agent-task");
    expect(wt.status).toBe("ACTIVE");
    expect(wt.worktreePath).toContain(tempStorage);

    // Verify worktree file system exists
    const readme = await readFile(join(wt.worktreePath, "README.md"), "utf8");
    expect(readme).toBe("# Test Project\n");

    // Modify a file in the worktree
    await writeFile(join(wt.worktreePath, "feature.txt"), "New feature created by agent");
    await execGit(wt.worktreePath, ["add", "feature.txt"]);
    await execGit(wt.worktreePath, ["commit", "-m", "Add feature from agent"]);

    // Main repo should NOT have feature.txt
    const mainHasFile = await readFile(join(tempRepo, "feature.txt"), "utf8").catch(() => null);
    expect(mainHasFile).toBeNull();

    // Worktree list should report the worktree
    const list = await service.listWorktrees(tempRepo);
    expect(list.length).toBeGreaterThanOrEqual(2); // root + created worktree
    const found = list.find((item) => item.worktreePath === wt.worktreePath);
    expect(found).toBeDefined();
    expect(found?.branch).toBe("feat/isolated-agent-task");

    // Merge the worktree back into main
    const mergeResult = await service.mergeWorktree(wt.worktreePath, {
      strategy: "merge",
      deleteBranchAfter: true
    });
    expect(mergeResult.ok).toBe(true);
    expect(mergeResult.commitSha).toBeTruthy();

    // Now main repo should have feature.txt
    const mainFeature = await readFile(join(tempRepo, "feature.txt"), "utf8");
    expect(mainFeature).toBe("New feature created by agent");
  });

  it("keeps checkouts group-writable for pane CLIs running as another user", async () => {
    // The API service runs with umask 022 while pane CLIs run as a different
    // member of the service group.
    const repo = await mkdtemp(join(tmpdir(), "space-wt-test-shared-"));
    const previousUmask = process.umask(0o022);
    try {
      await execGit(repo, ["init", "-b", "main"]);
      await execGit(repo, ["config", "user.name", "Test Runner"]);
      await execGit(repo, ["config", "user.email", "test@space.local"]);
      await mkdir(join(repo, "src"));
      await writeFile(join(repo, "src", "index.ts"), "export {};\n");
      await execGit(repo, ["add", "src/index.ts"]);
      await execGit(repo, ["commit", "-m", "Initial commit"]);

      const wt = await service.createWorktree({
        repoPath: repo, roomId: "room:test-shared", baseBranch: "main", linkModules: false
      });
      const gitDir = (await execGit(wt.worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
      for (const path of [join(wt.worktreePath, "src"), join(wt.worktreePath, "src", "index.ts"), gitDir, join(gitDir, "HEAD")]) {
        expect((await stat(path)).mode & 0o020, path).toBe(0o020);
      }
    } finally {
      process.umask(previousUmask);
      await rm(repo, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("handles worktree removal cleanly", async () => {
    const wt = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:test-2",
      branchName: "feat/to-be-discarded",
      baseBranch: "main",
      linkModules: false
    });

    await service.removeWorktree(wt.worktreePath, true);

    const exists = await readFile(join(wt.worktreePath, "README.md"), "utf8").catch(() => null);
    expect(exists).toBeNull();
  });

  it("exposes working REST API endpoints via Fastify", async () => {
    const { default: Fastify } = await import("fastify");
    const { registerWorktreeRoutes } = await import("../worktrees/worktree-routes.js");
    const app = Fastify();
    registerWorktreeRoutes(app, { service });

    // 1. GET /api/worktrees
    const getRes = await app.inject({
      method: "GET",
      url: `/api/worktrees?repoPath=${encodeURIComponent(tempRepo)}`
    });
    expect(getRes.statusCode).toBe(200);
    const getJson = JSON.parse(getRes.payload);
    expect(Array.isArray(getJson.data)).toBe(true);

    // 2. POST /api/worktrees
    const postRes = await app.inject({
      method: "POST",
      url: "/api/worktrees",
      payload: {
        repoPath: tempRepo,
        roomId: "room:route-test",
        branchName: "feat/via-rest-api",
        baseBranch: "main",
        linkModules: false
      }
    });
    expect(postRes.statusCode).toBe(200);
    const postJson = JSON.parse(postRes.payload);
    expect(postJson.ok).toBe(true);
    expect(postJson.data.branch).toBe("feat/via-rest-api");

    const createdPath = postJson.data.worktreePath;

    // 3. DELETE /api/worktrees?path=...&force=true
    const delRes = await app.inject({
      method: "DELETE",
      url: `/api/worktrees?path=${encodeURIComponent(createdPath)}&force=true`
    });
    expect(delRes.statusCode).toBe(200);
    const delJson = JSON.parse(delRes.payload);
    expect(delJson.ok).toBe(true);

    // 4. POST /api/worktrees/clean
    const cleanRes = await app.inject({
      method: "POST",
      url: "/api/worktrees/clean",
      payload: {
        repoPath: tempRepo,
        dryRun: false
      }
    });
    expect(cleanRes.statusCode).toBe(200);
    const cleanJson = JSON.parse(cleanRes.payload);
    expect(cleanJson.ok).toBe(true);
    expect(Array.isArray(cleanJson.cleaned)).toBe(true);
    expect(Array.isArray(cleanJson.preserved)).toBe(true);

    await app.close();
  });

  it("cleans merged worktrees while safely preserving dirty worktrees", async () => {
    // 1. Create a worktree and merge it into main
    const wtMerged = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:clean-merged",
      branchName: "feat/to-clean-merged",
      baseBranch: "main",
      linkModules: false
    });
    await writeFile(join(wtMerged.worktreePath, "clean-sample.txt"), "sample");
    await execGit(wtMerged.worktreePath, ["add", "clean-sample.txt"]);
    await execGit(wtMerged.worktreePath, ["commit", "-m", "sample commit"]);
    // Merge branch into main without deleting worktree
    await execGit(tempRepo, ["merge", "--no-ff", "-m", "Merge test branch", "feat/to-clean-merged"]);

    // 2. Create another worktree with uncommitted changes (dirty)
    const wtDirty = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:preserve-dirty",
      branchName: "feat/to-preserve-dirty",
      baseBranch: "main",
      linkModules: false
    });
    await writeFile(join(wtDirty.worktreePath, "dirty-uncommitted.txt"), "wip");

    // 3. Run cleanCompletedWorktrees
    const result = await service.cleanCompletedWorktrees(tempRepo, { force: false });

    // wtMerged should be cleaned
    const cleanedEntry = result.cleaned.find((item) => item.path === wtMerged.worktreePath);
    expect(cleanedEntry).toBeDefined();

    // wtDirty should be preserved due to dirty status
    const preservedEntry = result.preserved.find((item) => item.path === wtDirty.worktreePath);
    expect(preservedEntry).toBeDefined();
    expect(preservedEntry?.reason).toContain("dirty");

    // Clean up dirty worktree
    await service.removeWorktree(wtDirty.worktreePath, true);
  });

  it("deterministically resolves already merged worktrees without error", async () => {
    // 1. Create a worktree and make a commit
    const wt = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:already-merged-test",
      branchName: "feat/deterministic-merged",
      baseBranch: "main",
      linkModules: false
    });
    await writeFile(join(wt.worktreePath, "feature2.txt"), "feature 2 content");
    await execGit(wt.worktreePath, ["add", "feature2.txt"]);
    await execGit(wt.worktreePath, ["commit", "-m", "feature 2 commit"]);

    // 2. Merge it into main
    const firstMerge = await service.mergeWorktree(wt.worktreePath, { strategy: "merge", deleteBranchAfter: true });
    expect(firstMerge.ok).toBe(true);

    // 3. getWorktree should now recognize it as MERGED deterministically
    const wtCheck = await service.getWorktree(wt.worktreePath);
    expect(wtCheck).not.toBeNull();
    expect(wtCheck?.status).toBe("MERGED");

    // 4. Calling mergeWorktree again on this already merged worktree must succeed idempotently
    const secondMerge = await service.mergeWorktree(wt.worktreePath, { strategy: "merge", deleteBranchAfter: true });
    expect(secondMerge.ok).toBe(true);
    expect(secondMerge.alreadyMerged).toBe(true);
  });

  it("throws clear 404 for completely non-existent non-worktree paths without saying 'or already merged'", async () => {
    await expect(service.mergeWorktree("/tmp/totally-fake-never-existed-path")).rejects.toThrow(
      "Worktree not found for /tmp/totally-fake-never-existed-path."
    );
  });

  it("reads branch, HEAD, dirty state and repository like before, and rewrites the registry only on a change", async () => {
    const wt = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:badge-read-test",
      branchName: "feat/badge-read",
      baseBranch: "main",
      linkModules: false
    });
    const head = (await execGit(wt.worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const clean = await service.getWorktree(wt.worktreePath);
    expect(clean).toMatchObject({ branch: "feat/badge-read", baseCommit: head, isDirty: false, status: "ACTIVE", aheadCount: 0 });
    expect(clean?.repoPath).toBe(await realpath(tempRepo));
    await writeFile(join(wt.worktreePath, "untracked.txt"), "new\n");
    expect(await service.getWorktree(wt.worktreePath)).toMatchObject({ isDirty: true, status: "DIRTY" });
    await execGit(wt.worktreePath, ["checkout", "-q", "--detach"]);
    expect(await service.getWorktree(wt.worktreePath)).toMatchObject({ branch: "", baseCommit: head });

    const registry = join(tempStorage, ".worktree-registry.json");
    const record = { worktreePath: wt.worktreePath, branch: "feat/badge-read", baseCommit: head, status: "DIRTY" as const };
    await service.recordWorktree(record);
    const before = await stat(registry);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await service.recordWorktree(record);
    const unchanged = await stat(registry);
    expect([unchanged.ino, unchanged.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    await service.recordWorktree({ ...record, status: "ACTIVE" });
    expect((await stat(registry)).mtimeMs).not.toBe(before.mtimeMs);
    expect((await service.getRecordedWorktree(wt.worktreePath))?.status).toBe("ACTIVE");
    await service.removeWorktree(wt.worktreePath, true);
  });

  it("preserves ACTIVE status for freshly created clean worktrees on disk", async () => {
    const wtFresh = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:active-status-test",
      branchName: "feat/remain-active-check",
      baseBranch: "main",
      linkModules: false
    });

    const check = await service.getWorktree(wtFresh.worktreePath);
    expect(check).not.toBeNull();
    expect(check?.status).toBe("ACTIVE");

    const list = await service.listWorktrees(tempRepo);
    const inList = list.find((item) => item.worktreePath === wtFresh.worktreePath);
    expect(inList).toBeDefined();
    expect(inList?.status).toBe("ACTIVE");

    await service.removeWorktree(wtFresh.worktreePath, true);
  });

  it("supports repeating merge cycles when agent creates new changes in retained worktree", async () => {
    const wt = await service.createWorktree({
      repoPath: tempRepo,
      roomId: "room:multi-cycle-test",
      branchName: "feat/multi-cycle-branch",
      baseBranch: "main",
      linkModules: false
    });

    // Cycle 1: Agent creates changes
    await writeFile(join(wt.worktreePath, "cycle1.txt"), "hello cycle 1");
    let statusCheck = await service.getWorktree(wt.worktreePath);
    expect(statusCheck?.isDirty).toBe(true);
    expect(statusCheck?.status).toBe("DIRTY");

    // Merge cycle 1 with deleteBranchAfter: false
    const merge1 = await service.mergeWorktree(wt.worktreePath, { strategy: "merge", deleteBranchAfter: false });
    expect(merge1.ok).toBe(true);

    // After merge, worktree is recognized as MERGED and clean
    statusCheck = await service.getWorktree(wt.worktreePath);
    expect(statusCheck?.status).toBe("MERGED");
    expect(statusCheck?.isDirty).toBe(false);
    expect(statusCheck?.aheadCount).toBe(0);

    // Cycle 2: Agent creates new changes in the same worktree!
    await writeFile(join(wt.worktreePath, "cycle2.txt"), "hello cycle 2");
    statusCheck = await service.getWorktree(wt.worktreePath);
    expect(statusCheck?.isDirty).toBe(true);
    expect(statusCheck?.status).toBe("DIRTY");

    // Merge cycle 2 with deleteBranchAfter: false
    const merge2 = await service.mergeWorktree(wt.worktreePath, { strategy: "merge", deleteBranchAfter: false });
    expect(merge2.ok).toBe(true);

    statusCheck = await service.getWorktree(wt.worktreePath);
    expect(statusCheck?.status).toBe("MERGED");
    expect(statusCheck?.isDirty).toBe(false);

    // Clean up
    await service.removeWorktree(wt.worktreePath, true);
  });
});

