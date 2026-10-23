import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as original } from "../../src/workflows.js";

// Deliberately incompatible, test-only command. Never registered by the app.
export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return original(input);
}
