import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { type Artifact, createTurnInputSchema, listTurnsQuerySchema } from "@space/contracts";
import {
  SpaceConflictError, type SpaceEventBus, SpaceFeatureDisabledError, SpaceNotFoundError, type SpaceStore
} from "@space/runtime";
import { workflowStartErrorCode } from "./api-metrics.js";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { SpaceApiConfig } from "./config.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";
import { type TurnStarter, TurnStarterDisabledError } from "./turns.js";
import { isAllowedImageMime } from "./upload-media.js";

function isTurnImageArtifact(artifact: Artifact): boolean {
  return (artifact.kind === "IMAGE" || artifact.kind === "SCREENSHOT") && isAllowedImageMime(artifact.mimeType);
}

async function resolveTurnImageArtifacts(store: SpaceStore, roomId: string, artifactIds: string[]): Promise<Artifact[]> {
  const dedupedIds = Array.from(new Set(artifactIds));
  if (!dedupedIds.length) return [];
  const artifacts = await store.listArtifacts({ page: 1, pageSize: 100, sortOrder: "desc", roomId });
  const artifactsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return dedupedIds.map((artifactId) => {
    const artifact = artifactsById.get(artifactId);
    if (!artifact) {
      throw new SpaceNotFoundError(`Artifact ${artifactId} was not found in room ${roomId}.`);
    }
    if (!isTurnImageArtifact(artifact)) {
      throw new SpaceConflictError(`Artifact ${artifactId} is not an image attachment.`);
    }
    return artifact;
  });
}

/**
 * Turn list and turn submission (with attached image artifacts); the parent retains authentication, CSRF, errors
 * and rate limits.
 */
export function registerTurnRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  store: SpaceStore;
  eventBus: SpaceEventBus;
  turnStarter: TurnStarter;
  codexTurnStarter: TurnStarter;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { config, store, eventBus, turnStarter, codexTurnStarter, cliRuntimeVisibility,
    routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/turns", defaultRouteRateLimitOptions, async (request) => {
    const page = parseQuery(listTurnsQuerySchema, request.query);
    if (page.roomId) {
      await store.getRoom(page.roomId);
    }
    const turns = await store.listTurnsPage({
      roomId: page.roomId,
      page: page.page,
      pageSize: page.pageSize,
      sortOrder: page.sortOrder
    });
    return {
      data: turns.items,
      pagination: {
        page: page.page,
        pageSize: page.pageSize,
        totalItems: turns.total,
        totalPages: Math.ceil(turns.total / page.pageSize)
      }
    };
  });
  app.post("/api/turns", defaultRouteRateLimitOptions, async (request) => {
    const input = parseBody(createTurnInputSchema, request.body);
    if (input.runtime === "CODEX_APP_SERVER") await cliRuntimeVisibility.assertEnabled("cli:codex");
    await store.getRoom(input.roomId);
    const pane = await store.getPane(input.paneId);
    if (pane.roomId !== input.roomId) {
      throw new SpaceNotFoundError(`Pane ${input.paneId} was not found.`);
    }
    const turnArtifacts = await resolveTurnImageArtifacts(store, input.roomId, input.artifactIds);
    if (turnArtifacts.length && input.runtime === "CODEX_APP_SERVER") {
      const models = await store.listModels();
      const selectedModel = models.find(
        (model) => model.id === pane.modelId && (!pane.providerId || model.providerId === pane.providerId)
      );
      if (!selectedModel || selectedModel.status !== "VERIFIED" || !selectedModel.supportsVision) {
        throw new SpaceFeatureDisabledError(
          "VISION_MODEL_REQUIRED",
          "Image attachments require a verified vision-capable model on the selected pane.",
          {
            roomId: input.roomId,
            paneId: input.paneId,
            providerId: pane.providerId,
            modelId: pane.modelId,
            artifactCount: turnArtifacts.length
          }
        );
      }
    }
    const starter = input.runtime === "CODEX_APP_SERVER" ? codexTurnStarter : turnStarter;
    const turnInput = {
      roomId: input.roomId,
      paneId: input.paneId,
      prompt: input.prompt,
      artifactIds: turnArtifacts.map((artifact) => artifact.id),
      providerId: pane.providerId,
      modelId: pane.modelId,
      reasoningEffort: pane.reasoningEffort,
      permissionMode: null,
      collaborationMode: "default" as const,
      traceId: request.requestIdForSpace
    };
    const planned = starter.plan(turnInput);
    const queued = await store.recordTurnQueued({
      roomId: input.roomId,
      paneId: input.paneId,
      workflowId: planned.workflowId,
      runId: planned.runId,
      taskQueue: config.temporalTaskQueue,
      traceId: planned.traceId,
      prompt: input.prompt,
      artifactIds: turnInput.artifactIds,
      runtime: planned.runtime,
      providerId: pane.providerId,
      modelId: pane.modelId
    });
    eventBus.publish(queued.event);
    let result;
    try {
      result = await starter.start(turnInput);
      if (result.runId !== queued.workflow.runId) {
        await store.recordWorkflowRunId(result.workflowId, result.runId);
      }
    } catch (error) {
      const failed = await store.recordTurnFailed({
        workflowId: planned.workflowId,
        traceId: planned.traceId,
        message: "Temporal workflow failed to start.",
        // TEMPORAL_UNAVAILABLE / TEMPORAL_START_TIMEOUT / TURN_START_FAILED: a stable cause, never the message.
        reasonCode: error instanceof TurnStarterDisabledError ? "TURN_STARTER_DISABLED" : workflowStartErrorCode(error)
      });
      eventBus.publish(failed.event);
      throw error;
    }
    await recordAudit(store, request, {
      action: "turn.queue",
      targetType: "workflow",
      targetId: result.workflowId,
      metadata: {
        roomId: input.roomId,
        paneId: input.paneId,
        turnId: queued.turn.id,
        status: result.status,
        runtime: result.runtime,
        artifactCount: turnInput.artifactIds.length,
        artifactIds: turnInput.artifactIds
      }
    });
    return { ...result, artifactIds: turnInput.artifactIds, turnId: queued.turn.id };
  });
}
