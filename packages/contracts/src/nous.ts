import { z } from "zod";
import { nousPaneBoardSettingsSchema } from "./nous-pane-board.js";
import { patchSchema } from "./partial-update.js";

/**
 * Nous (Greek νους, "mind"; operator decision 2026-10-17): the mind of SpaceApp. One Claude Opus 5.5 at xhigh effort per
 * owner sees every room, pane, copilot, plan, task and release train, answers the small questions itself and brings only
 * the critical decisions (releases, irreversible actions, anything that goes to third parties or costs money, product
 * direction) to the operator. The model is fixed: no fallback model (operator decision).
 */
export const NOUS_MODEL_ID = "claude-opus-5-5";
export const NOUS_EFFORT = "xhigh";
export const NOUS_MESSAGE_MAX_CHARS = 20_000;
export const NOUS_OPERATOR_MESSAGE_MAX_CHARS = 8_000;

const isoDateTime = z.string().datetime({ offset: true });
export const nousMessageIdSchema = z.string().regex(/^nous_msg:[A-Za-z0-9_-]{6,80}$/);
export const nousDecisionIdSchema = z.string().regex(/^nous_decision:[A-Za-z0-9_-]{6,80}$/);

/** OPERATOR: the operator wrote it; INBOX: what the monitor and the notifications brought; ANSWER: Nous's reply. */
export const nousMessageKindSchema = z.enum(["OPERATOR", "INBOX", "ANSWER", "TOOL", "DECISION", "ERROR"]);
export type NousMessageKind = z.infer<typeof nousMessageKindSchema>;
export const nousMessageStatusSchema = z.enum(["RUNNING", "DONE", "FAILED", "REFUSED"]);
export type NousMessageStatus = z.infer<typeof nousMessageStatusSchema>;

