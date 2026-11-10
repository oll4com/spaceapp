import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";
import { googleBrowserProfilePathFor } from "../src/browser-sessions.js";
import { cliHostSocketTmpdir } from "./support/cli-runtimes-harness.js";

type Fn = (...args: never[]) => unknown;
const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], deps: {} as Record<string, Record<string, unknown>>, gatewayCreated: [] as unknown[], checks: [] as string[] };
  const rec = (name: string, result?: unknown) => (_app: unknown, deps: Record<string, unknown>) => { captured.order.push(name); captured.deps[name] = deps; return result; };
  return { captured, rec };
});
vi.mock("../src/auth-routes.js", async (orig) => ({ ...await orig<object>(), registerAuthRoutes: rec("auth") }));
vi.mock("../src/app-signin.js", async (orig) => ({ ...await orig<object>(), registerAppSignIn: rec("appSignIn", { appSignIn: true }) }));
vi.mock("../src/admin-user-routes.js", async (orig) => ({ ...await orig<object>(), registerAdminUserRoutes: rec("adminUsers") }));
vi.mock("../src/gateway/gateway-routes.js", async (orig) => ({ ...await orig<object>(), registerGatewayAdminRoutes: rec("gatewayAdmin") }));
vi.mock("../src/gateway/gateway-service.js", async (orig) => ({ ...await orig<object>(), createGatewayAdminService: (input: unknown) => { captured.gatewayCreated.push(input); return { created: true }; } }));
vi.mock("../src/clipboard-routes.js", async (orig) => ({ ...await orig<object>(), registerClipboardRoutes: rec("clipboard") }));
vi.mock("../src/client-error-routes.js", async (orig) => ({ ...await orig<object>(), registerClientErrorRoutes: rec("clientErrors") }));
vi.mock("../src/install-telemetry-routes.js", async (orig) => ({ ...await orig<object>(), registerInstallTelemetryRoutes: rec("installTelemetry"), registerFirstAnswerWatch: rec("firstAnswer") }));
vi.mock("../src/trace-routes.js", async (orig) => ({ ...await orig<object>(), registerTraceRoutes: rec("trace") }));
vi.mock("../src/shared-chat-routes.js", async (orig) => ({ ...await orig<object>(), registerSharedChatRoutes: rec("sharedChat") }));
vi.mock("../src/task-item-routes.js", async (orig) => ({ ...await orig<object>(), registerTaskItemRoutes: rec("taskItems") }));
vi.mock("../src/link-inspect-routes.js", async (orig) => ({ ...await orig<object>(), registerLinkInspectRoutes: rec("linkInspect") }));
vi.mock("../src/user-link-routes.js", async (orig) => ({ ...await orig<object>(), registerUserLinkRoutes: rec("userLinks") }));
vi.mock("../src/agent-session-routes.js", async (orig) => ({ ...await orig<object>(), registerAgentSessionHistoryRoutes: rec("sessionHistory"), registerAgentSessionThreadRoutes: rec("sessionThreads") }));
vi.mock("../src/system-services-routes.js", async (orig) => ({ ...await orig<object>(), registerSystemServicesRoutes: rec("systemServices") }));
vi.mock("../src/codex-environment-stats.js", async (orig) => ({ ...await orig<object>(), createCodexEnvironmentStats: (_app: unknown, deps: Record<string, unknown>) => {
  captured.order.push("environmentStats"); captured.deps.environmentStats = deps;
  return { readCodexEnvironmentSpaceStats: "space-stats", readCodexEnvironmentHostStats: "host-stats" };
} }));
vi.mock("../src/google-browser-session-check.js", async (orig) => ({ ...await orig<object>(),
  readGoogleBrowserCheck: async (path: string) => { captured.checks.push(path); return { checked: path }; },
  summarizeGoogleBrowserStatus: (input: unknown) => input }));

const { registerSignInRoutes, registerUserToolRoutes } = await import("../src/user-routes-wiring.js");

const secret = "s".repeat(32);
const owner = { id: "user:owner01", email: "owner@space.local", role: "ADMIN" as const };
afterEach(() => { vi.unstubAllEnvs(); Object.assign(captured, { order: [], deps: {}, gatewayCreated: [], checks: [] }); });

