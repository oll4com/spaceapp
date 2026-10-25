import { execFile } from "../safe-child-process.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { WorktreeError } from "./worktree-error.js";
import { childProcessEnv } from "../child-process-env.js";

const execFileAsync = promisify(execFile);

export type WorktreeRemovalTarget =
  | { kind: "MISSING"; path: string }
  | { kind: "LINKED_WORKTREE"; path: string }
  | { kind: "MANAGED_LEFTOVER"; path: string };

function strictlyInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

async function gitPaths(directory: string): Promise<{ gitDir: string; commonDir: string; topLevel: string } | null> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", directory, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"],
      { timeout: 10_000, maxBuffer: 64 * 1024, env: { ...childProcessEnv(), GIT_TERMINAL_PROMPT: "0" } }
    );
    const [gitDir, commonDir, topLevel] = stdout.trim().split("\n").map((line) => line.trim());
    if (!gitDir || !commonDir || !topLevel) return null;
    return { gitDir: resolve(gitDir), commonDir: resolve(commonDir), topLevel: resolve(topLevel) };
  } catch {
    return null;
  }
}

/**
 * The removal route deletes recursively as the service account. Only accept the
 * root of a linked Git worktree, or a non-Git leftover strictly inside the
 * managed worktree root. A main checkout, a subdirectory, the managed root itself
 * and any other directory are rejected before the service is called.
 */
export async function assertRemovableWorktreePath(path: string, managedRoot: string): Promise<WorktreeRemovalTarget> {
  if (!isAbsolute(path)) {
    throw new WorktreeError("INVALID_WORKTREE_PATH", "Worktree path must be absolute.", 400);
  }
  let target: string;
  try {
    target = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "MISSING", path: resolve(path) };
    throw new WorktreeError("INVALID_WORKTREE_PATH", "Worktree path could not be resolved.", 400);
  }

  const git = await gitPaths(target);
  if (git && git.topLevel === target && git.gitDir !== git.commonDir) {
    return { kind: "LINKED_WORKTREE", path: target };
  }

  let root: string | null = null;
  try {
    root = await realpath(managedRoot);
  } catch {
    root = null;
  }
  // The managed root can itself live inside the install checkout
  // (/opt/spaceapp/var/worktrees). A directory whose nearest repository is that
  // enclosing checkout is a leftover; anything belonging to a repository at or
  // below the managed root is not.
  const ownedByManagedRepository = git !== null && root !== null &&
    (git.topLevel === root || strictlyInside(root, git.topLevel));
  if (root && strictlyInside(root, target) && !ownedByManagedRepository) {
    return { kind: "MANAGED_LEFTOVER", path: target };
  }

  throw new WorktreeError(
    "NOT_A_WORKTREE",
    "Only linked Git worktrees or leftovers inside the managed worktree directory can be removed.",
    409
  );
}

/** Query-string booleans: only explicit true values enable force removal. */
export function parseForceFlag(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return value === "true" || value === "1";
}
