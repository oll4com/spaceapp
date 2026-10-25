import { connect } from "node:net";
import {
  gatewayAccountDetailSchema, gatewayApiKeyDetailSchema, gatewayDashboardSchema, gatewayHealthSchema, gatewayPooledRemaining, gatewayPools,
  type GatewayAccount, type GatewayAccountDetail, type GatewayApiKey, type GatewayApiKeyDetail, type GatewayDashboard, type GatewayDashboardRange,
  type GatewayHealth, type GatewayHealthSignal, type GatewayLatencyRow, type GatewayLiveAccount, type GatewayRequestLog, type GatewayRequestLogFilter,
  type GatewaySignalStatus, type GatewayUsageAggregate
} from "@space/contracts";
import type { GatewayRepository, GatewayUsageHistoryPoint } from "@space/db";

/**
 * Space Gateway statistics for the admin views, after codex-lb's dashboard (MIT, Soju06/codex-lb): KPIs, cost
 * leaders, latency by model and route with codex-lb's thresholds, capacity pools in plan credits, burn projection,
 * live accounts and health signals. Everything is read from the gateway tables; nothing here touches credentials.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ranges: Record<GatewayDashboardRange, { ms: number; bucketSeconds: number; unit: "hour" | "day" }> = {
  "24h": { ms: DAY, bucketSeconds: 3600, unit: "hour" },
  "7d": { ms: 7 * DAY, bucketSeconds: 6 * 3600, unit: "day" },
  "28d": { ms: 28 * DAY, bucketSeconds: 86_400, unit: "day" }
};

const errorStatuses = ["RATE_LIMITED", "QUOTA", "CLIENT_CLOSED", "ERROR"] as const;

/** codex-lb upstream thresholds: TTFT (or completion) p95 of 8 s degrades, 15 s is critical; 5% errors degrade. */
const UPSTREAM_WARN_MS = 8000;
const UPSTREAM_CRITICAL_MS = 15_000;
const ROUTE_DONE_CRITICAL_MS = 30_000;
const ERROR_RATE_DEGRADED = 0.05;

export const emptyAggregate = (key = "total"): GatewayUsageAggregate => ({
  key, requests: 0, errors: 0, rateLimited: 0, inputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, outputTokens: 0, reasoningTokens: 0,
  costUsd: 0, compressionTokensSaved: 0, latency: { samples: 0, averageMs: null, p50Ms: null, p95Ms: null },
  ttft: { samples: 0, averageMs: null, p50Ms: null, p95Ms: null }, lastAt: null
});

const iso = (ms: number) => new Date(ms).toISOString();
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

async function errorSummary(repository: GatewayRepository, fromMs: number, toMs: number) {
  const filter: GatewayRequestLogFilter = { from: iso(fromMs), to: iso(toMs) };
  const [[total], [top]] = await Promise.all([
    repository.aggregateRequestLogs(filter, "total"),
    repository.aggregateRequestLogs({ ...filter, statuses: [...errorStatuses] }, "errorCode", { limit: 1 })
  ]);
  const requests = total?.requests ?? 0;
  const errors = total?.errors ?? 0;
  return {
    minutes: Math.round((toMs - fromMs) / 60_000), requests, errors, errorRate: requests > 0 ? round(errors / requests) : null,
    topError: top ? { code: top.key.slice(0, 120), count: top.requests } : null
  };
}

/** codex-lb status for an upstream group: thresholds on TTFT p95 (or completion p95), degraded at 5% errors. */
export function upstreamStatus(row: GatewayUsageAggregate, options: { route?: boolean } = {}): { status: GatewaySignalStatus; detail: string } {
  if (row.requests === 0) return { status: "UNAVAILABLE", detail: "No requests." };
  const errorRate = row.errors / row.requests;
  const measure = row.ttft.p95Ms ?? row.latency.p95Ms;
  const label = row.ttft.p95Ms !== null ? "TTFT p95" : "Latency p95";
  const errors = `errors ${(errorRate * 100).toFixed(1)}%`;
  if (row.latency.samples === 0) return { status: "DEGRADED", detail: `No successful request; ${errors}` };
  if (errorRate >= ERROR_RATE_DEGRADED) return { status: "DEGRADED", detail: `${errors} ≥ 5%` };
  if (options.route && row.latency.p95Ms !== null && row.latency.p95Ms >= ROUTE_DONE_CRITICAL_MS) {
    return { status: "DEGRADED", detail: `Done p95 ${(row.latency.p95Ms / 1000).toFixed(1)}s ≥ 30s; ${errors}` };
  }
  if (measure !== null && measure >= UPSTREAM_WARN_MS) {
    return { status: "DEGRADED", detail: `${label} ${(measure / 1000).toFixed(1)}s ≥ ${measure >= UPSTREAM_CRITICAL_MS ? "15" : "8"}s; ${errors}` };
  }
  return { status: "OK", detail: `${label} ${measure === null ? "—" : `${(measure / 1000).toFixed(1)}s`}; ${errors}` };
}

