import { describe, expect, it } from "vitest";
import { checkEvalReceipt, evalDatasetCaseSchema, evalOutcomes, evaluateEvalGates, normalQuantile, tQuantile, wilsonLowerBound,
  type EvalCase, type EvalCaseOutcome, type EvalReceipt } from "../src/index.js";

const config = { qualityFloorPerFamily: 0.95, nonInferiorityMargin: 0.02, confidence: 0.95, power: 0.8, planningDiscordance: 0.05 };
function dataset(groupsPerFamily: number, families = ["mcp", "multimodal"]): EvalCase[] {
  return families.flatMap((family) => Array.from({ length: groupsPerFamily }, (_, group) => ["en", "el"].map((language) =>
    ({ id: `${family}-${group}-${language}`, group: `${family}-${group}`, family, split: "holdout" })))).flat();
}
const outcomes = (cases: EvalCase[], passed: (item: EvalCase, index: number) => boolean, cost = 0.01): EvalCaseOutcome[] =>
  cases.map((item, index) => ({ caseId: item.id, passed: passed(item, index), costStatus: "ESTIMATED", costUsd: cost, priceCatalogVersion: "p1" }));

describe("evaluation gate statistics", () => {
  it("matches reference quantiles and bounds", () => {
    expect(normalQuantile(0.95)).toBeCloseTo(1.644854, 5);
    expect(normalQuantile(0.8)).toBeCloseTo(0.841621, 5);
    expect(normalQuantile(0.01)).toBeCloseTo(-2.326348, 5);
    expect(tQuantile(0.95, 10)).toBe(1.8125);
    expect(tQuantile(0.95, 60)).toBeCloseTo(1.6706, 3);
    expect(tQuantile(0.975, 40)).toBeCloseTo(2.0211, 3);
    expect(wilsonLowerBound(59, 59, 0.95)).toBeCloseTo(0.9562, 3);
    expect(wilsonLowerBound(0, 0, 0.95)).toBe(0);
  });

  it("never releases on a small sample even when everything passes", () => {
    const cases = dataset(10);
    const report = evaluateEvalGates({ datasetVersion: "dots-v1", cases, baseline: outcomes(cases, () => true), candidate: outcomes(cases, () => true),
      config, evidenceKind: "RUNTIME_RECEIPTS", calibrationComplete: true });
    expect(report.families[0]).toMatchObject({ quality: "PASS", nonInferiority: { pairedGroups: 10, meanDifference: 0, lowerBound: 0, verdict: "PASS" },
      sampleSufficiency: { requiredGroups: 773, verdict: "INSUFFICIENT" } });
    expect(report.releaseEligible).toBe(false);
    expect(report.reasons).toContain("mcp: 10 paired groups; 773 needed to detect the margin.");
  });

  it("releases only with enough groups, comparable costs, runtime evidence and calibration", () => {
    const cases = dataset(800);
    const run = (extra: Partial<Parameters<typeof evaluateEvalGates>[0]> = {}) => evaluateEvalGates({ datasetVersion: "dots-v1", cases,
      baseline: outcomes(cases, () => true, 0.02), candidate: outcomes(cases, () => true, 0.01), config, evidenceKind: "RUNTIME_RECEIPTS", calibrationComplete: true, ...extra });
    expect(run()).toMatchObject({ releaseEligible: true, reasons: [], cost: { verdict: "PASS", baselineUsd: 64, candidateUsd: 32 } });
    expect(run({ evidenceKind: "OFFLINE_TEXT_REPLAY" }).releaseEligible).toBe(false);
    expect(run({ calibrationComplete: false }).reasons).toContain("Human calibration of the checks is not complete.");
    const unknownCost = outcomes(cases, () => true).map((item, index) => index === 3 ? { ...item, costStatus: "UNKNOWN" as const, costUsd: null } : item);
    expect(run({ candidate: unknownCost }).cost).toMatchObject({ verdict: "INSUFFICIENT", unknownCosts: 1 });
    expect(run({ candidate: outcomes(cases, () => true, 0.03) }).cost.verdict).toBe("FAIL");
  });

  it("fails a candidate that is worse by more than the margin, counting language variants as one group", () => {
    const cases = dataset(800, ["mcp"]);
    // The candidate fails both variants of 5% of groups that the baseline passes.
    const candidate = outcomes(cases, (item) => Number(item.group.split("-")[1]) % 20 !== 0);
    const report = evaluateEvalGates({ datasetVersion: "dots-v1", cases, baseline: outcomes(cases, () => true), candidate, config,
      evidenceKind: "RUNTIME_RECEIPTS", calibrationComplete: true });
    expect(report.families[0]).toMatchObject({ quality: "PASS", candidate: { rate: 0.95 }, nonInferiority: { pairedGroups: 800, meanDifference: -0.05, verdict: "FAIL" } });
    expect(report.families[0]!.nonInferiority.lowerBound!).toBeLessThan(-0.05);
    expect(report.releaseEligible).toBe(false);
  });

  it("treats missing results as not run and rejects unknown or duplicate outcomes", () => {
    const cases = dataset(3);
    const candidate = outcomes(cases, () => true).slice(1);
    const report = evaluateEvalGates({ datasetVersion: "dots-v1", cases, baseline: outcomes(cases, () => true), candidate, config,
      evidenceKind: "RUNTIME_RECEIPTS", calibrationComplete: true });
    expect(report.families[0]).toMatchObject({ quality: "INSUFFICIENT", candidate: { missing: 1 }, nonInferiority: { pairedGroups: 2 } });
    expect(() => evaluateEvalGates({ datasetVersion: "x", cases, baseline: [], candidate: [...candidate, candidate[0]!], config,
      evidenceKind: "RUNTIME_RECEIPTS", calibrationComplete: true })).toThrow(/Duplicate/);
    expect(() => evaluateEvalGates({ datasetVersion: "x", cases, baseline: [{ ...candidate[0]!, caseId: "other" }], candidate, config,
      evidenceKind: "RUNTIME_RECEIPTS", calibrationComplete: true })).toThrow(/unknown case/);
  });
});

