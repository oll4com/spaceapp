// Deliberate TEST ONLY incompatibility: same workflow name as the recorded
// dummyTurnWorkflow but an extra timer before its original activity commands.
import { proxyActivities, sleep } from "@temporalio/workflow";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<{
  recordDummyTurnStarted(input: unknown): Promise<void>;
  recordDummyTurnCompleted(input: unknown): Promise<unknown>;
}>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });

export async function dummyTurnWorkflow(input: unknown): Promise<unknown> {
  await sleep("1 second");
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
