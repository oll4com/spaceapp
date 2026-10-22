import type { GatewayCompressionRow, GatewayRepository } from "@space/db";
import type { CompressionCache } from "./compression/engine.js";
import { headroomWasteSignalNames } from "./compression/waste-signals.js";
import { createAdminGuard } from "./admin/codex-sign-in.js";

/**
 * Headroom-compatible statistics (`GET /stats`), after Headroom 0.37's `/stats` (Apache-2.0, Headroom Contributors):
 * the same section and field names for the parts Space Gateway measures: requests, tokens and savings, latency,
 * compression overhead, TTFB, savings by strategy, the compression cache and savings history. Aggregates only;
 * no per-request ids, prompts or keys. Shadow-mode measurements, which Headroom does not have, are under
 * `space_gateway.shadow` and never count as savings.
 */
const round2 = (value: number) => Math.round(value * 100) / 100;
const percent = (part: number, whole: number) => (whole > 0 ? round2((part / whole) * 100) : 0);

interface ModeTotals { requests: number; modified: number; blocks: number; attempted: number; saved: number; overheadMs: number; maxOverheadMs: number; timedOut: number }

function totals(rows: GatewayCompressionRow[], mode: "ON" | "SHADOW"): ModeTotals {
  const result: ModeTotals = { requests: 0, modified: 0, blocks: 0, attempted: 0, saved: 0, overheadMs: 0, maxOverheadMs: 0, timedOut: 0 };
  for (const row of rows) {
    if (row.mode !== mode) continue;
    if (row.strategy === "") {
      result.requests += row.requests;
      result.modified += row.modifiedRequests;
      result.overheadMs += row.overheadMs;
      result.maxOverheadMs = Math.max(result.maxOverheadMs, row.maxOverheadMs);
      result.timedOut += row.timedOut;
    } else {
      result.blocks += row.blocks;
      result.attempted += row.originalTokens;
      result.saved += row.originalTokens - row.compressedTokens;
    }
  }
  return result;
}

function byStrategy(rows: GatewayCompressionRow[], mode: "ON" | "SHADOW", pick: (row: GatewayCompressionRow) => number): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) if (row.mode === mode && row.strategy !== "") result[row.strategy] = (result[row.strategy] ?? 0) + pick(row);
  return result;
}

