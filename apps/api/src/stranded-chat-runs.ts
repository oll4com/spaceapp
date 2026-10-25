import type { DotsRepository } from "@space/db";

/** What Temporal reports for a Chat run's turn workflow. UNKNOWN (Temporal
 * unreachable or any other error) never changes a run. */
export type ChatRunWorkflowState = "RUNNING" | "CLOSED" | "NOT_FOUND" | "UNKNOWN";

export const strandedQueuedRunMessage = "This task did not start because the agent runtime never received it. Retry it.";
export const lostRunningRunMessage =
  "The agent runtime stopped before recording this task's outcome. The result is unknown: review the conversation and workspace before retrying.";

export interface StrandedChatRunSweepDeps {
  repository: Pick<DotsRepository, "listStaleQueuedRuns" | "failStrandedRun" | "listStaleRunningRuns" | "failLostRunningRun">;
  workflowState(workflowId: string): Promise<ChatRunWorkflowState>;
  store: {
    updateSpaceAgentMessage(messageId: string, input: { status: "FAILED"; content: string }): unknown;
    getSpaceAgentSession(sessionId: string): Promise<{ status: string } | null> | { status: string } | null;
    updateSpaceAgentSession(sessionId: string, input: { status: "READY"; lastSyncedAt: string }): unknown;
  };
  warn(fields: Record<string, unknown>, message: string): void;
  now?: () => string;
}

/**
 * Reconciles Chat runs that no workflow will ever finish. Both cases need
 * Temporal to confirm that the run's workflow is closed or unknown; a RUNNING
 * or unreachable workflow leaves the run untouched.
 * - QUEUED: the API accepted the run but its workflow never started (for
 *   example the API stopped after persisting it). Nothing ran: offer a retry.
 * - RUNNING: the turn started, but its workflow ended without recording an
 *   outcome (for example a single-attempt CLI or OpenCode turn whose worker was
 *   killed). The prompt may have been processed, so the outcome is unknown and
 *   the operator decides; nothing is retried automatically.
 * Each change is a compare-and-set on the run status, so a sweep never
 * overwrites a run that a worker moved on in the meantime.
 */
export async function sweepStrandedChatRuns(deps: StrandedChatRunSweepDeps): Promise<{ queuedFailed: string[]; runningFailed: string[] }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const queuedFailed: string[] = [];
  const runningFailed: string[] = [];
  const settle = async (run: { runId: string; sessionId: string; responseMessageId: string }, message: string) => {
    await Promise.resolve().then(() => deps.store.updateSpaceAgentMessage(run.responseMessageId, { status: "FAILED", content: message }))
      .catch(() => undefined);
    const session = await deps.store.getSpaceAgentSession(run.sessionId);
    if (session?.status === "RUNNING") await deps.store.updateSpaceAgentSession(run.sessionId, { status: "READY", lastSyncedAt: now() });
  };
  for (const run of await deps.repository.listStaleQueuedRuns(180, 20)) {
    const state = await deps.workflowState(run.workflowId);
    // Stranded: no workflow at all, or a workflow that already closed without ever starting the run.
    if (state !== "NOT_FOUND" && state !== "CLOSED") continue;
    if (!await deps.repository.failStrandedRun(run.runId, strandedQueuedRunMessage)) continue;
    await settle(run, strandedQueuedRunMessage);
    queuedFailed.push(run.runId);
    deps.warn({ runId: run.runId }, "Failed a stranded QUEUED Chat run with no Temporal workflow.");
  }
  for (const run of await deps.repository.listStaleRunningRuns(180, 20)) {
    const state = await deps.workflowState(run.workflowId);
    if (state !== "NOT_FOUND" && state !== "CLOSED") continue;
    if (!await deps.repository.failLostRunningRun(run.runId, lostRunningRunMessage)) continue;
    await settle(run, lostRunningRunMessage);
    runningFailed.push(run.runId);
    deps.warn({ runId: run.runId, workflowState: state }, "Failed a RUNNING Chat run whose Temporal workflow ended without an outcome.");
  }
  return { queuedFailed, runningFailed };
}
