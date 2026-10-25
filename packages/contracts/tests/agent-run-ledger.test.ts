import { describe, expect, it } from "vitest";
import { agentRunCostSchema, agentRunEvaluationSchema, transitionAgentRunLedger } from "../src/agent-run-ledger.js";
const at = "2026-09-30T03:00:00.000Z";

describe("Task ledger truthfulness", () => {
  it.each(["COMPLETED", "FAILED", "INTERRUPTED"] as const)("records an explicit unscorable reason for %s", status => {
    const ledger = transitionAgentRunLedger({ status, at });
    expect(ledger.evaluation).toMatchObject({ status: "UNSCORABLE", assessedAt: at, reason: expect.any(String) });
    expect(ledger.cost).toMatchObject({ status: "UNKNOWN", amountUsd: null });
    expect(ledger.model).toMatchObject({ source: "NOT_REPORTED", value: null, observedAt: null });
  });
  it("preserves model observation provenance through completion and keeps historical times unknown", () => {
    const initial = transitionAgentRunLedger({ status: "RUNNING", at, runtimeModelAtStart: "reported" });
    const completed = transitionAgentRunLedger({ current: initial, status: "COMPLETED", at: "2026-09-30T03:01:00.000Z" });
    expect(completed.model).toEqual(initial.model);
    expect(transitionAgentRunLedger({ status: "COMPLETED", at: null, runtimeModelAtStart: "old" }).model.observedAt).toBeNull();
  });
  it("requires a source for billed cost, versioned pricing for estimates and evidence for scoring", () => {
    expect(agentRunCostSchema.safeParse({ status: "ACTUAL", amountUsd: 0 }).success).toBe(false);
    expect(agentRunCostSchema.safeParse({ status: "ESTIMATED", amountUsd: 0.01, source: "pricing", observedAt: at,
      reason: null, priceCatalogVersion: null }).success).toBe(false);
    expect(agentRunEvaluationSchema.safeParse({ status: "SCORED", qualityScore: 100 }).success).toBe(false);
  });
  it("does not carry a scored success over cancellation or execution failure", () => {
    const scored = transitionAgentRunLedger({ status: "COMPLETED", at, evaluation: { status: "SCORED", reason: null,
      assessedAt: at, evaluator: "objective-validator", rubricVersion: "1", qualityScore: 100,
      criticalFailure: false, evidenceIds: ["artifact:test"] } });
    for (const status of ["FAILED", "INTERRUPTED"] as const) {
      expect(transitionAgentRunLedger({ current: scored, status, at }).evaluation.status).toBe("UNSCORABLE");
    }
  });
  it("rejects scored evidence that hides a failed critical check", () => {
    expect(agentRunEvaluationSchema.safeParse({ status: "SCORED", reason: null, assessedAt: at,
      evaluator: "space:objective-validator", rubricVersion: "declared-checks-v1", qualityScore: 100,
      criticalFailure: false, evidenceIds: ["agent_run:test"], validation: {
        scope: "DECLARED_CHECKS_ONLY", resultSha256: "a".repeat(64),
        checks: [{ id: "answer", kind: "NUMBER_EQUALS", passed: false, critical: true }] } }).success).toBe(false);
  });
});
