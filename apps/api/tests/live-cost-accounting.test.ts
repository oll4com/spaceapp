import { describe, expect, it } from "vitest";
import { isVoiceDailyBudgetExceeded, summarizeVoiceDelegationCosts } from "../src/live-cost-accounting.js";

describe("voice cost accounting", () => {
  it("is owner and time scoped and separates unknown costs", () => {
    const summary = summarizeVoiceDelegationCosts([
      { actorUserId: "owner", action: "voice.realtime.delegate", createdAt: "2026-09-19T10:00:00.000Z", metadata: { telemetry: { provider: "google", estimatedCostUsd: 0.2, latencyMs: 40 } } },
      { actorUserId: "other", action: "voice.realtime.delegate", createdAt: "2026-09-19T10:00:00.000Z", metadata: { telemetry: { provider: "openai", estimatedCostUsd: 9 } } },
      { actorUserId: "owner", action: "voice.realtime.delegate", createdAt: "2026-09-18T10:00:00.000Z", metadata: { telemetry: { provider: "vercel", estimatedCostUsd: 4 } } },
      { actorUserId: "owner", action: "voice.realtime.delegate", createdAt: "2026-09-19T11:00:00.000Z", metadata: { telemetry: { provider: "google", estimatedCostUsd: null, latencyMs: 60 } } }
    ], "owner", Date.parse("2026-09-19T00:00:00.000Z"));
    expect(summary).toMatchObject({ calls: 2, knownCostCalls: 1, estimatedCostUsd: 0.2, averageLatencyMs: 50, byProvider: { google: 2 } });
    expect(isVoiceDailyBudgetExceeded(summary, 0.2)).toBe(true);
    expect(isVoiceDailyBudgetExceeded(summary, null)).toBe(false);
  });
});
