import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool } from "../src/accounts/account-pool.js";
import { apiKeyAccountActions, googleAiEntry, registerApiKeyAccountRoutes } from "../src/admin/api-key-accounts.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { googleRetrySeconds } from "../src/providers/google-ai/embeddings.js";
import { apiKeyRefresher, registerEmbeddingsRoute } from "../src/providers/openai-api/embeddings-proxy.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 6));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// Dummy keys of the Google AI shape; no real key is ever used here.
const googleA = `AIza${"A".repeat(35)}`;
const googleB = `AIza${"B".repeat(35)}`;
const openAiKey = `sk-proj-${"o".repeat(40)}`;
const vector = (seed: number, size = 1536) => Array.from({ length: size }, (_, index) => ((index % 7) + seed) / 10);

type Call = { url: string; googleKey: string | null; bearer: string | null; body: Record<string, unknown> | null };

async function setup(google: (key: string, url: string, body: Record<string, unknown> | null) => Response) {
  const repository = new InMemoryGatewayRepository();
  const googlePool = new AccountPool({ provider: "GOOGLE_AI", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const openAiPool = new AccountPool({ provider: "OPENAI_API", repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const calls: Call[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = { url, googleKey: headers["x-goog-api-key"] ?? null, bearer: headers.authorization?.replace("Bearer ", "") ?? null,
      body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null };
    calls.push(call);
    if (url.startsWith("https://api.openai.com")) return url.endsWith("/models") ? json({ data: [] }) : json({ data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 3 } });
    return google(call.googleKey ?? "", url, call.body);
  }) as unknown as typeof fetch;
  const admin = Fastify();
  registerApiKeyAccountRoutes(admin, { repository, pools: { GOOGLE_AI: googlePool, OPENAI_API: openAiPool }, cipher: () => cipher, internalToken: "internal", fetchImpl });
  const add = (provider: string, apiKey: string) => admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/add", remoteAddress: "127.0.0.1",
    headers: { "x-space-internal-token": "internal" }, payload: { provider, apiKey, sourceRef: provider === "GOOGLE_AI" ? "space-google-voice" : undefined } });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"9".repeat(32)}`, name: "space-gateway-internal", keyHash, keyPrefix, trafficClass: "BACKGROUND", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    routes: (app, helpers) => registerEmbeddingsRoute(app, helpers, { pool: openAiPool, googlePool, logs, settings: () => repository.getSettings(), fetchImpl }) });
  const embed = (payload: Record<string, unknown>) => server.app.inject({ method: "POST", url: "/v1/embeddings", headers: { authorization: `Bearer ${plainKey}` }, payload });
  return { repository, googlePool, calls, add, embed, logs };
}

const batch = (body: Record<string, unknown> | null, dims = 1536) =>
  json({ embeddings: (body?.requests as unknown[]).map((_, index) => ({ values: vector(index + 1, dims) })) });

describe("Google AI keys and Gemini embeddings", () => {
  it("adds a Google AI key after a free model listing, sealed and never echoed or put in a URL", async () => {
    const { repository, add, calls } = await setup((key, url) => (url.includes("/models?pageSize=1") && key === googleA ? json({ models: [] }) : json({ error: { code: 400, message: "API key not valid." } }, 400)));
    expect((await add("GOOGLE_AI", "AIza-too-short")).json()).toMatchObject({ error: { code: "invalid_api_key" } });
    expect((await add("GOOGLE_AI", googleB)).json()).toMatchObject({ error: { code: "api_key_rejected" } });
    const added = await add("GOOGLE_AI", googleA);
    expect(added.json()).toMatchObject({ status: "CONNECTED", account: { provider: "GOOGLE_AI", label: "Google AI API key …AAAA", planType: "api" } });
    expect(added.body).not.toContain(googleA);
    expect(calls.at(-1)).toMatchObject({ url: "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", googleKey: googleA });
    expect(calls.every((call) => !call.url.includes(googleA) && !call.url.includes("key="))).toBe(true);
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ source: "API_KEY", sourceRef: "space-google-voice" });
    expect(account!.credentialsEncrypted).not.toContain("AIza");
  });

  it("answers gemini-embedding-001 in the OpenAI shape from batchEmbedContents, 1536 normalized dimensions, with the task type", async () => {
    const { add, embed, calls, logs, repository, googlePool } = await setup((_key, url, body) => (url.endsWith("/models?pageSize=1") ? json({}) : batch(body)));
    await add("GOOGLE_AI", googleA);
    const response = await embed({ model: "gemini-embedding-001", input: ["Μνήμη για το Space", "memory"], dimensions: 1536, task_type: "RETRIEVAL_QUERY" });
    expect(response.statusCode).toBe(200);
    const payload = response.json() as { object: string; model: string; data: { index: number; embedding: number[] }[] };
    expect(payload).toMatchObject({ object: "list", model: "gemini-embedding-001", data: [{ object: "embedding", index: 0 }, { object: "embedding", index: 1 }] });
    for (const { embedding } of payload.data) {
      expect(embedding).toHaveLength(1536);
      expect(Math.sqrt(embedding.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1, 9);
    }
    const sent = calls.find((call) => call.url.endsWith(":batchEmbedContents"))!;
    expect(sent.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents");
    expect(sent.googleKey).toBe(googleA);
    expect(sent.body).toEqual({ requests: [
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "Μνήμη για το Space" }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: 1536 },
      { model: "models/gemini-embedding-001", content: { parts: [{ text: "memory" }] }, taskType: "RETRIEVAL_QUERY", outputDimensionality: 1536 }] });
    await logs.flush();
    const [log] = await repository.listRequestLogs({ limit: 5 });
    expect(log).toMatchObject({ provider: "GOOGLE_AI", model: "gemini-embedding-001", status: "success" });
    expect((await embed({ model: "gemini-embedding-001", input: ["x"], task_type: "WHATEVER" })).statusCode).toBe(400);
    expect((await embed({ model: "gemini-embedding-001", input: [], dimensions: 1536 })).statusCode).toBe(400);
    expect((await embed({ model: "gemini-embedding-001", input: "x", dimensions: 4096 })).statusCode).toBe(400);
    const [account] = await repository.listAccounts();
    expect(await apiKeyAccountActions({ entry: googleAiEntry, pool: googlePool, fetchImpl: (async () => json({ models: [] })) as unknown as typeof fetch }).test(account!, {}))
      .toMatchObject({ ok: true, status: 200 });
  });

  it("takes an empty prepay key out of rotation, backs off a rate-limited one, and moves to the next key", async () => {
    const { add, embed, repository, calls } = await setup((key, url, body) => {
      if (url.endsWith("/models?pageSize=1")) return json({});
      if (key === googleA) return json({ error: { code: 402, message: "Your prepayment credits are depleted.", status: "RESOURCE_EXHAUSTED" } }, 402);
      return batch(body);
    });
    await add("GOOGLE_AI", googleA);
    await add("GOOGLE_AI", googleB);
    for (let index = 0; index < 2; index += 1) expect((await embed({ model: "gemini-embedding-001", input: "x", dimensions: 1536 })).statusCode).toBe(200);
    const accounts = await repository.listAccounts();
    expect(accounts.find((account) => account.label.endsWith("AAAA"))).toMatchObject({ status: "QUOTA_EXCEEDED", statusReason: "Your prepayment credits are depleted." });
    expect(calls.filter((call) => call.url.endsWith(":batchEmbedContents") && call.googleKey === googleA)).toHaveLength(1);

    const limited = await setup((key, url) => (url.endsWith("/models?pageSize=1") ? json({}) : json({ error: { code: 429, message: "Quota exceeded per minute.", status: "RESOURCE_EXHAUSTED" } }, 429)));
    await limited.add("GOOGLE_AI", googleA);
    const response = await limited.embed({ model: "gemini-embedding-001", input: "x" });
    expect(response.statusCode).toBe(429);
    expect((await limited.repository.listAccounts())[0]).toMatchObject({ status: "RATE_LIMITED" });
  });

  it("waits out a free-tier limit: the RetryInfo delay per minute, the next midnight Pacific per day", () => {
    const perMinute = JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED", details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [{ quotaId: "EmbedContentRequestsPerMinutePerProjectPerModel-FreeTier" }] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "34s" }] } });
    expect(googleRetrySeconds(perMinute)).toBe(34);
    const perDay = JSON.stringify({ error: { code: 429, details: [{ violations: [{ quotaId: "EmbedContentRequestsPerDayPerProjectPerModel-FreeTier" }] },
      { retryDelay: "20s" }] } });
    // 2030-01-10 20:00 UTC is 12:00 in Los Angeles: twelve hours (and a minute) to the reset.
    expect(googleRetrySeconds(perDay, Date.parse("2030-01-10T20:00:00Z"))).toBe(12 * 3600 + 60);
    expect(googleRetrySeconds("not json")).toBeNull();
    expect(googleRetrySeconds(JSON.stringify({ error: { code: 429 } }))).toBeNull();
  });

  it("keeps OpenAI models on the OpenAI keys without the task type, and needs a Google key for Gemini", async () => {
    const { add, embed, calls } = await setup(() => json({}, 500));
    await add("OPENAI_API", openAiKey);
    expect((await embed({ model: "text-embedding-3-small", input: "x", dimensions: 1536, task_type: "RETRIEVAL_DOCUMENT" })).statusCode).toBe(200);
    expect(calls.find((call) => call.url === "https://api.openai.com/v1/embeddings")!.body).toEqual({ model: "text-embedding-3-small", input: "x", dimensions: 1536 });
    const gemini = await embed({ model: "gemini-embedding-001", input: "x" });
    expect(gemini.statusCode).toBe(503);
    expect(calls.some((call) => call.url.includes("generativelanguage"))).toBe(false);
  });
});
