import type {} from "./request-context.js";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { SpaceStore } from "@space/runtime";
import { sendApiError } from "./http-errors.js";
import { approveHotfix, defaultReleasesOptions, promoteDev, readReleases, ReleaseActionError, type ReleasesOptions } from "./instance-releases.js";
import { recordAudit } from "./request-audit.js";
import { configureQueueOperatorGrants, isOperatorPerson } from "./queue-operator-grants.js";

/** Settings → Releases: compare the stable and dev instances, promote dev, approve stable hotfixes (ADMIN). */
export function registerInstanceReleaseRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "upsertUser" | "recordAuditEvent">;
  releases?: Partial<ReleasesOptions>;
  managedHere: boolean;
  routeOptions: Pick<RouteShorthandOptions, "config">;
  /** Signs the queue's operator grants (queue-operator-grants.ts). */
  sessionSecret: string;
  /** Keeps panes' held grants across API restarts (null: memory only). */
  grantStateFile?: string | null;
}) {
  const releases: ReleasesOptions = { ...defaultReleasesOptions, ...options.releases, managedHere: options.managedHere };
  const { routeOptions, store } = options;
  configureQueueOperatorGrants(options.sessionSecret, options.grantStateFile ?? null);

  app.get("/api/admin/releases", routeOptions, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Releases require ADMIN.");
    return readReleases(releases);
  });

  app.post("/api/admin/releases/promote", routeOptions, async (request, reply) => {
    if (!isOperatorPerson(request.user)) return sendApiError(reply, 403, "ADMIN_REQUIRED", "Only the operator can promote dev to stable.");
    try {
      const result = await promoteDev(releases);
      await recordAudit(store, request, { action: "release.promote", targetType: "release", targetId: result.ticketId, metadata: { status: result.status } });
      return result;
    } catch (error) {
      if (error instanceof ReleaseActionError) return sendApiError(reply, error.statusCode, "RELEASE_ACTION_FAILED", error.message);
      throw error;
    }
  });

  app.post<{ Params: { ticketId: string } }>("/api/admin/releases/hotfixes/:ticketId/approve", routeOptions, async (request, reply) => {
    if (!isOperatorPerson(request.user)) return sendApiError(reply, 403, "ADMIN_REQUIRED", "Only the operator can approve a stable hotfix.");
    try {
      const result = await approveHotfix(request.params.ticketId, releases);
      await recordAudit(store, request, { action: "release.hotfix.approve", targetType: "release", targetId: result.ticketId, metadata: {} });
      return result;
    } catch (error) {
      if (error instanceof ReleaseActionError) return sendApiError(reply, error.statusCode, "RELEASE_ACTION_FAILED", error.message);
      throw error;
    }
  });
}
