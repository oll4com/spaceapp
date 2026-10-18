import { continueAsNew, executeChild, proxyActivities, startChild } from "@temporalio/workflow";
import type * as activities from "./workflow-tracing-activity.js";
import { contextFromTraceparent, runSpanId } from "../src/workflow-trace-context.js";

const { recordTraceActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 seconds",
  retry: { maximumAttempts: 2, initialInterval: "1 millisecond" }
});

export interface TraceFixtureInput {
  traceparent?: string;
  missionTraceparent?: string;
  backgroundTraceparent?: string;
  prompt?: string;
  modelOutput?: string;
  filePath?: string;
  rawUrl?: string;
  userText?: string;
  roomAgentContinuation?: {
    sourceRunId: string;
    generation: number;
    sourceSpanContext?: { traceId: string; spanId: string };
  };
}

export async function tracedWorkflow(input: TraceFixtureInput): Promise<string> {
  await recordTraceActivity("retry", input);
  let sourceSpanContext: { traceId: string; spanId: string } | undefined;
  if (input.missionTraceparent) {
    const mission = await startChild(tracedChildWorkflow, {
      workflowId: "trace-child:mission",
      args: [{ ...input, traceparent: input.missionTraceparent, roomAgentContinuation: undefined }]
    });
    await mission.result();
    const sourceTrace = contextFromTraceparent(input.missionTraceparent);
    if (sourceTrace) sourceSpanContext = { traceId: sourceTrace.traceId, spanId: runSpanId(mission.firstExecutionRunId) };
  }
  if (input.roomAgentContinuation) {
    await executeChild(tracedChildWorkflow, {
      workflowId: "trace-child:" + input.roomAgentContinuation.sourceRunId,
      args: [{
        ...input,
        traceparent: input.backgroundTraceparent,
        roomAgentContinuation: {
          ...input.roomAgentContinuation,
          ...(sourceSpanContext ? { sourceSpanContext } : {})
        }
      }]
    });
  }
  return "done";
}

export async function tracedChildWorkflow(input: TraceFixtureInput): Promise<string> {
  await recordTraceActivity("child", input);
  return "child-done";
}

export async function continuedWorkflow(input: { count: number }): Promise<string> {
  if (input.count === 0) return continueAsNew<typeof continuedWorkflow>({ count: 1 });
  await recordTraceActivity("continued", {});
  return "continued-done";
}
