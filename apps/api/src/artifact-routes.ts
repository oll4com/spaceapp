import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  type Artifact, browserEvidenceCaptureSchema, browserEvidenceViewportSchema, createArtifactInputSchema,
  deleteRoomAgentFilesResponseSchema, deleteRoomMediaResponseSchema, idSchema, imageArtifactMaxBytes,
  isRoomMediaArtifact, paneCliUploadMaxCount, turnArtifactMaxCount, updateArtifactRetentionInputSchema,
  userUploadArtifactSourceSchema
} from "@space/contracts";
import {
  SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore
} from "@space/runtime";
import { withStagedAgentFiles } from "./agent-file-upload.js";
import { permanentlyDeleteLocalArtifact, safeOriginalFilename } from "./artifact-storage.js";
import {
  type BrowserEvidenceCaptureHandler, buildBrowserEvidenceTargetUrl, requireEvidenceArtifactKinds
} from "./browser-evidence.js";
import { AgentFileDocxNormalizationError, type AgentFileDocxNormalizer, persistAgentFile } from "./cli-agent-files.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";
import { withPersistedUpload, withStagedUploads } from "./multipart-upload.js";
import { assertPaneBelongsToRoom } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { idParamSchema, parseBody, parseQuery } from "./route-parsing.js";
import {
  buildGenericUserUploadStorage, buildUserUploadStorage, type ImageArtifactMimeType, inferUploadMimeType,
  isAllowedImageMime, isVideoMimeType, paneArtifactUploadMaxBytes, sniffImageMime
} from "./upload-media.js";
import { recordUploadedArtifact } from "./upload-record.js";

const uploadArtifactsQuerySchema = z.object({
  roomId: idSchema,
  paneId: idSchema.optional(),
  source: userUploadArtifactSourceSchema.default("USER_UPLOAD")
});

const screenCaptureInputSchema = z.object({
  paneId: idSchema.nullable().optional(),
  viewport: browserEvidenceViewportSchema.default("desktop")
});

/**
 * Artifact retention, deletion and uploads, room media and Agent Files uploads, and screen captures; the parent
 * retains authentication, CSRF, errors and rate limits.
 */
