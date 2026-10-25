import { describe, expect, it } from "vitest";
import { gatewayPlanCredits, gatewayPooledRemaining, gatewayPools, gatewayPoolWindow, gatewayProjectedUse, type GatewayAccount } from "../src/index.js";

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
