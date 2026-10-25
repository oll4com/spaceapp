import type {} from "./request-context.js";
import { execFile } from "./safe-child-process.js";
import { promisify } from "node:util";
import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { BrowserHostCaptureMetrics } from "@space/browser-host";
import { workerReadinessSchema } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { AppDiagnosticsService } from "./app-diagnostics.js";
import type { AppVersionReader } from "./app-version.js";
import { defaultSessionRevocationStore } from "./auth.js";
import { browserHostReadiness, type BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import type { WorkerReadinessChecker } from "./worker-readiness.js";

const execFileAsync = promisify(execFile);

async function readGitVersionMetadata(cwd = process.env.SPACE_GIT_ROOT ?? process.env.SPACE_REPO_ROOT ?? process.cwd()) {
  const gitConfig = ["-c", `safe.directory=${cwd}`];
  try {
    const [commit, branch, status] = await Promise.all([
      execFileAsync("git", [...gitConfig, "rev-parse", "HEAD"], { cwd }),
      execFileAsync("git", [...gitConfig, "branch", "--show-current"], { cwd }),
      execFileAsync("git", [...gitConfig, "status", "--porcelain=v1", "--untracked-files=no"], { cwd })
    ]);
    return {
      commit: commit.stdout.trim(),
      shortCommit: commit.stdout.trim().slice(0, 9),
      branch: branch.stdout.trim() || "(detached)",
      dirty: status.stdout.trim().length > 0
    };
  } catch {
    return null;
  }
}

/** Liveness, readiness and version endpoints; the parent retains authentication, CSRF, errors and rate limits. */
export function registerHealthRoutes(app: FastifyInstance, options: {
  apiStartedAt: string;
  config: SpaceApiConfig;
  appVersionReader: AppVersionReader;
  store: SpaceStore;
  appDiagnosticsService: AppDiagnosticsService;
  browserSessionManager: BrowserSessionManagerWithHostHealth;
  workerReadinessChecker: WorkerReadinessChecker;
  cliTerminalManager: CliTerminalManager;
  routeOptions: Pick<RouteShorthandOptions, "config">;
}) {
  const { apiStartedAt, config, appVersionReader, store, appDiagnosticsService, browserSessionManager,
    workerReadinessChecker, cliTerminalManager, routeOptions: defaultRouteRateLimitOptions } = options;
  app.get("/healthz", defaultRouteRateLimitOptions, async () => ({ ok: true, service: "space-api" }));
  // Liveness only: the process answers. Dependency outages belong to /readyz and
  // must not cause a supervisor to restart a healthy API.
  app.get("/livez", defaultRouteRateLimitOptions, async () => ({
    ok: true,
    service: "space-api",
    uptimeSeconds: Math.round(process.uptime())
  }));
  // One pending check per dependency: a stalled dependency answers every probe with its timeout fallback
  // instead of collecting a new unfinished check per probe (1.1.5 internal review, 2026-10-16).
  const inflight = new Map<string, Promise<unknown>>();
  const shared = <T>(key: string, start: () => Promise<T>): Promise<T> => {
    const pending = inflight.get(key) as Promise<T> | undefined;
    if (pending) return pending;
    const next = start().finally(() => inflight.delete(key));
    inflight.set(key, next);
    return next;
  };
  app.get("/readyz", defaultRouteRateLimitOptions, async (request, reply) => {
    const bounded = <T>(operation: Promise<T>, fallback: T, timeoutMs = 2_500): Promise<T> =>
      Promise.race([
        operation,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), timeoutMs))
      ]);
    const databaseCheck = store.checkReadiness
      ? bounded(
          shared("database", () => store.checkReadiness!().then(() => "RUNNING" as const).catch(() => "UNAVAILABLE" as const)),
          "UNAVAILABLE" as const
        )
      : Promise.resolve("in-memory" as const);
    const [worker, appDiagnostics, database] = await Promise.all([
      config.workflowsEnabled === false ? Promise.resolve(null) : bounded(shared("worker", () => workerReadinessChecker()), workerReadinessSchema.parse({
        id: "space-worker",
        status: "ERROR",
        statusReason: "Worker readiness check timed out.",
        address: config.temporalAddress,
        namespace: config.temporalNamespace,
        taskQueue: config.temporalTaskQueue,
        reachable: false,
        workflowPollerCount: 0,
        activityPollerCount: 0,
        pollerCount: 0,
        workflowBacklogCount: null,
        activityBacklogCount: null,
        pollerIdentities: [],
        lastPollerAccessAt: null,
        checkedAt: new Date().toISOString()
      })),
      shared("appDiagnostics", () => appDiagnosticsService.getStatus()),
      databaseCheck
    ]);
    const cliHost = config.cliEnabled
      ? await bounded(cliTerminalManager.hostPing().then((ok) => ok ? "RUNNING" as const : "UNAVAILABLE" as const).catch(() => "UNAVAILABLE" as const), "UNAVAILABLE" as const)
      : "disabled" as const;
    const cliAdminHost = config.cliRootEnabled
      ? await bounded(cliTerminalManager.hostPing("cli:root").then((ok) => ok ? "RUNNING" as const : "UNAVAILABLE" as const).catch(() => "UNAVAILABLE" as const), "UNAVAILABLE" as const)
      : "disabled" as const;
    let browserHost: "in-process" | "RUNNING" | "UNAVAILABLE" | "DISABLED" | "CAPACITY_MISMATCH" = "in-process";
    let browserHostBuildCommit: string | null = null;
    let browserHostCaptureMetrics: BrowserHostCaptureMetrics | null = null;
    if (config.browserSessionsEnabled && config.browserHostTransport === "unix") {
      try {
        const [health, git] = await Promise.all([
          bounded(browserSessionManager.browserHostHealth
            ? browserSessionManager.browserHostHealth()
            : Promise.reject(new Error("Browser Host health checker is not configured.")),
            { buildCommit: null, captureMetrics: null } as never),
          readGitVersionMetadata()
        ]);
        browserHostBuildCommit = health.buildCommit;
        browserHostCaptureMetrics = health.captureMetrics;
        browserHost = browserHostReadiness(health, git?.commit ?? null);
      } catch {
        browserHost = "UNAVAILABLE";
      }
    } else if (!config.browserSessionsEnabled) {
      browserHost = "DISABLED";
    }
    // Sessions are refused until the persisted logouts load (auth.ts, fail closed).
    const sessionRevocations = defaultSessionRevocationStore.isReady() ? "RUNNING" : "UNAVAILABLE";
    const ok = database !== "UNAVAILABLE" && sessionRevocations === "RUNNING" && (config.workflowsEnabled === false || worker?.status === "RUNNING") && cliHost !== "UNAVAILABLE" && cliAdminHost !== "UNAVAILABLE" &&
      (browserHost === "in-process" || browserHost === "RUNNING" || browserHost === "DISABLED");
    // Default responses stay 200 with an ok flag for existing consumers (web
    // proxy recovery, live guard). Orchestrators that only read status codes
    // use ?strict=1 and receive 503 while a dependency is not ready.
    if (!ok && (request.query as { strict?: string } | undefined)?.strict === "1") reply.code(503);
    return {
      ok,
      apiStartedAt,
      dependencies: {
        store: config.runtimeStore,
        runtimeStore: config.runtimeStore,
        database,
        sessionRevocations,
        eventBus: "in-process",
        temporal: config.workflowsEnabled === false ? "disabled" : config.enableDummyTurns ? "enabled" : "disabled",
        worker: config.workflowsEnabled === false ? "disabled" : worker?.status,
        cliHost,
        cliAdminHost,
        browserHost,
        browserHostBuildCommit,
        browserHostCaptureMetrics,
        appDiagnostics: {
          isEnabled: appDiagnostics.isEnabled,
          captureId: appDiagnostics.captureId,
          usageBytes: appDiagnostics.usage.totalBytes,
          quotaBytes: appDiagnostics.quotaBytes,
          recorderStatus: appDiagnostics.recorder.status
        },
        codexTurns: config.enableCodexTurns ? "enabled" : "disabled",
        codexLb: config.codexLbConfigured ? "configured" : "disabled"
      }
    };
  });
  app.get("/version", defaultRouteRateLimitOptions, async () => ({
    name: "space-api",
    instance: config.instance,
    version: config.version,
    node: process.version,
    git: await readGitVersionMetadata()
  }));
  app.get("/api/app/version", defaultRouteRateLimitOptions, async () => appVersionReader.status());
}