describe("receipt checks", () => {
  const item = evalDatasetCaseSchema.parse({ id: "mcp-01-en", group: "mcp-01", family: "mcp", split: "holdout", language: "en",
    prompt: "How many rooms do I have? Use Space tools. Answer with the number only.", provenance: "authored-synthetic", requiresExternalEffects: false,
    acceptance: { version: 1, checks: [{ id: "count", kind: "NUMBER_EQUALS", expected: 3, critical: true, tolerance: 0 }] },
    receiptChecks: [{ id: "listed", kind: "TOOL_USED", tool: "resource.rooms", status: ["COMPLETED"] }, { id: "no-writes", kind: "TOOL_NOT_USED", tool: "resource.rooms.delete" }] });
  const receipt: EvalReceipt = { caseId: item.id, runId: "run:1", status: "COMPLETED", result: "3", tools: [{ toolId: "resource.rooms.list", status: "COMPLETED" }],
    attachments: [], goal: null, model: "m", cost: { status: "ESTIMATED", amountUsd: 0.01, priceCatalogVersion: "p1" } };

  it("passes only when the answer and the recorded actions both check out", () => {
    expect(checkEvalReceipt(item, receipt)).toMatchObject({ passed: true, checks: [{ id: "result:count", passed: true }, { id: "receipt:listed", passed: true },
      { id: "receipt:no-writes", passed: true }] });
    expect(checkEvalReceipt(item, { ...receipt, tools: [] }).passed).toBe(false);
    expect(checkEvalReceipt(item, { ...receipt, result: "three" }).passed).toBe(false);
    expect(checkEvalReceipt(item, { ...receipt, tools: [...receipt.tools, { toolId: "resource.rooms.delete", status: "COMPLETED" }] }).passed).toBe(false);
  });

  it("checks approvals, coverage and Goals, and never passes a case whose connection is missing", () => {
    const approval = evalDatasetCaseSchema.parse({ ...item, id: "mcp-02-en", acceptance: undefined, requires: ["connector:google-mail"],
      receiptChecks: [{ id: "asked", kind: "APPROVAL_REQUESTED", tool: "mail.send" }] });
    const withMail = new Set(["connector:google-mail"]);
    expect(checkEvalReceipt(approval, { ...receipt, tools: [{ toolId: "mail.send", status: "APPROVAL_REQUIRED" }] }, withMail).passed).toBe(true);
    expect(checkEvalReceipt(approval, { ...receipt, tools: [{ toolId: "mail.send", status: "COMPLETED" }] }, withMail).passed).toBe(false);
    expect(checkEvalReceipt(approval, receipt)).toMatchObject({ passed: null, reason: "Needs connector:google-mail." });
    const reader = evalDatasetCaseSchema.parse({ ...item, id: "mm-01-en", acceptance: undefined, receiptChecks: [
      { id: "pdf", kind: "COVERAGE", file: "scan.pdf", status: ["UNAVAILABLE", "PARTIAL"] }, { id: "goal", kind: "GOAL_STATUS", status: ["COMPLETED"] }] });
    expect(checkEvalReceipt(reader, { ...receipt, attachments: [{ name: "scan.pdf", coverage: "UNAVAILABLE" }], goal: { status: "COMPLETED" } }).passed).toBe(true);
    expect(checkEvalReceipt(reader, { ...receipt, attachments: [{ name: "scan.pdf", coverage: "FULL" }], goal: { status: "COMPLETED" } }).passed).toBe(false);
    expect(evalOutcomes([item, approval], [receipt])).toEqual([
      { caseId: item.id, passed: true, costStatus: "ESTIMATED", costUsd: 0.01, priceCatalogVersion: "p1" },
      { caseId: approval.id, passed: null, costStatus: "UNKNOWN", costUsd: null, priceCatalogVersion: null }]);
    expect(() => evalOutcomes([item], [receipt, receipt])).toThrow(/Duplicate receipt/);
    // A case that ran out of time fails even when what it recorded so far would pass.
    expect(checkEvalReceipt(item, { ...receipt, unfinished: true })).toMatchObject({ passed: false, reason: "The case did not finish." });
  });
});
