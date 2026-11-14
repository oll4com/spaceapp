import { mkdir, open, readFile, readdir, stat, statfs, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import { safeOriginalFilename } from "./artifact-storage.js";
import { AgentFileDocxNormalizationError, type AgentFileDocxNormalizer, persistAgentFile } from "./cli-agent-files.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";

/** Technical bound: the phone channel buffers a request in memory and refuses bodies over 25 MiB (UPLOAD_MAX_BYTES); a bigger file is
 *  sent as more chunks, so nothing about the file's own size is capped here. */
export const agentFileChunkMaxBytes = 16 * 1024 * 1024;
/** Unfinished parts and finished-upload markers are class-B temporary files: one untouched for a week is swept when the same person
 *  starts another upload. shortcut: swept only on that person's next upload, upgrade to a timed sweep if staging space ever matters. */
const STALE_PART_MS = 7 * 24 * 60 * 60 * 1000;

const chunkQuerySchema = z.object({
  uploadId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  offset: z.coerce.number().int().min(0),
  total: z.coerce.number().int().min(1),
  name: z.string().min(1).max(255),
  type: z.string().max(255).optional(),
  folder: z.string().max(255).optional()
});

const userSegment = (id: string) => id.replace(/[^A-Za-z0-9_-]/g, "_");
// One API process serves the routes, so an in-process queue per upload keeps two retries of one chunk from both appending.
const locks = new Map<string, Promise<unknown>>();
function serially<T>(key: string, run: () => Promise<T>): Promise<T> {
  const next = (locks.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
  locks.set(key, next);
  return next.finally(() => { if (locks.get(key) === next) locks.delete(key); });
}

/**
 * POST /api/rooms/:id/agent-files/chunks: an Agent File sent in pieces (the Nous app's uploads, any size, resumable). Each request carries
 * the raw bytes at `offset`; a piece whose offset is not the size already received writes nothing and answers `{received}`, so a retry or a
 * resume after a lost answer is harmless. The last piece moves the file into Agent Files exactly as the multipart upload does.
 */
export function registerAgentFileChunkRoute(app: FastifyInstance, deps: {
  artifactRoot: string;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  docxNormalizer?: AgentFileDocxNormalizer;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  app.register(async (child) => {
    child.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: agentFileChunkMaxBytes }, (_request, body, done) => done(null, body));
    child.post("/api/rooms/:id/agent-files/chunks", deps.routeOptions, async (request, reply) => {
      const params = parseBody(idParamSchema, request.params);
      const query = parseQuery(chunkQuerySchema, request.query);
      await deps.store.getRoom(params.id);
      const body = Buffer.isBuffer(request.body) ? request.body : null;
      if (!body) return sendApiError(reply, 400, "BAD_REQUEST", "Send the piece as application/octet-stream.");
      const userId = request.user?.id ?? "anonymous";
      const directory = path.join(deps.artifactRoot, "agent-file-chunks", userSegment(userId));
      const partPath = path.join(directory, `${query.uploadId}.part`);
      const donePath = path.join(directory, `${query.uploadId}.done`);
      return serially(partPath, async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        // A retry of the last piece after its answer was lost gets the same artifact instead of a second copy.
        const done = await readFile(donePath, "utf8").then((id) => deps.store.getArtifact(id.trim())).catch(() => null);
        if (done) return { received: query.total, artifact: done };
        if (query.offset === 0) await sweepStaleParts(directory, partPath);
        const received = await stat(partPath).then((s) => s.size, () => 0);
        if (query.offset !== received || received >= query.total) return { received };
        if (received + body.length > query.total) {
          await unlink(partPath).catch(() => undefined);
          return sendApiError(reply, 400, "BAD_REQUEST", "The pieces are longer than the file's total size; start the upload again.");
        }
        const disk = await statfs(deps.artifactRoot);
        if (Number(disk.bavail) * Number(disk.bsize) < 1024 ** 3 + 2 * body.length) {
          return sendApiError(reply, 507, "STORAGE_FULL", "Uploading requires at least 1 GiB free space.");
        }
        const handle = await open(partPath, "a", 0o600);
        try { await handle.write(body); await handle.sync(); } finally { await handle.close(); }
        const now = received + body.length;
        if (now < query.total) return { received: now };

        const folder = query.folder?.trim() || undefined;
        let record: Awaited<ReturnType<typeof persistAgentFile>>;
        try {
          record = await persistAgentFile({
            store: deps.store, artifactRoot: deps.artifactRoot, roomId: params.id, paneId: null, cliSessionId: null, runtimeId: "user",
            originalFilename: safeOriginalFilename(query.name), declaredMimeType: query.type || "application/octet-stream",
            sourcePath: partPath, maxBytes: query.total, traceId: request.requestIdForSpace, source: "USER_UPLOAD", folder,
            docxNormalizer: deps.docxNormalizer
          });
        } catch (error) {
          if (error instanceof AgentFileDocxNormalizationError) return sendApiError(reply, 422, "DOCX_NORMALIZATION_FAILED", error.message);
          throw error;
        } finally {
          await unlink(partPath).catch(() => undefined);
        }
        await writeFile(donePath, record.artifact.id, { mode: 0o600 });
        deps.eventBus.publish(record.event);
        await recordAudit(deps.store, request, {
          action: "agent_file.upload", targetType: "room", targetId: params.id,
          metadata: { roomId: params.id, userId, folder, artifactCount: 1, artifactIds: [record.artifact.id], totalBytes: query.total, chunked: true }
        });
        return { received: now, artifact: record.artifact };
      });
    });
  });
}

async function sweepStaleParts(directory: string, keep: string) {
  const cutoff = Date.now() - STALE_PART_MS;
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    const file = path.join(directory, name);
    if (file === keep || !/\.(part|done)$/.test(name)) continue;
    const info = await stat(file).catch(() => null);
    if (info && info.mtimeMs < cutoff) await unlink(file).catch(() => undefined);
  }
}
