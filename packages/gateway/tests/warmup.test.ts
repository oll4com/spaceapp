import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository, type GatewayAccountRecord, type GatewayUsageHistoryPoint } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { StickyStore } from "../src/accounts/sticky-store.js";
import { registerAccountAdminRoutes } from "../src/admin/account-admin.js";
import { registerCodexSignInRoutes } from "../src/admin/codex-sign-in.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { lanAccessFromSettings } from "../src/lan-access.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { runWarmupCycle, warmupModel, warmupWindow } from "../src/warmup/warmup-runner.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 9));
const NOW = Date.parse("2030-01-08T12:00:00.000Z");
const settingsBase = { warmupWindows: "BOTH" as const, warmupMinAvailablePercent: 100 };
const point = (window: "PRIMARY" | "SECONDARY", usedPercent: number, resetAt: string, recordedAt: string): GatewayUsageHistoryPoint =>
  ({ window, quotaKey: "", usedPercent, resetAt, recordedAt });

function account(fields: Partial<GatewayAccountRecord> = {}): GatewayAccountRecord {
  return {
    id: `gw_account:${"1".repeat(32)}`, provider: "CODEX", label: "Team", alias: null, email: "team@example.test", planType: "plus", status: "ACTIVE",
    statusReason: null, priority: 100, warmupEnabled: true, resetCreditsAvailable: null, primaryWindow: { usedPercent: 0, resetAt: null, windowMinutes: 300 },
    secondaryWindow: { usedPercent: 0, resetAt: null, windowMinutes: 10080 }, lastRefreshAt: null, lastUsedAt: null, createdAt: "2030-01-01T00:00:00.000Z",
    externalAccountId: "acct-1", credentialsEncrypted: "", credentialsExpiresAt: null, source: "OAUTH", sourceRef: null, blockedUntil: null, ...fields
  };
}

