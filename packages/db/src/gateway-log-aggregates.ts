import type { GatewayLogStatusCategory, GatewayRequestLog, GatewayRequestLogFilter, GatewayUsageAggregate } from "@space/contracts";

/**
 * Request-log filters and aggregates for the Space Gateway admin views: the SQL the Postgres repository runs and the
 * same arithmetic over in-memory rows for the test and demo twin. Percentiles follow Postgres `percentile_cont`
 * (linear interpolation); latency and time to first token count successful requests only.
 */

/** Groups for request-log aggregates. Times are UTC. */
export type GatewayLogGroup = "total" | "model" | "provider" | "account" | "apiKey" | "client" | "project" | "route" | "errorCode" | "status"
  | "hour" | "day" | "minute";

export const gatewayRateLimitCodes = ["rate_limit_exceeded", "usage_limit_reached", "rate_limit_error", "http_429"] as const;
export const gatewayQuotaCodes = ["insufficient_quota", "usage_not_included", "quota_exceeded"] as const;

/** How a request ended. */
export function gatewayLogStatusCategory(log: { status: string; errorCode: string | null }): GatewayLogStatusCategory {
  if (log.status === "success") return "SUCCESS";
  if ((gatewayRateLimitCodes as readonly string[]).includes(log.errorCode ?? "")) return "RATE_LIMITED";
  if ((gatewayQuotaCodes as readonly string[]).includes(log.errorCode ?? "")) return "QUOTA";
  if (log.errorCode === "client_closed") return "CLIENT_CLOSED";
  return "ERROR";
}

/** The upstream route of a request as codex-lb groups it: provider, model, service tier and gateway key, joined by `|`. */
export function gatewayLogRoute(log: { provider: string; model: string; serviceTier: string | null; apiKeyId: string | null }): string {
  return `${log.provider}|${log.model}|${log.serviceTier ?? ""}|${log.apiKeyId ?? ""}`;
}

const sqlList = (items: readonly string[]) => items.map((item) => `'${item.replace(/'/g, "''")}'`).join(",");

export const statusCategorySql = `CASE WHEN l.status = 'success' THEN 'SUCCESS'
  WHEN l.error_code IN (${sqlList(gatewayRateLimitCodes)}) THEN 'RATE_LIMITED'
  WHEN l.error_code IN (${sqlList(gatewayQuotaCodes)}) THEN 'QUOTA'
  WHEN l.error_code = 'client_closed' THEN 'CLIENT_CLOSED' ELSE 'ERROR' END`;

export const groupSql: Record<GatewayLogGroup, string> = {
  total: "'total'",
  model: "l.model",
  provider: "l.provider",
  account: "COALESCE(l.account_id, '')",
  apiKey: "COALESCE(l.api_key_id, '')",
  client: "COALESCE(l.client_name, '')",
  project: "COALESCE(l.project, '')",
  route: "l.provider || '|' || l.model || '|' || COALESCE(l.service_tier, '') || '|' || COALESCE(l.api_key_id, '')",
  errorCode: "COALESCE(l.error_code, l.status)",
  status: statusCategorySql,
  hour: `to_char(date_trunc('hour', l.requested_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24":00:00.000Z"')`,
  day: "to_char(l.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')",
  minute: `to_char(date_trunc('minute', l.requested_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD"T"HH24:MI":00.000Z"')`
};

/** `%`, `_` and `\` match literally in a search. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, "\\$&")}%`;
}

/** WHERE conditions (on alias `l`) for a filter; values are appended to `values`. Statistics pass `excludeWarmup`. */
export function logFilterConditions(filter: GatewayRequestLogFilter | undefined, values: unknown[], options: { excludeWarmup?: boolean } = {}): string[] {
  const conditions: string[] = [];
  const param = (value: unknown) => { values.push(value); return `$${values.length}`; };
  if (options.excludeWarmup) conditions.push("l.source IS DISTINCT FROM 'limit_warmup'");
  if (!filter) return conditions;
  if (filter.from) conditions.push(`l.requested_at >= ${param(filter.from)}::timestamptz`);
  if (filter.to) conditions.push(`l.requested_at < ${param(filter.to)}::timestamptz`);
  if (filter.accountIds?.length) conditions.push(`l.account_id = ANY(${param(filter.accountIds)}::text[])`);
  if (filter.apiKeyIds?.length) conditions.push(`l.api_key_id = ANY(${param(filter.apiKeyIds)}::text[])`);
  if (filter.models?.length) conditions.push(`l.model = ANY(${param(filter.models)}::text[])`);
  if (filter.providers?.length) conditions.push(`l.provider = ANY(${param(filter.providers)}::text[])`);
  if (filter.clients?.length) conditions.push(`l.client_name = ANY(${param(filter.clients)}::text[])`);
  if (filter.statuses?.length) conditions.push(`(${statusCategorySql}) = ANY(${param(filter.statuses)}::text[])`);
  if (filter.q) {
    const like = param(likePattern(filter.q));
    conditions.push(`(l.request_id ILIKE ${like} OR l.model ILIKE ${like} OR l.error_code ILIKE ${like} OR l.error_message ILIKE ${like}
      OR l.client_name ILIKE ${like} OR l.project ILIKE ${like}
      OR l.account_id IN (SELECT account_id FROM space_gateway_accounts WHERE label ILIKE ${like} OR alias ILIKE ${like} OR email ILIKE ${like})
      OR l.api_key_id IN (SELECT key_id FROM space_gateway_api_keys WHERE name ILIKE ${like} OR key_prefix ILIKE ${like}))`);
  }
  return conditions;
}

