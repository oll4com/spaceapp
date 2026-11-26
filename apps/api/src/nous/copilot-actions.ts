import { JOB_APPLY_REVIEW_DECISIONS, MAIL_COPILOT_REVIEW_DECISIONS, freelanceLeadDecisionSchema, freelanceMessageReviewDecisionSchema, mailRuleDecisionSchema,
  marketingPostReviewDecisionSchema, type NousDecisionAction } from "@space/contracts";

/** The decisions each copilot item takes when an approved COPILOT decision runs (`executeAction` in wiring.ts); nothing else runs. */
export const COPILOT_ACTION_DECISIONS: Readonly<Record<string, readonly string[]>> = {
  "MAIL:REVIEW": MAIL_COPILOT_REVIEW_DECISIONS, "MAIL:RULE": mailRuleDecisionSchema.shape.decision.options, "MAIL:CAMPAIGN": ["cancel"],
  "MARKETING:REVIEW": marketingPostReviewDecisionSchema.shape.decision.options, "MARKETING:CAMPAIGN": ["approve", "complete", "cancel"],
  "MARKETING:RULE": ["approve", "reject", "retire"], "FREELANCE:RULE": ["approve", "reject", "retire"],
  "FREELANCE:REVIEW": freelanceMessageReviewDecisionSchema.shape.decision.options, "FREELANCE:LEAD": freelanceLeadDecisionSchema.shape.decision.options,
  "SECURITY:REVIEW": ["approve", "decline"], "MONITORING:REVIEW": ["approve", "decline"], "JOB:REVIEW": JOB_APPLY_REVIEW_DECISIONS
};

/** R13-4 (29/10: "decline" is not a decision a mail copilot's review takes): words other rails use for each decision. */
const DECISION_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  approve: ["accept", "yes", "send", "ok"], reject: ["decline", "deny", "refuse", "dismiss", "skip", "no"],
  decline: ["reject", "deny", "refuse", "dismiss", "skip", "no"], cancel: ["dismiss", "skip", "reject", "decline", "stop"], retire: ["archive"]
};

/** The decision this copilot item takes for `decision`: itself when allowed, else the one allowed decision it is a synonym of; null otherwise. */
export function copilotDecisionFor(copilot: string, item: string, decision: string): string | null {
  const allowed = COPILOT_ACTION_DECISIONS[`${copilot}:${item}`] ?? [];
  if (allowed.includes(decision)) return decision;
  const mapped = allowed.filter((value) => DECISION_SYNONYMS[value]?.includes(decision));
  return mapped.length === 1 ? mapped[0]! : null;
}

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

/** A review's item detail (what space_copilot_items shows) when its time is past; Nous's ask checks it, since deciding it without a new time fails. */
export const MARKETING_STALE_REVIEW = "MARKETING_STALE";
export const marketingStaleReviewDetail = (scheduledAt: string) => `${MARKETING_STALE_REVIEW}: its time ${scheduledAt} is more than 24 hours past; approve or edit it only with a new future scheduledAt, or reject it.`;
/** Overnight 21/11 (Daily Nous errors, 2 decisions failed 11:05Z): a yes that comes after the post's time passed by 24 h cannot publish it at a time
 * nobody approved; the post stays in review (space_copilot_items shows it stale) and the decision is held, not failed. Null for any other error. */
export const marketingStaleHeld = (error: unknown): string | null => error instanceof Error && error.message.startsWith(`${MARKETING_STALE_REVIEW}:`)
  ? `Held: ${error.message} The post stays in review; ask again with a new scheduledAt, or reject it.` : null;
