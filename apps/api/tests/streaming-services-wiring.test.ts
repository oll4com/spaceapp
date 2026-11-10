import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const { captured } = vi.hoisted(() => ({ captured: { built: [] as Array<{ name: string; input: Record<string, unknown> }>, calls: [] as string[] } }));
vi.mock("../src/streaming-bot-service.js", () => ({
  StreamingBotService: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; captured.built.push({ name: "bot", input }); }
    async botTicker() { return { enabled: true, ticker: [] }; } }
}));
vi.mock("../src/streaming-service.js", () => ({
  StreamingService: class { input: Record<string, unknown>; constructor(input: Record<string, unknown>) { this.input = input; captured.built.push({ name: "streaming", input }); }
    async overlaySnapshot() { return { snapshot: true }; } }
}));
vi.mock("../src/streaming-credential-store.js", () => ({ StreamingCredentialStore: class { root: string; constructor(root: string) { this.root = root; } } }));
vi.mock("@space/streaming", async (orig) => ({ ...await orig<object>(), formatStreamingBotLiveMetrics: (snapshot: unknown) => ({ formatted: snapshot }) }));
vi.mock("../src/active-agent-count.js", () => ({ createActiveAgentCountProvider: (input: Record<string, unknown>) => ({ provider: true, input }) }));
vi.mock("../src/room-terminal-screen.js", async (orig) => ({ ...await orig<object>(), roomTerminalState: (text: string) => (text === "busy" ? "RUNNING" : text ? "IDLE" : "UNKNOWN") }));
vi.mock("../src/gemini-native-turns.js", async (orig) => ({ ...await orig<object>(),
  loadGeminiNativeTurns: async (input: { rootPid: number | null }) => ({ turns: [{ status: input.rootPid === 7 ? "RUNNING" : "DONE" }] }) }));
vi.mock("@space/opencode-control", async (orig) => ({ ...await orig<object>(),
  readOpenCodeServerControl: async (sessionId: string, stateRoot: string) => { captured.calls.push(`openCodeControl:${sessionId}:${stateRoot}`); return null; } }));

const { createStreamingServices } = await import("../src/streaming-services-wiring.js");
const { InMemoryStreamingBotRepository, InMemoryStreamingRepository, PostgresSpaceStore } = await import("@space/db");

afterEach(() => { captured.built = []; captured.calls = []; });

type TurnCheck = (session: { sessionId: string; runtimeId: string; paneId: string; cwd: string | null }) => Promise<boolean>;
function build(input: { options?: Record<string, unknown>; store?: unknown; screens?: Record<string, string>; codexRunning?: string[]; pids?: Record<string, number>;
  claudeBusy?: Record<string, boolean> } = {}) {
  const terminals = {
    observeRoomScreen: async (sessionId: string) => ({ text: input.screens?.[sessionId] ?? "" }),
    getCurrentTurnActivity: async (sessionId: string) => ({ status: input.codexRunning?.includes(sessionId) ? "RUNNING" : "IDLE" }),
    activeSessionPids: async (sessions: Array<{ sessionId: string }>) => new Map(sessions.map((session) => [session.sessionId, input.pids?.[session.sessionId] ?? 1]))
  };
  const readClaudeLiveTurns = async (session: { sessionId: string }) => (session.sessionId in (input.claudeBusy ?? {}) ? { busy: input.claudeBusy![session.sessionId] } : null);
  return createStreamingServices({ options: input.options ?? {}, config: { databaseUrl: null, streamingSecretRoot: "/opt/spaceapp/var/streaming",
    streamingYoutubeDailyQuotaBudget: 9000 }, store: input.store ?? { store: true }, readClaudeLiveTurns, cliTerminalManager: terminals } as never);
}
const built = (name: string) => captured.built.find((entry) => entry.name === name)!.input;

