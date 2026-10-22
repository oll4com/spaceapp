import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryGatewayRepository, type GatewayRequestLogInsert } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { registerAnthropicAdminRoutes, startAnthropicBillingSync } from "../src/admin/anthropic-admin.js";
import { ANTHROPIC_ADMIN_KEY_AAD, anthropicBillingReport, anthropicModelFactors, fetchAnthropicReports, matchAnthropicKey } from "../src/anthropic-billing.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { createClaudeRefresher } from "../src/providers/claude/credentials.js";

/**
 * Operator request 2026-10-18: Space Gateway reads Anthropic's own bill with the operator's Admin API key and lets the
 * daily COST_USD caps count the real charge instead of the list-price estimate.
 */
const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const nowMs = Date.parse("2030-01-10T12:00:00Z");
const keyAccount = `gw_account:${"d".repeat(32)}`;
const gatewayKeyId = `gw_key:${"c".repeat(32)}`;
const plainClaudeKey = `sk-ant-api03-R2D${"k".repeat(60)}igAA`;
const adminKey = `sk-ant-admin01-${"a".repeat(40)}`;
const token = "internal-token";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Opus 5.5 at list: 1M uncached input $4 + 0.1M output $2 = $6; Anthropic bills $7.20, a factor of 1.2. */
function anthropic(options: { costCents?: string; status?: number; day?: string } = {}) {
  const day = options.day ?? "2030-01-10";
  const bucket = { starting_at: `${day}T00:00:00Z`, ending_at: `${day.slice(0, 8)}${String(Number(day.slice(8)) + 1).padStart(2, "0")}T00:00:00Z` };
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    expect((init?.headers as Record<string, string>)["x-api-key"]).toBe(adminKey);
    if (options.status) return json({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, options.status);
    if (url.pathname === "/v1/organizations/api_keys") {
      return json({ data: [
        { id: "apikey_gateway", name: "Space Gateway", partial_key_hint: "sk-ant-api03-R2D...igAA", workspace_id: "wrkspc_space", status: "active" },
        { id: "apikey_other", name: "Other", partial_key_hint: "sk-ant-api03-ZZZ...zzzz", workspace_id: null, status: "active" }
      ], has_more: false, first_id: "apikey_gateway", last_id: "apikey_other" });
    }
    if (url.pathname === "/v1/organizations/cost_report") {
      const costDay = { ...bucket, results: [
        { amount: options.costCents ?? "600", currency: "USD", workspace_id: "wrkspc_space", description: "Claude Opus 5.5 Usage - Input Tokens", cost_type: "tokens",
          token_type: "uncached_input_tokens", model: "claude-opus-5-5", service_tier: "standard", context_window: "0-200k", speed: "standard" },
        { amount: "120", currency: "USD", workspace_id: "wrkspc_space", description: "Claude Opus 5.5 Usage - Output Tokens", cost_type: "tokens",
          token_type: "output_tokens", model: "claude-opus-5-5", service_tier: "standard", context_window: "0-200k", speed: "standard" },
        { amount: "50", currency: "USD", workspace_id: "wrkspc_space", description: "Claude Opus 5.5 Batch - Input Tokens", cost_type: "tokens",
          token_type: "uncached_input_tokens", model: "claude-opus-5-5", service_tier: "batch", context_window: "0-200k", speed: "standard" },
        { amount: "1000", currency: "USD", workspace_id: null, description: "Web Search", cost_type: "web_search", token_type: null, model: null }
      ] };
      // Two pages: the second carries the day before.
      return url.searchParams.get("page")
        ? json({ data: [{ starting_at: "2030-01-09T00:00:00Z", ending_at: "2030-01-10T00:00:00Z", results: [] }], has_more: false, next_page: null })
        : json({ data: [costDay], has_more: true, next_page: "page_2" });
    }
    if (url.pathname === "/v1/organizations/usage_report/messages") {
      expect(url.searchParams.getAll("group_by[]")).toEqual(["workspace_id", "api_key_id", "model", "context_window", "speed"]);
      expect(url.searchParams.getAll("service_tiers[]")).toEqual(["standard"]);
      expect(url.searchParams.get("ending_at")).toBe(options.day ? "2030-01-12T00:00:00Z" : url.searchParams.get("ending_at"));
      return json({ data: [{ ...bucket, results: [
        { api_key_id: "apikey_gateway", workspace_id: "wrkspc_space", model: "claude-opus-5-5", context_window: "0-200k", speed: "standard",
          uncached_input_tokens: 1_000_000, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 },
          output_tokens: 100_000, server_tool_use: { web_search_requests: 0 } }
      ] }], has_more: false, next_page: null });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const log = (overrides: Partial<GatewayRequestLogInsert>): GatewayRequestLogInsert => ({
  requestId: `req_${Math.random()}`, requestedAt: "2030-01-10T11:00:00.000Z", provider: "CLAUDE", accountId: keyAccount, apiKeyId: gatewayKeyId,
  model: "claude-opus-5-5", reasoningEffort: null, serviceTier: null, transport: "http", status: "success", errorCode: null, latencyMs: 1000,
  firstTokenMs: 200, inputTokens: 1000, cachedInputTokens: 0, outputTokens: 100, reasoningTokens: null, costUsd: 10, compressionTokensSaved: null,
  stickyKind: null, stickyKeyHash: null, ...overrides
});

async function setup(fetchImpl: typeof fetch) {
  const repository = new InMemoryGatewayRepository();
  const credentials: StoredCredentials = { accessToken: plainClaudeKey, refreshToken: null, idToken: null, upstreamAccountId: null, accessExpiresAtMs: null };
  await repository.upsertAccount({ accountId: keyAccount, provider: "CLAUDE", label: "Claude API key …igAA", email: null, externalAccountId: "key:k", planType: "api",
    credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), keyAccount), credentialsExpiresAt: null, source: "API_KEY", sourceRef: null,
    lastRefreshAt: new Date(nowMs).toISOString() });
  const { keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: gatewayKeyId, name: "Claude API credits (CLIs)", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [keyAccount], compressionOverride: null,
    limits: [{ limitType: "COST_USD", limitWindow: "DAILY", maxValue: 200_000_000, modelFilter: null }], expiresAt: null, createdBy: null });
  // $10 on the API-key account (Opus 5.5) and $3 elsewhere, both settled as estimates.
  await repository.insertRequestLogs([log({}), log({ accountId: `gw_account:${"e".repeat(32)}`, model: "gpt-5.5", provider: "CODEX", costUsd: 3 })]);
  for (const costMicros of [10_000_000, 3_000_000]) {
    await repository.settleApiKeyUsage(gatewayKeyId, { inputTokens: 1, outputTokens: 1, costMicros, model: null, at: new Date(nowMs - 3_600_000).toISOString() });
  }
  const pool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: createClaudeRefresher(), now: () => nowMs });
  const sync = startAnthropicBillingSync({ repository, cipher: () => cipher, claudePool: pool, intervalMs: 3_600_000, fetchImpl, now: () => nowMs });
  const app = Fastify();
  registerAnthropicAdminRoutes(app, { repository, cipher: () => cipher, internalToken: token, sync: () => sync, fetchImpl, now: () => nowMs });
  const post = (path: string, payload: unknown = {}) =>
    app.inject({ method: "POST", url: `/__space-gateway/admin/anthropic-admin/${path}`, headers: { "x-space-internal-token": token }, payload: payload as object });
  return { repository, sync, post, close: () => { sync.stop(); return app.close(); } };
}

