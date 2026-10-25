import {
  gatewayHeadroomHistorySchema, gatewayHeadroomLifetimeSchema, gatewayHeadroomSessionSchema, gatewayPools, type GatewayAccount, type GatewayCompressionMode,
  type GatewayHeadroomHistory, type GatewayHeadroomLifetime, type GatewayHeadroomSession, type GatewayRequestLog
} from "@space/contracts";
import type { GatewayCompressionRow, GatewayCompressionSignalRow, GatewayRepository, GatewaySavingsDailyRow } from "@space/db";
import { inputPrices } from "@space/gateway";

/**
 * Space Gateway's Headroom views, after Headroom 0.37's dashboard (Apache-2.0, Headroom Contributors): the Session view
 * (since the gateway worker started), the Lifetime view and the Historical view, with the same quantities and
 * formulas. Headroom keeps a JSON file; Space Gateway reads its request logs and rollups. Differences:
 * - Prefix-cache misses add "account switch" (a load balancer can move a conversation), next to TTL expiry and prefix change.
 * - "Prefix freeze" does not apply: only the live part of a request is ever compressed, so the cached prefix never changes.
 * - Unpriced models (no list price) count tokens but no dollars.
 */
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const RATE_LIMIT_CODES = new Set(["rate_limit_exceeded", "usage_limit_reached", "rate_limit_error", "http_429"]);
/** Provider cache prices relative to input, as Headroom's session view (Anthropic 0.1 read / 1.25 write, OpenAI 0.5 / 1, Gemini 0.1 / 1). */
const cacheMultipliers: Record<string, { read: number; write: number }> = {
  CLAUDE: { read: 0.1, write: 1.25 }, ANTHROPIC_API: { read: 0.1, write: 1.25 }, CODEX: { read: 0.5, write: 1 }, OPENAI_API: { read: 0.5, write: 1 },
  ANTIGRAVITY: { read: 0.1, write: 1 }, GOOGLE_AI: { read: 0.1, write: 1 }
};
/** Idle time after which a provider prompt cache has expired (Anthropic's default five minutes). */
const CACHE_TTL_MS = 5 * 60_000;

const round = (value: number, digits = 2) => Math.round(value * 10 ** digits) / 10 ** digits;
const pct = (part: number, whole: number) => (whole > 0 ? Math.min(100, round((part / whole) * 100)) : 0);
const iso = (ms: number) => new Date(ms).toISOString();

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return round(sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower), 1);
}

function timing(values: number[]) {
  if (values.length === 0) return { averageMs: null, p50Ms: null, p95Ms: null, minMs: null, maxMs: null, samples: 0 };
  return { averageMs: round(values.reduce((sum, value) => sum + value, 0) / values.length, 1), p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    minMs: Math.min(...values), maxMs: Math.max(...values), samples: values.length };
}

/** Dollars per token of a model's input, or null when the model has no list price. */
function priceOf(model: string, provider: string) {
  const prices = inputPrices(model, provider);
  return prices ? { input: prices.input / 1e6, cached: prices.cachedInput / 1e6 } : null;
}

/** Reads request logs newest first, page by page, up to a limit. */
export async function logsSince(repository: GatewayRepository, since: string, limit = 20_000): Promise<{ rows: GatewayRequestLog[]; sampled: boolean }> {
  const rows: GatewayRequestLog[] = [];
  let beforeId: number | null = null;
  while (rows.length < limit) {
    const page = await repository.listRequestLogs({ limit: 500, beforeId, filter: { from: since } });
    rows.push(...page);
    if (page.length < 500) return { rows, sampled: false };
    beforeId = Number(page[page.length - 1]!.id);
  }
  return { rows: rows.slice(0, limit), sampled: true };
}

