import { z } from "zod";

/**
 * Research Council: one question answered by several models. A coordinator model reads the operator's context,
 * asks what is missing and proposes a plan the operator approves; members answer independently with a shared web
 * evidence pack, the coordinator merges the answers anonymously, every member scores the merged positions, the
 * server ranks them and the coordinator writes the final answer around the agreed Top 3.
 */
export const COUNCIL_MAX_MEMBERS = 8;
export const COUNCIL_MAX_REVIEW_ROUNDS = 3;
/** "Another review round" may go past the planned rounds up to this total. */
export const COUNCIL_MAX_TOTAL_ROUNDS = 5;
export const COUNCIL_MAX_QUESTION_ROUNDS = 3;
export const COUNCIL_MAX_SEARCHES = 6;
export const COUNCIL_MAX_EVIDENCE = 8;
export const COUNCIL_MAX_POSITIONS = 10;
export const COUNCIL_TOP = 3;
export const COUNCIL_QUESTION_MAX_CHARS = 2_000;
export const COUNCIL_PERSONAL_CONTEXT_MAX_CHARS = 2_500;
export const COUNCIL_ANSWER_MAX_CHARS = 2_500;
export const COUNCIL_CLAIM_MAX_CHARS = 160;
export const COUNCIL_MAX_CLAIMS = 6;

const isoDateTime = z.string().datetime({ offset: true });
export const councilRunIdSchema = z.string().regex(/^council_run:[A-Za-z0-9_-]{6,80}$/);
export const councilModelIdSchema = z.string().regex(/^(?:codex|claude|antigravity|opencode|openrouter)\/[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/);
export type CouncilModelId = z.infer<typeof councilModelIdSchema>;

export const councilRunStatusSchema = z.enum(["PLANNING", "NEEDS_INPUT", "AWAITING_APPROVAL", "RUNNING", "COMPLETED", "FAILED", "INTERRUPTED", "CANCELLED"]);
export type CouncilRunStatus = z.infer<typeof councilRunStatusSchema>;
/** Statuses that hold the owner's single active run (a partial unique index in migration 0195). */
export const COUNCIL_ACTIVE_STATUSES: readonly CouncilRunStatus[] = ["PLANNING", "NEEDS_INPUT", "AWAITING_APPROVAL", "RUNNING"];
export const councilStageSchema = z.enum(["PLAN", "RESEARCH", "ANSWERS", "MERGE", "REVIEW", "FINAL", "DONE"]);
export type CouncilStage = z.infer<typeof councilStageSchema>;

export const councilModelSchema = z.object({
  id: councilModelIdSchema,
  displayName: z.string().min(1).max(200),
  providerId: z.string().min(1).max(40),
  available: z.boolean(),
  note: z.string().max(200).nullable()
}).strict();
export type CouncilModel = z.infer<typeof councilModelSchema>;

export const councilModelsResponseSchema = z.object({
  models: z.array(councilModelSchema),
  coordinatorDefault: councilModelIdSchema,
  webSearch: z.boolean()
}).strict();
export type CouncilModelsResponse = z.infer<typeof councilModelsResponseSchema>;

export const councilCriterionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
  label: z.string().trim().min(1).max(80)
}).strict();

export const councilPlanSchema = z.object({
  understanding: z.string().trim().min(1).max(1_500),
  /** The only personal text the members receive; the operator edits it before approving. */
  personalContext: z.string().max(COUNCIL_PERSONAL_CONTEXT_MAX_CHARS),
  members: z.array(z.object({ modelId: councilModelIdSchema, reason: z.string().trim().max(300) }).strict()).min(2).max(COUNCIL_MAX_MEMBERS),
  reviewRounds: z.number().int().min(1).max(COUNCIL_MAX_REVIEW_ROUNDS),
  /** Share of reviewers that must score a Top-3 position 7 or more before the rounds stop early. */
  agreementTarget: z.number().min(0.5).max(1),
  criteria: z.array(councilCriterionSchema).min(1).max(6),
  searchQueries: z.array(z.string().trim().min(3).max(200)).max(COUNCIL_MAX_SEARCHES)
}).strict();
export type CouncilPlan = z.infer<typeof councilPlanSchema>;

