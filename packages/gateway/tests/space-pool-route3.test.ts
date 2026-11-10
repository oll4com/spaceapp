import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayApiBudgetPace } from "@space/contracts";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { registerClaudeProxyRoutes } from "../src/providers/claude/claude-proxy.js";
import { createClaudeRefresher } from "../src/providers/claude/credentials.js";
import { registerCodexProxyRoutes } from "../src/providers/codex/codex-proxy.js";
import { registerCodexModelRoutes } from "../src/providers/codex/models.js";
import { registerSpacePoolRoutes } from "../src/providers/space/space-pool.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

/**
 * Plan clipboard:52W5YTibb65k step 5 (Nous 5/11, goal 35813e48): the third route serving, proven on a real gateway instead of waiting for
 * Claude Max and Codex to refuse together. One server as main.ts assembles it (the Codex and Claude native routes, the shared /v1/models,
 * /pools/space over real loopback HTTP with the internal token) with stable's routing settings; only the upstreams are fakes: every Claude
 * Max account and every Codex account answers its usage limit, the Claude API-key account answers. No live key or setting is touched.
 */
const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const claudeA = `gw_account:${"a".repeat(32)}`;
const claudeB = `gw_account:${"b".repeat(32)}`;
const keyAccount = `gw_account:${"d".repeat(32)}`;
const codexA = `gw_account:${"e".repeat(32)}`;
const testKeyId = `gw_key:${"f".repeat(32)}`;
const apiKey = `sk-ant-api03-${"k".repeat(60)}`;
const internalToken = "route3-internal-token";
// Stable's order and routing on 5/11 06:12 UTC (`space-admin-action gateway-status`).
const STABLE_ORDER = [{ route: "CLAUDE", enabled: true }, { route: "CODEX", enabled: true }, { route: "CLAUDE_OPENCODE", enabled: true },
  { route: "ANTIGRAVITY", enabled: true }, { route: "OPENAI_API", enabled: false }, { route: "OPENROUTER", enabled: false }, { route: "DEEPSEEK", enabled: false }] as const;
// Stable's Claude API budget at the same time: today's allowance used.
const ALLOWANCE_USED: GatewayApiBudgetPace = { budgetUsd: 500, monthSpentUsd: 73.06, remainingUsd: 426.94, daysLeft: 26, allowanceTodayUsd: 17.08, todaySpentUsd: 17.16,
  stop: "DAILY_ALLOWANCE_REACHED" } as GatewayApiBudgetPace;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject).listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => resolve(port)); });
});

const servers: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); });

