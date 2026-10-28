import { z } from "zod";
import { nousPaneBoardSettingsSchema } from "./nous-pane-board.js";
import { planWaitsOnKindSchema } from "./plan-map.js";
import { nousGoalsSettingsSchema } from "./nous-goals.js";
import { patchSchema } from "./partial-update.js";

/**
 * Nous (Greek νους, "mind"; operator decision 2026-10-17): the mind of SpaceApp. One Claude model per owner sees every room,
 * pane, copilot, plan, task and release train, answers the small questions itself and brings only the critical decisions
 * (releases, irreversible actions, anything that goes to third parties or costs money, product direction) to the operator.
 * Since 2026-10-21 the operator picks the model and effort per turn kind (`nous.models`). Defaults since 2026-10-24 (operator
 * decision "Nous at maximum"): Claude Fable 5.1, `max` for the operator's and decision turns, `high` for inbox, standing and
 * helper turns (Opus 5.5 xhigh everywhere until then). No fallback model by default (operator decision 2026-10-21): `fallbackModel`
 * is a Settings option, off unless the operator picks one.
 */
export const NOUS_MODEL_ID = "claude-fable-5-1";
export const NOUS_EFFORT = "max";
/** The models a Nous turn may run on (all through Claude Code on the subscription accounts). */
export const NOUS_MODELS = ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const NOUS_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const nousModelChoiceSchema = z.object({
  model: z.enum(NOUS_MODELS).default(NOUS_MODEL_ID),
  effort: z.enum(NOUS_EFFORTS).default(NOUS_EFFORT)
}).strict();
export type NousModelChoice = z.infer<typeof nousModelChoiceSchema>;
/** Why a turn runs: the operator wrote, the inbox, a decision answer, the Away round (HEARTBEAT), Space's standing orders, the daily self-review (REVIEW, 2026-10-24), or the goal loop (GOAL, 2026-10-27). */
export const NOUS_TURN_REASONS = ["OPERATOR", "INBOX", "DECISION", "HEARTBEAT", "STANDING", "REVIEW", "GOAL"] as const;
export const nousTurnReasonSchema = z.enum(NOUS_TURN_REASONS);
export type NousTurnReason = z.infer<typeof nousTurnReasonSchema>;
/** The turn kinds the operator sets a model for; HEARTBEAT (the Away round) runs as a standing turn; goal turns (2026-10-27) get the strongest model and effort. */
export const NOUS_TURN_KINDS = ["operator", "decision", "inbox", "standing", "helper", "goal"] as const;
export type NousTurnKind = typeof NOUS_TURN_KINDS[number];
/** The default effort per turn kind (operator decision 2026-10-24): max where the operator waits, high for the volume. */
export const NOUS_EFFORT_BY_KIND: Record<NousTurnKind, typeof NOUS_EFFORTS[number]> = { operator: "max", decision: "max", inbox: "high", standing: "high", helper: "high", goal: "max" };
export const nousDefaultModel = (kind: NousTurnKind): NousModelChoice => ({ model: NOUS_MODEL_ID, effort: NOUS_EFFORT_BY_KIND[kind] });
const choice = (kind: NousTurnKind) => nousModelChoiceSchema.default(() => nousDefaultModel(kind));
export const nousModelsSettingsSchema = z.object({
  operator: choice("operator"), decision: choice("decision"), inbox: choice("inbox"), standing: choice("standing"), helper: choice("helper"),
  /** The goal loop's turns (operator order 2026-10-27: the best model with the best reasoning); never downgraded in low-spend mode. */
  goal: choice("goal")
}).strict();
export type NousModelsSettings = z.infer<typeof nousModelsSettingsSchema>;
/** The turn kind of a reason: HEARTBEAT (the Away round) and REVIEW (the daily self-review) run as standing turns. */
export function nousTurnKindOf(reason: NousTurnReason | "HELPER"): NousTurnKind {
  return reason === "OPERATOR" ? "operator" : reason === "DECISION" ? "decision" : reason === "INBOX" ? "inbox" : reason === "HELPER" ? "helper" : reason === "GOAL" ? "goal" : "standing";
}
/** The model and effort of a turn by its reason; without saved models (older settings, tests) the kind's default. */
export function nousModelFor(models: Partial<NousModelsSettings> | null | undefined, reason: NousTurnReason | "HELPER"): NousModelChoice {
  const kind = nousTurnKindOf(reason);
  return models?.[kind] ?? nousDefaultModel(kind);
}
export const nousSpendModeSchema = z.enum(["NORMAL", "LOW", "CRITICAL"]);
export type NousSpendMode = z.infer<typeof nousSpendModeSchema>;
export const NOUS_LOW_SPEND_KINDS = ["inbox", "standing", "helper"] as const;
export const nousLowSpendModel = (): NousModelChoice => ({ model: "claude-sonnet-5-5", effort: "medium" });
const lowChoice = nousModelChoiceSchema.default(nousLowSpendModel);
export const NOUS_CRITICAL_SPEND_EFFORTS = ["low", "medium"] as const;
export const nousCriticalSpendModel = () => ({ model: "claude-haiku-5-5" as const, effort: "medium" as const });
const criticalChoice = z.object({
  model: z.enum(NOUS_MODELS).default("claude-haiku-5-5"),
  effort: z.enum(NOUS_CRITICAL_SPEND_EFFORTS).default("medium")
}).strict().default(nousCriticalSpendModel);
export const nousLowSpendSettingsSchema = z.object({
  mode: z.enum(["AUTO", "ON", "OFF"]).default("AUTO"),
  /** Runtime-only automatic turn override, per kind and mode; normal models remain stored. */
  cheaperModel: z.boolean().default(true),
  minMaxAccountsWithRoom: z.number().int().min(1).max(100).default(2),
  roomRemainingPercent: z.number().min(1).max(100).default(10),
  lowBudgetRemainingPercent: z.number().min(0).max(100).default(40),
  criticalBudgetRemainingPercent: z.number().min(0).max(100).default(20),
  maxTurnsPerHour: z.number().int().min(1).max(120).default(6),
  models: z.object({ inbox: lowChoice, standing: lowChoice, helper: lowChoice }).strict().default(() => ({ inbox: nousLowSpendModel(), standing: nousLowSpendModel(), helper: nousLowSpendModel() })),
  criticalModels: z.object({ inbox: criticalChoice, standing: criticalChoice, helper: criticalChoice }).strict().default(() => ({ inbox: nousCriticalSpendModel(), standing: nousCriticalSpendModel(), helper: nousCriticalSpendModel() }))
}).strict().refine((value) => value.criticalBudgetRemainingPercent <= value.lowBudgetRemainingPercent,
  { message: "The critical budget threshold must not exceed the low budget threshold.", path: ["criticalBudgetRemainingPercent"] });
