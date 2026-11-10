import type { PaneCliSession } from "@space/contracts";
import type { CliTerminalManager } from "./cli-terminal.js";
import { loadClaudeNativeTurns, type ClaudeNativeTurns, type createClaudeNativeRefRecorder } from "./claude-native-turns.js";

interface ClaudeLiveTurnsDependencies {
  cliTerminalManager: Pick<CliTerminalManager, "activeSessionPids">;
  recordClaudeNativeRef: ReturnType<typeof createClaudeNativeRefRecorder>;
}

export function createClaudeLiveTurnsReader({ cliTerminalManager, recordClaudeNativeRef }: ClaudeLiveTurnsDependencies) {
  // Dashboard and live agent counts poll every Claude pane; one launcher read per session
  // serves every room request and browser tab for a few seconds.
  const claudeLiveTurnsCache = new Map<string, { expires: number; value: Promise<ClaudeNativeTurns | null> }>();
  const readClaudeLiveTurns = (session: PaneCliSession, { fresh = false }: { fresh?: boolean } = {}): Promise<ClaudeNativeTurns | null> => {
    const now = Date.now();
    const cached = claudeLiveTurnsCache.get(session.sessionId);
    if (!fresh && cached && cached.expires > now) return cached.value;
    for (const [key, entry] of claudeLiveTurnsCache) if (entry.expires <= now) claudeLiveTurnsCache.delete(key);
    const value = cliTerminalManager.activeSessionPids([session]).catch(() => null)
      .then(pids => loadClaudeNativeTurns({ paneId: session.paneId, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null }, { fresh }))
      .then(async native => {
        if (native) await recordClaudeNativeRef(session, native).catch(() => undefined);
        return native;
      });
    claudeLiveTurnsCache.set(session.sessionId, { expires: now + 4_000, value });
    return value;
  };
  return readClaudeLiveTurns;
}
