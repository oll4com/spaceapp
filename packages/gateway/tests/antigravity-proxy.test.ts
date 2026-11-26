import { createGatewayServer } from "../src/server.js";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { antigravityAccountActions, registerAntigravitySignInRoutes } from "../src/admin/antigravity-sign-in.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { registerAntigravityProxyRoutes, type AntigravityProxyOptions } from "../src/providers/antigravity/antigravity-proxy.js";
import { antigravityModelRequiresPaidPlan, fetchQuotaSummary, parseQuotaSummary, quotaGroupForModel } from "../src/providers/antigravity/code-assist.js";
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

async function setup(upstream: (token: string, path: string, body: Record<string, unknown> | null, signal: AbortSignal | null | undefined) => Response | Promise<Response>, extra: Partial<AntigravityProxyOptions> = {}) {
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
  const calls: { token: string; path: string; body: Record<string, unknown> | null; headers: Record<string, string> }[] = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const token = String((init.headers as Record<string, string>).authorization ?? "").replace("Bearer ", "");
    const path = url.replace("https://code-assist.test", "");
    const body = init.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString("utf8")) as Record<string, unknown> : null;
    calls.push({ token, path, body, headers: init.headers as Record<string, string> });
    return upstream(token, path, body, init.signal);
  }) as unknown as typeof fetch;
  const apiLog: Array<{ reqId: string; event: string }> = [];
  const { app } = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true,
    requestLog: (record) => apiLog.push(record),
    routes: (app) => registerAntigravityProxyRoutes(app, { pool, repository, logs, settings: () => repository.getSettings(), fetchImpl, now: () => nowMs,
    upstreamBaseUrl: "https://code-assist.test", ...extra,
    verifyIdentity: async (token) => (token === "client-a-token" ? { subject: "sub-a", email: "a@example.com", clientId: null }
      : token === "stranger" ? { subject: "sub-x", email: "x@example.com", clientId: null } : null) }) });
  const post = (path: string, body: Record<string, unknown>, token = "client-a-token", headers: Record<string, string> = {}) => app.inject({ method: "POST", url: `/antigravity${path}`,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "user-agent": "antigravity/1.3.1", ...headers }, payload: JSON.stringify(body) });
  return { repository, pool, logs, calls, post, app, apiLog };
}

const generate = (model = "gemini-3.8-flash-high") => ({ project: "project-a", requestId: "r1", model, userAgent: "antigravity", requestType: "agent",
  request: { contents: [{ role: "user", parts: [{ text: "hi" }] }], sessionId: "session-1" } });

it("correlates pooled and passthrough Antigravity CLI calls with the Gateway API id (OBS-006)", async () => {
  const f = await setup(() => { const response = reply("hello"); response.headers.set("x-request-id", "upstream-only-id"); return response; });
  try {
    const ids: string[] = [];
    for (const token of ["client-a-token", "stranger"]) {
      for (const supplied of [`req:antigravity-${token}`, "x".repeat(121), undefined]) {
        const response = await f.post("/v1internal:streamGenerateContent", generate(), token, supplied ? { "x-request-id": supplied } : {});
        expect(response.statusCode).toBe(200);
        const id = String(response.headers["x-request-id"]);
        if (supplied?.startsWith("req:")) expect(id).toBe(supplied);
        else expect(id).toMatch(/^req_[0-9a-f]{32}$/);
        ids.push(id);
      }
    }
    await f.logs.flush();
    expect((await f.repository.listRequestLogs({ limit: 10 })).map((row) => row.requestId).reverse()).toEqual(ids);
    expect(f.apiLog.map((row) => row.reqId)).toEqual(ids);
    expect(f.calls.map((call) => call.headers["x-request-id"])).toEqual(ids);
  } finally { await f.app.close(); }
});

