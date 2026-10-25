import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CreateWorktreeInput,
  MergeWorktreeInput,
  SpaceWorktree,
  WorktreeOperationResult,
  WorktreeStatus
} from "@space/contracts";
import { GIT_NOT_FOUND_EXIT_CODE, spawnGroupWritableGit } from "../group-writable-git.js";

import { WorktreeError } from "./worktree-error.js";
import { assertRemovableWorktreePath } from "./worktree-removal-guard.js";

export { WorktreeError };

export const WORKTREES_ROOT = process.env.SPACE_WORKTREES_ROOT || "/opt/spaceapp/var/worktrees";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function execGit(root: string, args: string[], timeoutMs = 25000): Promise<GitExecResult> {
  return new Promise((resolveResult, reject) => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null"
    };
    const ownProcessGroup = process.platform !== "win32";
    const child = spawnGroupWritableGit([
      "--no-optional-locks",
      "-c", `safe.directory=*`,
      "-c", "credential.helper=",
      "-c", "core.fsmonitor=false",
      "-c", "core.untrackedCache=false",
      "-C", root,
      ...args
    ], env);

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const stop = () => {
      try {
        if (ownProcessGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new WorktreeError("GIT_UNAVAILABLE", `Git failed to spawn: ${err.message}`, 503));
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new WorktreeError("GIT_TIMEOUT", "Git command timed out.", 504));
      }
      // The umask wrapper reports a missing git binary as an exit status, not a spawn error.
      if (ownProcessGroup && code === GIT_NOT_FOUND_EXIT_CODE) {
        return reject(new WorktreeError("GIT_UNAVAILABLE", "Git failed to spawn: git not found", 503));
      }
      resolveResult({ stdout, stderr, code: code ?? 0 });
    });
  });
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

export interface WorktreeRecord {
  id: string;
  worktreePath: string;
  repoPath: string;
  branch: string;
  baseBranch: string;
  baseCommit?: string;
  /** The room and pane that created the worktree, so the Room Agent knows where each pane works. */
  roomId?: string;
  paneId?: string;
  status: WorktreeStatus;
  mergeCommitSha?: string;
  createdAt: string;
  updatedAt: string;
  mergedAt?: string;
  discardedAt?: string;
}

export interface WorktreeRegistryData {
  version: 1;
  worktrees: Record<string, WorktreeRecord>;
}

// All API service instances sharing a registry must serialize read/modify/write.
// Atomic rename alone protects the file, but can still lose concurrent records.
const registryUpdates = new Map<string, Promise<void>>();
const repositoryInitializations = new Map<string, Promise<void>>();

export class WorktreeService {
  constructor(private readonly baseStorageDir = WORKTREES_ROOT) {}

  get registryPath(): string {
    return join(this.baseStorageDir, ".worktree-registry.json");
  }

