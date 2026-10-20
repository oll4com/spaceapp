import { continueAsNew, executeChild, proxyActivities, uuid4, workflowInfo } from "@temporalio/workflow";
import { traceWorkflowScope } from "../../src/workflow-trace-scope.js";

interface Input { traceparent?: string; remaining?: number; secret?: string; }
const { traceProbe } = proxyActivities<{ traceProbe(input: Input & { mode: string; marker: string }): Promise<string> }>({
  startToCloseTimeout: "5 seconds", retry: { maximumAttempts: 2, initialInterval: "10 milliseconds" }
});

export async function traceChildWorkflow(input: Input): Promise<string> {
  return traceProbe({ ...input, mode: "child", marker: uuid4() });
}
export async function traceTreeWorkflow(input: Input): Promise<string> {
  if (input.remaining) {
    await traceProbe({ ...input, mode: "continue", marker: uuid4() });
    return continueAsNew<typeof traceTreeWorkflow>({ ...input, remaining: input.remaining - 1 });
  }
  await traceProbe({ ...input, mode: "root", marker: uuid4() });
  return executeChild(traceChildWorkflow, { args: [input], workflowId: `trace-child-${workflowInfo().runId}` });
}
/** UUID is in an activity command, so a shifted random stream fails history replay. */
export async function traceUuidWorkflow(input: Input): Promise<string> {
  return traceProbe({ ...input, mode: "uuid", marker: uuid4() });
}

export async function traceMissionWorkflow(input: { first: Input; second: Input; backgroundTraceId: string }): Promise<void> {
  await traceWorkflowScope(input.first, () => traceProbe({ ...input.first, mode: "mission", marker: uuid4() }));
  const sourceTraceparent = await traceWorkflowScope(input.second, () => traceProbe({ ...input.second, mode: "link-source", marker: uuid4() }));
  await traceWorkflowScope({ roomAgentContinuation: { w3cTraceId: input.backgroundTraceId, sourceTraceparent } },
    () => traceProbe({ mode: "background", marker: uuid4() }));
}
