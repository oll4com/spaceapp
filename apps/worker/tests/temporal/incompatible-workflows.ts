import { sleep, proxyActivities } from "@temporalio/workflow";

// Deliberately incompatible with the saved dummyTurnWorkflow history. This must
// fail replay with a determinism violation, not an import/registration error.
export async function dummyTurnWorkflow(input: unknown) {
  await sleep("1 second");
  const activities = proxyActivities<{
    recordDummyTurnStarted(input: unknown): Promise<void>;
    recordDummyTurnCompleted(input: unknown): Promise<unknown>;
  }>({ startToCloseTimeout: "1 minute", retry: { maximumAttempts: 3 } });
  await activities.recordDummyTurnStarted(input);
  return activities.recordDummyTurnCompleted(input);
}
