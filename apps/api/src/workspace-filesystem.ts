import { constants } from "node:fs";
import { mkdir, open, readlink, realpath, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { FilesystemError, filesystemError } from "./filesystem-error.js";

export function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Linux API containers support descriptor-relative, no-follow traversal. Other
 * platforms fail closed instead of substituting a check-then-open pathname. The
 * configured root is trusted; this is not a sandbox against a privileged host. */
export async function openWorkspacePath(root: string, target: string, directory = false, createDirectories = false): Promise<FileHandle> {
  if (!contains(path.resolve(root), path.resolve(target))) {
    throw new FilesystemError("Path is outside the workspace.", 403, "PATH_UNSAFE");
  }
  if (process.platform !== "linux") {
    throw new FilesystemError("Workspace access requires the Linux filesystem backend.", 503, "TOOL_UNAVAILABLE");
  }
  const handles: FileHandle[] = [];
  let result: FileHandle | undefined;
  try {
    const canonicalRoot = await realpath(root);
    // O_PATH is a Linux ABI flag not exposed by node:fs. Resolve without opening
    // a device/FIFO for I/O; only reopen a verified regular-file descriptor.
    const O_PATH = 0x200000;
    let current = await open(canonicalRoot, O_PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    handles.push(current);
    const parts = path.relative(path.resolve(root), path.resolve(target)).split(path.sep).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      const flags = O_PATH | constants.O_NOFOLLOW
        | (index < parts.length - 1 || directory ? constants.O_DIRECTORY : 0);
      const child = `${descriptorPath(current)}/${part}`;
      try {
        current = await open(child, flags);
      } catch (error) {
        if (!directory || !createDirectories || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parentPath = await readlink(descriptorPath(current));
        if (!contains(canonicalRoot, parentPath) || parentPath.endsWith(" (deleted)")) {
          throw new FilesystemError("The workspace path changed during access.", 403, "PATH_UNSAFE");
        }
        await mkdir(child, { mode: 0o750 }).catch((failure) => {
          if ((failure as NodeJS.ErrnoException).code !== "EEXIST") throw failure;
        });
        current = await open(child, flags);
      }
      handles.push(current);
    }
    // Validate the opened object, then use this same descriptor for all I/O.
    // Never resolve the user pathname a second time after validation.
    const actualPath = await readlink(descriptorPath(current));
    if (!contains(canonicalRoot, actualPath) || actualPath.endsWith(" (deleted)")) {
      throw new FilesystemError("The workspace path changed during access.", 403, "PATH_UNSAFE");
    }
    const stats = await current.stat();
    if (stats.isSymbolicLink()) throw new FilesystemError("Symlinks are not allowed in workspace mode.", 403, "PATH_UNSAFE");
    if (directory ? !stats.isDirectory() : !stats.isFile()) {
      throw new FilesystemError(directory ? "Path is not a directory." : "Only regular files can be read.", 400);
    }
    result = directory ? current : await open(descriptorPath(current), constants.O_RDONLY | constants.O_NONBLOCK);
    return result;
  } catch (error) {
    throw filesystemError(error);
  } finally {
    await Promise.all(handles.filter((handle) => handle !== result).map((handle) => handle.close()));
  }
}

/** Unlink relative to a pinned parent. The last component is never followed by
 * unlink, so replacing it with a symlink cannot delete the symlink's target. */
export async function unlinkWorkspaceFile(root: string, target: string): Promise<void> {
  const parent = await openWorkspacePath(root, path.dirname(target), true);
  try {
    await unlink(path.join(descriptorPath(parent), path.basename(target)));
  } catch (error) {
    throw filesystemError(error);
  } finally { await parent.close(); }
}

export async function readBoundedText(handle: FileHandle, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  // Keep the limit effective even when a concurrent writer grows the file
  // after fstat. Buffer at most maxBytes + 1, not the entire changing file.
  while (total <= maxBytes) {
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
    if (!bytesRead) break;
    total += bytesRead;
    chunks.push(chunk.subarray(0, bytesRead));
  }
  if (total > maxBytes) throw new FilesystemError("File is too large for editor. Max 10MB.", 413, "FILE_TOO_LARGE");
  return Buffer.concat(chunks, total).toString("utf8");
}
