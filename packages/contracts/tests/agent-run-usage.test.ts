import { describe, expect, it } from "vitest";
import { estimateAgentRunCost, transitionAgentRunLedger, type AgentRunMeasuredUsage } from "../src/index.js";

const at = "2026-10-11T08:00:00.000Z";
const usage: AgentRunMeasuredUsage = { status: "MEASURED", inputTokens: 12_000, cachedInputTokens: 10_000, outputTokens: 1_000,
  reasoningOutputTokens: 400, totalTokens: 13_000, source: "codex-app-server:thread/tokenUsage/updated", observedAt: at, model: "gpt-test" };
const catalog = { version: "prices-2026-10", currency: "USD" as const, prices: [{ model: "gpt-test", inputPerMillion: 2, cachedInputPerMillion: 0.5, outputPerMillion: 8 }] };

describe("task usage and cost", () => {
  it("estimates cost only from a versioned price for the reported model", () => {
    // 2,000 uncached × $2 + 10,000 cached × $0.5 + 1,000 output × $8, per million.
    expect(estimateAgentRunCost(usage, catalog, at)).toEqual({ status: "ESTIMATED", reason: null, amountUsd: 0.017, source: "tokens × prices-2026-10",
      observedAt: at, priceCatalogVersion: "prices-2026-10" });
    expect(estimateAgentRunCost(usage, null, at)).toMatchObject({ status: "UNKNOWN", reason: expect.stringMatching(/No price catalog is configured; 13,000 tokens/) });
    expect(estimateAgentRunCost({ ...usage, model: "other" }, catalog, at)).toMatchObject({ status: "UNKNOWN", reason: "Price catalog prices-2026-10 has no price for other." });
    expect(estimateAgentRunCost({ ...usage, model: null }, catalog, at)).toMatchObject({ status: "UNKNOWN" });
  });

  it("keeps measured usage and cost through later run transitions", () => {
    const started = transitionAgentRunLedger({ status: "RUNNING", at });
    expect(started.usage.status).toBe("UNKNOWN");
    const measured = transitionAgentRunLedger({ current: started, status: "RUNNING", at, usage, cost: estimateAgentRunCost(usage, catalog, at) });
    const completed = transitionAgentRunLedger({ current: measured, status: "COMPLETED", at });
    expect(completed.usage).toEqual(usage);
    expect(completed.cost).toMatchObject({ status: "ESTIMATED", amountUsd: 0.017 });
  });
});
