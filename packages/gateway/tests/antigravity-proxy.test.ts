import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { antigravityAccountActions, registerAntigravitySignInRoutes } from "../src/admin/antigravity-sign-in.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { registerAntigravityProxyRoutes, type AntigravityProxyOptions } from "../src/providers/antigravity/antigravity-proxy.js";
import { parseQuotaSummary, quotaGroupForModel } from "../src/providers/antigravity/code-assist.js";
import { parseAntigravityTokenFile } from "../src/providers/antigravity/oauth.js";
import { CodeAssistStreamInspector, parseResetsIn } from "../src/providers/antigravity/stream.js";
import { CompressionCache, RawBlockRegistry } from "../src/compression/engine.js";
import { RequestLogWriter } from "../src/request-log-writer.js";

const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const nowMs = Date.parse("2030-01-10T00:00:00Z");
const accountA = `gw_account:${"a".repeat(32)}`;
const accountB = `gw_account:${"b".repeat(32)}`;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (...events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const reply = (text: string) => sse(
  { response: { candidates: [{ content: { role: "model", parts: [{ text }] } }], modelVersion: "gemini-3.8-flash-high" }, traceId: "t" },
  { response: { candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1200, cachedContentTokenCount: 800, candidatesTokenCount: 7, thoughtsTokenCount: 3 }, modelVersion: "gemini-3.8-flash-high" } }
);
const quotaError = () => json({ error: { code: 429, message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h3m17s.",
  status: "RESOURCE_EXHAUSTED" } }, 429);

