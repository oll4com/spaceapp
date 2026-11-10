import { z } from "zod";
import { planWaitsOnSchema } from "./plan-map.js";
import { orderedRange } from "./range-rules.js";

/**
 * Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the operator's standing objectives, above plans. A goal is
 * the operator's exact words; Nous breaks it into plans, panes, tasks and helpers and works it in GOAL turns of its own until it is
 * ACHIEVED (with evidence). Only a person creates, edits, pauses, drops or deletes a goal; Nous records progress, criteria, links,
 * what it waits on and its note. A leaf module like plan-map.ts (nous.ts imports it).
 */
export const NOUS_GOAL_STATUSES = ["ACTIVE", "PAUSED", "ACHIEVED", "DROPPED"] as const;
export const nousGoalStatusSchema = z.enum(NOUS_GOAL_STATUSES);
export type NousGoalStatus = z.infer<typeof nousGoalStatusSchema>;
export const nousGoalIdSchema = z.string().regex(/^nous_goal:[A-Za-z0-9_-]{6,80}$/);
export const NOUS_GOAL_EVIDENCE_MIN_CHARS = 20;
const isoDateTime = z.string().datetime({ offset: true });

/**
 * A goal's limit (operator 1/11 03:39 BKK, plan clipboard:ESIzQb7rHGQM): a deadline or another measurable bound. A goal shows a
 * progress percentage only when it has one; without it no percentage is shown anywhere.
 */
export const nousGoalLimitSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("DATE"), until: isoDateTime.describe("The deadline (ISO; without an offset it is the operator's time).") }).strict(),
  z.object({ kind: z.literal("TARGET"), what: z.string().trim().min(1).describe("The measurable bound, e.g. \"100 paid licences\".") }).strict()
]);
export type NousGoalLimit = z.infer<typeof nousGoalLimitSchema>;

export const nousGoalSchema = z.object({
  id: nousGoalIdSchema,
  ownerUserId: z.string().min(1).max(200),
  /** The operator's own words, any length (until 31/10 cut at 4,000). */
  text: z.string().min(1),
  status: nousGoalStatusSchema,
  /** 1 = first; the Goals view's order and the order Nous reads them in. */
  priority: z.number().int().min(1),
  progress: z.number().int().min(0).max(100),
  /** Nous's success criteria: what "achieved" means for this goal. */
  criteria: z.string().nullable(),
  planIds: z.array(z.string().min(1).max(120)),
  waitsOn: planWaitsOnSchema.nullable(),
  /** Its deadline or measurable bound; progress is shown only with one. */
  limit: nousGoalLimitSchema.nullable(),
  /** The last thing Nous did for it and what comes next. */
  note: z.string().nullable(),
  /** ACHIEVED only: what proves it. */
  evidence: z.string().nullable(),
  lastWorkedAt: isoDateTime.nullable(),
  /** When the loop may work it again; null = now. */
  nextTurnAt: isoDateTime.nullable(),
  /** The state fingerprint after its last GOAL turn, and how many turns in a row left it unchanged (back-off). */
  fingerprint: z.string().max(400).nullable(),
  unchangedTurns: z.number().int().min(0),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  achievedAt: isoDateTime.nullable()
}).strict();
export type NousGoal = z.infer<typeof nousGoalSchema>;

export const NOUS_GOAL_EVENT_KINDS = ["CREATED", "EDITED", "PAUSED", "RESUMED", "DROPPED", "REOPENED", "PROGRESS", "CRITERIA", "PLANS", "WAITS", "NOTE", "ACHIEVED", "TURN", "LIMIT"] as const;
export const nousGoalEventSchema = z.object({
  id: z.string().min(1).max(40),
  goalId: nousGoalIdSchema,
  at: isoDateTime,
  kind: z.enum(NOUS_GOAL_EVENT_KINDS),
  text: z.string().max(6_000),
  turnId: z.string().max(120).nullable()
}).strict();
export type NousGoalEvent = z.infer<typeof nousGoalEventSchema>;

/** The operator's own operations (the dock's Goals view, /goal). */
export const nousGoalCreateInputSchema = z.object({ text: z.string().trim().min(1) }).strict();
export type NousGoalCreateInput = z.infer<typeof nousGoalCreateInputSchema>;
export const nousGoalEditInputSchema = z.object({
  text: z.string().trim().min(1).optional(),
  /** ACTIVE resumes or reopens, PAUSED pauses, DROPPED drops; ACHIEVED stays Nous's (with evidence). */
  status: z.enum(["ACTIVE", "PAUSED", "DROPPED"]).optional(),
  priority: z.number().int().min(1).max(1_000).optional()
}).strict().refine((input) => input.text !== undefined || input.status !== undefined || input.priority !== undefined, { message: "Nothing to change." });
export type NousGoalEditInput = z.infer<typeof nousGoalEditInputSchema>;
export const nousGoalsReorderInputSchema = z.object({ ids: z.array(nousGoalIdSchema).min(1) }).strict();