/** Cache misses on conversations (same sticky key) that had cache traffic the time before. */
export function cacheMisses(logs: GatewayRequestLog[]) {
  const misses = { ttlExpiry: 0, accountSwitch: 0, prefixChange: 0 };
  const byKey = new Map<string, GatewayRequestLog[]>();
  for (const log of logs) if (log.stickyKeyHash && log.status === "success") byKey.set(log.stickyKeyHash, [...(byKey.get(log.stickyKeyHash) ?? []), log]);
  for (const series of byKey.values()) {
    series.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
    for (let index = 1; index < series.length; index += 1) {
      const previous = series[index - 1]!;
      const current = series[index]!;
      const previousCache = (previous.cachedInputTokens ?? 0) + (previous.cacheCreationTokens ?? 0);
      if (previousCache === 0 || (current.cachedInputTokens ?? 0) > 0) continue;
      if (Date.parse(current.requestedAt) - Date.parse(previous.requestedAt) > CACHE_TTL_MS) misses.ttlExpiry += 1;
      else if (previous.accountId && current.accountId && previous.accountId !== current.accountId) misses.accountSwitch += 1;
      else misses.prefixChange += 1;
    }
  }
  return misses;
}

function prefixCache(logs: GatewayRequestLog[]) {
  const byProvider = new Map<string, { requests: number; read: number; write: number; uncached: number; busts: number; savedUsd: number; premiumUsd: number }>();
  let busts = 0;
  let bustTokens = 0;
  for (const log of logs.filter((item) => item.status === "success")) {
    const read = log.cachedInputTokens ?? 0;
    const write = log.cacheCreationTokens ?? 0;
    if (read === 0 && write === 0) continue;
    const entry = byProvider.get(log.provider) ?? { requests: 0, read: 0, write: 0, uncached: 0, busts: 0, savedUsd: 0, premiumUsd: 0 };
    const multipliers = cacheMultipliers[log.provider] ?? cacheMultipliers.CLAUDE!;
    const price = priceOf(log.model, log.provider);
    entry.requests += 1;
    entry.read += read;
    entry.write += write;
    // Claude reports uncached input apart from cache traffic; OpenAI's input total includes the cached part.
    entry.uncached += log.provider === "CLAUDE" ? Math.max(0, (log.inputTokens ?? 0) - read - write) : Math.max(0, (log.inputTokens ?? 0) - read);
    if (log.cacheBust) { entry.busts += 1; busts += 1; bustTokens += write; }
    if (price) {
      entry.savedUsd += read * price.input * (1 - multipliers.read);
      if (multipliers.write > 1) entry.premiumUsd += write * price.input * (multipliers.write - 1);
    }
    byProvider.set(log.provider, entry);
  }
  const totals = [...byProvider.values()].reduce((sum, entry) => ({ requests: sum.requests + entry.requests, read: sum.read + entry.read, write: sum.write + entry.write,
    uncached: sum.uncached + entry.uncached, savedUsd: sum.savedUsd + entry.savedUsd, premiumUsd: sum.premiumUsd + entry.premiumUsd }),
  { requests: 0, read: 0, write: 0, uncached: 0, savedUsd: 0, premiumUsd: 0 });
  const hitRequests = logs.filter((log) => log.status === "success" && (log.cachedInputTokens ?? 0) > 0).length;
  return {
    requests: totals.requests, hitRequests, readTokens: totals.read, writeTokens: totals.write, uncachedTokens: totals.uncached,
    hitRatePercent: pct(totals.read, totals.read + totals.write + totals.uncached), busts, bustTokens,
    savedUsd: round(totals.savedUsd, 6), writePremiumUsd: round(totals.premiumUsd, 6), netUsd: round(totals.savedUsd - totals.premiumUsd, 6),
    byProvider: [...byProvider].map(([provider, entry]) => {
      const multipliers = cacheMultipliers[provider] ?? cacheMultipliers.CLAUDE!;
      return { provider, requests: entry.requests, readTokens: entry.read, writeTokens: entry.write, readDiscountPercent: round((1 - multipliers.read) * 100),
        writePremiumPercent: round(Math.max(0, multipliers.write - 1) * 100), busts: entry.busts, netUsd: round(entry.savedUsd - entry.premiumUsd, 6) };
    }).sort((a, b) => b.requests - a.requests),
    misses: cacheMisses(logs)
  };
}