async function setup(upstream: (token: string, path: string, body: Record<string, unknown> | null) => Response, extra: Partial<AntigravityProxyOptions> = {}) {
  const repository = new InMemoryGatewayRepository();
  for (const [accountId, name, used] of [[accountA, "a", 10], [accountB, "b", 40]] as const) {
    const credentials: StoredCredentials = { accessToken: `token-${name}`, refreshToken: "rt", idToken: null, upstreamAccountId: `project-${name}`, accessExpiresAtMs: null };
    await repository.upsertAccount({ accountId, provider: "ANTIGRAVITY", label: `${name}@example.com`, email: `${name}@example.com`, externalAccountId: `sub-${name}`,
      planType: "pro", credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "PROFILE_ADOPTION",
      sourceRef: name, lastRefreshAt: null });
    await repository.saveUsageWindows(accountId, [{ quotaKey: "gemini", window: "PRIMARY", usedPercent: used, resetAt: null, windowMinutes: 300 },
      { quotaKey: "claude", window: "PRIMARY", usedPercent: 100 - used, resetAt: null, windowMinutes: 300 }]);
  }
  await repository.updateSettings({ routingStrategy: "USAGE_WEIGHTED" });
  const pool = new AccountPool({ provider: "ANTIGRAVITY", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() }, now: () => nowMs });
  const logs = new RequestLogWriter(repository, { intervalMs: 1 });
  const calls: { token: string; path: string; body: Record<string, unknown> | null }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization ?? "").replace("Bearer ", "");
    const path = url.replace("https://code-assist.test", "");
    const body = init.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown> : null;
    calls.push({ token, path, body });
    return upstream(token, path, body);
  }) as unknown as typeof fetch;
  const app = Fastify();
  registerAntigravityProxyRoutes(app, { pool, repository, logs, settings: () => repository.getSettings(), fetchImpl, now: () => nowMs,
    upstreamBaseUrl: "https://code-assist.test", ...extra,
    verifyIdentity: async (token) => (token === "client-a-token" ? { subject: "sub-a", email: "a@example.com", clientId: null }
      : token === "stranger" ? { subject: "sub-x", email: "x@example.com", clientId: null } : null) });
  const post = (path: string, body: Record<string, unknown>, token = "client-a-token") => app.inject({ method: "POST", url: `/antigravity${path}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "antigravity/1.3.1" }, payload: JSON.stringify(body) });
  return { repository, pool, logs, calls, post, app };
}

const generate = (model = "gemini-3.8-flash-high") => ({ project: "project-a", requestId: "r1", model, userAgent: "antigravity", requestType: "agent",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }], sessionId: "session-1" } });

describe("Antigravity helpers", () => {
  it("reads the CLI sign-in file, quota groups, reset hints and the model's quota group", () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "a@example.com", sub: "sub-a" })).toString("base64url")}.y`;
    expect(parseAntigravityTokenFile(JSON.stringify({ token: { access_token: "at", refresh_token: "rt", expiry: "2030-01-10T01:00:00Z" }, id_token: idToken })))
      .toEqual({ accessToken: "at", refreshToken: "rt", expiresAtMs: Date.parse("2030-01-10T01:00:00Z"), email: "a@example.com", subject: "sub-a" });
    expect(() => parseAntigravityTokenFile("{}")).toThrow(/refresh token/);
    expect(parseQuotaSummary({ groups: [
      { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.25, resetTime: "2030-01-10T05:00:00Z" }, { window: "weekly", remainingFraction: 0.9 }] },
      { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", remainingFraction: 1 }] }
    ] })).toEqual({
      gemini: { fiveHourUsedPercent: 75, fiveHourResetAt: "2030-01-10T05:00:00Z", weeklyUsedPercent: 10, weeklyResetAt: null },
      claude: { fiveHourUsedPercent: 0, fiveHourResetAt: null, weeklyUsedPercent: null, weeklyResetAt: null }
    });
    expect(parseResetsIn("Individual quota reached. Resets in 4h3m17s.")).toBe(4 * 3600 + 3 * 60 + 17);
    expect(quotaGroupForModel("claude-opus-5-5-high")).toBe("claude");
    expect(quotaGroupForModel("gemini-3.8-flash-high")).toBe("gemini");
    const inspector = new CodeAssistStreamInspector();
    inspector.push(new TextEncoder().encode(`data: ${JSON.stringify({ error: { code: 429, message: "quota" } })}\n\n`));
    expect(inspector).toMatchObject({ outputStarted: false, errorStatus: 429 });
  });

  it("reads usage from a non-stream generateContent JSON body (an image call), split across chunks", () => {
    const inspector = new CodeAssistStreamInspector();
    const body = JSON.stringify({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QUJD" } }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1290 }, modelVersion: "gemini-3.1-flash-image" }, traceId: "t" }, null, 2);
    const bytes = new TextEncoder().encode(body);
    expect(inspector.push(bytes.slice(0, 40))).toBe(false);
    expect(inspector.push(bytes.slice(40))).toBe(false);
    expect(inspector.usage).toBeNull();
    inspector.end();
    expect(inspector).toMatchObject({ outputStarted: true, finished: true, model: "gemini-3.1-flash-image",
      usage: { promptTokens: 9, cachedTokens: null, outputTokens: 1290, thoughtsTokens: null } });
  });
});

