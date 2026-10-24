import { condition, defineSignal, executeChild, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";

type Item = { turn: { traceparent: string; marker: string; prompt: string } };
const queueMission = defineSignal<[Item]>("queue-mission");
const { traceActivity } = proxyActivities<{
  traceActivity(input: { marker?: string; item?: Item }): Promise<string>;
}>({ startToCloseTimeout: "10 seconds" });

export async function traceSupervisorChild(input: { marker: string; turn: Item["turn"] }) {
  return traceActivity({ marker: input.marker });
}

/** Two API-originated signals must keep independent parents. */
export async function roomAgentSupervisorWorkflow() {
  const pending: Item[] = [];
  setHandler(queueMission, item => { pending.push(item); });
  let result = "";
  for (let i = 0; i < 2; i++) {
    await condition(() => pending.length > 0);
    const item = pending.shift()!;
    result += await traceActivity({ item });
    result += await executeChild(traceSupervisorChild, {
      args: [{ marker: item.turn.marker, turn: item.turn }],
      workflowId: workflowInfo().workflowId + ":child-" + i
    });
  }
  return result;
}
