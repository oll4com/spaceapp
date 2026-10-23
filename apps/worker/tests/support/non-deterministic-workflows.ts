/** Deliberately incompatible test-only variant. Never registered in the production worker. */
import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as productionDotGoalWorkflow } from "../../src/workflows.js";
export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return productionDotGoalWorkflow(input);
}
