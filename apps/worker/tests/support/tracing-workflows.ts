import { continueAsNew, executeChild, proxyActivities, proxyLocalActivities } from "@temporalio/workflow";

interface TraceInput {
  traceparent?: string; sourceTraceparent?: string; traceId?: string;
  mode?: "tree" | "continue" | "background" | "requests";
  generation?: number; otherTraceparent?: string; prompt?: string;
}

const activities = proxyActivities<{
  echo(input: TraceInput): Promise<string>;
  retry(input: TraceInput): Promise<string>;
}>({ startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 2, initialInterval: "1 second" } });
const local = proxyLocalActivities<{ echo(input: TraceInput): Promise<string> }>({ startToCloseTimeout: "10 seconds" });

export async function tracingLeafWorkflow(input: TraceInput): Promise<string> {
  return activities.echo(input);
}

export async function tracingWorkflow(input: TraceInput): Promise<string> {
  await activities.echo(input);
  if (input.mode === "continue") {
    if (!input.generation) return continueAsNew<typeof tracingWorkflow>({ ...input, generation: 1 });
  } else if (input.mode === "background") {
    await executeChild(tracingLeafWorkflow, { args: [{ traceId: "trace:bg-synthetic", sourceTraceparent: input.traceparent }] });
  } else if (input.mode === "requests") {
    await executeChild(tracingLeafWorkflow, { args: [{ traceparent: input.traceparent }] });
    await executeChild(tracingLeafWorkflow, { args: [{ traceparent: input.otherTraceparent }] });
  } else {
    await activities.retry(input);
    await executeChild(tracingLeafWorkflow, { args: [{ prompt: input.prompt }] });
    await local.echo(input);
  }
  return "ok";
}
