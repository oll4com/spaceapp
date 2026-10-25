import { lstat, readdir, open, writeFile, mkdir, rename, chmod, rm, realpath } from "node:fs/promises";
import { execFile } from "./safe-child-process.js";
import { promisify } from "node:util";
import path from "node:path";
import { constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { FilesystemError, filesystemError } from "./filesystem-error.js";
import { openWorkspacePath, descriptorPath, readBoundedText } from "./workspace-filesystem.js";
export { FilesystemError } from "./filesystem-error.js";
import type { AuthUser, FileItem } from "@space/contracts";

const execFileAsync = promisify(execFile);

export const WORKSPACE_ROOT = process.env.SPACE_WORKSPACE_ROOT || "/opt/spaceapp";
const PROTECTED_SYSTEM_PATHS = new Set([
  "/",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/home",
  "/lib",
  "/lib64",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/usr",
  "/var"
]);

const MIME_TYPE_MAP: Record<string, string> = {
  // Code / Text
  ".ts": "text/typescript",
  ".tsx": "text/typescript-jsx",
  ".js": "application/javascript",
  ".jsx": "text/javascript-jsx",
  ".mjs": "application/javascript",
  ".cjs": "application/javascript",
  ".json": "application/json",
  ".json5": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".sass": "text/x-sass",
  ".less": "text/x-less",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".txt": "text/plain",
  ".sh": "application/x-sh",
  ".bash": "application/x-sh",
  ".zsh": "application/x-sh",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".php": "text/x-php",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".java": "text/x-java",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/x-toml",
  ".xml": "text/xml",
  ".sql": "text/x-sql",
  ".env": "text/plain",
  ".conf": "text/plain",
  ".ini": "text/plain",
  ".log": "text/plain",
  ".dockerfile": "text/plain",
  "dockerfile": "text/plain",

  // Images
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",

  // Audio / Video
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",

  // Documents / Archives
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".tgz": "application/gzip"
};

export function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  if (MIME_TYPE_MAP[basename]) return MIME_TYPE_MAP[basename];
  if (MIME_TYPE_MAP[ext]) return MIME_TYPE_MAP[ext];
  return "application/octet-stream";
}

export function isTextFile(mimeType: string, filePath: string): boolean {
  if (
    mimeType.startsWith("text/") ||
    mimeType === "application/javascript" ||
    mimeType === "application/json" ||
    mimeType === "application/x-sh" ||
    mimeType === "text/yaml" ||
    mimeType === "text/xml"
  ) {
    return true;
  }
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath).toLowerCase();
  const textFilenames = new Set([
    "hosts", "passwd", "group", "hostname", "resolv.conf", "dockerfile", "makefile",
    "license", "readme", "profile", "bashrc", "zshrc", "environment", "gemfile", "vagrantfile"
  ]);
  if (textFilenames.has(basename)) return true;

  const textExtensions = new Set([
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".html", ".css", ".scss",
    ".md", ".txt", ".sh", ".bash", ".zsh", ".py", ".rb", ".php", ".go", ".rs",
    ".c", ".cpp", ".h", ".hpp", ".java", ".yaml", ".yml", ".toml", ".xml", ".sql",
    ".env", ".conf", ".ini", ".log", ".dockerfile", ".gitignore", ".npmrc", ".prettierrc",
    ".eslintrc", ".service", ".socket", ".target", ".rules", ".cfg", ".cnf"
  ]);
  return textExtensions.has(ext);
}

export function formatPermissions(mode: number): string {
  const flags = ["---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx"];
  const user = flags[(mode >> 6) & 7];
  const group = flags[(mode >> 3) & 7];
  const other = flags[mode & 7];
  return `${user}${group}${other}`;
}

export function formatOctalPermissions(mode: number): string {
  return "0" + (mode & 0o777).toString(8);
}

