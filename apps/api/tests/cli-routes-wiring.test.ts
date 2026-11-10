import { afterEach, describe, expect, it, vi } from "vitest";
import { codexPrivateAppServerSocketPath } from "../src/cli-terminal.js";

type Fn = (...args: never[]) => Promise<unknown>;
const captured = vi.hoisted(() => ({
  routes: {} as Record<string, Record<string, unknown>>, plan: undefined as Record<string, Fn> | undefined,
  egress: undefined as unknown, vpnApps: undefined as unknown, login: undefined as unknown, audits: [] as unknown[],
  thread: null as string | null, claudeTarget: [] as unknown[], claudeDriver: [] as unknown[]
}));
const capture = (name: string) => (_app: unknown, deps: Record<string, unknown>) => { captured.routes[name] = deps; };
vi.mock("../src/plan-execution-routes.js", async (orig) => ({ ...await orig<object>(), registerPlanExecutionRoutes: (_app: unknown, deps: Record<string, Fn>) => { captured.plan = deps; } }));
vi.mock("../src/pane-cli-route-group.js", async (orig) => ({ ...await orig<object>(), registerPaneCliRoutes: capture("paneCli") }));
vi.mock("../src/cli-account-routes.js", async (orig) => ({ ...await orig<object>(), registerCliAccountRoutes: capture("accounts") }));
vi.mock("../src/cli-runtime-routes.js", async (orig) => ({ ...await orig<object>(), registerCliRuntimeRoutes: capture("runtimes"), registerCliRuntimeSettingsRoutes: capture("runtimeSettings") }));
vi.mock("../src/cli-egress-routes.js", async (orig) => ({ ...await orig<object>(), registerCliEgressRoutes: capture("egress") }));
vi.mock("../src/agent-tool-routing-routes.js", async (orig) => ({ ...await orig<object>(), registerAgentToolRoutingRoutes: capture("toolRouting") }));
vi.mock("../src/agent-tools-launch-routes.js", async (orig) => ({ ...await orig<object>(), registerAgentToolsLaunchRoutes: capture("toolsLaunch") }));
vi.mock("../src/instance-release-routes.js", async (orig) => ({ ...await orig<object>(), registerInstanceReleaseRoutes: capture("releases") }));
vi.mock("../src/server-ops-routes.js", async (orig) => ({ ...await orig<object>(), registerServerOpsRoutes: capture("serverOps") }));
vi.mock("../src/cli-runtimes.js", async (orig) => ({ ...await orig<object>(), registerCliRuntimeCacheInvalidation: (_app: unknown, invalidate: () => void) => { captured.routes.invalidate = { invalidate }; } }));
vi.mock("../src/cli-egress-status.js", async (orig) => ({ ...await orig<object>(), createCliEgressStatus: (deps: unknown) => {
  captured.egress = deps;
  return { assertCliVpnAvailable: vi.fn(), runningDeepSeekHarnessPid: vi.fn(), inspectCliVpnStatus: vi.fn(), assertDeepSeekHarnessIsolated: vi.fn(), readDeepSeekHarnessMaintenanceStatus: vi.fn(async () => "harness") };
} }));
vi.mock("../src/cli-vpn-applications.js", async (orig) => ({ ...await orig<object>(), createCliVpnApplicationsReader: (deps: unknown) => { captured.vpnApps = deps; return async () => "apps"; } }));
vi.mock("../src/cli-login-opener.js", async (orig) => ({ ...await orig<object>(), createCliLoginOpener: (deps: unknown) => { captured.login = deps; return async () => "login"; } }));
vi.mock("../src/request-audit.js", async (orig) => ({ ...await orig<object>(), recordAudit: async (...args: unknown[]) => { captured.audits.push(args); } }));
vi.mock("../src/pane-codex-thread.js", async (orig) => ({ ...await orig<object>(), resolvePaneCodexThreadId: async () => captured.thread }));
vi.mock("../src/plan-execution-claude-driver.js", async (orig) => ({ ...await orig<object>(),
  claudePlanTarget: async (session: unknown, read: (options: unknown) => Promise<unknown>) => { captured.claudeTarget.push([session, await read({ fresh: true })]); return { claude: true }; },
  claudePaneManagedTurnDriver: (input: unknown) => { captured.claudeDriver.push(input); return { driver: "claude" }; }
}));

const { registerCliRoutes } = await import("../src/cli-routes-wiring.js");

const pane = { id: "pane:term0001", roomId: "room:aaaa0001", mode: "TERMINAL", isClosed: false };
const codexSession = { sessionId: "cli_session:s1", paneId: pane.id, roomId: pane.roomId, runtimeId: "cli:codex", status: "RUNNING", isActive: true, purpose: "NORMAL", cwd: "/work" };
const claudeSession = { ...codexSession, sessionId: "cli_session:c1", runtimeId: "cli:claude" };
afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(captured, { routes: {}, plan: undefined, egress: undefined, vpnApps: undefined, login: undefined, audits: [], thread: null, claudeTarget: [], claudeDriver: [] });
});

