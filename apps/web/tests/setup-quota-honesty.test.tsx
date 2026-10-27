import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CodexUsageAccountList } from "@space/contracts";
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
  it("distinguishes unreported token quota from exhausted accounts", () => {
    // The reset alerts of AI Quota & Usage replaced the Token Reminder; an unreported account is neither watched nor exhausted.
    const cache = (codex: CodexUsageAccountList) => ({ codex, agy: null, claude: null, api: null, fetchedAt: 0 });
    const clock = Date.parse("2026-10-08T12:00:00.000Z");
    expect(watchedQuota(cache(source(null, null)), clock, { provider: "codex", proOnly: false })).toMatchObject({ available: 0, total: 0 });
    expect(watchedQuota(cache(source(0, 80)), clock, { provider: "codex", proOnly: false })).toMatchObject({ available: 0, total: 1 });
  });
});
