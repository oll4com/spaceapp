import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { z } from "zod";
import { summarizeAutoRouteShadow } from "@space/contracts";
import { type AutoRouteShadowRepository, PostgresAutoRouteShadowRepository } from "@space/db";
import type { createAutoRouteFactsLoader } from "./auto-route-facts.js";
import type { SpaceApiConfig } from "./config.js";
import { sendApiError } from "./http-errors.js";

/** Dots Auto routing evidence: the shadow repository (database-backed unless a test passes one) and its ADMIN summary route. */
export function registerDotAutoRoutingShadowRoutes(app: FastifyInstance, options: {
  config: SpaceApiConfig;
  autoRouteShadowRepository: AutoRouteShadowRepository | undefined;
  autoRouteFactsLoader: ReturnType<typeof createAutoRouteFactsLoader> | null;
  routeOptions: RouteShorthandOptions;
}) {
  const { config, autoRouteFactsLoader, routeOptions: defaultRouteRateLimitOptions } = options;
  // Stage 7: Auto runs in shadow mode; ADMINs see what it would have chosen and how those tasks went.
  const autoRouteShadowRepository = options.autoRouteShadowRepository
    ?? (config.databaseUrl ? PostgresAutoRouteShadowRepository.fromConnectionString(config.databaseUrl) : null);
  if (autoRouteShadowRepository && !options.autoRouteShadowRepository) app.addHook("onClose", () => autoRouteShadowRepository.dispose());
  app.get("/api/dots/auto-routing/shadow", defaultRouteRateLimitOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Auto routing evidence requires ADMIN.");
    const query = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict().safeParse(request.query ?? {});
    if (!query.success) return sendApiError(reply, 400, "INVALID_QUERY", "days must be a whole number from 1 to 90.");
    if (!autoRouteShadowRepository) return sendApiError(reply, 503, "AUTO_ROUTING_UNAVAILABLE", "Auto routing evidence needs the database.");
    const since = new Date(Date.now() - query.data.days * 86_400_000).toISOString();
    const [runs, facts] = await Promise.all([autoRouteShadowRepository.recent(since, 5_000), autoRouteFactsLoader?.().catch(() => null) ?? null]);
    return { since, ...summarizeAutoRouteShadow(runs, facts?.prices ?? null) };
  });
}