const costValue = async (repository: InMemoryGatewayRepository) => (await repository.listApiKeys())[0]!.limits[0]!.currentValue;

describe("Anthropic billing", () => {
  it("matches an Anthropic key only by a unique partial hint", () => {
    const keys = [{ id: "a", name: "A", partialKeyHint: "sk-ant-api03-R2D...igAA", workspaceId: "" }, { id: "b", name: "B", partialKeyHint: "sk-ant-api03-R2D...xxAA", workspaceId: "" }];
    expect(matchAnthropicKey(plainClaudeKey, keys)?.id).toBe("a");
    expect(matchAnthropicKey(plainClaudeKey, [...keys, { ...keys[0]!, id: "c" }])).toBeNull();
    expect(matchAnthropicKey(plainClaudeKey, [{ id: "d", name: "D", partialKeyHint: null, workspaceId: "" }])).toBeNull();
  });

  it("reads both reports across pages and keeps batch and non-token charges out of the factor", async () => {
    const { fetchImpl, calls } = anthropic({ costCents: "600" });
    const rows = await fetchAnthropicReports(adminKey, { fromDay: "2029-12-11", toDay: "2030-01-11" }, fetchImpl);
    expect(calls.filter((call) => call.startsWith("/v1/organizations/cost_report"))).toHaveLength(2);
    expect(rows.find((row) => row.item === "batch:uncached_input_tokens")?.value).toBe(50);
    const factors = anthropicModelFactors(rows, { fromDay: "2030-01-10", toDay: "2030-01-10" }, new Set(["wrkspc_space"]));
    expect(factors.get("claude-opus-5-5")).toMatchObject({ billedUsd: 7.2, listUsd: 6 });
    expect(factors.get("claude-opus-5-5")?.factor).toBeCloseTo(1.2, 6);
    expect(anthropicModelFactors(rows, { fromDay: "2030-01-10", toDay: "2030-01-10" }, new Set([""])).get("claude-opus-5-5")).toBeUndefined();
  });

  it("checks, seals and never returns the admin key; a sync makes the daily cap count the real charge", async () => {
    const { fetchImpl } = anthropic({ costCents: "600" });
    const { repository, post, close } = await setup(fetchImpl);
    expect(await costValue(repository)).toBe(13_000_000);
    expect((await post("save", { adminKey: "sk-ant-api03-not-admin" })).statusCode).toBe(422);
    const saved = await post("save", { adminKey });
    expect(saved.statusCode).toBe(200);
    expect(saved.body).not.toContain(adminKey);
    expect(saved.json()).toMatchObject({ configured: true, keyHint: "…aaaa", lastError: null,
      upstream: [{ accountId: keyAccount, apiKeyId: "apikey_gateway", keyName: "Space Gateway", workspaceId: "wrkspc_space" }] });
    const record = await repository.getAnthropicAdmin();
    expect(record?.keyEncrypted).not.toContain(adminKey);
    expect(cipher.decrypt(record!.keyEncrypted, ANTHROPIC_ADMIN_KEY_AAD)).toBe(adminKey);
    // $3 elsewhere stays an estimate; the $10 on the API-key account counts at Anthropic's factor 1.2.
    expect(await costValue(repository)).toBe(15_000_000);

    const report = await anthropicBillingReport(repository, 7, nowMs);
    expect(report.days[0]).toMatchObject({ day: "2030-01-10", reported: true, organizationUsd: 17.7, workspaceUsd: 7.7, gatewayEstimateUsd: 10 });
    expect(report.days[0]!.gatewayBilledUsd).toBeCloseTo(12, 6);
    expect(JSON.stringify(report)).not.toContain(adminKey);

    expect((await post("remove")).json()).toEqual({ removed: true });
    expect(await repository.getAnthropicAdmin()).toBeNull();
    await close();
  });

  it("counts today at the last 7 days' factor while Anthropic has not posted today, and marks today as not reported", async () => {
    const { fetchImpl } = anthropic({ costCents: "600", day: "2030-01-09" });
    const { repository, post, close } = await setup(fetchImpl);
    expect((await post("save", { adminKey })).statusCode).toBe(200);
    // Yesterday's factor 1.2 applies to today's $10 on the API-key account; the $3 elsewhere stays an estimate.
    expect(await costValue(repository)).toBe(15_000_000);
    const report = await anthropicBillingReport(repository, 2, nowMs);
    expect(report.days.map((day) => [day.day, day.reported])).toEqual([["2030-01-10", false], ["2030-01-09", true]]);
    expect(report.days[0]!.gatewayBilledUsd).toBeCloseTo(12, 6);
    expect(report.days[0]!.models[0]).toMatchObject({ model: "claude-opus-5-5", billedUsd: 0, listUsd: 0, gatewayEstimateUsd: 10 });
    await close();
  });

  it("refuses a key Anthropic rejects and records sync failures as codes only", async () => {
    const rejected = await setup(anthropic({ status: 401 }).fetchImpl);
    const answer = await rejected.post("save", { adminKey });
    expect(answer.statusCode).toBe(422);
    expect(answer.json().error.message).toBe("Anthropic rejected the key (HTTP 401).");
    expect(await rejected.repository.getAnthropicAdmin()).toBeNull();
    await rejected.close();

    const failing = await setup(anthropic({ status: 403 }).fetchImpl);
    await failing.repository.saveAnthropicAdminKey({ keyEncrypted: cipher.encrypt(adminKey, ANTHROPIC_ADMIN_KEY_AAD), keyHint: "…aaaa", at: new Date(nowMs).toISOString() });
    expect(await failing.sync.runOnce()).toEqual({ ok: false, error: "anthropic_http_403", limitsSet: 0 });
    expect((await failing.repository.getAnthropicAdmin())?.lastError).toBe("anthropic_http_403");
    expect(await costValue(failing.repository)).toBe(13_000_000);
    await failing.close();
  });

  it("does nothing without a saved key", async () => {
    const { sync, repository, close } = await setup(anthropic().fetchImpl);
    expect(await sync.runOnce()).toEqual({ ok: false, error: "not_configured", limitsSet: 0 });
    expect(await costValue(repository)).toBe(13_000_000);
    await close();
  });
});
