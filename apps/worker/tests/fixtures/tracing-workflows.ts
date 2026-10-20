import { continueAsNew, proxyActivities } from "@temporalio/workflow";

// Exercise the production workflow code, not copies or mocked Temporal APIs.
export { dummyTurnWorkflow, codexAppServerTurnWorkflow, dotGoalWorkflow, roomAgentActionWorkflow, roomAgentSupervisorWorkflow } from "../../src/workflows.js";
export { memoryMaintenanceWorkflow, memoryConsolidationWorkflow } from "../../src/memory-maintenance-workflows.js";
export { memoryMutationWorkflow } from "../../src/memory-mutation-workflows.js";

const { traceEcho } = proxyActivities<{ traceEcho(): Promise<string> }>({ startToCloseTimeout: "1 minute" });

/** Exercise production continuation interceptors with two short deterministic runs. */
export async function tracingContinuation(input: { iteration: number; traceparent: string }): Promise<string> {
  if (input.iteration === 0) await continueAsNew<typeof tracingContinuation>({ ...input, iteration: 1 });
  return traceEcho();
}
