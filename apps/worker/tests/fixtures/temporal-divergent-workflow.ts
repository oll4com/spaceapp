import { proxyActivities, sleep } from "@temporalio/workflow";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<{
  recordDummyTurnStarted(input: unknown): Promise<void>;
  recordDummyTurnCompleted(input: unknown): Promise<unknown>;
}>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });

/** Test-only incompatible version: production starts an activity, not a timer. */
export async function dummyTurnWorkflow(input: unknown): Promise<unknown> {
  await sleep("1 second");
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