describe("Antigravity proxy", () => {
  it("logs the usage of a non-stream model call (agy's image call)", async () => {
    const { post, logs, repository } = await setup(() => json({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: "QUJD" } }] },
      finishReason: "STOP" }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 1290 }, modelVersion: "gemini-3.1-flash-image" } }));
    const response = await post("/v1internal:generateContent", generate("gemini-3.1-flash-image"));
    expect(response.statusCode).toBe(200);
    expect(response.json().response.candidates[0].content.parts[0].inlineData.data).toBe("QUJD");
    await logs.flush();
    expect(await repository.listRequestLogs({ limit: 5 })).toEqual([expect.objectContaining({ model: "gemini-3.1-flash-image", inputTokens: 9, outputTokens: 1290,
      status: "success" })]);
  });

  it("sends model calls to the least-used account of the model's quota group with that account's project", async () => {
    const { post, calls, logs, repository } = await setup(() => reply("SPACE_AGY_OK"));
    const response = await post("/v1internal:streamGenerateContent?alt=sse", generate());
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("SPACE_AGY_OK");
    expect(calls[0]).toMatchObject({ token: "token-a", path: "/v1internal:streamGenerateContent?alt=sse", body: { project: "project-a", model: "gemini-3.8-flash-high" } });
    // Claude models use the other quota group, where account B has more left.
    await post("/v1internal:streamGenerateContent?alt=sse", { ...generate("claude-opus-5-5-high"), request: { contents: [], sessionId: "session-2" } });
    expect(calls[1]).toMatchObject({ token: "token-b", body: { project: "project-b" } });
    await logs.flush();
    const [, first] = await repository.listRequestLogs({ limit: 5 });
    expect(first).toMatchObject({ provider: "ANTIGRAVITY", accountId: accountA, model: "gemini-3.8-flash-high", inputTokens: 1200, cachedInputTokens: 800, outputTokens: 7,
      reasoningTokens: 3, status: "success" });
    // Gemini 3.8 Flash list prices: thinking is billed as output.
    expect(first!.costUsd).toBeCloseTo((400 * 0.75 + 800 * 0.075 + 10 * 3.75) / 1e6, 12);
  });

  it("moves to another account when one runs out of quota, and remembers the reset for that quota group only", async () => {
    const { post, calls, repository } = await setup((token) => (token === "token-a" ? quotaError() : reply("from b")));
    const response = await post("/v1internal:streamGenerateContent?alt=sse", generate());
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("from b");
    expect(calls.map((call) => call.token)).toEqual(["token-a", "token-b"]);
    expect(calls[1]!.body).toMatchObject({ project: "project-b" });
    const a = (await repository.listAccounts()).find((account) => account.id === accountA)!;
    expect(a.status).toBe("ACTIVE");
    expect(a.quotaGroups?.find((group) => group.key === "gemini")?.primaryWindow).toMatchObject({ usedPercent: 100,
      resetAt: new Date(nowMs + (4 * 3600 + 3 * 60 + 17) * 1000).toISOString() });
    expect(a.quotaGroups?.find((group) => group.key === "claude")?.primaryWindow.usedPercent).toBe(90);
  });

  it("returns the provider's error when every account is out of quota", async () => {
    const { post, calls } = await setup(() => quotaError());
    const response = await post("/v1internal:streamGenerateContent?alt=sse", generate());
    expect(response.statusCode).toBe(429);
    expect(response.json()).toMatchObject({ error: { status: "RESOURCE_EXHAUSTED" } });
    expect(calls).toHaveLength(2);
  });

  it("passes account calls, and clients outside the pool, through with the client's own sign-in", async () => {
    const { post, calls, app, logs, repository } = await setup((_token, path) => (path.includes("loadCodeAssist") ? json({ cloudaicompanionProject: "project-a" }) : reply("own account")));
    const response = await post("/v1internal:loadCodeAssist", { metadata: {} });
    expect(response.json()).toEqual({ cloudaicompanionProject: "project-a" });
    expect(calls[0]).toMatchObject({ token: "client-a-token", path: "/v1internal:loadCodeAssist", body: { metadata: {} } });
    // A client signed in as an account outside the pool keeps using its own account and project.
    const stranger = await post("/v1internal:streamGenerateContent?alt=sse", { ...generate(), project: "project-x" }, "stranger");
    expect(stranger.body).toContain("own account");
    expect(calls[1]).toMatchObject({ token: "stranger", body: { project: "project-x" } });
    expect((await app.inject({ method: "POST", url: "/antigravity/v1internal:loadCodeAssist", payload: {} })).statusCode).toBe(401);
    expect(calls).toHaveLength(2);
    // Only the model call is logged (no pool account), so the token usage page still counts its tokens.
    await logs.flush();
    expect(await repository.listRequestLogs({ limit: 5 })).toEqual([expect.objectContaining({ provider: "ANTIGRAVITY", accountId: null,
      model: "gemini-3.8-flash-high", inputTokens: 1200, outputTokens: 7, reasoningTokens: 3, status: "success", clientName: expect.any(String) })]);
  });
});

