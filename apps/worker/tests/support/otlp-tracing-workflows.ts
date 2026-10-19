// Test-only workflows for the OTLP tracing integration test: a parent with a
// stub activity, a retried activity and a child workflow, a run that continues
// as new once, and a background continuation. No Space services involved.
import { continueAsNew, executeChild, proxyActivities, workflowInfo } from "@temporalio/workflow";

export interface TracedInput {
  traceId: string;
  roomId: string;
  paneId: string;
  traceparent?: string;
  continuationTraceparent?: string;
  // Canary values: must never reach the collector.
  prompt?: string;
  filePath?: string;
  url?: string;
}

export interface TracingStubActivities {
  stubStep(input: TracedInput): Promise<string>;
  flakyStep(input: TracedInput): Promise<string>;
}

const { stubStep, flakyStep } = proxyActivities<TracingStubActivities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 3, initialInterval: "10 milliseconds", backoffCoefficient: 1 }
});

export async function tracedParentWorkflow(input: TracedInput): Promise<string> {
  await stubStep(input);
  await flakyStep(input);
  await executeChild(tracedChildWorkflow, {
    args: [{ traceId: input.traceId, roomId: input.roomId, paneId: input.paneId }],
    workflowId: `${workflowInfo().workflowId}:child`
  });
  return "parent-done";
}

export async function tracedChildWorkflow(input: TracedInput): Promise<string> {
  await stubStep(input);
  return "child-done";
}

export async function tracedContinueWorkflow(input: { iteration: number; traceparent?: string }): Promise<number> {
  if (input.iteration === 0) await continueAsNew<typeof tracedContinueWorkflow>({ iteration: 1 });
  return input.iteration;
}

export async function tracedContinuationWorkflow(input: TracedInput): Promise<string> {
  await stubStep(input);
  return "continuation-done";
}

export { memoryMaintenanceWorkflow, memoryConsolidationWorkflow } from "../../src/memory-maintenance-workflows.js";