export const nousMessageSchema = z.object({
  id: nousMessageIdSchema,
  ownerUserId: z.string().min(1).max(200),
  turnId: z.string().min(1).max(120).nullable(),
  kind: nousMessageKindSchema,
  status: nousMessageStatusSchema,
  content: z.string().max(NOUS_MESSAGE_MAX_CHARS),
  meta: z.record(z.string(), z.unknown()),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type NousMessage = z.infer<typeof nousMessageSchema>;

/**
 * How one of the operator's requests ended, as Nous reports it (space_nous_outcome): SELF with its own tools, HELPER when a
 * pane had to do it because Nous lacked a tool (`missing` names it), OPERATOR when it is the operator's decision, PENDING.
 */
export const nousRequestOutcomeSchema = z.object({
  summary: z.string().trim().min(1).max(300),
  outcome: z.enum(["SELF", "HELPER", "OPERATOR", "PENDING"]),
  missing: z.string().trim().min(1).max(300).optional(),
  /** The operator corrected Nous or repeated an earlier request. */
  correction: z.boolean().optional()
}).strict();
export type NousRequestOutcome = z.infer<typeof nousRequestOutcomeSchema>;

/** One turn's facts (migration 0212), kept when the conversation is cleared: the source of Nous's scorecard. */
export const nousTurnFactsSchema = z.object({
  turnId: z.string().min(1).max(120),
  ownerUserId: z.string().min(1).max(200),
  reason: z.enum(["OPERATOR", "INBOX", "DECISION", "HEARTBEAT"]),
  status: z.enum(["DONE", "FAILED", "STOPPED", "TIMEOUT"]),
  /** Per tool name: calls, failures, and the failures that were a gate holding back (not mistakes). */
  tools: z.record(z.string(), z.object({ calls: z.number().int().min(0), failed: z.number().int().min(0), refused: z.number().int().min(0) }).strict()),
  /** Plan progress points the turn recorded (space_plan_update, increases only). */
  planPoints: z.number().int().min(0),
  outcomes: z.array(nousRequestOutcomeSchema),
  startedAt: isoDateTime,
  endedAt: isoDateTime
}).strict();
export type NousTurnFacts = z.infer<typeof nousTurnFactsSchema>;

/** The operator's four kinds of critical decisions (2026-10-17). */
export const nousDecisionCategorySchema = z.enum(["RELEASE", "DESTRUCTIVE", "EXTERNAL", "DIRECTION"]);
export type NousDecisionCategory = z.infer<typeof nousDecisionCategorySchema>;
export const nousDecisionStatusSchema = z.enum(["OPEN", "APPROVED", "DECLINED", "ANSWERED", "CANCELLED"]);
export type NousDecisionStatus = z.infer<typeof nousDecisionStatusSchema>;

const refId = z.string().min(1).max(200);
export const nousCopilotSchema = z.enum(["MAIL", "MARKETING", "FREELANCE", "JOB", "DESIGN", "APP_STUDIO"]);
export type NousCopilot = z.infer<typeof nousCopilotSchema>;

/**
 * What the server runs on the operator's yes. The model proposes it with the question; after the yes the server runs
 * exactly this, so a critical action never depends on what the model says later.
 */
export const nousDecisionActionSchema = z.discriminatedUnion("type", [
  /** Text typed into one pane: a prompt answer or an instruction the guardrails held back. */
  z.object({
    type: z.literal("PANE_TEXT"), roomId: refId, paneId: refId, text: z.string().max(4_000), mode: z.enum(["PROMPT", "ANSWER"]),
    /** ANSWER only: the prompt the operator saw; a changed prompt is not answered. */
    fingerprint: z.string().max(200).optional()
  }).strict(),
  /** A copilot's review, rule, campaign or lead decision, as the operator. */
  z.object({
    type: z.literal("COPILOT"), copilot: nousCopilotSchema, item: z.enum(["REVIEW", "RULE", "CAMPAIGN", "LEAD"]), itemId: refId,
    paneId: refId.nullable(), decision: z.string().min(1).max(40), text: z.string().max(20_000).optional(), note: z.string().max(2_000).optional()
  }).strict(),
  /** Approves the product's release train at its current candidate commit. */
  z.object({ type: z.literal("RELEASE_APPROVE"), product: z.string().min(1).max(80) }).strict(),
  /** A Space Control batch (space_execute) in one of the owner's rooms that Nous may not run itself: deletes, publishing, settings. */
  z.object({ type: z.literal("SPACE_CONTROL"), roomId: refId, actions: z.array(z.record(z.string(), z.unknown())).min(1).max(20) }).strict(),
  /** Rebuilds the Vault broker from stable's committed code and restarts it, as root (scripts/space-vault-broker-reinstall.mjs). */
  z.object({ type: z.literal("VAULT_BROKER_REINSTALL") }).strict()
]);
export type NousDecisionAction = z.infer<typeof nousDecisionActionSchema>;

export const nousDecisionRefsSchema = z.object({
  roomId: refId.optional(), paneId: refId.optional(), planId: refId.optional(), notificationId: refId.optional()
}).strict();

export const nousDecisionSchema = z.object({
  id: nousDecisionIdSchema,
  ownerUserId: z.string().min(1).max(200),
  category: nousDecisionCategorySchema,
  title: z.string().min(1).max(200),
  body: z.string().max(4_000),
  options: z.array(z.string().min(1).max(200)).max(6),
  recommendation: z.string().max(2_000).nullable(),
  refs: nousDecisionRefsSchema,
  action: nousDecisionActionSchema.nullable(),
  status: nousDecisionStatusSchema,
  answer: z.string().max(2_000).nullable(),
  /** What the server did on the answer ("Approved the review", "Failed: …"). */
  outcome: z.string().max(2_000).nullable(),
  createdAt: isoDateTime,
  answeredAt: isoDateTime.nullable(),
  /** The operator's feedback after answering: Nous could have decided this itself (migration 0213). */
  couldHaveDecided: z.boolean().optional()
}).strict();
export type NousDecision = z.infer<typeof nousDecisionSchema>;

/**
 * A decision's kind for "Always approve" (operator request 2026-10-18): what its action does without its target, so the next
 * decision of that kind runs on its own. Null for what stays the operator's every time: releases, irreversible actions, text for
 * a pane (its words carry the risk) and questions without an action.
 */
export function nousDecisionKind(decision: Pick<NousDecision, "category" | "action">): { key: string; label: string } | null {
  const action = decision.action;
  if (!action || decision.category === "RELEASE" || decision.category === "DESTRUCTIVE") return null;
  if (action.type === "COPILOT") {
    return { key: `COPILOT:${action.copilot}:${action.item}:${action.decision}`, label: `${action.decision} the ${action.copilot.toLowerCase()} copilot's ${action.item.toLowerCase()}s` };
  }
  if (action.type !== "SPACE_CONTROL") return null;
  const ops = [...new Set(action.actions.map((entry) => [entry.kind, entry.operation].filter((part) => typeof part === "string").join(" ")))].sort();
  return { key: `SPACE_CONTROL:${ops.join(",")}`, label: `run in Space Control: ${ops.join(", ")}` };
}
export const nousStandingApprovalSchema = z.object({ key: z.string().min(1).max(2_000), label: z.string().min(1).max(2_000), at: isoDateTime }).strict();
export type NousStandingApproval = z.infer<typeof nousStandingApprovalSchema>;

/** Saved in the owner's user settings (`nous`); off until the operator turns it on. */
export const nousSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  maxTurnsPerHour: z.number().int().min(1).max(120).default(20),
  /** The operator lets Nous promote dev to stable without asking, batched (operator decision 2026-10-17, off by default). */
  mayPromote: z.boolean().default(false),
  /** The operator lets Nous approve changes to the protected Warm code (operator decision 2026-10-17, off by default). */
  mayApproveWarm: z.boolean().default(false),
  /** Kinds of decisions the operator approved with "Always approve" in the dock; a PATCH can only remove them. */
  alwaysApprove: z.array(nousStandingApprovalSchema).max(50).default([]),
  /** The pane board's summaries (plan clipboard:Y9cgKVHFaHrr); a function default so a PATCH without it keeps the saved one. */
  paneBoard: nousPaneBoardSettingsSchema.default(() => nousPaneBoardSettingsSchema.parse({}))
}).strict();
export type NousSettings = z.infer<typeof nousSettingsSchema>;

