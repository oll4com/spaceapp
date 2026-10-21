import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";
import { ApplicationFailure } from "@temporalio/common";

const activities = proxyActivities<{ echo(value: unknown): Promise<unknown>; retry(): Promise<void> }>({
  startToCloseTimeout: "10 seconds", retry: { initialInterval: "1 second", maximumAttempts: 2 }
});

export async function tracedChild(input: unknown): Promise<unknown> { return activities.echo(input); }

export async function tracedRoot(input: { traceparent?: string; childTraceparent?: string; continue?: boolean }): Promise<unknown> {
  await activities.echo({ prompt: "PRIVATE PROMPT", path: "/home/private", url: "https://private.example" });
  await activities.retry();
  await executeChild(tracedChild, { args: [{ traceparent: input.childTraceparent ?? input.traceparent }] });
  if (input.continue) return continueAsNew<typeof tracedRoot>({ ...input, continue: false });
  return "done";
}

export async function tracedFailure(): Promise<unknown> { throw ApplicationFailure.nonRetryable("PRIVATE ERROR /home/private", "WORKFLOW_ERROR"); }
