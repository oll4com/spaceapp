import type { z } from "zod";

/** Business rule shared by the memory consolidation run and its create input: an operator's run names its actor (ARCH-002). */
export function operatorRunNeedsActor(run: { triggerKind: string; actorUserId: string | null }, ctx: z.RefinementCtx): void {
  if (run.triggerKind === "OPERATOR" && !run.actorUserId) {
    ctx.addIssue({ code: "custom", path: ["actorUserId"], message: "Operator runs require an actor." });
  }
}
