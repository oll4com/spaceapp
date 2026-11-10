import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";
import { privatePaneProfileId } from "../src/youtube-accounts.js";

type Deps = Record<string, (...args: never[]) => Promise<unknown>>;
const captured = vi.hoisted(() => ({
  schedule: undefined as Deps | undefined, computer: undefined as Deps | undefined, deliverables: undefined as Deps | undefined,
  connector: undefined as Record<string, unknown> | undefined, delegation: undefined as Deps | undefined,
  routes: {} as Record<string, unknown[]>, persisted: [] as Record<string, unknown>[], google: [] as unknown[], microsoft: [] as unknown[]
}));
const route = (name: string) => (...args: unknown[]) => { (captured.routes[name] ??= []).push(args); };
vi.mock("../src/dot-schedules.js", () => ({ createDotScheduleService: (deps: Deps) => { captured.schedule = deps; return { kind: "schedules" }; }, registerDotScheduleRoutes: route("schedules") }));
vi.mock("../src/dot-computer.js", () => ({ createDotComputerService: (deps: Deps) => { captured.computer = deps; return { kind: "computer" }; } }));
vi.mock("../src/dot-deliverables.js", () => ({ createDotDeliverablesService: (deps: Deps) => { captured.deliverables = deps; return { kind: "deliverables" }; }, registerDotDeliverableRoutes: route("deliverables") }));
vi.mock("../src/dot-delegations.js", () => ({ createDotDelegationService: (deps: Deps) => { captured.delegation = deps; return { kind: "delegations" }; } }));
vi.mock("../src/dot-memory.js", () => ({ registerDotMemoryRoutes: route("memory") }));
vi.mock("../src/dot-auto-routing-routes.js", () => ({ registerDotAutoRoutingShadowRoutes: route("autoRouting") }));
vi.mock("../src/dot-connectors.js", () => ({
  createConnectorService: (deps: Record<string, unknown>) => { captured.connector = deps; return { kind: "connectors" }; },
  createGoogleConnector: (input: unknown) => { captured.google.push(input); return { kind: "google" }; },
  createMicrosoftConnector: (input: unknown) => { captured.microsoft.push(input); return { kind: "microsoft" }; },
  registerConnectorRoutes: route("connectors")
}));
vi.mock("../src/cli-agent-files.js", () => ({ agentFileMaxBytes: 1234, persistAgentFile: async (input: Record<string, unknown>) => { captured.persisted.push(input); return { artifact: { id: "artifact:1" }, event: { type: "ARTIFACT_CREATED" } }; } }));
vi.mock("@space/db", async (importOriginal) => {
  const store = (kind: string) => ({ fromConnectionString: () => ({ kind, dispose: vi.fn() }) });
  return { ...await importOriginal<object>(), PostgresDotSchedulesRepository: store("schedules"), PostgresDotDeliverablesRepository: store("deliverables"),
    PostgresConnectorAccountsRepository: store("connectors"), PostgresDotDelegationsRepository: store("delegations") };
});

const { registerDotServices } = await import("../src/dot-services-wiring.js");

const SECRET = "s".repeat(32);
const browserPane = { id: "pane:browser01", roomId: "room:aaaa0001", mode: "BROWSER", isClosed: false, title: "Browser" };
afterEach(() => {
  vi.unstubAllEnvs();
  Object.assign(captured, { schedule: undefined, computer: undefined, deliverables: undefined, connector: undefined, delegation: undefined, routes: {}, persisted: [], google: [], microsoft: [] });
});

