import { continueAsNew, executeChild, proxyActivities, workflowInfo } from "@temporalio/workflow";

/** Synthetic activities only: the tracing integration suite needs no database or provider. */
interface TraceActivities {
  retryOnce(input: { prompt: string; filePath: string }): Promise<string>;
  echo(input: { prompt: string; filePath: string }): Promise<string>;
}

export interface TraceWorkflowInput {
  traceparent?: string;
  traceId?: string;
  traceLink?: { traceId: string; spanId: string };
  activityTaskQueue: string;
  childTaskQueue?: string;
  childWorkflowId?: string;
  childTraceparent?: string;
  roomId?: string;
  prompt: string;
  filePath: string;
  url?: string;
}

function activities(input: TraceWorkflowInput) {
  return proxyActivities<TraceActivities>({
    taskQueue: input.activityTaskQueue,
    startToCloseTimeout: "10s",
    retry: { initialInterval: "1ms", maximumInterval: "1ms", maximumAttempts: 2 }
  });
}

/** Activity arguments never carry tracing; child context is explicit only for a later request. */
export async function traceParentWorkflow(input: TraceWorkflowInput): Promise<string[]> {
  const first = await activities(input).retryOnce({ prompt: input.prompt, filePath: input.filePath });
  const second = await executeChild(traceChildWorkflow, {
    taskQueue: input.childTaskQueue!,
    workflowId: input.childWorkflowId!,
    args: [{
      activityTaskQueue: input.activityTaskQueue,
      prompt: input.prompt,
      filePath: input.filePath,
      ...(input.childTraceparent ? { traceparent: input.childTraceparent } : {})
    }]
  });
  return [first, second];
}

export async function traceChildWorkflow(input: TraceWorkflowInput): Promise<string> {
  return activities(input).echo({ prompt: input.prompt, filePath: input.filePath });
}

export interface ContinueTraceInput extends TraceWorkflowInput {
  remaining: number;
}

/** Starts the next run without input trace data; continuation headers must carry it. */
export async function traceContinueWorkflow(input: ContinueTraceInput): Promise<string> {
  await activities(input).echo({ prompt: input.prompt, filePath: input.filePath });
  if (input.remaining > 0) {
    return continueAsNew<typeof traceContinueWorkflow>({
      activityTaskQueue: input.activityTaskQueue,
      prompt: input.prompt,
      filePath: input.filePath,
      remaining: input.remaining - 1
    });
  }
  return workflowInfo().runId;
}

export async function traceSimpleWorkflow(input: TraceWorkflowInput): Promise<string> {
  return activities(input).echo({ prompt: input.prompt, filePath: input.filePath });
}

/** Legacy request workflows forward their original traceparent in activity input. */
export async function traceLegacyWorkflow(input: TraceWorkflowInput): Promise<string> {
  return activities(input).echo(input);
}
