import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type CredentialRefresher, type StoredCredentials } from "../src/accounts/account-pool.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { compressBlock } from "../src/compression/engine.js";
import { applyRequestPolicy, PolicyRejection } from "../src/policy.js";
import { registerCodexProxyRoutes } from "../src/providers/codex/codex-proxy.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 9));
const nowMs = Date.parse("2030-01-10T00:00:00Z");
const accountA = `gw_account:${"a".repeat(32)}`;
const accountB = `gw_account:${"b".repeat(32)}`;

const sse = (...events: [string, Record<string, unknown>][]) => events.map(([type, body]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...body })}\n\n`).join("");
const completed = (id: string, extra: Record<string, unknown> = {}) => sse(
  ["response.created", { response: { id, model: "gpt-5.6-sol" } }],
  ["response.output_text.delta", { delta: "Hello" }],
  ["response.completed", { response: { id, model: "gpt-5.6-sol", output: [{ type: "message" }], usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 7 }, ...extra } }]
);

function streamResponse(body: string, status = 200, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(body);
  return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 20)); controller.enqueue(bytes.slice(20)); controller.close(); } }),
    { status, headers: { "content-type": "text/event-stream", ...headers } });
}

async function setup(upstream: (accountId: string | null, body: Record<string, unknown>) => Response, keyOverrides: Record<string, unknown> = {},
  compression?: { run: (text: string) => Promise<ReturnType<typeof compressBlock>>; record: (rows: never[]) => Promise<void> },
  modelPlans?: { eligible: (accounts: never[], model: string | null) => never[] }, speedDefaults?: Record<string, string>,
  refresher: CredentialRefresher = { needsRefresh: () => false, refresh: vi.fn() }) {
  const repository = new InMemoryGatewayRepository();
  for (const [accountId, external, used] of [[accountA, "chatgpt-a", 10], [accountB, "chatgpt-b", 50]] as const) {
    const credentials: StoredCredentials = { accessToken: `token-${external}`, refreshToken: "rt", idToken: null, upstreamAccountId: external, accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId, provider: "CODEX", label: external, email: null, externalAccountId: external, planType: "plus",
      credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null,
      lastRefreshAt: new Date(nowMs).toISOString() });
    await repository.saveUsageWindows(accountId, [{ window: "PRIMARY", usedPercent: used, resetAt: null, windowMinutes: 300 }]);
  }
  await repository.updateSettings({ planPriority: [], routingStrategy: "USAGE_WEIGHTED" });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"c".repeat(32)}`, name: "CLI", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [],
    expiresAt: null, createdBy: null, ...keyOverrides });
  const pool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher, now: () => nowMs });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const calls: { url: string; accountId: string | null; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    calls.push({ url, accountId: headers["chatgpt-account-id"] ?? null, body, headers });
    return upstream(headers["chatgpt-account-id"] ?? null, body);
  }) as unknown as typeof fetch;
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true, now: () => new Date(nowMs),
    routes: (app, helpers) => registerCodexProxyRoutes(app, helpers, { pool, logs, settings: () => repository.getSettings(), fetchImpl, now: () => nowMs,
      settleKeyUsage: (keyId, usage) => repository.settleApiKeyUsage(keyId, usage), compression: compression as never, modelPlans: modelPlans as never,
      ...(speedDefaults ? { speedDefaults: async () => speedDefaults } : {}) }) });
  const post = (payload: Record<string, unknown>, headers: Record<string, string> = {}) => server.app.inject({
    method: "POST", url: "/backend-api/codex/responses", headers: { authorization: `Bearer ${plainKey}`, "user-agent": "codex_cli_rs/0.150.1", ...headers }, payload
  });
  const postChat = (payload: Record<string, unknown>) => server.app.inject({
    method: "POST", url: "/v1/chat/completions", headers: { authorization: `Bearer ${plainKey}` }, payload
  });
  const postCompact = (payload: Record<string, unknown>, url = "/backend-api/codex/responses/compact") => server.app.inject({
    method: "POST", url, headers: { authorization: `Bearer ${plainKey}` }, payload
  });
  const postV1 = (payload: Record<string, unknown>) => server.app.inject({
    method: "POST", url: "/v1/responses", headers: { authorization: `Bearer ${plainKey}` }, payload
  });
  return { repository, pool, logs, calls, post, postChat, postCompact, postV1, server };
}