export function isPathInWorkspace(targetPath: string, workspaceRoot: string = WORKSPACE_ROOT): boolean {
  const resolvedTarget = path.resolve(targetPath);
  const resolvedRoot = path.resolve(workspaceRoot);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

let hostModeEnabled = true;

/** Server-side switch for Admin (host) Mode, set by the composition root from
 * SPACE_FILES_HOST_MODE. Disabled means no role can browse outside User Mode. */
export function configureFilesHostMode(enabled: boolean): void {
  hostModeEnabled = enabled;
}

/** Top-level install directories that hold secrets, backups or other users'
 * runtime data (artifacts, uploads, diagnostics). User Mode never reaches them. */
const userModeRestrictedTopLevel = new Set(["var", "secrets", "backups", ".git"]);
const environmentFilePattern = /^\.env(\..+)?$/;

/** True when User Mode must not read, list or search this workspace path:
 * restricted install directories and environment files (except examples). */
export function isUserModeRestricted(targetPath: string, workspaceRoot: string = WORKSPACE_ROOT): boolean {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(targetPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  // Managed worktrees are code checkouts that worktree panes browse in User Mode.
  const managedWorktree = segments[0] === "var" && segments[1] === "worktrees";
  if (userModeRestrictedTopLevel.has(segments[0]!) && !managedWorktree) return true;
  // Git metadata stays hidden at any depth, and each managed worktree
  // (var/worktrees/<project>/<worktree>/...) keeps the install root's restrictions.
  if (segments.includes(".git")) return true;
  if (managedWorktree && segments.length > 4 && userModeRestrictedTopLevel.has(segments[4]!)) return true;
  return segments.some((segment) => environmentFilePattern.test(segment) && segment !== ".env.example");
}

export function assertAccessAllowed(
  targetPath: string,
  mode: "user" | "admin" = "user",
  user?: AuthUser | null,
  workspaceRoot: string = WORKSPACE_ROOT
): { resolvedPath: string; isAdmin: boolean } {
  const resolvedPath = path.resolve(path.normalize(targetPath));
  const hasAdminRole = Boolean(user && (user.role === "ADMIN" || user.role === "OPERATOR"));

  if (mode === "admin") {
    if (!hostModeEnabled) {
      throw new FilesystemError("Admin Mode filesystem access is disabled on this server.", 403, "HOST_MODE_DISABLED");
    }
    if (!hasAdminRole) {
      throw new FilesystemError("Admin role required for Admin Mode filesystem access.", 403);
    }
    return { resolvedPath, isAdmin: true };
  }

  // User Mode: restricted strictly to workspace
  if (!isPathInWorkspace(resolvedPath, workspaceRoot)) {
    throw new FilesystemError(
      `Access outside workspace root (${workspaceRoot}) requires Admin Mode.`,
      403
    );
  }
  if (isUserModeRestricted(resolvedPath, workspaceRoot)) {
    throw new FilesystemError("This location holds server secrets or runtime data and requires Admin Mode.", 403, "RESTRICTED_PATH");
  }

  return { resolvedPath, isAdmin: false };
}

// localeCompare with options builds a collator per call: 50k names took ~5 s and blocked the API.
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export async function listDirectory(options: {
  targetPath?: string;
  showHidden?: boolean;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const requestedPath = options.targetPath || root;
  const { resolvedPath, isAdmin } = assertAccessAllowed(requestedPath, options.mode, options.user, root);

  const handle = isAdmin ? await open(resolvedPath, constants.O_RDONLY | constants.O_DIRECTORY)
    : await openWorkspacePath(root, resolvedPath, true);
  try {
    const accessPath = descriptorPath(handle);
    const rawEntries = await readdir(accessPath, { withFileTypes: true });
    const entries: FileItem[] = [];

    for (const dirent of rawEntries) {
      if (!options.showHidden && dirent.name.startsWith(".")) {
        continue;
      }

      const fullPath = path.join(resolvedPath, dirent.name);
      if (!isAdmin && isUserModeRestricted(fullPath, root)) continue;
      try {
        const stats = await lstat(path.join(accessPath, dirent.name));
        const isDirectory = stats.isDirectory();
        const isSymbolicLink = stats.isSymbolicLink();
        const mimeType = isDirectory ? "inode/directory" : detectMimeType(fullPath);
        const extension = isDirectory ? "" : path.extname(dirent.name).toLowerCase();
        const birthtime = stats.birthtime ? stats.birthtime.toISOString() : stats.ctime.toISOString();
        const size = isDirectory ? 0 : stats.size;

        entries.push({
          name: dirent.name,
          path: fullPath,
          isDirectory,
          isSymbolicLink,
          size,
          mtime: stats.mtime.toISOString(),
          birthtime,
          mode: stats.mode,
          permissions: formatPermissions(stats.mode),
          octalPermissions: formatOctalPermissions(stats.mode),
          owner: String(stats.uid),
          mimeType,
          extension
        });
      } catch {
        // Ignore unreadable entries (e.g. broken symlinks or permission denied)
      }
    }

    // Sort: directories first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return nameCollator.compare(a.name, b.name);
    });

    const parentPath = resolvedPath === "/" ? null : path.dirname(resolvedPath);
    const canGoUp = Boolean(parentPath && (isAdmin || isPathInWorkspace(parentPath, root)));

    return {
      currentPath: resolvedPath,
      parentPath: canGoUp ? parentPath : null,
      workspaceRoot: root,
      isAdminMode: isAdmin,
      canGoUp,
      entries,
      totalCount: entries.length
    };
  } catch (error) { throw filesystemError(error); }
  finally { await handle.close(); }
}

export async function openFileForRead(options: {
  targetPath: string;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath, isAdmin } = assertAccessAllowed(options.targetPath, options.mode, options.user, root);
  if (!isAdmin) return openWorkspacePath(root, resolvedPath);
  const handle = await open(resolvedPath, constants.O_RDONLY | constants.O_NONBLOCK).catch((error) => { throw filesystemError(error); });
  try {
    if (!(await handle.stat()).isFile()) throw new FilesystemError("Only regular files can be read.", 400);
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readFileContent(options: {
  targetPath: string;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath, isAdmin } = assertAccessAllowed(options.targetPath, options.mode, options.user, root);

  const handle = await openFileForRead(options);
  try {
    const stats = await handle.stat();
    const mimeType = detectMimeType(resolvedPath);
    const isBinary = !isTextFile(mimeType, resolvedPath);
    const MAX_TEXT_SIZE = 10 * 1024 * 1024; // 10MB limit for text editor

    let content: string | null = null;
    if (!isBinary) {
      if (stats.size > MAX_TEXT_SIZE) {
        throw new FilesystemError(`File is too large for editor (${Math.round(stats.size / 1024 / 1024)}MB). Max 10MB.`, 400);
      }
      content = await readBoundedText(handle, MAX_TEXT_SIZE);
    }

    return {
      path: resolvedPath,
      name: path.basename(resolvedPath),
      size: stats.size,
      mimeType,
      isBinary,
      content,
      permissions: formatPermissions(stats.mode),
      octalPermissions: formatOctalPermissions(stats.mode),
      mtime: stats.mtime.toISOString(),
      editable: !isBinary && isAdmin
    };
  } finally { await handle.close(); }
}

export async function writeFileContent(options: {
  targetPath: string;
  content: string;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  if (options.mode !== "admin") {
    throw new FilesystemError("File editing and saving strictly requires Admin Mode.", 403);
  }
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath } = assertAccessAllowed(options.targetPath, options.mode, options.user, root);

  // Atomic write via temporary file
  const dir = path.dirname(resolvedPath);
  // Random name and "wx": a planted symlink at a guessable temp name cannot redirect the save (1.1.5 review F13).
  const tmpPath = path.join(dir, `.tmp_${path.basename(resolvedPath)}_${randomBytes(8).toString("hex")}`);

  try {
    const previousMode = await lstat(resolvedPath).then((stats) => stats.mode & 0o7777, () => null);
    await writeFile(tmpPath, options.content, { encoding: "utf-8", flag: "wx" });
    if (previousMode !== null) await chmod(tmpPath, previousMode);
    await rename(tmpPath, resolvedPath);
  } catch (error) {
    try {
      await rm(tmpPath, { force: true });
    } catch {
      // ignore
    }
    throw new FilesystemError(`Failed to save file: ${(error as Error).message}`, 500);
  }

  const stats = await lstat(resolvedPath);
  return {
    ok: true,
    path: resolvedPath,
    size: stats.size,
    mtime: stats.mtime.toISOString()
  };
}

export async function createEntry(options: {
  targetPath: string;
  type: "file" | "directory";
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  if (options.mode !== "admin") {
    throw new FilesystemError("Creating files or folders strictly requires Admin Mode.", 403);
  }
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath } = assertAccessAllowed(options.targetPath, options.mode, options.user, root);

  if (options.type === "directory") {
    await mkdir(resolvedPath, { recursive: true });
  } else {
    const parentDir = path.dirname(resolvedPath);
    await mkdir(parentDir, { recursive: true });
    await writeFile(resolvedPath, "", { flag: "wx" });
  }

  const stats = await lstat(resolvedPath);
  return {
    ok: true,
    path: resolvedPath,
    name: path.basename(resolvedPath),
    isDirectory: stats.isDirectory(),
    mtime: stats.mtime.toISOString()
  };
}

export async function renameEntry(options: {
  oldPath: string;
  newPath: string;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  if (options.mode !== "admin") {
    throw new FilesystemError("Renaming files or folders strictly requires Admin Mode.", 403);
  }
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath: srcPath } = assertAccessAllowed(options.oldPath, options.mode, options.user, root);
  const { resolvedPath: destPath } = assertAccessAllowed(options.newPath, options.mode, options.user, root);

  await rename(srcPath, destPath);
  return {
    ok: true,
    oldPath: srcPath,
    newPath: destPath
  };
}

export async function chmodEntry(options: {
  targetPath: string;
  octalPermissions: string;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath, isAdmin } = assertAccessAllowed(options.targetPath, "admin", options.user, root);

  if (!isAdmin) {
    throw new FilesystemError("Permissions change (chmod) strictly requires Admin Mode.", 403);
  }

  const modeNumber = parseInt(options.octalPermissions, 8);
  if (Number.isNaN(modeNumber)) {
    throw new FilesystemError(`Invalid octal permissions: ${options.octalPermissions}`, 400);
  }

  await chmod(resolvedPath, modeNumber);
  const stats = await lstat(resolvedPath);

  return {
    ok: true,
    path: resolvedPath,
    mode: stats.mode,
    permissions: formatPermissions(stats.mode),
    octalPermissions: formatOctalPermissions(stats.mode)
  };
}

export async function deleteEntry(options: {
  targetPath: string;
  recursive?: boolean;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  if (options.mode !== "admin") {
    throw new FilesystemError("Deleting files or folders strictly requires Admin Mode.", 403);
  }
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath } = assertAccessAllowed(options.targetPath, options.mode, options.user, root);

  // Host mode stays an operator feature, but the system roots, their direct children (/etc/passwd,
  // /var/lib, /srv) and the Space workspace with its parents are never deleted through it (review 2026-10-14).
  // Real paths count too: rm follows symlinked ancestors such as /var/run -> /run, but not the last component
  // (external review 2026-10-16).
  const workspace = path.resolve(root);
  const realWorkspace = await realpath(workspace).catch(() => workspace);
  const realParent = await realpath(path.dirname(resolvedPath)).catch(() => path.dirname(resolvedPath));
  const realTarget = path.join(realParent, path.basename(resolvedPath));
  const isProtected = (target: string, ws: string) => PROTECTED_SYSTEM_PATHS.has(target) ||
    PROTECTED_SYSTEM_PATHS.has(path.dirname(target)) || ws === target || ws.startsWith(`${target}/`);
  if ([resolvedPath, realTarget].some((target) => isProtected(target, workspace) || isProtected(target, realWorkspace))) {
    throw new FilesystemError(`Deleting protected system directory (${resolvedPath}) is prohibited.`, 403);
  }

  await rm(resolvedPath, { recursive: options.recursive ?? false, force: true });
  return {
    ok: true,
    path: resolvedPath
  };
}

/**
 * A successful search states its outcome explicitly: OK (matches) or
 * EMPTY_RESULT (the search ran and matched nothing). Every failure is a thrown
 * FilesystemError with TOOL_UNAVAILABLE, TIMEOUT, PERMISSION_DENIED or
 * SEARCH_FAILED, so callers can never mistake a broken tool for no matches.
 */
function searchResult(query: string, results: FileItem[], truncated: boolean) {
  return {
    query,
    results,
    totalCount: results.length,
    code: results.length ? ("OK" as const) : ("EMPTY_RESULT" as const),
    truncated
  };
}

export async function searchFiles(options: {
  targetPath?: string;
  query: string;
  limit?: number;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const searchRoot = options.targetPath || root;
  const { resolvedPath, isAdmin } = assertAccessAllowed(searchRoot, options.mode, options.user, root);
  const limit = options.limit || 50;

  if (!isAdmin) {
    const results: FileItem[] = [];
    const pending = [resolvedPath];
    const deadline = Date.now() + 5000;
    let scanned = 0;
    let truncated = false;
    while (pending.length && results.length < limit) {
      if (Date.now() > deadline || scanned > 10_000) throw new FilesystemError("File search exceeded its scan budget.", 504, "TIMEOUT");
      const directory = pending.pop()!;
      const listing = await listDirectory({ ...options, targetPath: directory, workspaceRoot: root });
      for (const entry of listing.entries) {
        scanned++;
        if (scanned > 10_000 || Date.now() > deadline) throw new FilesystemError("File search exceeded its scan budget.", 504, "TIMEOUT");
        if (entry.isSymbolicLink) continue;
        if (entry.isDirectory) {
          if (entry.name !== "node_modules" && entry.name !== ".git") pending.push(entry.path);
        } else if (path.matchesGlob(options.query.includes("/") ? path.relative(resolvedPath, entry.path) : entry.name, `*${options.query}*`)) {
          results.push(entry);
          if (results.length === limit) { truncated = true; break; }
        }
      }
    }
    return searchResult(options.query, results, truncated);
  }

  // Host mode intentionally retains the operator's unrestricted search.
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--files", "--glob", `*${options.query}*`, resolvedPath],
      { maxBuffer: 10 * 1024 * 1024, timeout: 5000 }
    );
    const allLines = stdout.trim().split("\n").filter(Boolean);
    const lines = allLines.slice(0, limit);
    const results: FileItem[] = [];

    for (const filePath of lines) {
      try {
        const stats = await lstat(filePath);
        results.push({
          name: path.basename(filePath),
          path: filePath,
          isDirectory: stats.isDirectory(),
          isSymbolicLink: stats.isSymbolicLink(),
          size: stats.size,
          mtime: stats.mtime.toISOString(),
          birthtime: stats.birthtime ? stats.birthtime.toISOString() : stats.ctime.toISOString(),
          mode: stats.mode,
          permissions: formatPermissions(stats.mode),
          octalPermissions: formatOctalPermissions(stats.mode),
          mimeType: detectMimeType(filePath),
          extension: path.extname(filePath).toLowerCase()
        });
      } catch {
        // ignore unreadable
      }
    }

    return searchResult(options.query, results, allLines.length > limit);
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    // ripgrep exits 1 with no stderr only when the search ran and matched nothing.
    if ((failure.code as unknown) === 1 && !failure.stderr?.trim()) return searchResult(options.query, [], false);
    if (failure.code === "ENOENT") throw new FilesystemError("File search tool is unavailable.", 503, "TOOL_UNAVAILABLE");
    if (failure.killed || failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new FilesystemError("File search exceeded its time or output limit.", 504, "TIMEOUT");
    if (failure.code === "EACCES" || /permission denied/i.test(failure.stderr ?? "")) throw new FilesystemError("File search permission denied.", 403, "PERMISSION_DENIED");
    throw new FilesystemError("File search failed.", 502, "SEARCH_FAILED");
  }
}
