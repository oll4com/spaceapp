import { describe, expect, it } from "vitest";
import * as contracts from "../src/index.js";

// ARCH-002: "a run the operator started names its actor" is one business rule that the memory consolidation run and
// its create input share. This pins what each answers with and without an actor (message and path), so moving the
// rule changes nothing.
type Parse = { safeParse(input: unknown): { success: boolean; error?: { issues: Array<{ message: string; path: unknown[] }> } } };
const at = "2026-10-28T12:00:00.000Z";
const created = { mode: "AUDIT", workflowId: "wf:memory0001", dedupeKey: "memory-audit-1" };
const run = {
  ...created, id: "mcr:run00001", status: "QUEUED", sourceHash: null, progressCompleted: 0, progressTotal: 0, findingCount: 0,
  appliedOperationCount: 0, skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null, aiVerified: false,
  aiEvidence: {}, statusReason: null, createdAt: at, startedAt: null, completedAt: null, updatedAt: at
};
const cases = [
  { name: "memoryConsolidationRunSchema", schema: contracts.memoryConsolidationRunSchema as Parse, base: run },
  { name: "createMemoryConsolidationRunInputSchema", schema: contracts.createMemoryConsolidationRunInputSchema as Parse, base: created }
];

describe("operator-started runs that must name their actor", () => {
  for (const item of cases) {
    it(`${item.name}: an operator run without an actor is refused at actorUserId, other runs need none`, () => {
      const issues = (input: object) => item.schema.safeParse({ ...item.base, ...input }).error?.issues.map((issue) => [issue.message, issue.path]) ?? [];
      expect(issues({ triggerKind: "OPERATOR", actorUserId: null })).toEqual([["Operator runs require an actor.", ["actorUserId"]]]);
      expect(issues({ triggerKind: "OPERATOR", actorUserId: "user:operator" })).toEqual([]);
      expect(issues({ triggerKind: "SCHEDULED", actorUserId: null })).toEqual([]);
    });
  }
  it("memoryConsolidationRunSchema: the actor check keeps its place among the run's other checks", () => {
    const result = (contracts.memoryConsolidationRunSchema as Parse).safeParse({ ...run, triggerKind: "OPERATOR", actorUserId: null, progressCompleted: 2, progressTotal: 1, status: "RUNNING" });
    expect(result.error?.issues.map((issue) => [issue.message, issue.path])).toEqual([
      ["Completed progress cannot exceed total progress.", ["progressCompleted"]],
      ["Operator runs require an actor.", ["actorUserId"]],
      ["Running consolidations require a start timestamp.", ["startedAt"]]
    ]);
  });
});
