import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { lanPathAllowed } from "../src/lan-access.js";
import { registerCodexAccountUsageRoute } from "../src/providers/codex/account-usage.js";
import { createGatewayServer } from "../src/server.js";

describe("Codex account usage for local tools", () => {
  it("lists paid, unpaused accounts with their remaining 5-hour and weekly quota, and stays off the LAN", async () => {
    const repository = new InMemoryGatewayRepository();
    const add = async (digit: string, plan: string) => {
      const id = `gw_account:${digit.repeat(32)}`;
      await repository.upsertAccount({ accountId: id, provider: "CODEX", label: `Account ${digit}`, email: null, externalAccountId: digit, planType: plan,
        credentialsEncrypted: "v1.x", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: "2030-01-01T00:00:00.000Z" });
      return id;
    };
    const plus = await add("1", "plus");
    await repository.saveUsageWindows(plus, [
      { window: "PRIMARY", usedPercent: 25, resetAt: "2030-01-01T05:00:00.000Z", windowMinutes: 300 },
      { window: "SECONDARY", usedPercent: 60.04, resetAt: "2030-01-07T00:00:00.000Z", windowMinutes: 10080 }
    ]);
    await add("2", "free");
    await repository.setAccountStatus(await add("3", "pro"), "PAUSED", null);
    const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => null, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
      routes: (app) => registerCodexAccountUsageRoute(app, { pool, internalToken: "internal-test" }) });
    expect((await server.app.inject({ method: "GET", url: "/__space-gateway/codex/account-usage" })).statusCode).toBe(403);
    const response = await server.app.inject({ method: "GET", url: "/__space-gateway/codex/account-usage", headers: { "x-space-internal-token": "internal-test" } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ schemaVersion: 1, source: "space-gateway", accounts: [{
      id: plus, label: "Account 1", fiveHourRemainingPercent: 75, weeklyRemainingPercent: 40, fiveHourResetAt: "2030-01-01T05:00:00.000Z",
      weeklyResetAt: "2030-01-07T00:00:00.000Z", sampledAt: "2030-01-01T00:00:00.000Z", planType: "plus"
    }] });
    expect(lanPathAllowed("/__space-gateway/codex/account-usage")).toBe(false);
  });
});