function wire(input: { role?: string; session?: Record<string, unknown> | null; storedSession?: Record<string, unknown> | null; writers?: string[]; native?: Record<string, unknown> | null; instance?: string } = {}) {
  const gets: Record<string, () => Promise<unknown>> = {};
  const app = { get: (path: string, _options: unknown, handler: () => Promise<unknown>) => { gets[path] = handler; } };
  const claimed: unknown[] = [];
  const published: unknown[] = [];
  const enabled: string[] = [];
  const socketPaths: string[] = [];
  const roomRoutes: unknown[] = [];
  const access: unknown[] = [];
  const control: unknown[] = [];
  const liveReads: unknown[] = [];
  const session = input.session === undefined ? codexSession : input.session;
  const store = {
    getPane: async () => pane,
    getActivePaneCliSession: async () => session,
    getPaneCliSession: async () => input.storedSession === undefined ? session : input.storedSession,
    claimPaneCliCodexThread: async (...args: unknown[]) => { claimed.push(args); },
    publishManagedPlanExecutionEvent: async (event: object) => ({ ...event, stored: true })
  };
  const result = registerCliRoutes(app as never, {
    store: store as never,
    config: { instance: input.instance ?? "dev", cliAccountBalancerStateFile: "/state/balancer/state.json", planStageMaxAttempts: 4,
      instanceJobs: { "managed-plan-controller": true } } as never,
    options: { findCodexModelControlThreads: (async () => input.writers ?? []) as never, releasesOptions: { x: 1 } as never, agentToolsOptions: { y: 2 } as never },
    auth: { sessionSecret: "s".repeat(32) },
    eventBus: { publish: (event: unknown) => { published.push(event); } } as never,
    observability: {} as never, cliTerminalManager: {} as never,
    cliRuntimeVisibility: { assertEnabled: async (id: string) => { enabled.push(id); } } as never,
    cliRuntimeRegistryCache: { invalidate: vi.fn() } as never,
    cliUserHosting: { userRegistry: "registry" } as never,
    roomShares: { observeOnly: "observe" } as never,
    roomCoordination: { registerRoutes: (...args: unknown[]) => { roomRoutes.push(args); } } as never,
    controlRepository: {} as never,
    controlUser: (async (id: string) => ({ id, role: input.role ?? "ADMIN" })) as never,
    codexCliModeDefaultsService: { read: async () => ({ mode: "default" }) } as never,
    codexSocketControlFactory: ((path: string) => {
      socketPaths.push(path);
      return { readThread: async (id: string) => input.native === undefined ? { id, cwd: "/work", status: "idle" } : input.native, kind: "codex" };
    }) as never,
    inspectRoomCli: vi.fn() as never,
    readClaudeLiveTurns: (async (...args: unknown[]) => { liveReads.push(args); return { turns: [] }; }) as never,
    defaultRouteRateLimitOptions: { config: { rateLimit: { max: 1 } } } as never, defaultWebsocketRateLimitOptions: {} as never,
    assertRoomAccess: (async (...args: unknown[]) => { access.push(args); }) as never,
    assertPaneCliRuntimeEnabled: (async () => undefined) as never,
    assertCliHttpMutationControl: (async (...args: unknown[]) => { control.push(args); }) as never,
    cliAccountBalancer: {} as never
  } as never);
  return { result, gets, claimed, published, enabled, socketPaths, roomRoutes, access, control, liveReads };
}

