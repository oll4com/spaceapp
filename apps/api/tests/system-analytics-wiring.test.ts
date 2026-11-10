import { afterEach, describe, expect, it, vi } from "vitest";

type Input = Record<string, unknown>;
const { captured } = vi.hoisted(() => ({ captured: { built: [] as Array<{ name: string; input: Input }>, refreshes: 0, tokenUsage: [] as unknown[][] } }));
vi.mock("../src/system-analytics-service.js", async (orig) => ({ ...await orig<object>(),
  SystemAnalyticsService: class { constructor(input: Input) { captured.built.push({ name: "analytics", input }); } },
  tokenUsageSourcesFor: (...args: unknown[]) => { captured.tokenUsage.push(args); return "token-usage"; } }));
vi.mock("../src/opencode-model-bench.js", async (orig) => ({ ...await orig<object>(),
  OpencodeModelBenchService: class { constructor(input: Input) { captured.built.push({ name: "bench", input }); } startDailyRefresh() { captured.refreshes += 1; } },
  openCode2Models: (stdout: string, provider: string) => [`${provider}:${stdout}`] }));
vi.mock("../src/toolbar-system-services.js", async (orig) => ({ ...await orig<object>(),
  createCliSessionStatsProvider: (input: Input) => { captured.built.push({ name: "cliStats", input }); return input.collect; },
  createHostMemoryDetailsProvider: (input: Input) => { captured.built.push({ name: "hostMemory", input }); return "host-memory"; },
  collectCliSessionStats: (input: unknown) => input }));
vi.mock("../src/service-services.js", async (orig) => ({ ...await orig<object>(),
  createSystemServicesProvider: (input: Input) => { captured.built.push({ name: "services", input }); return "services"; } }));
vi.mock("../src/toolbar-model-stats.js", async (orig) => ({ ...await orig<object>(),
  createToolbarModelStatsCollector: (input: Input) => { captured.built.push({ name: "modelStats", input }); return "model-stats"; } }));

const { createSystemAnalyticsServices } = await import("../src/system-analytics-wiring.js");
const { InMemorySystemAnalyticsRepository } = await import("@space/db");

afterEach(() => { captured.built = []; captured.refreshes = 0; captured.tokenUsage = []; vi.unstubAllEnvs(); });

const session = (cliSessionId: string, runtimeId = "cli:codex") => ({ cliSessionId, paneId: "pane:a", roomId: "room:a", runtimeId, codexThreadId: null,
  modelId: "m", reasoningEffort: "high", pid: 1, status: "RUNNING", attachmentCount: 1, startedAt: "t0", detachedAt: null, endedAt: null, extra: "dropped" });

function build(input: { options?: Input; config?: Input; hostHealth?: (runtimeId: string) => Promise<unknown>; publicCredentialHost?: unknown;
  findLatestTaskForPane?: (paneId: string) => Promise<{ title: string } | null> } = {}) {
  const calls: string[] = [];
  const gatewayRepositoryFor = () => "gateway";
  const deps = {
    options: input.options ?? {},
    config: { cliEnabled: true, cliRootEnabled: false, codexAppServerHome: undefined, instanceJobs: { "token-usage-claude": true }, ...input.config },
    store: { kind: "memory-store" },
    cliTerminalManager: {
      hostHealth: input.hostHealth ?? (async () => ({ sessions: [] })),
      reapDetachedSessions: async () => { calls.push("reap"); return "reaped"; },
      interrupt: async (sessionId: string) => { calls.push(`interrupt ${sessionId}`); return true; }
    },
    unifiedCliTaskRegistry: { findLatestTaskForPane: input.findLatestTaskForPane ?? (async () => ({ title: "Fix it" })) },
    gatewayRepositoryFor,
    publicCredentialHost: input.publicCredentialHost ?? null
  };
  return { services: createSystemAnalyticsServices(deps as never), calls, gatewayRepositoryFor };
}
const built = (name: string) => captured.built.find((entry) => entry.name === name)!.input;