export type NousLowSpendSettings = z.infer<typeof nousLowSpendSettingsSchema>;
/** The fallback Claude Code moves a turn to when the main model is overloaded or unavailable; "none" by default (operator decision 2026-10-21). */
export const NOUS_FALLBACK_MODELS = ["none", ...NOUS_MODELS] as const;
/**
 * Standing orders (operator orders 2026-10-21): Space itself, every tick, finds the finished CLI panes (done or idle this long,
 * nothing waiting on them) and the stalled plans, and brings them to Nous in a turn of their own until each one is handled.
 */
export const nousStandingOrdersSettingsSchema = z.object({
  closeFinishedPanes: z.boolean().default(true),
  /** The operator's own panes (OPERATOR_TEST) too, once their task is done (operator order 2026-10-24, on by default). */
  closeOperatorPanes: z.boolean().default(true),
  finishedAfterMinutes: z.number().int().min(5).max(720).default(30),
  stalledAfterHours: z.number().min(1).max(72).default(3),
  tickMinutes: z.number().int().min(2).max(60).default(10),
  /** The daily self-review turn (operator decision 2026-10-24, replacing the scheduled task in a pane): once a day at this hour in the operator's zone. */
  dailyReview: z.boolean().default(true),
  dailyReviewHour: z.number().int().min(0).max(23).default(3)
}).strict();
export type NousStandingOrdersSettings = z.infer<typeof nousStandingOrdersSettingsSchema>;
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
  reason: nousTurnReasonSchema,
  status: z.enum(["DONE", "FAILED", "STOPPED", "TIMEOUT"]),
  /** Per tool name: calls, failures, and the failures that were a gate holding back (not mistakes). */
  tools: z.record(z.string(), z.object({ calls: z.number().int().min(0), failed: z.number().int().min(0), refused: z.number().int().min(0) }).strict()),
  /** Plan progress points the turn recorded (space_plan_update, increases only). */
  planPoints: z.number().int().min(0),
  outcomes: z.array(nousRequestOutcomeSchema),
  startedAt: isoDateTime,
  endedAt: isoDateTime,
  /** The model and effort the turn ran on, and what Claude Code reported it cost (total_cost_usd, modelUsage); null before 2026-10-21. */
  model: z.string().max(80).nullable().default(null),
  effort: z.string().max(16).nullable().default(null),
  costUsd: z.number().min(0).nullable().default(null),
  tokens: z.record(z.string(), z.unknown()).nullable().default(null),
  /** The goal a GOAL turn worked (2026-10-27), so the Goals view and space_nous_turn_costs show the cost per goal. */
  goalId: z.string().max(120).nullable().default(null)
}).strict();
export type NousTurnFacts = z.infer<typeof nousTurnFactsSchema>;

