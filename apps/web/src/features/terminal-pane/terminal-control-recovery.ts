/**
 * Client-side recovery for terminal control denials.
 *
 * The API owns a short-lived terminal control lease (`cliTerminalControlLeaseTtlSeconds`
 * = 30s in apps/api/src/cli-terminal.ts). A mutation that arrives without a live
 * lease is rejected with `CLI_CONTROL_REQUIRED` / `CLI_LEASE_STALE`, and the
 * operator's input used to vanish with no message at all.
 *
 * Live incident 2026-09-20 (DeepSeek protected setup pane): the control lease for
 * the pane expired between renewals, the pasted API key was rejected by the API
 * and dropped by the client, and the operator saw nothing happen. The fix has two
 * halves: keep controller heartbeats safely inside the lease TTL
 * (`hidden-warm-socket.ts`) and re-queue a mutation that was denied for control
 * reasons instead of dropping it.
 */

/** Replay window: a denial only re-sends an input the client sent moments ago. */
export const terminalControlDenialReplayWindowMs = 10_000;

/** Attempts allowed inside the budget window before the client stops retrying. */
export const terminalControlDenialReplayMaxAttempts = 2;

/** Budget window: a later, unrelated lease loss starts with a fresh allowance. */
export const terminalControlDenialReplayBudgetWindowMs = 60_000;

export interface RecordedTerminalControlMutation {
  data: string;
  source: string;
  display: "visible" | "hidden";
  preserveNotice: boolean;
  options: { turnMarker?: string; trackDraft?: boolean };
  leaseId: string | null;
  sentAtMs: number;
}

export interface TerminalControlReplayBudget {
  attempts: number;
  windowStartedAtMs: number;
}

export type TerminalControlDenialReplayReason =
  | "REPLAY"
  | "NOT_A_CONTROL_DENIAL"
  | "NO_PENDING_MUTATION"
  | "STALE_MUTATION"
  | "REPLAY_BUDGET_EXHAUSTED";

/** Control denials that mean "this mutation had no live lease" and can be retried. */
export function isRecoverableTerminalControlDenial(code: string): boolean {
  return code === "CLI_CONTROL_REQUIRED" || code === "CLI_LEASE_STALE";
}

function effectiveReplayAttempts(budget: TerminalControlReplayBudget, nowMs: number): number {
  return nowMs - budget.windowStartedAtMs > terminalControlDenialReplayBudgetWindowMs
    ? 0
    : budget.attempts;
}

export function terminalControlDenialReplay(input: {
  code: string;
  record: RecordedTerminalControlMutation | null;
  nowMs: number;
  replayBudget: TerminalControlReplayBudget;
}): TerminalControlDenialReplayReason {
  if (!isRecoverableTerminalControlDenial(input.code)) return "NOT_A_CONTROL_DENIAL";
  const record = input.record;
  if (!record) return "NO_PENDING_MUTATION";
  if (input.nowMs - record.sentAtMs > terminalControlDenialReplayWindowMs) return "STALE_MUTATION";
  if (effectiveReplayAttempts(input.replayBudget, input.nowMs) >= terminalControlDenialReplayMaxAttempts) {
    return "REPLAY_BUDGET_EXHAUSTED";
  }
  return "REPLAY";
}

export function nextTerminalControlReplayBudget(
  budget: TerminalControlReplayBudget,
  nowMs: number
): TerminalControlReplayBudget {
  return nowMs - budget.windowStartedAtMs > terminalControlDenialReplayBudgetWindowMs
    ? { attempts: 1, windowStartedAtMs: nowMs }
    : { attempts: budget.attempts + 1, windowStartedAtMs: budget.windowStartedAtMs };
}
