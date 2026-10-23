/**
 * Test-only workflow module for the replay gate's negative case.
 *
 * Same exported name as the recorded history, but the workflow now schedules an
 * extra activity before the recorded one. Replaying a history with no such
 * command must fail with a determinism violation, which proves the gate is
 * wired to real replay.
 */
import { proxyActivities } from "@temporalio/workflow";

const { recordDummyTurnStarted, recordDummyTurnCompleted, extraUnrecordedActivity } =
  proxyActivities<{
    recordDummyTurnStarted(input: unknown): Promise<{ workflowId: string }>;
    recordDummyTurnCompleted(input: unknown): Promise<unknown>;
    extraUnrecordedActivity(input: unknown): Promise<void>;
  }>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });

export async function dummyTurnWorkflow(input: unknown): Promise<unknown> {
  // The command the recorded history does not contain.
  await extraUnrecordedActivity(input);
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
