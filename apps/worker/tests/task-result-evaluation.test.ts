import { describe, expect, it } from "vitest";
import { taskAcceptanceSchema, transitionAgentRunLedger, type SpaceAgentRunRecord } from "@space/contracts";
import { evaluateCompletedTaskResult } from "../src/task-result-evaluation.js";

/** Verified-success semantics: execution completion never implies a passed acceptance test. */
const at = "2026-10-11T12:00:00.000Z";
function run(acceptance?: unknown): SpaceAgentRunRecord {
  return { runId: "agent_run:acceptance", responseMessageId: "agent_msg:answer",
    execution: acceptance ? { acceptance: taskAcceptanceSchema.parse(acceptance) } : null } as unknown as SpaceAgentRunRecord;
}
const checks = { version: 1, checks: [
  { id: "total", kind: "NUMBER_EQUALS", expected: 42 },
  { id: "unit", kind: "TEXT_INCLUDES", expected: "EUR", critical: false }
] };

describe("declared acceptance checks", () => {
  it("scores a failed critical check as a critical failure, never as success", () => {
    const evaluation = evaluateCompletedTaskResult(run(checks), "41", at)!;
    expect(evaluation).toMatchObject({ status: "SCORED", qualityScore: 0, criticalFailure: true,
      validation: { scope: "DECLARED_CHECKS_ONLY", checks: [{ id: "total", passed: false, critical: true }, { id: "unit", passed: false, critical: false }] } });
    // The ledger keeps the failure next to a COMPLETED execution status.
    expect(transitionAgentRunLedger({ status: "COMPLETED", at, evaluation }).evaluation).toMatchObject({ status: "SCORED", criticalFailure: true });
  });

  it("does not let a passing non-critical check hide a failed critical one, and only all checks give 100", () => {
    expect(evaluateCompletedTaskResult(run(checks), "41 EUR", at)).toMatchObject({ qualityScore: 50, criticalFailure: true });
    expect(evaluateCompletedTaskResult(run(checks), "42", at)).toMatchObject({ qualityScore: 50, criticalFailure: false });
    expect(evaluateCompletedTaskResult(run({ version: 1, checks: [checks.checks[0]] }), "42", at)).toMatchObject({ qualityScore: 100, criticalFailure: false });
  });

  it("reports a missing result or missing acceptance as unscorable, never as scored success", () => {
    expect(evaluateCompletedTaskResult(run(checks), "   ", at)).toEqual({ status: "UNSCORABLE", assessedAt: at,
      reason: "No readable final response was available for the declared checks." });
    expect(evaluateCompletedTaskResult(run(), "42", at)).toBeUndefined();
    expect(transitionAgentRunLedger({ status: "COMPLETED", at }).evaluation).toEqual({ status: "UNSCORABLE", assessedAt: at,
      reason: "No task-specific quality validator or calibrated judge has assessed this result." });
  });
});
