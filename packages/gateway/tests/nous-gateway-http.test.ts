import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { InMemoryGatewayRepository } from "@space/db";
import { disposablePostgresUnavailableReason, startDisposablePostgres, type DisposablePostgres } from "../../db/tests/support/disposable-postgres.js";
import { AccountPool, type StoredCredentials } from "../src/accounts/account-pool.js";
import { createCredentialCipher } from "../src/credential-cipher.js";
import { claudeCostUsd, geminiCostUsd } from "../src/pricing/pricing.js";
import { registerAntigravityProxyRoutes } from "../src/providers/antigravity/antigravity-proxy.js";
import { registerClaudeProxyRoutes } from "../src/providers/claude/claude-proxy.js";
import { RequestLogWriter } from "../src/request-log-writer.js";
import { createGatewayServer } from "../src/server.js";
import { stickyScope } from "../src/proxy-util.js";
import { createNousTenancy, onNousSurface, tenantRoute } from "../src/nous/http.js";
import { openTenantPeriod } from "../src/nous/ledger.js";
import { createNgwMetrics } from "../src/nous/metrics.js";
import { createSwitchReader, SWITCH_CHANGED, type SwitchReader } from "../src/nous/switches.js";
import { NGW_SCHEMA_SQL, ngwAppGrantsSql } from "../src/nous/schema.js";
import { createTenantKeyResolver, issueTenantKey, type TenantKeyResolver } from "../src/nous/tenant-keys.js";

// NGW_MODE=nous request path (K5-http): the real server, the real Claude proxy with a mocked upstream, the ledger on a disposable PostgreSQL.
const unavailable = disposablePostgresUnavailableReason();
const cipher = createCredentialCipher(Buffer.alloc(32, 7));
const DAY = 86_400_000;
const paidA = `gw_account:${"a".repeat(32)}`, paidB = `gw_account:${"b".repeat(32)}`, trial = `gw_account:${"t".repeat(32)}`, codex = `gw_account:${"c".repeat(32)}`;
const gemini = `gw_account:${"g".repeat(32)}`;
const geminiReply = () => Response.json({ response: { candidates: [{ content: { role: "model", parts: [{ text: "Hi" }] }, finishReason: "STOP" }],
  usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, totalTokenCount: 120 }, modelVersion: "gemini-3.8-flash" } });
