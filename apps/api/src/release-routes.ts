import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { createReleasePreviewInputSchema, createReleaseRequestSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { cliMaintenanceRunParamSchema } from "./cli-maintenance-routes.js";
import { sendApiError } from "./http-errors.js";
import type { ReleasePublishingManager } from "./release-publishing.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";

/**
 * ADMIN release previews, publishing and release run history; the parent retains authentication, CSRF, errors and
 * rate limits.
 */
export function registerReleaseRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  releasePublishingManager: ReleasePublishingManager;
}) {
  const { store, releasePublishingManager } = options;
  app.post(
    "/api/admin/releases/previews",
    { config: { rateLimit: { max: 6, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Space release previews require the ADMIN role.");
      }
      const input = parseBody(createReleasePreviewInputSchema, request.body ?? {});
      const preview = await releasePublishingManager.createPreview(input, request.user.id);
      await recordAudit(store, request, {
        action: "space_release.preview_created",
        targetType: "release_preview",
        targetId: preview.id,
        metadata: {
          tag: preview.tag,
          sourceCommit: preview.sourceCommit,
          previousTag: preview.previousTag,
          expiresAt: preview.expiresAt
        }
      });
      return reply.status(201).send(preview);
    }
  );
  app.post(
    "/api/admin/releases",
    { config: { rateLimit: { max: 4, timeWindow: "30 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Space release publishing requires the ADMIN role.");
      }
      const input = parseBody(createReleaseRequestSchema, request.body);
      const run = await releasePublishingManager.publish(input, request.user.id);
      await recordAudit(store, request, {
        action: "space_release.queued",
        targetType: "admin_operation_run",
        targetId: run.id,
        metadata: {
          tag: input.tag,
          previewId: input.previewId,
          status: run.status
        }
      });
      return reply.status(202).send(run);
    }
  );
  app.get(
    "/api/admin/releases/runs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Space release history requires the ADMIN role.");
      }
      return { data: await releasePublishingManager.listRuns() };
    }
  );
  app.get(
    "/api/admin/releases/runs/:runId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Space release history requires the ADMIN role.");
      }
      const params = parseQuery(cliMaintenanceRunParamSchema, request.params);
      return releasePublishingManager.getRun(params.runId);
    }
  );
}
