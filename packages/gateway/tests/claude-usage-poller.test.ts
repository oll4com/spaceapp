import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { startClaudeUsagePoller } from "../src/providers/claude/usage-refresh.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 5));

describe("Claude usage poller", () => {
  it("lifts a long limit early when Anthropic's usage shows the limits were reset (dev@spaceapp.dev, 2026-11-11)", async () => {
    const nowMs = Date.parse("2030-01-10T00:00:00Z");
    const repository = new InMemoryGatewayRepository();
    const id = (index: number) => `gw_account:${String(index).repeat(32)}`;
    for (const index of [1, 2]) {
      const credentials: StoredCredentials = { accessToken: `at-${index}`, refreshToken: "rt", idToken: null, upstreamAccountId: `acct-${index}`, accessExpiresAtMs: null };
      await repository.upsertAccount({ accountId: id(index), provider: "CLAUDE", label: `c${index}@spaceapp.dev`, email: `c${index}@spaceapp.dev`, externalAccountId: `acct-${index}`,
        planType: "max5x", credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), id(index)), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
      // Blocked until the weekly reset, 39 hours out; then the operator reset the limits on Anthropic's page.
      await repository.recordAccountState(id(index), { status: "RATE_LIMITED", statusReason: "This request would exceed your account's rate limit.",
        blockedUntil: new Date(nowMs + 39 * 3_600_000).toISOString() });
    }
    const pool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() }, now: () => nowMs });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({
      five_hour: { utilization: 0, resets_at: null },
      seven_day: { utilization: (init.headers as Record<string, string>).authorization === "Bearer at-2" ? 100 : 0, resets_at: "2030-01-11T15:00:00Z" }
    })));
    const poller = startClaudeUsagePoller({ repository, pool, intervalMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    try {
      await poller.runOnce();
    } finally {
      poller.stop();
    }
    const accounts = await repository.listAccounts();
    expect(accounts.find((account) => account.id === id(1))).toMatchObject({ status: "ACTIVE", blockedUntil: null, secondaryWindow: { usedPercent: 0 } });
    expect(accounts.find((account) => account.id === id(2))).toMatchObject({ status: "RATE_LIMITED" });
  });
});
