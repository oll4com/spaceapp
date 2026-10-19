import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { InMemorySpaceStore } from "@space/runtime";
import { InMemoryGatewayRepository, type GatewayRequestLogInsert } from "@space/db";
import { createCsrfToken, signSession } from "../src/auth.js";
import { createApp } from "../src/app.js";
import { getApiConfig } from "../src/config.js";
import { createGatewayAdminService } from "../src/gateway/gateway-service.js";
import { cacheMisses } from "../src/gateway/gateway-headroom.js";

const sessionSecret = "gateway-headroom-test-secret";
const apps: FastifyInstance[] = [];
const accountA = `gw_account:${"1".repeat(32)}`;
const accountB = `gw_account:${"2".repeat(32)}`;
const NOW = Date.parse("2030-01-08T12:00:00.000Z");

function authHeaders(role: "USER" | "ADMIN") {
  const session = signSession({ id: `user:${role.toLowerCase()}`, email: `${role.toLowerCase()}@space.local`, role }, sessionSecret);
  return { cookie: `space_session=${session}`, "x-space-csrf-token": createCsrfToken(session, sessionSecret)! };
}

const base = (fields: Partial<GatewayRequestLogInsert> & Pick<GatewayRequestLogInsert, "requestId" | "requestedAt">): GatewayRequestLogInsert => ({
  provider: "CODEX", accountId: accountA, apiKeyId: null, model: "gpt-5.5", reasoningEffort: null, serviceTier: null, transport: "http", status: "success",
  errorCode: null, latencyMs: 2000, firstTokenMs: 500, inputTokens: 10_000, cachedInputTokens: 0, outputTokens: 300, reasoningTokens: null, costUsd: 0.05,
  compressionTokensSaved: null, stickyKind: null, stickyKeyHash: null, ...fields
});

