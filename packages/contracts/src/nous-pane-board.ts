import { z } from "zod";

/**
 * Nous's pane board (operator request 2026-10-19, plan clipboard:Y9cgKVHFaHrr): every open pane by room with one live line
 * of what it does and what it waits on, the operator's items under it and a reply box per pane. Nous refreshes the lines
 * only for panes whose data changed, with a cheap Claude model as one headless Claude Code run per batch (no tools).
 */
export const NOUS_PANE_BOARD_MODELS = ["claude-haiku-5-5", "claude-sonnet-5-5"] as const;
export const NOUS_PANE_BOARD_LINE_MAX = 200;
export const NOUS_PANE_BOARD_DETAIL_MAX = 400;
export const NOUS_PANE_BOARD_ANSWER_MAX = 2_000;

/** Saved in the owner's Nous settings (`nous.paneBoard`); absent means these defaults. */
export const nousPaneBoardSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.enum(NOUS_PANE_BOARD_MODELS).default("claude-haiku-5-5"),
  intervalMinutes: z.number().int().min(2).max(60).default(5),
  maxPanesPerCall: z.number().int().min(1).max(20).default(12),
  dailyCap: z.number().int().min(10).max(2_000).default(300),
  /** The summary lines' language; every label around them stays English. */
  language: z.enum(["el", "en"]).default("el"),
  showFinished: z.boolean().default(true),
  showClosed: z.boolean().default(false)
}).strict();
export type NousPaneBoardSettings = z.infer<typeof nousPaneBoardSettingsSchema>;

/** Who or what a pane waits on: the operator, a date, the promote or a release, a third party, Nous, or nothing (working). */
export const nousPaneWaitsOnSchema = z.enum(["OPERATOR", "DATE", "PROMOTE", "THIRD_PARTY", "NOUS", "NONE"]);
export type NousPaneWaitsOn = z.infer<typeof nousPaneWaitsOnSchema>;

const isoDateTime = z.string().datetime({ offset: true });

/** One item of the model's strict JSON answer. */
export const nousPaneSummaryModelItemSchema = z.object({
  paneId: z.string().min(1).max(200),
  line: z.string().trim().min(1).max(NOUS_PANE_BOARD_LINE_MAX * 2),
  waitsOn: nousPaneWaitsOnSchema,
  needsOperator: z.boolean(),
  until: isoDateTime.nullish(),
  detail: z.string().trim().max(NOUS_PANE_BOARD_DETAIL_MAX * 2).nullish()
});
export const nousPaneSummaryModelAnswerSchema = z.array(nousPaneSummaryModelItemSchema).max(40);

export const nousPaneSummarySchema = z.object({
  line: z.string().max(NOUS_PANE_BOARD_LINE_MAX),
  waitsOn: nousPaneWaitsOnSchema,
  needsOperator: z.boolean(),
  until: isoDateTime.nullable(),
  detail: z.string().max(NOUS_PANE_BOARD_DETAIL_MAX).nullable(),
  /** MODEL: written by the summary model; FALLBACK: Space's own line from the newest report and the pane's state. */
  source: z.enum(["MODEL", "FALLBACK"]),
  model: z.string().max(80).nullable(),
  generatedAt: isoDateTime
}).strict();
export type NousPaneSummary = z.infer<typeof nousPaneSummarySchema>;

export const nousPaneBoardPaneSchema = z.object({
  paneId: z.string(),
  roomId: z.string(),
  name: z.string(),
  mode: z.string(),
  runtimeId: z.string().nullable(),
  model: z.string().nullable(),
  /** working | waiting | done | idle | closed */
  state: z.string(),
  plan: z.object({ id: z.string(), title: z.string(), progress: z.number().int().min(0).max(100), nextStep: z.string().nullable() }).strict().nullable(),
  /** A finished pane a scheduled task is bound to stays open (operator decision 2026-10-21): the task that keeps it. */
  keptOpenForTask: z.object({ id: z.string(), title: z.string() }).strict().nullable().optional(),
  summary: nousPaneSummarySchema,
  /** The pane's newest report (its own words). */
  report: z.object({ at: z.string(), status: z.string(), summary: z.string() }).strict().nullable(),
  /** A waiting CLI pane's question and numbered options (from its waiting report). */
  prompt: z.object({ question: z.string(), options: z.array(z.object({ key: z.string(), label: z.string() }).strict()).max(9) }).strict().nullable(),
  notifications: z.array(z.object({ id: z.string(), source: z.string(), kind: z.string(), severity: z.string(), title: z.string(), body: z.string(), card: z.boolean() }).strict()),
  decisionIds: z.array(z.string()),
  copilotItems: z.array(z.object({ copilot: z.string(), kind: z.string(), id: z.string(), title: z.string(), detail: z.string() }).strict())
}).strict();
export type NousPaneBoardPane = z.infer<typeof nousPaneBoardPaneSchema>;

export const nousPaneBoardSchema = z.object({
  rooms: z.array(z.object({ roomId: z.string(), name: z.string(), panes: z.array(nousPaneBoardPaneSchema) }).strict()),
  /** Why the model lines are not being refreshed now; null while they are. */
  paused: z.enum(["OFF", "NOUS_OFF", "UNAVAILABLE", "DAILY_CAP"]).nullable(),
  callsToday: z.number().int().min(0),
  settings: nousPaneBoardSettingsSchema,
  generatedAt: isoDateTime
}).strict();
export type NousPaneBoard = z.infer<typeof nousPaneBoardSchema>;

/** One reply from a pane's row: a CLI prompt's answer, a copilot question's answer, or (default) a message to Nous about the pane. */
export const nousPaneBoardAnswerInputSchema = z.object({
  text: z.string().trim().min(1).max(NOUS_PANE_BOARD_ANSWER_MAX),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("PROMPT") }).strict(),
    z.object({ kind: z.literal("COPILOT_QUESTION"), copilot: z.string().min(1).max(40), questionId: z.string().min(1).max(200) }).strict(),
    z.object({ kind: z.literal("NOUS") }).strict()
  ]).default({ kind: "NOUS" })
}).strict();
export type NousPaneBoardAnswerInput = z.infer<typeof nousPaneBoardAnswerInputSchema>;
export const nousPaneBoardAnswerResultSchema = z.object({
  routed: z.enum(["PROMPT", "COPILOT_QUESTION", "NOUS"]),
  display: z.string()
}).strict();
export type NousPaneBoardAnswerResult = z.infer<typeof nousPaneBoardAnswerResultSchema>;

export const nousPaneBoardRefreshInputSchema = z.object({ paneId: z.string().min(1).max(200).optional() }).strict();

/** NOUS_PANE_BOARD_UPDATED on the app stream: ids only (the stream is shared); the dock refetches the board. */
export const nousPaneBoardUpdatedPayloadSchema = z.object({ paneId: z.string().min(1).max(200).nullable() }).strict();
