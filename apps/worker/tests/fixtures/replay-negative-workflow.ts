import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../../../src/activities.js";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 }
});

// Test-only variant of dummyTurnWorkflow. The extra timer is what the replay gate must reject.
export async function dummyTurnWorkflow(input: unknown): Promise<unknown> {
  await sleep("1 second");
  await recordDummyTurnStarted(input as never);
  return recordDummyTurnCompleted(input as never);
}