function signIn(input: { profileRoot?: string; active?: unknown[]; auth?: Record<string, unknown>; multiUser?: unknown; decisions?: unknown[] } = {}) {
  const listed: number[] = [];
  const revoked: unknown[] = [];
  const forgotten: string[] = [];
  const store = {
    listActivePaneBrowserSessions: async () => { listed.push(1); return input.active ?? []; },
    upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` })
  };
  const deps = {
    store, config: { port: 4911, browserSessionsProfileRoot: input.profileRoot ?? "/missing", multiUserEnabled: input.multiUser, databaseUrl: "postgres://x" },
    auth: { sessionSecret: secret, secureCookies: true, googleRedirectUri: "", ...input.auth }, browserSessionManager: { browser: true },
    persistRevocation: (pending: Promise<void>) => pending.then(() => { revoked.push("persisted"); }),
    userRoleCache: { roles: true }, nousRef: { current: { service: { decisions: async () => input.decisions ?? [] } } },
    connectorCrypto: { crypto: true }, eventBus: { bus: true }, notificationService: { notifications: true },
    sessionAccess: { forget: (id: string) => { forgotten.push(id); } }, defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }
  };
  const result = registerSignInRoutes({} as never, deps as never);
  return { result, listed, revoked, forgotten, deps };
}

function request(input: { cookie?: string; user?: unknown; headers?: Record<string, string | string[]> } = {}) {
  return { user: input.user, cookies: input.cookie === undefined ? {} : { [cookieName]: input.cookie }, headers: input.headers ?? {} } as never;
}

describe("sign-in routes wiring", () => {
  it("reads each Google account's browser profile, check and active pages, and lists sessions only when there are accounts", async () => {
    const root = await mkdtemp(join(cliHostSocketTmpdir, "space-user-routes-"));
    try {
      const withProfile = { id: "google_account:withprof", ownerUserId: owner.id };
      const without = { id: "google_account:noprofil", ownerUserId: owner.id };
      await mkdir(googleBrowserProfilePathFor(root, owner.id, withProfile.id), { recursive: true });
      const active = [{ profileId: `google-account:${withProfile.id}`, currentUrl: "https://mail.google.com/" }, { profileId: "google-account:other", currentUrl: "https://x.test/" }];
      const { result, listed } = signIn({ profileRoot: root, active });
      expect(await result.googleAccountBrowserStatuses([])).toEqual(new Map());
      expect(listed).toHaveLength(0);
      const statuses = await result.googleAccountBrowserStatuses([withProfile, without] as never);
      expect(statuses.get(withProfile.id)).toEqual({ profileExists: true, check: { checked: googleBrowserProfilePathFor(root, owner.id, withProfile.id) }, activeUrls: ["https://mail.google.com/"] });
      expect(statuses.get(without.id)).toEqual({ profileExists: false, check: null, activeUrls: [] });
      expect(captured.checks).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("lets only a signed-in session use Dots and answers its stored owner", async () => {
    const { result } = signIn();
    await expect(result.dotsAuthenticatedOwner(request())).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });
    await expect(result.dotsAuthenticatedOwner(request({ user: owner, cookie: "forged" }))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(result.dotsAuthenticatedOwner(request({ user: owner, cookie: signSession(owner, secret) }))).resolves.toBe(`${owner.id}:stored`);
  });

  it("signs OAuth states, hashes the session cookie and builds each provider's redirect from the forwarded host", () => {
    const { result } = signIn();
    const tools = result.connectorStateTools;
    expect(tools.verify(tools.sign("state-1"))).toBe("state-1");
    expect(tools.verify("tampered")).toBeNull();
    expect(tools.sessionHash(request({ cookie: "abc" }))).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(tools.secureCookies).toBe(true);
    const forwarded = request({ headers: { "x-forwarded-proto": "http, https", "x-forwarded-host": ["space.example:4940", "inner"] } });
    expect(tools.redirectUri(forwarded, "GOOGLE")).toBe("http://space.example:4940/api/auth/google/callback");
    expect(tools.redirectUri(request({ headers: { host: "h.test" } }), "MICROSOFT")).toBe("https://h.test/api/connectors/microsoft/callback");
    expect(tools.redirectUri(request(), "GOOGLE")).toBe("https://127.0.0.1:4911/api/auth/google/callback");
    vi.stubEnv("SPACE_MICROSOFT_REDIRECT_URI", "https://fixed.test/ms");
    expect(tools.redirectUri(request(), "MICROSOFT")).toBe("https://fixed.test/ms");
    const configured = signIn({ auth: { googleRedirectUri: "https://fixed.test/google", secureCookies: false } }).result.connectorStateTools;
    expect(configured.redirectUri(request(), "GOOGLE")).toBe("https://fixed.test/google");
    expect(configured.redirectUri(request(), "MICROSOFT")).toBe("https://fixed.test/ms");
  });

  it("registers auth with the app sign-in, finds a Nous decision by id and needs a PostgreSQL store for the device store", async () => {
    const { result, deps } = signIn({ decisions: [{ id: "d1", title: "one" }, { id: "d2" }] });
    expect(captured.order).toEqual(["appSignIn", "auth", "adminUsers"]);
    expect(captured.deps.auth).toMatchObject({ appSignIn: { appSignIn: true }, googleAccountBrowserStatuses: result.googleAccountBrowserStatuses,
      connectorStateTools: result.connectorStateTools, connectorServiceRef: { current: null }, browserSessionManager: deps.browserSessionManager });
    const appSignIn = captured.deps.appSignIn!;
    expect(appSignIn).toMatchObject({ crypto: deps.connectorCrypto, events: deps.eventBus, notifications: deps.notificationService, sessionSecret: secret, databaseUrl: null });
    const decision = appSignIn.decision as (owner: string, id: string) => Promise<unknown>;
    await expect(decision(owner.id, "d1")).resolves.toEqual({ id: "d1", title: "one" });
    await expect(decision(owner.id, "nope")).resolves.toBeNull();
  });

  it("turns multi-user on only when the config says true, and revokes a user's sessions before forgetting them", async () => {
    const off = signIn({ multiUser: "yes" });
    expect(captured.deps.adminUsers?.multiUserEnabled).toBe(false);
    await (captured.deps.adminUsers?.revokeUserSessions as (id: string) => Promise<void>)("user:revoked1");
    expect(off.revoked).toEqual(["persisted"]);
    expect(off.forgotten).toEqual(["user:revoked1"]);
    signIn({ multiUser: true });
    expect(captured.deps.adminUsers?.multiUserEnabled).toBe(true);
  });
});

function userTools(input: { gatewayAdminService?: unknown; taskSchedules?: boolean } = {}) {
  const executed: unknown[] = [];
  const commands: unknown[] = [];
  const notices: unknown[] = [];
  const deps = {
    store: { listRooms: async () => ["room:aaaa0001"] }, options: { gatewayAdminService: input.gatewayAdminService },
    config: { gatewayUrl: "http://gw", gatewayAdminToken: "", internalApiToken: "internal", instanceJobs: { "task-schedules": input.taskSchedules === true } },
    auth: { sessionSecret: secret }, nousRef: { current: { service: { notice: async (...args: unknown[]) => { notices.push(args); } } } },
    cliTerminalManager: { terminal: true }, cliRuntimeVisibility: { visibility: true }, codexParity: { parity: true }, unifiedCliTaskRegistry: { registry: true },
    agentSessionHistoryService: { history: true }, visibleCliRuntimeIds: async () => ["cli:codex"], hostStatsProvider: { host: true }, systemServicesProvider: { services: true },
    installTelemetry: { active: { observe: vi.fn() }, firstAnswer: { reporter: true } }, readDashboardAgents: async () => ({ agents: [] }),
    gatewayRepositoryFor: () => ({ repository: true }), roomPaneController: { inspect: async (pane: unknown, options: unknown) => ({ pane, options }) },
    commandRoomCli: async (...args: unknown[]) => { commands.push(args); return { ok: true }; },
    spaceControl: { execute: async (...args: unknown[]) => { executed.push(args); return { executed: true }; } },
    controlUser: async (id: string) => ({ id, role: "ADMIN" }),
    defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }, defaultWebsocketRateLimitOptions: { config: { rateLimit: 2 } }
  };
  const result = registerUserToolRoutes({} as never, deps as never);
  return { result, deps, executed, commands, notices };
}

describe("user tool routes wiring", () => {
  it("registers every route group in app.ts's order with the environment stats the thread routes read", () => {
    userTools();
    expect(captured.order).toEqual(["gatewayAdmin", "clipboard", "clientErrors", "installTelemetry", "firstAnswer", "trace", "sharedChat", "taskItems", "linkInspect",
      "userLinks", "sessionHistory", "systemServices", "environmentStats", "sessionThreads"]);
    expect(captured.deps.sessionThreads).toMatchObject({ readCodexEnvironmentSpaceStats: "space-stats", readCodexEnvironmentHostStats: "host-stats" });
    expect(captured.deps.sharedChat).toMatchObject({ websocketRouteOptions: { config: { rateLimit: 2 } } });
  });

  it("uses the given gateway admin service, else makes one on the shared repository with the admin token or the internal one", () => {
    const given = { given: true };
    expect(userTools({ gatewayAdminService: given }).result.gatewayAdminService).toBe(given);
    expect(captured.gatewayCreated).toHaveLength(0);
    expect(captured.deps.gatewayAdmin?.service).toBe(given);
    const made = userTools().result.gatewayAdminService;
    expect(made).toEqual({ created: true });
    expect(captured.gatewayCreated).toEqual([{ repository: { repository: true }, gatewayUrl: "http://gw", internalToken: "internal" }]);
  });

  it("reopens a closed terminal and starts any other closed pane through Space Control as its owner", async () => {
    const { result, executed } = userTools();
    await result.reopenClosedPane({ id: "pane:term0001", roomId: "room:aaaa0001", mode: "TERMINAL" } as never, "user:owner01");
    await result.reopenClosedPane({ id: "pane:mail0001", roomId: "room:aaaa0001", mode: "MAIL_COPILOT" } as never, "user:owner01");
    expect(executed.map(([actor, batch]) => [(actor as { id: string }).id, (batch as { actions: Array<{ operation: string; target: unknown }> }).actions[0]])).toEqual([
      ["user:owner01", expect.objectContaining({ kind: "pane", operation: "reopen", target: { paneIds: ["pane:term0001"], state: "ALL" }, when: "NOW" })],
      ["user:owner01", expect.objectContaining({ kind: "pane", operation: "start", target: { paneIds: ["pane:mail0001"], state: "ALL" } })]
    ]);
  });

  it("runs task schedules only with their instance job, typing answers now and telling Nous", async () => {
    userTools();
    expect(captured.deps.taskItems?.schedules).toBeNull();
    const { result, commands, notices } = userTools({ taskSchedules: true });
    const schedules = captured.deps.taskItems?.schedules as Record<string, Fn>;
    expect(schedules.reopen).toBe(result.reopenClosedPane);
    const pane = { id: "pane:term0001" };
    await expect((schedules.inspect as (pane: unknown) => Promise<unknown>)(pane)).resolves.toEqual({ pane, options: { fresh: true } });
    await (schedules.answer as (pane: unknown, input: unknown) => Promise<unknown>)(pane, { answer: "go", submit: true });
    expect(commands[0]?.[1]).toEqual({ type: "cli_command", paneId: "pane:term0001", answer: "go", submit: true, when: "NOW" });
    await (schedules.notice as (owner: string, key: string, line: string) => Promise<void>)("user:owner01", "task:k", "line");
    expect(notices).toEqual([["user:owner01", "task:k", "line"]]);
    // Briefs go to the copilot services app.ts sets once they exist; before that a brief fails instead of being lost.
    const brief = schedules.brief as (pane: unknown, owner: string, text: string) => Promise<unknown>;
    await expect(brief(pane, "user:owner01", "Post the weekly update.")).rejects.toThrow(/not available/);
    result.taskBrief.current = async (...args: unknown[]) => args as never;
    await expect(brief(pane, "user:owner01", "Post the weekly update.")).resolves.toEqual([pane, "user:owner01", "Post the weekly update."]);
  });

  it("feeds install telemetry's active marker and the first-answer watch from the room store", async () => {
    const { deps } = userTools();
    (captured.deps.installTelemetry?.onActive as (fields: unknown) => void)({ v: 1 });
    expect(deps.installTelemetry.active.observe).toHaveBeenCalledWith({ v: 1 });
    await expect((captured.deps.firstAnswer?.rooms as () => Promise<unknown>)()).resolves.toEqual(["room:aaaa0001"]);
    expect(captured.deps.firstAnswer).toMatchObject({ reporter: { reporter: true }, readRoom: deps.readDashboardAgents });
  });
});
