import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { GATEWAY_KEYLESS_KEY } from "@space/contracts";
import { AccountPool } from "../src/accounts/account-pool.js";
import { FREE_POOL_KEY_PROVIDERS, NOUS_FREE_POOL_KEY_EXCLUDED, registerApiKeyAccountRoutes } from "../src/admin/api-key-accounts.js";
import { generateGatewayApiKey } from "../src/api-keys.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { lanPathAllowed } from "../src/lan-access.js";
import { apiKeyRefresher } from "../src/providers/openai-api/embeddings-proxy.js";
import { azureKeyFrom, checkPoolKey, keyPoolProviders, poolCooldownSeconds, readPoolUsage, registerKeyPoolRoutes, type KeyPoolSlug } from "../src/providers/key-pools/key-pools.js";
import { bedrockKeyFrom, CLOUD_CLAUDE_MODELS, vertexKeyFrom, vertexMessages } from "../src/providers/key-pools/cloud-claude.js";
import { ModelChecks } from "../src/providers/key-pools/model-checks.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const keyA = `sk-or-v1-${"a".repeat(64)}`;
const keyB = `sk-or-v1-${"b".repeat(64)}`;
const completion = (text: string) => ({ id: "gen-1", object: "chat.completion", model: "qwen/qwen3-coder",
  choices: [{ index: 0, message: { role: "assistant", content: text } }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 }, cost: 0.000123 } });

async function setup(upstream: (apiKey: string, url: string, body: unknown) => Response, slug: KeyPoolSlug = "openrouter", checks?: ModelChecks, now?: () => number,
  extra: Pick<Parameters<typeof registerKeyPoolRoutes>[2], "grants" | "creditSpent"> = {}) {
  const repository = new InMemoryGatewayRepository();
  const provider = keyPoolProviders[slug].provider;
  const pool = new AccountPool({ provider, repository, cipher: () => cipher, refresher: apiKeyRefresher });
  const calls: { apiKey: string; url: string; body: unknown; headers: Headers }[] = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    const apiKey = String((init?.headers as Record<string, string> | undefined)?.authorization ?? "").replace("Bearer ", "");
    // Google's token exchange posts a form, not JSON.
    let body: unknown;
    try { body = init?.body ? JSON.parse(String(init.body)) : null; } catch { body = String(init!.body); }
    calls.push({ apiKey, url, body, headers: new Headers(init?.headers) });
    return upstream(apiKey, url, body);
  }) as unknown as typeof fetch;
  const admin = Fastify();
  registerApiKeyAccountRoutes(admin, { repository, pools: { [provider]: pool }, cipher: () => cipher, internalToken: "internal", fetchImpl });
  const add = (apiKey: string, as: string = provider) => admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/add", remoteAddress: "127.0.0.1",
    headers: { "x-space-internal-token": "internal" }, payload: { provider: as, apiKey } });
  const { plainKey, keyHash, keyPrefix } = generateGatewayApiKey();
  await repository.createApiKey({ keyId: `gw_key:${"f".repeat(32)}`, name: "Qwen Code", keyHash, keyPrefix, trafficClass: "INTERACTIVE", allowedModels: [],
    enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [], compressionOverride: null, limits: [], expiresAt: null, createdBy: null });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const apiLog: Array<{ reqId: string; event: string }> = [];
  const server = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    requestLog: (record) => apiLog.push(record),
    routes: (app, helpers) => registerKeyPoolRoutes(app, helpers, { pools: { [slug]: pool }, logs, settings: () => repository.getSettings(), fetchImpl,
      settleKeyUsage: (keyId, usage) => repository.settleApiKeyUsage(keyId, usage), checks, internalToken: "internal", now, ...extra }) });
  const chat = (payload: Record<string, unknown>, pathSlug: string = slug, headers: Record<string, string> = {}) => server.app.inject({ method: "POST", url: `/pools/${pathSlug}/v1/chat/completions`,
    headers: { authorization: `Bearer ${plainKey}`, ...headers }, payload });
  const models = () => server.app.inject({ method: "GET", url: `/pools/${slug}/v1/models`, headers: { authorization: `Bearer ${plainKey}` } });
  const post = (path: string, payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    server.app.inject({ method: "POST", url: `/pools/${slug}/v1/${path}`, headers: { authorization: `Bearer ${plainKey}`, ...headers }, payload });
  return { repository, pool, calls, add, chat, models, post, logs, apiLog, server, admin };
}

