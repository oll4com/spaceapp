import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { startCodexUsagePoller } from "../src/providers/codex/usage-refresh.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 4));

describe("Codex usage poller", () => {
  it("refreshes usable accounts one at a time and skips paused ones", async () => {
    const repository = new InMemoryGatewayRepository();
    for (const [index, plan] of [[1, "plus"], [2, "plus"], [3, "pro"]] as const) {
      const id = `gw_account:${String(index).repeat(32)}`;
      const credentials: StoredCredentials = { accessToken: `at-${index}`, refreshToken: null, idToken: null, upstreamAccountId: `acct-${index}`, accessExpiresAtMs: null };
      await repository.upsertAccount({ accountId: id, provider: "CODEX", label: `A${index}`, email: null, externalAccountId: `acct-${index}`, planType: plan,
        credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), id), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
    }
    await repository.setAccountStatus(`gw_account:${"3".repeat(32)}`, "PAUSED", null);
    const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      const account = (init.headers as Record<string, string>)["chatgpt-account-id"];
      if (account === "acct-2") return new Response(JSON.stringify({ error: { message: "expired" } }), { status: 401 });
      return new Response(JSON.stringify({ plan_type: "pro", rate_limit: { primary_window: { used_percent: 33, limit_window_seconds: 18000 }, secondary_window: { used_percent: 7 } } }));
    });
    const errors: string[] = [];
    const poller = startCodexUsagePoller({ repository, pool, intervalMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch,
      onError: (accountId) => errors.push(accountId) });
    try {
      expect(await poller.runOnce()).toBe(1);
    } finally {
      poller.stop();
    }
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(errors).toEqual([`gw_account:${"2".repeat(32)}`]);
    const first = (await repository.listAccounts()).find((account) => account.id === `gw_account:${"1".repeat(32)}`)!;
    expect(first).toMatchObject({ planType: "pro", primaryWindow: { usedPercent: 33, windowMinutes: 300 }, secondaryWindow: { usedPercent: 7 } });
  });

  it("checks each account: a rejected sign-in leaves rotation and waits for a new one, a limit that is over shows active again", async () => {
    const nowMs = Date.parse("2030-01-10T00:00:00Z");
    const repository = new InMemoryGatewayRepository();
    const id = (index: number) => `gw_account:${String(index).repeat(32)}`;
    for (const index of [1, 2, 3]) {
      const credentials: StoredCredentials = { accessToken: `at-${index}`, refreshToken: null, idToken: null, upstreamAccountId: `acct-${index}`, accessExpiresAtMs: null };
      await repository.upsertAccount({ accountId: id(index), provider: "CODEX", label: `A${index}`, email: null, externalAccountId: `acct-${index}`, planType: "plus",
        credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), id(index)), credentialsExpiresAt: "2030-01-20T00:00:00.000Z", source: "OAUTH", sourceRef: null,
        lastRefreshAt: "2030-01-09T00:00:00.000Z" });
    }
    await repository.recordAccountState(id(1), { status: "RATE_LIMITED", statusReason: "The usage limit has been reached", blockedUntil: new Date(nowMs - 60_000).toISOString() });
    await repository.recordAccountState(id(3), { status: "RATE_LIMITED", statusReason: "The usage limit has been reached", blockedUntil: new Date(nowMs + 3_600_000).toISOString() });
    const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() }, now: () => nowMs });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => (init.headers as Record<string, string>)["chatgpt-account-id"] === "acct-2"
      ? new Response(JSON.stringify({ error: { message: "Your authentication token has been invalidated." } }), { status: 401 })
      : new Response(JSON.stringify({ plan_type: "plus", rate_limit: { primary_window: { used_percent: 10 } } })));
    const poller = startCodexUsagePoller({ repository, pool, intervalMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    try {
      await poller.runOnce();
      const accounts = await repository.listAccounts();
      const byId = (index: number) => accounts.find((account) => account.id === id(index))!;
      expect(byId(1)).toMatchObject({ status: "ACTIVE", statusReason: null, blockedUntil: null });
      expect(byId(2)).toMatchObject({ status: "REAUTH_REQUIRED", credentialsExpiresAt: new Date(nowMs).toISOString() });
      expect(byId(3)).toMatchObject({ status: "RATE_LIMITED" });
      pool.invalidate();
      fetchImpl.mockClear();
      await poller.runOnce();
      expect(fetchImpl.mock.calls.map(([, init]) => (init.headers as Record<string, string>)["chatgpt-account-id"])).toEqual(["acct-1", "acct-3"]);
    } finally {
      poller.stop();
    }
  });

  it("lifts a long limit early when the provider's usage shows no used-up limit, per-model limits included", async () => {
    const nowMs = Date.parse("2030-01-10T00:00:00Z");
    const repository = new InMemoryGatewayRepository();
    const id = (index: number) => `gw_account:${String(index).repeat(32)}`;
    for (const index of [1, 2]) {
      const credentials: StoredCredentials = { accessToken: `at-${index}`, refreshToken: null, idToken: null, upstreamAccountId: `acct-${index}`, accessExpiresAtMs: null };
      await repository.upsertAccount({ accountId: id(index), provider: "CODEX", label: `A${index}`, email: null, externalAccountId: `acct-${index}`, planType: "plus",
        credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), id(index)), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
      // Blocked for five days by "usage limit reached", then the provider reset the limits.
      await repository.recordAccountState(id(index), { status: "RATE_LIMITED", statusReason: "The usage limit has been reached", blockedUntil: new Date(nowMs + 5 * 86_400_000).toISOString() });
    }
    const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() }, now: () => nowMs });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => new Response(JSON.stringify({ plan_type: "plus",
      rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000 }, secondary_window: { used_percent: 0, limit_window_seconds: 604800 } },
      additional_rate_limits: (init.headers as Record<string, string>)["chatgpt-account-id"] === "acct-2"
        ? [{ limit_name: "GPT-5.6-Sol", metered_feature: "codex_sol", rate_limit: { secondary_window: { used_percent: 100 } } }] : [] })));
    const poller = startCodexUsagePoller({ repository, pool, intervalMs: 60_000, fetchImpl: fetchImpl as unknown as typeof fetch });
    try {
      await poller.runOnce();
    } finally {
      poller.stop();
    }
    const accounts = await repository.listAccounts();
    expect(accounts.find((account) => account.id === id(1))).toMatchObject({ status: "ACTIVE", blockedUntil: null });
    expect(accounts.find((account) => account.id === id(2))).toMatchObject({ status: "RATE_LIMITED" });
  });
});