/** The operator's four kinds of critical decisions (2026-10-17). */
export const nousDecisionCategorySchema = z.enum(["RELEASE", "DESTRUCTIVE", "EXTERNAL", "DIRECTION"]);
export type NousDecisionCategory = z.infer<typeof nousDecisionCategorySchema>;
export const nousDecisionStatusSchema = z.enum(["OPEN", "APPROVED", "DECLINED", "ANSWERED", "CANCELLED"]);
export type NousDecisionStatus = z.infer<typeof nousDecisionStatusSchema>;

const refId = z.string().min(1).max(200);
export const nousCopilotSchema = z.enum(["MAIL", "MARKETING", "FREELANCE", "JOB", "DESIGN", "APP_STUDIO", "VIDEO", "SECURITY", "MONITORING"]);
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
  roomId: refId.optional(), paneId: refId.optional(), planId: refId.optional(), notificationId: refId.optional(),
  // Operator request 2026-10-21: the operator reads every text a decision sends before approving it ("Show everything").
  files: z.array(z.string().trim().min(1).max(400)).max(10).optional()
    .describe("The files holding every text the action sends, word for word (emails, posts, messages): agent-workspace paths or Agent Files/Media artifact ids."),
  /** Queue item 27 (27/10 Temu/Will: a second reply started): an approved send holds itself when the thread got a reply after it was asked. */
  mailThread: z.object({ account: z.string().trim().email().max(320), threadId: z.string().trim().min(1).max(200) }).strict().optional()
    .describe("A send that answers a mail thread: its account and threadId; if a reply goes out there after you ask, the approved action holds instead of sending twice.")
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
  // A held Security or Monitoring Copilot change (a reboot, a delete, a restart on a host) is decided by a person every time.
  if (action.type === "COPILOT" && (action.copilot === "SECURITY" || action.copilot === "MONITORING")) return null;
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
  /** Deprecated JSON field from the first dev slice; lowSpend.mode now controls the policy. */
  lowTokenAutomatic: z.boolean().default(true),
  lowSpend: nousLowSpendSettingsSchema.default(() => nousLowSpendSettingsSchema.parse({})),
  /** The operator lets Nous promote dev to stable without asking, batched (operator decision 2026-10-17, off by default). */
  mayPromote: z.boolean().default(false),
  /** The operator lets Nous approve changes to the protected Warm code (operator decision 2026-10-17, off by default). */
  mayApproveWarm: z.boolean().default(false),
  /** The operator lets Nous approve the Security Copilot's stable hotfix tickets (operator decision 2026-10-24, off by default). */
  maySecurityHotfix: z.boolean().default(false),
  /** Bash in Nous's own turns, like a CLI pane but never with sudo (operator order 2026-10-24, on by default); helpers have none. */
  shell: z.boolean().default(true),
  /** Kinds of decisions the operator approved with "Always approve" in the dock; a PATCH can only remove them. */
  alwaysApprove: z.array(nousStandingApprovalSchema).max(50).default([]),
  /** The pane board's summaries (plan clipboard:Y9cgKVHFaHrr); a function default so a PATCH without it keeps the saved one. */
  paneBoard: nousPaneBoardSettingsSchema.default(() => nousPaneBoardSettingsSchema.parse({})),
  /** Space's standing orders (operator orders 2026-10-21): finished panes and stalled plans brought to Nous every tick. */
  standingOrders: nousStandingOrdersSettingsSchema.default(() => nousStandingOrdersSettingsSchema.parse({})),
  /** The model and effort per turn kind (operator decision 2026-10-24: Fable 5.1, max for the operator's and decision turns, high for the rest). */
  models: nousModelsSettingsSchema.default(() => nousModelsSettingsSchema.parse({})),
  /** Claude Code's --fallback-model for every turn; off by default (operator decision 2026-10-21, kept 2026-10-24). */
  fallbackModel: z.enum(NOUS_FALLBACK_MODELS).default("none"),
  /** The operator talks to Nous from the paired Telegram chat and answers its decisions there (2026-10-24); off until a person turns it on. */
  telegramInbound: z.boolean().default(false),
  /** A copilot's question waits up to an hour for Nous before it reaches the operator (Ask Last step 7, 2026-10-27); on by default. */
  copilotQuestionsNousFirst: z.boolean().default(true),
  /** The goal loop (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1); a function default so a PATCH without it keeps the saved one. */
  goals: nousGoalsSettingsSchema.default(() => nousGoalsSettingsSchema.parse({}))
}).strict();
export type NousSettings = z.infer<typeof nousSettingsSchema>;