function clientUsage(groups: Map<string, { requests: number; before: number; after: number; saved: number; output: number }>, totalSaved: number, totalRequests: number) {
  return [...groups].map(([key, entry]) => ({
    key, requests: entry.requests, beforeTokens: entry.before, afterTokens: entry.after, savedTokens: entry.saved, outputTokens: entry.output,
    savingsPercent: pct(entry.saved, entry.before), shareOfSavedPercent: pct(entry.saved, totalSaved), shareOfRequestsPercent: pct(entry.requests, totalRequests)
  })).sort((a, b) => b.savedTokens - a.savedTokens || b.beforeTokens - a.beforeTokens || b.requests - a.requests).slice(0, 100);
}

function stageRows(signals: GatewayCompressionSignalRow[]) {
  const stages = new Map<string, { runs: number; total: number; max: number }>();
  for (const row of signals.filter((item) => item.kind === "stage" && item.name !== "cache_hit")) {
    const entry = stages.get(row.name) ?? { runs: 0, total: 0, max: 0 };
    entry.runs += row.count;
    entry.total += row.value;
    entry.max = Math.max(entry.max, row.maxValue);
    stages.set(row.name, entry);
  }
  return [...stages].map(([name, entry]) => ({ name, runs: entry.runs, averageMs: entry.runs > 0 ? round(entry.total / entry.runs, 2) : 0, maxMs: round(entry.max, 2) }))
    .sort((a, b) => (a.name === "pipeline_total" ? 1 : b.name === "pipeline_total" ? -1 : b.averageMs - a.averageMs));
}

function wasteRows(signals: GatewayCompressionSignalRow[]) {
  const waste = new Map<string, number>();
  for (const row of signals.filter((item) => item.kind === "waste")) waste.set(row.name, (waste.get(row.name) ?? 0) + row.value);
  return [...waste].map(([name, tokens]) => ({ name, tokens: Math.round(tokens) })).sort((a, b) => b.tokens - a.tokens);
}

