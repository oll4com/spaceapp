import { proxyActivities, sleep } from "@temporalio/workflow";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<any>({
  startToCloseTimeout: "1 minute"
});

/**
 * Intentionally non-deterministic variant of dummyTurnWorkflow that schedules
 * an unexpected timer, violating history determinism during replay.
 */
export async function dummyTurnWorkflow(input: any): Promise<any> {
  await sleep("10 seconds");
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
