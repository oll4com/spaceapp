import { sleep } from "@temporalio/workflow";
export * from "../temporal-workflow-entry.js";

/**
 * Intentionally modified dotGoalWorkflow variant introducing an extra sleep timer
 * at the start, as instructed in issue #60, to prove replay determinism failure.
 *
 * @param _input Goal workflow input containing goalId.
 * @returns Status of the completed goal.
 */
export async function dotGoalWorkflow(_input: { goalId: string }): Promise<{ goalStatus: string }> {
  await sleep("1 second");
  return { goalStatus: "COMPLETED" };
}
