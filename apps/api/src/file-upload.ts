import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, rename, rm, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FilesystemError } from "./filesystem-error.js";
import { descriptorPath } from "./workspace-filesystem.js";

export const fileUploadLimits = { fileBytes: 100 * 1024 * 1024, requestBytes: 250 * 1024 * 1024, files: 10, concurrent: 4 };
let activeUploads = 0;

export function acquireFileUpload(): () => void {
  if (activeUploads >= fileUploadLimits.concurrent) throw new FilesystemError("Too many concurrent file uploads.", 429, "UPLOAD_BUSY");
  activeUploads++;
  let released = false;
  return () => { if (!released) { released = true; activeUploads--; } };
}

export interface StagedUpload {
  destination: string;
  byteSize: number;
  sha256: string;
  sample: Buffer;
  commit(): Promise<void>;
  cleanup(): Promise<void>;
}

/** The parent descriptor pins the destination throughout streaming and rename.
 * The existing destination is untouched until the entire multipart body passes. */
export async function stageFileUpload(options: {
  directory: string;
  filename: string;
  source: Readable & { truncated?: boolean };
  budget: { bytes: number };
  signal?: AbortSignal;
  fileBytes?: number;
}): Promise<StagedUpload> {
  const filename = path.basename(options.filename);
  if (!filename || filename === "." || filename === ".." || /[\x00-\x1f\x7f]/.test(filename)) {
    throw new FilesystemError("Invalid upload filename.", 400, "INVALID_FILENAME");
  }
  const parent = await open(options.directory, constants.O_RDONLY | constants.O_DIRECTORY);
  const temporary = `${descriptorPath(parent)}/.space-upload-${randomUUID()}`;
  const destination = `${descriptorPath(parent)}/${filename}`;
  let file: FileHandle | undefined;
  let bytes = 0;
  const hash = createHash("sha256");
  const sample = Buffer.alloc(8192);
  let sampled = 0;
  let committed = false;
  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try { if (!committed) await rm(temporary, { force: true }); }
    finally { await parent.close(); }
  };
  try {
    file = await open(temporary, "wx", 0o600);
    // Multipart can fail while opening the destination asynchronously. Such a
    // stream has already emitted its error; pipeline alone can wait forever.
    if (options.source.errored) throw options.source.errored;
    if (options.source.destroyed && !options.source.readableEnded) {
      throw new FilesystemError("File upload was interrupted.", 400, "UPLOAD_ABORTED");
    }
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        options.budget.bytes += chunk.length;
        // A route names its own cap (the Video pane's sources go past the shared 100 MiB); the request budget grows with it.
        const cap = options.fileBytes ?? fileUploadLimits.fileBytes;
        if (bytes > cap || options.budget.bytes > Math.max(fileUploadLimits.requestBytes, cap)) {
          callback(new FilesystemError("File upload exceeded its byte limit.", 413, "UPLOAD_TOO_LARGE"));
        } else {
          hash.update(chunk);
          sampled += chunk.copy(sample, sampled, 0, sample.length - sampled);
          callback(null, chunk);
        }
      }
    });
    await pipeline(options.source, limiter, file.createWriteStream(), { signal: options.signal });
    if (options.source.truncated) throw new FilesystemError("File upload exceeded its byte limit.", 413, "UPLOAD_TOO_LARGE");
    return {
      destination: path.join(options.directory, filename),
      byteSize: bytes,
      sha256: hash.digest("hex"),
      sample: sample.subarray(0, sampled),
      async commit() { await rename(temporary, destination); committed = true; },
      cleanup
    };
  } catch (error) {
    await file?.close();
    await cleanup();
    throw error;
  }
}
