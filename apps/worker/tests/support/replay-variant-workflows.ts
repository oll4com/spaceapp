/**
 * Negative-control bundle for the replay gate (temporal-replay.test.ts).
 *
 * Exports a dotGoalWorkflow variant that is NOT deterministic-equivalent to
 * the real one: it sleeps one minute before delegating to the real workflow.
 * Replaying a history recorded from the real workflow against this bundle
 * must throw DeterminismViolationError, proving the gate actually detects
 * nondeterministic workflow changes.
 */
import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as realDotGoalWorkflow } from "../../src/workflows.js";

export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {
  await sleep("1 minute");
  return realDotGoalWorkflow(input);
}