export async function buildHeadroomSession(input: {
  repository: GatewayRepository; startedAt: string | null; compressionMode: GatewayCompressionMode; accounts: GatewayAccount[];
  live: { activeRequests: number; activeWebSockets: number; relayTasks: number; compressionQueue: number } | null; now: number;
}): Promise<GatewayHeadroomSession> {
  const { repository, now } = input;
  const since = input.startedAt ?? iso(now - DAY);
  const [{ rows, sampled }, compression, signals] = await Promise.all([
    logsSince(repository, since), repository.compressionSince(since), repository.compressionSignalsSince(since)
  ]);
  const logs = rows.filter((log) => log.source !== "limit_warmup");
  const ok = logs.filter((log) => log.status === "success");
  const sum = (list: GatewayRequestLog[], pick: (log: GatewayRequestLog) => number | null) => list.reduce((total, log) => total + (pick(log) ?? 0), 0);
  const saved = sum(logs, (log) => log.compressionTokensSaved);
  const before = sum(logs, (log) => log.compressionTokensBefore);
  const after = sum(logs, (log) => log.compressionTokensAfter);
  const shadowSaved = sum(logs, (log) => (log.compressionTokensSaved === null && log.compressionTokensBefore !== null ? log.compressionTokensBefore - (log.compressionTokensAfter ?? 0) : 0));
  const inputTokens = sum(logs, (log) => log.inputTokens);
  const appliedBefore = sum(logs.filter((log) => log.compressionTokensSaved !== null), (log) => log.compressionTokensBefore);
  const requestRows = compression.filter((row) => row.strategy === "");
  const overheads = requestRows.flatMap((row: GatewayCompressionRow) => (row.requests > 0 ? [row.overheadMs / row.requests] : []));
  const overheadMax = requestRows.reduce((max, row) => Math.max(max, row.maxOverheadMs), 0);
  const overheadRequests = requestRows.reduce((total, row) => total + row.requests, 0);
  const overheadTotal = requestRows.reduce((total, row) => total + row.overheadMs, 0);

  const agents = new Map<string, { requests: number; before: number; after: number; saved: number; output: number }>();
  const models = new Map<string, { requests: number; saved: number; sent: number }>();
  const providers = new Map<string, number>();
  for (const log of logs) {
    const client = log.clientName ?? "Unknown";
    const entry = agents.get(client) ?? { requests: 0, before: 0, after: 0, saved: 0, output: 0 };
    const logSaved = log.compressionTokensSaved ?? 0;
    entry.requests += 1;
    entry.before += (log.inputTokens ?? 0) + logSaved;
    entry.after += log.inputTokens ?? 0;
    entry.saved += logSaved;
    entry.output += log.outputTokens ?? 0;
    agents.set(client, entry);
    const model = models.get(log.model) ?? { requests: 0, saved: 0, sent: 0 };
    model.requests += 1;
    model.saved += logSaved;
    model.sent += log.inputTokens ?? 0;
    models.set(log.model, model);
    providers.set(log.provider, (providers.get(log.provider) ?? 0) + 1);
  }

  const hourly = new Map<string, { saved: number; shadowSaved: number; requests: number }>();
  for (const row of requestRows) {
    const entry = hourly.get(row.hour) ?? { saved: 0, shadowSaved: 0, requests: 0 };
    const rowSaved = Math.max(0, row.originalTokens - row.compressedTokens);
    if (row.mode === "ON") entry.saved += rowSaved; else entry.shadowSaved += rowSaved;
    entry.requests += row.requests;
    hourly.set(row.hour, entry);
  }
  // Shadow request rows hold no token totals; the strategy rows do.
  for (const row of compression.filter((item) => item.strategy !== "" && item.mode === "SHADOW")) {
    const entry = hourly.get(row.hour) ?? { saved: 0, shadowSaved: 0, requests: 0 };
    entry.shadowSaved += Math.max(0, row.originalTokens - row.compressedTokens);
    hourly.set(row.hour, entry);
  }

  const cache = prefixCache(logs);
  const forward = ok.flatMap((log) => (log.latencyMs && log.latencyMs > 0 && log.inputTokens ? [(log.inputTokens / log.latencyMs) * 1000] : []));
  const generation = ok.flatMap((log) => {
    const span = (log.latencyMs ?? 0) - (log.firstTokenMs ?? 0);
    return span > 0 && log.outputTokens ? [(log.outputTokens / span) * 1000] : [];
  });
  const codexPool = gatewayPools(input.accounts, now).find((pool) => pool.provider === "CODEX");

  return gatewayHeadroomSessionSchema.parse({
    since: input.startedAt, generatedAt: iso(now), compressionMode: input.compressionMode, sampled,
    requests: { total: logs.length, completed: ok.length, failed: logs.length - ok.length,
      rateLimited: logs.filter((log) => RATE_LIMIT_CODES.has(log.errorCode ?? "")).length, cached: ok.filter((log) => (log.cachedInputTokens ?? 0) > 0).length },
    live: input.live,
    tokens: { input: inputTokens, output: sum(logs, (log) => log.outputTokens), cachedInput: sum(logs, (log) => log.cachedInputTokens),
      cacheWrites: sum(logs, (log) => log.cacheCreationTokens), compressedBefore: before, compressedAfter: after, saved, shadowSaved: Math.max(0, shadowSaved),
      savingsPercent: pct(saved, inputTokens + saved), activeSavingsPercent: pct(saved, appliedBefore) },
    performance: {
      overhead: { ...timing(overheads), averageMs: overheadRequests > 0 ? round(overheadTotal / overheadRequests, 2) : null, maxMs: overheadRequests > 0 ? round(overheadMax, 2) : null,
        samples: overheadRequests },
      ttfb: timing(ok.flatMap((log) => (log.firstTokenMs === null ? [] : [log.firstTokenMs]))),
      latency: timing(ok.flatMap((log) => (log.latencyMs === null ? [] : [log.latencyMs]))),
      throughput: { forwardP50: percentile(forward, 0.5), forwardP95: percentile(forward, 0.95), generationP50: percentile(generation, 0.5), generationP95: percentile(generation, 0.95) },
      stages: stageRows(signals)
    },
    waste: wasteRows(signals),
    savingsOverTime: [...hourly].map(([t, entry]) => ({ t, ...entry })).sort((a, b) => a.t.localeCompare(b.t)).slice(-24 * 31),
    prefixCache: cache,
    compressionVsCache: { savedTokens: saved, lostToBustTokens: cache.bustTokens, netTokens: saved - cache.bustTokens },
    agents: clientUsage(agents, saved, logs.length),
    providers: [...providers].map(([provider, requests]) => ({ provider, requests })).sort((a, b) => b.requests - a.requests),
    models: [...models].map(([model, entry]) => ({ model, requests: entry.requests, savedTokens: entry.saved, sentTokens: entry.sent,
      reductionPercent: pct(entry.saved, entry.saved + entry.sent) })).sort((a, b) => b.savedTokens - a.savedTokens || b.requests - a.requests).slice(0, 100),
    recent: rows.slice(0, 25),
    rateLimits: input.accounts.filter((account) => account.provider === "CODEX").map((account) => ({ accountId: account.id, label: account.alias ?? account.label,
      planType: account.planType, primary: account.primaryWindow, secondary: account.secondaryWindow, resetCredits: account.resetCreditsAvailable })),
    poolWeekly: codexPool ? { remainingPercent: codexPool.secondary.remainingPercent, remainingCredits: codexPool.secondary.remainingCredits,
      capacityCredits: codexPool.secondary.capacityCredits, resetAt: codexPool.secondary.resetAt } : null
  });
}