function latencyRow(row: GatewayUsageAggregate, parts: { label: string; provider?: string | null; model?: string | null; serviceTier?: string | null; apiKeyId?: string | null },
  route = false): GatewayLatencyRow {
  const { status, detail } = upstreamStatus(row, { route });
  return {
    key: row.key.slice(0, 400), label: parts.label.slice(0, 200), provider: (parts.provider ?? null) as GatewayLatencyRow["provider"], model: parts.model ?? null,
    serviceTier: parts.serviceTier || null, apiKeyId: parts.apiKeyId || null, samples: row.requests, errors: row.errors,
    errorRate: row.requests > 0 ? round(row.errors / row.requests) : 0, averageMs: row.latency.averageMs, p50Ms: row.latency.p50Ms,
    p95Ms: row.latency.p95Ms, ttftP50Ms: row.ttft.p50Ms, ttftP95Ms: row.ttft.p95Ms, status, detail
  };
}

/** Time buckets from the aligned start of the range to now, with zeros where nothing happened. */
function fillBuckets(rows: GatewayUsageAggregate[], fromMs: number, toMs: number, bucketSeconds: number) {
  const size = bucketSeconds * 1000;
  const start = Math.floor(fromMs / size) * size;
  const buckets = new Map<number, { t: string; requests: number; errors: number; tokens: number; costUsd: number }>();
  for (let at = start; at <= toMs; at += size) buckets.set(at, { t: iso(at), requests: 0, errors: 0, tokens: 0, costUsd: 0 });
  for (const row of rows) {
    const at = Math.floor(Date.parse(row.key.length === 10 ? `${row.key}T00:00:00.000Z` : row.key) / size) * size;
    const bucket = buckets.get(at);
    if (!bucket) continue;
    bucket.requests += row.requests;
    bucket.errors += row.errors;
    bucket.tokens += row.inputTokens + row.outputTokens;
    bucket.costUsd = round(bucket.costUsd + row.costUsd, 6);
  }
  return [...buckets.values()];
}

function topWithOther<T extends { requests: number; costUsd: number }>(rows: T[], limit: number, other: (requests: number, costUsd: number) => T): T[] {
  const sorted = [...rows].sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
  const top = sorted.slice(0, limit);
  const rest = sorted.slice(limit);
  if (rest.length > 0) top.push(other(rest.reduce((sum, row) => sum + row.requests, 0), round(rest.reduce((sum, row) => sum + row.costUsd, 0), 6)));
  return top;
}

export interface GatewayLiveSnapshot {
  /** Requests in flight per account, from the gateway status endpoint (null when the gateway does not report them). */
  inFlightByAccount: Record<string, number> | null;
}