describe("streaming services wiring (ARCH-001 step 86)", () => {
  it("keeps injected streaming services and builds none", () => {
    const streamingService = { injected: "streaming" }; const streamingBotService = { injected: "bot" };
    expect(build({ options: { streamingService, streamingBotService } })).toEqual({ streamingBotService, streamingService });
    expect(captured.built).toEqual([]);
  });

  it("builds the bot service, then the streaming service, on in-memory repositories and a private credential root without PostgreSQL", async () => {
    const store = { store: true };
    const { streamingBotService, streamingService } = build({ store });
    expect(captured.built.map((entry) => entry.name)).toEqual(["bot", "streaming"]);
    const bot = built("bot"); const streaming = built("streaming");
    expect(bot.botRepository).toBeInstanceOf(InMemoryStreamingBotRepository);
    expect(bot.streamingRepository).toBeInstanceOf(InMemoryStreamingRepository);
    expect(bot).toMatchObject({ store, youtubeDailyBudget: 9000, credentialStore: { root: "/opt/spaceapp/var/streaming" } });
    expect(streaming.repository).toBeInstanceOf(InMemoryStreamingRepository);
    expect(streaming).toMatchObject({ store, youtubeDailyQuotaBudget: 9000, cleanupCredentialRootOnDispose: true });
    expect((streaming.credentialStore as { root: string }).root.startsWith(`${tmpdir()}/space-streaming-secrets-${process.pid}-`)).toBe(true);
    // Each reads the other only when asked.
    await expect((bot.liveMetrics as () => Promise<unknown>)()).resolves.toEqual({ formatted: { snapshot: true } });
    await expect((streaming.botTickerProvider as () => Promise<unknown>)()).resolves.toEqual({ enabled: true, ticker: [] });
    expect((streamingService as unknown as { input: unknown }).input).toBe(streaming);
    expect((streamingBotService as unknown as { input: unknown }).input).toBe(bot);
  });

  it("refuses a PostgreSQL store without a database URL", () => {
    expect(() => build({ store: Object.create(PostgresSpaceStore.prototype) })).toThrow("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
  });

  it("counts a CLI as active from its runtime's own turn signal, else its screen", async () => {
    build({ options: { opencodeStateRoot: "/opt/spaceapp/var/opencode" }, screens: { "s-shell": "busy", "s-deepseek": "busy", "s-opencode": "busy", "s-codex-screen": "busy", "s-gemini-stale": "> " },
      codexRunning: ["s-codex"], pids: { "s-gemini": 7, "s-gemini-stale": 7 }, claudeBusy: { "s-claude": true, "s-claude-idle": false } });
    const provider = built("streaming").activeAgentCountProvider as { input: { store: unknown; isCliTurnActive: TurnCheck } };
    expect(provider.input.store).toEqual({ store: true });
    const active = (sessionId: string, runtimeId: string) => provider.input.isCliTurnActive({ sessionId, runtimeId, paneId: "pane:1", cwd: "/work" });
    expect(await active("s-codex", "cli:codex")).toBe(true);
    expect(await active("s-codex-screen", "cli:codex")).toBe(true);
    expect(await active("s-codex-idle", "cli:codex")).toBe(false);
    expect(await active("s-gemini", "cli:gemini")).toBe(true);
    expect(await active("s-gemini-idle", "cli:gemini")).toBe(false);
    // 6/11: agy writes no step on Esc or ctrl+c, so an idle composer ends the RUNNING native turn it leaves.
    expect(await active("s-gemini-stale", "cli:gemini")).toBe(false);
    expect(await active("s-claude", "cli:claude")).toBe(true);
    expect(await active("s-claude-idle", "cli:claude")).toBe(false);
    expect(await active("s-deepseek", "cli:deepseek")).toBe(true);
    expect(await active("s-shell", "cli:root")).toBe(true);
    expect(await active("s-quiet", "cli:root")).toBe(false);
    expect(await active("s-opencode", "cli:opencode")).toBe(true);
    expect(captured.calls).toEqual(["openCodeControl:s-opencode:/opt/spaceapp/var/opencode"]);
  });
});