describe("CLI routes wiring", () => {
  it("returns the harness status, VPN applications and CLI login it built, and registers every route group", async () => {
    const { result, roomRoutes } = wire();
    await expect(result.readDeepSeekHarnessMaintenanceStatus()).resolves.toBe("harness");
    await expect(result.readCliVpnApplications({} as never)).resolves.toBe("apps");
    await expect(result.openCliLogin({} as never)).resolves.toBe("login");
    expect(Object.keys(captured.routes).sort()).toEqual(["accounts", "egress", "invalidate", "paneCli", "releases", "runtimeSettings", "runtimes", "serverOps", "toolRouting", "toolsLaunch"]);
    expect(captured.routes.runtimes).toMatchObject({ userRegistry: "registry", readCliVpnApplications: expect.any(Function) });
    expect(captured.routes.paneCli).toMatchObject({ observeOnly: "observe" });
    expect(captured.routes.accounts).toMatchObject({ openCliLogin: result.openCliLogin });
    expect(roomRoutes).toHaveLength(1);
    expect(captured.plan).toMatchObject({ autoStart: true, maxStageAttempts: 4 });
  });

  it("serves the Codex defaults only while Codex is enabled", async () => {
    const { gets, enabled } = wire();
    await expect(gets["/api/cli/codex-defaults"]!()).resolves.toEqual({ mode: "default" });
    expect(enabled).toEqual(["cli:codex"]);
  });

  it("keeps the queue grants beside the balancer state outside tests, and manages releases only on stable", () => {
    wire();
    expect(captured.routes.releases).toMatchObject({ managedHere: false, grantStateFile: null, releases: { x: 1 } });
    vi.stubEnv("VITEST", "");
    wire({ instance: "stable" });
    expect(captured.routes.releases).toMatchObject({ managedHere: true, grantStateFile: "/state/balancer/queue-operator-grants.json" });
  });

  it("records the agent tool routing audit against the store", async () => {
    wire();
    await (captured.routes.toolRouting!.recordAudit as (request: unknown, input: unknown) => Promise<void>)({ id: "req" }, { action: "x" });
    expect(captured.audits).toHaveLength(1);
    expect((captured.audits[0] as unknown[]).slice(1)).toEqual([{ id: "req" }, { action: "x" }]);
    expect(captured.routes.toolRouting).toMatchObject({ agentToolsOptions: { y: 2 } });
  });

  it("refuses a managed plan for a non-administrator or without the same running Codex or Claude Code session", async () => {
    wire({ role: "USER" });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow("Managed execution requires current administrator access.");
    const same = "Managed execution requires the same running Codex or Claude Code session.";
    wire({ session: null });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow(same);
    wire({ session: { ...codexSession, status: "EXITED" } });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow(same);
    wire();
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never, "cli_session:other" as never)).rejects.toThrow(same);
    wire({ session: { ...codexSession, runtimeId: "cli:gemini" } });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow(same);
  });

  it("targets a Claude Code pane through its live turns", async () => {
    const { liveReads, access } = wire({ session: claudeSession });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).resolves.toEqual({ claude: true });
    expect(liveReads).toEqual([[claudeSession, { fresh: true }]]);
    expect(access).toEqual([[pane.roomId, { id: "user:owner01", role: "ADMIN" }]]);
  });

  it("targets a Codex pane by its known thread, else by the one writer thread its own socket confirms", async () => {
    captured.thread = "thread:known";
    wire();
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).resolves.toEqual({ paneId: pane.id, sessionId: codexSession.sessionId, threadId: "thread:known", cwd: "/work" });

    captured.thread = null;
    const fresh = wire({ writers: ["thread:fresh"] });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).resolves.toMatchObject({ threadId: "thread:fresh" });
    expect(fresh.claimed).toEqual([[codexSession.sessionId, "thread:fresh", "AUTO", "managed-plan"]]);
    expect(fresh.socketPaths).toEqual([codexPrivateAppServerSocketPath(codexSession)]);

    const unconfirmed = "The Codex session has no confirmed native thread and working directory.";
    const elsewhere = wire({ writers: ["thread:fresh"], native: { id: "thread:fresh", cwd: "/other", status: "idle" } });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow(unconfirmed);
    expect(elsewhere.claimed).toEqual([]);
    wire({ writers: ["thread:a", "thread:b"] });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow(unconfirmed);
    wire({ session: { ...codexSession, cwd: null } });
    await expect(captured.plan!.target("user:owner01" as never, pane.id as never)).rejects.toThrow(unconfirmed);
  });

  it("starts a plan only on the same CLI session and resumes it only with the same identity", async () => {
    const { control } = wire();
    await expect(captured.plan!.assertStartControl({ id: "req" } as never, { paneId: pane.id, sessionId: "cli_session:other" } as never)).rejects.toThrow("The CLI session changed.");
    await captured.plan!.assertStartControl({ id: "req" } as never, { paneId: pane.id, sessionId: codexSession.sessionId } as never);
    expect(control).toEqual([[{ id: "req" }, codexSession]]);

    captured.thread = "thread:known";
    const execution = { id: "plan_exec:1", ownerUserId: "user:owner01", paneId: pane.id, sessionId: codexSession.sessionId, threadId: "thread:known", cwd: "/work" };
    await expect(captured.plan!.resolve({ ...execution, threadId: "thread:other" } as never)).rejects.toThrow("Managed execution identity changed.");
    const codex = wire();
    await expect(captured.plan!.resolve(execution as never)).resolves.toMatchObject({ kind: "codex" });
    expect(codex.socketPaths).toEqual([codexPrivateAppServerSocketPath(codexSession)]);
    wire({ storedSession: null });
    await expect(captured.plan!.resolve(execution as never)).rejects.toThrow("Managed session was not found.");
  });

  it("drives a Claude Code plan through the pane and publishes the stored execution events", async () => {
    const { published } = wire({ session: claudeSession });
    const execution = { id: "plan_exec:2", ownerUserId: "user:owner01", paneId: pane.id, sessionId: claudeSession.sessionId };
    await expect(captured.plan!.resolve(execution as never)).resolves.toEqual({ driver: "claude" });
    expect(captured.claudeDriver).toEqual([expect.objectContaining({ executionId: "plan_exec:2", session: claudeSession, pane })]);
    await captured.plan!.publish({ type: "MANAGED_PLAN_EXECUTION_UPDATED" } as never);
    expect(published).toEqual([{ type: "MANAGED_PLAN_EXECUTION_UPDATED", stored: true }]);
  });
});