/** Saved tokens and API cost in dollars for daily rows; unpriced models count tokens only. */
function dollars(rows: GatewaySavingsDailyRow[]) {
  let savedUsd = 0;
  let cacheSavedUsd = 0;
  let unpriced = 0;
  for (const row of rows) {
    const price = priceOf(row.model, row.provider);
    if (!price) { unpriced += row.requests; continue; }
    savedUsd += row.compressionSaved * price.input;
    cacheSavedUsd += row.cachedInputTokens * Math.max(0, price.input - price.cached);
  }
  return { savedUsd: round(savedUsd, 6), cacheSavedUsd: round(cacheSavedUsd, 6), unpriced };
}

export async function buildHeadroomLifetime(input: { repository: GatewayRepository; now: number }): Promise<GatewayHeadroomLifetime> {
  const { repository, now } = input;
  const [days, signals, recent] = await Promise.all([repository.savingsDaily(), repository.compressionSignalsSince("2000-01-01T00:00:00.000Z"),
    logsSince(repository, iso(now - 7 * DAY))]);
  const total = (pick: (row: GatewaySavingsDailyRow) => number) => days.reduce((sum, row) => sum + pick(row), 0);
  const requests = total((row) => row.requests);
  const saved = total((row) => row.compressionSaved);
  const inputTokens = total((row) => row.inputTokens);
  const money = dollars(days);
  const group = <K extends string>(keyOf: (row: GatewaySavingsDailyRow) => K) => {
    const map = new Map<K, GatewaySavingsDailyRow[]>();
    for (const row of days) map.set(keyOf(row), [...(map.get(keyOf(row)) ?? []), row]);
    return map;
  };
  const clients = new Map<string, { requests: number; before: number; after: number; saved: number; output: number }>();
  for (const [client, rows] of group((row) => row.client || "Unknown")) {
    const clientSaved = rows.reduce((sum, row) => sum + row.compressionSaved, 0);
    const clientInput = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    clients.set(client, { requests: rows.reduce((sum, row) => sum + row.requests, 0), before: clientInput + clientSaved, after: clientInput, saved: clientSaved,
      output: rows.reduce((sum, row) => sum + row.outputTokens, 0) });
  }
  const modelRows = [...group((row) => row.model)].map(([model, rows]) => ({ model, requests: rows.reduce((sum, row) => sum + row.requests, 0),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
    savedTokens: rows.reduce((sum, row) => sum + row.compressionSaved, 0) })).sort((a, b) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens));
  const top = modelRows.slice(0, 100);
  const rest = modelRows.slice(100);
  if (rest.length > 0) top.push({ model: "other", requests: rest.reduce((sum, row) => sum + row.requests, 0), inputTokens: rest.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: rest.reduce((sum, row) => sum + row.outputTokens, 0), savedTokens: rest.reduce((sum, row) => sum + row.savedTokens, 0) });
  const projects = [...group((row) => row.project)].filter(([project]) => project !== "").map(([project, rows]) => {
    const projectSaved = rows.reduce((sum, row) => sum + row.compressionSaved, 0);
    const projectInput = rows.reduce((sum, row) => sum + row.inputTokens, 0);
    return { project, requests: rows.reduce((sum, row) => sum + row.requests, 0), savedTokens: projectSaved, savedUsd: dollars(rows).savedUsd, inputTokens: projectInput,
      inputCostUsd: round(rows.reduce((sum, row) => sum + row.costUsd, 0), 6), lastDay: rows.reduce((last, row) => (row.day > last ? row.day : last), ""),
      savingsPercent: pct(projectSaved, projectSaved + projectInput) };
  }).sort((a, b) => b.savedTokens - a.savedTokens || b.lastDay.localeCompare(a.lastDay)).slice(0, 50);
  const cachedRequests = total((row) => row.cachedRequests);
  return gatewayHeadroomLifetimeSchema.parse({
    since: days[0]?.day ?? null, generatedAt: iso(now),
    requests: { total: requests, completed: requests - total((row) => row.failed), failed: total((row) => row.failed), rateLimited: total((row) => row.rateLimited), cached: cachedRequests },
    tokens: { input: inputTokens, output: total((row) => row.outputTokens), attemptedInput: inputTokens + saved, saved, shadowSaved: total((row) => row.shadowSaved),
      savingsPercent: inputTokens + saved > 0 ? pct(saved, inputTokens + saved) : null },
    cost: { apiCostUsd: round(total((row) => row.costUsd), 6), compressionSavedUsd: money.savedUsd, cacheSavedUsd: money.cacheSavedUsd, unpricedRequests: money.unpriced },
    prefixCache: { requests, cachedRequests, hitRatePercent: requests > 0 ? pct(cachedRequests, requests) : null, readTokens: total((row) => row.cachedInputTokens),
      writeTokens: total((row) => row.cacheCreationTokens), busts: total((row) => row.cacheBusts), bustTokens: total((row) => row.cacheBustTokens), ttlMinutes: CACHE_TTL_MS / 60_000 },
    misses: cacheMisses(recent.rows),
    waste: wasteRows(signals),
    providers: [...group((row) => row.provider)].map(([provider, rows]) => ({ provider, requests: rows.reduce((sum, row) => sum + row.requests, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      savedTokens: rows.reduce((sum, row) => sum + row.compressionSaved, 0) })).sort((a, b) => b.requests - a.requests),
    clients: clientUsage(clients, saved, requests),
    models: top,
    projects
  });
}

