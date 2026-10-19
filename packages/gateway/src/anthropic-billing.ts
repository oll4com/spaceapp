import type { GatewayAnthropicAdminStatus, GatewayAnthropicBillingReport, GatewayAnthropicUpstreamKey } from "@space/contracts";
import type { GatewayAnthropicAdminRecord, GatewayAnthropicUsageRow, GatewayRepository } from "@space/db";
import { claudeReportCostUsd } from "./pricing/pricing.js";

/**
 * Anthropic's own bill through the Admin API (operator request 2026-10-18, plan clipboard:1uiLgPcnGg4P): the cost report
 * (cents, per day, workspace and description) and the usage report (tokens per day, workspace, API key, model, context
 * window and speed). Per model, Anthropic's standard-tier token charge divided by the same tokens at list price is a
 * factor that turns Space Gateway's list-price estimate into the real charge; it holds even when the Anthropic key also
 * serves traffic outside the gateway, because it is a price ratio, not a volume.
 */

/** Additional data of the sealed admin key in the gateway's credential cipher. */
export const ANTHROPIC_ADMIN_KEY_AAD = "anthropic-admin-key";
const apiBase = "https://api.anthropic.com";
export const anthropicTokenItems = ["uncached_input_tokens", "cache_read_input_tokens", "cache_creation.ephemeral_5m_input_tokens",
  "cache_creation.ephemeral_1h_input_tokens", "output_tokens"] as const;
/** Below this list cost a day's factor is noise. */
const minimumListUsd = 0.05;
const maxPages = 20;

export class AnthropicAdminError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** One Admin API read. Errors carry a code and the HTTP status only, never the key or the answer. */
export async function anthropicAdminGet(adminKey: string, path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(`${apiBase}${path}`, {
      headers: { "x-api-key": adminKey, "anthropic-version": "2023-06-01", "user-agent": "SpaceGateway/1.0 (https://spaceapp.dev)" },
      signal: AbortSignal.timeout(30_000)
    });
  } catch {
    throw new AnthropicAdminError("anthropic_unreachable", 0);
  }
  if (!response.ok) throw new AnthropicAdminError(`anthropic_http_${response.status}`, response.status);
  try {
    return await response.json();
  } catch {
    throw new AnthropicAdminError("anthropic_invalid_response", response.status);
  }
}

export interface AnthropicApiKey { id: string; name: string; partialKeyHint: string | null; workspaceId: string }

export async function listAnthropicApiKeys(adminKey: string, fetchImpl: typeof fetch = fetch): Promise<AnthropicApiKey[]> {
  const keys: AnthropicApiKey[] = [];
  let after: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const body = await anthropicAdminGet(adminKey, `/v1/organizations/api_keys?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ""}`, fetchImpl) as
      { data?: { id?: unknown; name?: unknown; partial_key_hint?: unknown; workspace_id?: unknown }[]; has_more?: unknown; last_id?: unknown };
    if (!Array.isArray(body?.data)) throw new AnthropicAdminError("anthropic_invalid_response", 200);
    for (const key of body.data) {
      if (typeof key.id !== "string") continue;
      // The deprecated `workspace_id` is null for the default workspace, as in the reports.
      keys.push({ id: key.id.slice(0, 120), name: String(key.name ?? "").slice(0, 200), partialKeyHint: typeof key.partial_key_hint === "string" ? key.partial_key_hint : null,
        workspaceId: typeof key.workspace_id === "string" ? key.workspace_id.slice(0, 120) : "" });
    }
    if (body.has_more !== true || typeof body.last_id !== "string") break;
    after = body.last_id;
  }
  return keys;
}

/** The key whose `partial_key_hint` ("sk-ant-api03-R2D...igAA") fits the plain key; null unless exactly one does. */
export function matchAnthropicKey(plainKey: string, keys: AnthropicApiKey[]): AnthropicApiKey | null {
  const matches = keys.filter((key) => {
    const [head, tail, extra] = (key.partialKeyHint ?? "").split("...");
    return Boolean(head) && tail !== undefined && tail.length >= 4 && extra === undefined && plainKey.startsWith(head!) && plainKey.endsWith(tail);
  });
  return matches.length === 1 ? matches[0]! : null;
}

