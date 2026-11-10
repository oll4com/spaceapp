import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], deps: {} as Record<string, unknown[]>, demoCreated: [] as unknown[] };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.deps[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/default-app-services.js", async (orig) => ({ ...await orig<object>(),
  createDemoProjectsService: (input: unknown) => { captured.demoCreated.push(input); return { demo: true }; } }));
vi.mock("../src/demo-projects/routes.js", async (orig) => ({ ...await orig<object>(), registerDemoProjectsRoutes: rec("demo") }));
vi.mock("../src/t3code/bindings.js", async (orig) => ({ ...await orig<object>(), registerT3Bindings: rec("t3Bindings", { openForDocument: "open-for-document" }) }));
vi.mock("../src/t3code/gateway.js", async (orig) => ({ ...await orig<object>(), registerT3Gateway: rec("t3Gateway") }));
vi.mock("../src/t3code/static-assets.js", async (orig) => ({ ...await orig<object>(), registerT3StaticAssets: rec("t3Static") }));
vi.mock("../src/t3code/legacy.js", async (orig) => ({ ...await orig<object>(), registerT3LegacyRetirement: rec("t3Legacy") }));
vi.mock("../src/t3code/service-control.js", async (orig) => ({ ...await orig<object>(), registerT3CodeAdminRoutes: rec("t3Admin") }));
vi.mock("../src/benchmark-routes.js", async (orig) => ({ ...await orig<object>(), registerBenchmarkRoutes: rec("benchmark") }));
vi.mock("../src/chess/chess-routes.js", async (orig) => ({ ...await orig<object>(), registerChessBenchmarkRoutes: rec("chess") }));
vi.mock("../src/chess/chess-cli.js", async (orig) => ({ ...await orig<object>(), createWorkerCliMoveRunner: () => "worker-move-runner" }));
vi.mock("../src/chess/chess-players.js", async (orig) => ({ ...await orig<object>(), pickClaudeProfile: (data: unknown) => ({ picked: data }) }));
vi.mock("../src/asteroids-director.js", async (orig) => ({ ...await orig<object>(), registerAsteroidsDirectorRoutes: rec("asteroids") }));
vi.mock("../src/dots-routes.js", async (orig) => ({ ...await orig<object>(), registerDotsRoutes: rec("dots") }));
vi.mock("../src/dot-home.js", async (orig) => ({ ...await orig<object>(), registerDotHomeRoutes: rec("dotHome") }));
vi.mock("../src/plugins-routes.js", async (orig) => ({ ...await orig<object>(), registerPluginRoutes: rec("plugins") }));
vi.mock("../src/source-control/routes.js", async (orig) => ({ ...await orig<object>(), registerSourceControlRoutes: rec("sourceControl") }));
vi.mock("../src/worktrees/worktree-routes.js", async (orig) => ({ ...await orig<object>(), registerWorktreeRoutes: rec("worktrees") }));
vi.mock("../src/harness-proxy.js", async (orig) => ({ ...await orig<object>(), registerHarnessRoutes: rec("harness") }));
vi.mock("../src/files-routes.js", async (orig) => ({ ...await orig<object>(), registerFilesRoutes: rec("files") }));
vi.mock("../src/databases/databases-routes.js", async (orig) => ({ ...await orig<object>(), registerDatabasesRoutes: rec("databases") }));
vi.mock("../src/app-diagnostics-routes.js", async (orig) => ({ ...await orig<object>(), registerAppDiagnosticsCaptureRoutes: rec("diagnostics") }));

const { registerWorkspaceRoutes } = await import("../src/workspace-routes-wiring.js");

const secret = "s".repeat(32);
const owner = { id: "user:owner01", email: "owner@space.local", role: "ADMIN" as const };
afterEach(() => { Object.assign(captured, { order: [], deps: {}, demoCreated: [] }); });

