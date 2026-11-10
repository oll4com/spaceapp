import type { StorageReadiness } from "@space/contracts";
import { InMemorySystemHealthRepository, PostgresSpaceStore, PostgresSystemHealthRepository } from "@space/db";
import type { SpaceStore } from "@space/runtime";
import type { FastifyInstance } from "fastify";
import type { BrowserSessionManagerWithHostHealth } from "./browser-host-proxy.js";
import { cliHealthChecks } from "./cli-canary-health.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import type { createHttpObservability } from "./observability.js";
import { SystemHealthMonitor } from "./system-health-service.js";
import { SystemTopologyService } from "./system-topology-service.js";
import { createToolbarProviderTargets } from "./toolbar-provider-targets.js";
import type { WorkerReadinessChecker } from "./worker-readiness.js";

type SystemHealthDeps = {
  /** Read only when a history sample fails: app.ts creates the app after this block, so it passes a lazy `log`. */
  app: Pick<FastifyInstance, "log">;
  options: { healthMonitor?: SystemHealthMonitor; systemTopologyService?: SystemTopologyService };
  config: SpaceApiConfig; store: SpaceStore; observability: Pick<ReturnType<typeof createHttpObservability>, "recentSnapshot">;
  workerReadinessChecker: WorkerReadinessChecker; storageReadinessChecker: () => Promise<StorageReadiness>;
  cliTerminalManager: Pick<CliTerminalManager, "hostHealth">; browserSessionManager: Pick<BrowserSessionManagerWithHostHealth, "browserHostHealth">;
};

/** The system health block of app.ts (moved verbatim, ARCH-001 step 87): the health history repository, the provider targets its provider check
 *  reads, the health monitor with every check, and the system topology over its snapshot, each injected one kept. Returns the monitor and the
 *  topology, which first setup, the request hooks and the admin routes read. */
export function createSystemHealthServices(deps: SystemHealthDeps) {
  const { app, options, config, store, observability, workerReadinessChecker, storageReadinessChecker, cliTerminalManager, browserSessionManager } = deps;
  const healthRepository = store instanceof PostgresSpaceStore && config.databaseUrl
    ? PostgresSystemHealthRepository.fromConnectionString(config.databaseUrl)
    : new InMemorySystemHealthRepository();
  const { readToolbarProviderTargets } = createToolbarProviderTargets({ store });
  const healthMonitor = options.healthMonitor ?? new SystemHealthMonitor({
    repository: healthRepository,
    requests: () => observability.recentSnapshot(),
    onError: () => app.log.warn("System health history sample could not be retained."),
    checks: [
      ...cliHealthChecks(config.publicDistribution === true),
      { id: "api", label: "Space API", collect: async () => ({ status: "healthy", detail: "API is responding", values: [
        { label: "Uptime", value: `${Math.round(process.uptime())} s` },
        { label: "Node.js", value: process.version },
        { label: "Heap", value: `${Math.round(process.memoryUsage().heapUsed / 1024 ** 2)} MiB` },
      ] }) },
      { id: "database", label: "Database", collect: async () => {
        await healthRepository.probe();
        return { status: "healthy", detail: config.runtimeStore === "postgres" ? "PostgreSQL query succeeded" : "In-memory store", values: [] };
      } },
      { id: "worker", label: "Temporal & worker", collect: async () => {
        const w = await workerReadinessChecker();
        return { status: w.status === "RUNNING" ? "healthy" : "critical",
          detail: w.status === "RUNNING" ? "Temporal reachable with workflow and activity pollers" : "Worker is not ready",
          values: [ { label: "Workflow pollers", value: String(w.workflowPollerCount) }, { label: "Activity pollers", value: String(w.activityPollerCount) },
            { label: "Workflow backlog", value: w.workflowBacklogCount === null ? "Unavailable" : String(w.workflowBacklogCount) },
            { label: "Activity backlog", value: w.activityBacklogCount === null ? "Unavailable" : String(w.activityBacklogCount) } ] };
      } },
      ...[{ id: "cli-host", label: "CLI host", enabled: config.cliEnabled, runtime: "cli:codex" },
        { id: "admin-host", label: "Admin CLI host", enabled: config.cliRootEnabled, runtime: "cli:root" }].map(h => ({
          id: h.id, label: h.label, collect: async () => {
            if (!h.enabled) return { status: "disabled" as const, detail: "Not enabled", values: [] };
            const result = await cliTerminalManager.hostHealth(h.runtime).catch(() => null);
            return { status: result ? "healthy" as const : "critical" as const, detail: result ? "Host is responding" : "Host is unreachable", values: [] };
          }
        })),
      { id: "browser-host", label: "Browser host", collect: async () => {
        if (!config.browserSessionsEnabled) return { status: "disabled", detail: "Not enabled", values: [] };
        if (config.browserHostTransport !== "unix") return { status: "healthy", detail: "In-process browser runtime", values: [] };
        const result = await browserSessionManager.browserHostHealth?.().catch(() => null);
        return { status: result ? "healthy" : "critical", detail: result ? "Browser host is responding" : "Browser host is unreachable", values: [] };
      } },
      { id: "storage", label: "Storage readiness", collect: async () => {
        const st = await storageReadinessChecker();
        return { status: st.status === "VERIFIED" ? "healthy" : st.status === "WARN" ? "warning" : "critical",
          detail: st.statusReason.slice(0, 500), values: [{ label: "Dedicated volume", value: st.dedicatedAppVolume ? "Yes" : "No" },
          { label: "Minimum free space", value: `${Math.round(st.minimumRecommendedFreeBytes / 1024 ** 3)} GiB` }] };
      } },
      { id: "mcp", label: "MCP gateway", collect: async () => {
        const g = await store.getMcpGatewayStatus();
        return { status: g.status === "VERIFIED" ? "healthy" : g.status === "ERROR" ? "critical" : "unavailable",
          detail: "Latest gateway verification", values: [{ label: "Servers", value: String(g.serverCount) }, { label: "Tools", value: String(g.toolCount) }, { label: "Last discovery", value: g.lastDiscoveryAt ?? "Unavailable" }] };
      } },
      { id: "provider", label: "Active provider", collect: async () => {
        const targets = await readToolbarProviderTargets(); const current = targets.data.find(p => p.isCurrent);
        return { status: current?.health === "HEALTHY" ? "healthy" : current?.health === "UNAVAILABLE" ? "critical" : current?.health === "DEGRADED" ? "warning" : "unavailable",
          detail: current ? `${current.displayName} · Latest provider verification` : "No active provider", values: [] };
      } },
    ]
  });
  const systemTopologyService: SystemTopologyService = options.systemTopologyService ?? new SystemTopologyService({
    getHealthSnapshot: () => healthMonitor.snapshot(),
    includeOperatorInfrastructure: !config.publicDistribution
  });
  return { healthMonitor, systemTopologyService };
}