type ReportBucket = { starting_at?: unknown; results?: Record<string, unknown>[] };

async function reportBuckets(adminKey: string, path: string, params: [string, string][], fetchImpl: typeof fetch): Promise<ReportBucket[]> {
  const buckets: ReportBucket[] = [];
  let page: string | null = null;
  for (let index = 0; index < maxPages; index += 1) {
    const query = new URLSearchParams(params);
    if (page) query.set("page", page);
    const body = await anthropicAdminGet(adminKey, `${path}?${query}`, fetchImpl) as { data?: unknown; has_more?: unknown; next_page?: unknown };
    if (!Array.isArray(body?.data)) throw new AnthropicAdminError("anthropic_invalid_response", 200);
    buckets.push(...(body.data as ReportBucket[]));
    if (body.has_more !== true || typeof body.next_page !== "string") break;
    page = body.next_page;
  }
  return buckets;
}

const text = (value: unknown, max = 160) => (typeof value === "string" ? value.slice(0, max) : "");
/** Report and log model names compare without a dated snapshot suffix. */
export const anthropicModelName = (model: string) => model.replace(/-\d{8}$/, "");

/** The cost and usage reports of the UTC days `fromDay` (inclusive) to `toDay` (exclusive), as rows. */
export async function fetchAnthropicReports(adminKey: string, range: { fromDay: string; toDay: string }, fetchImpl: typeof fetch = fetch): Promise<GatewayAnthropicUsageRow[]> {
  const window: [string, string][] = [["starting_at", `${range.fromDay}T00:00:00Z`], ["ending_at", `${range.toDay}T00:00:00Z`], ["limit", "31"]];
  const cost = await reportBuckets(adminKey, "/v1/organizations/cost_report", [...window, ["group_by[]", "workspace_id"], ["group_by[]", "description"]], fetchImpl);
  const usage = await reportBuckets(adminKey, "/v1/organizations/usage_report/messages", [...window, ["bucket_width", "1d"], ["service_tiers[]", "standard"],
    ...["workspace_id", "api_key_id", "model", "context_window", "speed"].map((group): [string, string] => ["group_by[]", group])], fetchImpl);
  const cells = new Map<string, GatewayAnthropicUsageRow>();
  const add = (row: Omit<GatewayAnthropicUsageRow, "value">, value: number) => {
    if (!Number.isFinite(value) || value === 0) return;
    const key = [row.day, row.source, row.workspaceId, row.apiKeyId, row.model, row.contextWindow, row.speed, row.item].join("\u0000");
    const existing = cells.get(key);
    if (existing) existing.value += value;
    else cells.set(key, { ...row, value });
  };
  const dayOf = (bucket: ReportBucket) => {
    const day = text(bucket.starting_at).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
  };
  for (const bucket of cost) {
    const day = dayOf(bucket);
    if (!day) continue;
    for (const result of bucket.results ?? []) {
      // Token charges keep their token type; batch charges are kept apart so the factor compares standard tier only.
      const item = result.cost_type === "tokens" ? `${result.service_tier === "batch" ? "batch:" : ""}${text(result.token_type, 80) || "unknown"}` : text(result.cost_type, 80) || "other";
      add({ day, source: "COST", workspaceId: text(result.workspace_id, 120), apiKeyId: "", model: anthropicModelName(text(result.model)),
        contextWindow: text(result.context_window, 20), speed: text(result.speed, 20), item }, Number(result.amount));
    }
  }
  for (const bucket of usage) {
    const day = dayOf(bucket);
    if (!day) continue;
    for (const result of bucket.results ?? []) {
      const base = { day, source: "USAGE" as const, workspaceId: text(result.workspace_id, 120), apiKeyId: text(result.api_key_id, 120),
        model: anthropicModelName(text(result.model)), contextWindow: text(result.context_window, 20), speed: text(result.speed, 20) };
      const creation = (result.cache_creation ?? {}) as Record<string, unknown>;
      for (const item of anthropicTokenItems) {
        add({ ...base, item }, Number(item.startsWith("cache_creation.") ? creation[item.slice("cache_creation.".length)] : result[item]));
      }
      add({ ...base, item: "web_search_requests" }, Number((result.server_tool_use as Record<string, unknown> | undefined)?.web_search_requests));
    }
  }
  return [...cells.values()];
}

