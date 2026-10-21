import { proxyActivities, executeChild, continueAsNew } from "@temporalio/workflow";

const { runSyntheticActivity } = proxyActivities<{
  runSyntheticActivity(value: { traceparent: string; prompt: string }): Promise<string>;
}>({ startToCloseTimeout: "10 seconds" });

export async function otlpBountyChildWorkflow(input: { traceparent: string; prompt: string }): Promise<string> {
  return runSyntheticActivity(input);
}

export async function otlpBountyRootWorkflow(input: { traceparent: string; prompt: string }): Promise<string> {
  return executeChild(otlpBountyChildWorkflow, { args: [input] });
}

/** Simulates a long-lived Temporal supervisor root with no HTTP W3C input. */
export async function otlpBountySupervisorRootWorkflow(input: { prompt: string }): Promise<string> {
  const result = await executeChild(otlpBountyChildWorkflow, { args: [{ traceparent: "", prompt: input.prompt }] });
  return result;
}

export async function otlpBountyBackgroundWorkflow(input: {
  traceparent: string;
  roomAgentContinuation: { sourceTraceparent: string; sourceRunId: string; generation: number };
}): Promise<string> {
  return "READY";
}

export async function otlpBountyContinueWorkflow(input: { traceparent: string; generation: number }): Promise<string> {
  if (input.generation === 0) return continueAsNew<typeof otlpBountyContinueWorkflow>({ ...input, generation: 1 });
  return "OK";
}