describe("Antigravity helpers", () => {
  it("reads the CLI sign-in file, quota groups, reset hints and the model's quota group", async () => {
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "a@example.com", sub: "sub-a" })).toString("base64url")}.y`;
    expect(parseAntigravityTokenFile(JSON.stringify({ token: { access_token: "at", refresh_token: "rt", expiry: "2030-01-10T01:00:00Z" }, id_token: idToken })))
      .toEqual({ accessToken: "at", refreshToken: "rt", expiresAtMs: Date.parse("2030-01-10T01:00:00Z"), email: "a@example.com", subject: "sub-a" });
    expect(parseAntigravityTokenFile(JSON.stringify({ token: { access_token: "at", refresh_token: "rt", expiry: "2030-01-10T01:00:00Z" }, id_token_email: "b@example.com" })))
      .toEqual({ accessToken: "at", refreshToken: "rt", expiresAtMs: Date.parse("2030-01-10T01:00:00Z"), email: "b@example.com", subject: null });
    expect(() => parseAntigravityTokenFile("{}")).toThrow(/refresh token/);
    expect(parseQuotaSummary({ groups: [
      { displayName: "Gemini Models", buckets: [{ window: "5h", remainingFraction: 0.25, resetTime: "2030-01-10T05:00:00Z" }, { window: "weekly", remainingFraction: 0.9 }] },
      { displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", remainingFraction: 1 }] }
    ] })).toEqual({
      gemini: { fiveHourUsedPercent: 75, fiveHourResetAt: "2030-01-10T05:00:00Z", weeklyUsedPercent: 10, weeklyResetAt: null },
      claude: { fiveHourUsedPercent: 0, fiveHourResetAt: null, weeklyUsedPercent: null, weeklyResetAt: null },
      argon: { fiveHourUsedPercent: null, fiveHourResetAt: null, weeklyUsedPercent: null, weeklyResetAt: null }
    });
    const parsedWithArgon = parseQuotaSummary({ groups: [
      { displayName: "Gemini 4 Argon", buckets: [{ bucketId: "gemini-argon-wtu-weekly", window: "weekly", remainingFraction: 0, resetTime: "2030-01-12T00:00:00Z" }] },
      { displayName: "Gemini Models", buckets: [{ bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.99, resetTime: "2030-01-15T00:00:00Z" }] }
    ] });
    expect(parsedWithArgon.gemini).toEqual({ fiveHourUsedPercent: null, fiveHourResetAt: null, weeklyUsedPercent: 1, weeklyResetAt: "2030-01-15T00:00:00Z" });
    expect(parsedWithArgon.argon).toEqual({ fiveHourUsedPercent: null, fiveHourResetAt: null, weeklyUsedPercent: 100, weeklyResetAt: "2030-01-12T00:00:00Z" });
    expect(parseQuotaSummary(
      { groups: [{ displayName: "Claude and GPT models", buckets: [{ bucketId: "3p-5h", remainingFraction: 1 }] }] },
      { buckets: [{ modelId: "gemini-3.8-flash-tiered", remainingFraction: 0.962, resetTime: "2030-01-10T04:00:00Z" }] },
      Date.parse("2030-01-10T00:00:00Z")
    ).gemini).toEqual({ fiveHourUsedPercent: 3.8, fiveHourResetAt: "2030-01-10T04:00:00Z", weeklyUsedPercent: null, weeklyResetAt: null });
    const agents: string[] = [];
    await fetchQuotaSummary("at", "project-a", { fetchImpl: (async (_url: string, init: RequestInit) => {
      agents.push((init.headers as Record<string, string>)["user-agent"]);
      return new Response(JSON.stringify({ groups: [] }));
    }) as typeof fetch });
    expect(agents[0]).toMatch(/^antigravity\/cli\/\d+\.\d+\.\d+$/);
    expect(parseResetsIn("Individual quota reached. Resets in 4h3m17s.")).toBe(4 * 3600 + 3 * 60 + 17);
    expect(quotaGroupForModel("claude-opus-5-5-high")).toBe("claude");
    expect(quotaGroupForModel("gemini-3.8-flash-high")).toBe("gemini");
    expect(quotaGroupForModel("gemini-4-argon-high")).toBe("argon");
    // Operator 22/11 c74c7453: Gemini 4 Neon draws on the Gemini group (Google reports no Neon group), never on Argon's.
    expect(quotaGroupForModel("gemini-4-neon-high")).toBe("gemini");
    expect(quotaGroupForModel("gemini-pro-orchestrator-g1-pro")).toBe("argon");
    expect(antigravityModelRequiresPaidPlan("gemini-4-argon-high")).toBe(true);
    expect(antigravityModelRequiresPaidPlan("gemini-4-hydrogen-high")).toBe(true);
    expect(antigravityModelRequiresPaidPlan("gemini-4-neon-high")).toBe(true);
    expect(antigravityModelRequiresPaidPlan("claude-opus-5-5-high")).toBe(true);
    expect(antigravityModelRequiresPaidPlan("claude-sonnet-5-5-medium")).toBe(true);
    expect(antigravityModelRequiresPaidPlan("gemini-pro-orchestrator-g1-pro")).toBe(true);
    expect(antigravityModelRequiresPaidPlan("gemini-4-hydrogen-sonar")).toBe(false);
    expect(antigravityModelRequiresPaidPlan("gemini-3.8-flash-high")).toBe(false);
    expect(antigravityModelRequiresPaidPlan("claude-sonnet-4-6")).toBe(false);
    expect(antigravityModelRequiresPaidPlan("gpt-oss-120b-medium")).toBe(false);
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
  it.each(["before headers", "during the body"])("cancels a Nous upstream request %s without trying another pooled account", async (phase) => {
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    let upstreamAborted = false;
    const { app, calls, logs, repository } = await setup((_token, _path, _body, signal) => new Promise<Response>((resolve, reject) => {
      let body: ReadableStreamDefaultController<Uint8Array> | null = null;
      const stop = (error: Error) => { if (body) body.error(error); else reject(error); };
      const fallback = setTimeout(() => stop(new Error("The client failed to cancel its upstream request.")), 2_000);
      signal!.addEventListener("abort", () => { upstreamAborted = true; clearTimeout(fallback); stop(new DOMException("Cancelled", "AbortError")); }, { once: true });
      if (phase === "during the body") resolve(new Response(new ReadableStream<Uint8Array>({ start(controller) { body = controller; } }), { headers: { "content-type": "application/json" } }));
      began();
    }));
    const controller = new AbortController();
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const pending = fetch(`http://127.0.0.1:${port}/antigravity/v1internal:generateContent`, {
      method: "POST", signal: controller.signal,
      headers: { authorization: "Bearer client-a-token", "content-type": "application/json", "x-space-gateway-require-pool": "true" },
      body: JSON.stringify(generate())
    });
    try {
      await started;
      controller.abort();
      await expect(pending).rejects.toThrow();
      await vi.waitFor(() => expect(upstreamAborted).toBe(true));
      await logs.flush();
      expect(calls).toHaveLength(1);
      expect(await repository.listRequestLogs({ limit: 5 })).toEqual([expect.objectContaining({ errorCode: "client_closed", accountId: accountA })]);
    } finally { controller.abort(); await pending.catch(() => undefined); await app.close(); }
  }, 15_000); // a real local server and fetch: the 5 s default timed out on a loaded host

  it("keeps Nous model requests inside the pool and strips private routing/project headers upstream", async () => {
    const { app, calls, logs, repository } = await setup(() => reply("pooled"));
    const headers = { authorization: "Bearer stranger", "content-type": "application/json", "x-space-gateway-require-pool": "true", "x-space-project": "nous" };
    const outside = await app.inject({ method: "POST", url: "/antigravity/v1internal:generateContent", headers, payload: JSON.stringify(generate()) });
    expect(outside.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
    const accountCall = await app.inject({ method: "POST", url: "/antigravity/v1internal:loadCodeAssist", headers, payload: "{}" });
    expect(accountCall.statusCode).toBe(400);
    const malformed = await app.inject({ method: "POST", url: "/antigravity/v1internal:generateContent",
      headers: { ...headers, authorization: "Bearer client-a-token" }, payload: "{" });
    expect(malformed.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
    const pooled = await app.inject({ method: "POST", url: "/antigravity/v1internal:generateContent",
      headers: { ...headers, authorization: "Bearer client-a-token" }, payload: JSON.stringify(generate()) });
    expect(pooled.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ token: "token-a", body: { project: "project-a" } });
    expect(calls[0]!.headers["x-space-project"]).toBeUndefined();
    expect(calls[0]!.headers["x-space-gateway-require-pool"]).toBeUndefined();
    await logs.flush();
    expect(await repository.listRequestLogs({ limit: 5 })).toEqual([expect.objectContaining({ project: "nous", accountId: accountA })]);
  });

  it("keeps a previously verified pooled token working if tokeninfo fails after the 10-minute cache window", async () => {
    let clock = nowMs;
    let tokenInfoUp = true;
    const { app, calls } = await setup(() => reply("pooled"), {
      now: () => clock,
      verifyIdentity: async (token) => (tokenInfoUp && token === "client-a-token" ? { subject: "sub-a", email: "a@example.com", clientId: null } : null)
    });
    const headers = { authorization: "Bearer client-a-token", "content-type": "application/json", "x-space-gateway-require-pool": "true", "x-space-project": "nous-operator" };
    expect((await app.inject({ method: "POST", url: "/antigravity/v1internal:generateContent", headers, payload: JSON.stringify(generate()) })).statusCode).toBe(200);
    // 10m01s later (mid-turn), tokeninfo fails or the client token expired, but the already-verified token stays pooled instead of failing with 403.
    clock += 10 * 60_000 + 1_000;
    tokenInfoUp = false;
    expect((await app.inject({ method: "POST", url: "/antigravity/v1internal:generateContent", headers, payload: JSON.stringify(generate()) })).statusCode).toBe(200);
    expect(calls).toHaveLength(2);
    await app.close();
  });

  it("tags a pane CLI's calls with the pane its base URL names, and sends the path upstream without it", async () => {
    const { post, calls, logs, repository } = await setup(() => reply("pooled"));
    expect((await post("/project/pane:abc_DEF-1/v1internal:streamGenerateContent?alt=sse", generate())).statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ path: "/v1internal:streamGenerateContent?alt=sse" });
    expect(calls[0]!.headers["x-space-project"]).toBeUndefined();
    // Only a pane id names a project; anything else is passed on as the path it is.
    await post("/project/nous/v1internal:loadCodeAssist", {});
    expect(calls[1]!.path).toBe("/project/nous/v1internal:loadCodeAssist");
    await logs.flush();
    expect((await repository.listRequestLogs({ limit: 5 })).map((log) => log.project)).toContain("pane:abc_DEF-1");
  });

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

  it("takes an account Google disabled for Terms of Service out of rotation and logs why the last call failed (25/11)", async () => {
    const tosError = () => json({ error: { code: 403, message: "This service has been disabled in this account for violation of Terms of Service. Please submit an appeal to continue using this product.",
      status: "PERMISSION_DENIED" } }, 403);
    const { post, calls, repository } = await setup((token) => (token === "token-a" ? tosError() : reply("from b")));
    expect((await post("/v1internal:streamGenerateContent?alt=sse", generate())).body).toContain("from b");
    const a = (await repository.listAccounts()).find((account) => account.id === accountA)!;
    expect(a).toMatchObject({ status: "DEACTIVATED", statusReason: "Account has been suspended" });
    await post("/v1internal:streamGenerateContent?alt=sse", { ...generate(), request: { contents: [], sessionId: "session-2" } });
    expect(calls.map((call) => call.token)).toEqual(["token-a", "token-b", "token-b"]);

    const both = await setup(() => tosError());
    expect((await both.post("/v1internal:streamGenerateContent?alt=sse", generate())).statusCode).toBe(403);
    await both.logs.flush();
    const [last] = await both.repository.listRequestLogs({ limit: 1 });
    expect(last).toMatchObject({ status: "error", errorCode: "http_403" });
    expect(last!.errorMessage).toContain("violation of Terms of Service");
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

  it("passes an account switched off through with its own sign-in and project, never another pool account's (25/11)", async () => {
    const { post, calls, repository, pool, app } = await setup(() => reply("own account"));
    await repository.setAccountStatus(accountA, "PAUSED", "Paused by an administrator.");
    pool.invalidate();
    const own = await post("/v1internal:streamGenerateContent?alt=sse", { ...generate(), project: "own-project" });
    expect(own.body).toContain("own account");
    expect(calls).toEqual([expect.objectContaining({ token: "client-a-token", body: expect.objectContaining({ project: "own-project" }) })]);
    await app.close();
  });

  it("lists a pooled client's models from a pool account, a stranger's from its own (3/11: Claude Opus 4.6 retired on the pool only)", async () => {
    const { post, calls, app } = await setup((token) => json({ models: { [token === "client-a-token" || token === "stranger" ? "claude-opus-4-6-thinking" : "claude-opus-5-5-high"]: {} } }));
    const pooled = await post("/v1internal:fetchAvailableModels", { project: "own-project" });
    expect(pooled.json()).toEqual({ models: { "claude-opus-5-5-high": {} } });
    expect(calls[0]).toMatchObject({ token: expect.stringMatching(/^token-[ab]$/), body: { project: expect.stringMatching(/^project-[ab]$/) } });
    const stranger = await post("/v1internal:fetchAvailableModels", { project: "project-x" }, "stranger");
    expect(stranger.json()).toEqual({ models: { "claude-opus-4-6-thinking": {} } });
    expect(calls[1]).toMatchObject({ token: "stranger", body: { project: "project-x" } });
    await app.close();
  });

  it("routes fetchAvailableModels and Pro-only models through paid accounts even when a free account has lower usage or owns the sticky session", async () => {
    const { post, calls, repository, pool, app } = await setup((token, path) => {
      if (path.includes("fetchAvailableModels")) {
        return json({ models: token === "token-a" ? { "gemini-3.8-flash-high": {} } : { "gemini-4-argon-high": {}, "gemini-3.8-flash-high": {} } });
      }
      return token === "token-a" ? json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404) : reply("PRO_OK");
    });
    const a = (await repository.listAccounts()).find((item) => item.id === accountA)!;
    await repository.upsertAccount({
      accountId: a.id, provider: "ANTIGRAVITY", label: a.label, email: a.email, externalAccountId: a.externalAccountId,
      planType: "free", credentialsEncrypted: a.credentialsEncrypted, credentialsExpiresAt: null, source: "PROFILE_ADOPTION", sourceRef: "a", lastRefreshAt: null
    });
    await repository.saveUsageWindows(accountA, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 0, resetAt: null, windowMinutes: 300 },
      { quotaKey: "claude", window: "PRIMARY", usedPercent: 0, resetAt: null, windowMinutes: 300 }
    ]);
    pool.invalidate();

    // fetchAvailableModels must use the paid account (token-b) so the CLI lists gemini-4-argon-high, even when the paid account's quota is at 100%.
    await repository.saveUsageWindows(accountB, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 },
      { quotaKey: "claude", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 }
    ]);
    pool.invalidate();
    const models = await post("/v1internal:fetchAvailableModels", { project: "own-project" });
    expect(models.json()).toEqual({ models: { "gemini-4-argon-high": {}, "gemini-3.8-flash-high": {} } });
    expect(calls[0]).toMatchObject({ token: "token-b", body: { project: "project-b" } });

    await repository.saveUsageWindows(accountB, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 40, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 },
      { quotaKey: "claude", window: "PRIMARY", usedPercent: 40, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 }
    ]);
    pool.invalidate();

    // Even if a session was previously sticky to the free account (accountA), switching to gemini-4-argon-high routes to the paid account (accountB).
    const argon = await post("/v1internal:streamGenerateContent?alt=sse", generate("gemini-4-argon-high"));
    expect(argon.statusCode).toBe(200);
    expect(argon.body).toContain("PRO_OK");
    expect(calls[1]).toMatchObject({ token: "token-b", body: { project: "project-b", model: "gemini-4-argon-high" } });
    await app.close();
  });

  it("unpins a session stuck on a free account that lacks claude-opus-5-5-high and keeps the Pro catalog on fetchAvailableModels refreshes (Max)", async () => {
    const { post, calls, repository, pool, app } = await setup((token, path, body) => {
      if (path.includes("fetchAvailableModels")) {
        return json({
          models: token === "token-a"
            ? { "claude-opus-4-6-thinking": {}, "gemini-3.8-flash-high": {} }
            : { "claude-opus-5-5-high": {}, "gemini-4-argon-high": {}, "gemini-3.8-flash-high": {} }
        });
      }
      if (token === "token-a" && body?.model === "claude-opus-5-5-high") {
        return json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404);
      }
      return reply(token === "token-b" ? "OPUS_PRO_OK" : "FREE_OK");
    });
    const [a, b] = await Promise.all([
      repository.listAccounts().then((items) => items.find((item) => item.id === accountA)!),
      repository.listAccounts().then((items) => items.find((item) => item.id === accountB)!)
    ]);
    await repository.upsertAccount({
      accountId: a.id, provider: "ANTIGRAVITY", label: a.label, email: a.email, externalAccountId: a.externalAccountId,
      planType: "free", credentialsEncrypted: a.credentialsEncrypted, credentialsExpiresAt: null, source: "PROFILE_ADOPTION", sourceRef: "a", lastRefreshAt: null
    });
    await repository.upsertAccount({
      accountId: b.id, provider: "ANTIGRAVITY", label: b.label, email: b.email, externalAccountId: b.externalAccountId,
      planType: "google-ai-pro", credentialsEncrypted: b.credentialsEncrypted, credentialsExpiresAt: null, source: "PROFILE_ADOPTION", sourceRef: "b", lastRefreshAt: null
    });
    // Pin session-1 to the free account first while the Pro account is temporarily exhausted on gemini.
    await repository.saveUsageWindows(accountA, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 0, resetAt: null, windowMinutes: 300 },
      { quotaKey: "claude", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-16T00:00:00Z", windowMinutes: 300 },
      { quotaKey: "claude", window: "SECONDARY", usedPercent: 0, resetAt: "2030-01-16T00:00:00Z", windowMinutes: 10080 }
    ]);
    await repository.saveUsageWindows(accountB, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 },
      { quotaKey: "claude", window: "PRIMARY", usedPercent: 2, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 },
      { quotaKey: "claude", window: "SECONDARY", usedPercent: 1, resetAt: "2030-01-16T00:00:00Z", windowMinutes: 10080 }
    ]);
    pool.invalidate();
    const pinned = await post("/v1internal:streamGenerateContent?alt=sse", generate("gemini-3.8-flash-high"));
    expect(pinned.statusCode).toBe(200);
    expect(calls[0]).toMatchObject({ token: "token-a", body: { project: "project-a", model: "gemini-3.8-flash-high" } });

    // Switching the pinned session to claude-opus-5-5-high bypasses the free account (never hitting 404) and moves sticky to the Pro account.
    const opus = await post("/v1internal:streamGenerateContent?alt=sse", generate("claude-opus-5-5-high"));
    expect(opus.statusCode).toBe(200);
    expect(opus.body).toContain("OPUS_PRO_OK");
    expect(calls[1]).toMatchObject({ token: "token-b", body: { project: "project-b", model: "claude-opus-5-5-high" } });

    // Periodic 6-minute fetchAvailableModels refreshes still read from the Pro account so claude-opus-5-5-high never becomes MODEL_PLACEHOLDER_M402.
    const refreshed = await post("/v1internal:fetchAvailableModels", { project: "project-a" });
    expect(refreshed.json()).toEqual({ models: { "claude-opus-5-5-high": {}, "gemini-4-argon-high": {}, "gemini-3.8-flash-high": {} } });
    expect(calls[2]).toMatchObject({ token: "token-b", body: { project: "project-b" } });
    await app.close();
  });

  it("moves a session pinned to a free account with a 166h weekly quota error to a Pro account at 1-3% without cycling through other free accounts (Emma)", async () => {
    const weeklyQuotaError = () => json({
      error: {
        code: 429,
        message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 166h59m16s.",
        status: "RESOURCE_EXHAUSTED"
      }
    }, 429);
    let freeExhausted = false;
    const { post, calls, repository, pool, app } = await setup((token) => {
      if (token.startsWith("token-free") || (token === "token-a" && freeExhausted)) return weeklyQuotaError();
      return reply(token === "token-b" ? "PRO_FLASH_OK" : "FREE_FLASH_OK");
    });
    const [a, b] = await Promise.all([
      repository.listAccounts().then((items) => items.find((item) => item.id === accountA)!),
      repository.listAccounts().then((items) => items.find((item) => item.id === accountB)!)
    ]);
    await repository.upsertAccount({
      accountId: a.id, provider: "ANTIGRAVITY", label: a.label, email: a.email, externalAccountId: a.externalAccountId,
      planType: "free", credentialsEncrypted: a.credentialsEncrypted, credentialsExpiresAt: null, source: "PROFILE_ADOPTION", sourceRef: "a", lastRefreshAt: null
    });
    await repository.upsertAccount({
      accountId: b.id, provider: "ANTIGRAVITY", label: b.label, email: b.email, externalAccountId: b.externalAccountId,
      planType: "google-ai-pro", credentialsEncrypted: b.credentialsEncrypted, credentialsExpiresAt: null, source: "PROFILE_ADOPTION", sourceRef: "b", lastRefreshAt: null
    });
    // Add four more free accounts so the pool has 5 free accounts and 1 Pro account, matching live public-host.
    for (const idx of ["1", "2", "3", "4"]) {
      const freeId = `gw_account:${idx.repeat(32)}`;
      const creds: StoredCredentials = { accessToken: `token-free-${idx}`, refreshToken: "rt", idToken: null, upstreamAccountId: `project-free-${idx}`, accessExpiresAtMs: null };
      await repository.upsertAccount({
        accountId: freeId, provider: "ANTIGRAVITY", label: `free${idx}@example.com`, email: `free${idx}@example.com`, externalAccountId: `sub-free-${idx}`,
        planType: "free", credentialsEncrypted: cipher.encrypt(JSON.stringify(creds), freeId), credentialsExpiresAt: null,
        source: "PROFILE_ADOPTION", sourceRef: `free-${idx}`, lastRefreshAt: null
      });
      await repository.saveUsageWindows(freeId, [
        { quotaKey: "gemini", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-16T22:59:16Z", windowMinutes: 300 },
        { quotaKey: "gemini", window: "SECONDARY", usedPercent: 99.2, resetAt: "2030-01-16T22:59:16Z", windowMinutes: 10080 }
      ]);
    }
    // Pin session-1 to accountA (free) while accountB (Pro) is temporarily at 100%, then restore accountB (Pro) to 2% used.
    await repository.saveUsageWindows(accountA, [{ quotaKey: "gemini", window: "SECONDARY", usedPercent: 10, resetAt: "2030-01-16T00:00:00Z", windowMinutes: 10080 }]);
    await repository.saveUsageWindows(accountB, [{ quotaKey: "gemini", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 }]);
    pool.invalidate();
    expect((await post("/v1internal:streamGenerateContent?alt=sse", generate("gemini-3.8-flash-high"))).body).toContain("FREE_FLASH_OK");
    expect(calls[0]).toMatchObject({ token: "token-a", body: { project: "project-a" } });

    // Pro account sits at 1-3% while the pinned free account hits "Individual quota reached ... Resets in 166h59m16s".
    freeExhausted = true;
    await repository.saveUsageWindows(accountB, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 2, resetAt: "2030-01-10T05:00:00Z", windowMinutes: 300 },
      { quotaKey: "gemini", window: "SECONDARY", usedPercent: 1, resetAt: "2030-01-16T00:00:00Z", windowMinutes: 10080 }
    ]);
    pool.invalidate();

    const failovered = await post("/v1internal:streamGenerateContent?alt=sse", generate("gemini-3.8-flash-high"));
    expect(failovered.statusCode).toBe(200);
    expect(failovered.body).toContain("PRO_FLASH_OK");
    // Fails over directly from the sticky free account (token-a) to the Pro account (token-b) without touching the other 4 free accounts.
    expect(calls.slice(1).map((call) => call.token)).toEqual(["token-a", "token-b"]);
    const updatedA = (await repository.listAccounts()).find((item) => item.id === accountA)!;
    const expectedReset = new Date(nowMs + (166 * 3600 + 59 * 60 + 16) * 1000).toISOString();
    expect(updatedA.quotaGroups?.find((g) => g.key === "gemini")).toMatchObject({
      primaryWindow: { usedPercent: 100, resetAt: expectedReset },
      secondaryWindow: { usedPercent: 100, resetAt: expectedReset }
    });

    // Subsequent turns (even if retrieveUserQuota later reports 99.2% weekly on the free account) go straight to the Pro account.
    await repository.saveUsageWindows(accountA, [
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 100, resetAt: expectedReset, windowMinutes: 300 },
      { quotaKey: "gemini", window: "SECONDARY", usedPercent: 99.2, resetAt: expectedReset, windowMinutes: 10080 }
    ]);
    pool.invalidate();
    const nextTurn = await post("/v1internal:streamGenerateContent?alt=sse", generate("gemini-3.8-flash-high"));
    expect(nextTurn.statusCode).toBe(200);
    expect(calls.at(-1)).toMatchObject({ token: "token-b", body: { project: "project-b" } });
    await app.close();
  });

  it("automatically hands over from Argon to Hydrogen when Argon limits are reached so no pane gets stuck", async () => {
    const { post, calls, repository, pool, app } = await setup((token, path, body) => {
      if (body?.model === "gemini-4-argon-high") {
        return json({ error: { code: 404, message: "Requested entity was not found.", status: "NOT_FOUND" } }, 404);
      }
      return reply(body?.model === "gemini-4-hydrogen-high" ? "HYDROGEN_OK" : "DEFAULT_OK");
    });
    await repository.saveUsageWindows(accountB, [
      { quotaKey: "argon", window: "PRIMARY", usedPercent: 100, resetAt: "2030-01-12T00:00:00Z", windowMinutes: 300 },
      { quotaKey: "gemini", window: "PRIMARY", usedPercent: 20, resetAt: null, windowMinutes: 300 }
    ]);
    pool.invalidate();

    const response = await post("/v1internal:streamGenerateContent?alt=sse", generate("gemini-4-argon-high"));
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("HYDROGEN_OK");
    expect(calls.some((call) => call.body.model === "gemini-4-hydrogen-high")).toBe(true);
    await app.close();
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

    // Re-importing with Antigravity 1.5.x `id_token_email` matches the existing `sub`-keyed account and unpauses free-plan auto-pause.
    await repository.setAccountStatus(account!.id, "PAUSED", "Free plan: paused automatically and never used. Sign in again on a paid plan, then resume.");
    const emailOnlyTokenJson = JSON.stringify({ token: { access_token: "old", refresh_token: "rt-9", expiry: "2029-01-01T00:00:00Z" }, id_token_email: "pro@example.com" });
    const reimported = await app.inject({ method: "POST", url: "/__space-gateway/admin/antigravity/import", remoteAddress: "127.0.0.1",
      headers: { "x-space-internal-token": "internal" }, payload: { tokenJson: emailOnlyTokenJson, sourceRef: "google-4" } });
    expect(reimported.json()).toMatchObject({ status: "CONNECTED", account: { id: account!.id, status: "ACTIVE", planType: "google-ai-pro" } });
    expect(await repository.listAccounts()).toHaveLength(1);
  });
});