export async function buildGatewayDashboard(input: {
  repository: GatewayRepository;
  range: GatewayDashboardRange;
  accounts: GatewayAccount[];
  keys: GatewayApiKey[];
  live?: GatewayLiveSnapshot;
  now: number;
}): Promise<GatewayDashboard> {
  const { repository, now } = input;
  const config = ranges[input.range];
  const fromMs = now - config.ms;
  const filter: GatewayRequestLogFilter = { from: iso(fromMs), to: iso(now + 1) };
  const [totalsRows, trendRows, byKey, byModel, latency, routes, errorRate, errorRate7d, errorRate5m, recent, lastMinute] = await Promise.all([
    repository.aggregateRequestLogs(filter, "total"),
    repository.aggregateRequestLogs(filter, config.bucketSeconds === 86_400 ? "day" : "hour", { orderBy: "key" }),
    repository.aggregateRequestLogs(filter, "apiKey", { orderBy: "costUsd" }),
    repository.aggregateRequestLogs(filter, "model", { orderBy: "costUsd" }),
    repository.aggregateRequestLogs(filter, "model", { limit: 8 }),
    repository.aggregateRequestLogs(filter, "route", { limit: 40 }),
    errorSummary(repository, fromMs, now + 1),
    errorSummary(repository, now - 7 * DAY, now + 1),
    errorSummary(repository, now - 5 * 60_000, now + 1),
    repository.listRequestLogs({ limit: 10 }),
    repository.listRequestLogs({ limit: 200, filter: { from: iso(now - 60_000) } })
  ]);
  const totals = totalsRows[0] ?? emptyAggregate();
  const periods = Math.max(1, config.ms / (config.unit === "hour" ? HOUR : DAY));
  const keyNames = new Map(input.keys.map((key) => [key.id, key.name]));
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));

  const topKeys = topWithOther(byKey.map((row) => ({ apiKeyId: row.key, name: (row.key ? keyNames.get(row.key) ?? "Removed key" : "No key").slice(0, 120),
    requests: row.requests, costUsd: row.costUsd })), 5, (requests, costUsd) => ({ apiKeyId: "other", name: "Other keys", requests, costUsd }));
  const topModels = topWithOther(byModel.map((row) => ({ model: row.key.slice(0, 200), requests: row.requests, costUsd: row.costUsd })), 5,
    (requests, costUsd) => ({ model: "Other models", requests, costUsd }));

  const routeRows = routes.map((row) => {
    const [provider = "", model = "", tier = "", apiKeyId = ""] = row.key.split("|");
    const keyName = apiKeyId ? keyNames.get(apiKeyId) ?? "Removed key" : "No key";
    return latencyRow(row, { label: `${model}${tier ? ` · ${tier}` : ""} · ${keyName}`, provider, model, serviceTier: tier, apiKeyId }, true);
  }).sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1) || (b.ttftP95Ms ?? -1) - (a.ttftP95Ms ?? -1)).slice(0, 8);

  const liveByAccount = new Map<string, { requests: number; tokens: number; lastAt: string; model: string; transport: string | null }>();
  for (const log of lastMinute.filter((item) => item.accountId && item.source !== "limit_warmup")) {
    const entry = liveByAccount.get(log.accountId!);
    const tokens = (log.inputTokens ?? 0) + (log.outputTokens ?? 0);
    if (!entry) liveByAccount.set(log.accountId!, { requests: 1, tokens, lastAt: log.requestedAt, model: log.model, transport: log.transport });
    else { entry.requests += 1; entry.tokens += tokens; }
  }
  const inFlight = input.live?.inFlightByAccount ?? null;
  const liveIds = new Set([...liveByAccount.keys(), ...Object.entries(inFlight ?? {}).filter(([, count]) => count > 0).map(([id]) => id)]);
  const live: GatewayLiveAccount[] = [...liveIds].flatMap((accountId) => {
    const account = accountById.get(accountId);
    if (!account) return [];
    const recentUse = liveByAccount.get(accountId);
    const active = inFlight ? inFlight[accountId] ?? 0 : null;
    return [{
      accountId, label: account.alias ?? account.label, planType: account.planType, provider: account.provider, activeRequests: active,
      requests: recentUse?.requests ?? 0, tokens: recentUse?.tokens ?? 0, lastAt: recentUse?.lastAt ?? null, model: recentUse?.model ?? null,
      transport: recentUse?.transport ?? null, state: (active ?? 0) > 0 ? "LIVE" as const : "RECENT" as const
    }];
  }).sort((a, b) => (a.state === b.state ? 0 : a.state === "LIVE" ? -1 : 1) || (b.activeRequests ?? 0) - (a.activeRequests ?? 0)
    || (b.lastAt ?? "").localeCompare(a.lastAt ?? "")).slice(0, 12);

  return gatewayDashboardSchema.parse({
    range: input.range, from: iso(fromMs), to: iso(now), bucketSeconds: config.bucketSeconds, generatedAt: iso(now), totals,
    perPeriod: { unit: config.unit, requests: round(totals.requests / periods, 2), costUsd: round(totals.costUsd / periods, 6),
      tokens: round((totals.inputTokens + totals.outputTokens) / periods, 2) },
    errorRate, errorRate7d, errorRate5m,
    trend: fillBuckets(trendRows, fromMs, now, config.bucketSeconds),
    topKeys, topModels,
    latencyByModel: latency.map((row) => latencyRow(row, { label: row.key, model: row.key })),
    routes: routeRows,
    pools: gatewayPools(input.accounts, now),
    live,
    recent
  });
}

