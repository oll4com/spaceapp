import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { listActivityLogEventsQuerySchema, updateActivityLogSettingsInputSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { ActivityLogService } from "./activity-log.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody, parseQuery } from "./route-parsing.js";

/** Operator activity log and its ADMIN settings; the parent retains authentication, CSRF, errors and rate limits. */
export function registerActivityLogRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  activityLogService: ActivityLogService;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { store, activityLogService, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/activity-log", defaultRouteRateLimitOptions, async (request, reply) => {
    const query = parseQuery(listActivityLogEventsQuerySchema, request.query);
    return activityLogService.listEvents(query);
  });
  app.get("/api/activity-log/settings", defaultRouteRateLimitOptions, async () => activityLogService.getSettings());
  app.patch("/api/admin/activity-log/settings", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") {
      return sendApiError(reply, 403, "ADMIN_REQUIRED", "Activity log settings require the ADMIN role.");
    }
    const input = parseBody(updateActivityLogSettingsInputSchema, request.body);
    const before = await activityLogService.getSettings();
    const settings = await activityLogService.setEnabled(input.enabled, request.user.id);
    if (before.enabled !== settings.enabled) {
      await recordAudit(store, request, {
        action: `admin.activity_log.${settings.enabled ? "enabled" : "disabled"}`,
        targetType: "activity_log",
        metadata: { enabled: settings.enabled }
      });
    }
    return settings;
  });
}
