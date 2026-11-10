import { InMemoryStreamingBotRepository, InMemoryStreamingRepository, PostgresSpaceStore, PostgresStreamingBotRepository, PostgresStreamingRepository } from "@space/db";
import { fetchOpenCodeSessionIsTurnActive, opencodeDirectParityRoot, readOpenCodeServerControl } from "@space/opencode-control";
import type { SpaceStore } from "@space/runtime";
import { formatStreamingBotLiveMetrics } from "@space/streaming";
import { nanoid } from "nanoid";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActiveAgentCountProvider } from "./active-agent-count.js";
import type { createClaudeLiveTurnsReader } from "./claude-live-turns.js";
import { isClaudeDirectParityRuntime, isCodexDirectParityRuntime, isDeepSeekDirectParityRuntime, isOpenCodeDirectParityRuntime } from "./cli-parity.js";
import type { CliTerminalManager } from "./cli-terminal.js";
import type { SpaceApiConfig } from "./config.js";
import { geminiTurnRunning, loadGeminiNativeTurns } from "./gemini-native-turns.js";
import { roomTerminalState } from "./room-terminal-screen.js";
import { StreamingBotService } from "./streaming-bot-service.js";
import { StreamingCredentialStore } from "./streaming-credential-store.js";
import { StreamingService } from "./streaming-service.js";

type StreamingServicesDeps = {
  options: { streamingBotService?: StreamingBotService; streamingService?: StreamingService; opencodeStateRoot?: string };
  config: SpaceApiConfig; store: SpaceStore; readClaudeLiveTurns: ReturnType<typeof createClaudeLiveTurnsReader>;
  cliTerminalManager: Pick<CliTerminalManager, "observeRoomScreen" | "getCurrentTurnActivity" | "activeSessionPids">;
};

/** The streaming services after the system topology in app.ts (moved verbatim, ARCH-001 step 86): the streaming bot service and the streaming
 *  service with its active-agent count, each injected one kept. Returns both: the request hooks, the platform and admin platform routes read them. */
export function createStreamingServices(deps: StreamingServicesDeps) {
  const { options, config, store, readClaudeLiveTurns, cliTerminalManager } = deps;
  const streamingBotService: StreamingBotService = options.streamingBotService ?? new StreamingBotService({
    botRepository: store instanceof PostgresSpaceStore
      ? PostgresStreamingBotRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemoryStreamingBotRepository(),
    streamingRepository: store instanceof PostgresSpaceStore
      ? PostgresStreamingRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemoryStreamingRepository(),
    store,
    youtubeDailyBudget: config.streamingYoutubeDailyQuotaBudget,
    credentialStore: new StreamingCredentialStore(config.streamingSecretRoot),
    liveMetrics: async () => formatStreamingBotLiveMetrics(await streamingService.overlaySnapshot())
  });
  const streamingService: StreamingService = options.streamingService ?? new StreamingService({
    repository: store instanceof PostgresSpaceStore
      ? PostgresStreamingRepository.fromConnectionString(
          config.databaseUrl ?? (() => {
            throw new Error("SPACE_DATABASE_URL is required when SPACE_RUNTIME_STORE=postgres.");
          })(),
          {
            max: 2,
            idleTimeoutMillis: config.databasePoolIdleTimeoutMs,
            connectionTimeoutMillis: config.databasePoolConnectionTimeoutMs
          }
        )
      : new InMemoryStreamingRepository(),
    credentialStore: new StreamingCredentialStore(
      store instanceof PostgresSpaceStore
        ? config.streamingSecretRoot
        : join(tmpdir(), `space-streaming-secrets-${process.pid}-${nanoid(8)}`)
    ),
    store,
    activeAgentCountProvider: createActiveAgentCountProvider({
      store,
      isCliTurnActive: async (session) => {
        if (isOpenCodeDirectParityRuntime(session.runtimeId)) {
          const stateRoot = options.opencodeStateRoot ?? opencodeDirectParityRoot + "/state";
          const control = await readOpenCodeServerControl(session.sessionId, stateRoot);
          if (control) {
            if (!control.directory && session.cwd) control.directory = session.cwd;
            if (await fetchOpenCodeSessionIsTurnActive(control, control.nativeSessionId, session.cwd ?? undefined).catch(() => false)) return true;
          }
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (isCodexDirectParityRuntime(session.runtimeId)) {
          const active = (await cliTerminalManager.getCurrentTurnActivity(session.sessionId)).status === "RUNNING";
          if (active) return true;
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (session.runtimeId === "cli:gemini") {
          const pids = await cliTerminalManager.activeSessionPids([session]).catch(() => null);
          const rootPid = pids?.get(session.sessionId) ?? null;
          const native = await loadGeminiNativeTurns({ paneId: session.paneId, sessionId: session.sessionId, rootPid }).catch(() => null);
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          const state = roomTerminalState(screen.text);
          return state === "RUNNING" || geminiTurnRunning(native?.turns.at(-1), state === "IDLE");
        }
        if (isDeepSeekDirectParityRuntime(session.runtimeId)) {
          const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
          return roomTerminalState(screen.text) === "RUNNING";
        }
        if (isClaudeDirectParityRuntime(session.runtimeId)) {
          const native = await readClaudeLiveTurns(session).catch(() => null);
          if (native) return native.busy;
        }
        const screen = await cliTerminalManager.observeRoomScreen(session.sessionId).catch(() => ({ text: "" }));
        return roomTerminalState(screen.text) === "RUNNING";
      }
    }),
    youtubeDailyQuotaBudget: config.streamingYoutubeDailyQuotaBudget,
    cleanupCredentialRootOnDispose: !(store instanceof PostgresSpaceStore),
    botTickerProvider: () => streamingBotService.botTicker()
  });
  return { streamingBotService, streamingService };
}
