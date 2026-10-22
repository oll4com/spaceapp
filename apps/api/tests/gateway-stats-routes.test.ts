import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryGatewayRepository, type GatewayAccountRecord, type GatewayRequestLogInsert } from "@space/db";
import { hashGatewayApiKey } from "@space/gateway";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createGatewayAdminService } from "../src/gateway/gateway-service.js";
import { accountTrend, GatewayHealthSampler, requestLogCsv, upstreamStatus } from "../src/gateway/gateway-stats.js";

const sessionSecret = "gateway-stats-test-secret";
const apps: FastifyInstance[] = [];
const plusId = `gw_account:${"1".repeat(32)}`;
const proId = `gw_account:${"2".repeat(32)}`;
const keyId = `gw_key:${"a".repeat(32)}`;
const NOW = Date.parse("2030-01-08T12:00:00.000Z");

function authHeaders(role: "USER" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
}

function account(id: string, label: string, planType: string, primaryUsed: number | null, secondaryUsed: number | null): GatewayAccountRecord {
  return {
    id, provider: "CODEX", label, alias: null, email: `${label.toLowerCase().replace(/\s/g, "")}@example.test`, planType, status: "ACTIVE", statusReason: null,
    priority: 100, warmupEnabled: false, resetCreditsAvailable: null,
    primaryWindow: { usedPercent: primaryUsed, resetAt: new Date(NOW + 2.5 * 3_600_000).toISOString(), windowMinutes: 300 },
    secondaryWindow: { usedPercent: secondaryUsed, resetAt: new Date(NOW + 3.5 * 86_400_000).toISOString(), windowMinutes: 10_080 },
    lastRefreshAt: "2030-01-08T00:00:00.000Z", lastUsedAt: null, createdAt: "2030-01-01T00:00:00.000Z", externalAccountId: `ext-${id}`,
    credentialsEncrypted: "v1.secret-envelope", credentialsExpiresAt: "2030-01-09T00:00:00.000Z", source: "OAUTH", sourceRef: null, blockedUntil: null
  };
}

function log(fields: Partial<GatewayRequestLogInsert> & Pick<GatewayRequestLogInsert, "requestId" | "requestedAt">): GatewayRequestLogInsert {
  return { provider: "CODEX", accountId: plusId, apiKeyId: keyId, model: "gpt-6-sol", reasoningEffort: "high", serviceTier: null, transport: "http",
    status: "success", errorCode: null, latencyMs: 1000, firstTokenMs: 200, inputTokens: 1000, cachedInputTokens: 250, outputTokens: 100, reasoningTokens: null,
    costUsd: 0.01, compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, ...fields };
}

