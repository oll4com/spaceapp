import { describe, expect, it, vi } from "vitest";
import { GATEWAY_FREE_PLAN_PAUSE_REASON } from "@space/contracts";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type CredentialRefresher, type StoredCredentials } from "../src/accounts/account-pool.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { createCodexRefresher } from "../src/providers/codex/credentials.js";
import { selectAccount } from "../src/router/balancer.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 3));
const nowMs = Date.parse("2030-01-10T00:00:00Z");

async function setup(refresher: CredentialRefresher, credentials: Partial<StoredCredentials> = {}, lastRefreshAt = "2030-01-09T00:00:00.000Z") {
  const repository = new InMemoryGatewayRepository();
  const accountId = `gw_account:${"1".repeat(32)}`;
  const stored: StoredCredentials = { accessToken: "at-1", refreshToken: "rt-1", idToken: null, upstreamAccountId: "chatgpt-1", accessExpiresAtMs: null, ...credentials };
  await repository.upsertAccount({ accountId, provider: "CODEX", label: "A", email: null, externalAccountId: "chatgpt-1", planType: "plus",
    credentialsEncrypted: cipher.encrypt(JSON.stringify(stored), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt });
  await repository.upsertAccount({ accountId: `gw_account:${"2".repeat(32)}`, provider: "CLAUDE", label: "Other provider", email: null,
    externalAccountId: "claude-1", planType: null, credentialsEncrypted: "v1.x", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, lastRefreshAt: null });
  const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher, now: () => nowMs });
  return { repository, pool, accountId };
}