export interface AnthropicModelFactor { model: string; billedUsd: number; listUsd: number; factor: number | null }

/**
 * Per model over the UTC days `fromDay` to `toDay` (inclusive) and the given workspaces: Anthropic's standard-tier token
 * charge and the same tokens at list price. shortcut: a `0-200k` cell is priced on the base card, so a model whose long
 * card starts lower (Haiku 5.5 at 100k) reads a factor above 1 for its 100k-200k prompts; split by request size if such a
 * model carries real volume.
 */
export function anthropicModelFactors(rows: GatewayAnthropicUsageRow[], range: { fromDay: string; toDay: string }, workspaceIds: ReadonlySet<string>): Map<string, AnthropicModelFactor> {
  const factors = new Map<string, AnthropicModelFactor>();
  const entry = (model: string) => {
    let found = factors.get(model);
    if (!found) factors.set(model, (found = { model, billedUsd: 0, listUsd: 0, factor: null }));
    return found;
  };
  for (const row of rows) {
    if (row.day < range.fromDay || row.day > range.toDay || !row.model || !workspaceIds.has(row.workspaceId)) continue;
    if (row.source === "COST" && (anthropicTokenItems as readonly string[]).includes(row.item)) entry(row.model).billedUsd += row.value / 100;
    if (row.source === "USAGE") {
      const usd = claudeReportCostUsd(row.model, row.item, row.value, { longContext: row.contextWindow === "200k-1M", fast: row.speed === "fast" });
      if (usd !== null) entry(row.model).listUsd += usd;
    }
  }
  for (const factor of factors.values()) factor.factor = factor.listUsd >= minimumListUsd ? factor.billedUsd / factor.listUsd : null;
  return factors;
}

export function anthropicAdminStatus(record: GatewayAnthropicAdminRecord | null): GatewayAnthropicAdminStatus {
  return record
    ? { configured: true, keyHint: record.keyHint, savedAt: record.savedAt, lastSyncAt: record.lastSyncAt, lastError: record.lastError, upstream: record.upstream }
    : { configured: false, keyHint: null, savedAt: null, lastSyncAt: null, lastError: null, upstream: [] };
}

export const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
const nextDay = (day: string) => shiftDay(day, 1);
/**
 * Anthropic posts the current day late (it was missing at 13:43 ICT on 2026-10-18 while its usage existed), so a day's
 * caps use the price factor of the 7 days ending that day: a ratio of prices, steady from day to day.
 */
export const factorWindow = (day: string) => ({ fromDay: shiftDay(day, -6), toDay: day });

/**
 * Lets the daily COST_USD caps (no model filter) of active keys that used the Claude API-key accounts today count
 * Anthropic's charge: the key's estimate on other accounts plus, per model, its estimate on those accounts times the
 * model's factor. Recomputed from the request logs on every sync, so each sync heals drift; a model without a factor
 * keeps its estimate. Returns the number of keys set.
 */
