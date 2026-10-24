import { condition, continueAsNew, defineQuery, defineSignal, executeChild, proxyActivities, proxyLocalActivities, setHandler, uuid4, workflowInfo } from "@temporalio/workflow";
import { withWorkflowTraceContext } from "../../src/workflow-tracing.js";

export interface TraceTestInput {
  traceId: string;
  traceparent?: string;
  roomId?: string;
  missionId?: string;
  agentRunId?: string;
  continuedTraceparent?: string;
  prompt?: string;
  toolOutput?: string;
  path?: string;
  url?: string;
}

export interface TraceTestActivities {
  noArgumentActivity(): Promise<string>;
  retryOnceActivity(): Promise<string>;
  privateActivity(input: TraceTestInput): Promise<{ status: string; message: string }>;
}

const activities = proxyActivities<TraceTestActivities>({
  startToCloseTimeout: "10 seconds",
  retry: { initialInterval: "10 milliseconds", maximumInterval: "10 milliseconds", maximumAttempts: 2 }
});
const localActivities = proxyLocalActivities<Pick<TraceTestActivities, "noArgumentActivity">>({
  startToCloseTimeout: "10 seconds"
});

// These fixtures execute through the real SDK sandbox and activity executor.
// They deliberately include activities with no arguments: those can only
// inherit tracing through the Temporal headers, not application payloads.
export async function traceTreeWorkflow(input: TraceTestInput): Promise<string[]> {
  const first = await activities.noArgumentActivity();
  const retried = await activities.retryOnceActivity();
  const local = await localActivities.noArgumentActivity();
  await activities.privateActivity(input);
  const child = await executeChild(traceChildWorkflow, {
    workflowId: `${workflowInfo().workflowId}:child`,
    args: []
  });
  return [first, retried, local, child];
}

export async function traceChildWorkflow(): Promise<string> {
  return activities.noArgumentActivity();
}

export async function traceContinueWorkflow(run = 0): Promise<string> {
  await activities.noArgumentActivity();
  if (run === 0) return continueAsNew<typeof traceContinueWorkflow>(1);
  return "continued";
}

export async function traceSingleActivityWorkflow(): Promise<string> {
  return activities.noArgumentActivity();
}

export async function traceRandomActivityIdWorkflow(): Promise<string> {
  // Temporal validates this command identity on replay. Tracing must not
  // consume the deterministic random stream that application code uses.
  return activities.noArgumentActivity.executeWithOptions({ activityId: uuid4() }, []);
}

export async function traceMissionWorkflow(missionCount: number): Promise<number> {
  const queue: TraceTestInput[] = [];
  let completed = 0;
  setHandler(defineSignal<[TraceTestInput]>("traceMission"), (input) => { queue.push(input); });
  setHandler(defineQuery<number>("completedTraceMissions"), () => completed);
  while (completed < missionCount) {
    await condition(() => queue.length > 0);
    const input = queue.shift()!;
    await withWorkflowTraceContext(input, () => activities.noArgumentActivity());
    completed += 1;
  }
  return completed;
}
