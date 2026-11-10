import { afterEach, describe, expect, it, vi } from "vitest";
import { cookieName, signSession } from "../src/auth.js";

type Fn = (...args: never[]) => Promise<unknown>;
const captured = vi.hoisted(() => ({
  channel: undefined as Record<string, unknown> | undefined,
  channelRoutes: [] as { service: unknown; options: Record<string, unknown> }[],
  computerRoutes: [] as { service: unknown; options: { authenticatedOwner(request: unknown): Promise<string> } }[],
  proactive: undefined as Record<string, unknown> | undefined,
  decider: undefined as Record<string, unknown> | undefined,
  liveEvals: [] as Record<string, unknown>[]
}));
vi.mock("../src/dot-channels.js", () => ({
  createDotChannelService: (deps: Record<string, unknown>) => { captured.channel = deps; return { kind: "channels", sweep: vi.fn(async () => undefined), notifyOwner: vi.fn() }; },
  registerDotChannelRoutes: (_app: unknown, service: unknown, options: Record<string, unknown>) => { captured.channelRoutes.push({ service, options }); }
}));
vi.mock("../src/dot-computer.js", () => ({ registerDotComputerRoutes: (_app: unknown, service: unknown, options: never) => { captured.computerRoutes.push({ service, options }); } }));
vi.mock("../src/dot-live-evals-wiring.js", () => ({ registerDotLiveAndEvals: (_app: unknown, deps: Record<string, unknown>) => { captured.liveEvals.push(deps); return { dotEvalsRepository: { kind: "evals" } }; } }));
vi.mock("../src/dot-proactive.js", () => ({
  createDotProactiveService: (deps: Record<string, unknown>) => { captured.proactive = deps; return { tick: vi.fn(async () => { throw new Error("mail down"); }) }; },
  createProactiveDecider: (deps: Record<string, unknown>) => { captured.decider = deps; return vi.fn(); }
}));

const { registerDotChannelsAndProactive } = await import("../src/dot-channels-proactive-wiring.js");

const SECRET = "s".repeat(32);
afterEach(() => {
  vi.unstubAllEnvs(); vi.useRealTimers();
  captured.channel = undefined; captured.channelRoutes = []; captured.computerRoutes = []; captured.proactive = undefined; captured.decider = undefined; captured.liveEvals = [];
});

