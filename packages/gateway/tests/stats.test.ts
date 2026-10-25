import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { InMemoryGatewayRepository, type GatewayRequestLogInsert } from "@space/db";
import { CompressionCache } from "../src/compression/engine.js";
import { registerStatsRoute } from "../src/stats.js";

const headers = { "x-space-internal-token": "internal-test" };

const now = new Date("2030-01-10T12:00:00Z");
const log = (overrides: Partial<GatewayRequestLogInsert>): GatewayRequestLogInsert => ({
  requestId: `req_${Math.random()}`, requestedAt: "2030-01-10T11:30:00.000Z", provider: "CODEX", accountId: null, apiKeyId: null, model: "gpt-5.5",
  reasoningEffort: null, serviceTier: null, transport: "http", status: "success", errorCode: null, latencyMs: 1000, firstTokenMs: 200,
  inputTokens: 10_000, cachedInputTokens: 4_000, outputTokens: 100, reasoningTokens: null, costUsd: null, compressionTokensSaved: null,
  stickyKind: null, stickyKeyHash: null, ...overrides
});

describe("Headroom-compatible /stats", () => {
  it("reports requests, applied savings and shadow measurements with Headroom's field names", async () => {
    const repository = new InMemoryGatewayRepository();
    await repository.insertRequestLogs([
      log({ compressionTokensSaved: 3_000 }),
      log({ provider: "CLAUDE", model: "claude-sonnet-4-5", latencyMs: 3000, firstTokenMs: 400 }),
      log({ status: "error", errorCode: "rate_limit_exceeded", inputTokens: null, cachedInputTokens: null, outputTokens: null, latencyMs: 50, firstTokenMs: null }),
      log({ requestedAt: "2030-01-08T00:00:00.000Z" })
    ]);
    const row = (mode: "ON" | "SHADOW", strategy: string, values: Record<string, number>) => ({ hour: "2030-01-10T11:00:00.000Z", mode, provider: "CODEX", strategy,
      requests: 0, modifiedRequests: 0, blocks: 0, rejectedBlocks: 0, errorBlocks: 0, timedOut: 0, originalTokens: 0, compressedTokens: 0, overheadMs: 0, maxOverheadMs: 0, ...values });
    await repository.recordCompression([
      row("ON", "", { requests: 2, modifiedRequests: 1, overheadMs: 60, maxOverheadMs: 50 }),
      row("ON", "smart_crusher", { blocks: 2, originalTokens: 4_000, compressedTokens: 1_000 }),
      row("SHADOW", "", { requests: 2, modifiedRequests: 2, overheadMs: 20, maxOverheadMs: 15, timedOut: 1 }),
      row("SHADOW", "log_compressor", { blocks: 1, originalTokens: 1_000, compressedTokens: 200 })
    ]);
    const cache = new CompressionCache();
    cache.set(cache.key("a"), { replacement: null, action: { kind: "no_compression", contentType: "text" } });
    cache.get(cache.key("a"));
    cache.get(cache.key("b"));
    const app = Fastify();
    registerStatsRoute(app, { repository, cache, compressionMode: async () => "ON", now: () => now, internalToken: "internal-test" });
    expect((await app.inject({ method: "GET", url: "/stats" })).statusCode).toBe(403);
    const stats = (await app.inject({ method: "GET", url: "/stats", headers })).json();
    expect(stats.requests).toEqual({ total: 3, cached: 2, rate_limited: 1, failed: 1, by_provider: { CODEX: 2, CLAUDE: 1 },
      by_model: { "gpt-5.5": 2, "claude-sonnet-4-5": 1 }, by_stack: {} });
    expect(stats.tokens).toMatchObject({ input: 20_000, output: 200, saved: 3_000, proxy_attempted_tokens: 4_000, active_savings_percent: 75,
      proxy_total_before_compression: 23_000, savings_percent: 13.04, new_input_tokens: 12_000, new_input_savings_percent: 20 });
    expect(stats.latency).toEqual({ average_ms: 1350, min_ms: 50, max_ms: 3000, total_requests: 3 });
    expect(stats.ttfb).toEqual({ average_ms: 300, min_ms: 200, max_ms: 400 });
    expect(stats.overhead).toEqual({ average_ms: 20, max_ms: 50 });
    expect(stats.compressions_by_strategy).toEqual({ smart_crusher: 2 });
    expect(stats.tokens_saved_by_strategy).toEqual({ smart_crusher: 3_000 });
    expect(stats.savings_history).toEqual([["2030-01-10T11:00:00.000Z", 3_000]]);
    expect(stats.compression_cache).toEqual({ hits: 1, misses: 1, hit_rate: 50 });
    expect(stats.summary).toMatchObject({ mode: "on", api_requests: 3, primary_model: "gpt-5.5", compression: { requests_compressed: 1, total_tokens_removed: 3_000 } });
    expect(stats.space_gateway).toMatchObject({ shadow: { requests: 2, tokens_saved: 800, active_savings_percent: 80, tokens_saved_by_strategy: { log_compressor: 800 } },
      timed_out_requests: 1 });
    expect((await app.inject({ method: "GET", url: "/stats?hours=1000", headers })).json().window_hours).toBe(720);
  });

  it("reports waste signals, pipeline timing and prompt-cache totals", async () => {
    const repository = new InMemoryGatewayRepository();
    await repository.insertRequestLogs([log({ cacheCreationTokens: 500 })]);
    await repository.recordCompressionSignals([
      { hour: "2030-01-10T11:10:00.000Z", mode: "ON", provider: "CODEX", kind: "waste", name: "html_noise", count: 1, value: 120, maxValue: 120 },
      { hour: "2030-01-10T11:20:00.000Z", mode: "ON", provider: "CODEX", kind: "waste", name: "html_noise", count: 1, value: 30, maxValue: 30 },
      { hour: "2030-01-10T11:10:00.000Z", mode: "ON", provider: "CODEX", kind: "stage", name: "pipeline_total", count: 1, value: 4, maxValue: 4 },
      { hour: "2030-01-10T11:20:00.000Z", mode: "ON", provider: "CODEX", kind: "stage", name: "pipeline_total", count: 1, value: 8, maxValue: 8 },
      { hour: "2030-01-10T11:20:00.000Z", mode: "ON", provider: "CODEX", kind: "stage", name: "cache_hit", count: 2, value: 0, maxValue: 0 }
    ]);
    const app = Fastify();
    registerStatsRoute(app, { repository, compressionMode: async () => "ON", now: () => now, internalToken: "internal-test" });
    const stats = (await app.inject({ method: "GET", url: "/stats?hours=24", headers })).json();
    // Every Headroom category is reported, in its order; the ones its detector never sets stay 0.
    expect(stats.waste_signals).toEqual({ json_bloat: 0, html_noise: 150, base64: 0, whitespace: 0, dynamic_date: 0, repetition: 0, reread: 0, reread_compressed: 0 });
    expect(Object.keys(stats.waste_signals)).toEqual(["json_bloat", "html_noise", "base64", "whitespace", "dynamic_date", "repetition", "reread", "reread_compressed"]);
    expect(stats.pipeline_timing).toEqual({ pipeline_total: { average_ms: 6, max_ms: 8, count: 2 } });
    expect(stats.prefix_cache.totals).toEqual({ cache_read_tokens: 4000, cache_write_tokens: 500, hit_rate: 40 });
  });
});
