import type { z } from "zod";

/**
 * Business rule shared by the room media and Agent Files deletion results: matched = deleted + failed, failed = the
 * failed ids, ok = nothing failed (ARCH-002). Pass to `.superRefine(...)`.
 */
export function deletionCountsAddUp(messages: { matched: string; failed: string; ok: string }) {
  return (
    result: { ok: boolean; matchedCount: number; deletedCount: number; failedCount: number; failedArtifactIds: string[] },
    context: z.RefinementCtx
  ) => {
    if (result.matchedCount !== result.deletedCount + result.failedCount) context.addIssue({ code: "custom", message: messages.matched });
    if (result.failedCount !== result.failedArtifactIds.length) context.addIssue({ code: "custom", message: messages.failed });
    if (result.ok !== (result.failedCount === 0)) context.addIssue({ code: "custom", message: messages.ok });
  };
}