function wire(input: { full?: boolean; modules?: string[]; turns?: boolean; job?: boolean; options?: Record<string, unknown>; googleRedirectUri?: string } = {}) {
  const hooks: { name: string; fn: () => Promise<unknown> | unknown }[] = [];
  const warns: unknown[][] = [];
  const app = { addHook: (name: string, fn: () => unknown) => { hooks.push({ name, fn }); }, log: { warn: (...args: unknown[]) => { warns.push(args); } } };
  const full = input.full ?? true;
  const dotGoalService = { steer: vi.fn(async () => undefined), control: vi.fn(async () => undefined), reconcile: vi.fn(async () => 2) };
  const dotScheduleService = { tick: vi.fn(async () => undefined) };
  const dotDelegationService = { reportOutcomes: vi.fn(async () => { throw new Error("busy"); }) };
  const result = registerDotChannelsAndProactive(app as never, {
    store: {
      listRooms: async () => [
        { id: "room:b", kind: "WORKSPACE", ownerUserId: "user:1", order: 2 }, { id: "room:a", kind: "WORKSPACE", ownerUserId: "user:1", order: 1 },
        { id: "room:p", kind: "AGENT_PROOF", ownerUserId: "user:1", order: 0 }, { id: "room:s", kind: "WORKSPACE", ownerUserId: "user:2", order: 0 }
      ],
      getUserSettings: async () => ({ dateTime: { timeZone: "Asia/Bangkok" } }),
      upsertUser: async (user: { id: string }) => ({ id: `${user.id}:stored` })
    } as never,
    config: { databaseUrl: "postgres://x", browserEvidenceArtifactRoot: "/tmp/x", optionalModules: new Set(input.modules ?? ["channels"]) as never, modelPriceCatalogPath: undefined,
      codexLbBaseUrl: "http://127.0.0.1:1", codexLbKeyFile: "/nonexistent/key", enableCodexTurns: input.turns ?? true, instanceJobs: { "dot-schedules": input.job ?? true } as never } as never,
    options: input.options ?? { channelsRepository: { kind: "injected", dispose: vi.fn() } },
    auth: { sessionSecret: SECRET, googleRedirectUri: input.googleRedirectUri },
    eventBus: { publish: vi.fn() },
    defaultRouteRateLimitOptions: {},
    dotsAuthenticatedOwner: async () => "user:1",
    dotsRepository: full ? {
      listPendingApprovals: async () => [{ invocationId: "inv:1", toolId: "mail.send", approvalSummary: null }, { invocationId: "inv:2", toolId: "x", approvalSummary: "Pay it" }]
    } as never : null,
    dotGoalsRepository: full ? { list: async () => [
      { goalId: "goal:old", status: "DONE", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" },
      { goalId: "goal:new", status: "RUNNING", statusReason: undefined, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" }
    ] } as never : null,
    dotHomeRepository: full ? { addProactiveUsage: vi.fn() } as never : null,
    dotGoalService: full ? dotGoalService as never : null,
    dotDelegationService: full ? dotDelegationService as never : null,
    dotScheduleService: full ? dotScheduleService as never : null,
    connectorService: full ? { status: async () => ({ accounts: ["a"] }), tool: vi.fn() } as never : null,
    dotComputerService: null,
    cliRuntimeVisibility: { assertEnabled: async () => undefined },
    roomPaneCommands: { resolve: async () => [] } as never,
    spaceAgentAdapter: { createOrRestoreSession: async () => ({ binding: { sessionId: "s:1" }, dotId: "dot:other" }) } as never,
    spaceControl: { watches: async () => ({}) } as never,
    controlUser: async () => ({ id: "user:1" }) as never
  });
  return { result, hooks, warns, dotGoalService, dotScheduleService, dotDelegationService, channel: captured.channel as Record<string, Fn> | undefined };
}

describe("Dots stages 6-8 wiring", () => {
  it("wires nothing optional without the Dots stores and returns the evaluations repository", () => {
    const { result, hooks } = wire({ full: false, options: {} });
    expect(result).toEqual({ dotChannelService: null, dotEvalsRepository: { kind: "evals" } });
    expect(captured.channel).toBeUndefined();
    expect(captured.proactive).toBeUndefined();
    expect(captured.channelRoutes[0]).toMatchObject({ service: null, options: { verifySlack: null, verifyTeams: null } });
    expect(captured.liveEvals[0]).toMatchObject({ channelsRepository: null, dotChannelService: null });
    expect(hooks.map((hook) => hook.name)).toEqual(["onReady", "onClose"]);
  });

  it("keeps an injected channel store open, and needs the channels module", () => {
    const off = wire({ modules: [] });
    expect(off.result.dotChannelService).toBeNull();
    expect(off.hooks.map((hook) => hook.name)).toEqual(["onReady", "onClose"]);
    const on = wire();
    expect(on.result.dotChannelService).toMatchObject({ kind: "channels" });
    expect(captured.channel?.repo).toMatchObject({ kind: "injected" });
    expect(captured.liveEvals[1]).toMatchObject({ channelsRepository: { kind: "injected" }, dotChannelService: { kind: "channels" } });
  });

  it("names why Slack and Teams are off, and turns them on from the environment", () => {
    wire();
    expect(captured.channel?.providers).toEqual([
      { provider: "SLACK", configured: false, reason: expect.stringContaining("SPACE_SLACK_SIGNING_SECRET"), appUrl: null },
      { provider: "TEAMS", configured: false, reason: expect.stringContaining("SPACE_TEAMS_APP_ID") }
    ]);
    vi.stubEnv("SPACE_SLACK_SIGNING_SECRET", "signing"); vi.stubEnv("SPACE_SLACK_BOT_TOKEN", "xoxb-1"); vi.stubEnv("SPACE_SLACK_APP_ID", "A0123456");
    vi.stubEnv("SPACE_TEAMS_APP_ID", "app-1"); vi.stubEnv("SPACE_TEAMS_APP_PASSWORD", "pw");
    wire();
    expect(captured.channel?.providers).toEqual([
      { provider: "SLACK", configured: true, reason: null, appUrl: "https://slack.com/app_redirect?app=A0123456" },
      { provider: "TEAMS", configured: true, reason: null }
    ]);
    expect(captured.channelRoutes.at(-1)?.options).toMatchObject({ verifySlack: expect.any(Function), verifyTeams: expect.any(Function) });
    expect((captured.channelRoutes.at(-1)?.options.verifySlack as (input: unknown) => boolean)({ rawBody: "{}", timestamp: "1", signature: "v0=bad" })).toBe(false);
  });

  it("takes the app origin from SPACE_PUBLIC_ORIGIN, else the Google redirect, else none", () => {
    vi.stubEnv("SPACE_PUBLIC_ORIGIN", "https://space.example.com/");
    wire();
    expect(captured.channel?.appOrigin).toBe("https://space.example.com");
    vi.unstubAllEnvs();
    wire({ googleRedirectUri: "https://login.example.com:4911/auth/callback" });
    expect(captured.channel?.appOrigin).toBe("https://login.example.com:4911");
    wire({ googleRedirectUri: "not a url" });
    expect(captured.channel?.appOrigin).toBeNull();
  });

  it("picks the owner's first workspace room, refuses another Dot's session, and maps approvals and Goals", async () => {
    const { channel, dotGoalService } = wire();
    await expect(channel!.pickRoom("user:1" as never)).resolves.toBe("room:a");
    await expect(channel!.pickRoom("user:9" as never)).resolves.toBeNull();
    await expect(channel!.startSession({ pane: {}, owner: "user:1", dotId: "dot:mine" } as never)).rejects.toThrow("The channel conversation could not start.");
    await expect(channel!.pendingApprovals("user:1" as never, "dot:1" as never, "s:1" as never)).resolves.toEqual([{ invocationId: "inv:1", summary: "mail.send" }, { invocationId: "inv:2", summary: "Pay it" }]);
    await expect(channel!.goalFor("user:1" as never, "dot:1" as never, "s:1" as never)).resolves.toEqual({ goalId: "goal:new", status: "RUNNING", statusReason: null, createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" });
    await channel!.answerGoal("user:1" as never, "dot:1" as never, "goal:new" as never, "x".repeat(5000) as never);
    expect(dotGoalService.steer).toHaveBeenCalledWith("user:1", "dot:1", "goal:new", { text: "x".repeat(4000) }, null);
    expect(dotGoalService.control).toHaveBeenCalledWith("user:1", "dot:1", "goal:new", { action: "RESUME" }, null);
  });

  it("answers 401 on the Dot computer routes without a valid session", async () => {
    wire();
    const routes = captured.computerRoutes[0]!.options;
    const user = { id: "user:owner01", email: "o@example.com", role: "ADMIN" as const };
    await expect(routes.authenticatedOwner({ user: null, cookies: {} })).rejects.toMatchObject({ statusCode: 401, message: "Sign in to use Dots." });
    await expect(routes.authenticatedOwner({ user, cookies: { [cookieName]: signSession(user, SECRET) } })).resolves.toBe("user:owner01:stored");
  });

  it("builds the proactive notices with the configured model and a missing key file as no key", async () => {
    wire();
    expect(captured.decider).toMatchObject({ model: "gpt-5.6-sol", baseUrl: "http://127.0.0.1:1" });
    await expect((captured.decider!.apiKey as () => Promise<unknown>)()).resolves.toBeNull();
    await expect((captured.proactive!.timeZone as (owner: string) => Promise<string>)("user:1")).resolves.toBe("Asia/Bangkok");
    await expect((captured.proactive!.accounts as (owner: string) => Promise<unknown>)("user:1")).resolves.toEqual(["a"]);
    expect(captured.proactive!.alsoSlack).toBeTypeOf("function");
    vi.stubEnv("SPACE_DOT_PROACTIVE_MODEL", "gpt-6-astra");
    wire({ modules: [] });
    expect(captured.decider).toMatchObject({ model: "gpt-6-astra" });
    expect(captured.proactive!.alsoSlack).toBeUndefined();
  });

  it("starts the Dot timers only with Codex turns and the dot-schedules job, logs failed ticks and clears them on close", async () => {
    vi.useFakeTimers();
    const idle = wire({ job: false });
    await idle.hooks.find((hook) => hook.name === "onReady")!.fn();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(idle.dotScheduleService.tick).not.toHaveBeenCalled();

    const on = wire();
    await on.hooks.find((hook) => hook.name === "onReady")!.fn();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(on.dotScheduleService.tick).toHaveBeenCalledTimes(10);
    expect(on.dotGoalService.reconcile).toHaveBeenCalledTimes(2);
    const messages = on.warns.map((args) => args[1]);
    expect(messages).toContain("Dot proactive tick failed.");
    expect(messages).toContain("Dot delegation reports failed.");
    expect(messages).toContain("Restarted drivers for open Dot Goals.");

    await on.hooks.find((hook) => hook.name === "onClose")!.fn();
    const ticks = on.dotScheduleService.tick.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(on.dotScheduleService.tick.mock.calls.length).toBe(ticks);
  });
});