describe("API-key pools", () => {
  it("sends AgentRouter the calling client's own User-Agent and no other pool, and lists only Free.ai's chat models (7/11)", async () => {
    // AgentRouter serves only CLIs it knows: another client gets a 401 "unauthorized client detected" that is no fault of the key.
    const relay = await setup(() => json(completion("OK")), "agentrouter");
    try {
      await relay.add(`sk-${"r".repeat(48)}`);
      expect((await relay.chat({ model: "gpt-6-astra", messages: [] }, "agentrouter", { "user-agent": "codex_cli_rs/0.99.0" })).statusCode).toBe(200);
      expect(relay.calls.at(-1)!.headers.get("user-agent")).toBe("codex_cli_rs/0.99.0");
    } finally { await relay.server.app.close(); await relay.admin.close(); }
    const picky = await setup((_key, url) => url.includes("/dashboard/") ? json({}) : json({ error: { message: "unauthorized client detected" } }, 401), "agentrouter");
    try {
      await picky.add(`sk-${"r".repeat(48)}`);
      const refused = await picky.chat({ model: "gpt-6-astra", messages: [] }, "agentrouter", { "user-agent": "opencode/2.2.6" });
      expect([refused.statusCode, refused.json().error.code]).toEqual([502, "upstream_client_refused"]);
      expect((await picky.models()).statusCode).toBe(502);
      expect((await picky.repository.listAccounts())[0]!.status).toBe("ACTIVE");
    } finally { await picky.server.app.close(); await picky.admin.close(); }
    const free = await setup((_key, url) => url.endsWith("/models") ? json({ models: [{ id: "qwen7b", type: "chat", self_hosted: true }, { id: "openai/gpt-6.1-terra", type: "chat", self_hosted: false }, { id: "sdxl", type: "image" }] }) : json(completion("OK")), "freeai");
    try {
      await free.add(`fa_${"f".repeat(40)}`);
      await free.chat({ model: "qwen7b", messages: [] }, "freeai", { "user-agent": "codex_cli_rs/0.99.0" });
      expect(free.calls.at(-1)!.headers.get("user-agent")).toBeNull();
      expect((await free.models()).json().data.map((model: { id: string }) => model.id)).toEqual(["qwen7b"]);
    } finally { await free.server.app.close(); await free.admin.close(); }
  });

  it("runs an Azure OpenAI pool from the pasted Endpoint and Key: the api-key header, its deployments as models, and 402 past its credit's last day (7/11)", async () => {
    const key = "k".repeat(84);
    expect(azureKeyFrom(`Endpoint: https://Space-Oll4-Aoai.openai.azure.com/\nKey: ${key}\nDeployment: gpt-5-mini`)).toBe(`space-oll4-aoai:${key}`);
    expect(azureKeyFrom(`Key: ${key}`)).toBeNull();
    const base = "https://space-oll4-aoai.openai.azure.com/openai";
    let today = Date.parse("2027-02-05T23:00:00Z");
    const f = await setup((_key, url) => url.startsWith(`${base}/deployments`) ? json({ data: [{ id: "gpt-5-mini", model: "gpt-5-mini" }], object: "list" })
      : url.endsWith("/models") ? json({ data: [] }) : json(completion("OK")), "azure", undefined, () => today);
    try {
      expect((await f.add(`Endpoint: https://space-oll4-aoai.openai.azure.com/ Key: ${key}`)).json().status).toBe("CONNECTED");
      expect(f.calls[0]!.url).toBe(`${base}/v1/models`);
      expect([f.calls[0]!.headers.get("api-key"), f.calls[0]!.headers.get("authorization")]).toEqual([key, null]);
      expect((await f.models()).json().data.map((model: { id: string }) => model.id)).toEqual(["gpt-5-mini"]);
      expect((await f.chat({ model: "gpt-5-mini", messages: [] })).statusCode).toBe(200);
      expect([f.calls.at(-1)!.url, f.calls.at(-1)!.headers.get("api-key")]).toEqual([`${base}/v1/chat/completions`, key]);
      today = Date.parse("2027-02-06T00:00:00Z");
      const calls = f.calls.length;
      const refused = await f.chat({ model: "gpt-5-mini", messages: [] });
      expect([refused.statusCode, refused.json().error.code, f.calls.length]).toEqual([402, "credit_expired", calls]);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });

  it("sends Claude on Bedrock only inside a recorded credit: Mantle's URL and x-api-key, fixed models, list price +10% logged, 402 without credit, past its day or at 90%, never for Claude Code (7/11)", async () => {
    const message = { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "OK" }], usage: { input_tokens: 100, output_tokens: 50 } };
    // The key check sends no messages: Bedrock's 400 proves the key.
    const upstream = (_key: string, _url: string, body: unknown) => ((body as { messages: unknown[] }).messages.length ? json(message) : json({ message: "messages: required" }, 400));
    const key = `us-west-2:${"b".repeat(60)}`;
    expect(bedrockKeyFrom("b".repeat(60))).toBe(`us-east-1:${"b".repeat(60)}`);
    const ask = { model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "Hi" }] };
    // No credit in GATEWAY_FREE_GRANTS: nothing is sent.
    const unrecorded = await setup(upstream, "bedrock", undefined, undefined, { creditSpent: async () => 0 });
    try {
      await unrecorded.add(key);
      const calls = unrecorded.calls.length;
      const refused = await unrecorded.post("messages", ask);
      expect([refused.statusCode, refused.json().error.code, unrecorded.calls.length]).toEqual([402, "credit_not_recorded", calls]);
    } finally { await unrecorded.server.app.close(); await unrecorded.admin.close(); }
    let spent = 0;
    let today = Date.parse("2026-11-07T12:00:00Z");
    const f = await setup(upstream, "bedrock", undefined, () => today,
      { grants: { BEDROCK: { amount: 100, unit: "usd", since: "2026-11-01", validUntil: "2027-11-01", note: "test" } }, creditSpent: async () => spent });
    try {
      expect((await f.add(key)).json().status).toBe("CONNECTED");
      expect((await f.models()).json().data.map((model: { id: string }) => model.id)).toEqual([...CLOUD_CLAUDE_MODELS]);
      expect((await f.post("messages", ask)).statusCode).toBe(200);
      const sent = f.calls.at(-1)!;
      expect([sent.url, sent.headers.get("x-api-key"), sent.headers.get("anthropic-version"), sent.headers.get("authorization"), (sent.body as { model: string }).model])
        .toEqual(["https://bedrock-mantle.us-west-2.api.aws/anthropic/v1/messages", "b".repeat(60), "2023-06-01", null, "anthropic.claude-opus-5-5"]);
      await f.logs.flush();
      const [row] = await f.repository.listRequestLogs({ limit: 5 });
      expect([row!.provider, row!.inputTokens, row!.outputTokens]).toEqual(["BEDROCK", 100, 50]);
      expect(row!.costUsd).toBeCloseTo((100 * 4 + 50 * 20) / 1e6 * 1.1, 9);
      const calls = f.calls.length;
      const codes = async (payload: Record<string, unknown>, path = "messages") => { const answer = await f.post(path, payload); return [answer.statusCode, answer.json().error.code]; };
      expect(await codes({ ...ask, messages: [] }, "chat/completions")).toEqual([404, "unknown_route"]);
      expect(await codes({ ...ask, model: "claude-opus-5-5-20261101" })).toEqual([400, "model_not_listed"]);
      expect(await codes({ ...ask, speed: "fast" })).toEqual([400, "model_not_listed"]);
      // Never for Claude Code (operator 7/11): it runs on the subscriptions alone.
      const fromClaudeCode = await f.post("messages", ask, { "user-agent": "claude-cli/2.1.319 (external, cli)" });
      expect([fromClaudeCode.statusCode, fromClaudeCode.json().error.code]).toEqual([403, "client_not_allowed"]);
      spent = 90;
      expect(await codes(ask)).toEqual([402, "credit_spent"]);
      spent = 0;
      today = Date.parse("2027-11-02T00:00:00Z");
      expect(await codes(ask)).toEqual([402, "credit_expired"]);
      expect(f.calls.length).toBe(calls);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });

  it("calls Claude on Vertex with a token signed from the service-account key: rawPredict and streamRawPredict, Vertex's body, the streamed usage priced (7/11)", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const account = (email: string) => JSON.stringify({ type: "service_account", project_id: "space-oll4-test", private_key_id: "1", client_email: email,
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), client_id: "1" });
    expect(vertexKeyFrom('{"type":"authorized_user"}')).toBeNull();
    const sse = [
      { type: "message_start", message: { id: "msg_2", model: "claude-sonnet-5-5", usage: { input_tokens: 1000, output_tokens: 1 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 100 } },
      { type: "message_stop" }
    ].map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
    const token = "oauth2.googleapis.com/token";
    const f = await setup((_key, url, body) => url.endsWith(token) ? json({ access_token: "ya29.test", expires_in: 3600 })
      : url.endsWith(":streamRawPredict") ? new Response(sse, { headers: { "content-type": "text/event-stream" } })
        : (body as { messages: unknown[] }).messages.length ? json({ id: "msg_1", type: "message", content: [], usage: { input_tokens: 10, output_tokens: 1 } })
          : json({ error: { message: "messages: required" } }, 400),
    "vertex", undefined, undefined, { grants: { VERTEX: { amount: 100, unit: "usd", since: "2026-11-01", note: "test" } }, creditSpent: async () => 0 });
    try {
      expect((await f.add(account("claude@space-oll4-test.iam.gserviceaccount.com"))).json().status).toBe("CONNECTED");
      // The JWT is signed with the key and names the service account.
      const [header, claims, signature] = new URLSearchParams(f.calls[0]!.body as string).get("assertion")!.split(".");
      expect(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature!, "base64url")).toBe(true);
      expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({ iss: "claude@space-oll4-test.iam.gserviceaccount.com", aud: `https://${token}` });
      const base = "https://aiplatform.googleapis.com/v1/projects/space-oll4-test/locations/global/publishers/anthropic/models";
      expect(f.calls[1]!.url).toBe(`${base}/claude-haiku-5-5:rawPredict`);
      expect((await f.post("messages", { model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: "Hi" }] })).statusCode).toBe(200);
      const sent = f.calls.at(-1)!;
      expect([sent.url, sent.headers.get("authorization"), sent.body]).toEqual([`${base}/claude-opus-5-5:rawPredict`, "Bearer ya29.test",
        { max_tokens: 64, messages: [{ role: "user", content: "Hi" }], anthropic_version: "vertex-2023-10-16" }]);
      const streamed = await f.post("messages", { model: "claude-sonnet-5-5", max_tokens: 64, stream: true, messages: [{ role: "user", content: "Hi" }] });
      expect([streamed.statusCode, streamed.body.includes("message_stop"), f.calls.at(-1)!.url]).toEqual([200, true, `${base}/claude-sonnet-5-5:streamRawPredict`]);
      // One token for the check and both requests.
      expect(f.calls.filter((call) => call.url.endsWith(token))).toHaveLength(1);
      await f.logs.flush();
      const [row] = await f.repository.listRequestLogs({ limit: 5 });
      expect([row!.model, row!.status, row!.inputTokens, row!.outputTokens]).toEqual(["claude-sonnet-5-5", "success", 1000, 100]);
      expect(row!.costUsd).toBeCloseTo((1000 * 2 + 100 * 10) / 1e6 * 1.1, 9);
    } finally { await f.server.app.close(); await f.admin.close(); }
    // Google refuses the token (a deleted key): the key's fault, before any request reaches the model.
    const refusing = (async () => json({ error: "invalid_grant" }, 400)) as unknown as typeof fetch;
    const deleted = vertexKeyFrom(account("deleted@space-oll4-test.iam.gserviceaccount.com"))!;
    await expect(vertexMessages({ apiKey: deleted, body: { model: "claude-opus-5-5" }, streaming: false, headers: {}, fetchImpl: refusing })).rejects.toMatchObject({ status: 401 });
    expect(await checkPoolKey(keyPoolProviders.vertex, deleted, refusing)).toEqual({ ok: false, status: 401 });
  });

  it("sends Z.AI only its free models and lists only those, and runs OVH with no key at all (7/11)", async () => {
    const zai = await setup((_key, url) => url.endsWith("/models") ? json({ data: [{ id: "glm-4.6" }] }) : json(completion("OK")), "zai");
    try {
      await zai.add("z".repeat(40));
      expect((await zai.models()).json().data.map((model: { id: string }) => model.id)).toEqual(["glm-4.5-flash", "glm-4.7-flash", "glm-4.6v-flash"]);
      const calls = zai.calls.length;
      const paid = await zai.chat({ model: "glm-4.6", messages: [] });
      expect([paid.statusCode, paid.json().error.code, zai.calls.length]).toEqual([403, "model_not_free", calls]);
      expect((await zai.chat({ model: "glm-4.5-flash", messages: [] })).statusCode).toBe(200);
    } finally { await zai.server.app.close(); await zai.admin.close(); }
    const ovh = await setup((_key, url) => url.endsWith("/models") ? json({ data: [{ id: "gpt-oss-20b" }] }) : json(completion("OK")), "ovh");
    try {
      expect((await ovh.add(GATEWAY_KEYLESS_KEY)).json().status).toBe("CONNECTED");
      expect((await ovh.chat({ model: "gpt-oss-20b", messages: [] })).statusCode).toBe(200);
      expect(ovh.calls.map((call) => call.headers.get("authorization"))).toEqual([null, null]);
    } finally { await ovh.server.app.close(); await ovh.admin.close(); }
  });

  it("lists each pool's supported models through its first active key for the API, and names why when it cannot (7/11)", async () => {
    let catalog = 200;
    const f = await setup((_key, url) => !url.endsWith("/models") ? json({ data: [] })
      : catalog === 200 ? json({ data: [{ id: "jina-ai/jina-embeddings-v3" }, { id: "jina-ai/jina-reranker-v3" }] }) : json({ error: { message: "no" } }, catalog), "jina");
    const list = (token = "internal") => f.server.app.inject({ method: "POST", url: "/__space-gateway/admin/pool-models", remoteAddress: "127.0.0.1",
      headers: { "x-space-internal-token": token }, payload: {} });
    try {
      expect((await list()).json().data).toEqual([{ provider: "JINA", models: null, error: "No active key." }]);
      await f.add(`jina_${"j".repeat(60)}`);
      expect((await list()).json().data).toEqual([{ provider: "JINA", models: ["jina-embeddings-v3", "jina-reranker-v3"], error: null }]);
      catalog = 404;
      expect((await list()).json().data).toEqual([{ provider: "JINA", models: null, error: "Jina AI answered HTTP 404 to its model list." }]);
      expect((await list("wrong")).statusCode).toBe(403);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });

  it("sends Mixedbread no x-request-id, which it refuses unless it is a UUID (7/11)", async () => {
    const f = await setup(() => json({ model: "mixedbread-ai/mxbai-embed-large-v1", usage: { prompt_tokens: 3, total_tokens: 3 }, data: [{ embedding: [0.1] }] }), "mixedbread");
    try {
      expect((await f.add(`mxb_${"m".repeat(40)}`)).json().status).toBe("CONNECTED");
      expect((await f.post("embeddings", { model: "mixedbread-ai/mxbai-embed-large-v1", input: ["hello"] })).statusCode).toBe(200);
      expect(f.calls.at(-1)!.url).toBe("https://api.mixedbread.com/v1/embeddings");
      expect(f.calls.at(-1)!.headers.has("x-request-id")).toBe(false);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });

  it("serves Jina AI's embeddings and rerank through the pool, counts rerank's total_tokens, and lists its models by the ids they take (7/11)", async () => {
    const f = await setup((_key, url) => url.endsWith("/models") ? json({ data: [{ id: "jina-ai/jina-embeddings-v3" }, { id: "jina-ai/jina-reranker-v3" }] })
      : url.endsWith("/rerank") ? json({ model: "jina-reranker-v3", usage: { total_tokens: 42 }, results: [{ index: 0, relevance_score: 0.9 }] })
      : url.endsWith("/embeddings") ? json({ model: "jina-embeddings-v3", usage: { prompt_tokens: 3, total_tokens: 3 }, data: [{ embedding: [0.1] }] }) : json({ data: [] }), "jina");
    try {
      expect((await f.add(`jina_${"j".repeat(60)}`)).json().status).toBe("CONNECTED");
      expect((await f.post("rerank", { model: "jina-reranker-v3", query: "q", documents: ["d"] })).json().results).toHaveLength(1);
      expect((await f.post("embeddings", { model: "jina-embeddings-v3", input: ["hello"] })).statusCode).toBe(200);
      expect(f.calls.slice(-2).map((call) => call.url)).toEqual(["https://api.jina.ai/v1/rerank", "https://api.jina.ai/v1/embeddings"]);
      await f.logs.flush();
      const logged = (await f.repository.listRequestLogs({ limit: 10 })).map((row) => `${row.model}:${row.inputTokens}`);
      expect(logged).toEqual(expect.arrayContaining(["jina-reranker-v3:42", "jina-embeddings-v3:3"]));
      expect((await f.models()).json().data.map((model: { id: string }) => model.id)).toEqual(["jina-embeddings-v3", "jina-reranker-v3"]);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });

  it("hides a free pool's model that answers 410 or 404 from /models, keeps one that answers 429, and brings one back on a 200", async () => {
    const checks = new ModelChecks(new InMemoryGatewayRepository());
    const answers: Record<string, number> = { "old/eol": 410, "not/served": 404, "busy/model": 429, "good/model": 200 };
    const f = await setup((_key, url, body) => {
      if (url.includes("/nvcf/functions")) return json({ functions: [] });
      if (url.endsWith("/models")) return json({ object: "list", data: Object.keys(answers).map((id) => ({ id })) });
      const status = answers[(body as { model: string }).model]!;
      return status === 200 ? json(completion("OK")) : json({ error: { message: `HTTP ${status}` } }, status);
    }, "nvidia", checks);
    try {
      await f.add(`nvapi-${"n".repeat(64)}`);
      for (const model of ["old/eol", "not/served", "good/model"]) await f.chat({ model, messages: [] });
      await new Promise((done) => setTimeout(done, 0));
      expect((await f.models()).json().data.map((row: { id: string }) => row.id)).toEqual(["busy/model", "good/model"]);
      expect((await f.chat({ model: "busy/model", messages: [] })).statusCode).toBe(429);
      await new Promise((done) => setTimeout(done, 0));
      expect(checks.dead("NVIDIA").map((check) => [check.model, check.status])).toEqual([["old/eol", 410], ["not/served", 404]]);
      expect(checks.isDead("NVIDIA", "busy/model")).toBe(false);
      await checks.record("NVIDIA", "old/eol", 200, null);
      expect(checks.isDead("NVIDIA", "old/eol")).toBe(false);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });
  it("correlates pooled CLI calls through the validated Gateway API id (OBS-006)", async () => {
    const f = await setup((_key, url) => json(url.endsWith("/key") ? { data: {} } : completion("hello")));
    try {
      await f.add(keyA);
      const ids: string[] = [];
      for (const supplied of ["req:qwen-pane", "x".repeat(121), undefined]) {
        const response = await f.chat({ model: "qwen/qwen3-coder", messages: [{ role: "user", content: "PRIVATE_PROMPT" }] }, "openrouter",
          supplied ? { "x-request-id": supplied } : {});
        expect(response.statusCode).toBe(200);
        ids.push(String(response.headers["x-request-id"]));
      }
      await f.logs.flush();
      expect(ids[0]).toBe("req:qwen-pane");
      for (const id of ids.slice(1)) expect(id).toMatch(/^req_[0-9a-f]{32}$/);
      expect((await f.repository.listRequestLogs({ limit: 10 })).map((row) => row.requestId).reverse()).toEqual(ids);
      expect(f.apiLog.map((row) => row.reqId)).toEqual(ids);
      expect(f.calls.filter((call) => call.url.endsWith("/chat/completions")).map((call) => call.headers.get("x-request-id"))).toEqual(ids);
      expect(JSON.stringify(f.apiLog)).not.toContain("PRIVATE_PROMPT");
    } finally { await f.server.app.close(); await f.admin.close(); }
  });
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

  it("takes a key out of rotation when its stream fails for lack of credit after a 200 (OpenAI, 29/10)", async () => {
    // The stream OpenAI sent on stable 29/10 17:09 UTC for the key without credit (messages shortened).
    const stream = 'event: response.created\ndata: {"type":"response.created","response":{"status":"in_progress","error":null}}\n\n'
      + 'event: error\ndata: {"type":"error","error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining."}}\n\n'
      + 'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed","error":{"type":"insufficient_quota","code":"credit_balance_exhausted","message":"You have no credits remaining."}}}\n\n';
    const { add, chat, logs, repository } = await setup((_apiKey, url) => url.endsWith("/key") ? json({ data: {} })
      : new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }));
    await add(keyA);
    expect((await chat({ model: "openai/gpt-6-astra", messages: [], stream: true })).body).toBe(stream);
    await logs.flush();
    expect((await repository.listRequestLogs({ limit: 5 }))[0]).toMatchObject({ status: "error", errorCode: "insufficient_quota" });
    const [account] = await repository.listAccounts();
    expect(account?.status).toBe("QUOTA_EXCEEDED");
    expect((await chat({ model: "openai/gpt-6-astra", messages: [], stream: true })).statusCode).toBe(503);
  });

  it("answers an unknown pool with 404, an empty pool with no accounts, and opens the pools to the LAN", async () => {
    const { chat } = await setup(() => json({}));
    expect((await chat({ model: "x", messages: [] }, "anthropic")).statusCode).toBe(404);
    expect((await chat({ model: "x", messages: [] })).statusCode).toBe(503);
    expect(lanPathAllowed("/pools/openrouter/v1/chat/completions")).toBe(true);
    expect(readPoolUsage({ response: { usage: { input_tokens: 9, output_tokens: 1 } } })).toEqual({ inputTokens: 9, outputTokens: 1, cachedInputTokens: null, costUsd: null });
    expect(readPoolUsage({ usage: { prompt_tokens: 1, completion_tokens: 1, cost: Number.NaN } })?.costUsd).toBeNull();
  });

  it("runs a Cloudflare pool from its <account>:<token> key: the account in every URL, only the token sent, its catalog as an OpenAI list", async () => {
    const account = "9371fb332815f9e747d46af264e69f6b";
    const token = "t".repeat(40);
    const base = `https://api.cloudflare.com/client/v4/accounts/${account}/ai`;
    let chatAnswer = () => json({ object: "chat.completion", choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, neurons: 2 } });
    const f = await setup((apiKey, url) => {
      if (apiKey !== token) return json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, 401);
      if (url.startsWith(`${base}/models/search`)) return json({ success: true, result: [{ name: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
        properties: [{ property_id: "async_queue", value: "true" }, { property_id: "context_window", value: "24000" }] }, { name: "@cf/openai/gpt-oss-120b" }] });
      return chatAnswer();
    }, "cloudflare");
    try {
      expect((await f.add(token)).json().error.code).toBe("invalid_api_key");
      expect((await f.add(`${account}:${token}`)).json()).toMatchObject({ status: "CONNECTED", account: { label: `Cloudflare Workers AI API key …${token.slice(-4)}` } });
      expect(f.calls[0]).toMatchObject({ apiKey: token, url: `${base}/models/search?task=Text%20Generation&per_page=1` });
      expect((await f.models()).json()).toEqual({ object: "list", data: [{ id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", object: "model", owned_by: "Cloudflare Workers AI", context_window: 24000 },
        { id: "@cf/openai/gpt-oss-120b", object: "model", owned_by: "Cloudflare Workers AI" }] });
      expect((await f.chat({ model: "@cf/openai/gpt-oss-120b", messages: [] })).statusCode).toBe(200);
      expect(f.calls.at(-1)).toMatchObject({ apiKey: token, url: `${base}/v1/chat/completions` });
      // An end-of-life model is that model's refusal: passed through, the key stays in rotation.
      chatAnswer = () => json({ errors: [{ message: "AiError: model is deprecated" }] }, 410);
      expect((await f.chat({ model: "@cf/old/model", messages: [] })).statusCode).toBe(410);
      expect((await f.repository.listAccounts())[0]!.status).toBe("ACTIVE");
      // The daily neurons are spent: the key cools down until 00:00 UTC and the pool has no other key.
      chatAnswer = () => json({ errors: [{ code: 4006, message: "you have used up your daily free allocation of 10,000 neurons" }] }, 429);
      expect((await f.chat({ model: "@cf/openai/gpt-oss-120b", messages: [] })).statusCode).toBe(429);
      expect((await f.repository.listAccounts())[0]!.status).toBe("RATE_LIMITED");
      expect((await f.chat({ model: "@cf/openai/gpt-oss-120b", messages: [] })).statusCode).toBe(503);
    } finally { await f.server.app.close(); await f.admin.close(); }
  });

  it("checks Groq, NVIDIA, Adaption Labs, AMD Token Lab, Inception Labs and Jina AI keys with a request that spends nothing, and cools a throttled key as long as the provider says", async () => {
    const keys = { groq: `gsk_${"g".repeat(52)}`, nvidia: `nvapi-${"n".repeat(64)}`, adaption: `pt_live_${"a".repeat(40)}`, amd: `tl-1${"a".repeat(47)}`,
      inception: `sk_${"i".repeat(40)}`, jina: `jina_${"j".repeat(60)}`, mixedbread: `mxb_${"m".repeat(40)}`, agentrouter: `sk-${"r".repeat(48)}`, freeai: `fa_${"f".repeat(40)}` } as const;
    // Inception and Jina answer /models without a key and refused real keys on their batches and classifiers (7/11): a 1-token chat, a one-word embedding.
    const checks = { groq: "https://api.groq.com/openai/v1/models", nvidia: "https://api.nvcf.nvidia.com/v2/nvcf/functions",
      adaption: "https://api.prod.adaptionlabs.ai/api/v1/models", amd: "https://api.tokenlab.amd.com/v1/models", inception: "https://api.inceptionlabs.ai/v1/chat/completions",
      jina: "https://api.jina.ai/v1/embeddings", mixedbread: "https://api.mixedbread.com/v1/files", agentrouter: "https://agentrouter.org/v1/dashboard/billing/subscription",
      freeai: "https://api.free.ai/v1/models" };
    for (const slug of ["groq", "nvidia", "adaption", "amd", "inception", "jina", "mixedbread", "agentrouter", "freeai"] as const) {
      const f = await setup(() => json({ data: [] }), slug);
      try {
        // Mixedbread's and Free.ai's key shapes are not documented: only their checks tell a wrong key (Free.ai's none).
        if (slug !== "mixedbread" && slug !== "freeai") expect((await f.add("sk-not-this-provider-0000000000")).json().error.code).toBe("invalid_api_key");
        expect((await f.add(keys[slug])).json().status).toBe("CONNECTED");
        expect(f.calls[0]).toMatchObject({ apiKey: keys[slug], url: checks[slug], body: keyPoolProviders[slug].checkBody ?? null });
      } finally { await f.server.app.close(); await f.admin.close(); }
    }
    // Mistral's free tier (7/11): its catalog needs the key, every model is free, a throttled 429 still proves the key.
    expect(keyPoolProviders.mistral).toMatchObject({ provider: "MISTRAL", baseUrl: "https://api.mistral.ai/v1", checkUrl: "https://api.mistral.ai/v1/models", checkAccepts: [429] });
    const mistral = await setup(() => json({ data: [{ id: "mistral-small-latest" }] }), "mistral");
    try {
      expect((await mistral.add("short")).json().error.code).toBe("invalid_api_key");
      expect((await mistral.add("M".repeat(32))).json().status).toBe("CONNECTED");
      expect(mistral.calls[0]).toMatchObject({ apiKey: "M".repeat(32), url: "https://api.mistral.ai/v1/models" });
    } finally { await mistral.server.app.close(); await mistral.admin.close(); }
    // The API's Vault reconcile asks by hash whether a key is an account: nothing reaches the provider.
    const known = await setup(() => json({ data: [] }), "groq");
    try {
      const ask = (apiKey: string) => known.admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/known", remoteAddress: "127.0.0.1",
        headers: { "x-space-internal-token": "internal" }, payload: { provider: "GROQ", apiKey } });
      expect((await ask(keys.groq)).json()).toEqual({ known: false });
      await known.add(keys.groq);
      const before = known.calls.length;
      expect((await ask(keys.groq)).json()).toEqual({ known: true });
      expect((await ask(`gsk_${"h".repeat(52)}`)).json()).toEqual({ known: false });
      expect(known.calls.length).toBe(before);
      expect((await known.admin.inject({ method: "POST", url: "/__space-gateway/admin/api-key/known", remoteAddress: "127.0.0.1", payload: { provider: "GROQ", apiKey: keys.groq } })).statusCode).not.toBe(200);
    } finally { await known.server.app.close(); await known.admin.close(); }
    // A new free pool account joins the `<who>-free-pools` keys at once (7/11: Inception joined and no free-pools key reached it).
    const scoped = await setup(() => json({ data: [] }), "groq");
    try {
      const make = async (name: string) => (await scoped.repository.createApiKey({ keyId: `gw_key:${name.length.toString(16).padStart(32, "0")}`, name, keyHash: `hash-${name}`,
        keyPrefix: "sk-sgw-x", trafficClass: "BACKGROUND", allowedModels: [], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [],
        compressionOverride: null, limits: [], expiresAt: null, createdBy: null })).id;
      const nous = await make("nous-free-pools");
      const other = await make("summary-writer");
      const added = (await scoped.add(keys.groq)).json().account.id;
      const byId = async (id: string) => (await scoped.repository.listApiKeys()).find((key) => key.id === id)!;
      expect((await byId(nous)).accountIds).toEqual([added]);
      expect((await byId(other)).accountIds).toEqual([]);
      // The same key again is no new account: nothing changes.
      await scoped.add(keys.groq);
      expect((await byId(nous)).accountIds).toEqual([added]);
    } finally { await scoped.server.app.close(); await scoped.admin.close(); }
    // A relay's account joins the other free-pools keys, never Nous's (plan clipboard:09Xmh_hkoGrp step 3).
    const relay = await setup(() => json({}), "agentrouter");
    try {
      const make = async (name: string) => (await relay.repository.createApiKey({ keyId: `gw_key:${name.length.toString(16).padStart(32, "0")}`, name, keyHash: `hash-${name}`,
        keyPrefix: "sk-sgw-x", trafficClass: "BACKGROUND", allowedModels: [], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [],
        compressionOverride: null, limits: [], expiresAt: null, createdBy: null })).id;
      const nous = await make("nous-free-pools");
      const openCode = await make("opencode-free-pools");
      const added = (await relay.add(keys.agentrouter)).json().account.id;
      const byId = async (id: string) => (await relay.repository.listApiKeys()).find((key) => key.id === id)!;
      expect((await byId(nous)).accountIds).toEqual([]);
      expect((await byId(openCode)).accountIds).toEqual([added]);
    } finally { await relay.server.app.close(); await relay.admin.close(); }
    // The same providers as the hand sync (space-admin-action gateway-free-pools-key-sync).
    const script = readFileSync(new URL("../../../scripts/space-admin-action.mjs", import.meta.url), "utf8");
    const listed = /const FREE_POOL_PROVIDERS = new Set\(\[([^\]]+)\]/.exec(script)![1]!.match(/[A-Z_]+/g)!;
    expect([...FREE_POOL_KEY_PROVIDERS].sort()).toEqual([...listed].sort());
    const excluded = /NOUS_FREE_POOL_PROVIDERS = new Set\(\[\.\.\.FREE_POOL_PROVIDERS\]\.filter\(\(provider\) => !\[([^\]]+)\]/.exec(script)![1]!.match(/[A-Z_]+/g)!;
    expect([...NOUS_FREE_POOL_KEY_EXCLUDED].sort()).toEqual([...excluded].sort());
    // 7/11: Inception's check names a model the granted key serves (mercury-2 answered it 404), and its throttled 429 proves the key.
    expect(keyPoolProviders.inception.checkBody).toMatchObject({ model: "mercury-3" });
    for (const [status, ok] of [[429, true], [401, false], [404, false]] as const) {
      expect(await checkPoolKey(keyPoolProviders.inception, keys.inception, (async () => json({ error: {} }, status)) as unknown as typeof fetch)).toEqual({ ok, status });
    }
    expect(await checkPoolKey(keyPoolProviders.groq, keys.groq, (async () => json({ error: {} }, 429)) as unknown as typeof fetch)).toEqual({ ok: false, status: 429 });
    const now = Date.UTC(2026, 10, 5, 22, 0);
    expect(poolCooldownSeconds(keyPoolProviders.groq, "17", "Rate limit reached", now)).toBe(17);
    expect(poolCooldownSeconds(keyPoolProviders.groq, null, "Rate limit reached on requests per day (RPD). Please try again in 7m12s.", now)).toBeUndefined();
    expect(poolCooldownSeconds(keyPoolProviders.groq, null, "Tokens per day limit exceeded", now)).toBe(2 * 3600);
    expect(poolCooldownSeconds(keyPoolProviders.nvidia, null, "HTTP 429", now)).toBe(60);
  });
});
