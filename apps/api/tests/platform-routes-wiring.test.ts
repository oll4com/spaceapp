import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/health-routes.js", async (orig) => ({ ...await orig<object>(), registerHealthRoutes: rec("health") }));
vi.mock("../src/desktop-release-routes.js", async (orig) => ({ ...await orig<object>(), registerDesktopReleaseRoutes: rec("desktopReleases") }));
vi.mock("../src/metrics-scrape.js", async (orig) => ({ ...await orig<object>(), registerMetricsScrape: rec("metricsScrape") }));
vi.mock("../src/host-metrics.js", async (orig) => ({ ...await orig<object>(), observeMemoryWorkers: rec("observeMemoryWorkers") }));
vi.mock("../src/auth-session-routes.js", async (orig) => ({ ...await orig<object>(), registerAuthSessionRoutes: rec("authSession") }));
vi.mock("../src/setup-wiring.js", async (orig) => ({ ...await orig<object>(),
  registerFirstSetup: rec("firstSetup", Promise.resolve({ setupOwnerVoiceRuntime: "voice-runtime", setupVoiceCredentials: "voice-credentials" })) }));
vi.mock("../src/public-waitlist-routes.js", async (orig) => ({ ...await orig<object>(), registerPublicWaitlistRoute: rec("waitlist") }));
vi.mock("../src/app-diagnostics-routes.js", async (orig) => ({ ...await orig<object>(), registerAppDiagnosticsSettingsRoutes: rec("appDiagnostics") }));
vi.mock("../src/activity-log-routes.js", async (orig) => ({ ...await orig<object>(), registerActivityLogRoutes: rec("activityLog") }));

const { registerPlatformRoutes } = await import("../src/platform-routes-wiring.js");
const { WORKER_METRICS_TARGETS } = await import("../src/metrics-scrape.js");

const apps: FastifyInstance[] = [];
afterEach(async () => { Object.assign(captured, { order: [], args: {} }); await Promise.all(apps.splice(0).map((app) => app.close())); });

async function wire(input: { instance?: string; modules?: string[] } = {}) {
  const app = Fastify();
  apps.push(app);
  app.decorateRequest("user", null);
  app.addHook("onRequest", async (request) => {
    const role = request.headers["x-test-role"];
    (request as { user?: unknown }).user = typeof role === "string" ? { id: "user:t", role } : null;
  });
  const get = app.get.bind(app);
  (app as { get: unknown }).get = (...args: Parameters<typeof get>) => { captured.order.push(`get:${String(args[0])}`); return get(...args); };
  const observed: string[] = [];
  const deps = {
    apiStartedAt: "2026-11-01T00:00:00Z", config: { instance: input.instance ?? "stable", optionalModules: new Set(input.modules ?? ["desktop-updates", "waitlist"]),
      metricsTokenFile: "/run/space/metrics.token" }, appVersionReader: "version-reader", store: "store", appDiagnosticsService: "diagnostics",
    browserSessionManager: "browsers", workerReadinessChecker: "worker-ready", cliTerminalManager: "terminals", defaultRouteRateLimitOptions: { config: { rateLimit: 1 } },
    observability: { renderPrometheus: () => "space_up 1\n" }, auth: "auth", userRoleCache: "roles", options: "options", publicCredentialHost: null,
    setupConnections: "connections", setupConnectionCheckRuns: "check-runs", streamingService: "streaming", sourceControlService: "source-control",
    visibleCliRuntimeIds: "visible-runtimes", agentSessionHistoryService: "session-history", healthMonitor: { snapshot: async () => "health-snapshot" },
    toolbarUsageProvider: "codex-quota", antigravityUsageProvider: "antigravity-quota", apiProviderAccountsProvider: "api-quota",
    installTelemetry: { setupCompleted: { observe: () => { observed.push("setupCompleted"); } } }, activityLogService: "activity-log"
  };
  const result = await registerPlatformRoutes(app as never, deps as never);
  return { app, deps, result, observed };
}
const arg = (name: string) => captured.args[name]![1] as Record<string, unknown>;