export const councilEstimateSchema = z.object({ calls: z.number().int().min(0), minutes: z.number().int().min(0) }).strict();
export type CouncilEstimate = z.infer<typeof councilEstimateSchema>;

export const councilQuestionSchema = z.object({ id: z.string().regex(/^q[0-9]{1,2}$/), text: z.string().trim().min(1).max(400) }).strict();
export const councilQaRoundSchema = z.object({
  questions: z.array(councilQuestionSchema).min(1).max(5),
  answers: z.record(z.string(), z.string().max(2_000))
}).strict();
export type CouncilQaRound = z.infer<typeof councilQaRoundSchema>;

const httpUrl = z.string().url().max(500).refine((value) => /^https?:\/\//i.test(value), "Only http(s) links are kept.");
export const councilEvidenceSchema = z.object({
  title: z.string().max(200),
  url: httpUrl,
  finding: z.string().max(400)
}).strict();
export type CouncilEvidence = z.infer<typeof councilEvidenceSchema>;

const callStatus = z.enum(["PENDING", "DONE", "FAILED"]);
export const councilAnswerSchema = z.object({
  modelId: councilModelIdSchema,
  status: callStatus,
  text: z.string().max(COUNCIL_ANSWER_MAX_CHARS),
  claims: z.array(z.string().max(COUNCIL_CLAIM_MAX_CHARS)).max(COUNCIL_MAX_CLAIMS),
  error: z.string().max(300).nullable(),
  ms: z.number().int().min(0).nullable()
}).strict();
export type CouncilAnswer = z.infer<typeof councilAnswerSchema>;

export const councilPositionSchema = z.object({
  id: z.string().regex(/^P[0-9]{1,2}$/),
  title: z.string().trim().min(1).max(160),
  summary: z.string().max(600),
  /** How many independent answers contained this position. */
  support: z.number().int().min(0)
}).strict();
export type CouncilPosition = z.infer<typeof councilPositionSchema>;

export const councilVerdictSchema = z.enum(["agree", "partly", "disagree"]);
export const councilScoreSchema = z.object({
  positionId: z.string().regex(/^P[0-9]{1,2}$/),
  score: z.number().int().min(1).max(10),
  verdict: councilVerdictSchema,
  issue: z.string().max(300)
}).strict();
export type CouncilScore = z.infer<typeof councilScoreSchema>;

export const councilReviewSchema = z.object({
  modelId: councilModelIdSchema,
  status: callStatus,
  scores: z.array(councilScoreSchema).max(COUNCIL_MAX_POSITIONS),
  corrections: z.array(z.string().max(300)).max(5),
  missing: z.array(z.string().max(300)).max(5),
  error: z.string().max(300).nullable()
}).strict();
export type CouncilReview = z.infer<typeof councilReviewSchema>;

export const councilRankingEntrySchema = z.object({
  positionId: z.string().regex(/^P[0-9]{1,2}$/),
  mean: z.number().min(0).max(10),
  /** Share of reviewers that scored the position 7 or more. */
  agreeShare: z.number().min(0).max(1),
  spread: z.number().min(0),
  reviewers: z.number().int().min(0),
  qualified: z.boolean()
}).strict();
export type CouncilRankingEntry = z.infer<typeof councilRankingEntrySchema>;

export const councilRoundSchema = z.object({
  round: z.number().int().min(1).max(COUNCIL_MAX_TOTAL_ROUNDS),
  merged: z.string().max(8_000),
  positions: z.array(councilPositionSchema).max(COUNCIL_MAX_POSITIONS),
  reviews: z.array(councilReviewSchema).max(COUNCIL_MAX_MEMBERS),
  ranking: z.array(councilRankingEntrySchema).max(COUNCIL_MAX_POSITIONS)
}).strict();
export type CouncilRound = z.infer<typeof councilRoundSchema>;

export const councilFinalSchema = z.object({
  text: z.string().max(12_000),
  top: z.array(z.object({
    positionId: z.string().regex(/^P[0-9]{1,2}$/),
    title: z.string().max(160),
    mean: z.number().min(0).max(10),
    agree: z.number().int().min(0),
    reviewers: z.number().int().min(0)
  }).strict()).max(COUNCIL_TOP)
}).strict();
export type CouncilFinal = z.infer<typeof councilFinalSchema>;

export const councilEventSchema = z.object({ at: isoDateTime, text: z.string().max(300) }).strict();

/** "Create plan": the coordinator turns the final answer into a PLAN record in the owner's clipboard. */
export const councilClipboardPlanSchema = z.object({
  status: z.enum(["WRITING", "DONE", "FAILED"]),
  /** The clipboard PLAN record once it is saved. */
  itemId: z.string().min(1).max(200).nullable(),
  title: z.string().max(160).nullable(),
  error: z.string().max(300).nullable()
}).strict();
export type CouncilClipboardPlan = z.infer<typeof councilClipboardPlanSchema>;

export const councilRunSchema = z.object({
  id: councilRunIdSchema,
  ownerUserId: z.string().min(1).max(200),
  question: z.string().min(1).max(COUNCIL_QUESTION_MAX_CHARS),
  coordinatorModelId: councilModelIdSchema,
  status: councilRunStatusSchema,
  stage: councilStageSchema,
  plan: councilPlanSchema.nullable(),
  estimate: councilEstimateSchema.nullable(),
  qa: z.array(councilQaRoundSchema).max(COUNCIL_MAX_QUESTION_ROUNDS),
  changeRequests: z.array(z.string().max(2_000)).max(10),
  evidence: z.array(councilEvidenceSchema).max(COUNCIL_MAX_EVIDENCE),
  answers: z.array(councilAnswerSchema).max(COUNCIL_MAX_MEMBERS),
  rounds: z.array(councilRoundSchema).max(COUNCIL_MAX_TOTAL_ROUNDS),
  final: councilFinalSchema.nullable(),
  events: z.array(councilEventSchema).max(200),
  clipboardPlan: councilClipboardPlanSchema.nullable().optional(),
  error: z.string().max(500).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime
}).strict();
export type CouncilRun = z.infer<typeof councilRunSchema>;

export const councilRunSummarySchema = councilRunSchema.pick({ id: true, question: true, status: true, stage: true, createdAt: true, updatedAt: true });
export type CouncilRunSummary = z.infer<typeof councilRunSummarySchema>;

export const createCouncilRunInputSchema = z.object({
  question: z.string().trim().min(3).max(COUNCIL_QUESTION_MAX_CHARS),
  coordinatorModelId: councilModelIdSchema.optional()
}).strict();
export type CreateCouncilRunInput = z.infer<typeof createCouncilRunInputSchema>;

export const councilAnswersInputSchema = z.object({ answers: z.record(z.string().regex(/^q[0-9]{1,2}$/), z.string().trim().max(2_000)) }).strict();
export const councilChangesInputSchema = z.object({ text: z.string().trim().min(1).max(2_000) }).strict();
export const councilApproveInputSchema = z.object({
  members: z.array(councilModelIdSchema).min(2).max(COUNCIL_MAX_MEMBERS).optional(),
  personalContext: z.string().max(COUNCIL_PERSONAL_CONTEXT_MAX_CHARS).optional(),
  reviewRounds: z.number().int().min(1).max(COUNCIL_MAX_REVIEW_ROUNDS).optional()
}).strict();
export type CouncilApproveInput = z.infer<typeof councilApproveInputSchema>;
