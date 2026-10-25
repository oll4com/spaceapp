import { createHash } from "node:crypto";
import { validateTaskResult, type AgentRunEvaluation, type SpaceAgentRunRecord } from "@space/contracts";

/** Local checks introduce no extra provider calls, retries or external effects. */
export function evaluateCompletedTaskResult(run: SpaceAgentRunRecord, result: string, at: string, responseMessageId = run.responseMessageId): AgentRunEvaluation | undefined {
  if (!run.execution?.acceptance) return undefined;
  if (!result.trim()) return { status: "UNSCORABLE", assessedAt: at, reason: "No readable final response was available for the declared checks." };
  const checks = validateTaskResult(run.execution.acceptance, result);
  return {
    status: "SCORED", reason: null, assessedAt: at,
    evaluator: "space:objective-validator", rubricVersion: "declared-checks-v1",
    qualityScore: checks.filter(check => check.passed).length / checks.length * 100,
    criticalFailure: checks.some(check => check.critical && !check.passed),
    evidenceIds: [run.runId, responseMessageId],
    validation: { scope: "DECLARED_CHECKS_ONLY", resultSha256: createHash("sha256").update(result).digest("hex"), checks }
  };
}
