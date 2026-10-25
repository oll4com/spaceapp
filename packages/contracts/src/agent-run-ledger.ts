import { z } from "zod";
import { taskValidationEvidenceSchema } from "./task-acceptance.js";

const timestamp = z.string().datetime({ offset: true });
const reason = z.string().min(1).max(1000);
const source = z.string().min(1).max(160);

// Accounting covers the whole task, including tools, retries and evaluation.
// A runtime's startup model or a thread-wide token counter is not a billing receipt.
export const agentRunCostSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("UNKNOWN"), reason, amountUsd: z.null(), source: z.null(),
    observedAt: z.null(), priceCatalogVersion: z.null() }).strict(),
  z.object({ status: z.literal("ACTUAL"), reason: z.null(), amountUsd: z.number().finite().nonnegative(),
    source, observedAt: timestamp, priceCatalogVersion: z.string().min(1).max(160).nullable() }).strict(),
  z.object({ status: z.literal("ESTIMATED"), reason: z.null(), amountUsd: z.number().finite().nonnegative(),
    source, observedAt: timestamp, priceCatalogVersion: z.string().min(1).max(160) }).strict()
]);

export const agentRunEvaluationSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("PENDING"), reason, assessedAt: z.null() }).strict(),
  z.object({ status: z.literal("UNSCORABLE"), reason, assessedAt: timestamp.nullable() }).strict(),
  z.object({ status: z.literal("SCORED"), reason: z.null(), assessedAt: timestamp,
    evaluator: source, rubricVersion: source, qualityScore: z.number().min(0).max(100),
    criticalFailure: z.boolean(), evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(32),
    validation: taskValidationEvidenceSchema.optional() }).strict().superRefine((value, context) => {
      if (!value.validation) return;
      const checks = value.validation.checks;
      const score = checks.filter(check => check.passed).length / checks.length * 100;
      if (value.qualityScore !== score || value.criticalFailure !== checks.some(check => check.critical && !check.passed)) {
        context.addIssue({ code: "custom", message: "Declared check score and critical failure must match their evidence." });
      }
    })
]);

const tokens = z.number().int().min(0).max(1_000_000_000_000);
/**
 * Space Dots Stage 7: token usage the runtime reported for this task's turn.
 * MEASURED counts only what the runtime reported (for Codex, `thread/tokenUsage/updated`
 * deltas within the turn); tools and evaluation outside the model are not tokens.
 */
export const agentRunMeasuredUsageSchema = z.object({
  status: z.literal("MEASURED"),
  inputTokens: tokens,
  cachedInputTokens: tokens,
  outputTokens: tokens,
  reasoningOutputTokens: tokens,
  totalTokens: tokens,
  source: source,
  observedAt: timestamp,
  model: z.string().min(1).max(200).nullable()
}).strict();
export const agentRunUsageSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("UNKNOWN"), reason }).strict(),
  agentRunMeasuredUsageSchema
]);
export type AgentRunMeasuredUsage = z.infer<typeof agentRunMeasuredUsageSchema>;
export type AgentRunUsage = z.infer<typeof agentRunUsageSchema>;
export type AgentRunCost = z.infer<typeof agentRunCostSchema>;

/**
 * A versioned price list the operator provides. Space ships no prices: an
 * estimate exists only for a model priced here, otherwise cost stays UNKNOWN.
 */
export const modelPriceCatalogSchema = z.object({
  // Short enough that the cost source "tokens × <version>" stays within its 160-character limit.
  version: z.string().min(1).max(120),
  currency: z.literal("USD"),
  prices: z.array(z.object({
    model: z.string().min(1).max(200),
    inputPerMillion: z.number().finite().nonnegative(),
    cachedInputPerMillion: z.number().finite().nonnegative().optional(),
    outputPerMillion: z.number().finite().nonnegative()
  }).strict()).max(500)
}).strict();
export type ModelPriceCatalog = z.infer<typeof modelPriceCatalogSchema>;

