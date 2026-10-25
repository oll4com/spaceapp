export class FilesystemError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = "FILESYSTEM_ERROR") {
    super(message);
    this.name = "FilesystemError";
  }
}

export function filesystemError(error: unknown): FilesystemError {
  if (error instanceof FilesystemError) return error;
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === "ELOOP" || code === "ENOTDIR") {
    return new FilesystemError("Symlinks and invalid path ancestors are not allowed in workspace mode.", 403, "PATH_UNSAFE");
  }
  if (code === "EACCES" || code === "EPERM") return new FilesystemError("Filesystem permission denied.", 403, "PERMISSION_DENIED");
  if (code === "ENOENT") return new FilesystemError("File or directory was not found.", 404, "NOT_FOUND");
  return new FilesystemError("Filesystem operation failed.", 500);
}
