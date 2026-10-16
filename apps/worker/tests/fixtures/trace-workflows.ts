import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";
const { tracedActivity } = proxyActivities<{ tracedActivity(): Promise<string> }>({ startToCloseTimeout: "10s" });
export async function traceChild(): Promise<string> { return tracedActivity(); }
export async function traceParent(input: { traceparent: string; again: boolean }): Promise<string> {
  await executeChild(traceChild, { args: [] });
  if (input.again) return continueAsNew<typeof traceParent>({ ...input, again: false });
  return "ok";
}
export async function traceBackground(input: { traceparent: string }): Promise<string> {
  return executeChild("traceBackgroundChild", { args: [{ ...input, roomAgentContinuation: { generation: 1 } }] });
}
export async function traceBackgroundChild(): Promise<string> { return tracedActivity(); }
