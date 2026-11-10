import { describe, expect, it } from "vitest";
import { lostWeekOf, weeklyLostTokens, type LostTokensAccount } from "../src/gateway/lost-tokens.js";

const id = (n: number) => `gw_account:${String(n).padStart(32, "0")}`;
const window = (usedPercent: number | null, resetAt: string | null = null) => ({ usedPercent, resetAt, windowMinutes: 10080 });
const account = (n: number, label: string, provider: LostTokensAccount["provider"], extra: Partial<LostTokensAccount> = {}): LostTokensAccount =>
  ({ id: id(n), label, alias: null, provider, planType: "max5x", secondaryWindow: window(0), ...extra });
const ops = account(1, "ops@spaceapp.dev", "CLAUDE");
// ops@spaceapp.dev's real daily rollups (input with cache + output, API value) of the 7 UTC days before its 1/11 09:00 reset.
const opsWeek: Array<[string, number, number]> = [["2026-10-25", 645155278, 289.95], ["2026-10-26", 952433651, 393.81], ["2026-10-27", 664571444, 413.11],
  ["2026-10-28", 949521507, 553.08], ["2026-10-29", 1077186125, 619.91], ["2026-10-30", 850113801, 626.59], ["2026-10-31", 1490637137, 741.24]];
const usage = (accountId: string, rows: Array<[string, number, number]>, model = "claude-opus-5-5") =>
  rows.map(([day, tokens, costUsd]) => ({ day, accountId, model, tokens, costUsd }));
const peak = (accountId: string, resetAt: string, usedPercent: number, quotaKey = "") => ({ accountId, quotaKey, resetAt, usedPercent, lastSampleAt: resetAt });
const now = Date.parse("2026-11-05T03:30:00Z");

describe("weeklyLostTokens", () => {
  it("matches the 5/11 research for ops: 31 % unused at the 1/11 reset, $52.72 per 1 % measured over the 7 days before", () => {
    const lost = weeklyLostTokens({ from: "2026-10-01", to: "2026-11-05", now, accounts: [ops],
      // One reset sampled a moment either side of the hour is one window; the next week has not reset yet.
      peaks: [peak(ops.id, "2026-11-01T08:59:59.899Z", 64), peak(ops.id, "2026-11-01T09:00:00.100Z", 69), peak(ops.id, "2026-11-08T10:00:00.000Z", 88)],
      usage: [...usage(ops.id, opsWeek), ...usage(ops.id, [["2026-10-24", 359468543, 221.19], ["2026-11-01", 2102962512, 968.19]])] });
    expect(lost.windows).toEqual([expect.objectContaining({ label: "ops@spaceapp.dev", provider: "CLAUDE", week: "2026-10-26", resetAt: "2026-11-01T09:00:00.100Z",
      usedPercent: 69, lostPercent: 31, costUsdPerPercent: 52.72, tokensPerPercent: 96081434, rateFrom: "own", lostCostUsd: 1634.32, lostTokens: 2978524453 })]);
    expect(lost.weeks).toEqual([{ week: "2026-10-26", provider: "CLAUDE", windows: 1, lostPercent: 31, lostTokens: 2978524453, lostCostUsd: 1634.32, unpriced: 0 }]);
    expect(lost.totals).toEqual({ windows: 1, lostPercent: 31, lostTokens: 2978524453, lostCostUsd: 1634.32, unpriced: 0, unobserved: 0 });
  });

  it("prices an unused week at the nearest measured week, leaves an account without traffic unpriced and splits quota groups by model", () => {
    const ntheo = account(2, "ntheo@spaceapp.dev", "CLAUDE");
    const antigravity = account(3, "spaceappdv@gmail.com", "ANTIGRAVITY", { planType: "free", secondaryWindow: window(null),
      quotaGroups: [{ key: "claude", primaryWindow: window(0), secondaryWindow: window(11) }, { key: "gemini", primaryWindow: window(0), secondaryWindow: window(0) }] });
    const lost = weeklyLostTokens({ from: "2026-10-01", to: "2026-11-05", now, accounts: [ntheo, antigravity],
      peaks: [peak(ntheo.id, "2026-10-22T02:00:00.000Z", 26), peak(ntheo.id, "2026-10-29T02:00:00.000Z", 0),
        peak(antigravity.id, "2026-11-04T15:23:16.000Z", 11, "claude"), peak(antigravity.id, "2026-10-20T10:29:42.000Z", 5, "gemini"),
        peak(id(9), "2026-10-29T02:00:00.000Z", 10)],
      usage: [...usage(ntheo.id, [["2026-10-15", 2_600_000_000, 1040]]), ...usage(antigravity.id, [["2026-10-30", 1_000_000, 1]], "gemini-3-pro")] });
    const byReset = Object.fromEntries(lost.windows.map((row) => [`${row.label}/${row.quotaKey}/${row.resetAt.slice(0, 10)}`, row]));
    expect(Object.keys(byReset)).toHaveLength(4); // the removed account id(9) has nothing to report under
    expect(byReset["ntheo@spaceapp.dev//2026-10-22"]).toMatchObject({ lostPercent: 74, tokensPerPercent: 100_000_000, rateFrom: "own", lostTokens: 7_400_000_000, lostCostUsd: 2960 });
    expect(byReset["ntheo@spaceapp.dev//2026-10-29"]).toMatchObject({ usedPercent: 0, lostPercent: 100, rateFrom: "nearest", lostTokens: 10_000_000_000, lostCostUsd: 4000 });
    // Gemini models draw on the gemini quota only (outside its 7 days here), never on the claude quota whose 7 days they fall in.
    expect(byReset["spaceappdv@gmail.com/claude/2026-11-04"]).toMatchObject({ lostPercent: 89, rateFrom: null, lostTokens: null, lostCostUsd: null });
    expect(byReset["spaceappdv@gmail.com/gemini/2026-10-20"]).toMatchObject({ lostPercent: 95, rateFrom: null });
    expect(lost.totals).toEqual({ windows: 4, lostPercent: 358, lostTokens: 17_400_000_000, lostCostUsd: 6960, unpriced: 2, unobserved: 0 });
    expect(lost.weeks.map((row) => `${row.week} ${row.provider} ${row.windows}`)).toEqual(["2026-10-19 ANTIGRAVITY 1", "2026-10-19 CLAUDE 1", "2026-10-26 CLAUDE 1",
      "2026-11-02 ANTIGRAVITY 1"]);
  });

  it("leaves out a reset whose last sample is far before it (an account no longer polled) and counts it as unobserved", () => {
    const stale = { ...peak(ops.id, "2026-10-25T10:00:00.000Z", 5), lastSampleAt: "2026-10-19T15:29:00.000Z" };
    const lost = weeklyLostTokens({ from: "2026-10-01", to: "2026-11-05", now, accounts: [ops], peaks: [stale, peak(ops.id, "2026-11-01T09:00:00.100Z", 69)],
      usage: usage(ops.id, opsWeek) });
    expect(lost.windows.map((row) => row.resetAt)).toEqual(["2026-11-01T09:00:00.100Z"]);
    expect(lost.totals).toMatchObject({ windows: 1, lostPercent: 31, unobserved: 1 });
  });

    it("names a week by its UTC Monday", () => {
    expect([lostWeekOf("2026-11-01T09:00:00Z"), lostWeekOf("2026-11-02T00:00:00Z"), lostWeekOf("2026-11-08T23:59:59Z")]).toEqual(["2026-10-26", "2026-11-02", "2026-11-02"]);
  });
});
