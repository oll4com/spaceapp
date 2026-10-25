import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { registerApiKeyAccountRoutes } from "../src/admin/api-key-accounts.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { lanPathAllowed } from "../src/lan-access.js";
import { apiKeyRefresher } from "../src/providers/openai-api/embeddings-proxy.js";
import { readPoolUsage, registerKeyPoolRoutes } from "../src/providers/key-pools/key-pools.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keyA = `sk-or-v1-${"a".repeat(64)}`;
const keyB = `sk-or-v1-${"b".repeat(64)}`;
const completion = (text: string) => ({ id: "gen-1", object: "chat.completion", model: "qwen/qwen3-coder",
  choices: [{ index: 0, message: { role: "assistant", content: text } }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.000123 } });

async function setup(upstream: (apiKey: string, url: string, body: unknown) => Response) {
  const repository = new InMemoryGatewayRepository();
  const pool = new AccountPool({ provider: "OPENROUTER", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const calls: { apiKey: string; url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const apiKey = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace("Bearer ", "");
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ apiKey, url, body });
    return upstream(apiKey, url, body);
  }) as unknown as typeof fetch;
  const admin = Fastify();
  registerApiKeyAccountRoutes(admin, { repository, pools: { OPENROUTER: pool }, cipher: () => cipher, internalToken: "internal", fetchImpl });
  const add = (apiKey: string, provider = "OPENROUTER") => admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/add", remoteAddress: "127.0.0.1",
    headers: { "x-space-internal-token": "internal" }, payload: { provider, apiKey } });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"f".repeat(32)}`, name: "Qwen Code", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerKeyPoolRoutes(app, helpers, { pools: { openrouter: pool }, logs, settings: () => repository.getSettings(), fetchImpl,
      settleKeyUsage: (keyId, usage) => repository.settleApiKeyUsage(keyId, usage) }) });
  const chat = (payload: Record<string, unknown>, provider = "openrouter") => server.app.inject({ method: "POST", url: `/pools/${provider}/v1/chat/completions`,
    headers: { authorization: `Bearer ${plainKey}` }, payload });
  const models = () => server.app.inject({ method: "GET", url: "/pools/openrouter/v1/models", headers: { authorization: `Bearer ${plainKey}` } });
  return { repository, pool, calls, add, chat, models, logs };
}

describe("API-key pools", () => {
  it("adds OpenRouter keys checked against the provider and refuses keys of the wrong shape or provider", async () => {
    const { add, repository, calls } = await setup((apiKey, url) => (url.endsWith("/key") && apiKey === keyA ? json({ data: { label: "x" } }) : json({ error: {} }, 401)));
    expect((await add(keyA)).json()).toMatchObject({ status: "CONNECTED", account: { label: `OpenRouter API key …${keyA.slice(-4)}` } });
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/key");
    expect((await add(keyB)).json().error.code).toBe("api_key_rejected");
    expect((await add("sk-proj-not-openrouter")).json().error.code).toBe("invalid_api_key");
    expect((await add(keyA, "GOOGLE_AI")).statusCode).toBe(422);
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ provider: "OPENROUTER", source: "API_KEY" });
    expect(JSON.stringify(account)).not.toContain(keyA);
  });

  it("passes a chat request through to a pooled key and moves on from a key without credit", async () => {
    const { add, chat, calls, logs, repository } = await setup((apiKey, url) => {
      if (url.endsWith("/key")) return json({ data: {} });
      return apiKey === keyA ? json({ error: { message: "Insufficient credits", code: 402 } }, 402) : json(completion("hello"));
    });
    await add(keyA);
    await add(keyB);
    const responses = [];
    for (let index = 0; index < 3; index += 1) {
      responses.push(await chat({ model: "qwen/qwen3-coder", messages: [{ role: "user", content: "hi" }], temperature: 0.2 }));
    }
    expect(responses.map((response) => response.statusCode)).toEqual([200, 200, 200]);
    expect(responses[0]!.json().choices[0].message.content).toBe("hello");
    const sent = calls.filter((call) => call.url.endsWith("/chat/completions"));
    // Round robin reaches the key without credit once; from then on it stays out of rotation.
    expect(sent.filter((call) => call.apiKey === keyA)).toHaveLength(1);
    expect(sent.at(-1)!.apiKey).toBe(keyB);
    expect(sent[0]!.body).toMatchObject({ model: "qwen/qwen3-coder", temperature: 0.2 });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "OPENROUTER", status: "success", model: "qwen/qwen3-coder", inputTokens: 12, outputTokens: 3, cachedInputTokens: 4,
      costUsd: 0.000123 });
  });

  it("takes a rejected key out of rotation until it is added again", async () => {
    let revoked = true;
    const { add, chat, calls, repository } = await setup((apiKey, url) => {
      if (url.endsWith("/key")) return json({ data: {} });
      return apiKey === keyA && revoked ? json({ error: { message: "User not found.", code: 401 } }, 401) : json(completion("hello"));
    });
    await add(keyA);
    await add(keyB);
    for (let index = 0; index < 3; index += 1) {
      expect((await chat({ model: "qwen/qwen3-coder", messages: [{ role: "user", content: "hi" }] })).statusCode).toBe(200);
    }
    const sent = () => calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => call.apiKey);
    expect(sent().filter((apiKey) => apiKey === keyA)).toHaveLength(1);
    const stored = (await repository.listAccounts()).find((account) => account.label.endsWith(keyA.slice(-4)))!;
    expect(stored.status).toBe("REAUTH_REQUIRED");
    // Adding the key again (a new key, or the provider accepts it again) brings it back.
    revoked = false;
    await add(keyA);
    calls.length = 0;
    for (let index = 0; index < 2; index += 1) await chat({ model: "qwen/qwen3-coder", messages: [{ role: "user", content: "hi" }] });
    expect(sent()).toContain(keyA);
  });

  it("streams through, logs the usage of the last event, and serves the provider's model list", async () => {
    const stream = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"y"}}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    const { add, chat, models, logs, repository } = await setup((_apiKey, url) => {
      if (url.endsWith("/key")) return json({ data: {} });
      if (url.endsWith("/models")) return json({ data: [{ id: "qwen/qwen3-coder" }] });
      return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    await add(keyA);
    const response = await chat({ model: "qwen/qwen3-coder", messages: [], stream: true, stream_options: { include_usage: true } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(stream);
    await logs.flush();
    // A provider that reports no cost leaves it unknown rather than zero.
    expect((await repository.listRequestLogs({ limit: 5 }))[0]).toMatchObject({ status: "success", inputTokens: 5, outputTokens: 2, costUsd: null });
    expect((await models()).json()).toEqual({ data: [{ id: "qwen/qwen3-coder" }] });
  });

  it("answers an unknown pool with 404, an empty pool with no accounts, and opens the pools to the LAN", async () => {
    const { chat } = await setup(() => json({}));
    expect((await chat({ model: "x", messages: [] }, "anthropic")).statusCode).toBe(404);
    expect((await chat({ model: "x", messages: [] })).statusCode).toBe(503);
    expect(lanPathAllowed("/pools/openrouter/v1/chat/completions")).toBe(true);
    expect(readPoolUsage({ response: { usage: { input_tokens: 9, output_tokens: 1 } } })).toEqual({ inputTokens: 9, outputTokens: 1, cachedInputTokens: null, costUsd: null });
    expect(readPoolUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: Number.NaN } })?.costUsd).toBeNull();
  });
});
