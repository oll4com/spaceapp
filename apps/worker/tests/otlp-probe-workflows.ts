import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";

export interface OtlpProbeInput {
  traceparent: string;
  traceId: string;
  prompt?: string;
}

const flaky = proxyActivities<{ otlpFlakyActivity(): Promise<string> }>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 2, initialInterval: "1 millisecond", backoffCoefficient: 1 }
});

const once = proxyActivities<{ otlpOnceActivity(label: string): Promise<string> }>({
  startToCloseTimeout: "20 seconds",
  retry: { maximumAttempts: 1 }
});

/** Parent workflow: one retried activity, then a child workflow on the same trace. */
export async function otlpParentWorkflow(input: OtlpProbeInput): Promise<string> {
  await flaky.otlpFlakyActivity();
  return executeChild(otlpChildWorkflow, {
    workflowId: `otlp-child:${input.traceId}`,
    args: [input]
  });
}

export async function otlpChildWorkflow(input: OtlpProbeInput): Promise<string> {
  return once.otlpOnceActivity("child");
}

/** First run continues as new; the next run links back to this one. */
export async function otlpContinueWorkflow(input: OtlpProbeInput & { remaining: number }): Promise<string> {
  if (input.remaining > 0) {
    await continueAsNew<typeof otlpContinueWorkflow>({ ...input, remaining: input.remaining - 1 });
  }
  await once.otlpOnceActivity("continued");
  return "done";
}

/** Background continuation: own W3C trace, span link to the caller's traceparent. */
export async function otlpBackgroundWorkflow(
  input: OtlpProbeInput & { roomAgentContinuation: { sourceRunId: string; generation: number } }
): Promise<string> {
  return once.otlpOnceActivity("background");
}