describe("system analytics wiring (ARCH-001 step 88)", () => {
  it("keeps every injected provider and builds nothing", () => {
    const options = { toolbarCliSessionStatsProvider: "stats", systemServicesProvider: "services", toolbarHostMemoryProvider: "memory",
      toolbarCliSessionReaper: "reaper", toolbarCliSessionTerminator: "terminator", toolbarModelStatsCollector: "model", systemAnalyticsService: "analytics",
      opencodeModelBenchService: "bench" };
    expect(build({ options }).services).toEqual(options);
    expect(captured.built).toEqual([]);
  });

  it("builds the providers in order on in-memory repositories and starts the bench refresh only outside tests", () => {
    const { services, gatewayRepositoryFor } = build({ options: { opencodeStateRoot: "/state" } });
    expect(captured.built.map((entry) => entry.name)).toEqual(["cliStats", "services", "hostMemory", "modelStats", "analytics", "bench"]);
    expect(services).toMatchObject({ systemServicesProvider: "services", toolbarHostMemoryProvider: "host-memory", toolbarModelStatsCollector: "model-stats" });
    expect(built("modelStats")).toEqual({ store: { kind: "memory-store" } });
    const analytics = built("analytics");
    expect(analytics.repository).toBeInstanceOf(InMemorySystemAnalyticsRepository);
    expect(analytics).toMatchObject({ store: { kind: "memory-store" }, stateRoot: "/state", codexHome: "/var/lib/spaceapp-user/.codex", tokenUsage: "token-usage" });
    expect(captured.tokenUsage).toEqual([[gatewayRepositoryFor, true]]);
    expect(built("bench").repository).toBeInstanceOf(InMemorySystemAnalyticsRepository);
    expect(built("bench").execVerbose).toBeUndefined();
    expect(captured.refreshes).toBe(0);
    captured.built = [];
    vi.stubEnv("NODE_ENV", "production"); vi.stubEnv("VITEST", "false");
    build();
    expect(captured.refreshes).toBe(1);
  });

  it("collects CLI session stats from the enabled hosts and fails only when every host fails", async () => {
    const { services } = build({ config: { cliRootEnabled: true }, hostHealth: async (runtimeId) => {
      if (runtimeId === "cli:root") throw new Error("down");
      return { sessions: [] };
    } });
    await expect((services.toolbarCliSessionStatsProvider as () => Promise<unknown>)()).resolves.toEqual({ hosts: [{ hostId: "main", health: { sessions: [] } }] });
    captured.built = [];
    const down = build({ hostHealth: async () => { throw new Error("down"); } }).services;
    await expect((down.toolbarCliSessionStatsProvider as () => Promise<unknown>)()).rejects.toThrow("Space CLI hosts are unavailable.");
    const none = build({ config: { cliEnabled: false } }).services;
    await expect((none.toolbarCliSessionStatsProvider as () => Promise<unknown>)()).resolves.toEqual({ hosts: [] });
  });

  it("reaps, interrupts, names sessions by their task and lists each live session once", async () => {
    const { services, calls } = build({ hostHealth: async (runtimeId) => ({ sessions: runtimeId === "cli:codex" ? [session("s1"), session("s1"), session("s2")] : [session("r1", "cli:root")] }) });
    await services.toolbarCliSessionReaper();
    await services.toolbarCliSessionTerminator("s9");
    expect(calls).toEqual(["reap", "interrupt s9"]);
    const resolveSessionTitle = built("hostMemory").resolveSessionTitle as (paneId: string) => Promise<string | null>;
    await expect(resolveSessionTitle("pane:a")).resolves.toBe("Fix it");
    const live = await (built("analytics").liveSessions as () => Promise<Array<Record<string, unknown>>>)();
    expect(live.map((entry) => entry.cliSessionId)).toEqual(["s1", "s2"]);
    expect(live[0]).not.toHaveProperty("extra");
    captured.built = [];
    build({ findLatestTaskForPane: async () => { throw new Error("gone"); } });
    await expect((built("hostMemory").resolveSessionTitle as (paneId: string) => Promise<string | null>)("pane:a")).resolves.toBeNull();
  });

  it("asks the CLI container for OpenCode models on a public install and reads none when it fails", async () => {
    build({ publicCredentialHost: { openCodeModels: async (provider: string) => (provider === "bad" ? Promise.reject(new Error("x")) : "out") } });
    const execVerbose = built("bench").execVerbose as (provider: string) => Promise<string[]>;
    await expect(execVerbose("opencode")).resolves.toEqual(["opencode:out"]);
    await expect(execVerbose("bad")).resolves.toEqual([]);
  });
});