/** Estimates a turn's model cost from measured tokens; reasoning tokens are billed as output. */
export function estimateAgentRunCost(usage: AgentRunMeasuredUsage, catalog: ModelPriceCatalog | null, at: string): AgentRunCost {
  const unknown = (text: string): AgentRunCost => ({ status: "UNKNOWN", amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null, reason: text });
  if (!usage.model) return unknown("The runtime did not report the model, so no price applies.");
  if (!catalog) return unknown(`No price catalog is configured; ${usage.totalTokens.toLocaleString("en-US")} tokens were measured.`);
  const price = catalog.prices.find((entry) => entry.model === usage.model);
  if (!price) return unknown(`Price catalog ${catalog.version} has no price for ${usage.model}.`);
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const amount = (uncached * price.inputPerMillion + usage.cachedInputTokens * (price.cachedInputPerMillion ?? price.inputPerMillion)
    + usage.outputTokens * price.outputPerMillion) / 1_000_000;
  return { status: "ESTIMATED", reason: null, amountUsd: Math.round(amount * 1_000_000) / 1_000_000, source: `tokens × ${catalog.version}`,
    observedAt: at, priceCatalogVersion: catalog.version };
}

export const agentRunLedgerSchema = z.object({
  version: z.literal(1),
  recordedAt: timestamp.nullable(),
  model: z.object({
    value: z.string().min(1).max(200).nullable(),
    source: z.enum(["RUNTIME_START", "NOT_REPORTED"]),
    scope: z.literal("STARTUP_ONLY"),
    observedAt: timestamp.nullable()
  }).strict(),
  usage: agentRunUsageSchema,
  cost: agentRunCostSchema,
  evaluation: agentRunEvaluationSchema
}).strict();

export type AgentRunLedger = z.infer<typeof agentRunLedgerSchema>;
export type AgentRunEvaluation = z.infer<typeof agentRunEvaluationSchema>;
export type AgentRunStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "INTERRUPTED";

function evaluationForStatus(status: AgentRunStatus, at: string | null): AgentRunEvaluation {
  if (status === "QUEUED" || status === "RUNNING") {
    return { status: "PENDING", reason: "Execution has not finished; no quality assessment is available.", assessedAt: null };
  }
  return { status: "UNSCORABLE", assessedAt: at, reason: status === "FAILED"
    ? "Execution failed; answer quality was not assessed."
    : status === "INTERRUPTED"
      ? "Execution was stopped; this is not an agent quality failure."
      : "No task-specific quality validator or calibrated judge has assessed this result." };
}

/** Used by both stores in the same transaction as each run transition. */
export function transitionAgentRunLedger(input: {
  current?: AgentRunLedger | null;
  status: AgentRunStatus;
  at: string | null;
  runtimeModelAtStart?: string | null;
  evaluation?: AgentRunEvaluation;
  /** Measured usage and its cost estimate, once the runtime reports them. */
  usage?: AgentRunMeasuredUsage;
  cost?: AgentRunCost;
}): AgentRunLedger {
  const previous = input.current;
  const model = input.runtimeModelAtStart === undefined && previous ? previous.model : {
    value: input.runtimeModelAtStart ?? null,
    source: input.runtimeModelAtStart ? "RUNTIME_START" as const : "NOT_REPORTED" as const,
    scope: "STARTUP_ONLY" as const,
    observedAt: input.runtimeModelAtStart ? input.at : null
  };
  // Preserve a scored result only on completion, never over failed/stopped execution.
  const evaluation = input.status === "FAILED" || input.status === "INTERRUPTED"
    ? evaluationForStatus(input.status, input.at)
    : input.evaluation ?? (input.status === "COMPLETED" && previous?.evaluation.status === "SCORED"
      ? previous.evaluation : evaluationForStatus(input.status, input.at));
  return agentRunLedgerSchema.parse({
    version: 1, recordedAt: input.at, model,
    usage: input.usage ?? previous?.usage ?? { status: "UNKNOWN", reason: "No task-scoped runtime usage receipt was recorded." },
    cost: input.cost ?? previous?.cost ?? { status: "UNKNOWN", amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null,
      reason: "No complete task billing receipt or versioned estimate covers model calls, tools, retries and evaluation." },
    evaluation
  });
}