const signalLabels: Record<GatewayHealthSignal["key"], string> = {
  gateway: "Gateway API", database: "Database", upstream: "Upstream providers", lan: "LAN listener", internet: "Internet", compression: "Compression workers"
};

const thresholds: Record<GatewayHealthSignal["key"], [number, number]> = {
  gateway: [250, 1000], database: [50, 250], upstream: [UPSTREAM_WARN_MS, UPSTREAM_CRITICAL_MS], lan: [150, 600], internet: [500, 1500], compression: [100, 250]
};

interface SignalState { samples: { at: number; ms: number | null }[]; detail: string; updatedAt: number | null; forcedStatus: GatewaySignalStatus | null }

function percentile(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * fraction;
  const lower = Math.floor(rank);
  const upper = Math.min(lower + 1, sorted.length - 1);
  return Math.round((sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower)) * 10) / 10;
}

export interface GatewayHealthProbes {
  /** Time a request to the gateway's /health. */
  gateway(): Promise<number>;
  /** The gateway's LAN listener ("host:port") or null when LAN access is off. */
  lanListen(): Promise<string | null>;
  /** TCP connect time to an address. */
  connect(host: string, port: number): Promise<number>;
  /** Time an internet request (gstatic generate_204). */
  internet(): Promise<number>;
}