describe("Antigravity context compression", () => {
  const run = vi.fn(async (text: string) => ({ replacement: text.slice(0, 600), action: { kind: "compressed" as const, strategy: "log_compressor" as const,
    contentType: "build" as const, originalBytes: text.length, compressedBytes: 600, originalTokens: Math.ceil(text.length / 3.8), compressedTokens: 158 } }));
  const log = "x".repeat(4000);
  /** An agent turn as Antigravity sends it: the tool call and its result both in `model` turns. */
  const toolTurn = () => ({ ...generate(), request: { sessionId: "session-1", contents: [{ role: "user", parts: [{ text: "build it" }] },
    { role: "model", parts: [{ functionCall: { id: "c1", name: "run_command", args: { CommandLine: "npm run build" } } }] },
    { role: "model", parts: [{ functionResponse: { id: "c1", name: "run_command", response: { output: log } } }] }] } });
  const outputSent = (body: Record<string, unknown> | null) =>
    String((((body!.request as { contents: Array<{ parts: Array<{ functionResponse?: { response: { output: string } } }> }> }).contents[2]!.parts[0]!.functionResponse)!.response.output));

  it("compresses tool results before they go upstream while compression is ON, and logs what it saved", async () => {
    const record = vi.fn(async () => undefined);
    const { post, calls, logs, repository } = await setup(() => reply("SPACE_AGY_OK"), { compression: { run, record } });
    await repository.updateSettings({ compressionMode: "ON" });
    const response = await post("/v1internal:streamGenerateContent?alt=sse", toolTurn());
    expect(response.body).toContain("SPACE_AGY_OK");
    expect(outputSent(calls[0]!.body)).toHaveLength(600);
    expect(calls[0]!.body).toMatchObject({ project: "project-a", request: { sessionId: "session-1" } });
    expect((calls[0]!.body!.request as { contents: unknown[] }).contents.slice(0, 2)).toEqual(toolTurn().request.contents.slice(0, 2));
    expect(run).toHaveBeenCalledWith(log, expect.any(Number), expect.objectContaining({ tokenizer: "gemini" }));
    // The session's raw blocks are keyed by its hashed sessionId, like its sticky account.
    const rawBlocks = new RawBlockRegistry();
    const keyed = await setup(() => reply("SPACE_AGY_OK"), { compression: { run: vi.fn(async () => null), cache: new CompressionCache(), record, rawBlocks } });
    await keyed.repository.updateSettings({ compressionMode: "ON" });
    await keyed.post("/v1internal:streamGenerateContent?alt=sse", toolTurn());
    expect(rawBlocks.size).toBe(1);
    await logs.flush();
    const [entry] = await repository.listRequestLogs({ limit: 1 });
    expect(entry).toMatchObject({ provider: "ANTIGRAVITY", status: "success", compressionTokensSaved: Math.ceil(4000 / 3.8) - 158,
      compressionTokensBefore: Math.ceil(4000 / 3.8), compressionTokensAfter: 158, compressionDetail: { strategies: ["log_compressor"] } });
    expect(record).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ provider: "ANTIGRAVITY", mode: "ON", strategy: "log_compressor", blocks: 1 })]));
  });

  it("sends the body unchanged while compression is OFF, or when the client opts out", async () => {
    const record = vi.fn(async () => undefined);
    const { post, calls, logs, repository, app } = await setup(() => reply("SPACE_AGY_OK"), { compression: { run, record } });
    await post("/v1internal:streamGenerateContent?alt=sse", toolTurn());
    expect(calls[0]!.body).toEqual(toolTurn());
    await repository.updateSettings({ compressionMode: "ON" });
    await app.inject({ method: "POST", url: "/antigravity/v1internal:streamGenerateContent?alt=sse", payload: JSON.stringify(toolTurn()),
      headers: { authorization: "Bearer client-a-token", "content-type": "application/json", "x-space-gateway-compression": "off" } });
    expect(calls[1]!.body).toEqual(toolTurn());
    expect(record).not.toHaveBeenCalled();
    await logs.flush();
    for (const entry of await repository.listRequestLogs({ limit: 2 })) expect(entry).toMatchObject({ compressionTokensSaved: null, compressionTokensBefore: null });
  });

  it("adds the provider's output policy to agent turns only, and follows the provider's compression mode", async () => {
    const { post, calls, repository } = await setup(() => reply("ok"));
    await repository.updateSettings({ compressionMode: "ON", compressionProviders: { ANTIGRAVITY: { mode: "OFF", outputPolicy: "LEAN" } } });
    await post("/v1internal:streamGenerateContent?alt=sse", { ...generate(), request: { ...generate().request, systemInstruction: { role: "user", parts: [{ text: "Base." }] } } });
    const parts = (calls[0]!.body!.request as { systemInstruction: { parts: { text: string }[] } }).systemInstruction.parts;
    expect(parts.map((part) => part.text.split("\n")[0])).toEqual(["Base.", "[Space Gateway output policy v1: lean]"]);
    await post("/v1internal:streamGenerateContent?alt=sse", { ...generate("gemini-3.5-flash-lite"), requestType: "checkpoint" });
    expect((calls[1]!.body!.request as { systemInstruction?: unknown }).systemInstruction).toBeUndefined();
  });

  it("claims no savings when no account could take the compressed request", async () => {
    const { post, logs, repository } = await setup(() => quotaError(), { compression: { run, record: vi.fn(async () => undefined) } });
    await repository.updateSettings({ compressionMode: "ON" });
    expect((await post("/v1internal:streamGenerateContent?alt=sse", toolTurn())).statusCode).toBe(429);
    await logs.flush();
    const [entry] = await repository.listRequestLogs({ limit: 1 });
    expect(entry).toMatchObject({ status: "error", accountId: null, compressionTokensSaved: null });
  });
});

