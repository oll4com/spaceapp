import { continueAsNew, executeChild, proxyActivities, workflowInfo } from "@temporalio/workflow";

interface TraceActivities {
  traceFixtureActivity(input: { marker: string; traceparent?: string; prompt?: string }): Promise<string>;
}

const { traceFixtureActivity } = proxyActivities<TraceActivities>({
  startToCloseTimeout: "10 seconds"
});

export async function traceFixtureChild(input: { marker: string }) {
  return traceFixtureActivity({ marker: input.marker });
}

export async function traceFixtureRoot(input: { traceparent: string }) {
  const first = await traceFixtureActivity({ marker: "root", traceparent: input.traceparent, prompt: "SENSITIVE PROMPT" });
  const second = await executeChild(traceFixtureChild, {
    workflowId: workflowInfo().workflowId + ":child",
    args: [{ marker: "child" }]
  });
  return first + second;
}

export async function traceFixtureContinue(input: { traceparent: string; remaining: number }) {
  await traceFixtureActivity({ marker: "continued" });
  if (input.remaining > 0) return continueAsNew<typeof traceFixtureContinue>({ ...input, remaining: input.remaining - 1 });
  return "final";
}

export async function traceFixtureBackground(input: {
  traceparent: string;
  roomAgentContinuation: { sourceRunId: string; generation: number; sourceTraceparent: string };
}) {
  await traceFixtureActivity({ marker: "background" });
  return "background";
}

export async function traceFixtureRetry(input: { traceparent: string }) {
  return traceFixtureActivity({ marker: "retry", traceparent: input.traceparent });
}
