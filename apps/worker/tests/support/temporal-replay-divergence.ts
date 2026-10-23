import { sleep } from "@temporalio/workflow";
import { dummyTurnWorkflow as productionDummyTurnWorkflow } from "../../src/workflows.js";
import type { DummyTurnInput } from "@space/contracts";

// Deliberately incompatible, test-only code with the same registered workflow name.
export async function dummyTurnWorkflow(input: DummyTurnInput) {
  await sleep("1 second");
  return productionDummyTurnWorkflow(input);
}