export const aggregateSelectSql = `count(*) AS requests,
  count(*) FILTER (WHERE l.status <> 'success') AS errors,
  count(*) FILTER (WHERE l.error_code IN (${sqlList(gatewayRateLimitCodes)})) AS rate_limited,
  COALESCE(sum(l.input_tokens), 0) AS input_tokens, COALESCE(sum(l.cached_input_tokens), 0) AS cached_input_tokens,
  COALESCE(sum(l.cache_creation_tokens), 0) AS cache_creation_tokens, COALESCE(sum(l.output_tokens), 0) AS output_tokens,
  COALESCE(sum(l.reasoning_tokens), 0) AS reasoning_tokens, COALESCE(sum(l.cost_usd), 0) AS cost_usd,
  COALESCE(sum(l.compression_tokens_saved), 0) AS compression_tokens_saved,
  count(l.latency_ms) FILTER (WHERE l.status = 'success') AS latency_samples,
  avg(l.latency_ms) FILTER (WHERE l.status = 'success') AS latency_avg,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status = 'success') AS latency_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY l.latency_ms) FILTER (WHERE l.status = 'success') AS latency_p95,
  count(l.first_token_ms) FILTER (WHERE l.status = 'success') AS ttft_samples,
  avg(l.first_token_ms) FILTER (WHERE l.status = 'success') AS ttft_avg,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY l.first_token_ms) FILTER (WHERE l.status = 'success') AS ttft_p50,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY l.first_token_ms) FILTER (WHERE l.status = 'success') AS ttft_p95,
  max(l.requested_at) AS last_at`;

const roundMs = (value: unknown) => value === null || value === undefined ? null : Math.round(Number(value) * 10) / 10;
/** Sums of costs are rounded to a billionth of a dollar, so the order of addition never shows. */
const roundCost = (value: number) => Math.round(value * 1e9) / 1e9;

export function aggregateRecord(row: Record<string, unknown>): GatewayUsageAggregate {
  return {
    key: String(row.key ?? ""),
    requests: Number(row.requests ?? 0), errors: Number(row.errors ?? 0), rateLimited: Number(row.rate_limited ?? 0),
    inputTokens: Number(row.input_tokens ?? 0), cachedInputTokens: Number(row.cached_input_tokens ?? 0),
    cacheCreationTokens: Number(row.cache_creation_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0),
    reasoningTokens: Number(row.reasoning_tokens ?? 0), costUsd: roundCost(Number(row.cost_usd ?? 0)),
    compressionTokensSaved: Number(row.compression_tokens_saved ?? 0),
    latency: { samples: Number(row.latency_samples ?? 0), averageMs: roundMs(row.latency_avg), p50Ms: roundMs(row.latency_p50), p95Ms: roundMs(row.latency_p95) },
    ttft: { samples: Number(row.ttft_samples ?? 0), averageMs: roundMs(row.ttft_avg), p50Ms: roundMs(row.ttft_p50), p95Ms: roundMs(row.ttft_p95) },
    lastAt: row.last_at ? new Date(row.last_at as string).toISOString() : null
  };
}

