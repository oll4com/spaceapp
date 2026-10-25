import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { registerApiKeyAccountRoutes } from "../src/admin/api-key-accounts.js";
import { claudeAccountActions } from "../src/admin/claude-sign-in.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { CLAUDE_API_KEY_PATTERN, claudeCreditsExhausted, isClaudeApiKeyAccount } from "../src/providers/claude/api-key.js";
import { registerClaudeProxyRoutes } from "../src/providers/claude/claude-proxy.js";
import { createClaudeRefresher } from "../src/providers/claude/credentials.js";
import { buildClaudeUpstreamHeaders } from "../src/providers/claude/headers.js";
import { startClaudeUsagePoller } from "../src/providers/claude/usage-refresh.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

/**
 * Operator request 2026-10-13: the Claude API key joins Space Gateway as a per-token fallback. It serves only while
 * every pooled subscription account is out of quota and only with the setting on; the accounts take over again at
 * their next reset.
 */
const cipher = createCredentialCipher(Buffer.alloc(32, 9));
const startMs = Date.parse("2030-01-10T00:00:00Z");
const accountA = `gw_account:${"a".repeat(32)}`;
const accountB = `gw_account:${"b".repeat(32)}`;
const keyAccount = `gw_account:${"d".repeat(32)}`;
const apiKey = `sk-ant-api03-${"k".repeat(60)}`;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const message = (id: string) => json({ id, type: "message", model: "claude-sonnet-4-5", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 5, output_tokens: 1 } });
const limited = (resetSeconds: number) => json({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached" } }, 429,
  { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(resetSeconds) });

interface Call { auth: string; url: string; betas: string | undefined; body: Record<string, unknown> }

async function setup(upstream: (call: Call) => Response, options: { fallback?: boolean; withKey?: boolean } = {}) {
  const repository = new InMemoryGatewayRepository();
  let clock = startMs;
  const now = () => clock;
  for (const [accountId, name] of [[accountA, "claude-a"], [accountB, "claude-b"]] as const) {
    const credentials: StoredCredentials = { accessToken: `token-${name}`, refreshToken: "rt", idToken: null, upstreamAccountId: name, accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId, provider: "CLAUDE", label: name, email: `${name}@spaceapp.dev`, externalAccountId: name, planType: "max5x",
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null,
      lastRefreshAt: new Date(startMs).toISOString() });
    await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: 10, resetAt: null, windowMinutes: 300 }]);
  }
  if (options.withKey !== false) {
    const credentials: StoredCredentials = { accessToken: apiKey, refreshToken: null, idToken: null, upstreamAccountId: null, accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId: keyAccount, provider: "CLAUDE", label: "Claude API key …kkkk", email: null, externalAccountId: "key:k", planType: "api",
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), keyAccount), credentialsExpiresAt: null, source: "API_KEY", sourceRef: "space-claude",
      lastRefreshAt: new Date(startMs).toISOString() });
  }
  await repository.updateSettings({ routingStrategy: "USAGE_WEIGHTED", claudeApiKeyFallback: options.fallback ?? false });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"c".repeat(32)}`, name: "Claude Code", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [],
    expiresAt: null, createdBy: null });
  const pool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: createClaudeRefresher(), now });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const call: Call = { auth: headers.authorization ? headers.authorization.replace("Bearer ", "") : `key:${headers["x-api-key"] ?? ""}`, url,
      betas: headers["anthropic-beta"], body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} };
    calls.push(call);
    return upstream(call);
  }) as unknown as typeof fetch;
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true, now: () => new Date(now()),
    routes: (app, helpers) => {
      registerClaudeProxyRoutes(app, helpers, { pool, logs, settings: () => repository.getSettings(), fetchImpl, now, upstreamBaseUrl: "https://claude.test" });
    } });
  const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}, url = "/v1/messages") => server.app.inject({
    method: "POST", url, payload, headers: { "x-api-key": plainKey, "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", ...headers }
  });
  // Both subscription accounts at 100% of the 5-hour window, back in 40 minutes.
  const limitAccounts = async () => {
    const resetAt = new Date(startMs + 40 * 60_000).toISOString();
    for (const accountId of [accountA, accountB]) {
      await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: 100, resetAt, windowMinutes: 300 }]);
      await repository.recordAccountState(accountId, { status: "RATE_LIMITED", statusReason: "rate limit", blockedUntil: resetAt });
    }
  };
  const account = async (id: string) => (await repository.listAccounts()).find((item) => item.id === id)!;
  return { repository, pool, logs, calls, post, fetchImpl, limitAccounts, account, advance: (ms: number) => { clock += ms; } };
}

describe("Claude API key account", () => {
  it("recognises Anthropic keys, the API-key account and the used-up credits answer", () => {
    expect(CLAUDE_API_KEY_PATTERN.test(apiKey)).toBe(true);
    // Built at runtime so secret scanners do not read the fixture as an OpenAI key.
    expect(CLAUDE_API_KEY_PATTERN.test(["sk-proj-", "not-anthropic-xxxxxxxxxxxxxxxx"].join(""))).toBe(false);
    expect(isClaudeApiKeyAccount({ provider: "CLAUDE", source: "API_KEY" })).toBe(true);
    expect(isClaudeApiKeyAccount({ provider: "CLAUDE", source: "OAUTH" })).toBe(false);
    expect(isClaudeApiKeyAccount({ provider: "OPENAI_API", source: "API_KEY" })).toBe(false);
    expect(claudeCreditsExhausted(400, "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.")).toBe(true);
    expect(claudeCreditsExhausted(400, "max_tokens: must be greater than 0")).toBe(false);
    expect(claudeCreditsExhausted(429, "credit balance")).toBe(false);
  });

  it("sends the key as x-api-key without the OAuth beta that subscription tokens carry", () => {
    const headers = buildClaudeUpstreamHeaders({ "x-api-key": "sk-sgw-x", "anthropic-beta": "claude-code-20250219,oauth-2025-04-20", "x-app": "cli" }, apiKey,
      "text/event-stream", "api-key");
    expect(headers).toEqual({ "anthropic-beta": "claude-code-20250219", "anthropic-version": "2023-06-01", "x-app": "cli", "x-api-key": apiKey,
      accept: "text/event-stream", "content-type": "application/json" });
    expect(buildClaudeUpstreamHeaders({ "anthropic-beta": "oauth-2025-04-20" }, apiKey, "application/json", "api-key")).not.toHaveProperty("anthropic-beta");
    expect(buildClaudeUpstreamHeaders({}, "oat-token")).toMatchObject({ authorization: "Bearer oat-token", "anthropic-beta": "oauth-2025-04-20" });
  });

  it("adds a Claude key checked with the free model list and files it under the api plan", async () => {
    const repository = new InMemoryGatewayRepository();
    const pool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: createClaudeRefresher() });
    const checks: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      checks.push({ url, headers });
      return json(headers["x-api-key"] === apiKey ? { data: [{ id: "claude-opus-5-5", type: "model" }] } : { type: "error" }, headers["x-api-key"] === apiKey ? 200 : 401);
    }) as unknown as typeof fetch;
    const admin = Fastify();
    registerApiKeyAccountRoutes(admin, { repository, pools: { CLAUDE: pool }, cipher: () => cipher, internalToken: "internal", fetchImpl });
    const add = (key: string, extra: Record<string, unknown> = {}) => admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/add", remoteAddress: "127.0.0.1",
      headers: { "x-space-internal-token": "internal" }, payload: { provider: "CLAUDE", apiKey: key, ...extra } });
    const added = await add(apiKey, { sourceRef: "space-claude" });
    expect(added.json()).toMatchObject({ status: "CONNECTED", account: { provider: "CLAUDE", label: "Claude API key …kkkk", planType: "api" } });
    expect(checks[0]).toMatchObject({ url: "https://api.anthropic.com/v1/models?limit=1", headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
    expect(checks[0]!.headers.authorization).toBeUndefined();
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ provider: "CLAUDE", source: "API_KEY", sourceRef: "space-claude", planType: "api", email: null });
    expect(JSON.stringify(account)).not.toContain(apiKey);
    expect((await add(`sk-ant-api03-${"z".repeat(60)}`)).json().error.code).toBe("api_key_rejected");
    expect((await add(["sk-proj-", "not-anthropic-xxxxxxxxxxxxxxxx"].join(""))).json().error.code).toBe("invalid_api_key");
    expect((await add(apiKey, { provider: "GOOGLE_AI" })).statusCode).toBe(422);
  });

  it("tests the key with the free model list and never polls it for plan usage", async () => {
    const { repository, pool, fetchImpl, calls, account } = await setup((call) => call.url.includes("/v1/models") ? json({ data: [] }) : json({ five_hour: { utilization: 0.2 } }));
    const actions = claudeAccountActions({ repository, pool, fetchImpl, upstreamBaseUrl: "https://claude.test" });
    expect(await actions.test(await account(keyAccount), {})).toMatchObject({ ok: true, status: 200, error: null, planType: "api" });
    expect(calls.at(-1)).toMatchObject({ url: "https://claude.test/v1/models?limit=1", auth: `key:${apiKey}` });
    await actions.refreshUsage(await account(keyAccount));
    expect(calls).toHaveLength(1);
    const poller = startClaudeUsagePoller({ repository, pool, intervalMs: 3_600_000, fetchImpl });
    await poller.runOnce();
    poller.stop();
    expect(calls.slice(1).map((call) => call.auth).sort()).toEqual(["token-claude-a", "token-claude-b"]);
  });
});

describe("Claude API key fallback", () => {
  it("never uses the key while the setting is off", async () => {
    const { post, calls, limitAccounts } = await setup(() => message("never"));
    await limitAccounts();
    const response = await post({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(429);
    expect(calls).toHaveLength(0);
    expect((response.json() as { error: { message: string } }).error.message).toMatch(/^All 2 Claude accounts in Space Gateway reached their usage limit\./);
  });

  it("serves through the key only while every account is out of quota, and returns to the accounts at their reset", async () => {
    const { post, calls, logs, repository, limitAccounts, advance } = await setup((call) => message(call.auth.startsWith("key:") ? "msg_key" : "msg_sub"), { fallback: true });
    const session = { "x-claude-code-session-id": "5f2c1f9e-7a1b-4c1d-9e2f-0a1b2c3d4e5f" };
    const body = { model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] };
    // Room on the accounts: the key stays idle.
    expect((await post(body, session)).json()).toMatchObject({ id: "msg_sub" });
    expect(calls[0]!.auth).toBe("token-claude-a");
    await limitAccounts();
    advance(6_000); // past the pool's account cache
    expect((await post(body, session)).json()).toMatchObject({ id: "msg_key" });
    expect(calls[1]).toMatchObject({ auth: `key:${apiKey}`, betas: "claude-code-20250219", url: "https://claude.test/v1/messages" });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 1 });
    expect(log).toMatchObject({ provider: "CLAUDE", status: "success", accountId: keyAccount, planType: "api" });
    // The accounts' block lapses: the same conversation goes back to a subscription account at its next request.
    advance(41 * 60_000);
    expect((await post(body, session)).json()).toMatchObject({ id: "msg_sub" });
    expect(calls[2]!.auth).toMatch(/^token-claude-/);
  });

  it("takes the key out of routing when Anthropic reports used-up credits, and passes the answer on", async () => {
    const credits = { type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } };
    const { post, calls, limitAccounts, account } = await setup((call) => call.auth.startsWith("key:") ? json(credits, 400) : limited(startMs / 1000 + 2400), { fallback: true });
    await limitAccounts();
    const response = await post({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual(credits);
    expect(calls.map((call) => call.auth)).toEqual([`key:${apiKey}`]);
    const key = await account(keyAccount);
    expect(key.status).toBe("QUOTA_EXCEEDED");
    expect(key.statusReason).toMatch(/credit balance/);
    expect(key.blockedUntil).toBe(new Date(startMs + 3_600_000).toISOString());
  });

  it("answers token counts and model lists from the accounts first, and from the key only with the fallback on", async () => {
    const withFallback = await setup((call) => json(call.url.includes("count_tokens") ? { input_tokens: 12 } : { data: [] }), { fallback: true });
    await withFallback.post({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }, {}, "/v1/messages/count_tokens");
    expect(withFallback.calls[0]!.auth).toBe("token-claude-a");
    await withFallback.limitAccounts();
    withFallback.advance(6_000);
    const counted = await withFallback.post({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }, {}, "/v1/messages/count_tokens");
    expect(counted.json()).toEqual({ input_tokens: 12 });
    expect(withFallback.calls[1]!.auth).toBe("token-claude-a"); // a limited account can still count tokens
    const without = await setup(() => json({ data: [] }), { fallback: false });
    for (const accountId of [accountA, accountB]) await without.repository.setAccountStatus(accountId, "PAUSED", null);
    const count = await without.post({ model: "claude-sonnet-4-5", messages: [{ role: "user", content: "hi" }] }, {}, "/v1/messages/count_tokens");
    expect(count.statusCode).toBe(503);
    expect(without.calls).toHaveLength(0);
  });
});
