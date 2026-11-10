import type { FastifyInstance } from "fastify";
import { registerActivityLogRoutes } from "./activity-log-routes.js";
import { registerAppDiagnosticsSettingsRoutes } from "./app-diagnostics-routes.js";
import { registerAuthSessionRoutes } from "./auth-session-routes.js";
import { registerDesktopReleaseRoutes } from "./desktop-release-routes.js";
import { registerHealthRoutes } from "./health-routes.js";
import { observeMemoryWorkers } from "./host-metrics.js";
import { sendApiError } from "./http-errors.js";
import type { createInstallTelemetry } from "./install-telemetry.js";
import { readSpaceMetrics, registerMetricsScrape, WORKER_METRICS_TARGETS } from "./metrics-scrape.js";
import { createHostSwap } from "./nous/server-load.js";
import { defaultReleasesOptions } from "./instance-releases.js";
import type { createHttpObservability } from "./observability.js";
import { registerPublicWaitlistRoute } from "./public-waitlist-routes.js";
import { isLoopbackRequest } from "./request-helpers.js";
import { registerFirstSetup } from "./setup-wiring.js";
import type { SystemHealthMonitor } from "./system-health-service.js";

type D<F extends (app: FastifyInstance, deps: never) => unknown> = Parameters<F>[1];
type Health = D<typeof registerHealthRoutes>; type AuthSession = D<typeof registerAuthSessionRoutes>; type Setup = D<typeof registerFirstSetup>;
type PlatformRoutesDeps = Omit<Health, "routeOptions"> & Pick<AuthSession, "auth" | "userRoleCache">
  & Pick<Setup, "options" | "publicCredentialHost" | "setupConnections" | "setupConnectionCheckRuns" | "streamingService" | "sourceControlService"
    | "visibleCliRuntimeIds" | "agentSessionHistoryService">
  & Pick<D<typeof registerActivityLogRoutes>, "activityLogService">
  & {
    defaultRouteRateLimitOptions: AuthSession["routeOptions"] & Health["routeOptions"] & Record<string, unknown>;
    observability: Pick<ReturnType<typeof createHttpObservability>, "renderPrometheus">; healthMonitor: Pick<SystemHealthMonitor, "snapshot">;
    toolbarUsageProvider: Setup["quotaProviders"]["codex"]; antigravityUsageProvider: Setup["quotaProviders"]["antigravity"];
    apiProviderAccountsProvider: Setup["quotaProviders"]["api"]; installTelemetry: Pick<ReturnType<typeof createInstallTelemetry>, "setupCompleted">;
  };

/** The platform routes after the error handler in app.ts (moved verbatim, ARCH-001 step 84): health, desktop releases, the metrics scrape and
 *  /metrics, the auth session, first setup, the public waitlist, app diagnostics settings and the activity log. Returns first setup's voice
 *  runtime and credentials, which the conversation routes read later. */
export async function registerPlatformRoutes(app: FastifyInstance, deps: PlatformRoutesDeps) {
  const { apiStartedAt, config, appVersionReader, store, appDiagnosticsService, browserSessionManager, workerReadinessChecker, cliTerminalManager,
    defaultRouteRateLimitOptions, observability, auth, userRoleCache, options, publicCredentialHost, setupConnections, setupConnectionCheckRuns,
    streamingService, sourceControlService, visibleCliRuntimeIds, agentSessionHistoryService, healthMonitor, toolbarUsageProvider, antigravityUsageProvider,
    apiProviderAccountsProvider, installTelemetry, activityLogService } = deps;
  registerHealthRoutes(app, {
    apiStartedAt, config, appVersionReader, store, appDiagnosticsService, browserSessionManager,
    workerReadinessChecker, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions
  });
  if (config.optionalModules.has("desktop-updates")) registerDesktopReleaseRoutes(app, { routeOptions: defaultRouteRateLimitOptions }); registerMetricsScrape(app, { tokenFile: config.metricsTokenFile, hostSwap: createHostSwap({ collectorConfig: config.monitoringCollector, hostSelector: config.loadHostSelector }), routeOptions: defaultRouteRateLimitOptions,
    space: () => readSpaceMetrics(config.publicDistribution ? { queueRoots: {}, gatewayUrl: null } : { queueRoots: { stable: defaultReleasesOptions.stableQueueRoot, dev: defaultReleasesOptions.devQueueRoot }, gatewayUrl: config.gatewayUrl }), render: () => { observeMemoryWorkers(); return observability.renderPrometheus(); }, targets: config.instance === "stable" ? WORKER_METRICS_TARGETS : {} });
  // Aggregate metrics only (route templates, codes, categories, process and
  // queue gauges). Served to local/private-network scrapers and signed-in
  // administrators; clients that reach the API from the public internet
  // (including through the trusted proxy) are refused.
  app.get("/metrics", defaultRouteRateLimitOptions, async (request, reply) => {
    // A LAN client is not trusted: with a 0.0.0.0 bind any host on the network could scrape (review F12).
    const administrator = request.user?.role === "ADMIN" || request.user?.role === "OPERATOR";
    if (!administrator && !isLoopbackRequest(request)) {
      return sendApiError(reply, 403, "METRICS_FORBIDDEN", "Metrics are available to local scrapers and administrators only.");
    }
    reply.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    observeMemoryWorkers();
    return observability.renderPrometheus();
  });

  registerAuthSessionRoutes(app, {
    config, store, auth, userRoleCache, routeOptions: defaultRouteRateLimitOptions
  });

  const { setupOwnerVoiceRuntime, setupVoiceCredentials } = await registerFirstSetup(app, { options, config, store, auth, publicCredentialHost,
    setupConnections, setupConnectionCheckRuns, routeOptions: defaultRouteRateLimitOptions, streamingService, sourceControlService,
    browserSessionManager, visibleCliRuntimeIds, agentSessionHistoryService, readSystemHealth: () => healthMonitor.snapshot(),
    quotaProviders: { codex: toolbarUsageProvider, antigravity: antigravityUsageProvider, api: apiProviderAccountsProvider },
    onOwnerClaimed: () => installTelemetry.setupCompleted.observe() });

  if (config.optionalModules.has("waitlist")) registerPublicWaitlistRoute(app, { store });

  registerAppDiagnosticsSettingsRoutes(app, {
    store, appDiagnosticsService, routeOptions: defaultRouteRateLimitOptions
  });

  registerActivityLogRoutes(app, { store, activityLogService, routeOptions: defaultRouteRateLimitOptions });
  return { setupOwnerVoiceRuntime, setupVoiceCredentials };
}
