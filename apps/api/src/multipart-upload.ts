import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, open, rm, statfs, unlink } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { FastifyRequest } from "fastify";
import { turnArtifactMaxCount } from "@space/contracts";
import { acquireFileUpload, stageFileUpload } from "./file-upload.js";
import { FilesystemError } from "./filesystem-error.js";
import { descriptorPath, openWorkspacePath } from "./workspace-filesystem.js";
import { UploadRecordUncertainError } from "./upload-record.js";

export interface StagedFile {
  sourcePath: string;
  filename: string;
  fieldname: string;
  declaredMimeType: string;
  byteSize: number;
  sha256: string;
  sample: Buffer;
}

/** JSON Control publishing has a small, schema-bounded body. Retain the same
 * upload admission, private staging and persistence boundary as multipart. */
export async function withStagedBufferUpload<T>(root: string, input: {
  buffer: Buffer; filename: string; mimeType: string;
}, consume: (upload: StagedFile) => Promise<T>): Promise<T> {
  const release = acquireFileUpload();
  let directory: string | undefined;
  try {
    if (!input.buffer.length || input.buffer.length > 1024 * 1024) {
      throw new FilesystemError("Control upload must contain 1 byte to 1 MiB.", 413, "UPLOAD_TOO_LARGE");
    }
    const disk = await statfs(root);
    if (Number(disk.bavail) * Number(disk.bsize) < 1024 ** 3 + 2 * input.buffer.length) {
      throw new FilesystemError("Uploading requires at least 1 GiB free space after upload.", 507, "STORAGE_FULL");
    }
    directory = await mkdtemp(path.join(root, ".incoming-uploads-"));
    const staged = await stageFileUpload({ directory, filename: randomUUID(), source: Readable.from([input.buffer]),
      budget: { bytes: 0 }, fileBytes: 1024 * 1024 });
    try { await staged.commit(); } finally { await staged.cleanup(); }
    return await consume({ sourcePath: staged.destination, filename: input.filename, fieldname: "file",
      declaredMimeType: input.mimeType, byteSize: staged.byteSize, sha256: staged.sha256, sample: staged.sample });
  } finally {
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { release(); }
  }
}

/** Fully parse into private disk staging before allowing persistence. All upload
 * routes share admission/backpressure and the aggregate request byte budget. */
export async function withStagedUploads<T>(request: FastifyRequest, root: string, options: {
  maxFiles: number;
  fileBytes: number;
  /** A route whose schema has more form fields than the plugin's default (4) raises the limit for itself only. */
  fields?: number;
  onField?: (name: string, value: unknown) => void;
}, consume: (uploads: StagedFile[], totalBytes: number) => Promise<T>): Promise<T> {
  const release = acquireFileUpload();
  let directory: string | undefined;
  const abort = new AbortController();
  const onAbort = () => abort.abort();
  request.raw.once("aborted", onAbort);
  if (request.raw.aborted) abort.abort();
  try {
    const disk = await statfs(root);
    if (Number(disk.bavail) * Number(disk.bsize) < 1024 ** 3) {
      throw new FilesystemError("Uploading requires at least 1 GiB free space.", 507, "STORAGE_FULL");
    }
    directory = await mkdtemp(path.join(root, ".incoming-uploads-"));
    const budget = { bytes: 0 };
    const uploads: StagedFile[] = [];
    // A route that takes more files than the plugin's global limit (turnArtifactMaxCount + 1) raises it for itself only.
    const moreFiles = options.maxFiles > turnArtifactMaxCount ? { files: options.maxFiles + 1, parts: options.maxFiles + 1 + (options.fields ?? 4) } : {};
    const limits = { ...(options.fields ? { fields: options.fields } : {}), ...moreFiles };
    for await (const part of request.parts(Object.keys(limits).length ? { limits } : undefined)) {
      if (part.type === "field") { options.onField?.(part.fieldname, part.value); continue; }
      if (uploads.length >= options.maxFiles) throw new FilesystemError(`At most ${options.maxFiles} files can be uploaded at once.`, 422, "UPLOAD_LIMIT_EXCEEDED");
      const staged = await stageFileUpload({ directory, filename: randomUUID(), source: part.file, budget, signal: abort.signal, fileBytes: options.fileBytes });
      try { await staged.commit(); }
      finally { await staged.cleanup(); }
      if (!staged.byteSize) throw new FilesystemError("Uploaded files must not be empty.", 422, "EMPTY_UPLOAD");
      uploads.push({ sourcePath: staged.destination, filename: part.filename || "upload", fieldname: part.fieldname,
        declaredMimeType: part.mimetype || "application/octet-stream", byteSize: staged.byteSize, sha256: staged.sha256, sample: staged.sample });
    }
    if (!uploads.length) throw new FilesystemError("Upload at least one file.", 422, "EMPTY_UPLOAD");
    const remaining = await statfs(root);
    if (Number(remaining.bavail) * Number(remaining.bsize) < budget.bytes + 1024 ** 3) {
      throw new FilesystemError("Uploading requires at least 1 GiB free space after upload.", 507, "STORAGE_FULL");
    }
    if (abort.signal.aborted) throw new FilesystemError("File upload was interrupted.", 400, "UPLOAD_ABORTED");
    return await consume(uploads, budget.bytes);
  } finally {
    request.raw.off("aborted", onAbort);
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { release(); }
  }
}

/** Create an exclusive file through pinned, no-follow ancestors; stream and
 * verify it before recording it. Uncertain database outcomes retain the complete
 * file and their reconciliation marker; definite pre-record failures clean up. */
export async function withPersistedUpload<T>(root: string, upload: StagedFile, destination: string,
  record: (pinnedPath: string) => T | Promise<T>, mode = 0o644, sourceRoot = root): Promise<T> {
  const parent = await openWorkspacePath(root, path.dirname(destination), true, true);
  const pinned = path.join(descriptorPath(parent), path.basename(destination));
  let created = false;
  try {
    const source = await openWorkspacePath(sourceRoot, upload.sourcePath);
    try {
      const output = await open(pinned, "wx", mode);
      created = true;
      try {
        const hash = createHash("sha256");
        let bytes = 0;
        for await (const chunk of source.createReadStream({ start: 0, end: upload.byteSize, autoClose: false })) {
          bytes += chunk.length;
          if (bytes > upload.byteSize) throw new FilesystemError("Staged upload changed.", 409, "UPLOAD_CHANGED");
          hash.update(chunk);
          await output.writeFile(chunk);
        }
        if (bytes !== upload.byteSize || hash.digest("hex") !== upload.sha256) throw new FilesystemError("Staged upload changed.", 409, "UPLOAD_CHANGED");
        await output.chmod(mode);
        await output.sync();
      } finally { await output.close(); }
    } finally { await source.close(); }
    return await record(pinned);
  } catch (error) {
    if (created && !(error instanceof UploadRecordUncertainError)) await unlink(pinned);
    throw error;
  } finally { await parent.close(); }
}

/** Only use for parsers/provider clients that require a buffer, while holding
 * upload admission. Allocation is bounded by the route's already checked limit. */
export async function readStagedUpload(root: string, upload: StagedFile): Promise<Buffer> {
  const source = await openWorkspacePath(root, upload.sourcePath);
  try {
    const buffer = Buffer.alloc(upload.byteSize);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await source.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== buffer.length || createHash("sha256").update(buffer).digest("hex") !== upload.sha256) {
      throw new FilesystemError("Staged upload changed.", 409, "UPLOAD_CHANGED");
    }
    return buffer;
  } finally { await source.close(); }
}