async function stableGateway(options: { claudeApiKeyFallback: boolean; budget: GatewayApiBudgetPace | null }) {
  const repository = new InMemoryGatewayRepository();
  const resetAt = new Date(Date.now() + 40 * 60_000).toISOString();
  const add = async (accountId: string, provider: "CLAUDE" | "CODEX", name: string, credentials: StoredCredentials, extra: { planType: string; source: "OAUTH" | "API_KEY" }) => {
    await repository.upsertAccount({ accountId, provider, label: name, email: extra.source === "OAUTH" ? `${name}@spaceapp.dev` : null, externalAccountId: name, planType: extra.planType,
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: extra.source, sourceRef: null,
      lastRefreshAt: new Date().toISOString() });
  };
  for (const [accountId, name] of [[claudeA, "claude-a"], [claudeB, "claude-b"]] as const) {
    await add(accountId, "CLAUDE", name, { accessToken: `token-${name}`, refreshToken: "rt", idToken: null, upstreamAccountId: name, accessExpiresAtMs: null }, { planType: "max5x", source: "OAUTH" });
    // The Claude Max pool spent: every 5-hour window full, as Gateway's usage samples show it.
    await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: 100, resetAt, windowMinutes: 300 },
      { window: "SECONDARY", usedPercent: 60, resetAt: new Date(Date.now() + 3 * 86_400_000).toISOString(), windowMinutes: 10_080 }]);
  }
  await add(keyAccount, "CLAUDE", "Claude API key …kkkk", { accessToken: apiKey, refreshToken: null, idToken: null, upstreamAccountId: null, accessExpiresAtMs: null },
    { planType: "api", source: "API_KEY" });
  await add(codexA, "CODEX", "chatgpt-a", { accessToken: "token-chatgpt-a", refreshToken: "rt", idToken: null, upstreamAccountId: "chatgpt-a", accessExpiresAtMs: null },
    { planType: "plus", source: "OAUTH" });
  // Codex at 0% of its week (Nous 5/11).
  await repository.saveUsageWindows(codexA, [{ window: "SECONDARY", usedPercent: 100, resetAt: new Date(Date.now() + 2 * 86_400_000).toISOString(), windowMinutes: 10_080 }]);
  await repository.updateSettings({ subscriptionRouting: "FILL_FIRST", claudeApiKeyFallback: options.claudeApiKeyFallback, providerOrder: STABLE_ORDER.map((entry) => ({ ...entry })) });
  // A test key like any client's: no account scope, no model narrowing.
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: testKeyId, name: "route3-test", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [], enforcedModel: null,
    allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });

  const upstream: Array<{ provider: "CLAUDE" | "CODEX"; path: string; credential: string }> = [];
  const claudeFetch = (async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const credential = headers["x-api-key"] ? "api-key" : String(headers.authorization ?? "").replace("Bearer ", "");
    const path = new URL(url).pathname;
    upstream.push({ provider: "CLAUDE", path, credential });
    if (path === "/v1/models") return json({ data: [{ id: "claude-haiku-5-5" }, { id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }], has_more: false });
    if (credential === "api-key") return json({ id: "msg_route3", type: "message", role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "served" }],
      stop_reason: "end_turn", usage: { input_tokens: 5, output_tokens: 1 } });
    return json({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached" } }, 429,
      { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(Math.floor(Date.parse(resetAt) / 1000)) });
  }) as unknown as typeof fetch;
  const codexFetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    upstream.push({ provider: "CODEX", path, credential: String((init.headers as Record<string, string>)["chatgpt-account-id"] ?? "") });
    if (path.endsWith("/codex/models")) return json({ models: [{ slug: "gpt-6-astra" }, { slug: "gpt-6.1-sol" }] });
    return json({ error: { type: "usage_limit_reached", message: "You've hit your usage limit.", resets_in_seconds: 3600 } }, 429);
  }) as unknown as typeof fetch;

  const port = await freePort();
  const settings = () => repository.getSettings();
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const claudePool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: createClaudeRefresher() });
  const codexPool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: async () => { throw new Error("no refresh"); } } });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true, logger: false,
    routes: (app, helpers) => {
      registerCodexProxyRoutes(app, helpers, { pool: codexPool, logs, settings, fetchImpl: codexFetch, upstreamBaseUrl: "https://codex.test" });
      const claude = registerClaudeProxyRoutes(app, helpers, { pool: claudePool, logs, settings, fetchImpl: claudeFetch, upstreamBaseUrl: "https://claude.test", internalToken,
        ...(options.budget ? { apiBudget: { read: async () => options.budget, record: () => {} } } : {}) });
      registerCodexModelRoutes(app, helpers, { pool: codexPool, fetchImpl: codexFetch, upstreamBaseUrl: "https://codex.test", anthropicModels: claude.models });
      // As main.ts: the pool reaches the native routes over this gateway's own loopback listener.
      registerSpacePoolRoutes(app, { settings, selfBaseUrl: `http://127.0.0.1:${port}`, internalToken });
    } });
  await server.app.listen({ host: "127.0.0.1", port });
  servers.push({ close: () => server.app.close() });
  const call = (path: string, body: unknown, protocol: "anthropic" | "openai") => fetch(`http://127.0.0.1:${port}${path}`, { method: "POST",
    headers: { "content-type": "application/json", "user-agent": "space-route3-check/1.0", ...(protocol === "anthropic" ? { "x-api-key": plainKey, "anthropic-version": "2023-06-01" }
      : { authorization: `Bearer ${plainKey}` }) }, body: JSON.stringify(body) });
  const logRows = async () => { await logs.flush(); return (await repository.listRequestLogs({ limit: 50 })).filter((row) => row.apiKeyId === testKeyId).reverse(); };
  const models = () => fetch(`http://127.0.0.1:${port}/pools/space/v1/models`, { headers: { authorization: `Bearer ${plainKey}` } });
  return { call, logRows, models, upstream };
}

const ask = { model: "auto", max_tokens: 16, messages: [{ role: "user", content: "route 3 check" }] };

