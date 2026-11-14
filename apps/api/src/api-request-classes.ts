import type { FastifyRequest } from "fastify";
import { isCliBridgeRoutePath } from "./cli-bridge-paths.js";
import { isHarnessRootHttpPath } from "./harness-proxy.js";
import { requestPathname, requestRoutePath } from "./request-helpers.js";
import { MAKE_APP_PATHS } from "./make-app-routes.js";

// How the API's request hooks classify a request: routes that need no session, the internal API and its token header,
// the CLI bridge, the mutations app-diagnostics automation may make, and which requests need a CSRF token.
export const publicPaths = new Set([
  "/healthz",
  "/metrics", "/api/metrics/scrape", "/api/metrics/scrape/:target",
  "/readyz",
  "/version",
  "/api/auth/login",
  "/api/auth/me",
  "/api/auth/google/start",
  "/api/auth/google/callback",
  "/api/auth/google/credential",
  "/api/auth/desktop-handoff", "/api/auth/app-handoff", "/api/mobile/channel", "/api/mobile/demo-offer",
  "/api/auth/logout",
  "/api/auth/logout-all",
  "/logout",
  "/api/setup/status",
  "/api/setup/claim",
  "/api/auth/invites/accept",
  "/api/auth/password-reset/request", "/api/auth/password-reset/complete",
  "/api/public/waitlist",
  "/api/demo-projects/preview/:runId/:token",
  "/api/demo-projects/preview/:runId/:token/*",
  // Demo connector routes: authenticated via x-demo-run-token header inside the route handler
  "/api/demo-projects/runs/:runId/connector/status",
  "/api/demo-projects/runs/:runId/connector/accounts",
  "/api/demo-projects/runs/:runId/connector/accounts/:accountId",
  "/api/demo-projects/runs/:runId/connector/operations",
  "/api/demo-projects/runs/:runId/connector/operations/:id/retry",
  // Desktop client release and auto-update routes
  "/api/desktop/latest",
  "/api/desktop/sentry",
  "/api/mobile/sentry/:app",
  "/api/desktop/update.ps1",
  "/api/desktop/update.bat",
  "/api/desktop/install.sh",
  "/api/desktop/download/:filename",
  "/api/admin/streaming/providers/:provider/oauth/authorize",
  "/api/admin/streaming/providers/:provider/oauth/callback",
  // Slack and Teams deliveries: verified by their signatures inside the routes.
  "/api/channels/slack/events",
  "/api/channels/teams/messages",
  // The SpaceApp app in Make: its Bearer key is checked inside the routes (make-app-routes.ts).
  ...MAKE_APP_PATHS
]);
const internalApiPrefix = "/api/internal/";
export const internalTokenHeader = "x-space-internal-token";

export function isInternalApiRequest(request: FastifyRequest): boolean {
  return requestRoutePath(request).startsWith(internalApiPrefix);
}

export function isCliBrowserBridgeRequest(request: FastifyRequest): boolean {
  return isCliBridgeRoutePath(requestRoutePath(request));
}

const appDiagnosticsAutomationMutationRoutes = new Set([
  "PATCH /api/admin/app-diagnostics",
  "POST /api/app-diagnostics/event-batches",
  "POST /api/admin/app-diagnostics/video-leases",
  "POST /api/admin/app-diagnostics/video-leases/:leaseId/heartbeats",
  "DELETE /api/admin/app-diagnostics/video-leases/:leaseId",
  "POST /api/admin/app-diagnostics/video-segments/:leaseId/:sequence",
  "POST /api/cli/client-events"
]);

export function isAllowedAppDiagnosticsAutomationMutation(request: FastifyRequest): boolean {
  if (request.method === "GET") return true;
  const route = request.routeOptions.url ?? requestPathname(request);
  return appDiagnosticsAutomationMutationRoutes.has(`${request.method} ${route}`);
}


export function requiresCsrf(request: FastifyRequest): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false;
  }
  const routeUrl = requestRoutePath(request);
  return (
    routeUrl.startsWith("/api/") &&
    routeUrl !== "/api/auth/login" &&
    routeUrl !== "/api/auth/google/credential" && routeUrl !== "/api/auth/desktop-handoff" && routeUrl !== "/api/auth/app-handoff" &&
    routeUrl !== "/api/voice/realtime/history/search" &&
    routeUrl !== "/api/voice/realtime/logs" &&
    routeUrl !== "/api/voice/client-error" &&
    !routeUrl.startsWith("/api/asteroids/benchmark/")
  ) || isHarnessRootHttpPath(routeUrl);
}