  async readRegistry(): Promise<WorktreeRegistryData> {
    try {
      const data = await readFile(this.registryPath, "utf8");
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed.worktrees === "object") {
        return parsed as WorktreeRegistryData;
      }
    } catch {}
    return { version: 1, worktrees: {} };
  }

  async writeRegistry(registry: WorktreeRegistryData): Promise<void> {
    try {
      await mkdir(this.baseStorageDir, { recursive: true });
      const tmpPath = `${this.registryPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
      await writeFile(tmpPath, JSON.stringify(registry, null, 2), "utf8");
      await chmod(tmpPath, 0o664).catch(() => {});
      await rename(tmpPath, this.registryPath);
    } catch {
      // Best-effort registry write
    }
  }

  async recordWorktree(record: Partial<WorktreeRecord> & { worktreePath: string }): Promise<void> {
    const key = resolve(this.registryPath);
    const previous = registryUpdates.get(key) ?? Promise.resolve();
    const update = previous.then(() => this.updateRecordedWorktree(record));
    registryUpdates.set(key, update);
    try {
      await update;
    } finally {
      if (registryUpdates.get(key) === update) registryUpdates.delete(key);
    }
  }

  private async updateRecordedWorktree(record: Partial<WorktreeRecord> & { worktreePath: string }): Promise<void> {
    try {
      const reg = await this.readRegistry();
      const normPath = resolve(record.worktreePath);
      const wtId = basename(normPath);
      const existing = reg.worktrees[normPath] || reg.worktrees[wtId];
      const now = new Date().toISOString();
      const updated: WorktreeRecord = {
        id: record.id || existing?.id || `wt:${wtId}`,
        worktreePath: normPath,
        repoPath: record.repoPath || existing?.repoPath || "/opt/spaceapp",
        branch: record.branch || existing?.branch || `space/${wtId}`,
        baseBranch: record.baseBranch || existing?.baseBranch || "main",
        baseCommit: record.baseCommit || existing?.baseCommit || "",
        roomId: record.roomId || existing?.roomId,
        paneId: record.paneId || existing?.paneId,
        status: record.status || existing?.status || "ACTIVE",
        mergeCommitSha: record.mergeCommitSha || existing?.mergeCommitSha,
        createdAt: existing?.createdAt || record.createdAt || now,
        updatedAt: now,
        mergedAt: record.mergedAt || (record.status === "MERGED" ? (existing?.mergedAt || now) : existing?.mergedAt),
        discardedAt: record.discardedAt || (record.status === "DISCARDED" ? (existing?.discardedAt || now) : existing?.discardedAt)
      };
      reg.worktrees[normPath] = updated;
      reg.worktrees[wtId] = updated;
      await this.writeRegistry(reg);
    } catch {}
  }

  async getRecordedWorktree(worktreePath: string): Promise<WorktreeRecord | null> {
    try {
      const reg = await this.readRegistry();
      const normPath = resolve(worktreePath);
      const wtId = basename(normPath);
      return reg.worktrees[normPath] || reg.worktrees[wtId] || null;
    } catch {
      return null;
    }
  }

  async validateGitRepository(repoPath: string): Promise<string> {
    const root = await realpath(repoPath);
    const stat = await lstat(root);
    if (!stat.isDirectory()) {
      throw new WorktreeError("INVALID_PATH", `Path ${repoPath} is not a directory.`);
    }
    const check = await execGit(root, ["rev-parse", "--is-inside-work-tree"]);
    if (check.code !== 0 || !check.stdout.includes("true")) {
      throw new WorktreeError("NOT_GIT_REPO", `Path ${repoPath} is not a valid Git repository.`);
    }
    const commonDirCheck = await execGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (commonDirCheck.code === 0 && commonDirCheck.stdout.trim()) {
      const commonDir = commonDirCheck.stdout.trim();
      if (commonDir.endsWith("/.git")) {
        return dirname(commonDir);
      }
    }
    const toplevel = await execGit(root, ["rev-parse", "--show-toplevel"]);
    return toplevel.stdout.trim() || root;
  }

  async createWorktree(input: CreateWorktreeInput): Promise<SpaceWorktree> {
    const repoRoot = await this.validateGitRepository(input.repoPath);
    const repoSlug = slugify(basename(repoRoot)) || "repo";
    const worktreeId = `wt-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const targetDir = join(this.baseStorageDir, repoSlug, worktreeId);

    // Share initialization so parallel checkouts cannot race on an unborn
    // repository's index or create several independent initial commits.
    let initialization = repositoryInitializations.get(repoRoot);
    if (!initialization) {
      initialization = (async () => {
        const repoHeadCheck = await execGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
        if (repoHeadCheck.code !== 0) {
          await execGit(repoRoot, ["add", "-A"]);
          await execGit(repoRoot, ["-c", "user.name=SpaceApp", "-c", "user.email=space@local", "commit", "-m", "chore: initial commit", "--allow-empty"]);
        }
      })();
      repositoryInitializations.set(repoRoot, initialization);
    }
    try {
      await initialization;
    } finally {
      if (repositoryInitializations.get(repoRoot) === initialization) repositoryInitializations.delete(repoRoot);
    }

    // Determine base branch (fallback to current branch if specified base does not exist)
    let baseBranch = input.baseBranch?.trim() || "main";
    const baseBranchRefCheck = await execGit(repoRoot, ["show-ref", "--verify", `refs/heads/${baseBranch}`]);
    if (baseBranchRefCheck.code !== 0) {
      const currentBranchCheck = await execGit(repoRoot, ["branch", "--show-current"]);
      const current = currentBranchCheck.stdout.trim();
      if (current) {
        baseBranch = current;
      }
    }

    // Determine branch name
    const branchName = input.branchName?.trim() || `space/${worktreeId}`;

    // Ensure parent directory exists
    await mkdir(dirname(targetDir), { recursive: true, mode: 0o775 });
    await chmod(dirname(targetDir), 0o775).catch(() => {});

    // Check if branch already exists in repo
    const branchCheck = await execGit(repoRoot, ["show-ref", "--verify", `refs/heads/${branchName}`]);
    const branchExists = branchCheck.code === 0;

    // Check if branch is already checked out elsewhere
    if (branchExists) {
      const listCheck = await execGit(repoRoot, ["worktree", "list", "--porcelain"]);
      if (listCheck.stdout.includes(`refs/heads/${branchName}`)) {
        throw new WorktreeError(
          "BRANCH_ALREADY_CHECKED_OUT",
          `Branch ${branchName} is already checked out in another worktree.`
        );
      }
    }

    // Run git worktree add
    const addArgs = branchExists
      ? ["worktree", "add", targetDir, branchName]
      : ["worktree", "add", targetDir, "-b", branchName, baseBranch];

    const result = await execGit(repoRoot, addArgs);
    if (result.code !== 0) {
      throw new WorktreeError("WORKTREE_ADD_FAILED", `Failed to add worktree: ${result.stderr.trim()}`);
    }
    await chmod(targetDir, 0o775).catch(() => {});

    // Link modules and environment if requested
    if (input.linkModules) {
      await this.linkDependenciesAndConfig(repoRoot, targetDir);
    }

    // Get base commit
    const headCheck = await execGit(targetDir, ["rev-parse", "HEAD"]);
    const baseCommit = headCheck.stdout.trim();

    const now = new Date().toISOString();
    await this.recordWorktree({
      id: worktreeId,
      worktreePath: targetDir,
      repoPath: repoRoot,
      branch: branchName,
      baseBranch,
      baseCommit,
      roomId: input.roomId,
      ...(input.paneId ? { paneId: input.paneId } : {}),
      status: "ACTIVE",
      createdAt: now
    });

    return {
      id: worktreeId,
      repoPath: repoRoot,
      worktreePath: targetDir,
      branch: branchName,
      baseBranch,
      baseCommit,
      roomId: input.roomId,
      paneId: input.paneId ?? null,
      status: "ACTIVE",
      isDirty: false,
      aheadCount: 0,
      behindCount: 0,
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Materialises a node_modules directory as per-entry symlinks into the
   * source tree instead of one symlink to the directory itself. Package
   * resolution is identical, but an npm run inside the worktree then rewrites
   * the worktree's own directory and can no longer mutate the live tree (a
   * worktree install replaced apps/api/node_modules/nanoid under the running
   * API on 2026-10-11 and crash-looped it).
   */
  static async linkNodeModulesOverlay(sourceDir: string, targetDir: string): Promise<void> {
    await mkdir(targetDir, { recursive: true });
    const entries = await readdir(sourceDir, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const source = join(sourceDir, entry.name);
        const target = join(targetDir, entry.name);
        try {
          await symlink(source, target, entry.isDirectory() ? "dir" : "file");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            throw error;
          }
        }
      })
    );
  }

  private async linkDependenciesAndConfig(repoRoot: string, targetDir: string): Promise<void> {
    // 1. Root node_modules overlay
    const rootNodeModules = join(repoRoot, "node_modules");
    const targetNodeModules = join(targetDir, "node_modules");
    try {
      const stat = await lstat(rootNodeModules);
      if (stat.isDirectory()) {
        await WorktreeService.linkNodeModulesOverlay(rootNodeModules, targetNodeModules);
      }
    } catch {}

    // 2. Monorepo apps and packages node_modules overlays
    for (const subDir of ["apps", "packages"]) {
      const sourceSub = join(repoRoot, subDir);
      const targetSub = join(targetDir, subDir);
      try {
        const entries = await readdir(sourceSub, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const pkgModules = join(sourceSub, entry.name, "node_modules");
            const targetPkgModules = join(targetSub, entry.name, "node_modules");
            try {
              const mStat = await lstat(pkgModules);
              if (mStat.isDirectory()) {
                await mkdir(join(targetSub, entry.name), { recursive: true });
                await WorktreeService.linkNodeModulesOverlay(pkgModules, targetPkgModules);
              }
            } catch {}
          }
        }
      } catch {}
    }

    // 3. Local configuration copies (non-sensitive / dev config)
    for (const conf of [".env.local", ".env.test", ".nvmrc"]) {
      const src = join(repoRoot, conf);
      const dst = join(targetDir, conf);
      try {
        const stat = await lstat(src);
        if (stat.isFile()) {
          const content = await readFile(src);
          await writeFile(dst, content);
        }
      } catch {}
    }
  }

  async listWorktrees(repoPath: string): Promise<SpaceWorktree[]> {
    const repoRoot = await this.validateGitRepository(repoPath);
    const listResult = await execGit(repoRoot, ["worktree", "list", "--porcelain"]);
    if (listResult.code !== 0) {
      throw new WorktreeError("WORKTREE_LIST_FAILED", `Failed to list worktrees: ${listResult.stderr.trim()}`);
    }

    const blocks = listResult.stdout.split("\n\n").filter(Boolean);
    const worktrees: SpaceWorktree[] = [];

    for (const block of blocks) {
      const lines = block.split("\n");
      let wtPath = "";
      let headSha = "";
      let branch = "";

      for (const line of lines) {
        if (line.startsWith("worktree ")) {
          wtPath = line.substring(9).trim();
        } else if (line.startsWith("HEAD ")) {
          headSha = line.substring(5).trim();
        } else if (line.startsWith("branch refs/heads/")) {
          branch = line.substring(18).trim();
        } else if (line.startsWith("detached")) {
          branch = `detached-${headSha.slice(0, 8)}`;
        }
      }

      if (!wtPath) continue;
      if (!existsSync(wtPath)) continue;

      // Skip the main repository itself from the worktrees list if desired, or mark it as root
      const isRoot = wtPath === repoRoot;
      const id = isRoot ? "wt:root" : `wt:${basename(wtPath)}`;

      // Check dirty status and ahead/behind
      let isDirty = false;
      let aheadCount = 0;
      let behindCount = 0;
      let status: WorktreeStatus = "ACTIVE";

      try {
        const statusResult = await execGit(wtPath, ["status", "--porcelain"], 5000);
        isDirty = statusResult.code === 0 && statusResult.stdout.trim().length > 0;
        status = isDirty ? "DIRTY" : "ACTIVE";

        if (branch && !branch.startsWith("detached")) {
          const abResult = await execGit(wtPath, ["rev-list", "--left-right", "--count", `main...${branch}`], 5000);
          if (abResult.code === 0) {
            const parts = abResult.stdout.trim().split(/\s+/);
            const p0 = parts[0];
            const p1 = parts[1];
            behindCount = p0 ? Number.parseInt(p0, 10) || 0 : 0;
            aheadCount = p1 ? Number.parseInt(p1, 10) || 0 : 0;
          }
        }

      } catch {}

      const now = new Date().toISOString();
      if (!isRoot) {
        void this.recordWorktree({
          worktreePath: wtPath,
          repoPath: repoRoot,
          branch,
          baseBranch: "main",
          baseCommit: headSha,
          status
        });
      }

      worktrees.push({
        id,
        repoPath: repoRoot,
        worktreePath: wtPath,
        branch,
        baseBranch: "main",
        baseCommit: headSha,
        roomId: "",
        paneId: null,
        status,
        isDirty,
        aheadCount,
        behindCount,
        createdAt: now,
        updatedAt: now
      });
    }

    return worktrees;
  }

  async getWorktree(worktreePath: string): Promise<SpaceWorktree | null> {
    let realPath = "";
    try {
      realPath = await realpath(worktreePath);
    } catch {
      realPath = resolve(worktreePath);
    }

    try {
      const toplevel = await execGit(realPath, ["rev-parse", "--show-toplevel"]);
      if (toplevel.code === 0 && toplevel.stdout.trim() === realPath) {
        const branchResult = await execGit(realPath, ["branch", "--show-current"]);
        const branch = branchResult.stdout.trim();
        const headResult = await execGit(realPath, ["rev-parse", "HEAD"]);
        const head = headResult.stdout.trim();
        const statusResult = await execGit(realPath, ["status", "--porcelain"]);
        const isDirty = statusResult.stdout.trim().length > 0;

        let repoPath = "";
        const commonRes = await execGit(realPath, ["rev-parse", "--git-common-dir"]);
        if (commonRes.code === 0) {
          const commonDir = resolve(realPath, commonRes.stdout.trim());
          repoPath = commonDir.endsWith("/.git") ? dirname(commonDir) : dirname(dirname(commonDir));
        }
        if (!repoPath) repoPath = "/opt/spaceapp";

        let aheadCount = 0;
        let behindCount = 0;
        let status: WorktreeStatus = isDirty ? "DIRTY" : "ACTIVE";

        if (branch && !branch.startsWith("detached")) {
          const abResult = await execGit(realPath, ["rev-list", "--left-right", "--count", `main...${branch}`], 5000);
          if (abResult.code === 0) {
            const parts = abResult.stdout.trim().split(/\s+/);
            const p0 = parts[0];
            const p1 = parts[1];
            behindCount = p0 ? Number.parseInt(p0, 10) || 0 : 0;
            aheadCount = p1 ? Number.parseInt(p1, 10) || 0 : 0;
          }
        }

        const recorded = await this.getRecordedWorktree(realPath);
        if (recorded?.status === "MERGED" && aheadCount === 0 && !isDirty) {
          status = "MERGED";
        }

        const now = new Date().toISOString();
        void this.recordWorktree({
          worktreePath: realPath,
          repoPath,
          branch,
          baseBranch: "main",
          baseCommit: head,
          status
        });

        return {
          id: `wt:${basename(realPath)}`,
          repoPath,
          worktreePath: realPath,
          branch,
          baseBranch: "main",
          baseCommit: head,
          roomId: "",
          status,
          isDirty,
          aheadCount,
          behindCount,
          createdAt: now,
          updatedAt: now
        };
      }
    } catch {}

    // 1. Check registry if worktree directory was cleaned/deleted
    const recorded = await this.getRecordedWorktree(worktreePath);
    if (recorded) {
      return {
        id: recorded.id,
        repoPath: recorded.repoPath,
        worktreePath: recorded.worktreePath,
        branch: recorded.branch,
        baseBranch: recorded.baseBranch || "main",
        baseCommit: recorded.mergeCommitSha || recorded.baseCommit || "",
        roomId: "",
        status: recorded.status,
        isDirty: false,
        aheadCount: 0,
        behindCount: 0,
        createdAt: recorded.createdAt,
        updatedAt: recorded.updatedAt
      };
    }

    // 2. Git-based heuristic for historical / managed worktrees
    const normPath = resolve(worktreePath);
    const repoRoot = "/opt/spaceapp";
    const wtId = basename(normPath);
    const isManagedWorktree =
      normPath.startsWith(resolve(this.baseStorageDir)) ||
      normPath.includes("/var/worktrees/") ||
      normPath.includes("/agent-workspace/");

    // Check candidate branches
    for (const candidate of [`space/${wtId}`, wtId]) {
      const branchCheck = await execGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${candidate}`]);
      if (branchCheck.code === 0) {
        const ancestorCheck = await execGit(repoRoot, ["merge-base", "--is-ancestor", candidate, "main"]);
        if (ancestorCheck.code === 0) {
          const now = new Date().toISOString();
          const headSha = branchCheck.stdout.trim();
          await this.recordWorktree({
            worktreePath: normPath,
            repoPath: repoRoot,
            branch: candidate,
            baseBranch: "main",
            baseCommit: headSha,
            status: "MERGED"
          });
          return {
            id: `wt:${wtId}`,
            repoPath: repoRoot,
            worktreePath: normPath,
            branch: candidate,
            baseBranch: "main",
            baseCommit: headSha,
            roomId: "",
            status: "MERGED",
            isDirty: false,
            aheadCount: 0,
            behindCount: 0,
            createdAt: now,
            updatedAt: now
          };
        }
      }
    }

    // Check git log for any commit mentioning wtId
    const logCheck = await execGit(repoRoot, ["log", "main", "--grep", wtId, "-n", "1", "--format=%H"]);
    if (logCheck.code === 0 && logCheck.stdout.trim()) {
      const commitSha = logCheck.stdout.trim();
      const now = new Date().toISOString();
      await this.recordWorktree({
        worktreePath: normPath,
        repoPath: repoRoot,
        branch: `space/${wtId}`,
        baseBranch: "main",
        status: "MERGED",
        mergeCommitSha: commitSha
      });
      return {
        id: `wt:${wtId}`,
        repoPath: repoRoot,
        worktreePath: normPath,
        branch: `space/${wtId}`,
        baseBranch: "main",
        baseCommit: commitSha,
        roomId: "",
        status: "MERGED",
        isDirty: false,
        aheadCount: 0,
        behindCount: 0,
        createdAt: now,
        updatedAt: now
      };
    }

    // Managed worktree under var/worktrees or baseStorageDir that is gone or empty
    if (isManagedWorktree) {
      const headRes = await execGit(repoRoot, ["rev-parse", "HEAD"]);
      const headSha = headRes.code === 0 ? headRes.stdout.trim() : "";
      const now = new Date().toISOString();
      await this.recordWorktree({
        worktreePath: normPath,
        repoPath: repoRoot,
        branch: `space/${wtId}`,
        baseBranch: "main",
        status: "MERGED",
        mergeCommitSha: headSha
      });
      return {
        id: `wt:${wtId}`,
        repoPath: repoRoot,
        worktreePath: normPath,
        branch: `space/${wtId}`,
        baseBranch: "main",
        baseCommit: headSha,
        roomId: "",
        status: "MERGED",
        isDirty: false,
        aheadCount: 0,
        behindCount: 0,
        createdAt: now,
        updatedAt: now
      };
    }

    return null;
  }

  async mergeWorktree(
    worktreePath: string,
    input: MergeWorktreeInput = { strategy: "merge", deleteBranchAfter: true }
  ): Promise<WorktreeOperationResult> {
    const wt = await this.getWorktree(worktreePath);
    if (!wt) {
      throw new WorktreeError("NOT_FOUND", `Worktree not found for ${worktreePath}.`, 404);
    }

    const repoRoot = await this.validateGitRepository(wt.repoPath || "/opt/spaceapp");
    const branch = wt.branch;
    const baseBranch = wt.baseBranch || "main";

    // 1. If already recognized as MERGED:
    if (wt.status === "MERGED") {
      if (input.deleteBranchAfter && branch && !branch.startsWith("detached-") && branch !== "main") {
        await execGit(repoRoot, ["branch", "-d", branch]).catch(async () => {
          await execGit(repoRoot, ["branch", "-D", branch]).catch(() => {});
        });
      }
      if (input.deleteBranchAfter) {
        try {
          await this.removeWorktree(worktreePath, true);
        } catch {}
        if (await this.removalAllowed(worktreePath)) await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      }
      const shaRes = await execGit(repoRoot, ["rev-parse", "HEAD"]);
      const commitSha = wt.baseCommit || (shaRes.code === 0 ? shaRes.stdout.trim() : null);

      await this.recordWorktree({
        id: wt.id,
        worktreePath: wt.worktreePath,
        repoPath: repoRoot,
        branch,
        status: "MERGED",
        mergeCommitSha: commitSha || undefined
      });

      return {
        ok: true,
        alreadyMerged: true,
        commitSha,
        worktree: { ...wt, status: "MERGED" }
      };
    }

    if (wt.isDirty) {
      await execGit(wt.worktreePath, ["add", "-A"]);
      const commitRes = await execGit(wt.worktreePath, [
        "-c", "user.name=SpaceApp",
        "-c", "user.email=space@local",
        "commit",
        "-m",
        input.commitMessage || `chore: commit changes in ${branch} before merge`
      ]);
      if (commitRes.code !== 0) {
        throw new WorktreeError(
          "WORKTREE_DIRTY",
          "Cannot merge a worktree with uncommitted changes: failed to commit local changes.",
          409
        );
      }
    }

    // 2. Check if branch or commit is already an ancestor of baseBranch
    let alreadyMerged = false;
    if (branch && branch !== baseBranch && !branch.startsWith("detached-")) {
      const ancestorCheck = await execGit(repoRoot, ["merge-base", "--is-ancestor", branch, baseBranch]);
      alreadyMerged = ancestorCheck.code === 0;
    }

    if (alreadyMerged) {
      if (input.deleteBranchAfter && branch && !branch.startsWith("detached-") && branch !== "main") {
        await execGit(repoRoot, ["branch", "-d", branch]).catch(async () => {
          await execGit(repoRoot, ["branch", "-D", branch]).catch(() => {});
        });
      }
      if (input.deleteBranchAfter) {
        try {
          await this.removeWorktree(worktreePath, true);
        } catch {}
        if (await this.removalAllowed(worktreePath)) await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      }
      const shaRes = await execGit(repoRoot, ["rev-parse", "HEAD"]);
      const commitSha = shaRes.code === 0 ? shaRes.stdout.trim() : null;

      await this.recordWorktree({
        id: wt.id,
        worktreePath: wt.worktreePath,
        repoPath: repoRoot,
        branch,
        status: "MERGED",
        mergeCommitSha: commitSha || undefined
      });

      return {
        ok: true,
        alreadyMerged: true,
        commitSha,
        worktree: { ...wt, status: "MERGED" }
      };
    }

    // 3. Perform Git merge
    const mergeArgs = input.strategy === "squash"
      ? ["merge", "--squash", branch]
      : ["merge", "--no-ff", "-m", input.commitMessage || `Merge worktree branch ${branch} into ${baseBranch}`, branch];

    const mergeResult = await execGit(repoRoot, mergeArgs);
    if (mergeResult.code !== 0) {
      throw new WorktreeError("MERGE_CONFLICT", `Merge failed: ${mergeResult.stderr.trim()}`, 409);
    }

    if (input.strategy === "squash") {
      const commitRes = await execGit(repoRoot, ["commit", "-m", input.commitMessage || `Squash merge ${branch}`]);
      if (commitRes.code !== 0) {
        throw new WorktreeError("COMMIT_FAILED", `Squash commit failed: ${commitRes.stderr.trim()}`);
      }
    }

    const shaRes = await execGit(repoRoot, ["rev-parse", "HEAD"]);
    const commitSha = shaRes.stdout.trim();

    if (input.deleteBranchAfter) {
      try {
        await this.removeWorktree(worktreePath, true);
      } catch {}
    }

    if (input.deleteBranchAfter && branch && !branch.startsWith("detached-") && branch !== "main") {
      await execGit(repoRoot, ["branch", "-d", branch]).catch(async () => {
        await execGit(repoRoot, ["branch", "-D", branch]).catch(() => {});
      });
    }

    await this.recordWorktree({
      id: wt.id,
      worktreePath: wt.worktreePath,
      repoPath: repoRoot,
      branch,
      status: "MERGED",
      mergeCommitSha: commitSha
    });

    return {
      ok: true,
      commitSha,
      worktree: { ...wt, status: "MERGED" }
    };
  }

  /** True when the removal guard accepts the path (a linked worktree, a managed leftover or a missing path). */
  private async removalAllowed(worktreePath: string): Promise<boolean> {
    try {
      await assertRemovableWorktreePath(worktreePath, WORKTREES_ROOT);
      return true;
    } catch {
      return false;
    }
  }

  async removeWorktree(worktreePath: string, force = false): Promise<void> {
    // Defense in depth: the service deletes recursively, so it applies the route's guard
    // itself (also with force) instead of trusting every caller to have done so.
    await assertRemovableWorktreePath(worktreePath, WORKTREES_ROOT);
    const existing = await this.getRecordedWorktree(worktreePath);
    if (!existing || existing.status !== "MERGED") {
      await this.recordWorktree({
        worktreePath,
        status: "DISCARDED"
      });
    }

    try {
      let realPath = worktreePath;
      try {
        realPath = await realpath(worktreePath);
      } catch {}

      // Discover repository root from the worktree
      const toplevel = await execGit(realPath, ["rev-parse", "--git-common-dir"]);
      let repoRoot = "";
      if (toplevel.code === 0) {
        const commonDir = resolve(realPath, toplevel.stdout.trim());
        repoRoot = commonDir.endsWith("/.git") ? dirname(commonDir) : dirname(dirname(commonDir));
      }

      if (repoRoot && repoRoot !== realPath) {
        const removeArgs = force ? ["worktree", "remove", "--force", realPath] : ["worktree", "remove", realPath];
        await execGit(repoRoot, removeArgs);
        await execGit(repoRoot, ["worktree", "prune"]);
      }

      // Cleanup any remaining filesystem leftovers if git left them
      await rm(realPath, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      if (!force) {
        throw new WorktreeError("REMOVE_FAILED", `Failed to remove worktree: ${(err as Error).message}`);
      }
      await rm(worktreePath, { recursive: true, force: true }).catch(() => {});
    }
  }

  async cleanCompletedWorktrees(
    repoPath: string,
    options: {
      dryRun?: boolean;
      excludePaths?: string[];
      force?: boolean;
    } = {}
  ): Promise<{
    cleaned: Array<{ path: string; branch: string; reason: string }>;
    preserved: Array<{ path: string; branch: string; reason: string }>;
  }> {
    const repoRoot = await this.validateGitRepository(repoPath);
    await execGit(repoRoot, ["worktree", "prune"], 5000).catch(() => null);
    const worktrees = await this.listWorktrees(repoRoot);

    const cleaned: Array<{ path: string; branch: string; reason: string }> = [];
    const preserved: Array<{ path: string; branch: string; reason: string }> = [];

    // Exclude repoRoot, current working directory, and caller-specified excludes
    const resolvedExcludes = new Set<string>();
    resolvedExcludes.add(resolve(repoRoot));
    try {
      resolvedExcludes.add(await realpath(repoRoot));
    } catch {}

    const cwd = process.cwd();
    resolvedExcludes.add(resolve(cwd));
    try {
      resolvedExcludes.add(await realpath(cwd));
    } catch {}

    if (Array.isArray(options.excludePaths)) {
      for (const p of options.excludePaths) {
        if (!p) continue;
        resolvedExcludes.add(resolve(p));
        try {
          resolvedExcludes.add(await realpath(p));
        } catch {}
      }
    }

    for (const wt of worktrees) {
      const resolvedPath = resolve(wt.worktreePath);
      let realWtPath = resolvedPath;
      try {
        realWtPath = await realpath(resolvedPath);
      } catch {}

      // Skip root repo
      if (resolvedPath === resolve(repoRoot) || realWtPath === resolve(repoRoot)) {
        continue;
      }

      // Skip current process working directory or explicitly excluded paths
      if (resolvedExcludes.has(resolvedPath) || resolvedExcludes.has(realWtPath)) {
        preserved.push({ path: wt.worktreePath, branch: wt.branch, reason: "active/current worktree" });
        continue;
      }

      // Check if worktree is under managed var/worktrees
      const isManagedWorktree = wt.worktreePath.includes("/var/worktrees/");

      // Check if dirty: preserve dirty worktrees unless forced
      if (wt.isDirty && !options.force) {
        let isOnlyChmod = false;
        if (isManagedWorktree) {
          try {
            const diffStat = await execGit(wt.worktreePath, ["diff", "--stat"]);
            if (diffStat.code === 0 && diffStat.stdout.includes("0 insertions(+), 0 deletions(-)")) {
              isOnlyChmod = true;
            }
          } catch {}
        }
        if (!isOnlyChmod) {
          preserved.push({ path: wt.worktreePath, branch: wt.branch, reason: "uncommitted changes (dirty)" });
          continue;
        }
      }

      // Check if ahead of main
      if (wt.aheadCount > 0) {
        preserved.push({ path: wt.worktreePath, branch: wt.branch, reason: `${wt.aheadCount} unmerged commit(s) ahead of main` });
        continue;
      }

      // If branch is detached, verify its commit is an ancestor of main
      if (wt.branch.startsWith("detached-") && wt.baseCommit) {
        const isAncestor = await execGit(repoRoot, ["merge-base", "--is-ancestor", wt.baseCommit, "main"]);
        if (isAncestor.code !== 0) {
          preserved.push({ path: wt.worktreePath, branch: wt.branch, reason: "detached commit is not an ancestor of main" });
          continue;
        }
      }

      // If branch has a name, verify it's an ancestor of main
      if (wt.branch && !wt.branch.startsWith("detached-") && wt.branch !== "main") {
        const isAncestor = await execGit(repoRoot, ["merge-base", "--is-ancestor", wt.branch, "main"]);
        if (isAncestor.code !== 0) {
          preserved.push({ path: wt.worktreePath, branch: wt.branch, reason: `branch ${wt.branch} is not merged into main` });
          continue;
        }
      }

      // Completed worktree!
      if (!options.dryRun) {
        try {
          await this.removeWorktree(wt.worktreePath, true);
          if (wt.branch && !wt.branch.startsWith("detached-") && wt.branch !== "main") {
            await execGit(repoRoot, ["branch", "-D", wt.branch]).catch(() => {});
          }
          await this.recordWorktree({
            id: wt.id,
            worktreePath: wt.worktreePath,
            repoPath: repoRoot,
            branch: wt.branch,
            baseBranch: wt.baseBranch || "main",
            status: "MERGED",
            mergedAt: new Date().toISOString()
          });
        } catch (err) {
          preserved.push({ path: wt.worktreePath, branch: wt.branch, reason: `failed to remove: ${(err as Error).message}` });
          continue;
        }
      }

      cleaned.push({
        path: wt.worktreePath,
        branch: wt.branch,
        reason: "fully merged into main"
      });
    }

    await execGit(repoRoot, ["worktree", "prune"], 5000).catch(() => null);

    return { cleaned, preserved };
  }
}
