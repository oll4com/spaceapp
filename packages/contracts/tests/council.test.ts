import { describe, expect, it } from "vitest";
import { councilApproveInputSchema, councilEvidenceSchema, councilPlanSchema, councilRunSchema, createCouncilRunInputSchema } from "../src/council.js";

const plan = {
  understanding: "Ways for Nikos to earn 100 euros in one day.",
  personalContext: "Lives in Athens; software developer.",
  members: [{ modelId: "codex/gpt-6-astra", reason: "web research" }, { modelId: "claude/claude-opus-5-5", reason: "reasoning" }],
  reviewRounds: 1,
  agreementTarget: 0.67,
  criteria: [{ id: "feasibility", label: "Feasible today" }],
  searchQueries: ["same day gig work Athens"]
};
const at = "2026-10-14T12:00:00.000Z";

describe("council contracts", () => {
  it("accepts a complete run", () => {
    expect(councilRunSchema.parse({
      id: "council_run:abcdef123456", ownerUserId: "user:operator", question: "How can I earn 100 euros today?", coordinatorModelId: "claude/claude-opus-5-5",
      status: "COMPLETED", stage: "DONE", plan, estimate: { calls: 9, minutes: 4 }, qa: [{ questions: [{ id: "q1", text: "City?" }], answers: { q1: "Athens" } }],
      changeRequests: [], evidence: [{ title: "Wolt", url: "https://wolt.com/couriers", finding: "Couriers are paid per delivery." }],
      answers: [{ modelId: "codex/gpt-6-astra", status: "DONE", text: "Deliver food.", claims: ["Courier shifts pay daily."], error: null, ms: 1200 }],
      rounds: [{ round: 1, merged: "Merged", positions: [{ id: "P1", title: "Courier", summary: "Deliver", support: 2 }],
        reviews: [{ modelId: "codex/gpt-6-astra", status: "DONE", scores: [{ positionId: "P1", score: 8, verdict: "agree", issue: "" }], corrections: [], missing: [], error: null }],
        ranking: [{ positionId: "P1", mean: 8, agreeShare: 1, spread: 0, reviewers: 1, qualified: true }] }],
      final: { text: "Final", top: [{ positionId: "P1", title: "Courier", mean: 8, agree: 1, reviewers: 1 }] },
      events: [{ at, text: "Done" }], error: null, createdAt: at, updatedAt: at
    }).status).toBe("COMPLETED");
  });

  it("bounds the plan: at least two members, known providers, at most three planned rounds", () => {
    expect(councilPlanSchema.safeParse(plan).success).toBe(true);
    expect(councilPlanSchema.safeParse({ ...plan, members: plan.members.slice(0, 1) }).success).toBe(false);
    expect(councilPlanSchema.safeParse({ ...plan, members: [...plan.members, { modelId: "baseline/scripted-pilot", reason: "" }] }).success).toBe(false);
    expect(councilPlanSchema.safeParse({ ...plan, reviewRounds: 4 }).success).toBe(false);
  });

  it("keeps only http(s) evidence links", () => {
    expect(councilEvidenceSchema.safeParse({ title: "x", url: "javascript:alert(1)", finding: "" }).success).toBe(false);
    expect(councilEvidenceSchema.safeParse({ title: "x", url: "https://example.com/a", finding: "" }).success).toBe(true);
  });

  it("validates operator inputs", () => {
    expect(createCouncilRunInputSchema.safeParse({ question: "  " }).success).toBe(false);
    expect(createCouncilRunInputSchema.parse({ question: " How can I earn 100 euros? " }).question).toBe("How can I earn 100 euros?");
    expect(councilApproveInputSchema.safeParse({ members: ["codex/gpt-6-astra"] }).success).toBe(false);
  });
});