/**
 * Nous Away mode (operator request 2026-10-17, plan clipboard:B7eTUHTJYg3X): what the operator's away grant lets Nous decide
 * alone. PROMOTE: promote dev to stable, only right after live:verify:dev passed; TEST_PANES: restart or close the operator's own
 * test panes. Never under any grant: npm or GitHub publishing, payments, deletes, sends to third parties, Warm code, pane-host or
 * browser-host restarts.
 */
export const nousAwayGrantSchema = z.enum(["PROMOTE", "TEST_PANES"]);
export type NousAwayGrant = z.infer<typeof nousAwayGrantSchema>;
export const nousAwaySchema = z.object({
  id: z.string().min(1).max(120),
  startedAt: isoDateTime,
  until: isoDateTime.nullable(),
  reason: z.string().max(500),
  mandate: z.string().max(2_000),
  grant: z.array(nousAwayGrantSchema)
}).strict();
export type NousAway = z.infer<typeof nousAwaySchema>;
/** Settings → Assistants & AI → Nous: the operator starts or ends Away, and widens or narrows its grant. */
export const nousAwayInputSchema = z.object({
  away: z.boolean(),
  grant: z.array(nousAwayGrantSchema).max(2).optional(),
  until: isoDateTime.optional()
}).strict();

/** OFF: not turned on; PAUSED_MODEL: the model failed and Nous waits (the other notifications go out again meanwhile). */
export const nousStatusSchema = z.enum(["OFF", "IDLE", "THINKING", "PAUSED_MODEL"]);
export type NousStatus = z.infer<typeof nousStatusSchema>;

export const nousStateSchema = z.object({
  status: nousStatusSchema,
  settings: nousSettingsSchema,
  model: z.string(),
  effort: z.string(),
  running: z.object({ turnId: z.string(), startedAt: isoDateTime, reason: z.enum(["OPERATOR", "INBOX", "DECISION", "HEARTBEAT"]) }).nullable(),
  turnsThisHour: z.number().int().min(0),
  lastError: z.string().max(1_000).nullable(),
  openDecisions: z.number().int().min(0),
  inbox: z.number().int().min(0),
  /** The open away session; absent or null while the operator is here. */
  away: nousAwaySchema.nullable().optional()
}).strict();
export type NousState = z.infer<typeof nousStateSchema>;

/**
 * A file the operator sends Nous with a message (plan clipboard:hQg9iKGYDqx7): an image it looks at, a document it reads
 * as extracted text, a video it gets as a reference with sampled frames, or another file it knows by name and size.
 */