/** Health signals with codex-lb's rules: the last 30 samples per signal, refreshed at most every 10 s (internet 30 s). */
export class GatewayHealthSampler {
  private readonly state = new Map<GatewayHealthSignal["key"], SignalState>();
  private sampling: Promise<void> | null = null;
  private lastSampleAt = Number.NEGATIVE_INFINITY;
  private lastInternetAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly options: { repository: GatewayRepository; probes: GatewayHealthProbes; now?: () => number; refreshMs?: number; internetRefreshMs?: number }) {}

  private record(key: GatewayHealthSignal["key"], ms: number | null, detail: string, forcedStatus: GatewaySignalStatus | null = null) {
    const state = this.state.get(key) ?? { samples: [], detail: "", updatedAt: null, forcedStatus: null };
    const now = (this.options.now ?? Date.now)();
    state.samples.push({ at: now, ms });
    if (state.samples.length > 30) state.samples.splice(0, state.samples.length - 30);
    state.detail = detail.slice(0, 300);
    state.updatedAt = now;
    state.forcedStatus = forcedStatus;
    this.state.set(key, state);
  }

  private async timed(key: GatewayHealthSignal["key"], run: () => Promise<number>, ok: string) {
    try {
      const ms = await run();
      this.record(key, Math.round(ms * 10) / 10, ok);
    } catch (error) {
      this.record(key, null, error instanceof Error ? error.message : "The check failed.");
    }
  }

  private async sample() {
    const now = (this.options.now ?? Date.now)();
    const { repository, probes } = this.options;
    const tasks: Promise<void>[] = [
      this.timed("gateway", () => probes.gateway(), "GET /health"),
      this.timed("database", () => repository.ping(), "SELECT 1"),
      (async () => {
        const [[row]] = await Promise.all([repository.aggregateRequestLogs({ from: iso(now - 15 * 60_000) }, "total")]);
        const recent = row ?? emptyAggregate();
        const status = upstreamStatus(recent);
        this.record("upstream", recent.ttft.p50Ms ?? recent.latency.p50Ms, `${recent.requests} requests in 15 min; ${status.detail}`,
          recent.requests === 0 ? "UNAVAILABLE" : status.status === "DEGRADED" ? "DEGRADED" : null);
      })().catch((error: unknown) => this.record("upstream", null, error instanceof Error ? error.message : "Request logs are unavailable.")),
      (async () => {
        const lan = await probes.lanListen();
        if (!lan) { this.record("lan", null, "LAN access is off.", "UNAVAILABLE"); return; }
        const separator = lan.lastIndexOf(":");
        const host = lan.slice(0, separator);
        const port = Number(lan.slice(separator + 1));
        await this.timed("lan", () => probes.connect(host, port), `TCP connect ${lan}`);
      })().catch(() => this.record("lan", null, "The LAN check failed.")),
      (async () => {
        const rows = await repository.compressionSince(iso(now - HOUR));
        const requests = rows.filter((item) => item.strategy === "").reduce((sum, item) => sum + item.requests, 0);
        const overhead = rows.filter((item) => item.strategy === "").reduce((sum, item) => sum + item.overheadMs, 0);
        if (requests === 0) { this.record("compression", null, "No compressed or measured requests in the last hour.", "UNAVAILABLE"); return; }
        this.record("compression", Math.round((overhead / requests) * 10) / 10, `Average overhead of ${requests} requests in the last hour`);
      })().catch(() => this.record("compression", null, "Compression statistics are unavailable."))
    ];
    if (now - this.lastInternetAt >= (this.options.internetRefreshMs ?? 30_000)) {
      this.lastInternetAt = now;
      tasks.push(this.timed("internet", () => probes.internet(), "GET www.gstatic.com/generate_204"));
    }
    await Promise.all(tasks);
    this.lastSampleAt = (this.options.now ?? Date.now)();
  }

  async snapshot(): Promise<GatewayHealth> {
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastSampleAt >= (this.options.refreshMs ?? 10_000)) {
      this.sampling ??= this.sample().finally(() => { this.sampling = null; });
      await this.sampling;
    }
    const current = (this.options.now ?? Date.now)();
    const signals = (Object.keys(signalLabels) as GatewayHealthSignal["key"][]).map((key): GatewayHealthSignal => {
      const state = this.state.get(key);
      const values = (state?.samples ?? []).map((sample) => sample.ms).filter((value): value is number => value !== null);
      const [warn, critical] = thresholds[key];
      const latest = state?.samples.at(-1);
      const nowMs = latest?.ms ?? null;
      const staleAfter = key === "internet" ? 90_000 : 30_000;
      let status: GatewaySignalStatus;
      if (!state || state.updatedAt === null) status = "UNAVAILABLE";
      else if (current - state.updatedAt > staleAfter) status = "STALE";
      else if (state.forcedStatus) status = state.forcedStatus;
      else if (nowMs === null) status = "UNAVAILABLE";
      else status = nowMs >= warn ? "DEGRADED" : "OK";
      return {
        key, label: signalLabels[key], status, nowMs, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95), samples: values.length,
        sparkline: values.slice(-12), warnMs: warn, criticalMs: critical, detail: state?.detail ?? "Not checked yet.",
        updatedAt: state?.updatedAt ? iso(state.updatedAt) : null
      };
    });
    return gatewayHealthSchema.parse({ signals, generatedAt: iso(current) });
  }
}

/** Default probes: the gateway's own /health, a TCP connect for the LAN listener, and gstatic for the internet. */
export function defaultHealthProbes(options: { gatewayUrl: string; fetchImpl?: typeof fetch; lanListen: () => Promise<string | null> }): GatewayHealthProbes {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timed = async (url: string) => {
    const started = performance.now();
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(1500), redirect: "manual" });
    await response.arrayBuffer().catch(() => undefined);
    if (response.status >= 500) throw new Error(`HTTP ${response.status}`);
    return performance.now() - started;
  };
  return {
    gateway: () => timed(`${options.gatewayUrl}/health`),
    lanListen: options.lanListen,
    connect: (host, port) => new Promise<number>((resolve, reject) => {
      const started = performance.now();
      const socket = connect({ host, port, timeout: 1500 });
      socket.once("connect", () => { socket.destroy(); resolve(performance.now() - started); });
      socket.once("timeout", () => { socket.destroy(); reject(new Error("TCP connect timed out.")); });
      socket.once("error", (error) => { socket.destroy(); reject(error); });
    }),
    internet: () => timed("https://www.gstatic.com/generate_204")
  };
}

