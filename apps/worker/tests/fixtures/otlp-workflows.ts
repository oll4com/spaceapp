import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";
import { dummyTurnWorkflow } from "../../src/workflows.js";

export { dummyTurnWorkflow };

const { tracedRetry } = proxyActivities<{ tracedRetry(): Promise<string> }>({
  startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 2, initialInterval: "1 second" }
});

export async function tracedRoot(input: { traceparent: string; prompt?: string }): Promise<string> {
  await tracedRetry();
  // Exercise the actual production dummy-turn workflow as a child. Its two
  // activities intentionally receive no business-argument traceparent.
  await executeChild(dummyTurnWorkflow, {
    workflowId: "otlp-child", args: [{ ...input, traceparent: undefined } as never]
  });
  return "complete";
}

export async function tracedContinuation(input: { traceparent: string; generation: number }): Promise<string> {
  await tracedRetry();
  if (input.generation === 0) return continueAsNew<typeof tracedContinuation>({ ...input, generation: 1 });
  return "continued";
}
