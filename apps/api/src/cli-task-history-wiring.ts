import type { SpaceStore } from "@space/runtime";
import { AgentSessionHistoryService } from "./agent-session-history.js";
import { loadClaudeNativeTurns } from "./claude-native-turns.js";
import { findSafeCodexThreadId, type CliTerminalManager, type CodexThreadFinder } from "./cli-terminal.js";
import { createCodexParityService, type CodexParityService } from "./codex-parity.js";
import type { SpaceApiConfig } from "./config.js";
import { geminiNativeConversationIdPattern, readGeminiNativeConversationIdFromProcessTree, readGeminiPaneConversation } from "./gemini-native-session.js";
import { readOpenCodeNativeSessionId } from "./opencode-native-session.js";
import { UnifiedCliTaskRegistry } from "./unified-cli-task-registry.js";

type CliTaskHistoryDeps = {
  options: { codexParity?: CodexParityService; findCodexThreadId?: CodexThreadFinder; opencodeStateRoot?: string };
  config: SpaceApiConfig; store: SpaceStore;
  /** A call-time reader: app.ts creates the CLI terminal manager after this block, so its session pids are read only when a native task ref is resolved. */
  cliTerminalManager: Pick<CliTerminalManager, "activeSessionPids">;
};

/**
 * The CLI task registry and session history block of app.ts (moved verbatim, ARCH-001 step 90): the Codex parity
 * service, the unified CLI task registry with each runtime's native task reference (Codex thread, OpenCode session, Gemini
 * conversation from the pane file or the process tree, Claude session from its transcript), and the agent session history.
 */
export function createCliTaskHistory(deps: CliTaskHistoryDeps) {
  const { options, config, store, cliTerminalManager } = deps;
  const codexParity =
    options.codexParity ??
    createCodexParityService({
      codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex",
      threadRenameCommand: config.codexAppServerCommand,
      codexLbBaseUrl: config.codexLbBaseUrl,
      codexLbKeyFile: config.codexLbKeyFile, ...(config.instance === "dev" ? { environmentInspectorCommand: null } : {}) // dev cannot sudo
    });

  const unifiedCliTaskRegistry = new UnifiedCliTaskRegistry(store, {
    resolveNativeTaskRef: async (session) => {
      if (session.runtimeId === "cli:codex") {
        return (options.findCodexThreadId ?? findSafeCodexThreadId)({
          paneId: session.paneId, sessionId: session.sessionId, cwd: session.cwd
        });
      }
      if (session.runtimeId === "cli:opencode") {
        return readOpenCodeNativeSessionId(session.sessionId, options.opencodeStateRoot);
      }
      if (session.runtimeId === "cli:gemini") {
        if (session.codexThreadId && geminiNativeConversationIdPattern.test(session.codexThreadId)) {
          return session.codexThreadId;
        }
        const fromFile = await readGeminiPaneConversation(session.paneId);
        if (fromFile) return fromFile;
        const pids = await cliTerminalManager.activeSessionPids([session]);
        const rootPid = pids.get(session.sessionId) ?? null;
        return rootPid ? readGeminiNativeConversationIdFromProcessTree(rootPid) : null;
      }
      if (session.runtimeId === "cli:claude") {
        const pids = await cliTerminalManager.activeSessionPids([session]);
        const native = await loadClaudeNativeTurns({
          paneId: session.paneId, sessionId: session.sessionId, rootPid: pids.get(session.sessionId) ?? null
        });
        return native?.nativeSessionId ?? null;
      }
      return null;
    }
  });
  const agentSessionHistoryService = new AgentSessionHistoryService({
    codexParity,
    unifiedCliTaskRegistry,
    codexHome: config.codexAppServerHome ?? "/var/lib/spaceapp-user/.codex",
    maxAgeDays: 7,
    verifyRolloutExistence: true
  });
  return { codexParity, unifiedCliTaskRegistry, agentSessionHistoryService };
}
