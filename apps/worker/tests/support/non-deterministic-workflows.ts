/**
 * @fileoverview Test-only workflows with injected nondeterminism (unpatched timers and activity calls).
 * Used by the replay determinism gate to prove that Worker.runReplayHistories fails with
 * DeterminismViolationError when workflow logic changes without a replay-safe patch.
 */

import { proxyActivities, sleep } from "@temporalio/workflow";
import type { DummyTurnInput, DummyTurnResult } from "@space/contracts";
import type * as activities from "../../src/activities.js";
import { dotGoalWorkflow as productionDotGoalWorkflow } from "../../src/workflows.js";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 3
  }
});

/**
 * Test-only variant of dotGoalWorkflow that injects an unpatched sleep timer before
 * executing the production workflow body, proving that unexpected timer events fail replay.
 * @param input - Workflow input containing goalId
 * @returns Workflow result
 */
export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {
  await sleep("1 second");
  return productionDotGoalWorkflow(input);
}

/**
 * Test-only variant of dummyTurnWorkflow that schedules an extra activity invocation
 * before the standard sequence, proving that unexpected activity events fail replay.
 * @param input - Workflow input containing runId, threadId, userMessage
 * @returns Workflow result
 */
export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {
  await recordDummyTurnCompleted(input);
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
