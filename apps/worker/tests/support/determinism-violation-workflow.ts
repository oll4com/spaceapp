/**
 * TEST-ONLY workflow variant used by the replay gate's negative test
 * (issue #60): identical to dotGoalWorkflow from src/workflows.ts, but it
 * schedules one extra timer at the start. Replaying a history recorded
 * from the real workflow against this variant must fail with
 * DeterminismViolationError - proving the gate actually detects
 * non-replay-compatible changes instead of silently passing.
 */
import { condition, continueAsNew, defineSignal, proxyActivities, setHandler, sleep, workflowInfo } from "@temporalio/workflow";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import type * as activities from "../../src/activities.js";
import { runDotGoalLoop } from "../../src/dot-goal-loop.js";

const dotGoalActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 20, initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" }
});
export const dotGoalWakeSignal = defineSignal<[]>(DOT_GOAL_SIGNAL);

export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {
  // The deliberate replay violation: an extra timer the recorded history
  // does not contain.
  await sleep("1 second");
  let woken = false;
  setHandler(dotGoalWakeSignal, () => { woken = true; });
  const result = await runDotGoalLoop(input.goalId, {
    step: (goalId) => dotGoalActivities.dotGoalStep(goalId),
    observe: (goalId, runId) => dotGoalActivities.dotGoalObserve(goalId, runId),
    wait: async (timeout) => { await condition(() => woken, timeout); woken = false; },
    shouldContinueAsNew: () => workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > 10_000
  }, 300);
  if (result.goalStatus === null) await continueAsNew<typeof dotGoalWorkflow>({ goalId: input.goalId });
  return { goalStatus: result.goalStatus ?? "UNKNOWN" };
}
