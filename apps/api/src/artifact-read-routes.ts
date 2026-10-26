import type { FastifyInstance, FastifyReply, FastifyRequest, RouteShorthandOptions } from "fastify";
import type { FileHandle } from "node:fs/promises";
import { z } from "zod";
import { idSchema, isAgentFileArtifact, listArtifactsQuerySchema } from "@space/contracts";
import { SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import { artifactFilename, localArtifactFilePath } from "./artifact-storage.js";
import { openWorkspacePath, descriptorPath } from "./workspace-filesystem.js";
import { applyFileResponsePolicy } from "./file-response-policy.js";
import { agentFilePreviewKind, readAgentFileTextPreview, renderAgentFileDocxPreview } from "./cli-agent-files.js";
import { sendApiError } from "./http-errors.js";
import { imageDimensions, readPngText } from "./design/images.js";

const idParamSchema = z.object({ id: idSchema });

/** A file's bytes, or the one range a player asks for (`Range: bytes=a-b`); the stream closes the handle. */
async function sendBytes(request: FastifyRequest, reply: FastifyReply, handle: FileHandle, size: number) {
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
}
/** Images up to the Design pane's limit are read for their size and embedded metadata; larger files answer the record only. */
const METADATA_READ_MAX_BYTES = 25 * 1024 * 1024;

/** Read-only artifact domain. Authentication and request/error policies remain
 * owned by the composition root; registration does not create service timers. */
export function registerArtifactReadRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "listArtifacts" | "getArtifact" | "listRooms">;
  artifactRoot: string;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, artifactRoot, routeOptions } = options;
  app.get("/api/artifacts", routeOptions, async (request) => {
    const page = listArtifactsQuerySchema.parse(request.query);
    let artifacts = await store.listArtifacts(page);
    // A USER lists only artifacts of their own rooms (a roomId or paneId in the query is checked centrally).
    if (request.user?.role === "USER") {
      const owned = new Set((await store.listRooms(request.user.id)).map((room) => room.id));
      artifacts = artifacts.filter((artifact) => artifact.roomId !== null && owned.has(artifact.roomId));
    }
    const start = (page.page - 1) * page.pageSize;
    return {
      data: artifacts.slice(start, start + page.pageSize),
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: artifacts.length,
        totalPages: Math.ceil(artifacts.length / page.pageSize)
      }
    };
  });
  app.get("/api/artifacts/:id/file", routeOptions, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const artifact = await store.getArtifact(params.id);
    if (artifact.deletedAt) {
      throw new SpaceNotFoundError(`Artifact ${artifact.id} was not found.`);
    }
    const filePath = localArtifactFilePath({ artifactRoot, artifact });
    const handle = await openWorkspacePath(artifactRoot, filePath);
    try {
      const fileStat = await handle.stat();
      const filename = artifactFilename(artifact);
      applyFileResponsePolicy(reply, artifact.mimeType, filename);
      // An artifact's bytes never change: images (CLI photo thumbnails and viewer) reuse the browser cache.
      if (artifact.mimeType.toLowerCase().startsWith("image/")) {
        reply.header("cache-control", "private, max-age=86400, stale-while-revalidate=604800");
      }
      // A player scrubs a video or a track with byte ranges (the Video pane's Studio and Library).
      return await sendBytes(request, reply, handle, fileStat.size);
    } catch (error) { await handle.close(); throw error; }
  });
  // What the Details dialog shows (Agent Files and the Design pane): the record, an image's measured size and the metadata a
  // PNG carries inside (a design's description and who made it, `spaceapp:design`).
  app.get("/api/artifacts/:id/metadata", routeOptions, async (request) => {
    const params = idParamSchema.parse(request.params);
    const artifact = await store.getArtifact(params.id);
    if (artifact.deletedAt) {
      throw new SpaceNotFoundError(`Artifact ${artifact.id} was not found.`);
    }
    let image: { width: number; height: number } | null = null;
    let embedded: Record<string, string> = {};
    if (artifact.mimeType.toLowerCase().startsWith("image/") && artifact.byteSize <= METADATA_READ_MAX_BYTES) {
      const handle = await openWorkspacePath(artifactRoot, localArtifactFilePath({ artifactRoot, artifact }));
      try {
        const bytes = await handle.readFile();
        image = imageDimensions(bytes);
        embedded = readPngText(bytes);
      } finally { await handle.close(); }
    }
    let design: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = embedded["spaceapp:design"] ? JSON.parse(embedded["spaceapp:design"]) : null;
      design = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch { design = null; }
    return {
      artifact: { id: artifact.id, filename: artifactFilename(artifact), mimeType: artifact.mimeType, byteSize: artifact.byteSize, sha256: artifact.sha256,
        createdAt: artifact.createdAt, roomId: artifact.roomId, metadata: artifact.metadata },
      image, embedded, design
    };
  });
  app.get("/api/artifacts/:id/download", routeOptions, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const artifact = await store.getArtifact(params.id);
    if (artifact.deletedAt || !isAgentFileArtifact(artifact)) {
      throw new SpaceNotFoundError(`Agent File ${artifact.id} was not found.`);
    }
    const filePath = localArtifactFilePath({ artifactRoot, artifact });
    const handle = await openWorkspacePath(artifactRoot, filePath);
    try {
      const fileStat = await handle.stat();
      const filename = artifactFilename(artifact);
      applyFileResponsePolicy(reply, artifact.mimeType, filename, true);
      reply.header("content-length", String(fileStat.size));
      return reply.send(handle.createReadStream());
    } catch (error) { await handle.close(); throw error; }
  });
  app.get("/api/artifacts/:id/preview", routeOptions, async (request, reply) => {
    const params = idParamSchema.parse(request.params);
    const artifact = await store.getArtifact(params.id);
    if (artifact.deletedAt || !isAgentFileArtifact(artifact)) {
      throw new SpaceNotFoundError(`Agent File ${artifact.id} was not found.`);
    }
    const filePath = localArtifactFilePath({ artifactRoot, artifact });
    const handle = await openWorkspacePath(artifactRoot, filePath);
    let streaming = false;
    try {
      const fileStat = await handle.stat();
      applyFileResponsePolicy(reply, artifact.mimeType, artifactFilename(artifact));
      const previewKind = agentFilePreviewKind(artifact);
      if (previewKind === "IMAGE") {
        reply.header("cache-control", "private, max-age=86400, stale-while-revalidate=604800");
      } else {
        reply.header("cache-control", "private, no-store");
      }
      if (previewKind === "TEXT") {
        const preview = await readAgentFileTextPreview(descriptorPath(handle));
        reply
          .type("text/plain; charset=utf-8")
          .header("x-space-preview-truncated", preview.truncated ? "true" : "false");
        return reply.send(preview.content);
      }
      if (previewKind === "DOCX") {
        try {
          const html = await renderAgentFileDocxPreview(`/proc/${process.pid}/fd/${handle.fd}`);
          reply
            .type("text/html; charset=utf-8")
            .header("content-disposition", "inline")
            .header(
              "content-security-policy",
              "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox"
            );
          return reply.send(html);
        } catch (error) {
          request.log.info(
            {
              artifactId: artifact.id,
              errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "UNKNOWN"
            },
            "Agent File DOCX preview unavailable"
          );
          return sendApiError(reply, 422, "PREVIEW_UNAVAILABLE", "This DOCX could not be rendered safely. Download remains available.");
        }
      }
      if (previewKind === "IMAGE" || previewKind === "VIDEO" || previewKind === "AUDIO" || previewKind === "PDF") {
        reply.type(artifact.mimeType);
        streaming = true;
        // Byte ranges, so a long video plays and seeks without loading all of it first.
        return await sendBytes(request, reply, handle, fileStat.size);
      }
      return sendApiError(reply, 415, "PREVIEW_UNSUPPORTED", "Preview is not available for this file type. Download remains available.");
    } finally { if (!streaming) await handle.close(); }
  });
}
