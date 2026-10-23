import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as realDotGoalWorkflow } from "../../src/workflows.js";

// Deliberately incompatible, and only registered by the negative replay test.
// There is no patch marker protecting this added command.
export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return realDotGoalWorkflow(input);
}
