import { describe, expect, it } from "vitest";
import { gatewayPlanCredits, gatewayPooledRemaining, gatewayPools, gatewayPoolWindow, gatewayProjectedUse, neededReservePercent, quotaLeftAtReset, type GatewayAccount } from "../src/index.js";

const NOW = Date.parse("2030-01-08T12:00:00.000Z");

function account(id: string, fields: Partial<GatewayAccount> & { primary?: number | null; secondary?: number | null }): GatewayAccount {
  const { primary = null, secondary = null, ...rest } = fields;
  return {
    id: `gw_account:${id.repeat(32)}`, provider: "CODEX", label: `Account ${id}`, alias: null, email: null, planType: "plus", status: "ACTIVE", statusReason: null,
    priority: 100, warmupEnabled: false, resetCreditsAvailable: null,
    primaryWindow: { usedPercent: primary, resetAt: new Date(NOW + 2.5 * 3_600_000).toISOString(), windowMinutes: 300 },
    secondaryWindow: { usedPercent: secondary, resetAt: new Date(NOW + 3.5 * 86_400_000).toISOString(), windowMinutes: 10_080 },
    lastRefreshAt: null, lastUsedAt: null, createdAt: "2030-01-01T00:00:00.000Z", ...rest
  };
}

describe("Space Gateway capacity (codex-lb plan credits)", () => {
  it("uses codex-lb's plan credits: Plus 1, Pro Lite 5, Pro 20 per window", () => {
    expect(gatewayPlanCredits("CODEX", "plus", "primary")).toBe(225);
    expect(gatewayPlanCredits("CODEX", "prolite", "secondary") / gatewayPlanCredits("CODEX", "plus", "secondary")).toBe(5);
    expect(gatewayPlanCredits("CODEX", "pro", "primary") / gatewayPlanCredits("CODEX", "plus", "primary")).toBe(20);
    expect(gatewayPlanCredits("CODEX", "free", "primary")).toBe(0);
    expect(gatewayPlanCredits("CLAUDE", "max20x", "secondary") / gatewayPlanCredits("CLAUDE", "pro", "secondary")).toBe(20);
  });

  it("caps the 5h window by what the week has left and empties accounts out of quota", () => {
    const window = gatewayPoolWindow([
      account("1", { primary: 0, secondary: 99.5 }),
      account("2", { primary: 10, secondary: 20, status: "QUOTA_EXCEEDED" }),
      account("3", { primary: 50, secondary: 0, planType: "pro" })
    ], "primary", NOW);
    // Account 1: 225 left in 5h but only 37.8 weekly credits; account 2: none; account 3: 2250 of 4500.
    expect(window.capacityCredits).toBe(22);
    expect(window.remainingCredits).toBe(Math.round(((37.8 + 2250) / 225) * 100) / 100);
    expect(window.accounts[0]).toMatchObject({ planType: "pro", capacityCredits: 20, remainingCredits: 10, remainingPercent: 50 });
  });

  it("projects account burn to the reset at the current pace", () => {
    // Half of a 5h window has passed and 30% is used: 60% by the reset.
    const resetAt = new Date(NOW + 2.5 * 3_600_000).toISOString();
    expect(gatewayProjectedUse(30, resetAt, 300, NOW)).toBeCloseTo(0.6, 10);
    expect(gatewayProjectedUse(30, null, 300, NOW)).toBeCloseTo(0.3, 10);
    expect(gatewayProjectedUse(10, resetAt, 300, NOW, true)).toBe(1);
    const pool = gatewayPoolWindow([account("1", { primary: 30, secondary: 0 }), account("2", { primary: 60, secondary: 0 })], "primary", NOW);
    expect(pool.burnAccounts).toBe(1.8);
  });

  it("pools per provider and reports a key's pooled remaining without paused accounts", () => {
    const accounts = [account("1", { primary: 40, secondary: 10 }), account("2", { primary: 0, secondary: 0, status: "PAUSED" }),
      account("4", { primary: 0, secondary: 0, provider: "OPENAI_API" }), account("5", { primary: 0, secondary: 0, status: "DEACTIVATED" })];
    expect(gatewayPools(accounts, NOW).map((pool) => [pool.provider, pool.accounts])).toEqual([["CODEX", 2]]);
    expect(gatewayPooledRemaining(accounts, { accountScopeEnabled: false, accountIds: [] }, NOW))
      .toEqual({ primaryRemainingPercent: 60, secondaryRemainingPercent: 90, accounts: 1 });
    expect(gatewayPooledRemaining(accounts, { accountScopeEnabled: true, accountIds: [accounts[1]!.id] }, NOW))
      .toEqual({ primaryRemainingPercent: null, secondaryRemainingPercent: null, accounts: 0 });
  });
});

