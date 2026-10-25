import type {} from "./request-context.js";
import { createReadStream } from "node:fs";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import {
  acquireAppDiagnosticsVideoLeaseInputSchema, appDiagnosticsEventBatchMaxBytes, appDiagnosticsEventBatchSchema,
  appDiagnosticsVideoSegmentMaxBytes, appDiagnosticsVideoSegmentQuerySchema, updateAppDiagnosticsInputSchema
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { type AppDiagnosticsService, AppDiagnosticsServiceError } from "./app-diagnostics.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { headerString, requestIpForLog } from "./request-helpers.js";
import { parseBody, parseQuery } from "./route-parsing.js";

const appDiagnosticsLeaseParamsSchema = z.object({
  leaseId: z.string().min(6).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/)
}).strict();

const appDiagnosticsSegmentParamsSchema = z.object({
  segmentId: z.string().min(6).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/)
}).strict();

const appDiagnosticsVideoSegmentParamsSchema = z.object({
  leaseId: z.string().min(6).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/),
  sequence: z.coerce.number().int().min(0).max(1_000_000)
}).strict();

const appDiagnosticsHeartbeatInputSchema = z.object({
  captureId: z.string().min(6).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/)
}).strict();

/**
 * App diagnostics status and the ADMIN Debug toggle; the parent retains authentication, CSRF, errors and rate
 * limits.
 */
export function registerAppDiagnosticsSettingsRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  appDiagnosticsService: AppDiagnosticsService;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, appDiagnosticsService, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/app-diagnostics", defaultRouteRateLimitOptions, async () => appDiagnosticsService.getStatus());
  app.patch("/api/admin/app-diagnostics", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics settings require the ADMIN role.");
    }
    const input = parseBody(updateAppDiagnosticsInputSchema, request.body);
    const before = await appDiagnosticsService.getStatus();
    const status = await appDiagnosticsService.setEnabled(input.isEnabled, request.user.id);
    if (before.isEnabled !== status.isEnabled) {
      await recordAudit(store, request, {
        action: `admin.app_diagnostics.${status.isEnabled ? "enabled" : "disabled"}`,
        targetType: "app_diagnostics",
        targetId: status.captureId ?? before.captureId,
        metadata: {
          isEnabled: status.isEnabled,
          captureId: status.captureId ?? before.captureId
        }
      });
    }
    return status;
  });
}

/**
 * App diagnostics capture: client event batches, video leases and segments; the parent retains authentication,
 * CSRF, errors and rate limits.
 */
export function registerAppDiagnosticsCaptureRoutes(app: FastifyInstance, options: {
  appDiagnosticsService: AppDiagnosticsService;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { appDiagnosticsService, routeOptions: defaultRouteRateLimitOptions } = options;
  app.post(
    "/api/app-diagnostics/event-batches",
    {
      bodyLimit: appDiagnosticsEventBatchMaxBytes,
      config: {
        rateLimit: {
          max: 60,
          timeWindow: "1 minute",
          hook: "preHandler",
          keyGenerator: (request) => {
            const body = request.body;
            const clientId = typeof body === "object" && body !== null && "clientId" in body &&
              typeof body.clientId === "string" &&
              /^[A-Za-z0-9][A-Za-z0-9:_-]{5,99}$/.test(body.clientId)
              ? body.clientId
              : "invalid";
            return `${request.user?.id ?? requestIpForLog(request) ?? "unknown"}:${clientId}`;
          }
        }
      }
    },
    async (request) => {
      const input = parseBody(appDiagnosticsEventBatchSchema, request.body);
      return appDiagnosticsService.ingestEventBatch(input);
    }
  );
  app.post("/api/admin/app-diagnostics/video-leases", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics recording requires the ADMIN role.");
    }
    const input = parseBody(acquireAppDiagnosticsVideoLeaseInputSchema, request.body);
    return appDiagnosticsService.acquireVideoLease({
      ...input,
      userId: request.user.id
    });
  });
  app.post("/api/admin/app-diagnostics/video-leases/:leaseId/heartbeats", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics recording requires the ADMIN role.");
    }
    const params = parseQuery(appDiagnosticsLeaseParamsSchema, request.params);
    const input = parseBody(appDiagnosticsHeartbeatInputSchema, request.body);
    return appDiagnosticsService.heartbeatVideoLease(params.leaseId, input.captureId, request.user.id);
  });
  app.delete("/api/admin/app-diagnostics/video-leases/:leaseId", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics recording requires the ADMIN role.");
    }
    const params = parseQuery(appDiagnosticsLeaseParamsSchema, request.params);
    return appDiagnosticsService.releaseVideoLease(params.leaseId, request.user.id);
  });
  app.post(
    "/api/admin/app-diagnostics/video-segments/:leaseId/:sequence",
    {
      bodyLimit: appDiagnosticsVideoSegmentMaxBytes,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics recording requires the ADMIN role.");
      }
      const params = parseQuery(appDiagnosticsVideoSegmentParamsSchema, request.params);
      const query = parseQuery(appDiagnosticsVideoSegmentQuerySchema, request.query);
      if (!Buffer.isBuffer(request.body)) {
        throw new AppDiagnosticsServiceError("VIDEO_MAGIC_INVALID", "Diagnostics video body is invalid.", 415);
      }
      return appDiagnosticsService.uploadVideoSegment({
        ...query,
        leaseId: params.leaseId,
        sequence: params.sequence,
        userId: request.user.id,
        mimeType: headerString(request.headers["content-type"]) ?? "",
        bytes: request.body
      });
    }
  );
  app.get("/api/admin/app-diagnostics/segments", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics segments require the ADMIN role.");
    }
    return appDiagnosticsService.listSegments(request.query);
  });
  app.get("/api/admin/app-diagnostics/segments/:segmentId/content", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "App diagnostics segments require the ADMIN role.");
    }
    const params = parseQuery(appDiagnosticsSegmentParamsSchema, request.params);
    const opened = await appDiagnosticsService.openSegment(params.segmentId, request.user.id);
    reply.header("Cache-Control", "private, no-store");
    reply.type(opened.segment.mimeType);
    return reply.send(createReadStream(opened.path));
  });
}
