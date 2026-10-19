import type { Pane, PaneCliSession } from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import { CLAUDE_LAST_ANSWER_MAX_CHARS, loadClaudeNativeTurns } from "../claude-native-turns.js";
import { codexDirectParityCodexHome, isClaudeDirectParityRuntime, isCodexDirectParityRuntime } from "../cli-parity.js";
import { findCodexCliTurnFinalResult, findCodexTaskTimeline } from "../codex-rollout-diagnostics.js";

/**
 * A CLI pane's last answer from its own transcript, for space_read_pane's reply "last" (plan clipboard:8s0ZNiO3q5ZT S2):
 * a pane's final report survives a scrolled or narrow screen. Claude Code through the launcher's existing native-turns
 * read (no new sudo rule), Codex from its rollout; other CLIs have none and keep the screen. Redacted like the screen.
 */
export interface PaneLastAnswerDeps {
  store: Pick<SpaceStore, "getActivePaneCliSession">;
  activeSessionPids(sessions: PaneCliSession[]): Promise<Map<string, number>>;
  claude?: typeof loadClaudeNativeTurns;
  codex?: { timeline: typeof findCodexTaskTimeline; finalResult: typeof findCodexCliTurnFinalResult };
}

/** live: the newest text of a turn still running (pane reports' heartbeat); Codex writes only finished turns, so it has none. */
export function createPaneLastAnswer(deps: PaneLastAnswerDeps): (pane: Pane, options?: { live?: boolean }) => Promise<string | null> {
  const claude = deps.claude ?? loadClaudeNativeTurns;
  const codex = deps.codex ?? { timeline: findCodexTaskTimeline, finalResult: findCodexCliTurnFinalResult };
  return async (pane, options = {}) => {
    const session = await deps.store.getActivePaneCliSession(pane.id);
    if (!session || session.purpose !== "NORMAL") return null;
    let answer: string | null = null;
    if (isClaudeDirectParityRuntime(session.runtimeId)) {
      const pids = await deps.activeSessionPids([session]).catch(() => null);
      const native = await claude({ paneId: pane.id, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null }, { fresh: true }).catch(() => null);
      answer = native?.lastAnswer ?? null;
    } else if (isCodexDirectParityRuntime(session.runtimeId) && session.codexThreadId && !options.live) {
      const options = { codexHome: codexDirectParityCodexHome, threadId: session.codexThreadId };
      const turn = (await codex.timeline(options).catch(() => [])).findLast((task) => task.status === "COMPLETED");
      answer = turn ? await codex.finalResult({ ...options, turnId: turn.taskId }).catch(() => null) : null;
    }
    return answer?.trim() ? redactMemoryText(answer.trim()).slice(-CLAUDE_LAST_ANSWER_MAX_CHARS) : null;
  };
}