/**
 * Nous on a self-hosted install (operator decision 2026-10-27, B+C3): the owner's own Claude plan pays for every turn, so the
 * defaults are lean (Sonnet 5.5; batched inbox; a goal turn every 15 minutes at most; no shell, finished-pane sweeps, daily
 * review or pane board). Every value stays a setting, and a stored value always wins.
 */
const sonnet = (effort: "medium" | "low") => ({ model: "claude-sonnet-5-5", effort });
export const NOUS_PUBLIC_DEFAULTS = {
  maxTurnsPerHour: 6,
  shell: false,
  paneBoard: { enabled: false },
  standingOrders: { closeFinishedPanes: false, dailyReview: false },
  goals: { gapSeconds: 900 },
  models: { operator: sonnet("medium"), decision: sonnet("medium"), inbox: sonnet("low"), standing: sonnet("low"), helper: sonnet("low"), goal: sonnet("low") }
} as const;
/** Stored Nous settings with the self-hosted defaults under them, one level deep for the grouped settings. */
export function withNousPublicDefaults(stored: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...NOUS_PUBLIC_DEFAULTS, ...stored };
  for (const key of ["paneBoard", "standingOrders", "goals", "models"] as const) {
    const own = stored[key];
    merged[key] = { ...NOUS_PUBLIC_DEFAULTS[key], ...(own && typeof own === "object" ? own : {}) };
  }
  return merged;
}

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

/**
 * OFF: not turned on; PAUSED_MODEL: the model failed and Nous waits (the other notifications go out again meanwhile);
 * UNAVAILABLE: no turn can run here now (`unavailable` says why: dev, or a public install whose Claude Code is not signed in).
 */
export const nousStatusSchema = z.enum(["OFF", "IDLE", "THINKING", "PAUSED_MODEL", "UNAVAILABLE"]);
export type NousStatus = z.infer<typeof nousStatusSchema>;