async function setup(fetchImpl?: typeof fetch) {
  const repository = new InMemoryGatewayRepository();
  repository.accounts.push(account(plusId, "Team Plus", "plus", 40, 10), account(proId, "Team Pro", "pro", 0, 50));
  await repository.createApiKey({ keyId, name: "Codex CLI", keyHash: hashGatewayApiKey(`sk-sgw-${"k".repeat(43)}`), keyPrefix: "sk-sgw-kkkkkkkk",
    trafficClass: "INTERACTIVE", allowedModels: [], enforcedModel: null, allowedReasoningEfforts: [], enforcedReasoningEffort: null, accountIds: [],
    compressionOverride: null, limits: [{ limitType: "TOTAL_TOKENS", limitWindow: "DAILY", maxValue: 100_000, modelFilter: null, resetAt: "2030-01-09T00:00:00.000Z" }],
    expiresAt: null, createdBy: null });
  await repository.insertRequestLogs([
    log({ requestId: "a", requestedAt: "2030-01-08T11:59:30.000Z", clientName: "Codex CLI" }),
    log({ requestId: "b", requestedAt: "2030-01-08T11:00:00.000Z", latencyMs: 3000, firstTokenMs: 400, accountId: proId, costUsd: 0.05 }),
    log({ requestId: "c", requestedAt: "2030-01-08T10:00:00.000Z", status: "error", errorCode: "rate_limit_exceeded", latencyMs: 20, firstTokenMs: null,
      inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, errorMessage: "Rate limit reached" }),
    log({ requestId: "d", requestedAt: "2030-01-05T10:00:00.000Z", model: "gpt-6-luna", costUsd: 0.002, apiKeyId: null }),
    log({ requestId: "w", requestedAt: "2030-01-08T11:30:00.000Z", source: "limit_warmup", costUsd: 9, latencyMs: 99_000 })
  ]);
  const store = new InMemorySpaceStore();
  const gatewayFetch = fetchImpl ?? (vi.fn(async (url: string) => {
    if (url.endsWith("/__space-gateway/status")) {
      return new Response(JSON.stringify({ version: "t", startedAt: "2030-01-08T00:00:00.000Z", inFlightRequests: 1, draining: false, listen: "127.0.0.1:4920",
        inFlightByAccount: { [proId]: 2 } }));
    }
    if (url.endsWith("/token-status")) return new Response(JSON.stringify({ accessExpiresAt: "2030-01-09T00:00:00.000Z", refreshStored: true, idTokenParsed: true }));
    if (url.endsWith("/export")) return new Response(JSON.stringify({ accountId: plusId, authJson: "{\n  \"auth_mode\": \"chatgpt\"\n}" }));
    if (url.endsWith("/reload")) return new Response(JSON.stringify({ status: "RELOADING" }), { status: 202 });
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch);
  const service = createGatewayAdminService({
    repository, gatewayUrl: "http://127.0.0.1:4920", fetchImpl: gatewayFetch, internalToken: "internal-secret", now: () => new Date(NOW),
    healthProbes: { gateway: async () => 3, lanListen: async () => null, connect: async () => 1, internet: async () => 40 }
  });
  const app = await createApp({ store, config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false }, gatewayAdminService: service });
  apps.push(app);
  return { app, repository, store, gatewayFetch };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Space Gateway statistics routes", () => {
  it("are limited to administrators", async () => {
    const { app } = await setup();
    for (const url of ["/api/admin/gateway/dashboard", "/api/admin/gateway/health", `/api/admin/gateway/accounts/${plusId}`, `/api/admin/gateway/keys/${keyId}`,
      "/api/admin/gateway/logs/facets", "/api/admin/gateway/logs/export.csv"]) {
      expect((await app.inject({ url, headers: authHeaders("USER") })).statusCode, url).toBe(404);
    }
  });

  it("builds the dashboard: totals, error rates, cost leaders, latency, pools and live accounts", async () => {
    const { app } = await setup();
    const response = await app.inject({ url: "/api/admin/gateway/dashboard?range=24h", headers: authHeaders("ADMIN") });
    expect(response.statusCode).toBe(200);
    const dashboard = response.json();
    // Warm-up and the 3-day-old request are outside: three requests, one rate limited.
    expect(dashboard.totals).toMatchObject({ requests: 3, errors: 1, rateLimited: 1, inputTokens: 2000, cachedInputTokens: 500, outputTokens: 200 });
    expect(dashboard.totals.costUsd).toBeCloseTo(0.06, 9);
    expect(dashboard.totals.latency).toEqual({ samples: 2, averageMs: 2000, p50Ms: 2000, p95Ms: 2900 });
    expect(dashboard.perPeriod).toMatchObject({ unit: "hour", requests: 0.13 });
    expect(dashboard.errorRate).toMatchObject({ requests: 3, errors: 1, errorRate: 0.3333, topError: { code: "rate_limit_exceeded", count: 1 } });
    expect(dashboard.errorRate5m).toMatchObject({ requests: 1, errors: 0, errorRate: 0, topError: null });
    expect(dashboard.errorRate7d.requests).toBe(4);
    expect(dashboard.trend).toHaveLength(25);
    expect(dashboard.trend.reduce((sum: number, point: { requests: number }) => sum + point.requests, 0)).toBe(3);
    expect(dashboard.topKeys).toEqual([{ apiKeyId: keyId, name: "Codex CLI", requests: 3, costUsd: 0.06 }]);
    expect(dashboard.topModels[0]).toMatchObject({ model: "gpt-6-sol", requests: 3 });
    expect(dashboard.latencyByModel[0]).toMatchObject({ model: "gpt-6-sol", samples: 3, errors: 1, status: "DEGRADED" });
    expect(dashboard.routes[0]).toMatchObject({ provider: "CODEX", model: "gpt-6-sol", apiKeyId: keyId, label: "gpt-6-sol · Codex CLI" });
    // Plus = 1 and Pro = 20 Plus-equivalents per window; the 5h window cannot hold more than the week has left.
    const pool = dashboard.pools.find((item: { provider: string }) => item.provider === "CODEX");
    expect(pool.primary).toMatchObject({ capacityCredits: 21, remainingCredits: 20.6, remainingPercent: 98.1 });
    expect(pool.secondary).toMatchObject({ capacityCredits: 21, remainingCredits: 10.9, remainingPercent: 51.9 });
    expect(dashboard.live).toEqual([
      expect.objectContaining({ accountId: proId, activeRequests: 2, state: "LIVE" }),
      expect.objectContaining({ accountId: plusId, activeRequests: 0, requests: 1, tokens: 1100, state: "RECENT", model: "gpt-6-sol" })
    ]);
    expect(dashboard.recent.map((row: { requestId: string }) => row.requestId)).toContain("w");
    expect((await app.inject({ url: "/api/admin/gateway/dashboard?range=1y", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
  });

  it("reports health signals with codex-lb thresholds", async () => {
    const { app } = await setup();
    const health = (await app.inject({ url: "/api/admin/gateway/health", headers: authHeaders("ADMIN") })).json();
    const byKey = Object.fromEntries(health.signals.map((signal: { key: string }) => [signal.key, signal]));
    expect(byKey.gateway).toMatchObject({ status: "OK", nowMs: 3, samples: 1, warnMs: 250 });
    expect(byKey.database).toMatchObject({ status: "OK", nowMs: 0 });
    expect(byKey.internet).toMatchObject({ status: "OK", nowMs: 40 });
    expect(byKey.lan).toMatchObject({ status: "UNAVAILABLE", detail: "LAN access is off." });
    expect(byKey.compression.status).toBe("UNAVAILABLE");
  });

  it("filters request logs, lists facets, returns one log and exports CSV", async () => {
    const { app } = await setup();
    const get = (query: string) => app.inject({ url: `/api/admin/gateway/logs?${query}`, headers: authHeaders("ADMIN") }).then((response) => response.json());
    expect((await get("status=RATE_LIMITED")).data.map((row: { requestId: string }) => row.requestId)).toEqual(["c"]);
    expect((await get("q=team%20pro")).data.map((row: { requestId: string }) => row.requestId)).toEqual(["b"]);
    expect((await get(`account=${plusId}&account=${proId}&model=gpt-6-luna`)).data.map((row: { requestId: string }) => row.requestId)).toEqual(["d"]);
    expect((await get("from=2030-01-08T10:30:00.000Z&to=2030-01-08T11:45:00.000Z")).data.map((row: { requestId: string }) => row.requestId)).toEqual(["w", "b"]);
    expect((await app.inject({ url: "/api/admin/gateway/logs?status=BROKEN", headers: authHeaders("ADMIN") })).statusCode).toBe(422);
    const facets = (await app.inject({ url: "/api/admin/gateway/logs/facets?from=2030-01-08T00:00:00.000Z", headers: authHeaders("ADMIN") })).json();
    expect(facets.models).toEqual([{ value: "gpt-6-sol", count: 4 }]);
    const id = (await get("q=Rate%20limit%20reached")).data[0].id;
    expect((await app.inject({ url: `/api/admin/gateway/logs/${id}`, headers: authHeaders("ADMIN") })).json()).toMatchObject({ requestId: "c", errorMessage: "Rate limit reached" });
    expect((await app.inject({ url: "/api/admin/gateway/logs/999", headers: authHeaders("ADMIN") })).statusCode).toBe(404);
    const csv = await app.inject({ url: "/api/admin/gateway/logs/export.csv?status=SUCCESS", headers: authHeaders("ADMIN") });
    expect(csv.headers["content-type"]).toContain("text/csv");
    const lines = csv.body.trim().split("\n");
    expect(lines[0]).toMatch(/^requested_at,request_id,provider,account,plan,api_key,client,/);
    expect(lines).toHaveLength(5);
    expect(lines[1]).toContain(",Team Plus,");
  });

  it("guards CSV cells that a spreadsheet would run", () => {
    const csv = requestLogCsv([{ id: "1", requestId: "=cmd()", requestedAt: "2030-01-01T00:00:00.000Z", provider: "CODEX", accountId: null, apiKeyId: null,
      model: "m,1", reasoningEffort: null, serviceTier: null, transport: null, status: "error", errorCode: null, latencyMs: null, firstTokenMs: null,
      inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, costUsd: null, compressionTokensSaved: null, stickyKind: null,
      stickyKeyHash: null, planType: null, requestedServiceTier: null, upstreamTransport: null, errorMessage: "say \"hi\"", stickyKeySource: null,
      cacheCreationTokens: null, clientName: null, project: null, compressionTokensBefore: null, compressionTokensAfter: null, source: null }],
    { account: () => "", key: () => "" });
    expect(csv.split("\n")[1]).toContain(",'=cmd(),CODEX,");
    expect(csv).toContain("\"m,1\"");
    expect(csv).toContain("\"say \"\"hi\"\"\"");
  });

  it("shows account details, keeps aliases and warm-up opt-in, and exports auth.json only when confirmed", async () => {
    const { app, store, gatewayFetch } = await setup();
    const detail = (await app.inject({ url: `/api/admin/gateway/accounts/${plusId}`, headers: authHeaders("ADMIN") })).json();
    expect(detail.account).not.toHaveProperty("credentialsEncrypted");
    expect(JSON.stringify(detail)).not.toContain("secret-envelope");
    expect(detail.lifetime).toEqual({ requests: 3, inputTokens: 2000, cachedInputTokens: 500, outputTokens: 200, costUsd: 0.012 });
    expect(detail.last7d).toMatchObject({ requests: 3, errors: 1 });
    expect(detail.tokenStatus).toMatchObject({ accessExpiresAt: "2030-01-09T00:00:00.000Z", refreshStored: true, idTokenParsed: true, source: "oauth" });
    expect(detail.trend.primary.length).toBeGreaterThan(160);

    const updated = await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${plusId}`, headers: authHeaders("ADMIN"), payload: { alias: "Main", warmupEnabled: true } });
    expect(updated.json()).toMatchObject({ alias: "Main", warmupEnabled: true, status: "ACTIVE" });
    expect((await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${plusId}`, headers: authHeaders("ADMIN"), payload: { alias: "" } })).json().alias).toBeNull();
    expect((await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${plusId}`, headers: authHeaders("ADMIN"), payload: { paused: true } })).json().status).toBe("PAUSED");
    expect((await app.inject({ method: "PATCH", url: `/api/admin/gateway/accounts/${plusId}`, headers: authHeaders("ADMIN"), payload: {} })).statusCode).toBe(422);

    expect((await app.inject({ method: "POST", url: `/api/admin/gateway/accounts/${plusId}/export`, headers: authHeaders("ADMIN"), payload: {} })).statusCode).toBe(422);
    const exported = await app.inject({ method: "POST", url: `/api/admin/gateway/accounts/${plusId}/export`, headers: authHeaders("ADMIN"), payload: { confirm: true } });
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["cache-control"]).toBe("no-store");
    const [, init] = (gatewayFetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls.find(([url]) => url.endsWith("/export"))!;
    expect((init.headers as Record<string, string>)["x-space-internal-token"]).toBe("internal-secret");
    const actions = ((await store.listAuditEvents?.({ limit: 20 })) ?? []).map((event: { action: string }) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.gateway.account.export", "admin.gateway.account.update", "admin.gateway.account.pause"]));
  });

  it("edits a key in full, rejects contradictions, regenerates its secret and shows its detail", async () => {
    const { app, repository } = await setup();
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: `/api/admin/gateway/keys/${keyId}`, headers: authHeaders("ADMIN"), payload });
    await repository.settleApiKeyUsage(keyId, { inputTokens: 300, outputTokens: 20, costMicros: 0, model: null, at: "2030-01-08T11:00:00.000Z" });
    const edited = await patch({ name: "Worker", trafficClass: "BACKGROUND", allowedModels: ["gpt-6-sol", "gpt-6-luna"], enforcedModel: "gpt-6-luna",
      accountIds: [proId], compressionOverride: "ON", expiresAt: "2031-01-01T00:00:00.000Z",
      limits: [{ limitType: "TOTAL_TOKENS", limitWindow: "DAILY", maxValue: 50_000 }, { limitType: "COST_USD", limitWindow: "MONTHLY", maxValue: 5_000_000, modelFilter: "gpt-6-sol" }] });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ name: "Worker", trafficClass: "BACKGROUND", enforcedModel: "gpt-6-luna", accountScopeEnabled: true, accountIds: [proId],
      compressionOverride: "ON", limits: [{ limitType: "TOTAL_TOKENS", maxValue: 50_000, currentValue: 320 }, { limitType: "COST_USD", currentValue: 0 }] });
    expect((await patch({ enforcedModel: "gpt-5.5" })).json()).toMatchObject({ error: { code: "GATEWAY_KEY_POLICY_INVALID" } });
    expect((await patch({ accountIds: [`gw_account:${"9".repeat(32)}`] })).statusCode).toBe(422);
    expect((await patch({ resetUsage: true })).json().limits[0].currentValue).toBe(0);

    const regenerated = await app.inject({ method: "POST", url: `/api/admin/gateway/keys/${keyId}/regenerate`, headers: authHeaders("ADMIN"), payload: {} });
    expect(regenerated.statusCode).toBe(200);
    const body = regenerated.json();
    expect(body.key.id).toBe(keyId);
    expect(body.plainKey).toMatch(/^sk-sgw-/);
    expect(await repository.findApiKeyByHash(hashGatewayApiKey(`sk-sgw-${"k".repeat(43)}`))).toBeNull();
    expect((await repository.findApiKeyByHash(hashGatewayApiKey(body.plainKey)))?.name).toBe("Worker");

    const detail = (await app.inject({ url: `/api/admin/gateway/keys/${keyId}`, headers: authHeaders("ADMIN") })).json();
    expect(detail.last7d.requests).toBe(3);
    expect(detail.costByAccount.map((row: { label: string }) => row.label)).toEqual(["Team Pro", "Team Plus"]);
    expect(detail.trend.length).toBeGreaterThan(160);
    expect(detail.pooled).toEqual({ primaryRemainingPercent: 100, secondaryRemainingPercent: 50, accounts: 1 });
  });
});

describe("Space Gateway settings routes", () => {
  it("refuses LAN settings outside the private ranges, stores valid ones, orders plans and reloads the gateway (audited)", async () => {
    const { app, store } = await setup();
    const patch = (payload: unknown) => app.inject({ method: "PATCH", url: "/api/admin/gateway/settings", headers: authHeaders("ADMIN"), payload });
    const refused = await patch({ lanMode: "ON", lanHost: "8.8.8.8", lanPort: 4925, lanAllowedSources: ["10.0.0.0/8"] });
    expect(refused.statusCode).toBe(422);
    expect(refused.json().error).toMatchObject({ code: "GATEWAY_SETTINGS_INVALID", message: expect.stringContaining("The LAN address must be a private") });
    expect((await patch({ lanMode: "ON" })).statusCode).toBe(422);
    const saved = await patch({ lanMode: "ON", lanHost: "10.20.30.40", lanPort: 4925, lanAllowedSources: ["10.20.30.0/24"], planPriority: ["Pro", "plus", "pro", " "],
      displayTimeFormat: "12H", warmupEnabled: true, promptCacheTtlSeconds: 900 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ lanMode: "ON", lanHost: "10.20.30.40", planPriority: ["pro", "plus"], displayTimeFormat: "12H", warmupEnabled: true, promptCacheTtlSeconds: 900 });
    expect((await patch({ warmupMinAvailablePercent: 0 })).statusCode).toBe(422);
    expect((await patch({ upstreamStreamTransport: "UDP" })).statusCode).toBe(422);
    const reload = await app.inject({ method: "POST", url: "/api/admin/gateway/reload", headers: authHeaders("ADMIN"), payload: {} });
    expect(reload.statusCode).toBe(202);
    expect((await app.inject({ method: "POST", url: "/api/admin/gateway/reload", headers: authHeaders("USER"), payload: {} })).statusCode).toBe(404);
    const actions = ((await store.listAuditEvents?.({ limit: 20 })) ?? []).map((event: { action: string }) => event.action);
    expect(actions).toEqual(expect.arrayContaining(["admin.gateway.settings.update", "admin.gateway.reload"]));
  });
});

describe("Space Gateway statistics helpers", () => {
  it("rates upstream latency like codex-lb", () => {
    const row = (p95: number, errors: number) => ({ key: "m", requests: 100, errors, rateLimited: 0, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0,
      outputTokens: 0, reasoningTokens: 0, costUsd: 0, compressionTokensSaved: 0, latency: { samples: 100 - errors, averageMs: 1, p50Ms: 1, p95Ms: p95 },
      ttft: { samples: 100 - errors, averageMs: 1, p50Ms: 1, p95Ms: p95 }, lastAt: null });
    expect(upstreamStatus(row(1000, 0)).status).toBe("OK");
    expect(upstreamStatus(row(9000, 0)).status).toBe("DEGRADED");
    expect(upstreamStatus(row(1000, 5)).status).toBe("DEGRADED");
    expect(upstreamStatus({ ...row(1000, 0), requests: 0 }).status).toBe("UNAVAILABLE");
  });

  it("carries usage forward hourly and draws the even-burn weekly plan line", () => {
    const base = account(plusId, "Team", "plus", null, null);
    const now = Date.parse("2030-01-08T12:30:00.000Z");
    const trend = accountTrend([
      { window: "SECONDARY", quotaKey: "", usedPercent: 20, resetAt: "2030-01-10T12:00:00.000Z", recordedAt: "2030-01-08T09:10:00.000Z" },
      { window: "SECONDARY", quotaKey: "", usedPercent: 30, resetAt: "2030-01-10T12:00:00.000Z", recordedAt: "2030-01-08T11:10:00.000Z" }
    ], base, now);
    const at = (iso: string) => trend.secondary.find((point) => point.t === iso)?.value;
    expect(at("2030-01-08T08:00:00.000Z")).toBe(100);
    expect(at("2030-01-08T09:00:00.000Z")).toBe(80);
    expect(at("2030-01-08T10:00:00.000Z")).toBe(80);
    expect(at("2030-01-08T12:00:00.000Z")).toBe(70);
    // 2 days of a 7-day window left at 12:00 → 28.57% should be left on an even burn.
    expect(trend.secondaryScheduled.find((point) => point.t === "2030-01-08T12:00:00.000Z")?.value).toBe(28.57);
  });

  it("samples on first use, reports failed checks and reuses samples within the refresh interval", async () => {
    let now = 0;
    const sampler = new GatewayHealthSampler({ repository: new InMemoryGatewayRepository(), now: () => now,
      probes: { gateway: async () => 5, lanListen: async () => null, connect: async () => 1, internet: async () => { throw new Error("offline"); } } });
    expect((await sampler.snapshot()).signals.find((signal) => signal.key === "internet")).toMatchObject({ status: "UNAVAILABLE", detail: "offline" });
    now = 5_000;
    const cached = await sampler.snapshot();
    expect(cached.signals.find((signal) => signal.key === "gateway")?.samples).toBe(1);
  });
});