describe("Antigravity import", () => {
  it("adds an account from a profile sign-in with its project, plan and quota groups", async () => {
    const repository = new InMemoryGatewayRepository();
    const pool = new AccountPool({ provider: "ANTIGRAVITY", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/token")) return json({ access_token: "fresh", expires_in: 3600 });
      if (url.includes("loadCodeAssist")) return json({ cloudaicompanionProject: "proj-9", paidTier: { id: "g1-pro-tier", name: "Google AI Pro" } });
      return json({ groups: [{ displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.5 }] }] });
    }) as unknown as typeof fetch;
    const app = Fastify();
    registerAntigravitySignInRoutes(app, { repository, pool, cipher: () => cipher, internalToken: "internal", fetchImpl, now: () => nowMs });
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "pro@example.com", sub: "sub-9" })).toString("base64url")}.y`;
    const tokenJson = JSON.stringify({ token: { access_token: "old", refresh_token: "rt-9", expiry: "2029-01-01T00:00:00Z" }, id_token: idToken });
    const call = (token: string) => app.inject({ method: "POST", url: "/__space-gateway/admin/antigravity/import", remoteAddress: "127.0.0.1",
      headers: { "x-space-internal-token": token }, payload: { tokenJson, sourceRef: "google-4" } });
    expect((await call("wrong")).statusCode).toBe(403);
    const response = await call("internal");
    expect(response.json()).toMatchObject({ status: "CONNECTED", account: { provider: "ANTIGRAVITY", label: "pro@example.com", planType: "google-ai-pro" } });
    const [account] = await repository.listAccounts();
    expect(account).toMatchObject({ externalAccountId: "sub-9", sourceRef: "google-4", quotaGroups: [{ key: "gemini", primaryWindow: { usedPercent: 50 } }] });
    expect(JSON.parse(cipher.decrypt(account!.credentialsEncrypted, account!.id))).toMatchObject({ accessToken: "fresh", refreshToken: "rt-9", upstreamAccountId: "proj-9" });
    const test = await antigravityAccountActions({ repository, pool, fetchImpl }).test(account!, {});
    expect(test).toMatchObject({ ok: true, planType: "google-ai-pro" });
  });
});