export const nousAttachmentIdSchema = z.string().regex(/^nous_file:[A-Za-z0-9_-]{6,80}$/);
export const nousAttachmentKindSchema = z.enum(["IMAGE", "DOCUMENT", "VIDEO", "FILE"]);
export type NousAttachmentKind = z.infer<typeof nousAttachmentKindSchema>;
export const NOUS_ATTACHMENTS_PER_MESSAGE = 10;
/** The server appends the files' block (for Nous's turn) to the operator's message after this line; the dock hides it. */
export const NOUS_ATTACHMENTS_MARKER = "[[Attachments:";
export const nousAttachmentSchema = z.object({
  id: nousAttachmentIdSchema,
  messageId: nousMessageIdSchema.nullable(),
  kind: nousAttachmentKindSchema,
  filename: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(200),
  byteSize: z.number().int().min(1),
  width: z.number().int().min(1).nullable(),
  height: z.number().int().min(1).nullable(),
  durationSeconds: z.number().min(0).nullable(),
  /** How much of a document Nous can read, e.g. "FULL" or "PARTIAL: first 40 of 120 pages". */
  readable: z.string().max(300).nullable(),
  createdAt: isoDateTime
}).strict();
export type NousAttachment = z.infer<typeof nousAttachmentSchema>;

export const nousSendInputSchema = z.object({
  content: z.string().trim().max(NOUS_OPERATOR_MESSAGE_MAX_CHARS).default(""),
  attachmentIds: z.array(nousAttachmentIdSchema).max(NOUS_ATTACHMENTS_PER_MESSAGE).optional()
}).strict().refine((input) => input.content.length > 0 || Boolean(input.attachmentIds?.length), { message: "Write a message or attach a file." });

export const nousSettingsInputSchema = patchSchema(nousSettingsSchema).strict();

export const nousDecisionAnswerInputSchema = z.object({
  answer: z.enum(["APPROVE", "DECLINE", "ANSWER"]),
  text: z.string().trim().min(1).max(2_000).optional(),
  /** APPROVE only: approve this kind of decision from now on too. */
  always: z.boolean().optional()
}).strict().refine((input) => input.answer !== "ANSWER" || Boolean(input.text), { message: "An answer needs text.", path: ["text"] })
  .refine((input) => !input.always || input.answer === "APPROVE", { message: "Only an approval can be always.", path: ["always"] });
export type NousDecisionAnswerInput = z.infer<typeof nousDecisionAnswerInputSchema>;

/** "You could have decided this" on an answered decision, from the operator in the Nous dock. */
export const nousDecisionFeedbackInputSchema = z.object({ couldHaveDecided: z.boolean() }).strict();
export type NousDecisionFeedbackInput = z.infer<typeof nousDecisionFeedbackInputSchema>;

/** The dock's overview: every open plan, what needs the operator's hands, the release trains and Nous's plan map. */
export const nousOverviewSchema = z.object({
  plans: z.array(z.object({
    id: z.string(), title: z.string(), progress: z.number().int().min(0).max(100), status: z.string(),
    room: z.string().nullable(), pane: z.string().nullable(), nextStep: z.string().nullable(),
    /** Its pane is working now (the state the Live view's Running tile counts; plan clipboard:RXqSSUQSdwJK). */
    active: z.boolean().optional()
  }).strict()),
  needsHands: z.array(z.object({ id: z.string(), source: z.string(), title: z.string(), room: z.string().nullable() }).strict()),
  trains: z.string(),
  planMap: z.string().nullable(),
  /** The dock's live stats (plan clipboard:wr9yNPJwkDrp): the owner's rooms and their CLI panes by state, from the world's activity samples. */
  live: z.object({
    rooms: z.number().int().min(0),
    agents: z.object({ running: z.number().int().min(0), waiting: z.number().int().min(0), idle: z.number().int().min(0), total: z.number().int().min(0) }).strict()
  }).strict().optional(),
  /** The dock's Panes cards (plan clipboard:MAongwnxq9Ro): every open pane with Nous's last check, verdict and next check. */
  panes: z.array(z.object({
    paneId: z.string(), roomId: z.string(), room: z.string(), pane: z.string(), state: z.string().nullable(),
    checkedAt: z.string().nullable(), verdict: z.enum(["OK_WORKING", "WAITING_OPERATOR", "WAITING_DATE", "NEEDS_ACTION", "BLOCKED", "OPERATOR_TEST"]).nullable(),
    note: z.string().nullable(), nextCheckAt: z.string().nullable(), dueAt: z.string(), overdue: z.boolean(),
    /** The pane's newest report (plan clipboard:ot6-jLKOWDNC); its summary is the pane's own words. */
    report: z.object({ at: z.string(), status: z.string(), source: z.enum(["AGENT", "AUTO"]), summary: z.string() }).strict().nullable().optional()
  }).strict()).optional()
}).strict();
export type NousOverview = z.infer<typeof nousOverviewSchema>;
