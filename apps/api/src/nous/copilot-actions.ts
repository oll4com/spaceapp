import { JOB_APPLY_REVIEW_DECISIONS, MAIL_COPILOT_REVIEW_DECISIONS, freelanceLeadDecisionSchema, freelanceMessageReviewDecisionSchema, mailRuleDecisionSchema,
  marketingPostReviewDecisionSchema, type NousDecisionAction } from "@space/contracts";

/** The decisions each copilot item takes when an approved COPILOT decision runs (`executeAction` in wiring.ts); nothing else runs. */
export const COPILOT_ACTION_DECISIONS: Readonly<Record<string, readonly string[]>> = {
  "MAIL:REVIEW": MAIL_COPILOT_REVIEW_DECISIONS, "MAIL:RULE": mailRuleDecisionSchema.shape.decision.options,
  "MARKETING:REVIEW": marketingPostReviewDecisionSchema.shape.decision.options, "MARKETING:CAMPAIGN": ["approve", "complete", "cancel"],
  "MARKETING:RULE": ["approve", "reject", "retire"], "FREELANCE:RULE": ["approve", "reject", "retire"],
  "FREELANCE:REVIEW": freelanceMessageReviewDecisionSchema.shape.decision.options, "FREELANCE:LEAD": freelanceLeadDecisionSchema.shape.decision.options,
  "SECURITY:REVIEW": ["approve", "decline"], "MONITORING:REVIEW": ["approve", "decline"], "JOB:REVIEW": JOB_APPLY_REVIEW_DECISIONS
};

/**
 * Why a COPILOT action would fail on the operator's yes, checked when the decision is asked (queue item 25, 27/10: a Mail review
 * decided "decline" failed after the operator approved, and they had to approve twice). Null when it would run.
 */
export function copilotActionProblem(action: NousDecisionAction): string | null {
  if (action.type !== "COPILOT") return null;
  const allowed = COPILOT_ACTION_DECISIONS[`${action.copilot}:${action.item}`];
  if (!allowed) return `An approved decision cannot decide a ${action.copilot.toLowerCase()} copilot's ${action.item.toLowerCase()}: the items it decides are `
    + `${Object.keys(COPILOT_ACTION_DECISIONS).join(", ")}. Ask without an action, or answer the copilot yourself.`;
  return allowed.includes(action.decision) ? null
    : `"${action.decision}" is not a decision a ${action.copilot.toLowerCase()} copilot's ${action.item.toLowerCase()} takes: use ${allowed.join(", ")}.`;
}
