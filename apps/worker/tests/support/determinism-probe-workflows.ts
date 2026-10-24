import { proxyActivities } from "@temporalio/workflow";
import type * as activities from "../../src/activities.js";

const probeActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 1 }
});

/**
 * Determinism probe: one fixed command sequence. Recorded once; replaying the
 * history must stay green against this module and fail with a
 * DeterminismViolationError against `determinism-probe-drifted-workflows.ts`.
 */
export async function determinismProbeWorkflow(input: { traceId: string }): Promise<{ ok: true }> {
  await probeActivities.recordDummyTurnStarted({ traceId: input.traceId } as never);
  await probeActivities.recordDummyTurnCompleted({ traceId: input.traceId } as never);
  return { ok: true };
}
