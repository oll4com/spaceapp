import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type CredentialRefresher, type StoredCredentials } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { compressBlock } from "../src/compression/engine.js";
import { createCompressors, tokenCounter } from "../src/compression/compressors.js";
import { registerClaudeProxyRoutes } from "../src/providers/claude/claude-proxy.js";
import { registerCodexModelRoutes } from "../src/providers/codex/models.js";
import { buildClaudeUpstreamHeaders } from "../src/providers/claude/headers.js";
import { ClaudeStreamInspector, claudeResponseUsage, readClaudeRateLimitHeaders } from "../src/providers/claude/stream.js";
import { claudeCostUsd } from "../src/pricing/pricing.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 5));
const nowMs = Date.parse("2030-01-10T00:00:00Z");
const accountA = `gw_account:${"a".repeat(32)}`;
const accountB = `gw_account:${"b".repeat(32)}`;

const sse = (...events: Record<string, unknown>[]) => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const messageStream = (id: string) => sse(
  { type: "message_start", message: { id, model: "claude-sonnet-4-5-20250929", usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
  { type: "message_stop" }
);

function streamResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 30)); controller.enqueue(bytes.slice(30)); controller.close(); } }),
    { status, headers: { "content-type": "text/event-stream", ...headers } });
}

async function setup(upstream: (token: string, body: Record<string, unknown>, url: string) => Response,
  compression?: { run: (text: string) => Promise<ReturnType<typeof compressBlock>>; record: (rows: never[]) => Promise<void> },
  refresher: CredentialRefresher = { needsRefresh: () => false, refresh: vi.fn() }) {
  const repository = new InMemoryGatewayRepository();
  for (const [accountId, name, used] of [[accountA, "claude-a", 10], [accountB, "claude-b", 50]] as const) {
    const credentials: StoredCredentials = { accessToken: `token-${name}`, refreshToken: "rt", idToken: null, upstreamAccountId: name, accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId, provider: "CLAUDE", label: name, email: null, externalAccountId: name, planType: "max5x",
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null,
      lastRefreshAt: new Date(nowMs).toISOString() });
    await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: used, resetAt: null, windowMinutes: 300 }]);
  }
  await repository.updateSettings({ routingStrategy: "USAGE_WEIGHTED" });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"c".repeat(32)}`, name: "Claude Code", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [],
    expiresAt: null, createdBy: null });
  const pool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher, now: () => nowMs });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const calls: { token: string; url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = (init.body ? JSON.parse(String(init.body)) : {}) as Record<string, unknown>;
    const token = headers.authorization!.replace("Bearer ", "");
    calls.push({ token, url, body, headers });
    return upstream(token, body, url);
  }) as unknown as typeof fetch;
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true, now: () => new Date(nowMs),
    routes: (app, helpers) => {
      const claude = registerClaudeProxyRoutes(app, helpers, { pool, logs, settings: () => repository.getSettings(), fetchImpl, now: () => nowMs,
        upstreamBaseUrl: "https://claude.test", settleKeyUsage: (keyId, usage) => repository.settleApiKeyUsage(keyId, usage), compression: compression as never });
      registerCodexModelRoutes(app, helpers, { pool, fetchImpl, anthropicModels: claude.models });
    } });
  const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}, url = "/v1/messages?beta=true") => server.app.inject({
    method: "POST", url, payload,
    headers: { "x-api-key": plainKey, "anthropic-version": "2023-06-01", "anthropic-beta": "claude-code-20250219", "user-agent": "claude-cli/2.1.206 (external, cli)", ...headers }
  });
  const get = (url: string, headers: Record<string, string> = {}) => server.app.inject({ method: "GET", url, headers: { "x-api-key": plainKey, ...headers } });
  return { repository, logs, calls, post, get };
}

describe("Claude stream inspection", () => {
  it("reports content start, usage and completion", () => {
    const inspector = new ClaudeStreamInspector();
    const bytes = new TextEncoder().encode(messageStream("msg_1"));
    const starts = [inspector.push(bytes.slice(0, 100)), inspector.push(bytes.slice(100))];
    expect(starts).toEqual([false, true]);
    expect(inspector).toMatchObject({ status: "success", model: "claude-sonnet-4-5-20250929", messageId: "msg_1",
      usage: { inputTokens: 10, cacheReadInputTokens: 1000, cacheCreationInputTokens: 200, outputTokens: 42 } });
  });

  it("reads the unified rate-limit headers", () => {
    const headers = new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.42", "anthropic-ratelimit-unified-5h-reset": "1894000000",
      "anthropic-ratelimit-unified-7d-utilization": "0.9", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "1894000000" });
    expect(readClaudeRateLimitHeaders(headers)).toMatchObject({ fiveHourUsedPercent: 42, weeklyUsedPercent: 90, rejected: true, resetAt: 1894000000,
      fiveHourResetAt: new Date(1894000000 * 1000).toISOString() });
  });

  it("swaps the credential and adds the OAuth beta to the client's betas", () => {
    const headers = buildClaudeUpstreamHeaders({ "x-api-key": "sk-sgw-x", authorization: "Bearer sk-sgw-x", "anthropic-beta": "claude-code-20250219",
      "x-app": "cli", host: "127.0.0.1:4920", "x-space-gateway-compression": "off" }, "oat-token");
    expect(headers).toEqual({ "anthropic-beta": "claude-code-20250219,oauth-2025-04-20", "anthropic-version": "2023-06-01", "x-app": "cli",
      authorization: "Bearer oat-token", accept: "application/json", "content-type": "application/json" });
  });

  it("prices Claude models with cache reads and writes, and leaves unknown models unpriced", () => {
    const usage = { inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(claudeCostUsd(usage, "claude-sonnet-4-5-20250929")).toBeCloseTo(3 + 0.3 + 3.75 + 15, 6);
    expect(claudeCostUsd(usage, "claude-opus-6")).toBeNull();
  });

  it("prices the Claude 5.x cards: cache reads per model, 1-hour writes, Haiku's long prompts and fast mode", () => {
    const million = { inputTokens: 1_000_000, cacheReadInputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(claudeCostUsd(million, "claude-opus-5-5")).toBeCloseTo(4 + 0.2 + 5 + 20, 6);
    expect(claudeCostUsd(million, "claude-sonnet-5-5")).toBeCloseTo(2 + 0.2 + 2.5 + 10, 6);
    expect(claudeCostUsd(million, "claude-fable-5-1")).toBeCloseTo(10 + 0.25 + 12.5 + 50, 6);
    expect(claudeCostUsd({ ...million, cacheCreation1hInputTokens: 400_000 }, "claude-opus-5-5")).toBeCloseTo(4 + 0.2 + 0.6 * 5 + 0.4 * 8 + 20, 6);
    expect(claudeCostUsd({ ...million, speed: "fast" }, "claude-opus-5-5")).toBeCloseTo(2 * (4 + 0.2 + 5 + 20), 6);
    expect(claudeCostUsd({ ...million, speed: "fast" }, "claude-opus-4-8")).toBeNull();
    const haiku = (inputTokens: number) => claudeCostUsd({ inputTokens, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 10_000 }, "claude-haiku-5-5");
    expect(haiku(50_000)).toBeCloseTo(0.005 + 0.005, 9);
    expect(haiku(200_000)).toBeCloseTo(0.1 + 0.025, 9);
    expect(claudeResponseUsage({ usage: { input_tokens: 5, cache_creation_input_tokens: 30, cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
      output_tokens: 2, speed: "fast" } })).toMatchObject({ cacheCreationInputTokens: 30, cacheCreation1hInputTokens: 20, speed: "fast" });
  });
});

describe("Claude proxy", () => {
  it("streams from the least-used account and logs cache-aware usage", async () => {
    const { post, calls, logs, repository } = await setup(() => streamResponse(messageStream("msg_1"), 200, {
      "anthropic-ratelimit-unified-5h-utilization": "0.2", "request-id": "req_up_1" }));
    const response = await post({ model: "claude-sonnet-4-5-20250929", stream: true, max_tokens: 100, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["request-id"]).toBe("req_up_1");
    expect(response.body).toContain("message_stop");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ token: "token-claude-a", url: "https://claude.test/v1/messages?beta=true" });
    expect(calls[0]!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
    expect(calls[0]!.headers["x-api-key"]).toBeUndefined();
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "CLAUDE", status: "success", accountId: accountA, model: "claude-sonnet-4-5-20250929",
      inputTokens: 1210, cachedInputTokens: 1000, outputTokens: 42 });
    expect(log!.costUsd).toBeCloseTo((10 * 3 + 1000 * 0.3 + 200 * 3.75 + 42 * 15) / 1e6, 10);
    const accounts = await repository.listAccounts();
    expect(accounts.find((account) => account.id === accountA)!.primaryWindow.usedPercent).toBe(20);
    // Claude Code stores the Anthropic request id; the token usage page uses it to tell gateway calls apart.
    expect(await repository.claudeLogKeys("2000-01-01T00:00:00.000Z", "2100-01-01T00:00:00.000Z")).toEqual([
      expect.objectContaining({ upstreamRequestId: "req_up_1", outputTokens: 42 })]);
  });

  it("moves to another account when the first one hits its subscription limit", async () => {
    const { post, calls, repository } = await setup((token) => token === "token-claude-a"
      ? new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Usage limit reached" } }), {
        status: 429, headers: { "content-type": "application/json", "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String(nowMs / 1000 + 3600) } })
      : streamResponse(messageStream("msg_2")));
    const response = await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(200);
    expect(calls.map((call) => call.token)).toEqual(["token-claude-a", "token-claude-b"]);
    const first = (await repository.listAccounts()).find((account) => account.id === accountA)!;
    expect(first.status).toBe("RATE_LIMITED");
    expect(first.blockedUntil).toBe(new Date(nowMs + 3_600_000).toISOString());
  });

  it("says when the first account is back once every pooled account is at its limit", async () => {
    // Seen live 2026-10-12: four Max accounts at 100% of the 5-hour window answered "Try again in 300s" for hours.
    const { post, calls, repository } = await setup(() => streamResponse(messageStream("never")));
    for (const [accountId, backInMinutes] of [[accountA, 40], [accountB, 140]] as const) {
      const resetAt = new Date(nowMs + backInMinutes * 60_000).toISOString();
      await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: 100, resetAt, windowMinutes: 300 }]);
      await repository.recordAccountState(accountId, { status: "RATE_LIMITED", statusReason: "rate limit", blockedUntil: resetAt });
    }
    const response = await post({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(429);
    expect(calls).toHaveLength(0);
    const { error } = response.json() as { error: { type: string; code: string; message: string } };
    expect(error).toMatchObject({ type: "rate_limit_error", code: "usage_limit_reached" });
    expect(error.message).toMatch(/^All 2 Claude accounts in Space Gateway reached their usage limit\. The first one is back in 40m \(at \d\d:\d\d\)\.$/);
  });

  it("formats the pool limit message for one account, hours and an unknown reset", async () => {
    const { claudePoolLimitMessage } = await import("../src/providers/claude/claude-proxy.js");
    const now = Date.parse("2026-10-12T15:10:00Z") / 1000;
    expect(claudePoolLimitMessage(4, now + 2 * 3600 + 20 * 60, now, "UTC"))
      .toBe("All 4 Claude accounts in Space Gateway reached their usage limit. The first one is back in 2h 20m (at 17:30).");
    expect(claudePoolLimitMessage(1, now + 3 * 3600, now, "Europe/Athens"))
      .toBe("The Claude account in Space Gateway reached its usage limit. It is back in 3h (at 21:10).");
    expect(claudePoolLimitMessage(3, null, now)).toBe("All 3 Claude accounts in Space Gateway reached their usage limit.");
  });

  it("returns a bare 429 without rate-limit headers to the client and blocks no account", async () => {
    // Anthropic's reply to a subscription-token request that does not come from Claude Code (seen live 2026-10-12).
    const { post, calls, repository } = await setup(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" } }),
      { status: 429, headers: { "content-type": "application/json" } }));
    const response = await post({ model: "claude-haiku-4-5", max_tokens: 8, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ type: "error", error: { type: "rate_limit_error", message: "Error" } });
    expect(calls).toHaveLength(1);
    expect((await repository.listAccounts()).filter((account) => account.provider === "CLAUDE").map((account) => account.status))
      .toEqual(["ACTIVE", "ACTIVE"]);
  });

  it("still treats a 429 with retry-after as a rate limit of the account", async () => {
    const { post, calls, repository } = await setup((token) => token === "token-claude-a"
      ? new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Error" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "40" } })
      : streamResponse(messageStream("msg_4")));
    const response = await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(200);
    expect(calls.map((call) => call.token)).toEqual(["token-claude-a", "token-claude-b"]);
    expect((await repository.listAccounts()).find((account) => account.id === accountA)!.status).toBe("RATE_LIMITED");
  });

  it("refreshes a rejected sign-in and retries the same account; a refused refresh takes the account out of rotation", async () => {
    const rejected = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "OAuth token has expired." } }), { status: 401 });
    const yesterday = new Date(nowMs - 86_400_000).toISOString();
    const renewing: CredentialRefresher = { needsRefresh: () => false, refresh: async (credentials) => ({ ...credentials, accessToken: "token-renewed" }) };
    const renewed = await setup((token) => token === "token-claude-a" ? rejected() : streamResponse(messageStream("msg_renewed")), undefined, renewing);
    await renewed.repository.withAccountCredentialLock(accountA, async () => ({ lastRefreshAt: yesterday }));
    expect((await renewed.post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] })).body).toContain("msg_renewed");
    expect(renewed.calls.map((call) => call.token)).toEqual(["token-claude-a", "token-renewed"]);

    const refusing: CredentialRefresher = { needsRefresh: () => false, refresh: async () => { throw Object.assign(new Error("invalid"), { code: "invalid_grant" }); } };
    const refused = await setup((token) => token === "token-claude-a" ? rejected() : streamResponse(messageStream("msg_b")), undefined, refusing);
    await refused.repository.withAccountCredentialLock(accountA, async () => ({ lastRefreshAt: yesterday }));
    const ask = () => refused.post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect((await ask()).body).toContain("msg_b");
    expect((await refused.repository.listAccounts()).find((account) => account.id === accountA)).toMatchObject({ status: "REAUTH_REQUIRED" });
    // The next request does not try the signed-out account at all.
    refused.calls.length = 0;
    expect((await ask()).body).toContain("msg_b");
    expect(refused.calls.map((call) => call.token)).toEqual(["token-claude-b"]);
  });

  it("moves on when the stream reports overload before any content", async () => {
    const overloaded = sse({ type: "message_start", message: { id: "m", model: "claude-sonnet-4-5", usage: { input_tokens: 1 } } },
      { type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
    const { post, calls } = await setup((token) => token === "token-claude-a" ? streamResponse(overloaded) : streamResponse(messageStream("msg_3")));
    const response = await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "hi" }] });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("overloaded_error");
    expect(calls).toHaveLength(2);
  });

  it("returns client errors as they are without trying other accounts", async () => {
    const { post, calls } = await setup(() => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: required" } }),
      { status: 400, headers: { "content-type": "application/json" } }));
    const response = await post({ model: "claude-sonnet-4-5", messages: [] });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: required" } });
    expect(calls).toHaveLength(1);
  });

  it("drops thinking disabled for the models that reject it and keeps it for the rest", async () => {
    const { post, calls } = await setup(() => streamResponse(messageStream("msg_ok")));
    for (const model of ["claude-sonnet-5-5", "claude-opus-5-5", "claude-fable-5-1", "claude-haiku-5-5"]) {
      expect((await post({ model, max_tokens: 10, thinking: { type: "disabled" }, messages: [{ role: "user", content: "hi" }] })).statusCode).toBe(200);
    }
    expect(calls.map((call) => call.body.thinking)).toEqual([undefined, undefined, undefined, { type: "disabled" }]);
  });

  it("retries an edited history once on the same account with the stale thinking blocks dropped", async () => {
    const bound = "messages.1.content.21: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, "
      + "or set `thinking.block_binding.prefix_mismatch_behavior` to \"drop_block\".";
    const refuse = (message: string) => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message } }),
      { status: 400, headers: { "content-type": "application/json" } });
    const { post, calls } = await setup((_token, body) => (body.thinking as { block_binding?: unknown } | undefined)?.block_binding ? streamResponse(messageStream("msg_ok")) : refuse(bound));
    const response = await post({ model: "claude-opus-5-5", stream: true, max_tokens: 10, thinking: { type: "adaptive" }, messages: [{ role: "user", content: "hi" }] });
    expect(response.body).toContain("msg_ok");
    expect(calls.map((call) => call.token)).toEqual(["token-claude-a", "token-claude-a"]);
    expect(calls[1]!.body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(calls[1]!.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20,thinking-binding-controls-2026-08-01");

    // Retried once only; thinking off, a client's own binding and a forged signature go back as they are.
    const always = await setup(() => refuse(bound));
    expect((await always.post({ model: "claude-opus-5-5", max_tokens: 10, messages: [] })).statusCode).toBe(400);
    expect(always.calls).toHaveLength(2);
    expect(always.calls[1]!.body.thinking).toEqual({ type: "adaptive", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    for (const [model, thinking] of [["claude-haiku-5-5", { type: "disabled" }], ["claude-opus-5-5", { type: "adaptive", block_binding: { prefix_mismatch_behavior: "error" } }]] as const) {
      const kept = await setup(() => refuse(bound));
      expect((await kept.post({ model, max_tokens: 10, thinking, messages: [] })).statusCode).toBe(400);
      expect(kept.calls).toHaveLength(1);
    }
    const forged = await setup(() => refuse("messages.1.content.0: Invalid `signature` in `thinking` block."));
    expect((await forged.post({ model: "claude-opus-5-5", max_tokens: 10, messages: [] })).statusCode).toBe(400);
    expect(forged.calls).toHaveLength(1);
  });

  it("keeps a session on the same account for the prompt cache", async () => {
    const { post, calls } = await setup(() => streamResponse(messageStream("msg")));
    const session = { "x-claude-code-session-id": "5f2c1f9e-7a1b-4c1d-9e2f-0a1b2c3d4e5f" };
    await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "one" }] }, session);
    await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: "two" }] }, session);
    expect(new Set(calls.map((call) => call.token)).size).toBe(1);
  });

  it("passes non-streamed replies through and answers token counts", async () => {
    const { post, calls } = await setup((_token, _body, url) => url.includes("count_tokens")
      ? new Response(JSON.stringify({ input_tokens: 12 }), { headers: { "content-type": "application/json" } })
      : new Response(JSON.stringify({ id: "msg_x", model: "claude-haiku-4-5", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 5, output_tokens: 1 } }),
        { headers: { "content-type": "application/json" } }));
    const reply = await post({ model: "claude-haiku-4-5", max_tokens: 5, messages: [{ role: "user", content: "hi" }] });
    expect(reply.json()).toMatchObject({ id: "msg_x", content: [{ text: "OK" }] });
    const count = await post({ model: "claude-haiku-4-5", messages: [{ role: "user", content: "hi" }] }, {}, "/v1/messages/count_tokens?beta=true");
    expect(count.json()).toEqual({ input_tokens: 12 });
    expect(calls[1]!.url).toBe("https://claude.test/v1/messages/count_tokens?beta=true");
  });

  it("lists Anthropic models for Anthropic clients on /v1/models", async () => {
    const { get, calls } = await setup(() => new Response(JSON.stringify({ data: [{ id: "claude-sonnet-4-5", type: "model" }] }),
      { headers: { "content-type": "application/json" } }));
    const response = await get("/v1/models?limit=100", { "anthropic-version": "2023-06-01" });
    expect(response.json()).toEqual({ data: [{ id: "claude-sonnet-4-5", type: "model" }] });
    expect(calls[0]!.url).toBe("https://claude.test/v1/models?limit=100");
  });

  it("adds the provider's output policy before the cached system block, mirrors it in token counts and logs it", async () => {
    const { post, calls, repository, logs } = await setup((_token, _body, url) => (url.includes("count_tokens")
      ? new Response(JSON.stringify({ input_tokens: 12 }), { headers: { "content-type": "application/json" } }) : streamResponse(messageStream("msg"))));
    await repository.updateSettings({ compressionProviders: { CLAUDE: { outputPolicy: "LEAN" } } });
    const system = [{ type: "text", text: "billing" }, { type: "text", text: "identity", cache_control: { type: "ephemeral" } },
      { type: "text", text: "instructions", cache_control: { type: "ephemeral" } }];
    const request = { model: "claude-sonnet-4-5", stream: true, max_tokens: 10, system, messages: [{ role: "user", content: "hi" }] };
    await post(request);
    await post(request);
    const texts = (call: (typeof calls)[number]) => (call.body.system as { text: string; cache_control?: unknown }[]);
    expect(texts(calls[0]!).map((block) => block.text.split("\n")[0])).toEqual(["billing", "identity", "[Space Gateway output policy v1: lean]", "instructions"]);
    expect(texts(calls[0]!)[2]!.cache_control).toBeUndefined();
    expect(JSON.stringify(calls[1]!.body.system)).toBe(JSON.stringify(calls[0]!.body.system));
    await post({ model: "claude-sonnet-4-5", system, messages: [{ role: "user", content: "hi" }] }, {}, "/v1/messages/count_tokens");
    expect(JSON.stringify(calls[2]!.body.system)).toBe(JSON.stringify(calls[0]!.body.system));
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log!.compressionDetail).toEqual({ strategies: [], waste: {}, outputPolicy: "LEAN" });
  });

  it("leaves the system prompt alone with the off header, for other clients and for the internal key", async () => {
    const { post, calls, repository } = await setup(() => streamResponse(messageStream("msg")));
    await repository.updateSettings({ compressionProviders: { CLAUDE: { outputPolicy: "LEAN" } } });
    const request = { model: "claude-sonnet-4-5", stream: true, max_tokens: 10, system: "You are helpful.", messages: [{ role: "user", content: "hi" }] };
    await post(request, { "x-space-gateway-output-policy": "off" });
    await post(request, { "user-agent": "Anthropic/JS 0.60.0" });
    const [stored] = await repository.listApiKeys();
    await repository.updateApiKey(stored!.id, { name: "space-gateway-internal" });
    await post(request);
    expect(calls.map((call) => call.body.system)).toEqual(["You are helpful.", "You are helpful.", "You are helpful."]);
  });

  it("follows the provider's compression mode over the global one", async () => {
    const compressors = createCompressors();
    const run = vi.fn(async (text: string) => compressBlock(text, compressors, tokenCounter));
    const { post, repository } = await setup(() => streamResponse(messageStream("msg")), { run, record: async () => undefined });
    await repository.updateSettings({ compressionMode: "ON", compressionProviders: { CLAUDE: { mode: "OFF" } } });
    const log = Array.from({ length: 300 }, (_, index) => `2026-10-11T10:00:${String(index % 60).padStart(2, "0")} INFO worker heartbeat ok`).join("\n");
    await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: log }] }] });
    expect(run).not.toHaveBeenCalled();
  });

  it("compresses tool results in every user message and sends the same bytes on the next turn", async () => {
    const compressors = createCompressors();
    const rows: unknown[] = [];
    const { post, calls, repository } = await setup(() => streamResponse(messageStream("msg")), {
      run: async (text) => compressBlock(text, compressors, tokenCounter),
      record: async (batch) => { rows.push(...batch); }
    });
    await repository.updateSettings({ compressionMode: "ON" });
    const log = Array.from({ length: 300 }, (_, index) => `2026-10-11T10:00:${String(index % 60).padStart(2, "0")} INFO worker heartbeat ok`).join("\n")
      + "\n2026-10-11T10:05:00 ERROR build failed: missing module\n";
    const earlier = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: log }] };
    const assistant = { role: "assistant", content: [{ type: "tool_use", id: "t2", name: "Bash", input: {} }] };
    const latest = { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: log }, { type: "text", text: "continue" }] };
    const session = { "x-claude-code-session-id": "11111111-2222-4333-8444-555555555555" };
    await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [earlier, assistant, latest] }, session);
    const sent = calls[0]!.body.messages as Array<{ content: Array<{ content?: string; text?: string }> }>;
    expect(sent[0]!.content[0]!.content!.length).toBeLessThan(log.length);
    expect(sent[2]!.content[0]!.content).toBe(sent[0]!.content[0]!.content);
    expect(sent[2]!.content[1]!.text).toBe("continue");
    expect(rows.length).toBeGreaterThan(0);
    // The next turn resends the original text; the gateway sends the same compressed bytes, so the prompt cache holds.
    await post({ model: "claude-sonnet-4-5", stream: true, max_tokens: 10, messages: [earlier, assistant, latest, { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: [{ type: "text", text: "next" }] }] }, session);
    const again = calls[1]!.body.messages as unknown[];
    expect(again.slice(0, 3)).toEqual(sent.slice(0, 3));
  });
});
