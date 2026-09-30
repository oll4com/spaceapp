import { lstat, readdir, readFile, writeFile, mkdir, rename, chmod, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import os from "node:os";
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

export class FilesystemError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "FilesystemError";
    this.statusCode = statusCode;
  }
}

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
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
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

  return { resolvedPath, isAdmin: false };
}

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

  let dirStats;
  try {
    dirStats = await lstat(resolvedPath);
  } catch (error) {
    throw new FilesystemError(`Directory not found: ${resolvedPath}`, 404);
  }

  if (!dirStats.isDirectory()) {
    throw new FilesystemError(`Path is not a directory: ${resolvedPath}`, 400);
  }

  const rawEntries = await readdir(resolvedPath, { withFileTypes: true });
  const entries: FileItem[] = [];

  for (const dirent of rawEntries) {
    if (!options.showHidden && dirent.name.startsWith(".")) {
      continue;
    }

    const fullPath = path.join(resolvedPath, dirent.name);
    try {
      const stats = await lstat(fullPath);
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
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
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
}

export async function readFileContent(options: {
  targetPath: string;
  mode?: "user" | "admin";
  user?: AuthUser | null;
  workspaceRoot?: string;
}) {
  const root = options.workspaceRoot || WORKSPACE_ROOT;
  const { resolvedPath, isAdmin } = assertAccessAllowed(options.targetPath, options.mode, options.user, root);

  let stats;
  try {
    stats = await lstat(resolvedPath);
  } catch {
    throw new FilesystemError(`File not found: ${resolvedPath}`, 404);
  }

  if (stats.isDirectory()) {
    throw new FilesystemError(`Cannot read directory as file: ${resolvedPath}`, 400);
  }

  const mimeType = detectMimeType(resolvedPath);
  const isBinary = !isTextFile(mimeType, resolvedPath);
  const MAX_TEXT_SIZE = 10 * 1024 * 1024; // 10MB limit for text editor

  let content: string | null = null;
  if (!isBinary) {
    if (stats.size > MAX_TEXT_SIZE) {
      throw new FilesystemError(`File is too large for editor (${Math.round(stats.size / 1024 / 1024)}MB). Max 10MB.`, 400);
    }
    content = await readFile(resolvedPath, "utf-8");
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
  const tmpPath = path.join(dir, `.tmp_${path.basename(resolvedPath)}_${Date.now()}`);

  try {
    await writeFile(tmpPath, options.content, "utf-8");
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

  if (PROTECTED_SYSTEM_PATHS.has(resolvedPath)) {
    throw new FilesystemError(`Deleting protected system directory (${resolvedPath}) is prohibited.`, 403);
  }

  await rm(resolvedPath, { recursive: options.recursive ?? false, force: true });
  return {
    ok: true,
    path: resolvedPath
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
  const { resolvedPath } = assertAccessAllowed(searchRoot, options.mode, options.user, root);
  const limit = options.limit || 50;

  // Use ripgrep --files with case-insensitive glob if available
  try {
    const { stdout } = await execFileAsync(
      "rg",
      ["--files", "--glob", `*${options.query}*`, resolvedPath],
      { maxBuffer: 10 * 1024 * 1024 }
    );
    const lines = stdout.trim().split("\n").filter(Boolean).slice(0, limit);
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

    return {
      query: options.query,
      results,
      totalCount: results.length
    };
  } catch {
    // If rg fails or produces nothing, return empty
    return {
      query: options.query,
      results: [],
      totalCount: 0
    };
  }
}
