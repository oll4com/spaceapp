import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NOUS_ATTACHMENTS_PER_MESSAGE, nousAttachmentIdSchema } from "@space/contracts";
import { InMemoryNousAttachmentRepository, PostgresNousAttachmentRepository, type NousAttachmentRepository } from "@space/db";
import { applyFileResponsePolicy } from "../file-response-policy.js";
import { withStagedUploads } from "../multipart-upload.js";
import { openWorkspacePath } from "../workspace-filesystem.js";
import { createNousAttachments, NOUS_ATTACHMENT_LIMITS, type NousAttachments } from "./attachments.js";

const idParams = z.object({ id: nousAttachmentIdSchema }).strict();
const fileQuery = z.object({ download: z.enum(["1"]).optional(), preview: z.enum(["1"]).optional() }).strict();
const SWEEP_MS = 3_600_000;

/**
 * The dock's file routes for Nous (plan clipboard:hQg9iKGYDqx7): upload, serve (with ranges, so a video can seek),
 * remove an unsent file; an hourly sweep removes unsent files after a day and every file after 30 days. Owner-scoped:
 * another user's file is not found.
 */
export function registerNousAttachments(app: FastifyInstance, deps: {
  /** The API config: databaseUrl, and browserEvidenceArtifactRoot where files are stored. */
  config: { databaseUrl?: string | null; browserEvidenceArtifactRoot?: string };
  routeOptions: Record<string, unknown>;
  owner(request: FastifyRequest): Promise<string>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
  repository?: NousAttachmentRepository;
  readerWorkerPath?: string;
}): NousAttachments {
  const root = deps.config.browserEvidenceArtifactRoot || process.env.SPACE_ARTIFACT_ROOT || "/opt/spaceapp/var/artifacts";
  const repository = deps.repository
    ?? (deps.config.databaseUrl ? PostgresNousAttachmentRepository.fromConnectionString(deps.config.databaseUrl) : new InMemoryNousAttachmentRepository());
  const attachments = createNousAttachments({ repository, root, readerWorkerPath: deps.readerWorkerPath });
  const { routeOptions, parseQuery } = deps;

  app.post("/api/nous/attachments", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const stored = await withStagedUploads(request, root, { maxFiles: NOUS_ATTACHMENTS_PER_MESSAGE, fileBytes: NOUS_ATTACHMENT_LIMITS.VIDEO },
      (uploads) => attachments.store(owner, uploads));
    return reply.code(201).send({ attachments: stored });
  });

  app.get("/api/nous/attachments/:id", routeOptions, async (request, reply) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(idParams, request.params);
    const query = parseQuery(fileQuery, request.query);
    const { attachment, path, mimeType } = await attachments.file(owner, id, query.preview === "1");
    const handle = await openWorkspacePath(root, path);
    try {
      const size = (await handle.stat()).size;
      applyFileResponsePolicy(reply, mimeType, query.preview === "1" ? `${attachment.filename}.jpg` : attachment.filename, query.download === "1");
      // A stored file never changes: the dock's thumbnails and players reuse the browser cache.
      if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) reply.header("cache-control", "private, max-age=86400");
      reply.header("accept-ranges", "bytes");
      const range = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ""));
      if (range && size > 0 && (range[1] || range[2])) {
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
        if (start > end || start >= size) {
          await handle.close();
          return reply.code(416).header("content-range", `bytes */${size}`).send();
        }
        reply.code(206).header("content-range", `bytes ${start}-${end}/${size}`).header("content-length", String(end - start + 1));
        return reply.send(handle.createReadStream({ start, end }));
      }
      reply.header("content-length", String(size));
      return reply.send(handle.createReadStream());
    } catch (error) { await handle.close(); throw error; }
  });

  app.delete("/api/nous/attachments/:id", routeOptions, async (request) => {
    const owner = await deps.owner(request);
    const { id } = parseQuery(idParams, request.params);
    await attachments.removeUnsent(owner, id);
    return { removed: true };
  });

  const sweep = setInterval(() => { void attachments.sweep().catch((error) => app.log.warn({ err: error }, "Nous attachment sweep failed.")); }, SWEEP_MS);
  sweep.unref?.();
  app.addHook("onClose", async () => { clearInterval(sweep); await repository.dispose(); });
  return attachments;
}
