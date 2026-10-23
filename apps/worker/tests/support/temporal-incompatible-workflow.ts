import { sleep } from "@temporalio/workflow";
import { dummyTurnWorkflow as original } from "../../src/workflows.js";

// Deliberately incompatible, test-only mutation. Never registered in the app.
export async function dummyTurnWorkflow(input: Parameters<typeof original>[0]) {
  await sleep("1 second");
  return original(input);
}