describe("Limit warm-up (codex-lb)", () => {
  it("fires only after a used-up window shows a newer reset with enough free, despite reset times that drift by seconds", () => {
    const history = [
      point("PRIMARY", 99, "2030-01-08T10:00:03.000Z", "2030-01-08T09:40:00.000Z"),
      point("PRIMARY", 100, "2030-01-08T10:00:01.000Z", "2030-01-08T09:50:00.000Z"),
      point("PRIMARY", 0, "2030-01-08T15:00:02.000Z", "2030-01-08T10:01:00.000Z")
    ];
    expect(warmupWindow(history, account(), settingsBase)).toMatchObject({ window: "PRIMARY", resetAt: "2030-01-08T15:00:00.000Z" });
    // Samples of one period whose reset drifted by seconds are not a reset.
    expect(warmupWindow([history[1]!, point("PRIMARY", 0, "2030-01-08T10:00:40.000Z", "2030-01-08T09:55:00.000Z")], account(), settingsBase)).toBeNull();
    // Not used up before, or not free enough after.
    expect(warmupWindow([point("PRIMARY", 80, "2030-01-08T10:00:00.000Z", "2030-01-08T09:50:00.000Z"), history[2]!], account(), settingsBase)).toBeNull();
    expect(warmupWindow([history[1]!, point("PRIMARY", 3, "2030-01-08T15:00:00.000Z", "2030-01-08T10:30:00.000Z")], account(), settingsBase)).toBeNull();
    expect(warmupWindow([history[1]!, point("PRIMARY", 3, "2030-01-08T15:00:00.000Z", "2030-01-08T10:30:00.000Z")], account(), { ...settingsBase, warmupMinAvailablePercent: 90 })).not.toBeNull();
    // Only the selected windows; a weekly-only account has no 5h window to warm.
    expect(warmupWindow(history, account(), { ...settingsBase, warmupWindows: "SECONDARY" })).toBeNull();
    expect(warmupWindow(history, account({ primaryWindow: { usedPercent: 0, resetAt: null, windowMinutes: 10080 } }), settingsBase)).toBeNull();
  });

  it("picks the cheapest priced model the plan offers for auto", () => {
    expect(warmupModel("auto", ["gpt-6-sol", "gpt-5.6-luna", "gpt-6-luna", "unknown-model"])).toBe("gpt-6-luna");
    expect(warmupModel("auto", ["unknown-model"])).toBeNull();
    expect(warmupModel(" gpt-5.5 ", [])).toBe("gpt-5.5");
  });

  it("sends one request per reset, logs it as warm-up and respects the cooldown", async () => {
    const repository = new InMemoryGatewayRepository();
    const record = account();
    const credentials = { accessToken: "at", refreshToken: "rt", idToken: null, upstreamAccountId: "acct-1", accessExpiresAtMs: null };
    repository.accounts.push({ ...record, credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), record.id) });
    repository.history.push({ accountId: record.id, ...point("PRIMARY", 100, "2030-01-08T10:00:00.000Z", "2030-01-08T09:50:00.000Z") },
      { accountId: record.id, ...point("PRIMARY", 0, "2030-01-08T15:00:00.000Z", "2030-01-08T10:01:00.000Z") });
    const stream = 'event: response.completed\ndata: {"type":"response.completed","response":{"model":"gpt-6-luna","usage":{"input_tokens":9,"output_tokens":1}}}\n\n';
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const logs = new RequestLogWriter(repository);
    const settings = { ...(await repository.getSettings()), warmupEnabled: true };
    const options = { repository, pool, logs, fetchImpl: fetchImpl as unknown as typeof fetch, now: () => NOW,
      modelPlans: { modelsFor: () => ["gpt-6-sol", "gpt-6-luna"] } as never, settings: async () => settings };
    expect(await runWarmupCycle({ ...options, settings: async () => ({ ...settings, warmupEnabled: false }) })).toBe(0);
    expect(await runWarmupCycle(options)).toBe(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "gpt-6-luna", instructions: "Reply with OK only.", store: false });
    await logs.flush();
    expect(repository.logs[0]).toMatchObject({ source: "limit_warmup", accountId: record.id, status: "success" });
    expect(await repository.aggregateRequestLogs({}, "total")).toEqual([]);
    expect((await repository.latestWarmups())[0]).toMatchObject({ status: "SUCCEEDED", window: "PRIMARY", model: "gpt-6-luna" });
    // Same reset: never again; a later reset waits out the cooldown.
    expect(await runWarmupCycle(options)).toBe(0);
    repository.history.push({ accountId: record.id, ...point("PRIMARY", 100, "2030-01-08T15:00:00.000Z", "2030-01-08T11:00:00.000Z") },
      { accountId: record.id, ...point("PRIMARY", 0, "2030-01-08T20:00:00.000Z", "2030-01-08T11:01:00.000Z") });
    expect(await runWarmupCycle(options)).toBe(0);
    expect(await runWarmupCycle({ ...options, now: () => NOW + 2 * 3_600_000 })).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("Settings applied by the gateway", () => {
  it("validates LAN access from the settings with the env-file rules", () => {
    expect(lanAccessFromSettings({ lanMode: "ENV", lanHost: null, lanPort: null, lanAllowedSources: [] })).toEqual({ lan: null, error: null });
    expect(lanAccessFromSettings({ lanMode: "OFF", lanHost: "10.0.0.1", lanPort: 4925, lanAllowedSources: ["10.0.0.0/8"] })).toEqual({ lan: null, error: null });
    const on = lanAccessFromSettings({ lanMode: "ON", lanHost: "10.20.0.207", lanPort: 4925, lanAllowedSources: ["10.20.0.0/24"] });
    expect(on.lan).toMatchObject({ host: "10.20.0.207", port: 4925, allowedSources: [{ text: "10.20.0.0/24" }] });
    expect(lanAccessFromSettings({ lanMode: "ON", lanHost: "8.8.8.8", lanPort: 4925, lanAllowedSources: ["10.0.0.0/8"] }).error).toMatch(/The LAN address must be a private/);
    expect(lanAccessFromSettings({ lanMode: "ON", lanHost: "10.0.0.1", lanPort: 4925, lanAllowedSources: ["0.0.0.0/0"] }).error).toMatch(/only private ranges/);
    expect(lanAccessFromSettings({ lanMode: "ON", lanHost: "10.0.0.1", lanPort: 4925, lanAllowedSources: [] }).error).toMatch(/The allowed ranges must list/);
    expect(lanAccessFromSettings({ lanMode: "ON", lanHost: null, lanPort: 4925, lanAllowedSources: ["10.0.0.0/8"] }).error).toBe("Give the LAN address to listen on.");
  });

  it("reloads only under the supervisor and only for the Space API", async () => {
    const repository = new InMemoryGatewayRepository();
    const reload = vi.fn(() => true);
    const app = Fastify();
    registerAccountAdminRoutes(app, { repository, cipher: () => cipher, internalToken: "internal-secret", reload });
    const call = (token: string) => app.inject({ method: "POST", url: "/__space-gateway/admin/reload", payload: {}, headers: { "x-space-internal-token": token } });
    expect((await call("wrong")).statusCode).toBe(403);
    expect((await call("internal-secret")).statusCode).toBe(202);
    expect(reload).toHaveBeenCalledTimes(1);
    const bare = Fastify();
    registerAccountAdminRoutes(bare, { repository, cipher: () => cipher, internalToken: "internal-secret" });
    expect((await bare.inject({ method: "POST", url: "/__space-gateway/admin/reload", payload: {}, headers: { "x-space-internal-token": "internal-secret" } })).statusCode).toBe(409);
  });

  it("follows a changing prompt-cache affinity time", async () => {
    let now = 0;
    let ttl = 60_000;
    const store = new StickyStore({ provider: "CODEX", kind: "STICKY_THREAD", now: () => now, ttlMs: () => ttl });
    store.set("a".repeat(64), "account-1");
    now = 59_000;
    expect(await store.get("a".repeat(64))).toBe("account-1");
    ttl = 10_000;
    store.set("b".repeat(64), "account-2");
    now = 70_000;
    expect(await store.get("b".repeat(64))).toBeUndefined();
  });

  it("imports with overwrite onto the account with the same email when the policy allows it", async () => {
    const repository = new InMemoryGatewayRepository();
    const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const app = Fastify();
    registerCodexSignInRoutes(app, { repository, pool, cipher: () => cipher, internalToken: "internal-secret",
      fetchImpl: vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch });
    const jwt = (payload: Record<string, unknown>) => ["e30", Buffer.from(JSON.stringify(payload)).toString("base64url"), "s"].join(".");
    const authJson = (accountId: string) => JSON.stringify({ tokens: { access_token: jwt({ exp: 1_900_000_000 }), refresh_token: `rt-${accountId}`, account_id: accountId,
      id_token: jwt({ email: "same@example.test", "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } }) } });
    const importJson = (body: string) => app.inject({ method: "POST", url: "/__space-gateway/admin/codex/import", payload: { authJson: body },
      headers: { "x-space-internal-token": "internal-secret" } });
    await importJson(authJson("acct-a"));
    const [first] = await repository.listAccounts();
    await repository.updateAccountPreferences(first!.id, { alias: "Kept" });
    // Default policy: import without overwrite adds the other upstream account beside it.
    await importJson(authJson("acct-b"));
    expect(await repository.listAccounts()).toHaveLength(2);
    await repository.deleteAccount((await repository.listAccounts()).find((item) => item.externalAccountId?.startsWith("acct-b"))!.id);
    await repository.updateSettings({ importWithoutOverwrite: false });
    const replaced = (await importJson(authJson("acct-c"))).json();
    const accounts = await repository.listAccounts();
    expect(accounts).toHaveLength(1);
    expect(replaced.account.id).toBe(first!.id);
    expect(accounts[0]).toMatchObject({ id: first!.id, alias: "Kept", externalAccountId: expect.stringContaining("acct-c") });
    expect(JSON.parse(cipher.decrypt(accounts[0]!.credentialsEncrypted, accounts[0]!.id)).refreshToken).toBe("rt-acct-c");
  });
});