type Hook = () => Promise<void> | void;
async function wire(input: { games?: boolean; dots?: boolean; config?: Record<string, unknown>; registry?: unknown[]; state?: { enabled: boolean; reason?: string } } = {}) {
  const hooks: Hook[] = [];
  const audits: unknown[] = [];
  const disposed: string[] = [];
  const app = { log: { info: () => {} }, addHook: (_name: string, hook: Hook) => { hooks.push(hook); } };
  const repo = (name: string) => input.dots === false ? null : { dispose: () => { disposed.push(name); } };
  const deps = {
    store: { upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` }), recordAuditEvent: async (event: unknown) => { audits.push(event); } },
    config: { port: 4940, t3CodeEnabled: true, t3CodeSocketPath: "/run/t3.sock", t3CodeHealthTimeoutMs: 1000, t3CodeProxyTimeoutMs: 2000,
      demoProjectsEnabled: true, demoProjectsPublicOrigin: undefined, browserEvidenceTargetOrigin: "https://space.local:4940",
      optionalModules: new Set(input.games === false ? [] : ["games"]), filesHostModeEnabled: false, ...input.config },
    auth: { sessionSecret: secret },
    options: { t3CodeServiceController: { controller: true }, resumeChessTournament: true },
    appDiagnosticsService: { diagnostics: true },
    claudeUsageProvider: async () => ({ data: ["usage-row"] }),
    cliChatRuntimeState: async () => input.state ?? { enabled: true },
    cliModelsExecutor: (runtimeId: string) => () => ({ runtimeId }),
    cliRuntimeRegistryCache: { read: async () => ({ data: input.registry ?? [] }) },
    codexGoals: { list: async () => [{ threadId: "thread-0001", goalId: "goal-0001", title: "Ship it", status: "active", tokenBudget: null,
      tokensUsed: 5, timeUsedSeconds: 7, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:01:00.000Z" }] },
    dotsRepository: repo("dots"), dotMemoryRepository: repo("memory"), dotHomeRepository: repo("home"),
    spaceAgentAdapter: { listModelChoices: () => ["choice"] },
    sourceControlService: { close: async () => { disposed.push("sourceControl"); } }, worktreeService: { worktrees: true },
    publicBrowserOrigins: ["https://space.local:4940"], defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }
  };
  const result = await registerWorkspaceRoutes(app as never, deps as never);
  return { result, hooks, audits, disposed, deps };
}
const arg = (name: string, index = 1) => captured.deps[name]![index] as Record<string, never>;
const request = (user: unknown, cookie?: string) => ({ user, cookies: cookie ? { [cookieName]: cookie } : {} }) as never;

describe("workspace routes wiring (ARCH-001 step 76)", () => {
  it("registers the workspace routes in app.ts's order and returns the demo projects service", async () => {
    const { result } = await wire();
    expect(captured.order).toEqual(["demo", "t3Bindings", "t3Gateway", "t3Static", "t3Legacy", "t3Admin", "benchmark", "chess", "asteroids",
      "dots", "dotHome", "plugins", "sourceControl", "worktrees", "harness", "files", "databases", "diagnostics"]);
    expect(result).toEqual({ demoProjectsService: { demo: true } });
    expect(arg("demo").service).toEqual({ demo: true });
    expect(arg("t3Gateway").documentBootstrap).toBe("open-for-document");
    expect(arg("t3Bindings").publicOrigins).toEqual(["https://space.local:4940"]);
    expect(arg("t3Admin").controller).toEqual({ controller: true });
    expect(arg("diagnostics").appDiagnosticsService).toEqual({ diagnostics: true });
  });

  it("registers the games only with the games module", async () => {
    await wire({ games: false });
    expect(captured.order).not.toContain("benchmark");
    expect(captured.order).not.toContain("chess");
    expect(captured.order).not.toContain("asteroids");
  });

  it("resolves the demo projects' public origin: configured, forwarded, host, then loopback", async () => {
    await wire();
    const resolve = arg("demo").resolvePublicOrigin as unknown as (request: unknown) => string;
    expect(resolve({ headers: { "x-forwarded-proto": "https, http", "x-forwarded-host": ["demo.example, other"] } })).toBe("https://demo.example");
    expect(resolve({ headers: { host: "space.local:4940" } })).toBe("https://space.local:4940");
    expect(resolve({ headers: {} })).toBe("http://127.0.0.1:4940");
    captured.order = [];
    await wire({ config: { demoProjectsPublicOrigin: "https://demos.example" } });
    expect((arg("demo").resolvePublicOrigin as unknown as (request: unknown) => string)({ headers: { host: "x" } })).toBe("https://demos.example");
  });

  it("chess players must be signed in and Claude picks the account with quota", async () => {
    await wire({ registry: [{ id: "cli:kimi", authState: "MISSING", authReason: "Sign in to Kimi." }, { id: "cli:codex", authState: "READY" }] });
    const chess = arg("chess", 2) as unknown as { runCliMove: string; autoResume: boolean; claudeProfile: () => Promise<unknown>;
      cli: { state: (id: string) => Promise<unknown>; listModels: (id: string) => unknown } };
    expect(chess.runCliMove).toBe("worker-move-runner");
    expect(chess.autoResume).toBe(true);
    expect(await chess.cli.state("cli:codex")).toEqual({ enabled: true });
    expect(await chess.cli.state("cli:kimi")).toEqual({ enabled: false, reason: "Sign in to Kimi." });
    expect(await chess.cli.state("cli:none")).toEqual({ enabled: false, reason: "Sign-in required." });
    expect(chess.cli.listModels("cli:codex")).toEqual({ runtimeId: "cli:codex" });
    expect(await chess.claudeProfile()).toEqual({ picked: ["usage-row"] });
    expect(await (arg("benchmark", 2) as unknown as { claudeProfile: () => Promise<unknown> }).claudeProfile()).toEqual({ picked: ["usage-row"] });
    captured.order = [];
    await wire({ state: { enabled: false, reason: "Disabled." } });
    expect(await (arg("chess", 2) as unknown as { cli: { state: (id: string) => Promise<unknown> } }).cli.state("cli:codex")).toEqual({ enabled: false, reason: "Disabled." });
  });

  it("Dots, Dot Home and source control need a signed session and use the stored owner id", async () => {
    await wire();
    const cookie = signSession(owner, secret);
    for (const name of ["dots", "dotHome"]) {
      const authenticatedOwner = arg(name).authenticatedOwner as unknown as (request: unknown) => Promise<string>;
      await expect(authenticatedOwner(request(owner, cookie))).resolves.toBe("user:owner01:stored");
      await expect(authenticatedOwner(request(owner))).rejects.toMatchObject({ code: "UNAUTHENTICATED", statusCode: 401 });
      await expect(authenticatedOwner(request(undefined, cookie))).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    }
    const gitOwner = arg("sourceControl").authenticatedOwner as unknown as (request: unknown) => Promise<string>;
    await expect(gitOwner(request(owner, cookie))).resolves.toBe("user:owner01:stored");
    await expect(gitOwner(request(owner, "forged"))).rejects.toThrow("Sign in to use personal Source Control.");
    expect((arg("plugins", 2) as unknown as { owner: unknown }).owner).toBe(gitOwner);
    expect(arg("dots").dedicatedResources).toEqual(["goals", "schedules"]);
    expect((arg("dotHome").modelChoices as unknown as () => unknown)()).toEqual(["choice"]);
    const goals = await (arg("dots").nativeGoals as unknown as () => Promise<Array<Record<string, unknown>>>)();
    expect(goals[0]).toMatchObject({ threadId: "thread-0001", goalId: "goal-0001", objective: "Ship it", tokensUsed: 5 });
  });

  it("closes the Dot repositories that exist and the source control service", async () => {
    const wired = await wire();
    for (const hook of wired.hooks) await hook();
    expect(wired.disposed).toEqual(["dots", "memory", "home", "sourceControl"]);
    const without = await wire({ dots: false });
    for (const hook of without.hooks) await hook();
    expect(without.hooks).toHaveLength(1);
    expect(without.disposed).toEqual(["sourceControl"]);
  });

  it("only ADMIN and OPERATOR may run destructive worktree actions", async () => {
    await wire();
    const authorize = arg("worktrees").authorizeDestructive as unknown as (request: unknown) => boolean;
    expect(authorize({ user: { role: "ADMIN" } })).toBe(true);
    expect(authorize({ user: { role: "OPERATOR" } })).toBe(true);
    expect(authorize({ user: { role: "USER" } })).toBe(false);
    expect(authorize({})).toBe(false);
  });

  it("the Harness upgrade takes a same-site ADMIN or OPERATOR session, never an admin action's", async () => {
    await wire();
    const authorize = (arg("harness", 3) as unknown as { authorizeUpgrade: (request: unknown) => boolean }).authorizeUpgrade;
    const upgrade = (user: typeof owner & Record<string, unknown>, headers: Record<string, string> = {}) =>
      authorize({ headers: { cookie: `${cookieName}=${encodeURIComponent(signSession(user, secret))}`, ...headers } });
    expect(upgrade(owner)).toBe(true);
    expect(upgrade({ ...owner, role: "OPERATOR" as never })).toBe(true);
    expect(upgrade({ ...owner, role: "USER" as never })).toBe(false);
    expect(upgrade(owner, { "sec-fetch-site": "cross-site" })).toBe(false);
    expect(upgrade({ ...owner, brokerScope: "UI_PROOF" })).toBe(true);
    expect(upgrade({ ...owner, brokerScope: "ADMIN_ACTION:rooms-list" })).toBe(false);
    expect(authorize({ headers: {} })).toBe(false);
  });

  it("audits T3 Code admin actions against the managed service", async () => {
    const { audits } = await wire();
    const audit = arg("t3Admin").audit as unknown as (request: unknown, action: string, metadata: unknown) => Promise<void>;
    await audit({ user: owner, requestIdForSpace: "req:000001" }, "t3code.restart", { reason: "test" });
    expect(audits).toEqual([expect.objectContaining({ actorUserId: "user:owner01:stored", action: "t3code.restart",
      targetType: "managed_service", targetId: "space-t3code.service", metadata: { reason: "test" } })]);
  });
});
