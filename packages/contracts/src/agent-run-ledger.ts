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

export const agentRunLedgerSchema = z.object({
  version: z.literal(1),
  recordedAt: timestamp.nullable(),
  model: z.object({
    value: z.string().min(1).max(200).nullable(),
    source: z.enum(["RUNTIME_START", "NOT_REPORTED"]),
    scope: z.literal("STARTUP_ONLY"),
    observedAt: timestamp.nullable()
  }).strict(),
  usage: z.object({ status: z.literal("UNKNOWN"), reason }).strict(),
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
    usage: previous?.usage ?? { status: "UNKNOWN", reason: "No task-scoped runtime usage receipt was recorded." },
    cost: previous?.cost ?? { status: "UNKNOWN", amountUsd: null, source: null, observedAt: null, priceCatalogVersion: null,
      reason: "No complete task billing receipt or versioned estimate covers model calls, tools, retries and evaluation." },
    evaluation
  });
}
