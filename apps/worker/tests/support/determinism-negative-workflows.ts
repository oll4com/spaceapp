import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as production } from "../../src/workflows.js";

// Deliberately incompatible test-only change: never use this as production code.
/**
 * Insert one extra durable timer before the production DOT workflow in this test-only bundle.
 * Replaying the unchanged baseline must reject this incompatible command sequence.
 */
export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return production(input);
}
