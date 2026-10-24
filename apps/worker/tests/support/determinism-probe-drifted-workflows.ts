import { proxyActivities, sleep } from "@temporalio/workflow";
import type * as activities from "../../src/activities.js";

const probeActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 }
});

/**
 * Intentionally drifted copy of `determinism-probe-workflows.ts`: one extra
 * `sleep("2 seconds")` before the recorded activity calls. Replaying the
 * recorded probe history against this module must throw a
 * DeterminismViolationError (the negative determinism gate).
 */
export async function determinismProbeWorkflow(input: { traceId: string }): Promise<{ ok: true }> {
  await sleep("2 seconds");
  await probeActivities.recordDummyTurnStarted({ traceId: input.traceId } as never);
  await probeActivities.recordDummyTurnCompleted({ traceId: input.traceId } as never);
  return { ok: true };
}