// 5/11: Low-spend went LOW all night on "0% free at the weekly reset" while ntheo had an empty week and lab and dev reset within a day.
describe("quotaLeftAtReset", () => {
  const week = 7 * 86_400_000;
  const at = Date.parse("2026-11-05T03:20:00Z");
  const period = (remaining: number, resetAt: string, periodMs = week) => ({ remaining, resetAt, periodMs });
  it("ends each account's period at most used up and adds the fresh periods it gets before the pool's last reset", () => {
    const pool = [period(33, "2026-11-08T18:59:59.911Z"), period(2, "2026-11-05T23:00:00Z"), period(0, "2026-11-05T21:00:00.406Z"),
      period(100, "2026-11-12T02:00:00.812Z"), period(12, "2026-11-08T10:00:00.102Z")];
    const left = quotaLeftAtReset(pool, at)!;
    // Not 0: lab and dev's fresh weeks count. 30 at each account's own pace; the pool's ~76 points a day also fill ntheo's empty week.
    expect(Math.round(left.percent)).toBe(5);
    expect(left).toMatchObject({ accounts: 5, resetAt: "2026-11-12T02:00:00.812Z" });
    // One account alone: its own reset is the last one, and a pace past its limit leaves nothing (not less than nothing).
    expect(quotaLeftAtReset([period(12, "2026-11-08T10:00:00.102Z")], at)!.percent).toBe(0);
    // A weekly account inside a monthly pool counts every fresh week until the month's reset; the share never passes 100%.
    const idle = quotaLeftAtReset([period(100, "2026-11-06T00:00:00Z"), period(100, "2026-12-01T00:00:00Z", 30 * 86_400_000)], at)!;
    expect(idle.percent).toBe(100);
    // The monthly account's ~24% a day moves to the weekly one with its own ~15%: every fresh week until 1/12 is used up.
    const busy = quotaLeftAtReset([period(10, "2026-11-06T00:00:00Z"), period(0, "2026-12-01T00:00:00Z", 30 * 86_400_000)], at)!;
    expect(Math.round(busy.percent)).toBe(0);
  });
  // 7/11 (nous_msg:e768734b): the header read «43% free at Fri 06:00» with 3 of the 5 accounts spent; each account kept its own pace.
  it("moves the spent accounts' load to the ones with room and reports the share free now", () => {
    const hours = (count: number) => new Date(at + count * 3_600_000).toISOString();
    // ops, crew, ntheo at 100% used, lab and dev at 97%.
    const today = [period(0, hours(20.4)), period(0, hours(29.4)), period(0, hours(108.4)), period(3, hours(127.4)), period(3, hours(129.4))];
    const left = quotaLeftAtReset(today, at)!;
    // Each account at its own pace gave 26 + 28 + 65 + 95 + 0 = 214 / 5 ≈ 43; the pool's pace (~8 points an hour) empties ops and
    // crew's fresh weeks and ntheo's before the last reset, and leaves only lab's 2 fresh hours (~84%).
    expect(left.percent).toBeLessThan(43);
    expect(Math.round(left.percent)).toBe(17);
    expect(left).toMatchObject({ now: 1.2, accounts: 5, resetAt: hours(129.4) });
  });
});


// Operator 5/11 (nous_msg:3723fc28): the 3% floors and the 20% kept on the last account hold only while the work runs short before a reset.
describe("neededReservePercent", () => {
  const HOUR = 3_600_000, DAY = 24 * HOUR, WEEK = 7 * DAY;
  // A week used `used` %, resetting in `resetIn`.
  const week = (used: number | null, resetIn: number | null) => ({ used, resetAt: resetIn === null ? null : NOW + resetIn, length: WEEK });

  it("keeps nothing when the account's own week resets in a few hours", () => {
    // 96% used over 6 days 21 h (14 points a day): the 4 points left carry the 3 h to its reset.
    expect(neededReservePercent([week(96, 3 * HOUR)], 3, NOW)).toBe(0);
    expect(neededReservePercent([week(96, 3 * HOUR)], 20, NOW)).toBe(0);
  });

  it("keeps the base when no reset comes for days and the room runs out before it", () => {
    // 96% in one day: 4 points cannot carry 6 days.
    expect(neededReservePercent([week(96, 6 * DAY)], 3, NOW)).toBe(3);
    expect(neededReservePercent([week(96, 6 * DAY), week(100, 5 * DAY)], 20, NOW)).toBe(20);
    // Only the shortfall, when it is smaller than the base: 51.5 points in 3.5 days, so the 3.5 days left need 51.5 of the 48.5 left.
    expect(neededReservePercent([week(51.5, 3.5 * DAY)], 20, NOW)).toBeCloseTo(3, 5);
  });

  it("keeps nothing when another account's week resets before the work runs short", () => {
    // a: 96% over 4 days (1 point an hour); b: spent, back in 2 h: 4 points carry the pool (1.6 an hour) until then.
    expect(neededReservePercent([week(96, 3 * DAY), week(100, 2 * HOUR)], 3, NOW)).toBe(0);
    // b back in 4 days instead: the same room runs out first.
    expect(neededReservePercent([week(96, 3 * DAY), week(100, 4 * DAY)], 3, NOW)).toBe(3);
  });

  it("keeps nothing with no pace to judge, a base of 0, or windows already reset", () => {
    expect(neededReservePercent([week(null, 6 * DAY), week(null, null)], 3, NOW)).toBe(0);
    expect(neededReservePercent([week(96, 6 * DAY)], 0, NOW)).toBe(0);
    expect(neededReservePercent([week(100, -HOUR), week(10, 6 * DAY)], 3, NOW)).toBe(0);
  });
});