function wire(input: { dots?: boolean; databaseUrl?: string | undefined; goals?: boolean; bridge?: boolean; googleClientId?: string; pane?: Record<string, unknown>; activeSession?: unknown; browserSession?: unknown; auditFails?: boolean } = {}) {
  const hooks: string[] = [];
  const app = { addHook: (name: string) => { hooks.push(name); } };
  const published: unknown[] = [];
  const audits: unknown[] = [];
  const sent: unknown[] = [];
  const interrupted: unknown[] = [];
  const updates: unknown[] = [];
  const browser = { startOrRestore: vi.fn(async () => ({ session: { sessionId: "bs:new", currentUrl: "https://a.example/?q=secret", title: null } })),
    navigate: vi.fn(async () => ({ session: { sessionId: "bs:old", currentUrl: "https://b.example/", title: "t".repeat(600) } })), getActive: vi.fn(async () => null) };
  const saved: unknown[] = [];
  const connectorServiceRef = { current: null as unknown };
  const dotGoalService = { control: vi.fn(async () => undefined), create: vi.fn() };
  const result = registerDotServices(app as never, {
    store: {
      getActiveSpaceAgentSession: async () => input.activeSession ?? null,
      getActivePaneBrowserSession: async () => input.browserSession ?? null,
      getPane: async () => input.pane ?? browserPane,
      createPanes: async () => [{ ...browserPane, id: "pane:created01" }],
      listEvents: async () => [{ type: "PANE_CREATED", paneId: "pane:created01" }, { type: "PANE_CREATED", paneId: "pane:other001" }],
      updatePane: async (...args: unknown[]) => { updates.push(args); },
      recordAuditEvent: async (event: unknown) => { if (input.auditFails) throw new Error("db down"); audits.push(event); },
      upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` })
    } as never,
    config: { databaseUrl: "databaseUrl" in input ? input.databaseUrl : "postgres://x", dotWorkspaceRoot: "/tmp/dots", browserEvidenceArtifactRoot: "/tmp/art",
      browserSessionsEnabled: input.bridge ?? true, browserToolBridgeEnabled: input.bridge ?? true } as never,
    options: {},
    auth: { sessionSecret: SECRET, googleClientId: input.googleClientId, googleClientSecret: "g-secret" },
    eventBus: { publish: (event: unknown) => { published.push(event); } },
    defaultRouteRateLimitOptions: {},
    dotsAuthenticatedOwner: async () => "user:owner01",
    dotsRepository: input.dots === false ? null : {} as never,
    dotGoalsRepository: input.goals === false ? null : {} as never,
    dotGoalService: input.goals === false ? null : dotGoalService as never,
    dotMemoryService: null,
    dotAtCapacity: async () => false,
    autoRouteFactsLoader: null,
    browserSessionManager: browser as never,
    browserAccountStore: { save: async (...args: unknown[]) => { saved.push(args); } } as never,
    youtubeAccountOwner: async (owner: string) => `${owner}:yt`,
    cliRuntimeVisibility: { assertEnabled: async () => undefined },
    connectorCrypto: {} as never,
    connectorServiceRef: connectorServiceRef as never,
    connectorStateTools: {} as never,
    roomPaneCommands: { resolve: async () => [{ mode: "BROWSER" }] } as never,
    spaceAgentAdapter: {
      sendMessage: async (input: unknown) => { sent.push(input); return {}; },
      interrupt: async (input: unknown) => { interrupted.push(input); },
      createOrRestoreSession: async () => ({ binding: { sessionId: "s:1" }, dotId: "dot:other" })
    } as never
  });
  return { result, hooks, published, audits, sent, interrupted, updates, browser, saved, connectorServiceRef, dotGoalService };
}

describe("Dot services wiring", () => {
  it("makes no service or store without the Dots store or a database, and still registers the routes", () => {
    const none = wire({ dots: false });
    expect(none.result).toEqual({ dotScheduleService: null, dotComputerService: null, dotDeliverablesService: null, connectorService: null, dotDelegationService: null });
    expect(none.hooks).toEqual([]);
    expect(none.connectorServiceRef.current).toBeNull();
    expect(Object.keys(captured.routes).sort()).toEqual(["autoRouting", "connectors", "deliverables", "memory", "schedules"]);

    const noDb = wire({ databaseUrl: undefined });
    expect(noDb.result).toMatchObject({ dotScheduleService: null, dotDeliverablesService: null, connectorService: null, dotDelegationService: null, dotComputerService: { kind: "computer" } });
  });

  it("closes each store it opens, sets the connector reference and leaves delegations out without Goals", () => {
    const all = wire();
    expect(all.result).toEqual({ dotScheduleService: { kind: "schedules" }, dotComputerService: { kind: "computer" }, dotDeliverablesService: { kind: "deliverables" },
      connectorService: { kind: "connectors" }, dotDelegationService: { kind: "delegations" } });
    expect(all.hooks).toEqual(["onClose", "onClose", "onClose", "onClose"]);
    expect(all.connectorServiceRef.current).toEqual({ kind: "connectors" });
    expect(captured.deliverables).toMatchObject({ maxBytes: 1234, workspaceRoot: "/tmp/dots" });

    const noGoals = wire({ goals: false });
    expect(noGoals.result.dotDelegationService).toBeNull();
    expect(noGoals.hooks).toHaveLength(3);
  });

  it("offers Google only with a client id and Microsoft only with its app registration", () => {
    wire();
    expect(captured.connector).toMatchObject({ google: null, microsoft: null, microsoftReason: expect.stringContaining("SPACE_MICROSOFT_CLIENT_ID") });
    vi.stubEnv("SPACE_MICROSOFT_CLIENT_ID", "ms-id"); vi.stubEnv("SPACE_MICROSOFT_CLIENT_SECRET", "ms-secret");
    wire({ googleClientId: "g-id" });
    expect(captured.connector).toMatchObject({ google: { kind: "google" }, microsoft: { kind: "microsoft" } });
    expect(captured.google).toEqual([{ clientId: "g-id", clientSecret: "g-secret" }]);
    expect(captured.microsoft).toEqual([{ clientId: "ms-id", clientSecret: "ms-secret", tenant: "common" }]);
  });

  it("answers 401 on the schedule, deliverable and memory routes without a valid session", async () => {
    wire();
    const user = { id: "user:owner01", email: "o@example.com", role: "ADMIN" as const };
    for (const name of ["schedules", "deliverables", "memory"]) {
      const args = captured.routes[name]![0] as unknown[];
      const options = args.at(-1) as { authenticatedOwner(request: unknown): Promise<string> };
      await expect(options.authenticatedOwner({ user: null, cookies: {} })).rejects.toMatchObject({ statusCode: 401, message: "Sign in to use Dots." });
      await expect(options.authenticatedOwner({ user, cookies: { [cookieName]: signSession(user, SECRET) } })).resolves.toBe("user:owner01:stored");
    }
    expect((captured.routes.connectors![0] as unknown[]).at(-1)).toMatchObject({ authenticatedOwner: expect.any(Function), state: {} });
  });

  it("schedules read the pane's active conversation and send through it", async () => {
    const { sent } = wire({ activeSession: { sessionId: "s:live" } });
    await expect(captured.schedule!.activeSessionId("pane:browser01" as never)).resolves.toBe("s:live");
    await captured.schedule!.send({ paneId: "pane:browser01", sessionId: "s:live", ownerUserId: "user:owner01", content: "hi", requestKey: "rk" } as never);
    expect(sent).toEqual([expect.objectContaining({ sessionId: "s:live", content: "hi", operatorUserId: "user:owner01", clientRequestId: "rk" })]);
    wire();
    await expect(captured.schedule!.activeSessionId("pane:browser01" as never)).resolves.toBeNull();
  });

  it("the Dot computer pauses Goals only with the Goal service and interrupts only the conversation the pane shows", async () => {
    const on = wire({ activeSession: { sessionId: "s:shown" } });
    await expect(captured.computer!.pauseGoal("user:owner01" as never, "dot:1" as never, "goal:1" as never, null as never)).resolves.toBe(true);
    expect(on.dotGoalService.control).toHaveBeenCalledWith("user:owner01", "dot:1", "goal:1", { action: "PAUSE" }, null);
    await expect(captured.computer!.interrupt({ paneId: "pane:browser01", sessionId: "s:other" } as never, "stop" as never)).resolves.toBe(false);
    await expect(captured.computer!.interrupt({ paneId: "pane:browser01", sessionId: "s:shown" } as never, "stop" as never)).resolves.toBe(true);
    expect(on.interrupted).toHaveLength(1);
    wire({ goals: false });
    await expect(captured.computer!.pauseGoal("user:owner01" as never, "dot:1" as never, "goal:1" as never, null as never)).resolves.toBe(false);
  });

  it("reports the browser state redacted and ready only when the session is ready", async () => {
    wire({ browserSession: { isActive: true, sessionId: "bs:1", runtimeState: "STARTING", currentUrl: "https://a.example/path?token=x", title: "t".repeat(700) } });
    const state = await captured.computer!.browserState("pane:browser01" as never) as Record<string, unknown>;
    expect(state).toMatchObject({ active: true, sessionId: "bs:1", ready: false });
    expect(String(state.title).length).toBeLessThanOrEqual(500);
    expect(state.currentUrl).not.toContain("token=x");
    wire();
    await expect(captured.computer!.browserState("pane:browser01" as never)).resolves.toEqual({ active: false, currentUrl: null, title: null, sessionId: null, ready: false });
  });

  it("gives the Dot its own browser pane only with the browser bridge, and opens it only in its room", async () => {
    wire({ bridge: false });
    expect(captured.computer!.createBrowserPane).toBeUndefined();

    const on = wire();
    await expect(captured.computer!.createBrowserPane({ owner: "user:owner01", dotId: "dot:1", dotName: "Ada", roomId: "room:aaaa0001" } as never)).resolves.toBe("pane:created01");
    expect(on.saved).toEqual([["user:owner01:yt", "pane:created01", privatePaneProfileId]]);
    expect(on.published).toEqual([{ type: "PANE_CREATED", paneId: "pane:created01" }]);
    await captured.computer!.closePane("pane:created01" as never);
    expect(on.updates).toEqual([["pane:created01", { isClosed: true, status: "CLOSED" }, expect.any(String)]]);

    await expect(captured.computer!.openBrowser("pane:browser01" as never, "https://a.example/" as never, { agentSessionId: "s:1", roomId: "room:elsewhere" } as never))
      .rejects.toThrow("The Dot's browser is no longer in this room.");
    await expect(captured.computer!.openBrowser("pane:browser01" as never, "https://a.example/" as never, { agentSessionId: "s:1", roomId: "room:aaaa0001" } as never))
      .resolves.toMatchObject({ sessionId: "bs:new", active: true });
    expect(on.browser.startOrRestore).toHaveBeenCalledWith(expect.objectContaining({ targetUrl: "https://a.example/" }), { holderType: "AGENT", holderId: "s:1" });

    const live = wire({ browserSession: { sessionId: "bs:old", currentUrl: "https://b.example/", title: null } });
    const opened = await captured.computer!.openBrowser("pane:browser01" as never, "https://b.example/" as never, { agentSessionId: "s:1", roomId: "room:aaaa0001" } as never) as { title: string };
    expect(live.browser.navigate).toHaveBeenCalled();
    expect(opened.title.length).toBeLessThanOrEqual(500);
    await expect(captured.computer!.openBrowser("pane:browser01" as never, null as never, { agentSessionId: "s:1", roomId: "room:aaaa0001" } as never)).resolves.toMatchObject({ sessionId: "bs:old" });
    expect(live.browser.getActive).toHaveBeenCalled();
  });

  it("records audits without a request and never fails on a lost audit row", async () => {
    const on = wire();
    await captured.computer!.audit(null as never, "dot.computer.x" as never, "room:aaaa0001" as never, {} as never);
    await captured.deliverables!.audit(null as never, "dot.deliverable.x" as never, { dotId: "dot:1" } as never);
    await (captured.connector!.audit as (...args: unknown[]) => Promise<void>)(null, "connector.x", { accountId: "acct:1" });
    expect(on.audits).toEqual([
      expect.objectContaining({ actorUserId: null, action: "dot.computer.x", targetType: "room", targetId: "room:aaaa0001" }),
      expect.objectContaining({ action: "dot.deliverable.x", targetType: "dot", targetId: "dot:1" }),
      expect.objectContaining({ action: "connector.x", targetType: "connector", targetId: "acct:1" })
    ]);
    wire({ auditFails: true });
    await expect(captured.computer!.audit(null as never, "x" as never, "room:aaaa0001" as never, {} as never)).resolves.toBeUndefined();
    await expect(captured.deliverables!.audit(null as never, "x" as never, {} as never)).resolves.toBeUndefined();
  });

  it("publishes a deliverable as an Agent File in the Dot's folder and announces it", async () => {
    const on = wire();
    await expect(captured.deliverables!.publishArtifact({ roomId: "room:aaaa0001", dotName: "Ada", filename: "report.md", mimeType: "text/markdown", buffer: Buffer.from("x") } as never))
      .resolves.toEqual({ id: "artifact:1" });
    expect(captured.persisted).toEqual([expect.objectContaining({ roomId: "room:aaaa0001", runtimeId: "dot", originalFilename: "report.md", folder: "Dots/Ada" })]);
    expect(on.published).toEqual([{ type: "ARTIFACT_CREATED" }]);
  });

  it("delegations refuse another Dot's conversation and close their panes", async () => {
    const on = wire();
    await expect(captured.delegation!.startSession({ pane: browserPane, owner: "user:owner01", dotId: "dot:mine" } as never)).rejects.toThrow("The delegate's conversation could not start.");
    await captured.delegation!.closePane("pane:browser01" as never);
    expect(on.updates).toEqual([["pane:browser01", { isClosed: true, status: "CLOSED" }, expect.any(String)]]);
  });
});
