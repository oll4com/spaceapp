import { afterEach, describe, expect, it, vi } from "vitest";
import { parseBody, parseQuery } from "../src/route-parsing.js";

const { captured, rec } = vi.hoisted(() => {
  const captured = { order: [] as string[], args: {} as Record<string, unknown[]> };
  const rec = (name: string, result?: unknown) => (...args: unknown[]) => { captured.order.push(name); captured.args[name] = args; return result; };
  return { captured, rec };
});
vi.mock("../src/agent-pane-routes.js", async (orig) => ({ ...await orig<object>(), registerAgentPaneRoutes: rec("agentPane") }));
vi.mock("../src/voice-routes.js", async (orig) => ({ ...await orig<object>(), registerVoiceRoutes: rec("voice"), registerVoiceAttachmentRoutes: rec("voiceAttachments") }));
vi.mock("../src/live-routes.js", async (orig) => ({ ...await orig<object>(),
  registerLiveRoutes: rec("live", { livePersonalMemory: "live-personal-memory", liveHistory: "live-history" }) }));
vi.mock("../src/council/wiring.js", async (orig) => ({ ...await orig<object>(), registerCouncil: rec("council", { council: "service" }) }));
vi.mock("../src/nous/wiring.js", async (orig) => ({ ...await orig<object>(), registerNous: rec("nous", { nous: "wiring" }), nousLessonEmbedder: rec("embedder", "lesson-embedder") }));
vi.mock("../src/cli-agent-files.js", async (orig) => ({ ...await orig<object>(), cliAgentFilesApiBaseUrl: rec("apiBase", "https://api.space.local") }));
vi.mock("../src/turn-routes.js", async (orig) => ({ ...await orig<object>(), registerTurnRoutes: rec("turns") }));
vi.mock("../src/event-routes.js", async (orig) => ({ ...await orig<object>(), registerEventRoutes: rec("events") }));

const { registerConversationRoutes } = await import("../src/conversation-routes-wiring.js");

afterEach(() => { Object.assign(captured, { order: [], args: {} }); });

const copilotNames = ["mailCopilotService", "marketingCopilotService", "freelanceCopilotService", "jobApplyService", "designService", "appStudioService", "videoService",
  "securityCopilotService", "monitoringCopilotService", "mailCampaignsService"] as const;

function wire(input: { telegramManager?: boolean; gateway?: boolean; hostHealth?: "up" | "missing" | "none" } = {}) {
  const noted: unknown[] = [];
  const nousRef = { current: null as unknown };
  const deps = {
    config: { instanceJobs: { nous: true, "managed-plan-controller": false, "nous-pane-board": true } }, store: { store: true }, eventBus: { bus: true },
    auth: { sessionSecret: "s".repeat(32) },
    options: { ...(input.telegramManager ? { telegramIntegrationManager: {} } : {}), nousRunner: "nous-runner", vaultBrokerReinstall: "reinstall", paneBoardRunner: "board-runner" },
    nousRef, browserSessionManager: input.hostHealth === "missing" ? { browsers: true }
      : { browsers: true, browserHostHealth: async () => input.hostHealth === "none" ? undefined : { startedAt: "2026-11-01T00:00:00Z" } },
    cliTerminalManager: {
      runSerializedTerminalMutation: async (sessionId: string, run: () => Promise<unknown>) => { noted.push(["serialized", sessionId]); return run(); },
      sendInput: async (...args: unknown[]) => { noted.push(["sendInput", ...args]); return "sent"; },
      activeSessionPids: async (sessions: unknown) => { noted.push(["pids", sessions]); return new Map([["cli_session:a1", 42]]); }
    },
    cliRuntimeVisibility: "visibility", roomPaneController: { inspect: async (...args: unknown[]) => { noted.push(["inspect", ...args]); return { sessionId: "s" }; } },
    commandRoomCli: async (...args: unknown[]) => { noted.push(["command", ...args]); return "commanded"; }, assertRoomAccess: "assert-room-access",
    readDashboardAgents: "read-dashboard-agents", roomAgentService: "room-agent-service", roomAgentTools: "room-agent-tools", roomCoordination: { releaseTrain: "release-train" },
    roomAgentMonitorRepository: "monitor-repository", controlRepository: "control-repository", controlInvoke: "control-invoke", railCli: "rail-cli", vault: "vault",
    paneBrowserAccounts: "pane-browser-accounts", cliUpdateAllRunner: "update-all", telegramPersistence: "telegram-persistence", telegramSecrets: "telegram-secrets",
    youtubePlaybackStore: { getByPaneId: async (paneId: string) => ({ paneId, updatedAt: 7 }) }, notificationService: "notifications",
    claudeUsageProvider: "claude-usage", canonicalMemory: "canonical-memory", apiProviderAccountsProvider: "api-providers", healthMonitor: "health-monitor",
    systemServicesProvider: "system-services", systemAnalyticsService: { models: async (...args: unknown[]) => ({ models: args }) },
    gatewayAdminService: input.gateway === false ? undefined : { status: async () => "gateway-status" }, jobApplyRepository: "job-repository",
    ...Object.fromEntries(copilotNames.map((name) => [name, `${name}-value`])),
    spaceAgentAdapter: "space-agent", codexHistoryAccessCoordinator: "history-coordinator", setupOwnerVoiceRuntime: "voice-runtime",
    setupVoiceCredentials: "voice-credentials", decisionsService: "decisions", turnStarter: "turn-starter", codexTurnStarter: "codex-turn-starter",
    roomShares: "room-shares", defaultRouteRateLimitOptions: { config: { rateLimit: 1 } }, defaultWebsocketRateLimitOptions: { config: { rateLimit: 2 } }
  };
  const result = registerConversationRoutes({ app: true } as never, deps as never);
  return { result, deps, noted, nousRef };
}
const arg = (name: string, index = 1) => captured.args[name]![index] as Record<string, never>;
const nous = () => arg("nous") as unknown as Record<string, unknown> & {
  browserHostHealth: () => Promise<unknown>; youtubePlayback: (paneId: string) => Promise<unknown>; inspectPane: (pane: unknown) => Promise<unknown>;
  answerCli: (pane: unknown, input: unknown, traceId: string) => Promise<unknown>; pressKeys: (sessionId: string, keys: string, traceId: string) => Promise<unknown>;
  activeSessionPids: (sessions: unknown) => Promise<unknown>; sessionPids: (sessions: unknown) => Promise<unknown>;
  ops: { health: unknown; services: unknown; tokenUsage: (range: string) => Promise<unknown>; gateway: () => Promise<unknown>; gatewayAdmin?: unknown };
};

