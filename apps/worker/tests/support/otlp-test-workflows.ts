import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";
import type * as activities from "./otlp-test-activities.js";

/**
 * Minimal real workflows for the OTLP span integration test. They run in the
 * Temporal sandbox with the production workflow interceptors
 * (src/otlp-workflow-interceptors.ts) and call stub activities: the activity
 * arguments deliberately carry a prompt string so the tests can prove prompts
 * are never exported as span attributes. The traceparent travels in the
 * activity arguments, mirroring how production turn workflows pass the turn
 * input (which carries the traceparent) to their activities.
 */

const { flakyProbe, echoProbe } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "100 milliseconds", backoffCoefficient: 1, maximumAttempts: 3 }
});

export interface OtlpProbeInput {
  traceparent?: string;
  roomId?: string;
  continueOnce?: boolean;
}

export async function otlpTraceChildWorkflow(input: OtlpProbeInput): Promise<string> {
  return echoProbe({ traceparent: input.traceparent, roomId: input.roomId, prompt: "child secret prompt that must never be exported" });
}

export async function otlpTraceProbeWorkflow(input: OtlpProbeInput): Promise<string> {
  await flakyProbe({ traceparent: input.traceparent, roomId: input.roomId, prompt: "parent secret prompt that must never be exported" });
  const childResult = await executeChild(otlpTraceChildWorkflow, { args: [{ traceparent: input.traceparent, roomId: input.roomId }] });
  if (input.continueOnce) {
    await continueAsNew<typeof otlpTraceProbeWorkflow>({ ...input, continueOnce: false });
  }
  return childResult;
}
