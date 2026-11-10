import { afterEach, describe, expect, it, vi } from "vitest";

type Check = { id: string; collect: () => Promise<{ status: string; detail: string; values: unknown[] }> };
const { captured } = vi.hoisted(() => ({ captured: { built: [] as Array<{ name: string; input: Record<string, unknown> }>, cliPublic: [] as boolean[] } }));
vi.mock("../src/system-health-service.js", async (orig) => ({ ...await orig<object>(),
  SystemHealthMonitor: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; captured.built.push({ name: "monitor", input }); }
    async snapshot() { return { snapshot: "health" }; } } }));
vi.mock("../src/system-topology-service.js", async (orig) => ({ ...await orig<object>(),
  SystemTopologyService: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; captured.built.push({ name: "topology", input }); } } }));
vi.mock("../src/cli-canary-health.js", async (orig) => ({ ...await orig<object>(),
  cliHealthChecks: (publicDistribution: boolean) => { captured.cliPublic.push(publicDistribution); return [{ id: "cli-canary" }]; } }));
vi.mock("../src/toolbar-provider-targets.js", async (orig) => ({ ...await orig<object>(),
  createToolbarProviderTargets: () => ({ readToolbarProviderTargets: async () => ({ data: [{ isCurrent: true, health: "DEGRADED", displayName: "Codex" }] }) }) }));

const { createSystemHealthServices } = await import("../src/system-health-wiring.js");
const { InMemorySystemHealthRepository } = await import("@space/db");

afterEach(() => { captured.built = []; captured.cliPublic = []; });

function build(input: { options?: Record<string, unknown>; config?: Record<string, unknown>; app?: unknown } = {}) {
  const deps = {
    app: input.app ?? { log: { warn: () => undefined } }, options: input.options ?? {},
    config: { publicDistribution: false, runtimeStore: "memory", cliEnabled: true, cliRootEnabled: false, browserSessionsEnabled: true, browserHostTransport: "unix",
      ...input.config },
    store: { getMcpGatewayStatus: async () => ({ status: "VERIFIED", serverCount: 3, toolCount: 40, lastDiscoveryAt: null }) },
    observability: { recentSnapshot: () => "requests" },
    workerReadinessChecker: async () => ({ status: "RUNNING", workflowPollerCount: 2, activityPollerCount: 1, workflowBacklogCount: null, activityBacklogCount: 0 }),
    storageReadinessChecker: async () => ({ status: "WARN", statusReason: "low space", dedicatedAppVolume: false, minimumRecommendedFreeBytes: 20 * 1024 ** 3 }),
    cliTerminalManager: { hostHealth: async (runtime: string) => (runtime === "cli:codex" ? { ok: true } : null) },
    browserSessionManager: { browserHostHealth: async () => null }
  };
  return createSystemHealthServices(deps as never);
}
const built = (name: string) => captured.built.find((entry) => entry.name === name)!.input;
const checks = () => built("monitor").checks as Check[];
const run = async (id: string) => checks().find((check) => check.id === id)!.collect();

describe("system health wiring (ARCH-001 step 87)", () => {
  it("keeps an injected health monitor and topology and builds neither", () => {
    const healthMonitor = { injected: "monitor" }; const systemTopologyService = { injected: "topology" };
    expect(build({ options: { healthMonitor, systemTopologyService } })).toEqual({ healthMonitor, systemTopologyService });
    expect(captured.built).toEqual([]);
  });

  it("builds the monitor on an in-memory history without PostgreSQL, then the topology over its snapshot", async () => {
    const { healthMonitor, systemTopologyService } = build({ config: { publicDistribution: true } });
    expect(captured.built.map((entry) => entry.name)).toEqual(["monitor", "topology"]);
    expect(built("monitor").repository).toBeInstanceOf(InMemorySystemHealthRepository);
    expect((built("monitor").requests as () => unknown)()).toBe("requests");
    const topology = built("topology");
    expect(topology.includeOperatorInfrastructure).toBe(false);
    await expect((topology.getHealthSnapshot as () => Promise<unknown>)()).resolves.toEqual({ snapshot: "health" });
    expect((healthMonitor as unknown as { input: unknown }).input).toBe(built("monitor"));
    expect((systemTopologyService as unknown as { input: unknown }).input).toBe(topology);
    expect(captured.cliPublic).toEqual([true]);
  });

  it("logs a failed history sample through the app log read when it happens", () => {
    const warnings: string[] = [];
    const app = { log: { warn: () => undefined } };
    build({ app });
    app.log = { warn: (message: string) => { warnings.push(message); } };
    (built("monitor").onError as () => void)();
    expect(warnings).toEqual(["System health history sample could not be retained."]);
  });

  it("runs every check in order with its own status rules", async () => {
    build();
    expect(checks().map((check) => check.id)).toEqual(["cli-canary", "api", "database", "worker", "cli-host", "admin-host", "browser-host", "storage", "mcp", "provider"]);
    expect(await run("api")).toMatchObject({ status: "healthy", detail: "API is responding" });
    expect(await run("database")).toEqual({ status: "healthy", detail: "In-memory store", values: [] });
    expect(await run("worker")).toMatchObject({ status: "healthy", values: expect.arrayContaining([{ label: "Workflow backlog", value: "Unavailable" }]) });
    expect(await run("cli-host")).toEqual({ status: "healthy", detail: "Host is responding", values: [] });
    expect(await run("admin-host")).toEqual({ status: "disabled", detail: "Not enabled", values: [] });
    expect(await run("browser-host")).toEqual({ status: "critical", detail: "Browser host is unreachable", values: [] });
    expect(await run("storage")).toEqual({ status: "warning", detail: "low space", values: [{ label: "Dedicated volume", value: "No" }, { label: "Minimum free space", value: "20 GiB" }] });
    expect(await run("mcp")).toMatchObject({ status: "healthy", values: [{ label: "Servers", value: "3" }, { label: "Tools", value: "40" }, { label: "Last discovery", value: "Unavailable" }] });
    expect(await run("provider")).toEqual({ status: "warning", detail: "Codex · Latest provider verification", values: [] });
    captured.built = [];
    build({ config: { browserHostTransport: "in-process" } });
    expect(await run("browser-host")).toEqual({ status: "healthy", detail: "In-process browser runtime", values: [] });
  });
});