describe("account pool", () => {
  it("lists only its provider and exposes balancer state", async () => {
    const { pool } = await setup(createCodexRefresher());
    const states = await pool.balancerStates();
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ status: "ACTIVE", planType: "plus", errorCount: 0 });
  });

  it("returns stored credentials when no refresh is due", async () => {
    const refresh = vi.fn();
    const { pool } = await setup({ needsRefresh: () => false, refresh });
    const [account] = await pool.accounts();
    expect(await pool.credentials(account!)).toMatchObject({ accessToken: "at-1", upstreamAccountId: "chatgpt-1" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshes once under the lock and stores the rotated token encrypted", async () => {
    let calls = 0;
    const refresher: CredentialRefresher = {
      needsRefresh: (_account, credentials) => credentials.refreshToken === "rt-1",
      refresh: async (credentials) => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...credentials, accessToken: "at-2", refreshToken: "rt-2", planType: "pro", email: "new@example.test" }; }
    };
    const { pool, repository, accountId } = await setup(refresher);
    const [account] = await pool.accounts();
    const results = await Promise.all([pool.credentials(account!), pool.credentials(account!)]);
    expect(calls).toBe(1);
    expect(results.map((result) => result.accessToken)).toEqual(["at-2", "at-2"]);
    const stored = (await repository.listAccounts()).find((item) => item.id === accountId)!;
    expect(stored.credentialsEncrypted).not.toContain("rt-2");
    expect(JSON.parse(cipher.decrypt(stored.credentialsEncrypted, accountId))).toMatchObject({ refreshToken: "rt-2" });
    expect(stored).toMatchObject({ planType: "pro", email: "new@example.test", lastRefreshAt: new Date(nowMs).toISOString() });
  });

  it("marks reused refresh tokens for re-login and keeps transient failures on the current token", async () => {
    const reused: CredentialRefresher = { needsRefresh: () => true, refresh: async () => { throw Object.assign(new Error("reused"), { code: "refresh_token_reused" }); } };
    const first = await setup(reused);
    const [account] = await first.pool.accounts();
    expect((await first.pool.credentials(account!)).accessToken).toBe("at-1");
    expect((await first.repository.listAccounts()).find((item) => item.id === first.accountId)).toMatchObject({ status: "REAUTH_REQUIRED", statusReason: expect.stringContaining("re-login") });
    const suspended: CredentialRefresher = { needsRefresh: () => true, refresh: async () => { throw Object.assign(new Error("gone"), { code: "account_suspended" }); } };
    const second = await setup(suspended);
    await expect(second.pool.credentials((await second.pool.accounts())[0]!)).rejects.toMatchObject({ code: "account_suspended" });
    const flaky: CredentialRefresher = { needsRefresh: () => true, refresh: async () => { throw Object.assign(new Error("timeout"), { code: "transport_error" }); } };
    const third = await setup(flaky);
    expect((await third.pool.credentials((await third.pool.accounts())[0]!)).accessToken).toBe("at-1");
  });

  it("takes a re-login account out of rotation when the provider rejected its access token, not only its refresh token", async () => {
    const select = async (pool: AccountPool) => selectAccount(await pool.balancerStates(), { now: nowMs / 1000 }).account?.accountId ?? null;
    const future = "2030-01-20T00:00:00.000Z";
    for (const [code, stillSelectable] of [["token_expired", false], ["refresh_token_reused", true]] as const) {
      const { pool, repository, accountId } = await setup(createCodexRefresher());
      await repository.withAccountCredentialLock(accountId, async () => ({ credentialsExpiresAt: future }));
      pool.invalidate();
      const [account] = await pool.accounts();
      await pool.markPermanentFailure(account!, code);
      const stored = (await repository.listAccounts()).find((item) => item.id === accountId)!;
      expect(stored.status).toBe("REAUTH_REQUIRED");
      // codex-lb keeps an unexpired token usable after a refresh failure; a rejected access token is expired now.
      expect(stored.credentialsExpiresAt).toBe(stillSelectable ? future : new Date(nowMs).toISOString());
      expect(await select(pool)).toBe(stillSelectable ? accountId : null);
    }
  });

  it("refreshes a rejected access token once: renewed accounts return to rotation, refused ones need a re-login", async () => {
    const future = "2030-01-20T00:00:00.000Z";
    const prepare = async (refresh: CredentialRefresher["refresh"], lastRefreshAt?: string) => {
      const context = await setup({ needsRefresh: () => false, refresh }, {}, lastRefreshAt);
      await context.repository.withAccountCredentialLock(context.accountId, async () => ({ credentialsExpiresAt: future }));
      await context.repository.recordAccountState(context.accountId, { status: "REAUTH_REQUIRED", statusReason: "Authentication token expired", blockedUntil: null });
      context.pool.invalidate();
      const stored = async () => (await context.repository.listAccounts()).find((item) => item.id === context.accountId)!;
      return { ...context, account: (await context.pool.accounts())[0]!, stored };
    };

    const renewed = await prepare(async (credentials) => ({ ...credentials, accessToken: "at-2", accessExpiresAtMs: Date.parse(future) + 1000 }));
    const retry = await renewed.pool.refreshRejectedToken(renewed.account, "token_expired");
    expect(retry?.id).toBe(renewed.accountId);
    expect((await renewed.pool.credentials(retry!)).accessToken).toBe("at-2");
    expect(await renewed.stored()).toMatchObject({ status: "ACTIVE", statusReason: null, lastRefreshAt: new Date(nowMs).toISOString() });

    const refused = await prepare(async () => { throw Object.assign(new Error("reused"), { code: "refresh_token_reused" }); });
    expect(await refused.pool.refreshRejectedToken(refused.account, "token_expired")).toBeNull();
    expect(await refused.stored()).toMatchObject({ status: "REAUTH_REQUIRED", credentialsExpiresAt: new Date(nowMs).toISOString() });

    // Refreshed minutes ago and still rejected: no second refresh.
    const recentRefresh = vi.fn();
    const recent = await prepare(recentRefresh, new Date(nowMs - 60_000).toISOString());
    expect(await recent.pool.refreshRejectedToken(recent.account, "token_expired")).toBeNull();
    expect(recentRefresh).not.toHaveBeenCalled();
    expect(await recent.stored()).toMatchObject({ status: "REAUTH_REQUIRED", credentialsExpiresAt: new Date(nowMs).toISOString() });

    // The token endpoint could not be reached: only a cooldown, the next request tries again.
    const unreachable = await prepare(async () => { throw Object.assign(new Error("timeout"), { code: "transport_error" }); });
    expect(await unreachable.pool.refreshRejectedToken(unreachable.account, "token_expired")).toBeNull();
    expect(await unreachable.stored()).toMatchObject({ credentialsExpiresAt: future });
    expect((await unreachable.pool.balancerStates())[0]).toMatchObject({ errorCount: 1 });
  });

  it("feeds rate limits and recoveries back into selection", async () => {
    const { pool, repository, accountId } = await setup(createCodexRefresher());
    const [account] = await pool.accounts();
    await pool.markRateLimited(account!, { message: "Try again in 30s" });
    expect(selectAccount(await pool.balancerStates(), { now: nowMs / 1000 }).account).toBeNull();
    expect((await repository.listAccounts()).find((item) => item.id === accountId)).toMatchObject({ status: "RATE_LIMITED", blockedUntil: new Date(nowMs + 30_000).toISOString() });
    await pool.markSuccess(accountId);
    expect(selectAccount(await pool.balancerStates(), { now: nowMs / 1000 }).account?.accountId).toBe(accountId);
    expect((await repository.listAccounts()).find((item) => item.id === accountId)?.status).toBe("ACTIVE");
  });

  it("clears a stored limit on success even when this process never saw the block", async () => {
    const { pool, repository, accountId } = await setup(createCodexRefresher());
    await pool.markRateLimited((await pool.accounts())[0]!, { message: "Try again in 30s" });
    // A restarted process (or one whose balancer already lifted the expired block) starts without runtime status.
    const fresh = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: createCodexRefresher(), now: () => nowMs + 60_000 });
    await fresh.markSuccess(accountId);
    expect((await repository.listAccounts()).find((item) => item.id === accountId)).toMatchObject({ status: "ACTIVE", statusReason: null, blockedUntil: null });
  });

  it("pauses a free-plan account for good: never selected, never refreshed, stored paused with the reason", async () => {
    const refresh = vi.fn();
    const { pool, repository, accountId } = await setup({ needsRefresh: () => true, refresh });
    await repository.withAccountCredentialLock(accountId, async () => ({ planType: "Free" }));
    pool.invalidate();
    const [account] = await pool.accounts();
    expect(account).toMatchObject({ status: "PAUSED", statusReason: GATEWAY_FREE_PLAN_PAUSE_REASON });
    expect((await repository.listAccounts()).find((item) => item.id === accountId)).toMatchObject({ status: "PAUSED", statusReason: GATEWAY_FREE_PLAN_PAUSE_REASON });
    expect(selectAccount(await pool.balancerStates(), { now: nowMs / 1000 }).account).toBeNull();
    // A copy read before the pause still never reaches the provider.
    await expect(pool.credentials({ ...account!, status: "ACTIVE" })).rejects.toMatchObject({ code: "free_plan_paused" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("pauses an account whose refresh shows a free plan, so the request moves to another account", async () => {
    const toFree: CredentialRefresher["refresh"] = async (credentials) => ({ ...credentials, accessToken: "at-2", planType: "free" });
    const due = await setup({ needsRefresh: () => true, refresh: toFree });
    await expect(due.pool.credentials((await due.pool.accounts())[0]!)).rejects.toMatchObject({ code: "free_plan_paused" });
    expect((await due.repository.listAccounts()).find((item) => item.id === due.accountId)).toMatchObject({ planType: "free", status: "PAUSED" });

    // A rejected access token renewed onto a free plan is not retried on.
    const rejected = await setup({ needsRefresh: () => false, refresh: toFree });
    expect(await rejected.pool.refreshRejectedToken((await rejected.pool.accounts())[0]!, "token_expired")).toBeNull();
    expect((await rejected.repository.listAccounts()).find((item) => item.id === rejected.accountId)).toMatchObject({ planType: "free", status: "PAUSED" });
    expect(selectAccount(await rejected.pool.balancerStates(), { now: nowMs / 1000 }).account).toBeNull();
  });

  it("keeps a paused account out of selection even after this process saw it recover", async () => {
    const { pool, repository, accountId } = await setup(createCodexRefresher());
    await pool.markRateLimited((await pool.accounts())[0]!, { message: "Try again in 30s" });
    await pool.markSuccess(accountId);
    await repository.setAccountStatus(accountId, "PAUSED", "Paused by an administrator.");
    pool.invalidate();
    expect(selectAccount(await pool.balancerStates(), { now: nowMs / 1000 }).account).toBeNull();
  });

  it("records passive usage for selection and dashboards", async () => {
    const { pool, accountId } = await setup(createCodexRefresher());
    await pool.recordUsage(accountId, { primaryUsedPercent: 64, secondaryUsedPercent: 12, primaryResetAt: null, secondaryResetAt: null, primaryWindowMinutes: 300, secondaryWindowMinutes: null });
    expect((await pool.balancerStates())[0]).toMatchObject({ usedPercent: 64, secondaryUsedPercent: 12 });
  });

  it("decides Codex refreshes from age and access-token expiry", () => {
    const refresher = createCodexRefresher();
    const account = { lastRefreshAt: "2030-01-09T00:00:00.000Z" } as never;
    const credentials: StoredCredentials = { accessToken: "a", refreshToken: "r", idToken: null, upstreamAccountId: null, accessExpiresAtMs: null };
    expect(refresher.needsRefresh(account, credentials, nowMs)).toBe(false);
    expect(refresher.needsRefresh({ lastRefreshAt: "2029-12-31T00:00:00.000Z" } as never, credentials, nowMs)).toBe(true);
    expect(refresher.needsRefresh(account, { ...credentials, accessExpiresAtMs: nowMs + 30_000 }, nowMs)).toBe(true);
    expect(refresher.needsRefresh(account, { ...credentials, refreshToken: null, accessExpiresAtMs: nowMs }, nowMs)).toBe(false);
  });
});
