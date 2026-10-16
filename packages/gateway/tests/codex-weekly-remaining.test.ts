import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { registerWeeklyRemainingRoute } from "../src/providers/codex/weekly-remaining.js";
import { createGatewayServer } from "../src/server.js";

type Usage = { window: "PRIMARY" | "SECONDARY"; usedPercent: number; resetAt: string | null; windowMinutes: number };

async function weeklyRemainingServer(accounts: Array<[string, string, Usage[]]>) {
  const repository = new InMemoryGatewayRepository();
  for (const [digit, plan, windows] of accounts) {
    const id = `gw_account:${digit.repeat(32)}`;
    await repository.upsertAccount({ accountId: id, provider: "CODEX", label: digit, email: null, externalAccountId: digit, planType: plan, credentialsEncrypted: "v1.x",
      credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
    if (windows.length > 0) await repository.saveUsageWindows(id, windows);
  }
  const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => null, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"d".repeat(32)}`, name: "Space", keyHash, keyPrefix, trafficClass: "BACKGROUND", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerWeeklyRemainingRoute(app, helpers, { pool }) });
  return { server, read: async () => (await server.app.inject({ method: "GET", url: "/v1/api/codex/weekly-remaining", headers: { authorization: `Bearer ${plainKey}` } })).json() };
}

const weekly = (usedPercent: number, window: Usage["window"] = "SECONDARY"): Usage => ({ window, usedPercent, resetAt: null, windowMinutes: 10080 });

describe("Codex weekly remaining", () => {
  it("pools weekly usage by plan capacity, counts active accounts and needs a key", async () => {
    const accounts: Array<[string, string, number]> = [["1", "plus", 50], ["2", "prolite", 10], ["3", "plus", 100], ["4", "free", 0]];
    const { server, read } = await weeklyRemainingServer(accounts.map(([digit, plan, used]) =>
      [digit, plan, [{ ...weekly(used), resetAt: `2030-01-1${digit}T00:00:00.000Z` }]]));
    expect((await server.app.inject({ method: "GET", url: "/api/codex/weekly-remaining" })).statusCode).toBe(401);
    // plus 7560 + prolite 37800 + plus 7560 = 52920 credits; used 3780 + 3780 + 7560 = 15120.
    expect(await read()).toMatchObject({ remaining_percent: 71.43, capacity_credits: 52920, used_credits: 15120, all_accounts_count: 3,
      active_accounts_count: 2, active_capacity_credits: 45360, active_used_credits: 7560, reset_at: "2030-01-11T00:00:00.000Z",
      all_accounts_remaining_percent: 46.67 });
  });

  it("reads a weekly-only window from the primary slot and leaves accounts without weekly usage out", async () => {
    // Prolite reported only its exhausted weekly window (primary slot), the Plus account its exhausted week: 83% was shown.
    const { read } = await weeklyRemainingServer([["1", "prolite", [weekly(100, "PRIMARY")]], ["2", "plus", [weekly(100)]],
      ["3", "plus", [{ window: "PRIMARY", usedPercent: 20, resetAt: null, windowMinutes: 300 }]], ["4", "pro", []]]);
    expect(await read()).toMatchObject({ remaining_percent: 0, capacity_credits: 45360, all_accounts_remaining_percent: 0, all_accounts_count: 4 });
    const unknown = await weeklyRemainingServer([["1", "plus", []]]);
    expect(await unknown.read()).toMatchObject({ remaining_percent: null, used_percent: null, all_accounts_remaining_percent: null, capacity_credits: 0 });
  });
});