export async function reconcileAnthropicKeyLimits(repository: GatewayRepository, input: {
  upstream: GatewayAnthropicUpstreamKey[]; rows: GatewayAnthropicUsageRow[]; now: number;
}): Promise<number> {
  const at = new Date(input.now).toISOString();
  const day = at.slice(0, 10);
  const factors = anthropicModelFactors(input.rows, factorWindow(day), new Set(input.upstream.map((key) => key.workspaceId)));
  const accountIds = [...new Set(input.upstream.map((key) => key.accountId))];
  if (!accountIds.length || ![...factors.values()].some((factor) => factor.factor !== null)) return 0;
  const window = { from: `${day}T00:00:00.000Z`, to: at };
  const used = new Set((await repository.aggregateRequestLogs({ ...window, accountIds }, "apiKey")).filter((row) => row.costUsd > 0).map((row) => row.key));
  let set = 0;
  for (const key of await repository.listApiKeys()) {
    if (!key.isActive || !used.has(key.id) || !key.limits.some((limit) => limit.limitType === "COST_USD" && limit.limitWindow === "DAILY" && limit.modelFilter === null)) continue;
    const total = (await repository.aggregateRequestLogs({ ...window, apiKeyIds: [key.id] }, "total"))[0]?.costUsd ?? 0;
    const models = await repository.aggregateRequestLogs({ ...window, apiKeyIds: [key.id], accountIds }, "model");
    const estimated = models.reduce((sum, row) => sum + row.costUsd, 0);
    const billed = models.reduce((sum, row) => sum + row.costUsd * (factors.get(anthropicModelName(row.key))?.factor ?? 1), 0);
    await repository.setApiKeyLimitValue(key.id, { limitType: "COST_USD", limitWindow: "DAILY" }, (total - estimated + billed) * 1e6, at);
    set += 1;
  }
  return set;
}

/** The last `days` UTC days of the bill next to the gateway's estimate for its Claude API-key accounts (Token usage page). */
export async function anthropicBillingReport(repository: GatewayRepository, days: number, now = Date.now()): Promise<GatewayAnthropicBillingReport> {
  const record = await repository.getAnthropicAdmin();
  const status = anthropicAdminStatus(record);
  const toDay = new Date(now).toISOString().slice(0, 10);
  const fromDay = new Date(Date.parse(`${toDay}T00:00:00.000Z`) - (Math.max(1, Math.min(days, 31)) - 1) * 86_400_000).toISOString().slice(0, 10);
  const rows = record ? await repository.listAnthropicUsage(shiftDay(fromDay, -6), toDay) : [];
  const workspaces = new Set(status.upstream.map((key) => key.workspaceId));
  const accountIds = [...new Set(status.upstream.map((key) => key.accountId))];
  const report: GatewayAnthropicBillingReport["days"] = [];
  for (let day = fromDay; day <= toDay; day = nextDay(day)) {
    const costRows = rows.filter((row) => row.day === day && row.source === "COST");
    const billed = anthropicModelFactors(rows, { fromDay: day, toDay: day }, workspaces);
    const factors = anthropicModelFactors(rows, factorWindow(day), workspaces);
    const logged = accountIds.length
      ? await repository.aggregateRequestLogs({ from: `${day}T00:00:00.000Z`, to: `${nextDay(day)}T00:00:00.000Z`, accountIds }, "model") : [];
    const estimates = new Map<string, number>();
    for (const row of logged) estimates.set(anthropicModelName(row.key), (estimates.get(anthropicModelName(row.key)) ?? 0) + row.costUsd);
    const models = [...new Set([...billed.keys(), ...estimates.keys()])].map((model) => {
      const day = billed.get(model);
      const factor = factors.get(model)?.factor ?? null;
      const estimate = estimates.get(model) ?? 0;
      return { model, billedUsd: Math.max(0, day?.billedUsd ?? 0), listUsd: day?.listUsd ?? 0, factor: factor === null ? null : Math.max(0, factor),
        gatewayEstimateUsd: estimate, gatewayBilledUsd: estimate * (factor ?? 1) };
    }).sort((left, right) => right.billedUsd + right.gatewayEstimateUsd - left.billedUsd - left.gatewayEstimateUsd).slice(0, 50);
    if (!costRows.length && !models.length) continue;
    const usd = (items: GatewayAnthropicUsageRow[]) => Math.max(0, items.reduce((sum, row) => sum + row.value, 0) / 100);
    report.push({ day, reported: costRows.length > 0, organizationUsd: usd(costRows), workspaceUsd: usd(costRows.filter((row) => workspaces.has(row.workspaceId))),
      gatewayEstimateUsd: models.reduce((sum, model) => sum + model.gatewayEstimateUsd, 0),
      gatewayBilledUsd: models.reduce((sum, model) => sum + model.gatewayBilledUsd, 0), models });
  }
  return { status, days: report.reverse() };
}