describe("Space provider route 3 on a real gateway (plan clipboard:52W5YTibb65k step 5)", () => {
  it("Claude Max and Codex both refuse: a Messages client is served by Claude via OpenCode, with the route, model, fallback and log rows", async () => {
    const gateway = await stableGateway({ claudeApiKeyFallback: false, budget: null });
    const response = await gateway.call("/pools/space/v1/messages", ask, "anthropic");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "msg_route3", content: [{ text: "served" }] });
    expect(response.headers.get("x-space-route")).toBe("CLAUDE_OPENCODE");
    expect(response.headers.get("x-space-model")).toBe("opencode-claude:claude-opus-5-5");
    // The first request finds the pool spent upstream: full samples never refuse on their own, so each Max account is asked once and
    // answers its usage limit. The route passes Anthropic's own error type on, which the pool reads as a provider throttle (not quota).
    expect(JSON.parse(response.headers.get("x-space-fallback") ?? "null")).toEqual([
      { route: "CLAUDE", model: "claude:claude-opus-5-5", kind: "throttle", scope: "provider_rate", code: "rate_limit_error", resets_at: null }]);
    expect(gateway.upstream.filter((call) => call.provider === "CLAUDE" && call.path === "/v1/messages").map((call) => call.credential))
      .toEqual(["token-claude-a", "token-claude-b", "api-key"]);
    // From then on the Max accounts are marked limited: the Claude route refuses at once with the pool's quota, and route 3 serves again.
    const again = await gateway.call("/pools/space/v1/messages", ask, "anthropic");
    expect(again.status).toBe(200);
    expect(again.headers.get("x-space-route")).toBe("CLAUDE_OPENCODE");
    expect(JSON.parse(again.headers.get("x-space-fallback") ?? "null")).toEqual([
      { route: "CLAUDE", model: "claude:claude-opus-5-5", kind: "quota", scope: "provider_pool", code: "usage_limit_reached", resets_at: null }]);
    expect(gateway.upstream.filter((call) => call.provider === "CLAUDE" && call.path === "/v1/messages").map((call) => call.credential).slice(3)).toEqual(["api-key"]);
    // Gateway's log under the test key: each Claude refusal (the last account asked, or none), then the answer on the API-key account.
    expect((await gateway.logRows()).map((row) => [row.provider, row.status, row.errorCode, row.accountId, row.model])).toEqual([
      ["CLAUDE", "error", "rate_limit_error", claudeB, "claude-opus-5-5"], ["CLAUDE", "success", null, keyAccount, "claude-opus-5-5"],
      ["CLAUDE", "error", "usage_limit_reached", null, "claude-opus-5-5"], ["CLAUDE", "success", null, keyAccount, "claude-opus-5-5"]]);

    // Codex refuses at the same time: an OpenAI client's auto ends there (the pay-per-token routes are off on stable), naming Codex's quota.
    const codex = await gateway.call("/pools/space/v1/responses", { model: "auto", input: "route 3 check" }, "openai");
    expect(codex.status).toBe(429);
    expect(await codex.json()).toMatchObject({ error: { code: "space_routes_exhausted", kind: "exhausted",
      attempts: [{ route: "CODEX", model: "codex:gpt-6-astra", kind: "quota", scope: "provider_pool", code: "usage_limit_reached" }] } });
    expect((await gateway.logRows()).at(-1)).toMatchObject({ provider: "CODEX", status: "error", errorCode: "usage_limit_reached" });
    // Antigravity, route 4, has no gateway-key protocol: listed as such, never faked.
    const listed = await (await gateway.models()).json() as { routes: Array<{ route: string; available: boolean; reason: string | null }> };
    expect(listed.routes.find((route) => route.route === "ANTIGRAVITY")).toMatchObject({ available: false, reason: "No gateway-key protocol (Gemini CLI and Nous only)." });
  });

  it("with stable's Claude API-key fallback on, the Claude route itself answers on the key; with today's API allowance used, both Claude routes refuse", async () => {
    const fallback = await stableGateway({ claudeApiKeyFallback: true, budget: null });
    const served = await fallback.call("/pools/space/v1/messages", ask, "anthropic");
    expect(served.status).toBe(200);
    expect(served.headers.get("x-space-route")).toBe("CLAUDE");
    expect(served.headers.get("x-space-fallback")).toBeNull();
    expect((await fallback.logRows()).map((row) => [row.provider, row.status, row.accountId])).toEqual([["CLAUDE", "success", keyAccount]]);

    // Stable at 06:12 UTC: $17.16 of today's $17.08 used. The Claude route asks the Max accounts and refuses with their limit,
    // route 3 refuses on the allowance, and the API key is never spent.
    const spent = await stableGateway({ claudeApiKeyFallback: true, budget: ALLOWANCE_USED });
    const refused = await spent.call("/pools/space/v1/messages", ask, "anthropic");
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ type: "error", error: { code: "space_routes_exhausted", attempts: [
      { route: "CLAUDE", kind: "throttle", code: "rate_limit_error" }, { route: "CLAUDE_OPENCODE", kind: "budget", code: "DAILY_ALLOWANCE_REACHED" }] } });
    expect(spent.upstream.filter((call) => call.path === "/v1/messages").map((call) => call.credential)).toEqual(["token-claude-a", "token-claude-b"]);
  });
});