/** Nous's own update (space_goal_update): never the text, the status or the order (the operator's), ACHIEVED only with evidence. */
export const nousGoalUpdateArgsSchema = z.object({
  goal: nousGoalIdSchema.describe("The goal id from the world (nous_goal:...)."),
  progress: z.number().int().min(0).max(100).optional().describe("Kept and shown only on a goal with a limit (a deadline or a measurable target)."),
  limit: nousGoalLimitSchema.nullable().optional()
    .describe("The goal's deadline (DATE with until) or measurable bound (TARGET with what), when the operator's words name one; null clears it. Progress is shown only with a limit."),
  criteria: z.string().trim().min(1).optional().describe("Your success criteria: what must be true for the goal to count as achieved."),
  planIds: z.array(z.string().trim().regex(/^clipboard:[A-Za-z0-9_-]{6,64}$/)).optional().describe("The plans that serve this goal; replaces the list ([] clears)."),
  waitsOn: planWaitsOnSchema.nullable().optional().describe("What the goal waits on now (OPERATOR, DATE with until, PROMOTE, THIRD_PARTY, NOUS, SERVER); null clears it."),
  note: z.string().trim().min(1).optional().describe("The last thing you did for it and what comes next (the operator reads it in the Goals view)."),
  achieved: z.object({ evidence: z.string().trim().min(NOUS_GOAL_EVIDENCE_MIN_CHARS) }).strict().optional()
    .describe("Mark the goal ACHIEVED with the evidence that proves it (what the operator can check); never without it.")
}).strict();
export type NousGoalUpdateArgs = z.infer<typeof nousGoalUpdateArgsSchema>;

/** The goal loop's settings (Settings → Assistants & AI → Nous → Goals; only a person changes them on stable). */
export const nousGoalsSettingsSchema = z.object({
  /** The loop: a GOAL turn shortly after the previous one while a goal is ACTIVE. */
  loop: z.boolean().default(true),
  // Operator token audit 31/10: a goal turn every 10 minutes at most, two unchanged turns, then 30 minutes doubling to 2 hours.
  gapSeconds: z.number().int().min(10).max(3_600).default(600),
  backoffMinutes: z.number().int().min(1).max(180).default(30),
  /** Also the sleep of a goal whose wait stayed the same through a turn. */
  backoffMaxMinutes: z.number().int().min(1).max(720).default(120),
  /** GOAL turns in a row that leave a goal unchanged before it backs off. */
  unchangedTurns: z.number().int().min(1).max(20).default(2)
}).strict().refine(...orderedRange("backoffMinutes", "backoffMaxMinutes", { message: "The longest back-off must not be shorter than the first one.", path: ["backoffMaxMinutes"] }));
export type NousGoalsSettings = z.infer<typeof nousGoalsSettingsSchema>;

/** The Goals view: each goal with what its turns cost today and this month (turn facts) and its newest events. */
export const nousGoalCostSchema = z.object({ turns: z.number().int().min(0), costUsd: z.number().min(0), unpriced: z.number().int().min(0) }).strict();
export const nousGoalsViewSchema = z.object({
  goals: z.array(nousGoalSchema.extend({ cost: z.object({ today: nousGoalCostSchema, month: nousGoalCostSchema }).strict(), events: z.array(nousGoalEventSchema) }).strict()),
  /** The loop's state as the dock shows it. */
  loop: z.object({ on: z.boolean(), running: z.string().nullable(), nextAt: isoDateTime.nullable(), held: z.string().nullable() }).strict()
}).strict();
export type NousGoalsView = z.infer<typeof nousGoalsViewSchema>;

/**
 * `/goal <text>` creates a goal from the operator's exact words; `/goal` alone or `/goals` opens the Goals view (the dock) or lists
 * them (Telegram). Anything else is a message to Nous.
 */
export function parseNousGoalCommand(text: string): { kind: "CREATE"; text: string } | { kind: "LIST" } | null {
  const match = /^\s*\/goals?(?=\s|$)([\s\S]*)$/iu.exec(text);
  if (!match) return null;
  const rest = match[1]!.trim();
  if (!rest) return { kind: "LIST" };
  return { kind: "CREATE", text: rest };
}

/**
 * A goal's work history (operator 1/11 03:35 BKK «ανα goal να δω ιστορικό εργασιών», plan clipboard:jNDx8l-vMEl9): what was done for it,
 * newest first, each entry whole. TURN: a goal turn (a run of turns that did no new work folds into one, `since` its first); BRIEF,
 * PANE, PLAN, DECISION, CARD, DONE: what those turns did; REPORT: the goal's plans' pane reports; TICKET: the merge-queue tickets they
 * name; GOAL: the goal's own changes. `GET /api/nous/goals/:id/history?before=<at of the oldest entry held>&kind=` (the Nous app too).
 */
export const NOUS_GOAL_HISTORY_KINDS = ["TURN", "BRIEF", "PANE", "PLAN", "REPORT", "TICKET", "DECISION", "CARD", "DONE", "GOAL"] as const;
export const nousGoalHistoryKindSchema = z.enum(NOUS_GOAL_HISTORY_KINDS);
export type NousGoalHistoryKind = z.infer<typeof nousGoalHistoryKindSchema>;
export const nousGoalHistoryEntrySchema = z.object({
  id: z.string().min(1).max(200),
  at: isoDateTime,
  since: isoDateTime.optional(),
  kind: nousGoalHistoryKindSchema,
  title: z.string(),
  detail: z.string().nullable(),
  refs: z.object({ paneId: z.string().optional(), roomId: z.string().optional(), paneName: z.string().optional(), planId: z.string().optional(),
    ticket: z.string().optional(), decisionId: z.string().optional() }).strict()
}).strict();
export type NousGoalHistoryEntry = z.infer<typeof nousGoalHistoryEntrySchema>;
export const nousGoalHistoryQuerySchema = z.object({ before: isoDateTime.optional(), kind: nousGoalHistoryKindSchema.optional() }).strict();
export const nousGoalHistoryPageSchema = z.object({
  entries: z.array(nousGoalHistoryEntrySchema),
  hasMore: z.boolean(),
  /** Every entry of the goal by kind, whatever `before` and `kind` say. */
  counts: z.record(z.string(), z.number().int().min(0))
}).strict();
export type NousGoalHistoryPage = z.infer<typeof nousGoalHistoryPageSchema>;
