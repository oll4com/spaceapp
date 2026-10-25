import { createHash, randomUUID } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Artifact, CreateArtifactInput } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { z } from "zod";
import { FilesystemError } from "./filesystem-error.js";
import { descriptorPath, openWorkspacePath, readBoundedText } from "./workspace-filesystem.js";

const recordSchema = z.object({
  version: z.literal(1),
  reconciliationId: z.string().uuid(),
  filename: z.string().min(1).max(255).refine(value => basename(value) === value && value !== "." && value !== ".."),
  storageUri: z.string().startsWith("space-artifact://").max(4096),
  roomId: z.string().nullable(),
  traceId: z.string().max(500),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteSize: z.number().int().positive().max(100 * 1024 * 1024),
  createdAt: z.string().datetime()
});

export class UploadRecordUncertainError extends FilesystemError {
  constructor(readonly reconciliationId: string) {
    super(`Upload confirmation is uncertain. Check upload ${reconciliationId} before retrying.`, 503, "UPLOAD_RECORD_UNCERTAIN");
  }
}

/** The file is complete and pinned before entering this boundary. Journal intent
 * before the database call: an exception does not prove that COMMIT rolled back.
 * Never repeat that call or delete the file after an uncertain acknowledgement. */
export async function recordUploadedArtifact(store: SpaceStore, input: CreateArtifactInput,
  traceId: string, pinnedFilePath: string) {
  const identity = recordSchema.parse({
    version: 1, reconciliationId: randomUUID(), filename: basename(pinnedFilePath),
    storageUri: input.storageUri, roomId: input.roomId ?? null, traceId,
    sha256: input.sha256, byteSize: input.byteSize, createdAt: new Date().toISOString()
  });
  const markerPath = join(dirname(pinnedFilePath), `.upload-record-${identity.reconciliationId}.json`);
  let markerCreated = false;
  try {
    const marker = await open(markerPath, "wx", 0o600);
    markerCreated = true;
    try { await marker.writeFile(JSON.stringify(identity)); await marker.sync(); }
    finally { await marker.close(); }
    // Persist both directory entries before the database can reference the file.
    const directory = await open(dirname(pinnedFilePath), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) {
    if (markerCreated) await unlink(markerPath).catch(() => undefined);
    throw error;
  }
  let result;
  try { result = await store.createArtifact(input, traceId); }
  catch { throw new UploadRecordUncertainError(identity.reconciliationId); }
  // A stale marker is safe: reconciliation confirms the committed row. A failed
  // marker cleanup must never turn a successful COMMIT into file deletion.
  await unlink(markerPath).catch(() => undefined);
  return result;
}

/** Read-only operator reconciliation. Absence is deliberately inconclusive: the
 * original transaction may still finish. This function never retries or deletes. */
export async function inspectUploadRecord(root: string, markerPath: string,
  findArtifacts: (storageUri: string) => Promise<Array<Pick<Artifact, "id" | "sha256" | "byteSize">>> | Array<Pick<Artifact, "id" | "sha256" | "byteSize">>) {
  const parent = await openWorkspacePath(root, dirname(markerPath), true);
  try {
    const marker = await openWorkspacePath(descriptorPath(parent), join(descriptorPath(parent), basename(markerPath)));
    let record: z.infer<typeof recordSchema>;
    try {
      if ((await marker.stat()).size > 16_384) throw new Error("Upload record exceeds the metadata limit.");
      record = recordSchema.parse(JSON.parse(await readBoundedText(marker, 16_384)));
    } finally { await marker.close(); }
    const candidates = await findArtifacts(record.storageUri);
    let fileValid = false;
    try {
      const file = await openWorkspacePath(descriptorPath(parent), join(descriptorPath(parent), record.filename));
      try {
        if ((await file.stat()).size === record.byteSize) {
          const hash = createHash("sha256");
          let bytes = 0;
          for await (const chunk of file.createReadStream({ start: 0, end: record.byteSize, autoClose: false })) {
            bytes += chunk.length;
            hash.update(chunk);
          }
          fileValid = bytes === record.byteSize && hash.digest("hex") === record.sha256;
        }
      } finally { await file.close(); }
    } catch (error) {
      if (!(error instanceof FilesystemError && error.code === "NOT_FOUND")) throw error;
    }
    const matching = candidates.filter(artifact => artifact.sha256 === record.sha256 && artifact.byteSize === record.byteSize);
    const status = !fileValid ? "FILE_DAMAGED_OR_MISSING"
      : candidates.length === 1 && matching.length === 1 ? "CONFIRMED"
      : candidates.length ? "CONFLICT" : "AWAITING_CONFIRMATION";
    return { reconciliationId: record.reconciliationId, status, fileValid,
      artifactIds: candidates.map(artifact => artifact.id), storageUri: record.storageUri };
  } finally { await parent.close(); }
}
