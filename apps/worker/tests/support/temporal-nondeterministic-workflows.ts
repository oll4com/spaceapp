import { sleep } from "@temporalio/workflow";
import { dummyTurnWorkflow as original } from "../../src/workflows.js";
import type { DummyTurnInput } from "@space/contracts";

// Deliberately incompatible with the committed dummy-turn history.
export async function dummyTurnWorkflow(input: DummyTurnInput) {
  await sleep("1 second");
  return original(input);
}