async function setup() {
  const repository = new InMemoryGatewayRepository();
  await repository.insertRequestLogs([
    // Applied compression on Codex: 4000 -> 1000 tokens of tool output.
    base({ requestId: "a", requestedAt: "2030-01-08T10:00:00.000Z", clientName: "Codex CLI", project: "space", compressionTokensBefore: 4000, compressionTokensAfter: 1000,
      compressionTokensSaved: 3000, cachedInputTokens: 6000, stickyKeyHash: "a1a1a1a1a1a1a1a1", compressionDetail: { strategies: ["log_compressor"], waste: { whitespace: 40 } } }),
    // Same conversation two minutes later on another account, no cache read: an account switch.
    base({ requestId: "b", requestedAt: "2030-01-08T10:02:00.000Z", clientName: "Codex CLI", accountId: accountB, stickyKeyHash: "a1a1a1a1a1a1a1a1" }),
    // Claude: cache bust on a continuing conversation (write 1500 of 2000 cache tokens).
    base({ requestId: "c", requestedAt: "2030-01-08T11:00:00.000Z", provider: "CLAUDE", model: "claude-sonnet-4-5", clientName: "Claude Code", inputTokens: 2500,
      cachedInputTokens: 500, cacheCreationTokens: 1500, cacheBust: true, stickyKeyHash: "c1c1c1c1c1c1c1c1" }),
    // Shadow measurement only.
    base({ requestId: "d", requestedAt: "2030-01-08T11:30:00.000Z", clientName: "Codex CLI", compressionTokensBefore: 800, compressionTokensAfter: 600 }),
    base({ requestId: "e", requestedAt: "2030-01-08T11:40:00.000Z", status: "error", errorCode: "rate_limit_exceeded", inputTokens: null, outputTokens: null, costUsd: null,
      latencyMs: 30, firstTokenMs: null }),
    // An older day for history.
    base({ requestId: "f", requestedAt: "2030-01-01T09:00:00.000Z", compressionTokensBefore: 2000, compressionTokensAfter: 1000, compressionTokensSaved: 1000 }),
    // Warm-up requests never count.
    base({ requestId: "w", requestedAt: "2030-01-08T11:50:00.000Z", source: "limit_warmup", compressionTokensSaved: 99_999 })
  ]);
  await repository.recordCompression([
    { hour: "2030-01-08T10:00:00.000Z", mode: "ON", provider: "CODEX", strategy: "", requests: 2, modifiedRequests: 1, blocks: 0, rejectedBlocks: 0, errorBlocks: 0,
      timedOut: 0, originalTokens: 4000, compressedTokens: 1000, overheadMs: 6, maxOverheadMs: 5 },
    { hour: "2030-01-08T11:00:00.000Z", mode: "SHADOW", provider: "CODEX", strategy: "log_compressor", requests: 0, modifiedRequests: 0, blocks: 1, rejectedBlocks: 0,
      errorBlocks: 0, timedOut: 0, originalTokens: 800, compressedTokens: 600, overheadMs: 0, maxOverheadMs: 0 }
  ]);
  await repository.recordCompressionSignals([
    { hour: "2030-01-08T10:00:00.000Z", mode: "ON", provider: "CODEX", kind: "waste", name: "whitespace", count: 1, value: 40, maxValue: 40 },
    { hour: "2030-01-08T10:00:00.000Z", mode: "ON", provider: "CODEX", kind: "stage", name: "compressor:log_compressor", count: 1, value: 3, maxValue: 3 },
    { hour: "2030-01-08T10:00:00.000Z", mode: "ON", provider: "CODEX", kind: "stage", name: "pipeline_total", count: 2, value: 6, maxValue: 5 }
  ]);
  repository.accounts.push({
    id: accountA, provider: "CODEX", label: "Team A", alias: null, email: null, planType: "plus", status: "ACTIVE", statusReason: null, priority: 100, warmupEnabled: false,
    resetCreditsAvailable: 1, primaryWindow: { usedPercent: 20, resetAt: null, windowMinutes: 300 }, secondaryWindow: { usedPercent: 50, resetAt: null, windowMinutes: 10080 },
    lastRefreshAt: null, lastUsedAt: null, createdAt: "2030-01-01T00:00:00.000Z", externalAccountId: "x", credentialsEncrypted: "v1.secret", credentialsExpiresAt: null,
    source: "OAUTH", sourceRef: null, blockedUntil: null
  });
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: "t", startedAt: "2030-01-08T09:00:00.000Z", inFlightRequests: 3, draining: false,
    listen: "127.0.0.1:4920", activeWebSockets: 1, relayTasks: 0, compressionQueue: 2 })));
  const service = createGatewayAdminService({ repository, gatewayUrl: "http://127.0.0.1:4920", fetchImpl: fetchImpl as unknown as typeof fetch, now: () => new Date(NOW),
    healthProbes: { gateway: async () => 1, lanListen: async () => null, connect: async () => 1, internet: async () => 1 } });
  const app = await createApp({ store: new InMemorySpaceStore(), config: getApiConfig({}), auth: { sessionSecret, devLogin: false, secureCookies: false }, gatewayAdminService: service });
  apps.push(app);
  return { app };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("Space Gateway Headroom views", () => {
  it("are limited to administrators", async () => {
    const { app } = await setup();
    for (const url of ["/api/admin/gateway/compression/session", "/api/admin/gateway/compression/lifetime", "/api/admin/gateway/compression/history",
      "/api/admin/gateway/compression/export"]) {
      expect((await app.inject({ url, headers: authHeaders("USER") })).statusCode, url).toBe(404);
    }
  });

  it("builds the session view since the gateway worker started", async () => {
    const { app } = await setup();
    const session = (await app.inject({ url: "/api/admin/gateway/compression/session", headers: authHeaders("ADMIN") })).json();
    expect(session.since).toBe("2030-01-08T09:00:00.000Z");
    expect(session.requests).toEqual({ total: 5, completed: 4, failed: 1, rateLimited: 1, cached: 2 });
    expect(session.live).toEqual({ activeRequests: 3, activeWebSockets: 1, relayTasks: 0, compressionQueue: 2 });
    // Before = input + removed; removed = applied savings only; Shadow measured 800 -> 600.
    expect(session.tokens).toMatchObject({ input: 32_500, saved: 3000, shadowSaved: 200, compressedBefore: 4800, savingsPercent: 8.45, activeSavingsPercent: 75 });
    expect(session.performance.overhead).toMatchObject({ averageMs: 3, maxMs: 5, samples: 2 });
    expect(session.performance.ttfb).toMatchObject({ samples: 4, p50Ms: 500 });
    expect(session.performance.throughput.forwardP50).toBe(5000);
    expect(session.performance.stages[0]).toMatchObject({ name: "compressor:log_compressor", runs: 1, averageMs: 3 });
    expect(session.waste).toEqual([{ name: "whitespace", tokens: 40 }]);
    expect(session.savingsOverTime).toEqual([{ t: "2030-01-08T10:00:00.000Z", saved: 3000, shadowSaved: 0, requests: 2 },
      { t: "2030-01-08T11:00:00.000Z", saved: 0, shadowSaved: 200, requests: 0 }]);
    // Cache: Codex reads 6000 (no writes reported), Claude 500 read / 1500 written / 500 uncached.
    expect(session.prefixCache).toMatchObject({ requests: 2, hitRequests: 2, readTokens: 6500, writeTokens: 1500, busts: 1, bustTokens: 1500,
      misses: { ttlExpiry: 0, accountSwitch: 1, prefixChange: 0 } });
    expect(session.prefixCache.byProvider.find((row: { provider: string }) => row.provider === "CLAUDE")).toMatchObject({ readDiscountPercent: 90, writePremiumPercent: 25 });
    expect(session.compressionVsCache).toEqual({ savedTokens: 3000, lostToBustTokens: 1500, netTokens: 1500 });
    expect(session.agents[0]).toMatchObject({ key: "Codex CLI", requests: 3, savedTokens: 3000, shareOfSavedPercent: 100, shareOfRequestsPercent: 60 });
    expect(session.models.find((row: { model: string }) => row.model === "gpt-5.5")).toMatchObject({ savedTokens: 3000 });
    expect(session.recent[0].requestId).toBe("w");
    expect(session.rateLimits[0]).toMatchObject({ label: "Team A", resetCredits: 1 });
    expect(session.poolWeekly).toMatchObject({ remainingPercent: 50 });
  });

  it("builds lifetime totals and dollars from the daily rollups", async () => {
    const { app } = await setup();
    const lifetime = (await app.inject({ url: "/api/admin/gateway/compression/lifetime", headers: authHeaders("ADMIN") })).json();
    expect(lifetime.since).toBe("2030-01-01");
    expect(lifetime.requests).toEqual({ total: 6, completed: 5, failed: 1, rateLimited: 1, cached: 2 });
    expect(lifetime.tokens).toMatchObject({ saved: 4000, shadowSaved: 200, input: 42_500, attemptedInput: 46_500 });
    // gpt-5.5 lists at $5 input / $0.50 cached per million: 4000 saved -> $0.02; 6000 cached Codex reads -> $0.027.
    expect(lifetime.cost.compressionSavedUsd).toBeCloseTo(0.02, 6);
    expect(lifetime.cost.cacheSavedUsd).toBeCloseTo(6000 * 4.5 / 1e6 + 500 * 2.7 / 1e6, 6);
    expect(lifetime.prefixCache).toMatchObject({ requests: 6, cachedRequests: 2, busts: 1, bustTokens: 1500 });
    expect(lifetime.projects).toEqual([expect.objectContaining({ project: "space", requests: 1, savedTokens: 3000 })]);
    expect(lifetime.clients.map((row: { key: string }) => row.key)).toEqual(expect.arrayContaining(["Codex CLI", "Claude Code", "Unknown"]));
  });

  it("builds daily, weekly and monthly history and exports it", async () => {
    const { app } = await setup();
    const history = (await app.inject({ url: "/api/admin/gateway/compression/history", headers: authHeaders("ADMIN") })).json();
    expect(history.lifetime).toMatchObject({ savedTokens: 4000, activeDays: 2, averagePerDay: 2000 });
    expect(history.series.daily.map((row: { key: string; savedTokens: number }) => [row.key, row.savedTokens])).toEqual([["2030-01-01", 1000], ["2030-01-08", 3000]]);
    // 2030-01-01 is a Tuesday (week of Monday 2029-12-31); 2030-01-08 starts the next week on Monday 2030-01-07.
    expect(history.series.weekly.map((row: { key: string }) => row.key)).toEqual(["2029-12-31", "2030-01-07"]);
    expect(history.series.monthly).toEqual([expect.objectContaining({ key: "2030-01", savedTokens: 4000, cumulativeSavedTokens: 4000 })]);
    expect(history.models[0]).toMatchObject({ model: "gpt-5.5", savedTokens: 4000 });
    expect(history.models[0].costWithoutUsd).toBeCloseTo(history.models[0].apiCostUsd + history.models[0].savedUsd, 6);
    const csv = await app.inject({ url: "/api/admin/gateway/compression/export?format=csv&series=weekly", headers: authHeaders("ADMIN") });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\n")[0]).toBe("period,tokens_saved,compression_savings_usd,requests,input_tokens,api_cost_usd,total_tokens_saved,total_compression_savings_usd,total_api_cost_usd");
    expect(csv.body).toContain("2030-01-07,3000,");
    const json = await app.inject({ url: "/api/admin/gateway/compression/export", headers: authHeaders("ADMIN") });
    expect(json.headers["content-disposition"]).toContain("space-gateway-savings-");
    expect(json.json().series.daily).toHaveLength(2);
  });

  it("attributes cache misses to expiry, account switches and prefix changes", () => {
    const log = (requestedAt: string, accountId: string, cached: number, created = 0) => ({ id: requestedAt, requestId: requestedAt, requestedAt, provider: "CLAUDE" as const,
      accountId, apiKeyId: null, model: "m", reasoningEffort: null, serviceTier: null, transport: null, status: "success", errorCode: null, latencyMs: 1, firstTokenMs: 1,
      inputTokens: 1, cachedInputTokens: cached, outputTokens: 1, reasoningTokens: null, costUsd: null, compressionTokensSaved: null, stickyKind: null,
      stickyKeyHash: "k", planType: null, requestedServiceTier: null, upstreamTransport: null, errorMessage: null, stickyKeySource: null, cacheCreationTokens: created,
      clientName: null, project: null, compressionTokensBefore: null, compressionTokensAfter: null, source: null, cacheBust: null, compressionDetail: null });
    expect(cacheMisses([
      log("2030-01-01T10:00:00.000Z", accountA, 0, 900),
      log("2030-01-01T10:20:00.000Z", accountA, 0, 900),
      log("2030-01-01T10:21:00.000Z", accountB, 0, 900),
      log("2030-01-01T10:22:00.000Z", accountB, 0),
      log("2030-01-01T10:23:00.000Z", accountB, 500)
    ])).toEqual({ ttlExpiry: 1, accountSwitch: 1, prefixChange: 1 });
  });
});