/** Postgres `percentile_cont` over values. */
export function percentileCont(values: number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function groupKey(log: GatewayRequestLog, group: GatewayLogGroup): string {
  switch (group) {
    case "total": return "total";
    case "model": return log.model;
    case "provider": return log.provider;
    case "account": return log.accountId ?? "";
    case "apiKey": return log.apiKeyId ?? "";
    case "client": return log.clientName ?? "";
    case "project": return log.project ?? "";
    case "route": return gatewayLogRoute(log);
    case "errorCode": return log.errorCode ?? log.status;
    case "status": return gatewayLogStatusCategory(log);
    case "hour": return `${log.requestedAt.slice(0, 13)}:00:00.000Z`;
    case "day": return log.requestedAt.slice(0, 10);
    case "minute": return `${log.requestedAt.slice(0, 16)}:00.000Z`;
  }
}

/** In-memory filter matching `logFilterConditions`; `names` resolves account and key search text. */
export function matchesLogFilter(log: GatewayRequestLog, filter: GatewayRequestLogFilter | undefined,
  names: { account: (id: string) => string[]; key: (id: string) => string[] } = { account: () => [], key: () => [] }): boolean {
  if (!filter) return true;
  if (filter.from && log.requestedAt < new Date(filter.from).toISOString()) return false;
  if (filter.to && log.requestedAt >= new Date(filter.to).toISOString()) return false;
  if (filter.accountIds?.length && !filter.accountIds.includes(log.accountId ?? "")) return false;
  if (filter.apiKeyIds?.length && !filter.apiKeyIds.includes(log.apiKeyId ?? "")) return false;
  if (filter.models?.length && !filter.models.includes(log.model)) return false;
  if (filter.providers?.length && !(filter.providers as string[]).includes(log.provider)) return false;
  if (filter.clients?.length && !filter.clients.includes(log.clientName ?? "")) return false;
  if (filter.statuses?.length && !filter.statuses.includes(gatewayLogStatusCategory(log))) return false;
  if (filter.q) {
    const needle = filter.q.toLowerCase();
    const haystack = [log.requestId, log.model, log.errorCode, log.errorMessage, log.clientName, log.project,
      ...(log.accountId ? names.account(log.accountId) : []), ...(log.apiKeyId ? names.key(log.apiKeyId) : [])];
    if (!haystack.some((value) => value?.toLowerCase().includes(needle))) return false;
  }
  return true;
}

/** In-memory twin of the aggregate query (warm-up requests left out). */
export function aggregateLogs(logs: GatewayRequestLog[], group: GatewayLogGroup, options: { limit?: number; orderBy?: "requests" | "costUsd" | "key" } = {}): GatewayUsageAggregate[] {
  const groups = new Map<string, GatewayRequestLog[]>();
  for (const log of logs.filter((item) => item.source !== "limit_warmup")) {
    const key = groupKey(log, group);
    groups.set(key, [...(groups.get(key) ?? []), log]);
  }
  const timing = (rows: GatewayRequestLog[], pick: (log: GatewayRequestLog) => number | null) => {
    const values = rows.filter((log) => log.status === "success").map(pick).filter((value): value is number => value !== null);
    const round = (value: number | null) => value === null ? null : Math.round(value * 10) / 10;
    return { samples: values.length, averageMs: values.length ? round(values.reduce((a, b) => a + b, 0) / values.length) : null,
      p50Ms: round(percentileCont(values, 0.5)), p95Ms: round(percentileCont(values, 0.95)) };
  };
  const sum = (rows: GatewayRequestLog[], pick: (log: GatewayRequestLog) => number | null) => rows.reduce((total, log) => total + (pick(log) ?? 0), 0);
  const result = [...groups].map(([key, rows]): GatewayUsageAggregate => ({
    key, requests: rows.length, errors: rows.filter((log) => log.status !== "success").length,
    rateLimited: rows.filter((log) => (gatewayRateLimitCodes as readonly string[]).includes(log.errorCode ?? "")).length,
    inputTokens: sum(rows, (log) => log.inputTokens), cachedInputTokens: sum(rows, (log) => log.cachedInputTokens),
    cacheCreationTokens: sum(rows, (log) => log.cacheCreationTokens), outputTokens: sum(rows, (log) => log.outputTokens),
    reasoningTokens: sum(rows, (log) => log.reasoningTokens), costUsd: roundCost(sum(rows, (log) => log.costUsd)),
    compressionTokensSaved: sum(rows, (log) => log.compressionTokensSaved),
    latency: timing(rows, (log) => log.latencyMs), ttft: timing(rows, (log) => log.firstTokenMs),
    lastAt: rows.reduce<string | null>((latest, log) => (latest === null || log.requestedAt > latest ? log.requestedAt : latest), null)
  }));
  const orderBy = options.orderBy ?? "requests";
  result.sort((a, b) => orderBy === "key" ? a.key.localeCompare(b.key)
    : (orderBy === "costUsd" ? b.costUsd - a.costUsd : b.requests - a.requests) || a.key.localeCompare(b.key));
  return options.limit ? result.slice(0, options.limit) : result;
}
