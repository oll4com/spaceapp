import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../../src/activities.js";
import type { DummyTurnInput, DummyTurnResult } from "@space/contracts";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 3 }
});

/**
 * Deliberately incompatible test-only workflow used by the replay gate's
 * negative assertion. It adds a timer before the first activity, so a history
 * recorded by the production dummy workflow must fail determinism checking.
 */
export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {
  await sleep("1 second");
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}
