import { proxyActivities, sleep } from "@temporalio/workflow";

const activities = proxyActivities<{
  recordDummyTurnStarted(input: unknown): Promise<void>;
  recordDummyTurnCompleted(input: unknown): Promise<unknown>;
}>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });

/** Deliberately incompatible test-only variant, never registered by a live worker. */
export async function dummyTurnWorkflow(input: unknown): Promise<unknown> {
  await sleep("1 second");
  await activities.recordDummyTurnStarted(input);
  return activities.recordDummyTurnCompleted(input);
}