export const nousStateSchema = z.object({
  status: nousStatusSchema,
  settings: nousSettingsSchema,
  model: z.string(),
  effort: z.string(),
  /** `draft`: the answer as it is written (streamed, operator request 2026-10-24); the dock shows it with "Nous is writing…". */
  running: z.object({ turnId: z.string(), startedAt: isoDateTime, reason: nousTurnReasonSchema, draft: z.string().max(NOUS_MESSAGE_MAX_CHARS).nullable().optional() }).nullable(),
  turnsThisHour: z.number().int().min(0),
  lastError: z.string().max(1_000).nullable(),
  unavailable: z.string().max(300).nullable().optional(),
  openDecisions: z.number().int().min(0),
  inbox: z.number().int().min(0),
  /** The open away session; absent or null while the operator is here. */
  away: nousAwaySchema.nullable().optional(),
  /** The goals (2026-10-27): how many are ACTIVE (the composer's Goals badge) and whether a goal turn is due or held. */
  goals: z.object({ active: z.number().int().min(0), nextAt: isoDateTime.nullable(), held: z.string().max(200).nullable() }).strict().optional()
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

const YES_WORDS = "ναι|ναί|οκ|οκέι|οκει|εντάξει|ενταξει|εγκρίνω|εγκρινω|προχώρα|προχωρα|προχώρησε|προχωρησε|κάν(?:['’] ?|ε )?το|καντο|συμφωνώ|συμφωνω|ωραία|ωραια|τέλεια|τελεια|σωστά|σωστα|βεβαίως|βεβαιως|φυσικά|φυσικα|σίγουρα|σιγουρα"
  + "|yes|yep|yeah|ok|okay|approve|approved|go|go ahead|do it|proceed|sure|confirm|confirmed|great|fine|perfect|sounds good";
const ANSWER_YES = new RegExp(`^(?:${YES_WORDS})(?:\\s+(?:παρακαλώ|παρακαλω|ευχαριστώ|ευχαριστω|please|thanks))?$`, "iu");
/** A yes word with a short note after a plain space: «ωραια την διαγραφεις», «οκ προχώρα». */
const ANSWER_YES_NOTE = new RegExp(`^(${YES_WORDS})\\s+([\\s\\S]+)$`, "iu");
/** A short imperative that carries the action out is a yes on its own (operator answers 26/10 «να φυγει τωρα», 27/10 «διάγραψε»). */
const ACTION_WORDS = "διάγραψε|διαγραψε|διαγράφεις|διαγραφεις|σβήσε|σβησε|στείλε|στειλε|στείλ['’ ]?το|στειλ['’ ]?το|να φύγει|να φυγει|να φύγουν|να φυγουν|τρέξε|τρεξε|κάνε|κανε|κάν['’] ?το|καντο|φτιάξε|φτιαξε|αφαίρεσε|αφαιρεσε|delete it|send it|run it|do it";
const ANSWER_ACTION = new RegExp(`^(?:${ACTION_WORDS})(?:\\s+(?:το|τα|τον|την|τη))?(?:\\s+(?:τώρα|τωρα|now))?$`, "iu");
/**
 * "Do it now" anywhere makes the answer a yes even when it brushes a later date aside (operator 27/10 14:37: «ασε τα αυριο κανε το
 * τωρα!!!»): sooner is no condition. A real condition (if, only, unless, when, don't, after the X) still leaves it to Nous.
 */
const ANSWER_ACTION_NOW = new RegExp(`(?<=^|[\\s,.;:!«"'(-])(?:${ACTION_WORDS})(?:\\s+(?:το|τα|τον|την|τη))?\\s+(?:τώρα|τωρα|now)(?=$|[\\s,.;:!…»"')])`, "iu");
const ANSWER_HARD_CONDITION = /(?<=^|[\s,.;:!?…«»"'()-])(?:αλλά|αλλα|αν|εάν|εαν|εφόσον|εφοσον|όταν|οταν|μόνο|μονο|εκτός|εκτος|μην|μη|if|unless|only|except|when|but|don'?t|μετά\s+(?:το|τη|την|τον|τα|τις|από)|μετα\s+(?:το|τη|την|τον|τα|τις|απο)|after\s+(?:the|it|that|this))(?=\s|$|[,.;:!?…»"')])/iu;
const ANSWER_NO = /^(?:όχι|οχι|μην|μη|απορρίπτω|απορριπτω|άκυρο|ακυρο|no|nope|decline|declined|don'?t|do not|stop|cancel|reject|rejected)(?:\s+(?:παρακαλώ|παρακαλω|ευχαριστώ|ευχαριστω|please|thanks))?$/iu;
/** A note that makes the yes conditional: "yes, but tomorrow", "ναι, μόνο αν…". */
const ANSWER_CONDITION = /^(?:αλλά|αλλα|όμως|ομως|μόνο|μονο|εκτός|εκτος|αν|εάν|εαν|εφόσον|εφοσον|αφού|αφου|μετά|μετα|πρώτα|πρωτα|όχι|οχι|μην|μη|but|only|except|if|unless|after|first|when|once|instead|not|no|don'?t)(?=\s|$|[,.;:!?])/iu;
/** A condition or deferral anywhere in the note ("μετά"/"after" only lead one: "πες μου μετά" is no condition). */
const ANSWER_CONDITION_ANYWHERE = /(?<=^|[\s,.;:!?…«»"'()-])(?:αλλά|αλλα|όμως|ομως|μόνο|μονο|εκτός|εκτος|αν|εάν|εαν|εφόσον|εφοσον|όταν|οταν|πρώτα|πρωτα|αύριο|αυριο|αργότερα|αργοτερα|but|only|except|if|unless|when|first|tomorrow|later)(?=\s|$|[,.;:!?…»"')])/iu;
const conditional = (note: string) => ANSWER_CONDITION.test(note) || ANSWER_CONDITION_ANYWHERE.test(note);
export const NOUS_ANSWER_NOTE_MAX_CHARS = 200;

/**
 * What an answer in words means for a decision with an action (operator gap 2026-10-24: a typed "ναι" closed the card as answered
 * with its action unrun, and Nous asked again). A yes or no decides, with at most a short unconditional note after a comma, dash,
 * line break or (for a yes) a plain space; a short imperative of the action ("διάγραψε", "να φύγει τώρα") is a yes. Conditions,
 * questions and anything longer stay for Nous to read (null).
 */
export function nousAnswerIntent(text: string): "APPROVE" | "DECLINE" | null {
  const trimmed = text.trim();
  if (/[?;\u037e]$/u.test(trimmed)) return null;
  if (trimmed.length <= NOUS_ANSWER_NOTE_MAX_CHARS && ANSWER_ACTION_NOW.test(trimmed) && !ANSWER_HARD_CONDITION.test(trimmed)) return "APPROVE";
  const match = /^([^,;:\n—–-]+?)\s*(?:[,;:—–-]|\n)\s*([\s\S]*)$/u.exec(trimmed);
  const head = (match ? match[1]! : trimmed).trim().replace(/[.!…]+$/u, "").trim();
  const note = match ? match[2]!.trim() : "";
  if (note.length > NOUS_ANSWER_NOTE_MAX_CHARS || conditional(note)) return null;
  if (ANSWER_YES.test(head) || ANSWER_ACTION.test(head)) return "APPROVE";
  if (ANSWER_NO.test(head)) return "DECLINE";
  const [, word, spaced] = ANSWER_YES_NOTE.exec(head) ?? [];
  // "ναι ναι" stays Nous's to read, as before.
  if (spaced && spaced.toLowerCase() !== word!.toLowerCase() && spaced.length + note.length <= NOUS_ANSWER_NOTE_MAX_CHARS && !conditional(spaced) && !ANSWER_NO.test(spaced)) return "APPROVE";
  return null;
}

/** "You could have decided this" on an answered decision, from the operator in the Nous dock. */
export const nousDecisionFeedbackInputSchema = z.object({ couldHaveDecided: z.boolean() }).strict();
export type NousDecisionFeedbackInput = z.infer<typeof nousDecisionFeedbackInputSchema>;

/** Plan map (operator request 2026-10-25): a server-wide condition that holds every plan until it clears. */
export const nousGlobalHoldSchema = z.object({
  kind: z.enum(["NOUS_OFF", "MODEL_PAUSED", "LOW_SPEND", "QUEUE_PAUSED", "QUEUE_DOWN", "PLAN_CONTROLLER_OFF", "OVERLOADED"]),
  text: z.string(), since: z.string().nullable()
}).strict();
export type NousGlobalHold = z.infer<typeof nousGlobalHoldSchema>;
/** What one plan waits on now and where Space learned it: the plan's own `waitsOn`, an unfinished dependency, its managed execution, its pane's board line, its pane's report, or a server-wide hold. */
export const nousPlanHoldSchema = z.object({
  kind: planWaitsOnKindSchema, what: z.string(), until: z.string().nullable(),
  source: z.enum(["PLAN", "DEPENDENCY", "EXECUTION", "PANE", "REPORT", "SERVER"])
}).strict();
export type NousPlanHold = z.infer<typeof nousPlanHoldSchema>;
export const nousPlanHoldsSchema = z.object({
  holds: z.array(nousGlobalHoldSchema),
  /**
   * What to do first (2026-10-25): the server-wide holds (no plan ids: they hold every plan), then each blocker someone can act on
   * (you, a third party, a promote, Nous), merged when plans wait on the same thing, then plans others depend on (FINISH).
   * A wait for a date or for another plan is not a blocker: the date passes, the other plan is listed itself.
   */
  unblockFirst: z.array(z.object({
    kind: z.union([planWaitsOnKindSchema, z.literal("FINISH")]), what: z.string(), planIds: z.array(z.string()), unsticks: z.number().int().min(0)
  }).strict()),
  /** The dates: each plan's due date (DUE) and the time a plan waiting for a date resumes (RESUMES), soonest first; overdue = passed. */
  dates: z.array(z.object({ planId: z.string(), title: z.string(), at: z.string(), kind: z.enum(["DUE", "RESUMES"]), overdue: z.boolean() }).strict())
}).strict();
export type NousPlanHolds = z.infer<typeof nousPlanHoldsSchema>;

/** The dock's overview: every open plan, what needs the operator's hands, the release trains and Nous's plan map. */
export const nousOverviewSchema = z.object({
  plans: z.array(z.object({
    id: z.string(), title: z.string(), progress: z.number().int().min(0).max(100), status: z.string(),
    /** `pane` names the plan's pane only while it is open; `paneClosed`: its pane was closed or deleted (operator request 2026-10-26). */
    room: z.string().nullable(), pane: z.string().nullable(), paneClosed: z.boolean().optional(), nextStep: z.string().nullable(),
    /** Its pane is working now (the state the Live view's Running tile counts; plan clipboard:RXqSSUQSdwJK). */
    active: z.boolean().optional(),
    /** The plan map (2026-10-25): dependency depth (0 = depends on no open plan), the open plans it depends on, its date and hold. */
    level: z.number().int().min(0).optional(), dependsOn: z.array(z.string()).optional(), dueAt: z.string().nullable().optional(),
    overdue: z.boolean().optional(), hold: nousPlanHoldSchema.nullable().optional()
  }).strict()),
  needsHands: z.array(z.object({ id: z.string(), source: z.string(), title: z.string(), room: z.string().nullable() }).strict()),
  trains: z.string(),
  planMap: z.string().nullable(),
  planHolds: nousPlanHoldsSchema.optional(),
  /** The dock's live stats (plan clipboard:wr9yNPJwkDrp): the owner's rooms and their CLI panes by state, from the world's activity samples. */
  live: z.object({
    rooms: z.number().int().min(0),
    agents: z.object({ running: z.number().int().min(0), waiting: z.number().int().min(0), idle: z.number().int().min(0), total: z.number().int().min(0) }).strict()
  }).strict().optional(),
  /** The dock's Panes cards (plan clipboard:MAongwnxq9Ro): every open pane with Nous's last check, verdict and next check. */
  panes: z.array(z.object({
    paneId: z.string(), roomId: z.string(), room: z.string(), pane: z.string(), state: z.string().nullable(),
    checkedAt: z.string().nullable(), verdict: z.enum(["OK_WORKING", "WAITING_OPERATOR", "WAITING_DATE", "NEEDS_ACTION", "BLOCKED", "OPERATOR_TEST", "KEEP_OPEN"]).nullable(),
    note: z.string().nullable(), nextCheckAt: z.string().nullable(), dueAt: z.string(), overdue: z.boolean(),
    /** The pane's newest report (plan clipboard:ot6-jLKOWDNC); its summary is the pane's own words. */
    report: z.object({ at: z.string(), status: z.string(), source: z.enum(["AGENT", "AUTO"]), summary: z.string() }).strict().nullable().optional()
  }).strict()).optional()
}).strict();
export type NousOverview = z.infer<typeof nousOverviewSchema>;