/** Hourly remaining-percent series over 7 days, carried forward, with codex-lb's even-burn weekly plan line. */
export function accountTrend(points: GatewayUsageHistoryPoint[], account: GatewayAccount, now: number) {
  const start = Math.floor((now - 7 * DAY) / HOUR) * HOUR;
  const hours = Math.floor((now - start) / HOUR) + 1;
  const series = (window: "PRIMARY" | "SECONDARY") => {
    const own = points.filter((point) => point.window === window && point.quotaKey === "");
    // Accounts with quota groups (Antigravity) follow their most used group.
    const source = own.length > 0 ? own : points.filter((point) => point.window === window);
    const result: { t: string; value: number; resetAt: string | null }[] = [];
    let index = 0;
    let lastUsed: number | null = null;
    let lastReset: string | null = null;
    while (index < source.length && Date.parse(source[index]!.recordedAt) < start) {
      lastUsed = source[index]!.usedPercent;
      lastReset = source[index]!.resetAt;
      index += 1;
    }
    for (let hour = 0; hour < hours; hour += 1) {
      const bucketStart = start + hour * HOUR;
      const inBucket: GatewayUsageHistoryPoint[] = [];
      while (index < source.length && Date.parse(source[index]!.recordedAt) < bucketStart + HOUR) inBucket.push(source[index++]!);
      if (inBucket.length > 0) {
        lastUsed = Math.max(...inBucket.map((point) => point.usedPercent));
        lastReset = inBucket.at(-1)!.resetAt;
      }
      result.push({ t: iso(bucketStart), value: Math.max(0, Math.min(100, 100 - (lastUsed ?? 0))), resetAt: lastReset });
    }
    return result;
  };
  const primary = series("PRIMARY");
  const secondary = series("SECONDARY");
  const windowSeconds = (account.secondaryWindow.windowMinutes ?? 10_080) * 60;
  const secondaryScheduled = secondary.filter((point) => point.resetAt).map((point) => {
    const remaining = Math.max(0, Math.min(windowSeconds, (Date.parse(point.resetAt!) - Date.parse(point.t)) / 1000));
    return { t: point.t, value: Math.round((100 * remaining / windowSeconds) * 100) / 100 };
  });
  const plain = (rows: { t: string; value: number }[]) => rows.map(({ t, value }) => ({ t, value: Math.round(value * 100) / 100 }));
  return { primary: plain(primary), secondary: plain(secondary), secondaryScheduled };
}

export async function buildAccountDetail(input: {
  repository: GatewayRepository;
  account: GatewayAccount & { credentialsExpiresAt?: string | null; source?: string };
  tokenStatus: { accessExpiresAt: string | null; refreshStored: boolean | null; idTokenParsed: boolean | null } | null;
  now: number;
}): Promise<GatewayAccountDetail> {
  const { repository, account, now } = input;
  const [lifetime, [last7d], history, warmups] = await Promise.all([
    repository.usageTotals({ accountId: account.id }),
    repository.aggregateRequestLogs({ from: iso(now - 7 * DAY), accountIds: [account.id] }, "total"),
    repository.usageHistory(account.id, iso(now - 8 * DAY)),
    repository.latestWarmups()
  ]);
  const warmup = warmups.find((row) => row.accountId === account.id);
  const { credentialsExpiresAt: _expires, source, ...publicAccount } = account as GatewayAccount & { credentialsExpiresAt?: string | null; source?: string; [key: string]: unknown };
  const cleanAccount = Object.fromEntries(Object.entries(publicAccount).filter(([field]) =>
    !["externalAccountId", "credentialsEncrypted", "sourceRef", "blockedUntil"].includes(field))) as GatewayAccount;
  return gatewayAccountDetailSchema.parse({
    account: cleanAccount,
    lifetime,
    last7d: last7d ?? emptyAggregate(),
    trend: accountTrend(history, account, now),
    tokenStatus: {
      accessExpiresAt: input.tokenStatus?.accessExpiresAt ?? account.credentialsExpiresAt ?? null,
      refreshStored: input.tokenStatus?.refreshStored ?? null,
      idTokenParsed: input.tokenStatus?.idTokenParsed ?? null,
      lastRefreshAt: account.lastRefreshAt,
      source: (source ?? "unknown").toLowerCase().replace(/_/g, " ").slice(0, 40)
    },
    lastWarmup: warmup ? { window: warmup.window, status: warmup.status, model: warmup.model, attemptedAt: warmup.attemptedAt, errorCode: warmup.errorCode } : null
  });
}

