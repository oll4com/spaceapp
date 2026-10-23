// Deliberately incompatible workflow code used only by the replay guard test.
import { proxyActivities } from "@temporalio/workflow";
import type { DummyTurnInput, DummyTurnResult } from "@space/contracts";

const { recordDummyTurnStarted, recordDummyTurnCompleted, unexpectedReplayActivity } = proxyActivities<{
  recordDummyTurnStarted(input: DummyTurnInput): Promise<unknown>;
  recordDummyTurnCompleted(input: DummyTurnInput): Promise<DummyTurnResult>;
  unexpectedReplayActivity(): Promise<void>;
}>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 }
});

/** Inserts a different first activity to prove replay compares activity types, not only command kinds. */
export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {
  // Same command kind, but an activity type absent from the recorded history.
  await unexpectedReplayActivity();
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