export async function buildHeadroomStats(input: { repository: GatewayRepository; cache?: CompressionCache; hours: number; now?: () => Date;
  compressionMode: string }) {
  const now = (input.now ?? (() => new Date()))();
  const since = new Date(now.getTime() - input.hours * 3_600_000).toISOString();
  const [requests, compression, signals] = await Promise.all([input.repository.requestStatsSince(since), input.repository.compressionSince(since),
    input.repository.compressionSignalsSince(since)]);
  const waste: Record<string, number> = Object.fromEntries(headroomWasteSignalNames.map((name) => [name, 0]));
  const pipeline: Record<string, { average_ms: number; max_ms: number; count: number }> = {};
  for (const row of signals) {
    if (row.kind === "waste") waste[row.name] = (waste[row.name] ?? 0) + Math.round(row.value);
    else if (row.name !== "cache_hit") {
      const entry = pipeline[row.name] ?? { average_ms: 0, max_ms: 0, count: 0 };
      const total = entry.average_ms * entry.count + row.value;
      entry.count += row.count;
      entry.average_ms = entry.count > 0 ? total / entry.count : 0;
      entry.max_ms = Math.max(entry.max_ms, row.maxValue);
      pipeline[row.name] = entry;
    }
  }
  for (const entry of Object.values(pipeline)) { entry.average_ms = round2(entry.average_ms); entry.max_ms = round2(entry.max_ms); }
  const applied = totals(compression, "ON");
  const shadow = totals(compression, "SHADOW");
  // Request-log input is what the provider billed, after compression; adding the savings back gives the input before it.
  const totalBefore = requests.inputTokens + applied.saved;
  const newInput = Math.max(0, requests.inputTokens - requests.cachedInputTokens);
  const overheadRequests = applied.requests + shadow.requests;
  const primaryModel = Object.entries(requests.byModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  let cumulative = 0;
  const savingsHistory = compression.filter((row) => row.mode === "ON" && row.strategy !== "")
    .reduce<Map<string, number>>((map, row) => map.set(row.hour, (map.get(row.hour) ?? 0) + row.originalTokens - row.compressedTokens), new Map())
    .entries();
  const history = [...savingsHistory].sort((a, b) => a[0].localeCompare(b[0])).map(([hour, saved]) => {
    cumulative += saved;
    return [hour, cumulative] as const;
  });

  return {
    window_hours: input.hours,
    summary: {
      mode: input.compressionMode.toLowerCase(),
      api_requests: requests.total,
      primary_model: primaryModel,
      compression: {
        requests_compressed: applied.modified,
        avg_compression_pct: percent(applied.saved, applied.attempted),
        total_tokens_removed: applied.saved,
        total_tokens_before: totalBefore,
        total_tokens_saved_all_layers: applied.saved
      }
    },
    savings: {
      total_tokens: applied.saved,
      by_layer: { compression: { tokens: applied.saved, proxy_tokens: applied.saved, all_layers_tokens: applied.saved,
        description: "Tokens removed by Space Gateway compression." } }
    },
    requests: {
      total: requests.total, cached: requests.cached, rate_limited: requests.rateLimited, failed: requests.failed,
      by_provider: requests.byProvider, by_model: requests.byModel, by_stack: {}
    },
    tokens: {
      input: requests.inputTokens,
      output: requests.outputTokens,
      saved: applied.saved,
      proxy_compression_saved: applied.saved,
      proxy_total_before_compression: totalBefore,
      total_before_compression: totalBefore,
      all_layers_saved: applied.saved,
      proxy_attempted_tokens: applied.attempted,
      active_savings_percent: percent(applied.saved, applied.attempted),
      proxy_savings_percent: percent(applied.saved, totalBefore),
      new_input_tokens: newInput,
      new_input_savings_percent: newInput > 0 ? percent(applied.saved, newInput + applied.saved) : 0,
      savings_percent: percent(applied.saved, totalBefore),
      all_layers_savings_percent: percent(applied.saved, totalBefore),
      output_saved: 0,
      output_reduction_percent: 0
    },
    latency: { average_ms: requests.latency.averageMs, min_ms: requests.latency.minMs, max_ms: requests.latency.maxMs, total_requests: requests.latency.count },
    overhead: { average_ms: overheadRequests > 0 ? round2((applied.overheadMs + shadow.overheadMs) / overheadRequests) : 0,
      max_ms: round2(Math.max(applied.maxOverheadMs, shadow.maxOverheadMs)) },
    ttfb: { average_ms: requests.ttfb.averageMs, min_ms: requests.ttfb.minMs, max_ms: requests.ttfb.maxMs },
    waste_signals: waste,
    pipeline_timing: pipeline,
    prefix_cache: { totals: { cache_read_tokens: requests.cachedInputTokens, cache_write_tokens: requests.cacheCreationTokens,
      hit_rate: percent(requests.cachedInputTokens, requests.inputTokens) } },
    compressions_by_strategy: byStrategy(compression, "ON", (row) => row.blocks),
    tokens_saved_by_strategy: byStrategy(compression, "ON", (row) => row.originalTokens - row.compressedTokens),
    savings_history: history.slice(-100),
    compression_cache: input.cache
      ? { hits: input.cache.hits, misses: input.cache.misses, hit_rate: percent(input.cache.hits, input.cache.hits + input.cache.misses) }
      : null,
    space_gateway: {
      shadow: {
        requests: shadow.requests, modified_requests: shadow.modified, blocks: shadow.blocks, tokens_saved: shadow.saved,
        attempted_tokens: shadow.attempted, active_savings_percent: percent(shadow.saved, shadow.attempted),
        compressions_by_strategy: byStrategy(compression, "SHADOW", (row) => row.blocks),
        tokens_saved_by_strategy: byStrategy(compression, "SHADOW", (row) => row.originalTokens - row.compressedTokens)
      },
      timed_out_requests: applied.timedOut + shadow.timedOut
    }
  };
}

/** `GET /stats?hours=24` (1 to 720 hours). */
export function registerStatsRoute(app: import("fastify").FastifyInstance, options: {
  repository: GatewayRepository; cache?: CompressionCache; compressionMode: () => Promise<string>; now?: () => Date;
  /** Only the Space API reads usage statistics; loopback alone also admits every CLI pane. */
  internalToken: string | null;
}) {
  const guard = createAdminGuard(options.internalToken);
  app.get("/stats", async (request, reply) => {
    if (!(await guard(request, reply))) return reply;
    const raw = Number((request.query as { hours?: unknown }).hours ?? 24);
    const hours = Number.isFinite(raw) ? Math.min(720, Math.max(1, Math.trunc(raw))) : 24;
    try {
      return await buildHeadroomStats({ repository: options.repository, cache: options.cache, hours, now: options.now,
        compressionMode: await options.compressionMode() });
    } catch {
      return reply.code(503).send({ error: { code: "stats_unavailable", message: "Space Gateway statistics are unavailable." } });
    }
  });
}
