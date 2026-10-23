/**
 * Test-only workflow variants used by the replay gate's negative test.
 *
 * `dotGoalWorkflow` here is identical to production except for one extra
 * timer at the start. Replaying a history recorded from the production
 * workflow against this code must fail with a determinism error: that failure
 * is what proves the replay gate actually gates.
 */
import {
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo
} from "@temporalio/workflow";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import type * as activities from "../../src/activities.js";
import { runDotGoalLoop } from "../../src/dot-goal-loop.js";

const dotGoalActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 20, initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" }
});

const dotGoalWakeSignal = defineSignal<[]>(DOT_GOAL_SIGNAL);

export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {
  // NON-DETERMINISM ON PURPOSE: production dotGoalWorkflow has no such timer.
  await sleep("1 second");
  let woken = false;
  setHandler(dotGoalWakeSignal, () => {
    woken = true;
  });
  const result = await runDotGoalLoop(
    input.goalId,
    {
      step: (goalId) => dotGoalActivities.dotGoalStep(goalId),
      observe: (goalId, runId) => dotGoalActivities.dotGoalObserve(goalId, runId),
      wait: async (timeout) => {
        await condition(() => woken, timeout);
        woken = false;
      },
      shouldContinueAsNew: () =>
        workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > 10_000
    },
    300
  );
  return { goalStatus: result.goalStatus ?? "UNKNOWN" };
}

export {
  codexAppServerTurnWorkflow,
  dummyTurnWorkflow,
  roomAgentActionWorkflow,
  roomAgentSupervisorWorkflow
} from "../../src/workflows.js";
export {
  memoryConsolidationWorkflow,
  memoryMaintenanceWorkflow
} from "../../src/memory-maintenance-workflows.js";
export { memoryMutationWorkflow } from "../../src/memory-mutation-workflows.js";
