import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { CodexResetCreditsError } from "../src/codex-reset-credits.js";
import { createGatewayCodexResetCreditsService, createGatewayCodexUsageProvider } from "../src/gateway/gateway-codex-services.js";

const now = () => new Date("2030-01-10T00:00:00.000Z");

async function repositoryWithAccounts() {
  const repository = new InMemoryGatewayRepository();
  for (const [digit, provider, used] of [["1", "CODEX", 25], ["2", "CODEX", null], ["3", "CLAUDE", 50]] as const) {
    const id = `gw_account:${digit.repeat(32)}`;
    await repository.upsertAccount({ accountId: id, provider, label: `Account ${digit}`, email: null, externalAccountId: digit, planType: "plus",
      credentialsEncrypted: "v1.secret", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: "2030-01-09T23:00:00.000Z" });
    await repository.saveUsageWindows(id, [{ window: "PRIMARY", usedPercent: used, resetAt: "2030-01-10T03:00:00.000Z", windowMinutes: 300 },
      { window: "SECONDARY", usedPercent: 10, resetAt: null, windowMinutes: 10080 }]);
  }
  await repository.saveResetCredits(`gw_account:${"1".repeat(32)}`, 2);
  return repository;
}

describe("Codex quotas and reset credits from Space Gateway", () => {
  it("lists Codex accounts in the toolbar quota contract", async () => {
    const list = await createGatewayCodexUsageProvider({ repository: await repositoryWithAccounts(), now })();
    expect(list).toMatchObject({ source: "space-gateway", isStale: false, error: null, pagination: { totalItems: 2 } });
    expect(list.data[0]).toEqual({ id: `gw_account:${"1".repeat(32)}`, label: "Account 1", planType: "plus", fiveHourRemainingPercent: 75,
      weeklyRemainingPercent: 90, fiveHourResetAt: "2030-01-10T03:00:00.000Z", weeklyResetAt: null, sampledAt: "2030-01-09T23:00:00.000Z" });
    expect(list.data[1]!.fiveHourRemainingPercent).toBeNull();
    expect(JSON.stringify(list)).not.toContain("v1.secret");
  });

  it("shows a weekly-only window as the week, not as the 5h window", async () => {
    const repository = new InMemoryGatewayRepository();
    const id = `gw_account:${"8".repeat(32)}`;
    await repository.upsertAccount({ accountId: id, provider: "CODEX", label: "Prolite", email: null, externalAccountId: "8", planType: "prolite",
      credentialsEncrypted: "v1.secret", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
    await repository.saveUsageWindows(id, [{ window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-14T00:00:00.000Z", windowMinutes: 10080 }]);
    const [account] = (await createGatewayCodexUsageProvider({ repository, now })()).data;
    expect(account).toMatchObject({ fiveHourRemainingPercent: null, fiveHourResetAt: null, weeklyRemainingPercent: 0, weeklyResetAt: "2030-01-14T00:00:00.000Z" });
  });

  it("leaves out accounts Space Gateway does not use: paused, deactivated and signed out", async () => {
    const repository = await repositoryWithAccounts();
    const add = async (digit: string, planType: string, credentialsExpiresAt: string | null) => {
      const id = `gw_account:${digit.repeat(32)}`;
      await repository.upsertAccount({ accountId: id, provider: "CODEX", label: `Account ${digit}`, email: null, externalAccountId: digit, planType,
        credentialsEncrypted: "v1.secret", credentialsExpiresAt, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
      return id;
    };
    // Signed out: the provider rejected the token, stored as expired.
    await repository.recordAccountState(await add("4", "free", "2030-01-09T08:43:17.000Z"), { status: "REAUTH_REQUIRED", statusReason: "Authentication token invalidated", blockedUntil: null });
    // Only the refresh token failed: the gateway still uses the unexpired access token, so the account stays.
    await repository.recordAccountState(await add("5", "plus", "2030-01-20T00:00:00.000Z"), { status: "REAUTH_REQUIRED", statusReason: "Refresh token reused", blockedUntil: null });
    await repository.recordAccountState(await add("6", "free", null), { status: "PAUSED", statusReason: null, blockedUntil: null });
    await repository.recordAccountState(await add("7", "plus", null), { status: "DEACTIVATED", statusReason: "Account deactivated", blockedUntil: null });
    const list = await createGatewayCodexUsageProvider({ repository, now })();
    expect(list.data.map((account) => account.label)).toEqual(["Account 1", "Account 2", "Account 5"]);
  });

  it("reports and spends reset credits through the gateway", async () => {
    const repository = await repositoryWithAccounts();
    const gatewayAdmin = vi.fn(async () => ({ status: 200, body: { outcome: "RESET", windowsReset: 1 } }));
    const service = createGatewayCodexResetCreditsService({ repository, admin: { gatewayAdmin }, now });
    expect(await service.availability()).toMatchObject({ source: "space-gateway", data: [{ accountId: `gw_account:${"1".repeat(32)}`, availableCreditCount: 2 },
      { accountId: `gw_account:${"2".repeat(32)}`, availableCreditCount: null }] });
    const key = "6f9619ff-8b86-4011-b42d-00c04fc964ff";
    const result = await service.redeem(`gw_account:${"1".repeat(32)}`, key);
    expect(result).toEqual({ response: { accountId: `gw_account:${"1".repeat(32)}`, outcome: "RESET", completedAt: "2030-01-10T00:00:00.000Z" },
      audit: { outcome: "RESET", usageVerified: true, creditIdHash: null } });
    expect(gatewayAdmin).toHaveBeenCalledWith(`/__space-gateway/admin/accounts/gw_account:${"1".repeat(32)}/reset-credit`, { idempotencyKey: key });
    gatewayAdmin.mockResolvedValueOnce({ status: 502, body: { error: {} } } as never);
    await expect(service.redeem(`gw_account:${"1".repeat(32)}`, key)).rejects.toBeInstanceOf(CodexResetCreditsError);
    await expect(service.redeem("vm214-account", key)).rejects.toBeInstanceOf(CodexResetCreditsError);
  });
});