describe("Codex proxy", () => {
  it("streams a reply from the least-used account and logs usage", async () => {
    const { post, calls, logs, repository } = await setup(() => streamResponse(completed("resp_1"), 200, { "x-codex-primary-used-percent": "12" }));
    const response = await post({ model: "gpt-5.6-sol", stream: true, input: "hi", service_tier: "fast", reasoning: { effort: "ultra" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.body).toContain("response.completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ accountId: "chatgpt-a", body: { stream: true, service_tier: "priority", reasoning: { effort: "max" } } });
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer token-chatgpt-a", "user-agent": "codex_cli_rs/0.150.1" });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ status: "success", accountId: accountA, model: "gpt-5.6-sol", inputTokens: 100, cachedInputTokens: 40, outputTokens: 7,
      reasoningEffort: "ultra", serviceTier: "priority", firstTokenMs: 0 });
    // gpt-5.6-sol priority: 8 input, 0.8 cached, 40 output per 1M tokens.
    expect(log!.costUsd).toBeCloseTo((60 * 8 + 40 * 0.8 + 7 * 40) / 1e6, 10);
    expect((await repository.listAccounts()).find((account) => account.id === accountA)?.primaryWindow.usedPercent).toBe(12);
  });

  it("appends the provider's output policy to the instructions for Codex CLI, never for other clients", async () => {
    const { post, postV1, calls, repository, logs } = await setup(() => streamResponse(completed("resp_p")));
    await repository.updateSettings({ compressionProviders: { CODEX: { outputPolicy: "LEAN" } } });
    await post({ model: "gpt-5.6-sol", stream: true, input: "hi", instructions: "Base." });
    expect(String(calls[0]!.body.instructions)).toMatch(/^Base\.\n\n\[Space Gateway output policy v1: lean\]\n\nYou are a lazy senior developer\./);
    await post({ model: "gpt-5.6-sol", stream: true, input: "hi", instructions: "Base." }, { "x-space-gateway-output-policy": "off" });
    expect(calls[1]!.body.instructions).toBe("Base.");
    await postV1({ model: "gpt-5.6-sol", stream: true, input: "hi", instructions: "Base." });
    expect(calls[2]!.body.instructions).toBe("Base.");
    await logs.flush();
    const outcomes = (await repository.listRequestLogs({ limit: 5 })).map((log) => log.compressionDetail?.outputPolicy ?? null);
    expect(outcomes.sort()).toEqual(["LEAN", null, null].sort());
  });

  it("moves to another account when the first is out of quota before any output", async () => {
    const { post, calls, repository } = await setup((accountId) => accountId === "chatgpt-a"
      ? new Response(JSON.stringify({ error: { type: "usage_limit_reached", message: "You've hit your usage limit.", resets_in_seconds: 600 } }), { status: 429 })
      : streamResponse(completed("resp_2")));
    const response = await post({ model: "gpt-5.6-sol", stream: true, input: "hi" });
    expect(response.statusCode).toBe(200);
    expect(calls.map((call) => call.accountId)).toEqual(["chatgpt-a", "chatgpt-b"]);
    expect((await repository.listAccounts()).find((account) => account.id === accountA)).toMatchObject({ status: "RATE_LIMITED", blockedUntil: new Date(nowMs + 600_000).toISOString() });
  });

  it("moves on when the stream fails before output, but not after output", async () => {
    const early = await setup((accountId) => accountId === "chatgpt-a"
      ? streamResponse(sse(["response.created", { response: { id: "x" } }], ["response.failed", { response: { error: { code: "rate_limit_exceeded", message: "Try again in 20s" } } }]))
      : streamResponse(completed("resp_3")));
    expect((await early.post({ model: "m", stream: true, input: "hi" })).body).toContain("resp_3");
    expect(early.calls.map((call) => call.accountId)).toEqual(["chatgpt-a", "chatgpt-b"]);
    const late = await setup(() => streamResponse(sse(["response.output_text.delta", { delta: "partial" }], ["response.failed", { response: { error: { code: "server_error" } } }])));
    const response = await late.post({ model: "m", stream: true, input: "hi" });
    expect(response.body).toContain("partial");
    expect(late.calls).toHaveLength(1);
  });

  it("returns the final response as JSON to non-streaming clients", async () => {
    const { post, calls } = await setup(() => streamResponse(completed("resp_4")));
    const response = await post({ model: "gpt-5.6-sol", input: "hi" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: "resp_4", output: [{ type: "message" }] });
    expect(calls[0]!.body.stream).toBe(true);
  });

  it("takes OpenAI-style /v1/responses requests like codex-lb: string input, messages, store false", async () => {
    const { postV1: send, calls } = await setup(() => streamResponse(completed("resp_v1")));
    expect((await send({ model: "gpt-5.6-sol", input: "Reply with ok", store: true })).statusCode).toBe(200);
    expect(calls[0]!.body).toMatchObject({ instructions: "", store: false, input: [{ role: "user", content: [{ type: "input_text", text: "Reply with ok" }] }] });
    expect((await send({ model: "gpt-5.6-sol", instructions: "Be brief.", messages: [{ role: "system", content: "Answer in English." }, { role: "user", content: "hi" }] })).statusCode).toBe(200);
    expect(calls[1]!.body).toMatchObject({ instructions: "Be brief.\nAnswer in English.", store: false, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] });
    expect(calls[1]!.body.messages).toBeUndefined();
    const both = await send({ model: "gpt-5.6-sol", input: "a", messages: [{ role: "user", content: "b" }] });
    expect(both.statusCode).toBe(400);
    expect(both.json().error.message).toMatch(/either 'input' or 'messages'/);
    expect(calls).toHaveLength(2);
  });

  it("refreshes a rejected access token and retries the same account once, like codex-lb", async () => {
    const expired = () => new Response(JSON.stringify({ error: { code: "token_expired", message: "Your authentication token has expired. Please try refreshing it." } }), { status: 401 });
    const yesterday = new Date(nowMs - 86_400_000).toISOString();
    const renewing: CredentialRefresher = { needsRefresh: () => false, refresh: async (credentials) => ({ ...credentials, accessToken: "token-renewed" }) };
    let rejected = false;
    const renewed = await setup((accountId) => {
      if (accountId === "chatgpt-a" && !rejected) { rejected = true; return expired(); }
      return streamResponse(completed("resp_renewed"));
    }, {}, undefined, undefined, undefined, renewing);
    await renewed.repository.withAccountCredentialLock(accountA, async () => ({ lastRefreshAt: yesterday }));
    const response = await renewed.post({ model: "gpt-5.6-sol", stream: true, input: "hi" });
    expect(response.body).toContain("resp_renewed");
    expect(renewed.calls.map((call) => [call.accountId, call.headers.authorization])).toEqual([["chatgpt-a", "Bearer token-chatgpt-a"], ["chatgpt-a", "Bearer token-renewed"]]);
    expect((await renewed.repository.listAccounts()).find((account) => account.id === accountA)).toMatchObject({ status: "ACTIVE", lastRefreshAt: new Date(nowMs).toISOString() });

    // The refresh token is refused too: the account needs a re-login and the request moves on.
    const refusing: CredentialRefresher = { needsRefresh: () => false, refresh: async () => { throw Object.assign(new Error("reused"), { code: "refresh_token_reused" }); } };
    const refused = await setup((accountId) => accountId === "chatgpt-a" ? expired() : streamResponse(completed("resp_b")), {}, undefined, undefined, undefined, refusing);
    await refused.repository.withAccountCredentialLock(accountA, async () => ({ lastRefreshAt: yesterday, credentialsExpiresAt: "2030-01-20T00:00:00.000Z" }));
    expect((await refused.post({ model: "gpt-5.6-sol", stream: true, input: "hi" })).body).toContain("resp_b");
    expect(refused.calls.map((call) => call.accountId)).toEqual(["chatgpt-a", "chatgpt-b"]);
    expect((await refused.repository.listAccounts()).find((account) => account.id === accountA))
      .toMatchObject({ status: "REAUTH_REQUIRED", credentialsExpiresAt: new Date(nowMs).toISOString() });
  });

  it("keeps a continuation on the account that owns the previous response", async () => {
    const { post, calls, repository } = await setup((accountId) => streamResponse(completed(`resp_${accountId}`)));
    await post({ model: "m", stream: true, input: "first" });
    await repository.saveUsageWindows(accountA, [{ window: "PRIMARY", usedPercent: 90, resetAt: null, windowMinutes: 300 }]);
    await post({ model: "m", stream: true, input: "next", previous_response_id: "resp_chatgpt-a" });
    expect(calls.map((call) => call.accountId)).toEqual(["chatgpt-a", "chatgpt-a"]);
  });

  it("applies key policy and reports empty pools like codex-lb", async () => {
    const restricted = await setup(() => streamResponse(completed("r")), { allowedModels: ["gpt-5.5"], allowedReasoningEfforts: ["low"] });
    expect((await restricted.post({ model: "gpt-6", input: "hi" })).json()).toMatchObject({ error: { code: "model_not_allowed" } });
    expect((await restricted.post({ model: "gpt-5.5", input: "hi", reasoning: { effort: "high" } })).statusCode).toBe(403);
    const empty = await setup(() => streamResponse(completed("r")));
    await empty.repository.setAccountStatus(accountA, "PAUSED", null);
    await empty.repository.setAccountStatus(accountB, "PAUSED", null);
    empty.pool.invalidate();
    const response = await empty.post({ model: "m", input: "hi" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: { code: "no_accounts", message: "All accounts are paused" } });
  });

  it("passes request errors through unchanged, and logs the account that answered them", async () => {
    const { post, calls, logs, repository } = await setup(() => new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "Unknown parameter: foo" } }), { status: 400 }));
    const response = await post({ model: "m", input: "hi", foo: 1 });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { type: "invalid_request_error", message: "Unknown parameter: foo" } });
    expect(calls).toHaveLength(1);
    // 2026-10-27: such rows were logged with no account, so a week of upstream refusals read as "no account" failures.
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 1 });
    expect(log).toMatchObject({ status: "error", accountId: calls[0]!.accountId === "chatgpt-a" ? accountA : accountB });
  });

  it("serves a model the ChatGPT accounts retired on its current successor, after the key's allowlist checked the name asked", async () => {
    const { post, calls } = await setup(() => streamResponse(completed("resp_1")));
    expect((await post({ model: "gpt-5.5", input: "hi" })).statusCode).toBe(200);
    expect((await post({ model: "gpt-5.4-mini", input: "hi" })).statusCode).toBe(200);
    expect(calls.map((call) => call.body.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-luna"]);
    expect(applyRequestPolicy({ model: "gpt-5.5" }, { allowedModels: ["gpt-5.5"], enforcedModel: null } as never)).toMatchObject({ model: "gpt-5.6-sol", body: { model: "gpt-5.6-sol" } });
    expect(() => applyRequestPolicy({ model: "gpt-5.5" }, { allowedModels: ["gpt-5.6-sol"], enforcedModel: null } as never)).toThrow(PolicyRejection);
  });

  it("counts usage against key limits and rejects once a limit is used up", async () => {
    const { post, calls, repository } = await setup(() => streamResponse(completed("resp_limit")), {
      limits: [{ limitType: "TOTAL_TOKENS", limitWindow: "DAILY", maxValue: 150, modelFilter: null, resetAt: new Date(nowMs + 3_600_000).toISOString() }]
    });
    expect((await post({ model: "gpt-5.6-sol", stream: true, input: "one" })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect((await repository.listApiKeys())[0]!.limits[0]!.currentValue).toBe(107);
    expect((await post({ model: "gpt-5.6-sol", stream: true, input: "two" })).statusCode).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const blocked = await post({ model: "gpt-5.6-sol", stream: true, input: "three" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toMatchObject({ error: { code: "rate_limit_exceeded", message: "API key total_tokens daily limit exceeded" } });
    expect(calls).toHaveLength(2);
  });

  it("serves Chat Completions through the same account pool", async () => {
    const { postChat, calls, logs, repository } = await setup(() => streamResponse(completed("resp_chat")));
    const plain = await postChat({ model: "gpt-5.6-sol", messages: [{ role: "system", content: "Be brief." }, { role: "user", content: "hi" }] });
    expect(plain.statusCode).toBe(200);
    expect(plain.json()).toMatchObject({ object: "chat.completion", model: "gpt-5.6-sol", choices: [{ finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 7 } });
    expect(calls[0]!.body).toMatchObject({ instructions: "Be brief.", stream: true, store: false, input: [{ type: "message", role: "user" }] });
    const streamed = await postChat({ model: "gpt-5.6-sol", stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(streamed.headers["content-type"]).toContain("text/event-stream");
    expect(streamed.body).toContain("chat.completion.chunk");
    expect(streamed.body.trim().endsWith("data: [DONE]")).toBe(true);
    expect((await postChat({ model: "m", messages: [] })).statusCode).toBe(400);
    await logs.flush();
    expect((await repository.listRequestLogs({ limit: 5 })).filter((log) => log.status === "success")).toHaveLength(2);
  });

  it("compresses tool outputs when On, only measures them in Shadow, and skips them on request", async () => {
    const big = JSON.stringify(Array.from({ length: 80 }, (_, index) => ({ id: index, status: "ok", note: `row ${index}` })));
    const recorded: unknown[] = [];
    const compressors = { smartCrusher: (text: string) => JSON.stringify(JSON.parse(text).slice(0, 3)) };
    const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
    const compression = { run: async (text: string) => compressBlock(text, compressors, tokens), record: async (rows: unknown[]) => { recorded.push(...rows); } };
    const body = { model: "gpt-5.6-sol", stream: true, input: [{ type: "function_call_output", call_id: "c", output: big }] };
    const on = await setup(() => streamResponse(completed("r_on")), {}, compression);
    await on.repository.updateSettings({ compressionMode: "ON" });
    await on.post(body);
    expect(JSON.parse(String((on.calls[0]!.body.input as { output: string }[])[0]!.output))).toHaveLength(3);
    await on.logs.flush();
    expect((await on.repository.listRequestLogs({ limit: 1 }))[0]!.compressionTokensSaved).toBeGreaterThan(0);
    await on.post(body, { "x-space-gateway-compression": "off" });
    expect((on.calls[1]!.body.input as { output: string }[])[0]!.output).toBe(big);
    expect(recorded).toEqual(expect.arrayContaining([expect.objectContaining({ mode: "ON", strategy: "smart_crusher", blocks: 1 })]));
    // Off (there is no Shadow any more) sends the body unchanged and records nothing.
    const off = await setup(() => streamResponse(completed("r_off")), {}, compression);
    await off.repository.updateSettings({ compressionMode: "OFF" });
    recorded.length = 0;
    await off.post(body);
    expect((off.calls[0]!.body.input as { output: string }[])[0]!.output).toBe(big);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(recorded).toEqual([]);
  });

  it("compacts through the pool and moves on when an account is rate limited", async () => {
    const compacted = { object: "response.compaction", id: "cmp_1", model: "gpt-5.6-sol", output: [{ type: "compaction", encrypted_content: "x" }],
      usage: { input_tokens: 900, input_tokens_details: { cached_tokens: 100 }, output_tokens: 50 } };
    const { postCompact, calls, logs, repository } = await setup((accountId) => accountId === "chatgpt-a"
      ? new Response(JSON.stringify({ error: { code: "rate_limit_exceeded", message: "Slow down" } }), { status: 429 })
      : new Response(JSON.stringify(compacted), { headers: { "content-type": "application/json" } }));
    const response = await postCompact({ model: "gpt-5.6-sol", instructions: "Summarize", input: [], stream: true, reasoning: { effort: "ultra" } }, "/v1/responses/compact");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(compacted);
    expect(calls.map((call) => call.accountId)).toEqual(["chatgpt-a", "chatgpt-b"]);
    expect(calls[0]!.url).toMatch(/\/codex\/responses\/compact$/);
    expect(calls[0]!.body).not.toHaveProperty("stream");
    expect(calls[0]!.body.reasoning).toEqual({ effort: "max" });
    expect(calls[0]!.headers.accept).toBe("application/json");
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ status: "success", accountId: accountB, inputTokens: 900, cachedInputTokens: 100, outputTokens: 50 });
  });

  it("sends a model only to accounts whose plan offers it", async () => {
    // chatgpt-a is less used, but only chatgpt-b's plan offers the model.
    const plans = { eligible: (accounts: Array<{ externalAccountId: string | null }>, model: string | null) =>
      model === "gpt-5.3-codex-spark" ? accounts.filter((account) => account.externalAccountId === "chatgpt-b")
        : model === "gpt-nowhere" ? [] : accounts };
    const { post, calls } = await setup(() => streamResponse(completed("resp_plan")), {}, undefined, plans as never);
    expect((await post({ model: "gpt-5.3-codex-spark", stream: true, input: "hi" })).statusCode).toBe(200);
    expect(calls.map((call) => call.accountId)).toEqual(["chatgpt-b"]);
    const refused = await post({ model: "gpt-nowhere", stream: true, input: "hi" });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({ error: { code: "no_plan_support_for_model" } });
    expect(calls).toHaveLength(1);
  });

  it("gives a request without a speed its model's default speed", async () => {
    const { post, calls } = await setup(() => streamResponse(completed("resp_speed")), {}, undefined, undefined, { "gpt-6-astra": "fast" });
    await post({ model: "gpt-6-astra", stream: true, input: "hi" });
    await post({ model: "gpt-6-astra", stream: true, input: "hi", service_tier: "default" });
    await post({ model: "gpt-5.5", stream: true, input: "hi" });
    expect(calls.map((call) => call.body.service_tier ?? null)).toEqual(["priority", null, null]);
  });
});
