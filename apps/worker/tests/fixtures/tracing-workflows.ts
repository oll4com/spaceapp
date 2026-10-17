import { traceWorkflowRequest } from "../../src/workflow-trace-scope.js";
import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";
const { probe } = proxyActivities<{ probe(): Promise<string> }>({ startToCloseTimeout: "5s", retry: { maximumAttempts: 2, initialInterval: "1ms" } });
export async function continuingTrace(input: { remaining: number; traceparent?: string }): Promise<string> {
  await probe();
  if (input.remaining > 0) return continueAsNew<typeof continuingTrace>({ remaining: input.remaining - 1 });
  return "complete";
}
export async function backgroundTrace(input: { turn: { traceparent: string; roomAgentContinuation: { sourceTraceparent: string } } }) {
  return executeChild(continuingTrace, { args: [{ ...input.turn, remaining: 0 }] });
}

export async function laterRequestTrace(input: { traceparent: string; later: { traceparent: string } }) {
  const { perRequest } = proxyActivities<{ perRequest(input: { traceparent: string }): Promise<void> }>({ startToCloseTimeout: "5s" });
  await traceWorkflowRequest(input.later, async () => { await perRequest(input.later); await perRequest(input.later); });
  return "ok";
}

export async function recoverableTaskFailure(): Promise<void> { throw new TypeError("private bug details"); }
