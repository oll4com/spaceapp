// Deliberately incompatible test-only code: never registered by the application.
import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as realDotGoalWorkflow } from "../../src/workflows.js";

export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return realDotGoalWorkflow(input);
}
