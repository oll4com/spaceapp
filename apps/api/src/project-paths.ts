import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const projectNamePattern = /^[a-zA-Z0-9_-]+$/;

/** System locations where a project directory or `git init` is never created. */
const protectedTrees = [
  "/bin", "/boot", "/dev", "/etc", "/lib", "/lib32", "/lib64", "/libx32", "/proc", "/root", "/run",
  "/sbin", "/snap", "/sys", "/usr", "/var/cache", "/var/lib", "/var/log", "/var/mail", "/var/run", "/var/spool"
];
/** Shared parents that may contain projects but must not become one. */
const protectedExact = ["/", "/home", "/media", "/mnt", "/opt", "/srv", "/tmp", "/var"];

export type ProjectEnsureTarget =
  | { ok: true; path: string; name: string }
  | { ok: false; status: 400 | 403; code: string; error: string };

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve symlinks in the existing part of a path that may not exist yet. */
async function resolveExistingPrefix(path: string): Promise<string> {
  let existing = path;
  const missing: string[] = [];
  for (;;) {
    try {
      return join(await realpath(existing), ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || existing === dirname(existing)) throw error;
      missing.push(basename(existing));
      existing = dirname(existing);
    }
  }
}

/**
 * Projects are created under the managed projects root by name. Only an ADMIN or
 * OPERATOR may choose another absolute location, and never a system directory,
 * a shared parent, or the live installation outside its projects root.
 */
export async function resolveProjectEnsureTarget(input: {
  name?: unknown;
  path?: unknown;
  role?: string | null;
  projectsRoot: string;
  installRoot: string;
}): Promise<ProjectEnsureTarget> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const requestedPath = typeof input.path === "string" ? input.path.trim() : "";
  if (name && !projectNamePattern.test(name)) {
    return { ok: false, status: 400, code: "INVALID_PROJECT_NAME",
      error: "Project name must contain only English letters, numbers, hyphens, and underscores." };
  }
  if (!name && !requestedPath) {
    return { ok: false, status: 400, code: "INVALID_PROJECT_PATH", error: "Missing project name or path." };
  }
  const projectsRoot = resolve(input.projectsRoot);
  const candidate = requestedPath || join(projectsRoot, name);
  if (!isAbsolute(candidate) || candidate.includes("\0")) {
    return { ok: false, status: 400, code: "INVALID_PROJECT_PATH", error: "Project path must be absolute." };
  }
  const normalized = resolve(candidate);
  let effective: string;
  try {
    effective = await resolveExistingPrefix(normalized);
  } catch {
    return { ok: false, status: 400, code: "INVALID_PROJECT_PATH", error: "Project path could not be resolved." };
  }
  let realProjectsRoot = projectsRoot;
  try { realProjectsRoot = await resolveExistingPrefix(projectsRoot); } catch { /* keep configured value */ }
  const insideProjects = within(realProjectsRoot, effective) && effective !== realProjectsRoot;
  const privileged = input.role === "ADMIN" || input.role === "OPERATOR";
  if (!insideProjects && !privileged) {
    return { ok: false, status: 403, code: "PROJECT_PATH_FORBIDDEN",
      error: "Creating a project outside the projects folder requires ADMIN or OPERATOR access." };
  }
  const installRoot = resolve(input.installRoot);
  const unsafe =
    protectedExact.includes(effective) ||
    protectedTrees.some((tree) => within(tree, effective)) ||
    (within(installRoot, effective) && !insideProjects) ||
    effective === realProjectsRoot;
  if (unsafe) {
    return { ok: false, status: 403, code: "PROJECT_PATH_FORBIDDEN",
      error: "Projects cannot be created in system directories or inside the Space installation." };
  }
  return { ok: true, path: normalized, name: name || basename(normalized) || "project" };
}

/**
 * SEC-009: pane creation may create a missing working directory only where a
 * project or worktree may live. Managed worktrees (inside the install checkout)
 * are allowed; everything else follows the project-creation policy above.
 */
export async function mayCreatePaneDirectory(input: {
  cwd: string;
  role?: string | null;
  projectsRoot: string;
  installRoot: string;
  worktreesRoot: string;
}): Promise<boolean> {
  if (!isAbsolute(input.cwd) || input.cwd.includes("\0")) return false;
  const target = resolve(input.cwd);
  let worktreesRoot = resolve(input.worktreesRoot);
  try { worktreesRoot = await resolveExistingPrefix(worktreesRoot); } catch { /* keep configured value */ }
  let effective = target;
  try { effective = await resolveExistingPrefix(target); } catch { return false; }
  if (within(worktreesRoot, effective) && effective !== worktreesRoot) return true;
  const decision = await resolveProjectEnsureTarget({
    path: target, role: input.role, projectsRoot: input.projectsRoot, installRoot: input.installRoot
  });
  return decision.ok;
}

/**
 * SEC-009 for CLI sessions: a session may create its missing working directory only under the managed CLI
 * workspace root or where pane creation may (mayCreatePaneDirectory). The 1.1.5 internal review found the
 * session start and the terminal attach running mkdir -p on the request's or pane's cwd unchecked.
 */
export async function mayCreateCliSessionDirectory(input: Parameters<typeof mayCreatePaneDirectory>[0] & { workspaceRoot: string }): Promise<boolean> {
  if (!isAbsolute(input.cwd) || input.cwd.includes("\0")) return false;
  if (within(resolve(input.workspaceRoot), resolve(input.cwd))) return true;
  return mayCreatePaneDirectory(input);
}

