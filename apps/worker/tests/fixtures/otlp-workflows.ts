import { continueAsNew, executeChild, proxyActivities } from "@temporalio/workflow";
const { tracedActivity } = proxyActivities<{ tracedActivity(): Promise<string> }>({
  startToCloseTimeout: "10s", retry: { maximumAttempts: 2, initialInterval: "10ms" }
});
export async function tracedChild(_input?: { traceparent: string; missionId: string }): Promise<string> { return tracedActivity(); }
export async function tracedRoot(input: { traceparent?: string; continuation?: boolean; count?: number }): Promise<string> {
  await tracedActivity();
  if (input.continuation && !input.count) return continueAsNew<typeof tracedRoot>({ ...input, count: 1 });
  return executeChild(tracedChild, { args: [] });
}

export async function roomAgentSupervisorWorkflow(input: { items: { traceparent: string; missionId: string }[] }): Promise<void> {
  for (const item of input.items) await executeChild(tracedChild, { args: [item] });
}
