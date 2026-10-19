export {
  dummyTurnWorkflow, codexAppServerTurnWorkflow, dotGoalWorkflow,
  roomAgentSupervisorWorkflow, roomAgentActionWorkflow
} from "../../src/workflows.js";
export { memoryMaintenanceWorkflow, memoryConsolidationWorkflow } from "../../src/memory-maintenance-workflows.js";
export { memoryMutationWorkflow } from "../../src/memory-mutation-workflows.js";

import { ApplicationFailure, CancelledFailure, ContinueAsNew, continueAsNew } from "@temporalio/workflow";

// A continue-as-new attempt can be caught by workflow code. Telemetry must
// classify the actual completion boundary, not the attempted outbound command.
export async function caughtContinuationWorkflow(outcome: "COMPLETED" | "FAILED" | "CANCELLED") {
  try { await continueAsNew<typeof caughtContinuationWorkflow>(outcome); }
  catch (error) {
    if (!(error instanceof ContinueAsNew)) throw error;
    if (outcome === "FAILED") throw ApplicationFailure.nonRetryable("Synthetic terminal failure");
    if (outcome === "CANCELLED") throw new CancelledFailure("Synthetic cancellation");
    return "recovered";
  }
}
