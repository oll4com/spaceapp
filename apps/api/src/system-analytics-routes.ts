import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  opencodeBenchResponseSchema, systemAnalyticsCliSessionsResponseSchema, systemAnalyticsModelsResponseSchema,
  systemAnalyticsTokenRouteSchema,
  systemAnalyticsOverviewResponseSchema, systemAnalyticsProcessesResponseSchema, systemAnalyticsRangeSchema,
  systemAnalyticsResourcesResponseSchema
} from "@space/contracts";
import { sendApiError } from "./http-errors.js";
import type { OpencodeModelBenchService } from "./opencode-model-bench.js";
import type { SystemAnalyticsService } from "./system-analytics-service.js";

/**
 * ADMIN system analytics: overview, models, resources, processes, CLI sessions and the OpenCode model bench; the
 * parent retains authentication, CSRF, errors and rate limits.
 */
export function registerSystemAnalyticsRoutes(app: FastifyInstance, options: {
  systemAnalyticsService: SystemAnalyticsService;
  opencodeModelBenchService: OpencodeModelBenchService;
}) {
  const { systemAnalyticsService, opencodeModelBenchService } = options;
  app.get(
    "/api/admin/system-analytics/overview",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const { range } = z.object({ range: systemAnalyticsRangeSchema.default("10m") }).strict().parse(request.query);
      return systemAnalyticsOverviewResponseSchema.parse(await systemAnalyticsService.overview(range));
    }
  );
  app.get(
    "/api/admin/system-analytics/models",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const { range, route } = z.object({
        range: systemAnalyticsRangeSchema.default("10m"),
        route: systemAnalyticsTokenRouteSchema.default("all")
      }).strict().parse(request.query);
      return systemAnalyticsModelsResponseSchema.parse(await systemAnalyticsService.models(range, route));
    }
  );
  app.get(
    "/api/admin/system-analytics/resources",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const { range } = z.object({ range: systemAnalyticsRangeSchema.default("10m") }).strict().parse(request.query);
      return systemAnalyticsResourcesResponseSchema.parse(await systemAnalyticsService.resources(range));
    }
  );
  app.get(
    "/api/admin/system-analytics/processes",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const input = z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(10).max(200).default(100),
        sort: z.enum(["rss", "cpu", "pid", "uptime", "name", "state", "threads"]).default("rss"),
        direction: z.enum(["asc", "desc"]).default("desc"),
        query: z.string().trim().max(160).optional(),
        ownership: z.enum(["ALL", "SPACE_CLI", "SPACE_SHARED", "OTHER"]).default("ALL")
      }).strict().parse(request.query);
      return systemAnalyticsProcessesResponseSchema.parse(await systemAnalyticsService.processes(input));
    }
  );
  app.get(
    "/api/admin/system-analytics/cli-sessions",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const { range } = z.object({ range: systemAnalyticsRangeSchema.default("10m") }).strict().parse(request.query);
      return systemAnalyticsCliSessionsResponseSchema.parse(await systemAnalyticsService.cliSessions(range));
    }
  );
  app.get(
    "/api/admin/system-analytics/opencode-bench",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const { range, refresh } = z.object({
        range: systemAnalyticsRangeSchema.default("7d"),
        refresh: z.enum(["true", "false"]).default("false")
      }).strict().parse(request.query);
      const data = await opencodeModelBenchService.get(range as any, refresh === "true");
      return opencodeBenchResponseSchema.parse(data);
    }
  );
  app.get(
    "/api/admin/system-analytics/opencode-bench/probe/:provider/:model",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "System analytics require the ADMIN role.");
      }
      const { provider, model } = z.object({ provider: z.enum(["opencode", "opencode-go", "openrouter"]), model: z.string().min(1).max(160) }).parse((request as any).params);
      const data = await opencodeModelBenchService.probeSingle(provider, model);
      return data as any;
    }
  );
}
