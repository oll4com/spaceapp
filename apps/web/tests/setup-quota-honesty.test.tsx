import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AntigravityUsageAccountList, ClaudeUsageAccountList, CodexUsageAccountList } from "@space/contracts";
import { computeQuotaAggregates } from "../src/features/desktop-widgets/quota-aggregates.js";
import { watchedQuota } from "../src/features/desktop-widgets/quota-overview.js";

afterEach(cleanup);
function source(fiveHourRemainingPercent: number | null, weeklyRemainingPercent: number | null): CodexUsageAccountList {
  return { data: [{ id: "fixture", label: "Fixture account", planType: "plus", fiveHourRemainingPercent,
    weeklyRemainingPercent, sampledAt: "2026-10-08T12:00:00.000Z" }],
    pagination: { page: 1, pageSize: 100, totalItems: 1, totalPages: 1 }, source: "fixture", isStale: false,
    error: null, checkedAt: "2026-10-08T12:00:00.000Z" };
}
describe("honest quota presentation", () => {
  it("preserves missing and partly reported quota as unavailable instead of a zero capacity", () => {
    expect(computeQuotaAggregates().codex.percent5h).toBeNull();
    const missing = computeQuotaAggregates(source(null, null));
    expect(missing.codex).toMatchObject({ percent5h: null, percentWeekly: null, available5h: null,
      availableWeekly: null, activeAccounts: 0, exhaustedAccounts: 0 });
    expect(missing.totalAiPool.percent5h).toBeNull();
    expect(computeQuotaAggregates(source(70, null)).codex.percent5h).toBeNull();
    expect(computeQuotaAggregates(source(null, 60)).codex.percentWeekly).toBe(60);
  });
  it("keeps a reported exhausted limit at zero and suppresses failed or stale balances", () => {
    expect(computeQuotaAggregates(source(70, 0)).codex).toMatchObject({ percent5h: 0, percentWeekly: 0, exhaustedAccounts: 1 });
    const stale = { ...source(70, 80), isStale: true };
    expect(computeQuotaAggregates(stale).codex.percent5h).toBeNull();
    expect(computeQuotaAggregates({ ...source(70, 80), error: "Source unavailable" }).codex.percentWeekly).toBeNull();
  });
  it("counts only the accounts that report a window, so a silent group never blanks the pool", () => {
    // Stable 3/11: Google's quota answer had only "Claude and GPT models" (no Gemini group; Free accounts no 5h bucket) and the
    // whole Antigravity pool read Unavailable.
    const group = (fiveHourRemainingPercent: number | null, weeklyRemainingPercent: number | null) =>
      ({ displayName: "group", fiveHourRemainingPercent, weeklyRemainingPercent });
    const account = (id: string, tier: string, claude: ReturnType<typeof group>) =>
      ({ id, label: id, email: null, tier, status: "CONNECTED" as const, gemini: group(null, null), claude, sampledAt: null });
    const agy = (data: ReturnType<typeof account>[]): AntigravityUsageAccountList => ({ data, source: "fixture", isStale: false,
      error: null, checkedAt: "2026-11-03T12:00:00.000Z", pagination: { page: 1, pageSize: 50, totalItems: data.length, totalPages: 1 } });
    const partial = computeQuotaAggregates(null, agy([account("pro", "Google AI Pro", group(60, 80)), account("free", "Free", group(null, 88.8))]));
    expect(partial.gemini).toMatchObject({ percent5h: null, percentWeekly: null });
    expect(partial.antigravityCombined).toMatchObject({ percent5h: 60, percentWeekly: 80 });
    // An account without a 5h window counts at its weekly share; the week caps the 5h.
    const codex = computeQuotaAggregates({ ...source(2, 55), data: [{ ...source(2, 55).data[0]!, id: "plus" },
      { ...source(null, 21).data[0]!, id: "prolite", planType: "prolite" }] });
    expect(codex.codex.percent5h).toBeCloseTo((2 + 21 * 5) / 6, 5);
    expect(codex.codex.percentWeekly).toBeCloseTo((55 + 21 * 5) / 6, 5);
    const silent = computeQuotaAggregates(null, agy([account("pro", "Google AI Pro", group(null, null))]));
    expect(silent.antigravityCombined).toMatchObject({ percent5h: null, percentWeekly: null, available5h: null });
  });
  it("adds the Claude Max accounts once, the gateway pool's copies skipped", () => {
    const window = { fiveHourResetAt: null, weeklyResetAt: null };
    const claude: ClaudeUsageAccountList = { source: "fixture", isStale: false, error: null, checkedAt: "2026-11-03T12:00:00.000Z",
      pagination: { page: 1, pageSize: 100, totalItems: 2, totalPages: 1 }, data: [
        { ...window, id: "main", label: "ntheo", email: "ntheo@example.com", plan: "Team · Max 5x", status: "CONNECTED",
          fiveHourRemainingPercent: 3, weeklyRemainingPercent: 48, weeklyScope: null, sampledAt: null },
        { ...window, id: "gateway", label: "Space Gateway (pooled)", email: null, plan: null, status: "GATEWAY", fiveHourRemainingPercent: null,
          weeklyRemainingPercent: null, weeklyScope: null, sampledAt: null, pool: [
            { ...window, label: "ntheo", signInRequired: false, fiveHourRemainingPercent: 4, weeklyRemainingPercent: 48 },
            { ...window, label: "ops", signInRequired: false, fiveHourRemainingPercent: 98, weeklyRemainingPercent: 63 }] }] };
    const result = computeQuotaAggregates(null, null, null, claude);
    expect(result.claudeMax.accounts.map((a) => a.label)).toEqual(["ntheo", "ops"]);
    expect(result.claudeMax.percent5h).toBeCloseTo((3 + 63) / 2, 5);
    expect(result.claudeMax.percentWeekly).toBeCloseTo((48 + 63) / 2, 5);
    expect(computeQuotaAggregates(null, null, null, { ...claude, data: [] }).claudeMax.percent5h).toBeNull();
  });
  it("distinguishes unreported token quota from exhausted accounts", () => {
    // The reset alerts of AI Quota & Usage replaced the Token Reminder; an unreported account is neither watched nor exhausted.
    const cache = (codex: CodexUsageAccountList) => ({ codex, agy: null, claude: null, api: null, fetchedAt: 0 });
    const clock = Date.parse("2026-10-08T12:00:00.000Z");
    expect(watchedQuota(cache(source(null, null)), clock, { provider: "codex", proOnly: false })).toMatchObject({ available: 0, total: 0 });
    expect(watchedQuota(cache(source(0, 80)), clock, { provider: "codex", proOnly: false })).toMatchObject({ available: 0, total: 1 });
  });
});