const usage = { input_tokens: 100, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 300, output_tokens: 50 };
const sse = (...events: Record<string, unknown>[]) => events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
const reply = () => new Response(sse(
  { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5", usage: { ...usage, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 50 } },
  { type: "message_stop" }), { status: 200, headers: { "content-type": "text/event-stream" } });

describe("tenant routes", () => {
  it("serves only the metered model routes and token counting; sticky bindings are scoped by tenant", () => {
    expect(tenantRoute("POST", "/v1/messages?beta=true")).toEqual({ provider: "CLAUDE", metered: true });
    expect(tenantRoute("POST", "/backend-api/codex/responses")).toEqual({ provider: "CODEX", metered: true });
    expect(tenantRoute("POST", "/v1/messages/count_tokens")).toEqual({ provider: "CLAUDE", metered: false });
    expect(tenantRoute("POST", "/v1internal:streamGenerateContent?alt=sse")).toEqual({ provider: "GEMINI", metered: true });
    for (const [method, url] of [["POST", "/v1/embeddings"], ["GET", "/v1/models"], ["POST", "/v1/chat/completions"], ["GET", "/__space-gateway/status"]]) {
      expect(tenantRoute(method!, url!)).toBeNull();
    }
    // K5-listener/profile: the replica's whole surface; the Antigravity pass-through, weekly-remaining and stats are not on it.
    for (const [method, url] of [["GET", "/v1/models"], ["GET", "/readyz"], ["GET", "/health"], ["POST", "/__space-gateway/admin/reload"], ["POST", "/stripe/webhook"]]) {
      expect(onNousSurface(method!, url!, false)).toBe(true);
    }
    expect(onNousSurface("GET", "/backend-api/codex/responses", true)).toBe(true); // answered 426, so the CLI falls back to HTTP
    for (const [method, url] of [["POST", "/antigravity/v1internal:generateContent"], ["GET", "/api/codex/weekly-remaining"], ["GET", "/stats"],
      ["POST", "/v1/embeddings"], ["GET", "/backend-api/codex/models"], ["GET", "/stripe/webhook"]]) {
      expect(onNousSurface(method!, url!, false)).toBe(false);
    }
    expect(stickyScope({})).toBe("");
    expect(stickyScope({ ngwTenantId: "t1" })).not.toBe(stickyScope({ ngwTenantId: "t2" }));
  });
});

describe.skipIf(unavailable)("NGW_MODE=nous HTTP path: tenant key, pool scope, admission and settlement", () => {
  let server: DisposablePostgres;
  let ops: pg.Pool, app: pg.Pool;
  let resolver: TenantKeyResolver;
  let switches: SwitchReader;
  const periodStart = new Date(Math.floor(Date.now() / DAY) * DAY);

  beforeAll(async () => {
    server = await startDisposablePostgres("ngw-http");
    await server.createDatabase("ngw_http");
    ops = server.pool("ngw_http", 4);
    await ops.query(NGW_SCHEMA_SQL);
    await ops.query("CREATE ROLE ngw_app LOGIN");
    await ops.query(ngwAppGrantsSql("ngw_app"));
    app = new pg.Pool({ host: server.socketDir, user: "ngw_app", database: "ngw_http", max: 10 });
    app.on("error", () => {});
    resolver = await createTenantKeyResolver(app);
    switches = await createSwitchReader(app);
    await ops.query(`INSERT INTO ngw_account_pools (account_id, pool, five_hour_capacity_micros) VALUES ($1, 'eu1:paid', 400000000),
      ($2, 'eu1:paid', 400000000), ($3, 'eu1:trial', 400000000), ($4, 'eu1:paid', 400000000), ($5, 'eu1:paid', 400000000)`, [paidA, paidB, trial, codex, gemini]);
  }, 120_000);

  afterAll(async () => {
    await resolver?.close();
    await switches?.close();
    await app?.end();
    await server?.stop();
  }, 60_000);

  async function gateway(upstream: (token: string, url: string) => Response, used: { claude?: number; codex?: number } = {}) {
    const repository = new InMemoryGatewayRepository();
    const resetAt = new Date(Date.now() + 2 * 3_600_000).toISOString();
    for (const [accountId, provider, percent] of [[trial, "CLAUDE", 1], [paidA, "CLAUDE", used.claude ?? 10], [paidB, "CLAUDE", used.claude ?? 50],
      [codex, "CODEX", used.codex ?? 10], [gemini, "ANTIGRAVITY", 10]] as const) {
      const credentials: StoredCredentials = { accessToken: `token-${accountId}`, refreshToken: "rt", idToken: null, upstreamAccountId: accountId, accessExpiresAtMs: null };
      await repository.upsertAccount({ accountId, provider, label: accountId, email: null, externalAccountId: accountId, planType: "max5x",
        credentialsEncrypted: cipher.encrypt(JSON.stringify(credentials), accountId), credentialsExpiresAt: null, source: "OAUTH", sourceRef: null,
        lastRefreshAt: new Date().toISOString() });
      await repository.saveUsageWindows(accountId, [{ ...(provider === "ANTIGRAVITY" ? { quotaKey: "gemini" } : {}), window: "PRIMARY", usedPercent: percent,
        resetAt: percent >= 100 ? resetAt : null, windowMinutes: 300 }]);
    }
    const claudePool = new AccountPool({ provider: "CLAUDE", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const codexPool = new AccountPool({ provider: "CODEX", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const geminiPool = new AccountPool({ provider: "ANTIGRAVITY", repository, cipher: () => cipher, refresher: { needsRefresh: () => false, refresh: vi.fn() } });
    const metrics = createNgwMetrics();
    const tenancy = createNousTenancy({ db: app, resolver, region: "eu1", metrics, switches, pools: { CLAUDE: claudePool, CODEX: codexPool,
      GEMINI: { accounts: () => geminiPool.accounts(), toBalancerState: (account) => geminiPool.toBalancerState(account, "gemini") } } });
    const logs = new RequestLogWriter(repository, { intervalMs: 1, transform: tenancy.logRow });
    const tokens: string[] = [];
    const sent: Record<string, string>[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const token = (init.headers as Record<string, string>).authorization!.replace("Bearer ", "");
      tokens.push(token);
      sent.push(init.headers as Record<string, string>);
      return upstream(token, url);
    }) as unknown as typeof fetch;
    const gw = createGatewayServer({ repository, version: "test", credentialKeyPresent: () => true, tenancy,
      routes: (fastify, helpers) => { registerClaudeProxyRoutes(fastify, helpers, { pool: claudePool, logs, settings: () => repository.getSettings(), fetchImpl,
        upstreamBaseUrl: "https://claude.test" });
        registerAntigravityProxyRoutes(fastify, { pool: geminiPool, repository, logs, settings: () => repository.getSettings(), fetchImpl,
          upstreamBaseUrl: "https://codeassist.test", tenant: helpers });
        fastify.get("/stats", async () => ({ shown: "to anyone" })); } });
    const post = (key: string, url = "/v1/messages", headers: Record<string, string> = {}, model = "claude-sonnet-5-5") => gw.app.inject({ method: "POST", url,
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", ...headers }, payload: { model, max_tokens: 64, stream: true, messages: [{ role: "user", content: "hi" }] } });
    return { repository, logs, tokens, sent, post, tenancy, metrics, app: gw.app };
  }
  const tenant = async (tenantId: string, allowanceMicros: number, extra: { region?: string; plan?: "PERSONAL" | "TRIAL" | "ULTRA" } = {}) => {
    const issued = await issueTenantKey(ops, { tenantId, actor: "test", plan: extra.plan ?? "PERSONAL", region: extra.region ?? "eu1", riskTier: "TRUSTED" });
    await openTenantPeriod(ops, { tenantId, start: periodStart, end: new Date(periodStart.getTime() + 30 * DAY), allowanceMicros });
    return issued.plainKey;
  };
  const period = async (tenantId: string) => (await ops.query("SELECT spent_micros::int AS spent, reserved_micros::int AS reserved FROM ngw_tenant_period WHERE tenant_id = $1",
    [tenantId])).rows[0] as { spent: number; reserved: number };
  const settled = async (tenantId: string) => {
    for (let i = 0; i < 200; i += 1) {
      if ((await ops.query("SELECT 1 FROM ngw_usage WHERE tenant_id = $1", [tenantId])).rowCount) return period(tenantId);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("not settled");
  };

  it("streams a tenant's turn on an account of its own pool and settles the list cost on the ledger", async () => {
    const gw = await gateway(() => reply());
    const key = await tenant("t-ok", 50_000_000);
    const res = await gw.post(key);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("message_stop");
    expect(gw.tokens.every((token) => token === `token-${paidA}` || token === `token-${paidB}`)).toBe(true); // never the trial pool's account
    const cost = Math.round(claudeCostUsd({ inputTokens: 100, cacheReadInputTokens: 2_000, cacheCreationInputTokens: 300, outputTokens: 50 }, "claude-sonnet-5-5")! * 1e6);
    expect(await settled("t-ok")).toEqual({ spent: cost, reserved: 0 });
    const usageRow = (await ops.query("SELECT * FROM ngw_usage WHERE tenant_id = 't-ok'")).rows[0];
    expect(usageRow).toMatchObject({ status: "OK", input_tokens: "100", cached_input_tokens: "2000", cache_write_tokens: "300", output_tokens: "50" });
    await gw.logs.flush();
    const [log] = await gw.repository.listRequestLogs({ limit: 5 } as never);
    expect(log).toMatchObject({ apiKeyId: null, requestId: usageRow.request_id });
    expect(usageRow.request_id).toMatch(/^ngwreq:t-ok:[0-9a-f-]{36}$/);
    // K5-metrics: outcomes, settled list value per plan, first-token time and the pool accounts; never a tenant.
    const text = gw.metrics.render(await gw.tenancy.gauges());
    expect(text).toContain('ngw_requests_total{provider="CLAUDE",outcome="admitted"} 1');
    expect(text).toContain('ngw_requests_total{provider="CLAUDE",outcome="answered"} 1');
    expect(text).toContain(`ngw_settled_micros_total{plan="PERSONAL",provider="CLAUDE"} ${cost}`);
    expect(text).toMatch(/ngw_first_token_seconds_count\{provider="CLAUDE"\} 1/);
    expect(text).toContain(`ngw_account_used_percent{pool="eu1:paid",provider="CLAUDE",account="${paidB}",window="5h"} 50`);
    expect(text).toContain(`ngw_account_healthy{pool="eu1:trial",provider="CLAUDE",account="${trial}"} 1`);
    expect(text).toContain("ngw_open_requests 0");
    expect(text).not.toContain("t-ok");
  });

  it("refuses other keys, other regions, unserved paths and WebSocket; a used-up month answers with a time, never an account count", async () => {
    const gw = await gateway(() => reply());
    expect((await gw.post("sk-sgw-" + "x".repeat(43))).statusCode).toBe(401);
    expect((await gw.post(await tenant("t-us", 50_000_000, { region: "us1" }))).statusCode).toBe(403);
    const key = await tenant("t-cap", 1_000);
    expect((await gw.post(key, "/v1/embeddings")).statusCode).toBe(404);
    expect((await gw.post(key, "/v1/messages", { upgrade: "websocket" })).statusCode).toBe(426);
    const capped = await gw.post(key);
    expect(capped.statusCode).toBe(429);
    expect(capped.json().error.message).toMatch(/^Your AI continues at \d{2}:\d{2} UTC\.$/);
    expect(capped.headers["retry-after"]).toBeDefined();
    expect(gw.tokens).toEqual([]);
  });

  it("gives the reservation back and charges nothing when every account fails before any output", async () => {
    const gw = await gateway(() => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "busy" } }), { status: 529 }));
    const res = await gw.post(await tenant("t-fail", 50_000_000));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toMatchObject({ code: "ai_unavailable", message: "Your AI is not available right now. Try again in a minute." });
    expect(await settled("t-fail")).toEqual({ spent: 0, reserved: 0 });
    expect(gw.tenancy.openRequests()).toBe(0);
  });

  it("moves a closed model's next turn to the task's next model with room (409 route_moved), else answers with the time", async () => {
    const key = await tenant("t-route", 50_000_000);
    const full = await gateway(() => reply(), { claude: 100 });
    const moved = await full.post(key, "/v1/messages", { "x-nous-task": "code" });
    expect(moved.statusCode).toBe(409);
    expect(moved.json()).toMatchObject({ type: "error", error: { code: "route_moved" }, model: "gpt-5.6-sol" });
    expect((await full.post(key, "/v1/messages", { "x-nous-task": "think" })).statusCode).toBe(400);
    expect((await full.post(key, "/v1/messages", {}, "gpt-5.6-sol")).statusCode).toBe(400);
    await ops.query("INSERT INTO ngw_task_routes (task, models, set_by) VALUES ('classify', ARRAY['claude-sonnet-5-5', 'gpt-5.6-luna'], 'person:test')");
    expect((await (await gateway(() => reply(), { claude: 100 })).post(key, "/v1/messages", { "x-nous-task": "classify" })).json().model).toBe("gpt-5.6-luna");
    const allFull = await gateway(() => reply(), { claude: 100, codex: 100 });
    const waits = await allFull.post(key);
    expect(waits.statusCode).toBe(429);
    expect(waits.json().error.message).toMatch(/^Your AI continues at \d{2}:\d{2} UTC\.$/);
    expect([...full.tokens, ...allFull.tokens]).toEqual([]);
    expect(await period("t-route")).toEqual({ spent: 0, reserved: 0 });
  });

  it("runs the hard list (Opus) for Ultra or on a failed reason turn's retry; another plan's hard request moves to the reason list", async () => {
    const gw = await gateway(() => reply());
    const personal = await tenant("t-hard-personal", 50_000_000);
    for (const task of ["hard", "reason"]) {
      const moved = await gw.post(personal, "/v1/messages", { "x-nous-task": task }, "claude-opus-5-5");
      expect(moved.statusCode).toBe(409);
      expect(moved.json()).toMatchObject({ error: { code: "route_moved" }, model: "claude-sonnet-5-5" });
    }
    expect(gw.tokens).toEqual([]);
    const retry = await gw.post(personal, "/v1/messages", { "x-nous-task": "hard", "x-nous-after-failure": "reason" }, "claude-opus-5-5");
    expect(retry.statusCode).toBe(200);
    expect(gw.sent.at(-1)).not.toHaveProperty("x-nous-after-failure");
    const ultra = await tenant("t-hard-ultra", 50_000_000, { plan: "ULTRA" });
    expect((await gw.post(ultra, "/v1/messages", { "x-nous-task": "hard" }, "claude-opus-5-5")).statusCode).toBe(200);
    expect((await gw.post(personal, "/v1/messages", { "x-nous-task": "code" })).statusCode).toBe(200); // a model on the task's own list runs
  });

  it("obeys the kill switches at once on every request: model or provider off moves the turn, user traffic only, all included AI off", async () => {
    const key = await tenant("t-switch", 50_000_000);
    const gw = await gateway(() => reply());
    const flip = async (name: string, scope: string, value: boolean) => {
      await ops.query(`INSERT INTO ngw_switches (name, scope, value, set_by, reason) VALUES ($1, $2, $3, 'person:test', 'test')
        ON CONFLICT (name, scope) DO UPDATE SET value = EXCLUDED.value`, [name, scope, value]);
      await ops.query("SELECT pg_notify($1, 'x')", [SWITCH_CHANGED]);
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await flip("model_off", "claude-sonnet-5-5", true);
    expect((await gw.post(key)).json()).toMatchObject({ error: { code: "route_moved" }, model: "gpt-5.6-sol" });
    await flip("model_off", "claude-sonnet-5-5", false);
    await flip("provider_off", "CLAUDE:eu1:paid", true);
    expect((await gw.post(key, "/v1/messages", { "x-nous-task": "classify" })).json()).toMatchObject({ model: "gpt-5.6-luna" });
    await flip("provider_off", "CLAUDE:eu1:paid", false);
    await flip("user_traffic_only", "*", true);
    expect((await gw.post(key, "/v1/messages", { "x-nous-traffic-class": "background" })).statusCode).toBe(429);
    expect((await gw.post(key)).statusCode).toBe(200);
    await flip("user_traffic_only", "*", false);
    await flip("all_included_ai_off", "*", true);
    const off = await gw.post(key);
    expect(off.statusCode).toBe(503);
    expect(off.json().error.code).toBe("included_ai_off");
    await flip("all_included_ai_off", "*", false);
    expect((await gw.post(key)).statusCode).toBe(200);
    expect(gw.tokens).toHaveLength(2);
  });

  it("serves Gemini on the tenant key through the pool's balanced path, with the tenant's credits left; nothing else of the Space Gateway answers", async () => {
    const gw = await gateway((_token, url) => url.startsWith("https://codeassist.test/") ? geminiReply() : reply());
    const key = await tenant("t-gemini", 50_000_000);
    const res = await gw.app.inject({ method: "POST", url: "/v1internal:generateContent", payload: { model: "gemini-3.8-flash",
      request: { contents: [{ role: "user", parts: [{ text: "hi" }] }] } }, headers: { authorization: `Bearer ${key}`, "x-nous-task": "classify", "content-type": "application/json" } });
    expect(res.statusCode).toBe(200);
    expect(res.json().response.candidates[0].content.parts[0].text).toBe("Hi");
    expect(gw.tokens).toEqual([`token-${gemini}`]);
    // Nothing of the tenant's own reaches the provider.
    expect(JSON.stringify(gw.sent)).not.toContain(key);
    expect(gw.sent[0]).not.toHaveProperty("x-nous-task");
    const cost = Math.round(geminiCostUsd({ promptTokens: 100, cachedTokens: 0, outputTokens: 20, thoughtsTokens: 0 }, "gemini-3.8-flash")! * 1e6);
    expect(await settled("t-gemini")).toEqual({ spent: cost, reserved: 0 });
    expect((await ops.query("SELECT provider, model FROM ngw_usage WHERE tenant_id = 't-gemini'")).rows).toEqual([{ provider: "gemini", model: "gemini-3.8-flash" }]);
    // Usage headers: the tenant's own credits (1 credit = $0.01), never an account's window.
    expect(Number(res.headers["x-nous-credits-left-today"])).toBeGreaterThan(0);
    expect(Number(res.headers["x-nous-credits-left-period"])).toBeLessThan(5_000);
    expect(res.headers["x-nous-credits-day-resets"]).toMatch(/T00:00:00\.000Z$/);
    for (const [method, url] of [["POST", "/antigravity/v1internal:generateContent"], ["GET", "/api/codex/weekly-remaining"], ["GET", "/stats"],
      ["GET", "/__space-gateway/status"]] as const) {
      expect((await gw.app.inject({ method, url, headers: { authorization: `Bearer ${key}` } })).statusCode).toBe(404);
    }
    expect(gw.tokens).toHaveLength(1);
  });

  it("lists the models of the tenant's task lists that no switch closes, in the OpenAI or the Anthropic shape", async () => {
    const gw = await gateway(() => reply());
    const key = await tenant("t-models", 50_000_000);
    expect((await gw.app.inject({ method: "GET", url: "/v1/models" })).statusCode).toBe(401);
    const list = (await gw.app.inject({ method: "GET", url: "/v1/models", headers: { authorization: `Bearer ${key}` } })).json();
    expect(list.object).toBe("list");
    expect(list.data).toEqual(expect.arrayContaining([{ id: "gemini-3.8-flash", object: "model", created: 0, owned_by: "google" },
      { id: "claude-opus-5-5", object: "model", created: 0, owned_by: "anthropic" }]));
    await ops.query("INSERT INTO ngw_switches (name, scope, value, set_by, reason) VALUES ('model_off', 'claude-opus-5-5', true, 'person:test', 'test')");
    await ops.query("SELECT pg_notify($1, 'x')", [SWITCH_CHANGED]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const anthropic = (await gw.app.inject({ method: "GET", url: "/v1/models", headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } })).json();
    expect(anthropic.data.map((model: { id: string }) => model.id)).not.toContain("claude-opus-5-5");
    expect(anthropic.data[0]).toMatchObject({ type: "model" });
    await ops.query("DELETE FROM ngw_switches WHERE name = 'model_off'");
    await ops.query("SELECT pg_notify($1, 'x')", [SWITCH_CHANGED]);
  });

  it("never names accounts in an error: a limit every account hit reads when the AI continues", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 3_600);
    const gw = await gateway(() => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "Rate limited." } }),
      { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset } }));
    const res = await gw.post(await tenant("t-limit", 50_000_000));
    expect(res.statusCode).toBe(429);
    expect(res.json().error.message).toMatch(/^Your AI continues at \d{2}:\d{2} UTC\.$/);
    expect(res.body).not.toMatch(/account/i);
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    expect(await settled("t-limit")).toEqual({ spent: 0, reserved: 0 });
  });
});
