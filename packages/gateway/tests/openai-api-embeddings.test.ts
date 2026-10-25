import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { openAiApiAccountActions, registerApiKeyAccountRoutes } from "../src/admin/api-key-accounts.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { apiKeyRefresher, registerEmbeddingsRoute } from "../src/providers/openai-api/embeddings-proxy.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 8));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keyA = `sk-proj-${"a".repeat(40)}`;
const keyB = `sk-proj-${"b".repeat(40)}`;

async function setup(upstream: (apiKey: string, url: string) => Response) {
  const repository = new InMemoryGatewayRepository();
  const pool = new AccountPool({ provider: "OPENAI_API", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const calls: { apiKey: string; url: string; body: unknown }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const apiKey = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace("Bearer ", "");
    calls.push({ apiKey, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    return upstream(apiKey, url);
  }) as unknown as typeof fetch;
  const admin = Fastify();
  registerApiKeyAccountRoutes(admin, { repository, pools: { OPENAI_API: pool }, cipher: () => cipher, internalToken: "internal", fetchImpl });
  const add = (apiKey: string, extra: Record<string, unknown> = {}) => admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/add", remoteAddress: "127.0.0.1",
    headers: { "x-space-internal-token": "internal" }, payload: { provider: "OPENAI_API", apiKey, ...extra } });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"e".repeat(32)}`, name: "Memory", keyHash, keyPrefix, trafficClass: "BACKGROUND", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerEmbeddingsRoute(app, helpers, { pool, logs, settings: () => repository.getSettings(), fetchImpl,
      settleKeyUsage: (keyId, usage) => repository.settleApiKeyUsage(keyId, usage) }) });
  const embed = (payload: Record<string, unknown>) => server.app.inject({ method: "POST", url: "/v1/embeddings", headers: { authorization: `Bearer ${plainKey}` }, payload });
  return { repository, pool, calls, add, embed, logs };
}

describe("OpenAI API keys and embeddings", () => {
  it("adds a key after a free check, stores it encrypted and never echoes it", async () => {
    const { repository, add, calls } = await setup((apiKey) => (apiKey === keyA ? json({ data: [] }) : json({ error: { message: "bad" } }, 401)));
    expect((await add("not-a-key")).statusCode).toBe(422);
    const rejected = await add(keyB);
    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ error: { code: "api_key_rejected" } });
    const added = await add(keyA, { sourceRef: "space-openai-voice" });
    expect(added.json()).toMatchObject({ status: "CONNECTED", account: { provider: "OPENAI_API", label: "OpenAI API key …aaaa", planType: "api" } });
    expect(added.body).not.toContain(keyA);
    expect(calls.at(-1)).toMatchObject({ url: "https://api.openai.com/v1/models" });
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ source: "API_KEY", sourceRef: "space-openai-voice" });
    expect(account!.credentialsEncrypted).not.toContain("sk-proj");
    await add(keyA);
    expect(await repository.listAccounts()).toHaveLength(1);
  });

  it("serves embeddings from the pooled keys and moves to another key on rate limits", async () => {
    let embeddingRequests = 0;
    const { add, embed, calls, logs, repository, pool } = await setup((_apiKey, url) => {
      if (url.endsWith("/models")) return json({ data: [] });
      // The first key asked is rate limited; the request moves to the other key.
      if ((embeddingRequests += 1) === 1) return json({ error: { message: "slow down" } }, 429);
      return json({ object: "list", data: [{ embedding: [0.1, 0.2] }], model: "text-embedding-3-small", usage: { prompt_tokens: 1000, total_tokens: 1000 } });
    });
    await add(keyA);
    await add(keyB);
    const response = await embed({ model: "text-embedding-3-small", input: ["hello"] });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ data: [{ embedding: [0.1, 0.2] }] });
    const embeddingCalls = calls.filter((call) => call.url.endsWith("/embeddings"));
    expect(embeddingCalls.map((call) => call.apiKey).sort()).toEqual([keyA, keyB].sort());
    expect(embeddingCalls[0]!.body).toEqual({ model: "text-embedding-3-small", input: ["hello"] });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "OPENAI_API", model: "text-embedding-3-small", status: "success", inputTokens: 1000 });
    expect(log!.costUsd).toBeCloseTo(0.00002, 10);
    expect((await embed({ input: ["x"] })).statusCode).toBe(400);
    const [account] = await repository.listAccounts();
    expect(await openAiApiAccountActions({ pool, fetchImpl: (async () => json({ data: [] })) as unknown as typeof fetch }).test(account!, {})).toMatchObject({ ok: true, status: 200 });
  });

  it("takes a key without credit out of rotation as quota exceeded", async () => {
    const { add, embed, repository } = await setup((_apiKey, url) => url.endsWith("/models") ? json({ data: [] })
      : json({ error: { message: "You have no credits remaining.", type: "insufficient_quota", code: "credit_balance_exhausted" } }, 429));
    await add(keyA);
    const response = await embed({ model: "text-embedding-3-small", input: ["x"] });
    expect(response.statusCode).toBe(429);
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ status: "QUOTA_EXCEEDED", statusReason: "You have no credits remaining." });
  });
});
