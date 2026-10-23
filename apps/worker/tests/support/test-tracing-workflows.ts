import { proxyActivities } from "@temporalio/workflow";

const { executeMockActivity, executeArglessMockActivity } = proxyActivities<{
  executeMockActivity(input: { traceparent: string; roomId: string }): Promise<{ status: string; ok: boolean }>;
  executeArglessMockActivity(input: { actionId: string; roomId: string }): Promise<{ status: string; ok: boolean }>;
}>({
  startToCloseTimeout: "10s"
});

export async function testTraceWorkflow(input: {
  traceparent: string;
  roomId: string;
  missionId: string;
}): Promise<{ success: boolean }> {
  await executeMockActivity({ traceparent: input.traceparent, roomId: input.roomId });
  await executeArglessMockActivity({ actionId: "action:bg-1", roomId: input.roomId });
  return { success: true };
}