/** The Monday of a UTC day. */
function weekStart(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}

export async function buildHeadroomHistory(input: { repository: GatewayRepository; retentionDays: number; now: number }): Promise<GatewayHeadroomHistory> {
  const days = await input.repository.savingsDaily();
  const series = (keyOf: (day: string) => string) => {
    const buckets = new Map<string, GatewaySavingsDailyRow[]>();
    for (const row of days) buckets.set(keyOf(row.day), [...(buckets.get(keyOf(row.day)) ?? []), row]);
    let savedTokens = 0;
    let savedUsd = 0;
    let apiCostUsd = 0;
    return [...buckets].sort((a, b) => a[0].localeCompare(b[0])).map(([key, rows]) => {
      const money = dollars(rows);
      const bucketSaved = rows.reduce((sum, row) => sum + row.compressionSaved, 0);
      const bucketCost = round(rows.reduce((sum, row) => sum + row.costUsd, 0), 6);
      savedTokens += bucketSaved;
      savedUsd += money.savedUsd;
      apiCostUsd += bucketCost;
      const byModel = new Map<string, GatewaySavingsDailyRow[]>();
      for (const row of rows) byModel.set(row.model, [...(byModel.get(row.model) ?? []), row]);
      return {
        key, savedTokens: bucketSaved, savedUsd: money.savedUsd, inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0), apiCostUsd: bucketCost,
        requests: rows.reduce((sum, row) => sum + row.requests, 0), cumulativeSavedTokens: savedTokens, cumulativeSavedUsd: round(savedUsd, 6), cumulativeApiCostUsd: round(apiCostUsd, 6),
        byModel: [...byModel].map(([model, modelRows]) => ({ model, savedTokens: modelRows.reduce((sum, row) => sum + row.compressionSaved, 0),
          savedUsd: dollars(modelRows).savedUsd, apiCostUsd: round(modelRows.reduce((sum, row) => sum + row.costUsd, 0), 6) }))
          .sort((a, b) => b.savedTokens - a.savedTokens || b.apiCostUsd - a.apiCostUsd).slice(0, 6)
      };
    });
  };
  const daily = series((day) => day);
  const weekly = series(weekStart);
  const monthly = series((day) => day.slice(0, 7));
  const savedTokens = days.reduce((sum, row) => sum + row.compressionSaved, 0);
  const models = new Map<string, GatewaySavingsDailyRow[]>();
  for (const row of days) models.set(row.model, [...(models.get(row.model) ?? []), row]);
  return gatewayHeadroomHistorySchema.parse({
    generatedAt: iso(input.now),
    lifetime: { savedTokens, savedUsd: dollars(days).savedUsd, activeDays: new Set(days.filter((row) => row.requests > 0).map((row) => row.day)).size,
      averagePerDay: daily.length ? round(savedTokens / daily.length) : 0, averagePerWeek: weekly.length ? round(savedTokens / weekly.length) : 0,
      averagePerMonth: monthly.length ? round(savedTokens / monthly.length) : 0 },
    series: { daily, weekly, monthly },
    models: [...models].map(([model, rows]) => {
      const apiCostUsd = round(rows.reduce((sum, row) => sum + row.costUsd, 0), 6);
      const savedUsd = dollars(rows).savedUsd;
      return { model, savedTokens: rows.reduce((sum, row) => sum + row.compressionSaved, 0), apiCostUsd, savedUsd, costWithoutUsd: round(apiCostUsd + savedUsd, 6) };
    }).sort((a, b) => b.savedTokens - a.savedTokens || b.apiCostUsd - a.apiCostUsd).slice(0, 200),
    retention: { requestLogDays: input.retentionDays, rollups: "kept" }
  });
}

/** Headroom's CSV export of a rollup series. */
export function historyCsv(history: GatewayHeadroomHistory, series: "daily" | "weekly" | "monthly"): string {
  const header = ["period", "tokens_saved", "compression_savings_usd", "requests", "input_tokens", "api_cost_usd", "total_tokens_saved", "total_compression_savings_usd", "total_api_cost_usd"];
  const lines = history.series[series].map((bucket) => [bucket.key, bucket.savedTokens, bucket.savedUsd.toFixed(6), bucket.requests, bucket.inputTokens, bucket.apiCostUsd.toFixed(6),
    bucket.cumulativeSavedTokens, bucket.cumulativeSavedUsd.toFixed(6), bucket.cumulativeApiCostUsd.toFixed(6)].join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}
