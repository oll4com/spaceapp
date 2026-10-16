import { sleep } from "@temporalio/workflow";
import { dotGoalWorkflow as productionDotGoalWorkflow } from "../../src/workflows.js";

// Deliberately incompatible, test-only code. The added command must fail replay
// of the production history; never record this variant as a replacement golden.
/**
 * Adds an unpatched timer before the real goal workflow to prove that replay
 * rejects an incompatible command sequence. Never use this entry to record goldens.
 */
export async function dotGoalWorkflow(input: { goalId: string }) {
  await sleep("1 second");
  return productionDotGoalWorkflow(input);
}
