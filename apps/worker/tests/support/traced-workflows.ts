/**
 * Workflows for the workflow-span integration and replay tests. Started by
 * name (string) from the test so the client never imports workflow code; the
 * worker bundles this file with the same workflow interceptor module as
 * production.
 */

import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";

interface EchoInput {
  value: string;
  roomId: string;
  traceparent?: string;
  sourceTraceparent?: string;
  /** Never allowlisted: proves prompts cannot leak into spans. */
  prompt?: string;
}

const { echo } = proxyActivities<{
  echo(input: EchoInput): Promise<string>;
}>({ startToCloseTimeout: "10 seconds", retry: { maximumAttempts: 1 } });

export interface TracedTurnInput extends EchoInput {
  fail?: boolean;
  /** A traceparent of a different trace, as a signalled turn carries. */
  childTraceparent?: string;
}

export async function tracedRootWorkflow(input: TracedTurnInput): Promise<string> {
  await echo({ value: "root", roomId: input.roomId, traceparent: input.traceparent, prompt: input.prompt });
  await executeChild(tracedChildWorkflow, { args: [input] });
  return "done";
}

export async function tracedChildWorkflow(input: TracedTurnInput): Promise<string> {
  await echo({ value: "child", roomId: input.roomId, traceparent: input.traceparent, prompt: input.prompt });
  return "child-done";
}

/**
 * A turn signalled into an observed long-running supervisor: the child run
 * carries a traceparent of a different (newer) request than this workflow's
 * own trace, like a Room Agent turn started through a signal.
 */
export async function tracedMixedWorkflow(input: TracedTurnInput): Promise<string> {
  await echo({ value: "mixed", roomId: input.roomId, prompt: input.prompt });
  await executeChild(tracedChildWorkflow, { args: [{ ...input, traceparent: input.childTraceparent }] });
  return "mixed-done";
}

export async function tracedContinueWorkflow(input: TracedTurnInput & { pass: number }): Promise<string> {
  await echo({ value: "continue-" + input.pass, roomId: input.roomId, traceparent: input.traceparent, prompt: input.prompt });
  if (input.pass < 1) return continueAsNew<typeof tracedContinueWorkflow>({ ...input, pass: input.pass + 1 });
  return "continued";
}
