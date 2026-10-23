// Deliberately incompatible workflow code used only by the replay guard test.
import { proxyActivities, sleep } from "@temporalio/workflow";
import type { DummyTurnInput, DummyTurnResult } from "@space/contracts";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<{
  recordDummyTurnStarted(input: DummyTurnInput): Promise<unknown>;
  recordDummyTurnCompleted(input: DummyTurnInput): Promise<DummyTurnResult>;
}>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 }
});

/** Inserts a timer before the normal dummy activities to prove replay rejects an extra durable command. */
export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {
  // The committed history schedules recordDummyTurnStarted here, not a timer.
  await sleep("1 second");
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
