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
 * Test-only variant of dotGoalWorkflow that injects an unpatched timer before
 * running the production workflow body, used to verify that replay determinism
 * gating rejects unpatched workflow timer changes.
 */
export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {
  await sleep("1 second");
  return productionDotGoalWorkflow(input);
}

/**
 * Test-only variant of dummyTurnWorkflow that schedules an extra activity
 * before the original sequence, used to verify that replay determinism gating
 * rejects unpatched workflow activity changes.
 */
export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {
  await recordDummyTurnCompleted(input);
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
