import type { Pane, PaneCliSession } from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { claudeNativeSessionIdPattern } from "./claude-native-turns.js";

export interface ClaudeAccountSwitchDeps {
  store: Pick<SpaceStore, "getCliAccountProfile" | "getCliTaskRevision" | "updatePaneCliSession">;
  /** A fresh read; it also records the conversation's native session id on the task revision. */
  inspect(pane: Pane): Promise<{ state: string; usageLimited?: boolean }>;
  /** Space Control's exact native resume of the pane's task, on the given account profile. */
  resume(pane: Pane, input: { taskId: string; accountProfileId: string | null }, traceId: string): Promise<{ pane: Pane }>;
  ensureReady(pane: Pane, traceId: string, selection?: { accountProfileId: string | null }): Promise<unknown>;
  interrupt(sessionId: string): Promise<unknown>;
  now(): string;
}

/**
 * Moves a Claude Code pane to another account profile (operator order 2026-10-19; "main" is its direct account). Every profile
 * shares one transcript store (claude-vscode-parity links projects/ and sessions/; credentials stay per profile), so the CLI
 * restarts on the same conversation. It restarts the CLI, so it runs only at an idle prompt.
 */
export async function switchClaudePaneAccount(deps: ClaudeAccountSwitchDeps, pane: Pane, session: PaneCliSession, accountProfileId: string | null, traceId: string): Promise<boolean> {
  const target = accountProfileId && accountProfileId !== "main" ? accountProfileId : null;
  if (target && !await deps.store.getCliAccountProfile("cli:claude", target)) throw new SpaceConflictError(`Claude Code account profile "${target}" was not found.`);
  if ((session.accountProfileId ?? null) === target) return false;
  const observed = await deps.inspect(pane);
  if (observed.state !== "IDLE") {
    // Cleo/Dana 2026-10-21: a turn at its usage limit stayed RUNNING for hours (background agents and shells), and Esc did not end it.
    const limited = observed.state === "RUNNING" && observed.usageLimited ? " It waits at its usage limit while Claude keeps the turn running (background agents or shells),"
      + " so AFTER_TURN fires only when that work ends; otherwise it continues by itself after the limit resets." : "";
    throw new SpaceConflictError(`Switching a Claude Code pane's account restarts its CLI, so it runs only at an idle prompt (state ${observed.state}). Use when AFTER_TURN to switch once the turn ends.${limited}`);
  }
  const revision = session.cliTaskRevisionId ? await deps.store.getCliTaskRevision(session.cliTaskRevisionId) : null;
  if (session.cliTaskId && revision?.nativeTaskRef && claudeNativeSessionIdPattern.test(revision.nativeTaskRef)) {
    const resumed = await deps.resume(pane, { taskId: session.cliTaskId, accountProfileId: target }, traceId);
    await deps.ensureReady(resumed.pane, traceId);
  } else {
    // No written turn yet: a fresh session on the new account (as the pane's own account picker does).
    await deps.interrupt(session.sessionId);
    await deps.store.updatePaneCliSession(session.sessionId, { status: "EXITED", isActive: false, endedAt: deps.now(), statusReason: "Account profile switched" }, traceId);
    await deps.ensureReady(pane, traceId, { accountProfileId: target });
  }
  return true;
}
