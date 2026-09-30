import { z } from "zod";

// Optional Jev decisions contract. Nothing here is required for MCP control
// to work: when no token is configured, callers receive available:false and
// continue with existing chat/CLI paths.

export const JEV_MODEL_ID = "typesafe/jev-1.13";
export const JEV_DECISIONS_PATH = "/api/alpha/decisions";

const noulQuestionSchema = z.object({
  type: z.literal("noul"),
  instructions: z.string().trim().min(1).max(2000),
  criteria: z.object({
    true: z.string().trim().min(1).max(500),
    false: z.string().trim().min(1).max(500)
  }).strict().optional()
}).strict();

const choiceQuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().trim().min(1).max(2000),
  criteria: z.record(z.string().trim().min(1).max(120), z.string().trim().min(1).max(500))
}).strict().superRefine((value, context) => {
  if (Object.keys(value.criteria).length < 2) {
    context.addIssue({ code: "custom", message: "Choice needs at least 2 options." });
  }
});

const scoreQuestionSchema = z.object({
  type: z.literal("score"),
  instructions: z.string().trim().min(1).max(2000),
  criteria: z.array(z.string().trim().min(1).max(500)).min(2).max(16)
}).strict();

export const jevQuestionSchema = z.union([noulQuestionSchema, choiceQuestionSchema, scoreQuestionSchema]);
export type JevQuestion = z.infer<typeof jevQuestionSchema>;

export const jevDecideInputSchema = z.object({
  state: z.unknown(),
  questions: z.record(z.string().trim().min(1).max(120), jevQuestionSchema).refine(
    (questions) => Object.keys(questions).length >= 1 && Object.keys(questions).length <= 16,
    "Provide 1 through 16 questions."
  )
}).strict();
export type JevDecideInput = z.infer<typeof jevDecideInputSchema>;

const jevAnswerSchema = z.unknown();

export const jevDecideResultSchema = z.union([
  z.object({
    available: z.literal(true),
    answers: z.record(z.string(), jevAnswerSchema),
    model: z.string().nullable().default(null),
    usage: z.object({
      inputTokens: z.number().int().min(0).nullable().default(null),
      outputTokens: z.number().int().min(0).nullable().default(null),
      cost: z.number().nullable().default(null)
    }).strict().default({ inputTokens: null, outputTokens: null, cost: null }),
    latencyMs: z.number().min(0)
  }).strict(),
  z.object({
    available: z.literal(false),
    reason: z.string().trim().min(1).max(500),
    degraded: z.literal(true)
  }).strict()
]);
export type JevDecideResult = z.infer<typeof jevDecideResultSchema>;

export const JEV_NOT_CONFIGURED_REASON = "Jev decisions are not configured; continuing without them.";
export const JEV_DISABLED_REASON = "Jev decisions are disabled for this room; continuing without them.";

export const taskCompletionStatusSchema = z.enum(["YES", "NO", "NEEDS_REVIEW"]);
export type TaskCompletionStatus = z.infer<typeof taskCompletionStatusSchema>;

export const recoveryActionSchema = z.enum(["retry_same_agent", "switch_agent", "inspect_logs", "rollback", "ask_user"]);
export type RecoveryAction = z.infer<typeof recoveryActionSchema>;

export const agentRouteSchema = z.enum(["codex", "claude_code", "gemini", "opencode", "shell_fast", "clarify"]);
export type AgentRoute = z.infer<typeof agentRouteSchema>;

export interface SafetyGuardOutcome {
  available: boolean;
  isDestructive: boolean;
  confidence: number;
  touchesProduction: boolean;
  reason?: string;
  degraded?: boolean;
}

export interface SilentFailureOutcome {
  available: boolean;
  hasSilentFailure: boolean;
  confidence: number;
  reason?: string;
  degraded?: boolean;
}

export interface TaskCompletionOutcome {
  available: boolean;
  status: TaskCompletionStatus | null;
  confidence: number | null;
  reason?: string;
  degraded?: boolean;
}

export interface RecoveryActionOutcome {
  available: boolean;
  action: RecoveryAction | null;
  confidence: number | null;
  reason?: string;
  degraded?: boolean;
}

export const modelTierSchema = z.enum(["flash", "standard", "pro"]);
export type ModelTier = z.infer<typeof modelTierSchema>;

export interface ModelTierOutcome {
  available: boolean;
  tier: ModelTier;
  complexityScore: number;
  reason?: string;
  degraded?: boolean;
}

export interface AgentRouteOutcome {
  available: boolean;
  route: AgentRoute | null;
  confidence: number | null;
  isAmbiguous: boolean;
  ambiguousScore: number;
  reason?: string;
  degraded?: boolean;
}

export const concurrencyActionSchema = z.enum(["allow", "wait", "queue", "isolate_worktree"]);
export type ConcurrencyAction = z.infer<typeof concurrencyActionSchema>;

export interface ConcurrencyConflictOutcome {
  available: boolean;
  action: ConcurrencyAction;
  conflictingFiles: string[];
  confidence?: number | null;
  reason?: string;
  degraded?: boolean;
}

export interface ToolSurfaceOutcome {
  available: boolean;
  needsBrowser: boolean;
  filteredTools: string[];
  confidence?: number | null;
  reason?: string;
  degraded?: boolean;
}

export interface MemoryRelevanceOutcome {
  available: boolean;
  ranked: Array<{ id: string; text: string; score: number }>;
  reason?: string;
  degraded?: boolean;
}