export function registerArtifactRoutes(app: FastifyInstance, deps: {
  options: { agentFileDocxNormalizer?: AgentFileDocxNormalizer };
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  browserEvidenceCapture: BrowserEvidenceCaptureHandler;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { options, config, store, eventBus, browserEvidenceCapture, routeOptions: defaultRouteRateLimitOptions } = deps;
  app.patch("/api/artifacts/:id/retention", defaultRouteRateLimitOptions, async (request) => {
    const params = parseBody(idParamSchema, request.params);
    const input = parseBody(updateArtifactRetentionInputSchema, request.body ?? {});
    const current = await store.getArtifact(params.id);
    if (current.deletedAt) {
      throw new SpaceNotFoundError(`Artifact ${current.id} was not found.`);
    }
    const artifact = await store.updateArtifactRetention(params.id, input);
    await recordAudit(store, request, {
      action: "artifact.retention.update",
      targetType: "artifact",
      targetId: artifact.id,
      metadata: {
        roomId: artifact.roomId,
        paneId: artifact.paneId,
        expiresAt: artifact.expiresAt,
        pinnedAt: artifact.pinnedAt
      }
    });
    return artifact;
  });
  app.delete("/api/artifacts/:id", defaultRouteRateLimitOptions, async (request, reply) => {
    const params = parseBody(idParamSchema, request.params);
    const artifact = await store.getArtifact(params.id);
    const deleted = await permanentlyDeleteLocalArtifact({ store, artifactRoot: config.browserEvidenceArtifactRoot, artifact });
    await recordAudit(store, request, {
      action: "artifact.delete",
      targetType: "artifact",
      targetId: deleted.id,
      metadata: {
        roomId: deleted.roomId,
        paneId: deleted.paneId,
        kind: deleted.kind,
        byteSize: deleted.byteSize,
        storageUri: deleted.storageUri
      }
    });
    return { ok: true, artifactId: deleted.id };
  });
  app.delete("/api/rooms/:id/media", defaultRouteRateLimitOptions, async (request) => {
    const params = parseBody(idParamSchema, request.params);
    await store.getRoom(params.id);
    const mediaArtifacts = (await store.listArtifacts({
      page: 1,
      pageSize: 100,
      sortOrder: "desc",
      roomId: params.id
    })).filter(isRoomMediaArtifact);
    const failedArtifactIds: string[] = [];
    let deletedCount = 0;
    for (const artifact of mediaArtifacts) {
      try {
        await permanentlyDeleteLocalArtifact({ store, artifactRoot: config.browserEvidenceArtifactRoot, artifact });
        deletedCount += 1;
      } catch (error) {
        failedArtifactIds.push(artifact.id);
        request.log.warn(
          {
            roomId: params.id,
            artifactId: artifact.id,
            errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "UNKNOWN"
          },
          "Room media artifact deletion failed."
        );
      }
    }
    const result = deleteRoomMediaResponseSchema.parse({
      ok: failedArtifactIds.length === 0,
      roomId: params.id,
      matchedCount: mediaArtifacts.length,
      deletedCount,
      failedCount: failedArtifactIds.length,
      failedArtifactIds
    });
    await recordAudit(store, request, {
      action: "room.media.clear",
      targetType: "room",
      targetId: params.id,
      metadata: {
        matchedCount: result.matchedCount,
        deletedCount: result.deletedCount,
        failedCount: result.failedCount
      }
    });
    return result;
  });
  app.post("/api/rooms/:id/agent-files/uploads", defaultRouteRateLimitOptions, async (request, reply) => {
    const params = parseBody(idParamSchema, request.params);
    await store.getRoom(params.id);
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "BAD_REQUEST", "Agent Files uploads must use multipart/form-data.");
    }

    let folder: string | null = null;
    return withStagedAgentFiles(request, config.browserEvidenceArtifactRoot, async (uploads, totalBytes) => {
      const artifacts: Artifact[] = [];
      for (const upload of uploads) {
        let record: Awaited<ReturnType<typeof persistAgentFile>>;
        try {
          record = await persistAgentFile({
            store,
            artifactRoot: config.browserEvidenceArtifactRoot,
            roomId: params.id,
            paneId: null,
            cliSessionId: null,
            runtimeId: "user",
            originalFilename: upload.filename,
            declaredMimeType: upload.declaredMimeType,
            sourcePath: upload.sourcePath,
            traceId: request.requestIdForSpace,
            source: "USER_UPLOAD",
            folder: folder || undefined,
            docxNormalizer: options.agentFileDocxNormalizer
          });
        } catch (error) {
          if (error instanceof AgentFileDocxNormalizationError) {
            return sendApiError(reply, 422, "DOCX_NORMALIZATION_FAILED", error.message);
          }
          throw error;
        }
        eventBus.publish(record.event);
        artifacts.push(record.artifact);
      }
      await recordAudit(store, request, {
        action: "agent_file.upload",
        targetType: "room",
        targetId: params.id,
        metadata: {
          roomId: params.id,
          userId: request.user?.id ?? null,
          folder: folder || undefined,
          artifactCount: artifacts.length,
          artifactIds: artifacts.map((artifact) => artifact.id),
          totalBytes
        }
      });
      return { artifacts };
    }, (name, value) => {
      if (name === "folder") folder = typeof value === "string" ? value.trim() : null;
    });
  });
  app.delete("/api/rooms/:id/agent-files", defaultRouteRateLimitOptions, async (request) => {
    const params = parseBody(idParamSchema, request.params);
    await store.getRoom(params.id);
    const agentFiles = await store.listArtifacts({
      page: 1,
      pageSize: 100,
      sortOrder: "desc",
      roomId: params.id,
      collection: "AGENT_FILES"
    });
    if (agentFiles.length > 10_000) {
      throw new SpaceConflictError("Agent Files clear is limited to 10,000 files per operation.");
    }
    const failedArtifactIds: string[] = [];
    let deletedCount = 0;
    for (const artifact of agentFiles) {
      try {
        await permanentlyDeleteLocalArtifact({ store, artifactRoot: config.browserEvidenceArtifactRoot, artifact });
        deletedCount += 1;
      } catch (error) {
        failedArtifactIds.push(artifact.id);
        request.log.warn(
          {
            roomId: params.id,
            artifactId: artifact.id,
            errorCode: error instanceof Error ? (error as NodeJS.ErrnoException).code ?? error.name : "UNKNOWN"
          },
          "Room Agent File deletion failed."
        );
      }
    }
    const result = deleteRoomAgentFilesResponseSchema.parse({
      ok: failedArtifactIds.length === 0,
      roomId: params.id,
      matchedCount: agentFiles.length,
      deletedCount,
      failedCount: failedArtifactIds.length,
      failedArtifactIds
    });
    await recordAudit(store, request, {
      action: "room.agent_files.clear",
      targetType: "room",
      targetId: params.id,
      metadata: {
        matchedCount: result.matchedCount,
        deletedCount: result.deletedCount,
        failedCount: result.failedCount
      }
    });
    return result;
  });
  app.post("/api/artifacts/uploads", defaultRouteRateLimitOptions, async (request, reply) => {
    const query = parseQuery(uploadArtifactsQuerySchema, request.query);
    await store.getRoom(query.roomId);
    await assertPaneBelongsToRoom(store, query.roomId, query.paneId ?? null);
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "BAD_REQUEST", "Image uploads must use multipart/form-data.");
    }

    return withStagedUploads(request, config.browserEvidenceArtifactRoot,
      { maxFiles: turnArtifactMaxCount, fileBytes: imageArtifactMaxBytes }, async uploads => {
      for (const upload of uploads) {
        if (!isAllowedImageMime(upload.declaredMimeType) || sniffImageMime(upload.sample) !== upload.declaredMimeType) {
          return sendApiError(reply, 422, "UNSUPPORTED_MEDIA_TYPE", "Uploaded image bytes do not match a supported PNG, JPEG, or WebP image type.");
        }
      }
      const artifacts: Artifact[] = [];
      for (const upload of uploads) {
        const storage = buildUserUploadStorage({
          artifactRoot: config.browserEvidenceArtifactRoot,
          roomId: query.roomId,
          mimeType: upload.declaredMimeType as ImageArtifactMimeType
        });
        const record = await withPersistedUpload(config.browserEvidenceArtifactRoot, upload, storage.filePath, pinnedPath => recordUploadedArtifact(store,
          {
            roomId: query.roomId,
            paneId: query.paneId ?? null,
            kind: "IMAGE",
            mimeType: upload.declaredMimeType as ImageArtifactMimeType,
            storageUri: storage.storageUri,
            sha256: upload.sha256,
            byteSize: upload.byteSize,
            metadata: {
              source: query.source,
              originalFilename: safeOriginalFilename(upload.filename),
              fieldName: upload.fieldname,
              declaredMimeType: upload.declaredMimeType,
              sniffedMimeType: sniffImageMime(upload.sample),
              uploadedBy: request.user?.id ?? null
            }
          },
          request.requestIdForSpace, pinnedPath
        ));
        eventBus.publish(record.event);
        artifacts.push(record.artifact);
      }
      await recordAudit(store, request, {
        action: "artifact.upload",
        targetType: "room",
        targetId: query.roomId,
        metadata: {
          roomId: query.roomId,
          paneId: query.paneId ?? null,
          source: query.source,
          artifactCount: artifacts.length,
          artifactIds: artifacts.map((artifact) => artifact.id)
        }
      });
      return { artifacts };
    });
  });
  app.post("/api/artifacts/file-uploads", defaultRouteRateLimitOptions, async (request, reply) => {
    const query = parseQuery(uploadArtifactsQuerySchema, request.query);
    await store.getRoom(query.roomId);
    await assertPaneBelongsToRoom(store, query.roomId, query.paneId ?? null);
    if (!request.isMultipart()) {
      return sendApiError(reply, 400, "BAD_REQUEST", "File uploads must use multipart/form-data.");
    }

    return withStagedUploads(request, config.browserEvidenceArtifactRoot,
      { maxFiles: paneCliUploadMaxCount, fileBytes: paneArtifactUploadMaxBytes }, async staged => {
      for (const upload of staged) {
        if (upload.declaredMimeType.startsWith("image/") && (!isAllowedImageMime(upload.declaredMimeType) || sniffImageMime(upload.sample) !== upload.declaredMimeType)) {
          return sendApiError(reply, 422, "UNSUPPORTED_MEDIA_TYPE", "Uploaded image bytes do not match the declared image type.");
        }
      }
      const uploads = staged.map(upload => {
        const sniffedMimeType = sniffImageMime(upload.sample);
        const mimeType = sniffedMimeType ?? inferUploadMimeType(upload.filename, upload.declaredMimeType);
        return { ...upload, sniffedMimeType, mimeType,
          kind: (sniffedMimeType ? "IMAGE" : isVideoMimeType(mimeType) ? "VIDEO" : "EXPORT") as Artifact["kind"],
          ...buildGenericUserUploadStorage({ artifactRoot: config.browserEvidenceArtifactRoot, roomId: query.roomId, originalFilename: upload.filename }) };
      });
      const artifacts: Artifact[] = [];
      for (const upload of uploads) {
        const record = await withPersistedUpload(config.browserEvidenceArtifactRoot, upload, upload.filePath, pinnedPath => recordUploadedArtifact(store,
          {
            roomId: query.roomId,
            paneId: query.paneId ?? null,
            kind: upload.kind,
            mimeType: upload.mimeType,
            storageUri: upload.storageUri,
            sha256: upload.sha256,
            byteSize: upload.byteSize,
            metadata: {
              source: query.source,
              originalFilename: safeOriginalFilename(upload.filename),
              storedFilename: upload.storedFilename,
              fieldName: upload.fieldname,
              declaredMimeType: upload.declaredMimeType,
              resolvedMimeType: upload.mimeType,
              sniffedMimeType: upload.sniffedMimeType,
              uploadedBy: request.user?.id ?? null
            }
          },
          request.requestIdForSpace, pinnedPath
        ));
        eventBus.publish(record.event);
        artifacts.push(record.artifact);
      }
      await recordAudit(store, request, {
        action: "artifact.upload",
        targetType: "room",
        targetId: query.roomId,
        metadata: {
          roomId: query.roomId,
          paneId: query.paneId ?? null,
          source: query.source,
          artifactCount: artifacts.length,
          artifactIds: artifacts.map((artifact) => artifact.id)
        }
      });
      return { artifacts };
    });
  });
  app.post("/api/rooms/:id/screen-capture", defaultRouteRateLimitOptions, async (request) => {
    const params = parseBody(idParamSchema, request.params);
    const input = parseBody(screenCaptureInputSchema, request.body ?? {});
    await store.getRoom(params.id);
    await assertPaneBelongsToRoom(store, params.id, input.paneId ?? null);
    const targetUrl = buildBrowserEvidenceTargetUrl(config.browserEvidenceTargetOrigin);
    const capture = await browserEvidenceCapture({
      roomId: params.id,
      paneId: input.paneId ?? null,
      viewport: input.viewport,
      targetUrl,
      traceId: request.requestIdForSpace
    });
    const artifacts: Artifact[] = [];
    for (const artifactInput of capture.artifacts) {
      const record = await store.createArtifact(
        {
          roomId: params.id,
          paneId: input.paneId ?? null,
          ...artifactInput,
          metadata: {
            ...artifactInput.metadata,
            source: "SCREEN_CAPTURE",
            browserCaptureId: capture.captureId,
            browserTargetUrl: targetUrl
          }
        },
        request.requestIdForSpace
      );
      eventBus.publish(record.event);
      artifacts.push(record.artifact);
    }
    requireEvidenceArtifactKinds(artifacts);
    const screenshot = artifacts.find((artifact) => artifact.kind === "SCREENSHOT");
    if (!screenshot) {
      throw new SpaceFeatureDisabledError("SCREEN_CAPTURE_INCOMPLETE", "Screen capture did not produce a screenshot artifact.");
    }
    await recordAudit(store, request, {
      action: "room.screen_capture",
      targetType: "room",
      targetId: params.id,
      metadata: {
        roomId: params.id,
        paneId: input.paneId ?? null,
        viewport: input.viewport,
        targetUrl,
        captureId: capture.captureId,
        artifactId: screenshot.id,
        artifactCount: artifacts.length
      }
    });
    const parsedCapture = browserEvidenceCaptureSchema.parse({
      ...capture,
      roomId: params.id,
      paneId: input.paneId ?? null,
      targetUrl,
      artifacts
    });
    return { ...parsedCapture, artifact: screenshot };
  });
  app.post("/api/artifacts", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createArtifactInputSchema, request.body);
    const record = await store.createArtifact(input, request.requestIdForSpace);
    eventBus.publish(record.event);
    await recordAudit(store, request, {
      action: "artifact.create",
      targetType: "artifact",
      targetId: record.artifact.id,
      metadata: {
        roomId: record.artifact.roomId,
        paneId: record.artifact.paneId,
        workflowId: record.artifact.workflowId,
        kind: record.artifact.kind,
        byteSize: record.artifact.byteSize,
        storageUri: record.artifact.storageUri
      }
    });
    return record.artifact;
  });
}