describe("platform routes wiring (ARCH-001 step 84)", () => {
  it("registers in app.ts's order on the same app and returns first setup's voice runtime and credentials", async () => {
    const { app, result } = await wire();
    expect(captured.order).toEqual(["health", "desktopReleases", "metricsScrape", "get:/metrics", "authSession", "firstSetup", "waitlist", "appDiagnostics", "activityLog"]);
    for (const name of captured.order.filter((entry) => !entry.startsWith("get:"))) expect(captured.args[name]![0]).toBe(app);
    expect(result).toEqual({ setupOwnerVoiceRuntime: "voice-runtime", setupVoiceCredentials: "voice-credentials" });
  });

  it("registers desktop releases and the waitlist only with their optional modules, and scrapes the workers only on stable", async () => {
    await wire({ instance: "dev", modules: [] });
    expect(captured.order).toEqual(["health", "metricsScrape", "get:/metrics", "authSession", "firstSetup", "appDiagnostics", "activityLog"]);
    const scrape = arg("metricsScrape");
    expect(scrape).toMatchObject({ tokenFile: "/run/space/metrics.token", targets: {} });
    expect((scrape.render as () => string)()).toBe("space_up 1\n");
    expect(captured.order.at(-1)).toBe("observeMemoryWorkers");
    captured.order = [];
    await wire();
    expect(arg("metricsScrape").targets).toBe(WORKER_METRICS_TARGETS);
  });

  it("serves /metrics to loopback scrapers and administrators only", async () => {
    const { app } = await wire();
    const remote = await app.inject({ method: "GET", url: "/metrics", remoteAddress: "203.0.113.5" });
    expect(remote.statusCode).toBe(403);
    expect(remote.body).toContain("METRICS_FORBIDDEN");
    for (const role of ["ADMIN", "OPERATOR"]) {
      const admin = await app.inject({ method: "GET", url: "/metrics", remoteAddress: "203.0.113.5", headers: { "x-test-role": role } });
      expect([admin.statusCode, admin.body, admin.headers["content-type"]]).toEqual([200, "space_up 1\n", "text/plain; version=0.0.4; charset=utf-8"]);
    }
    expect((await app.inject({ method: "GET", url: "/metrics", remoteAddress: "203.0.113.5", headers: { "x-test-role": "USER" } })).statusCode).toBe(403);
    captured.order = [];
    expect((await app.inject({ method: "GET", url: "/metrics", remoteAddress: "127.0.0.1" })).statusCode).toBe(200);
    expect(captured.order).toEqual(["observeMemoryWorkers"]);
  });

  it("passes every registration its dependencies and wires first setup to health, quotas and the setup telemetry", async () => {
    const { deps, observed } = await wire();
    const routeOptions = deps.defaultRouteRateLimitOptions;
    expect(arg("health")).toEqual({ apiStartedAt: deps.apiStartedAt, config: deps.config, appVersionReader: "version-reader", store: "store",
      appDiagnosticsService: "diagnostics", browserSessionManager: "browsers", workerReadinessChecker: "worker-ready", cliTerminalManager: "terminals", routeOptions });
    expect(arg("desktopReleases")).toEqual({ routeOptions });
    expect(arg("authSession")).toEqual({ config: deps.config, store: "store", auth: "auth", userRoleCache: "roles", routeOptions });
    expect(arg("waitlist")).toEqual({ store: "store" });
    expect(arg("appDiagnostics")).toEqual({ store: "store", appDiagnosticsService: "diagnostics", routeOptions });
    expect(arg("activityLog")).toEqual({ store: "store", activityLogService: "activity-log", routeOptions });
    const setup = arg("firstSetup");
    expect(setup).toMatchObject({ options: "options", config: deps.config, store: "store", auth: "auth", publicCredentialHost: null, setupConnections: "connections",
      setupConnectionCheckRuns: "check-runs", routeOptions, streamingService: "streaming", sourceControlService: "source-control", browserSessionManager: "browsers",
      visibleCliRuntimeIds: "visible-runtimes", agentSessionHistoryService: "session-history",
      quotaProviders: { codex: "codex-quota", antigravity: "antigravity-quota", api: "api-quota" } });
    await expect((setup.readSystemHealth as () => Promise<unknown>)()).resolves.toBe("health-snapshot");
    (setup.onOwnerClaimed as () => void)();
    expect(observed).toEqual(["setupCompleted"]);
  });
});
