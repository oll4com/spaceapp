import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as productionDotGoalWorkflow } from "../../src/workflows.js";

// Deliberately incompatible with the committed Dot history. Never registered live.
export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return productionDotGoalWorkflow(input);
}
