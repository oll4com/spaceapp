import type { z } from "zod";

/**
 * Business rule shared by the purge and cleanup responses: the status is NOOP exactly when nothing was found or removed
 * (ARCH-002). Refinements run only on a parsed status, so "not NOOP" is READY, COMPLETED or PARTIAL. Pass to `.superRefine(...)`.
 */
export function noopExactlyWhenEmpty<Response extends { status: string }>(hasTargets: (response: Response) => boolean, message: string) {
  return (response: Response, context: z.RefinementCtx) => {
    if ((response.status === "NOOP") === hasTargets(response)) context.addIssue({ code: "custom", path: ["status"], message });
  };
}
