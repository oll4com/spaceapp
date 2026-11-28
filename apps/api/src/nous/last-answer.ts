import type { Pane, PaneCliSession } from "@space/contracts";
import { redactMemoryText, type SpaceStore } from "@space/runtime";
import { loadClaudeNativeTurns } from "../claude-native-turns.js";
import { codexDirectParityCodexHome, isClaudeDirectParityRuntime, isCodexDirectParityRuntime } from "../cli-parity.js";
import { findCodexCliTurnFinalResult, findCodexTaskTimeline } from "../codex-rollout-diagnostics.js";
import type { NativeTaskExecution } from "../room-task-telemetry.js";
import { NOUS_SAVE_REQUEST } from "./save-request.js";

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
    return answer?.trim() ? redactMemoryText(answer.trim()) : null;
  };
}

/**
 * 27/11 (Bruno/Kate and ~30 panes kept open for hours): a save turn lasts seconds, so the monitor can miss it, and then it files no FINISHED
 * event and no turn-end report to verify from. The pane's own transcript holds the turn: the answer of its newest COMPLETED turn whose prompt
 * asked the save (NOUS_SAVE_REQUEST) and that ended at or after `since` ("" when it said nothing), null when no such turn ran.
 */
export function createPaneSaveTurn(deps: PaneLastAnswerDeps): (pane: Pane, since: string) => Promise<string | null> {
  const claude = deps.claude ?? loadClaudeNativeTurns;
  const codex = deps.codex ?? { timeline: findCodexTaskTimeline, finalResult: findCodexCliTurnFinalResult };
  const saveTurn = (tasks: NativeTaskExecution[], since: string) => tasks.findLast((task) => task.status === "COMPLETED" && NOUS_SAVE_REQUEST.test(task.title)
    && Boolean(task.timing.completedAt) && Date.parse(task.timing.completedAt!) >= Date.parse(since));
  return async (pane, since) => {
    const session = await deps.store.getActivePaneCliSession(pane.id);
    if (!session || session.purpose !== "NORMAL") return null;
    let answer: string | null;
    if (isClaudeDirectParityRuntime(session.runtimeId)) {
      const pids = await deps.activeSessionPids([session]).catch(() => null);
      const native = await claude({ paneId: pane.id, sessionId: session.sessionId, rootPid: pids?.get(session.sessionId) ?? null }, { fresh: true }).catch(() => null);
      const turn = native ? saveTurn(native.tasks, since) : undefined;
      if (!turn) return null;
      answer = native!.turnResults?.find((result) => result.taskId === turn.taskId)?.answer ?? null;
    } else if (isCodexDirectParityRuntime(session.runtimeId) && session.codexThreadId) {
      const options = { codexHome: codexDirectParityCodexHome, threadId: session.codexThreadId };
      const turn = saveTurn(await codex.timeline(options).catch(() => []), since);
      if (!turn) return null;
      answer = await codex.finalResult({ ...options, turnId: turn.taskId }).catch(() => null);
    } else return null;
    return answer?.trim() ? redactMemoryText(answer.trim()) : "";
  };
}

/**
 * A pane's Space Memory save made at or after `since`: the entry stamped with its pane id, else (27/11, Copilots/Finn saved unstamped, then the
 * idle sleeper stopped its CLI so no transcript turn is readable) an entry made after `since` whose id the pane's screen printed after `since`.
 */
export function createPaneSaves(deps: {
  store: Pick<SpaceStore, "listPaneCliSessions" | "listPaneCliTranscriptChunks">;
  entries(): Promise<Array<{ id: string; createdAt: string; body: string; title?: string }>>;
}): (paneId: string, since: string, names?: { pane: string; room: string }) => Promise<string | null> {
  return async (paneId, since, names) => {
    const entries = (await deps.entries()).filter((entry) => entry.createdAt >= since);
    if (!entries.length) return null;
    const stamp = new RegExp(`provenance=[^;\\n]*\\b${paneId}(?![\\w-])`);
    const stamped = entries.find((entry) => stamp.test(entry.body));
    if (stamped) return stamped.id;
    // Operator 28/11 (Antigravity panes with no quota cannot run "save to memory"): Nous's own note naming the pane (its id, "Room/Pane" or "Pane in room Room") is its save.
    const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`(?<![\\w-])(?:${esc(paneId)}${names ? `|${esc(names.room)}/${esc(names.pane)}|${esc(names.pane)} in room ${esc(names.room)}` : ""})(?![\\w-])`, "i");
    // 28/11 space_memory:6eec03f9 "Work/Dana: …": the name may stand in the title only.
    const noted = entries.find((entry) => /provenance=nous[:;]/.test(entry.body) && named.test(`${entry.title ?? ""}\n${entry.body}`));
    if (noted) return noted.id;
    let screen = "";
    for (const session of await deps.store.listPaneCliSessions(paneId)) {
      if (session.updatedAt < since) continue;
      // Joined per session: an id may straddle two chunks.
      screen += (await deps.store.listPaneCliTranscriptChunks(session.sessionId)).filter((chunk) => chunk.createdAt >= since).map((chunk) => chunk.content).join("") + "\n";
    }
    const shown = new Set(screen.match(/space_memory:[0-9a-f]{24}/g) ?? []);
    return entries.find((entry) => shown.has(entry.id))?.id ?? null;
  };
}
