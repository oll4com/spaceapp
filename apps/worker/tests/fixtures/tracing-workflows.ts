import { continueAsNew, executeChild, proxyActivities, uuid4, workflowInfo } from "@temporalio/workflow";
export {
  codexAppServerTurnWorkflow, roomAgentSupervisorWorkflow, roomAgentActionWorkflow, dotGoalWorkflow
} from "../../src/workflows.js";
export { memoryMaintenanceWorkflow, memoryConsolidationWorkflow } from "../../src/memory-maintenance-workflows.js";
export { memoryMutationWorkflow } from "../../src/memory-mutation-workflows.js";

const { tracingActivity } = proxyActivities<{
  tracingActivity(input: Record<string, unknown>): Promise<unknown>;
}>({ startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 2, initialInterval: "10 ms" } });

export async function tracingChildWorkflow(input: Record<string, unknown>) {
  return tracingActivity(input);
}

export async function tracingTreeWorkflow(input: Record<string, unknown>) {
  await tracingActivity({ ...input, retry: true });
  await executeChild(tracingChildWorkflow, { workflowId: `child:${uuid4()}`, args: [input] });
  await executeChild(tracingChildWorkflow, {
    workflowId: `background:${workflowInfo().runId}`, args: [{ ...input, traceId: "trace:bg-test" }]
  });
  return "done";
}

export async function tracingContinuedWorkflow(input: Record<string, unknown>, generation = 0): Promise<unknown> {
  await tracingActivity(input);
  if (generation === 0) return continueAsNew<typeof tracingContinuedWorkflow>(input, 1);
  return "continued";
}
