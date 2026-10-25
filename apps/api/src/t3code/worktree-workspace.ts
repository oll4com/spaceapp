import { readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { WORKTREES_ROOT } from "../worktrees/worktree-service.js";

// What a Space CLI pane, and so a T3 agent, can write
// (codex-pane-host.service and space-t3code.service ReadWritePaths).
export const T3_WRITABLE_ROOTS = ["/srv", "/var/lib/spaceapp-user"];
// The live checkout is never a T3 project: its own worktrees are.
const LIVE_CHECKOUT = "/opt/spaceapp";

const strictlyInside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
};
const safeCandidate = (candidate: unknown): candidate is string =>
  typeof candidate === "string" && candidate.length <= 4096 && isAbsolute(candidate) && !/[\x00-\x1f\x7f]/.test(candidate);

/**
 * Canonical root of a Space-managed linked worktree (room worktree isolation,
 * as for CLI panes), or null. Space owns these worktrees (unlike the private T3
 * workspace tree), so the API checks them itself: a directory under the managed
 * root whose `.git` file names `<repository>/.git/worktrees/<name>`, which the
 * repository registered and which links back to it.
 */
export async function t3WorktreeWorkspace(candidate: string, worktreesRoot = WORKTREES_ROOT): Promise<string | null> {
  if (!safeCandidate(candidate)) return null;
  try {
    const [root, target] = await Promise.all([realpath(worktreesRoot), realpath(candidate)]);
    if (!strictlyInside(root, target) || !(await stat(target)).isDirectory()) return null;
    const pointer = /^gitdir: ([^\n]+)\n?$/.exec(await readFile(join(target, ".git"), "utf8"));
    if (!pointer) return null;
    const gitDir = await realpath(resolve(target, pointer[1]!));
    if (basename(dirname(gitDir)) !== "worktrees" || !(await stat(join(dirname(dirname(gitDir)), "objects"))).isDirectory()) return null;
    const backLink = (await readFile(join(gitDir, "gitdir"), "utf8")).trim();
    return await realpath(resolve(gitDir, backLink)) === join(target, ".git") ? target : null;
  } catch {
    return null;
  }
}

/**
 * The room's own project directory, as a CLI pane opens there, or null: only
 * the room's configured path, an existing directory strictly inside a
 * CLI-writable root, never the live checkout.
 */
export async function t3RoomProjectWorkspace(candidate: string, projectPath: string | null | undefined,
  roots = T3_WRITABLE_ROOTS): Promise<string | null> {
  if (!safeCandidate(candidate) || !safeCandidate(projectPath) || resolve(candidate) !== resolve(projectPath)) return null;
  try {
    const target = await realpath(candidate);
    if (target === LIVE_CHECKOUT || !(await stat(target)).isDirectory()) return null;
    for (const root of roots) if (strictlyInside(await realpath(root).catch(() => root), target)) return target;
    return null;
  } catch {
    return null;
  }
}
