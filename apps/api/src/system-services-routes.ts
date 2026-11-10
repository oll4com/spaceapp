import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { systemServicesResponseSchema } from "@space/contracts";
import { resetFailedSystemUnits, type SystemServicesRunner } from "./service-services.js";

/** Space's systemd services and timers, and clearing their failed state (space-* units only). */
export function registerSystemServicesRoutes(app: FastifyInstance, options: {
  systemServicesProvider: SystemServicesRunner;
  routeOptions: RouteShorthandOptions;
}) {
  const { systemServicesProvider, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/api/system/services", defaultRouteRateLimitOptions, async () => {
    return systemServicesResponseSchema.parse(await systemServicesProvider());
  });

  app.post("/api/system/services/reset-failed", defaultRouteRateLimitOptions, async (request) => {
    const body = (request.body && typeof request.body === "object") ? (request.body as { unit?: string }) : undefined;
    const unit = typeof body?.unit === "string" ? body.unit.trim() : undefined;
    return await resetFailedSystemUnits(unit);
  });
}
