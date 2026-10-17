import {
  ApplicationFailure,
  continueAsNew,
  executeChild,
  proxyActivities
} from "@temporalio/workflow";
import type * as activities from "./otlp-test-activities.js";

const { flakyProbeActivity, echoProbeActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30s",
  retry: {
    initialInterval: "20ms",
    maximumAttempts: 3
  }
});

export interface ProbeWorkflowInput {
  workflowId?: string;
  traceparent?: string;
  roomId?: string;
  paneId?: string;
  missionId?: string;
  turnId?: string;
  actionId?: string;
  secretPrompt?: string;
  runChildWorkflow?: boolean;
}

export async function otlpTraceProbeWorkflow(input: ProbeWorkflowInput = {}): Promise<{ status: string; childResult?: unknown }> {
  // Executes flaky activity that fails attempt 1 and succeeds attempt 2
  await flakyProbeActivity({
    roomId: input.roomId,
    paneId: input.paneId,
    missionId: input.missionId,
    turnId: input.turnId,
    actionId: input.actionId,
    secretPrompt: input.secretPrompt
  });

  let childResult: unknown;
  if (input.runChildWorkflow) {
    childResult = await executeChild(otlpTraceChildWorkflow, {
      args: [{ message: "from-parent", secretPrompt: input.secretPrompt }]
    });
  }

  return { status: "COMPLETED", childResult };
}

export async function otlpTraceChildWorkflow(input: { message?: string; secretPrompt?: string } = {}): Promise<{ status: string; echoed: string }> {
  return await echoProbeActivity({ message: input.message, secretPrompt: input.secretPrompt });
}

export interface ContinueAsNewWorkflowInput {
  iteration: number;
  maxIterations: number;
  traceparent?: string;
}

export async function otlpContinueAsNewProbeWorkflow(input: ContinueAsNewWorkflowInput): Promise<string> {
  if (input.iteration < input.maxIterations) {
    return await continueAsNew<typeof otlpContinueAsNewProbeWorkflow>({
      iteration: input.iteration + 1,
      maxIterations: input.maxIterations,
      traceparent: input.traceparent
    });
  }
  return "continue-as-new-done";
}

export interface BackgroundContinuationWorkflowInput {
  roomAgentContinuation: {
    sourceRunId: string;
    generation: number;
  };
  traceId: string;
  traceparent: string;
  secretPrompt?: string;
}

export async function otlpBackgroundContinuationProbeWorkflow(input: BackgroundContinuationWorkflowInput): Promise<string> {
  await echoProbeActivity({ message: "bg-done", secretPrompt: input.secretPrompt });
  return "bg-continuation-done";
}

export async function otlpFailingProbeWorkflow(input: { reasonCode?: string } = {}): Promise<never> {
  throw ApplicationFailure.nonRetryable("Simulated workflow failure", input.reasonCode ?? "SIMULATED_WORKFLOW_FAILURE");
}