export async function buildApiKeyDetail(input: { repository: GatewayRepository; key: GatewayApiKey; accounts: GatewayAccount[]; now: number }): Promise<GatewayApiKeyDetail> {
  const { repository, key, now } = input;
  const filter: GatewayRequestLogFilter = { from: iso(now - 7 * DAY), apiKeyIds: [key.id] };
  const [lifetime, [last7d], byAccount, hourly] = await Promise.all([
    repository.usageTotals({ apiKeyId: key.id }),
    repository.aggregateRequestLogs(filter, "total"),
    repository.aggregateRequestLogs(filter, "account", { orderBy: "costUsd" }),
    repository.aggregateRequestLogs(filter, "hour", { orderBy: "key" })
  ]);
  const accountById = new Map(input.accounts.map((account) => [account.id, account]));
  const start = Math.floor((now - 7 * DAY) / HOUR) * HOUR;
  const byHour = new Map(hourly.map((row) => [row.key, row]));
  const trend: GatewayApiKeyDetail["trend"] = [];
  for (let at = start; at <= now; at += HOUR) {
    const row = byHour.get(iso(at));
    trend.push({ t: iso(at), tokens: row ? row.inputTokens + row.outputTokens : 0, costUsd: row?.costUsd ?? 0, requests: row?.requests ?? 0 });
  }
  return gatewayApiKeyDetailSchema.parse({
    key, lifetime, last7d: last7d ?? emptyAggregate(),
    costByAccount: byAccount.map((row) => {
      const account = row.key ? accountById.get(row.key) : undefined;
      return { accountId: row.key || "none", label: (account ? account.alias ?? account.label : row.key ? "Removed account" : "No account").slice(0, 120),
        requests: row.requests, costUsd: row.costUsd, deleted: Boolean(row.key) && !account };
    }),
    trend,
    pooled: gatewayPooledRemaining(input.accounts, key, now)
  });
}

const csvColumns: { header: string; value: (log: GatewayRequestLog, names: { account: (id: string | null) => string; key: (id: string | null) => string }) => unknown }[] = [
  { header: "requested_at", value: (log) => log.requestedAt },
  { header: "request_id", value: (log) => log.requestId },
  { header: "provider", value: (log) => log.provider },
  { header: "account", value: (log, names) => names.account(log.accountId) },
  { header: "plan", value: (log) => log.planType },
  { header: "api_key", value: (log, names) => names.key(log.apiKeyId) },
  { header: "client", value: (log) => log.clientName },
  { header: "project", value: (log) => log.project },
  { header: "model", value: (log) => log.model },
  { header: "reasoning_effort", value: (log) => log.reasoningEffort },
  { header: "service_tier", value: (log) => log.serviceTier },
  { header: "requested_service_tier", value: (log) => log.requestedServiceTier },
  { header: "transport", value: (log) => log.transport },
  { header: "upstream_transport", value: (log) => log.upstreamTransport },
  { header: "status", value: (log) => log.status },
  { header: "error_code", value: (log) => log.errorCode },
  { header: "error_message", value: (log) => log.errorMessage },
  { header: "latency_ms", value: (log) => log.latencyMs },
  { header: "first_token_ms", value: (log) => log.firstTokenMs },
  { header: "input_tokens", value: (log) => log.inputTokens },
  { header: "cached_input_tokens", value: (log) => log.cachedInputTokens },
  { header: "cache_creation_tokens", value: (log) => log.cacheCreationTokens },
  { header: "output_tokens", value: (log) => log.outputTokens },
  { header: "reasoning_tokens", value: (log) => log.reasoningTokens },
  { header: "cost_usd", value: (log) => log.costUsd },
  { header: "compression_tokens_before", value: (log) => log.compressionTokensBefore },
  { header: "compression_tokens_after", value: (log) => log.compressionTokensAfter },
  { header: "compression_tokens_saved", value: (log) => log.compressionTokensSaved },
  { header: "sticky_kind", value: (log) => log.stickyKind },
  { header: "source", value: (log) => log.source }
];

/** RFC 4180 CSV; cells that a spreadsheet would run as a formula are prefixed with an apostrophe. */
export function requestLogCsv(logs: GatewayRequestLog[], names: { account: (id: string | null) => string; key: (id: string | null) => string }): string {
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return "";
    let text = String(value);
    if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [csvColumns.map((column) => column.header).join(","), ...logs.map((log) => csvColumns.map((column) => cell(column.value(log, names))).join(","))].join("\n") + "\n";
}