describe("conversation routes wiring (ARCH-001 step 81)", () => {
  it("registers in app.ts's order and sets Nous on nousRef", () => {
    const { result, nousRef } = wire();
    expect(captured.order).toEqual(["agentPane", "voice", "live", "council", "embedder", "apiBase", "nous", "voiceAttachments", "turns", "events"]);
    expect(result).toBeUndefined();
    expect(nousRef.current).toEqual({ nous: "wiring" });
  });

  it("passes the agent pane, voice, voice attachment, turn and event routes their dependencies", () => {
    const { deps } = wire();
    const routeOptions = deps.defaultRouteRateLimitOptions;
    expect(arg("agentPane")).toEqual({ store: deps.store, spaceAgentAdapter: "space-agent", cliRuntimeVisibility: "visibility",
      codexHistoryAccessCoordinator: "history-coordinator", routeOptions });
    expect(arg("voice")).toEqual({ setupOwnerVoiceRuntime: "voice-runtime", setupVoiceCredentials: "voice-credentials", config: deps.config, decisionsService: "decisions",
      store: deps.store, routeOptions, websocketRouteOptions: deps.defaultWebsocketRateLimitOptions, assertRoomAccess: "assert-room-access" });
    expect(arg("voiceAttachments")).toEqual({ config: deps.config, store: deps.store, routeOptions });
    expect(arg("turns")).toEqual({ config: deps.config, store: deps.store, eventBus: deps.eventBus, turnStarter: "turn-starter", codexTurnStarter: "codex-turn-starter",
      cliRuntimeVisibility: "visibility", routeOptions });
    expect(arg("events")).toEqual({ store: deps.store, eventBus: deps.eventBus, routeOptions, roomShares: "room-shares" });
  });

  it("feeds Live's personal memory to the Council and Live's history and the Council to Nous", () => {
    const { deps } = wire();
    expect(arg("live")).toEqual({ config: deps.config, auth: deps.auth, store: deps.store, roomPaneController: deps.roomPaneController,
      roomAgentService: "room-agent-service", routeOptions: deps.defaultRouteRateLimitOptions, assertRoomAccess: "assert-room-access", readDashboardAgents: "read-dashboard-agents" });
    expect(arg("council")).toEqual({ config: deps.config, auth: deps.auth, store: deps.store, parseBody, parseQuery, routeOptions: deps.defaultRouteRateLimitOptions,
      claudeUsageProvider: "claude-usage", jobApplyRepository: "job-repository", jobApplyService: "jobApplyService-value", livePersonalMemory: "live-personal-memory",
      canonicalMemory: "canonical-memory", notifications: "notifications" });
    expect(nous()).toMatchObject({ council: { council: "service" }, liveHistory: "live-history" });
  });

  it("gives Nous its configuration, services and copilots", () => {
    const { deps } = wire();
    expect(captured.args.embedder).toEqual([deps.config]);
    expect(captured.args.apiBase).toEqual([deps.config]);
    expect(nous()).toMatchObject({ config: deps.config, memoryEmbedding: "lesson-embedder", vault: "vault", browser: deps.browserSessionManager,
      paneBrowserAccounts: "pane-browser-accounts", cliUpdateAllRunner: "update-all", telegram: { persistence: "telegram-persistence", secrets: "telegram-secrets" },
      autonomous: true, planControllerRunning: false, auth: deps.auth, store: deps.store, parseBody, parseQuery, routeOptions: deps.defaultRouteRateLimitOptions,
      readActivity: "read-dashboard-agents", railCli: "rail-cli", roomTools: "room-agent-tools", releaseTrain: "release-train", notifications: "notifications",
      runner: "nous-runner", vaultBrokerReinstall: "reinstall", monitorEvents: "monitor-repository", invoke: "control-invoke", eventBus: deps.eventBus,
      health: "health-monitor", controlRepository: "control-repository", apiBaseUrl: "https://api.space.local", claudeUsageProvider: "claude-usage",
      apiProviderAccountsProvider: "api-providers", paneBoardJob: true, paneBoardRunner: "board-runner",
      copilots: { mail: "mailCopilotService-value", marketing: "marketingCopilotService-value", freelance: "freelanceCopilotService-value", job: "jobApplyService-value",
        design: "designService-value", appStudio: "appStudioService-value", video: "videoService-value", security: "securityCopilotService-value",
        monitoring: "monitoringCopilotService-value", mailCampaigns: "mailCampaignsService-value" } });
    expect(nous().ops).toMatchObject({ health: "health-monitor", services: "system-services" });
    wire({ telegramManager: true });
    expect(nous()).not.toHaveProperty("telegram");
  });

  it("reads the browser host's health, YouTube playback and the token usage and gateway status for Nous", async () => {
    wire();
    await expect(nous().browserHostHealth()).resolves.toEqual({ startedAt: "2026-11-01T00:00:00Z" });
    await expect(nous().youtubePlayback("pane:youtube1")).resolves.toEqual({ paneId: "pane:youtube1", updatedAt: 7 });
    await expect(nous().ops.tokenUsage("7d")).resolves.toEqual({ models: ["7d", "all"] });
    await expect(nous().ops.gateway()).resolves.toBe("gateway-status");
    expect(nous().ops.gatewayAdmin).toMatchObject({ status: expect.any(Function) });
    for (const hostHealth of ["missing", "none"] as const) {
      wire({ hostHealth });
      await expect(nous().browserHostHealth()).resolves.toBeNull();
    }
    wire({ gateway: false });
    expect(nous().ops).not.toHaveProperty("gatewayAdmin");
  });

  it("lets Nous inspect panes, answer CLI prompts, press keys and read session pids through the room's CLI control", async () => {
    const { noted } = wire();
    const pane = { id: "pane:cli00001" };
    await nous().inspectPane(pane);
    await expect(nous().answerCli(pane, { sessionId: "cli_session:a1", answer: "yes" }, "trace:answer1")).resolves.toBe("commanded");
    await nous().answerCli(pane, { sessionId: "cli_session:a1", answer: "2", fingerprint: "fp-1" }, "trace:answer2");
    await expect(nous().pressKeys("cli_session:a1", "\u001b", "trace:keys001")).resolves.toBe("sent");
    await nous().activeSessionPids(["s1"]);
    await nous().sessionPids(["s2"]);
    expect(noted.slice(0, 5)).toEqual([
      ["inspect", pane, { fresh: true }],
      ["command", pane, { type: "cli_command", paneId: "pane:cli00001", expectedSessionId: "cli_session:a1", answer: "yes", submit: true, when: "NOW" }, "trace:answer1"],
      ["command", pane, { type: "cli_command", paneId: "pane:cli00001", expectedSessionId: "cli_session:a1", answer: "2", submit: true, expectedPromptFingerprint: "fp-1",
        when: "NOW" }, "trace:answer2"],
      ["serialized", "cli_session:a1"],
      ["sendInput", "cli_session:a1", "\u001b", "trace:keys001", null, expect.stringMatching(/^trace:keys001:keys:[0-9a-f-]{36}$/)]
    ]);
    expect(noted.slice(5)).toEqual([["pids", ["s1"]], ["pids", ["s2"]]]);
  });
});
