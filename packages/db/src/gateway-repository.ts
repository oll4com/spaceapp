import { gatewayCompressionProvidersSchema } from "@space/contracts";
import type {
  GatewayAccount, GatewayAccountStatus, GatewayApiKey, GatewayApiKeyLimit, GatewayCompressionMode, GatewayLimitType,
  GatewayLimitWindow, GatewayOutputPolicy, GatewayProvider, GatewayReasoningEffort, GatewayRequestLog, GatewayRequestLogFacets,
  GatewayRequestLogFilter, GatewaySettings, GatewaySettingsUpdateRequest, GatewayTrafficClass, GatewayUsageAggregate
} from "@space/contracts";
import { createSpacePgPool, type PgPoolLike } from "./space-store.js";
import {
  aggregateLogs, aggregateRecord, aggregateSelectSql, gatewayLogStatusCategory, groupSql, logFilterConditions, matchesLogFilter, type GatewayLogGroup
} from "./gateway-log-aggregates.js";

/**
 * Space Gateway storage, shared by the gateway process (routing, logging) and the API (admin views).
 * Account credentials stay encrypted; only the gateway can decrypt them.
 */
export interface GatewayAccountRecord extends GatewayAccount {
  externalAccountId: string | null;
  credentialsEncrypted: string;
  credentialsExpiresAt: string | null;
  source: "OAUTH" | "IMPORT_AUTH_JSON" | "IMPORT_CODEX_LB" | "PROFILE_ADOPTION" | "API_KEY";
  sourceRef: string | null;
  blockedUntil: string | null;
}

export interface GatewayAccountInsert {
  accountId: string;
  provider: GatewayProvider;
  label: string;
  email: string | null;
  externalAccountId: string | null;
  planType: string | null;
  credentialsEncrypted: string;
  credentialsExpiresAt: string | null;
  source: GatewayAccountRecord["source"];
  sourceRef: string | null;
  lastRefreshAt: string | null;
}

export interface GatewayCredentialUpdate {
  credentialsEncrypted?: string;
  credentialsExpiresAt?: string | null;
  lastRefreshAt?: string | null;
  planType?: string | null;
  email?: string | null;
  status?: GatewayAccountStatus;
  statusReason?: string | null;
}

export interface GatewayUsageWindowInput {
  quotaKey?: string;
  window: "PRIMARY" | "SECONDARY";
  usedPercent: number | null;
  resetAt: string | null;
  windowMinutes: number | null;
}

export interface GatewayApiKeyRecord extends GatewayApiKey {
  keyHash: string;
}

export interface GatewayApiKeyInsert {
  keyId: string;
  name: string;
  keyHash: string;
  keyPrefix: string;
  trafficClass: GatewayTrafficClass;
  allowedModels: string[];
  enforcedModel: string | null;
  allowedReasoningEfforts: GatewayReasoningEffort[];
  enforcedReasoningEffort: GatewayReasoningEffort | null;
  accountIds: string[];
  compressionOverride: GatewayCompressionMode | null;
  /** Null (the default) follows the provider's output policy. */
  outputPolicyOverride?: GatewayOutputPolicy | null;
  limits: { limitType: GatewayLimitType; limitWindow: GatewayLimitWindow; maxValue: number; modelFilter: string | null; resetAt: string }[];
  expiresAt: string | null;
  createdBy: string | null;
}

/** Fields a log row may omit; older writers leave them null. */
type GatewayRequestLogOptional = "planType" | "requestedServiceTier" | "upstreamTransport" | "errorMessage" | "stickyKeySource" | "cacheCreationTokens"
  | "clientName" | "project" | "compressionTokensBefore" | "compressionTokensAfter" | "source" | "cacheBust" | "compressionDetail" | "upstreamRequestId";
export type GatewayRequestLogInsert = Omit<GatewayRequestLog, "id" | GatewayRequestLogOptional> & Partial<Pick<GatewayRequestLog, GatewayRequestLogOptional>>;

export interface GatewayClaudeLogKey {
  upstreamRequestId: string | null;
  requestedAt: string;
  model: string;
  /** Input including cache reads and writes: what a Claude Code transcript message adds up to exactly. */
  inputTokens: number | null;
  outputTokens: number | null;
}


export interface GatewayApiKeyPatch {
  name?: string;
  isActive?: boolean;
  trafficClass?: GatewayTrafficClass;
  allowedModels?: string[];
  enforcedModel?: string | null;
  allowedReasoningEfforts?: GatewayReasoningEffort[];
  enforcedReasoningEffort?: GatewayReasoningEffort | null;
  accountIds?: string[];
  compressionOverride?: GatewayCompressionMode | null;
  outputPolicyOverride?: GatewayOutputPolicy | null;
  expiresAt?: string | null;
  limits?: { limitType: GatewayLimitType; limitWindow: GatewayLimitWindow; maxValue: number; modelFilter: string | null; resetAt: string }[];
  resetUsage?: boolean;
}

export interface GatewayUsageTotals {
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface GatewayUsageHistoryPoint {
  window: "PRIMARY" | "SECONDARY";
  quotaKey: string;
  usedPercent: number;
  resetAt: string | null;
  recordedAt: string;
}

export interface GatewayWarmupRecord {
  id: number;
  accountId: string;
  window: "PRIMARY" | "SECONDARY";
  resetAt: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED" | "SKIPPED";
  model: string | null;
  attemptedAt: string;
  completedAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface GatewayRequestLogQuery {
  limit: number;
  beforeId?: number | null;
  /** Kept for older callers: the same as `filter.accountIds` / `filter.apiKeyIds` with one entry. */
  accountId?: string | null;
  apiKeyId?: string | null;
  filter?: GatewayRequestLogFilter;
}

export type GatewayStickyKind = "CODEX_SESSION" | "STICKY_THREAD" | "PROMPT_CACHE" | "CONTINUATION";

/** Which account a conversation key (SHA-256 hex, never the raw key) belongs to. */
export interface GatewayStickyBinding {
  keyHash: string;
  kind: GatewayStickyKind;
  provider: GatewayProvider;
  accountId: string;
  expiresAt: string | null;
}

export interface GatewayReportRowInput {
  key: string;
  requests: number;
  errors: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningReported: number;
  costUsd: number;
  compressionTokensSaved: number;
}

export interface GatewayCompressionRow {
  hour: string;
  mode: "SHADOW" | "ON";
  provider: string;
  strategy: string;
  requests: number;
  modifiedRequests: number;
  blocks: number;
  rejectedBlocks: number;
  errorBlocks: number;
  timedOut: number;
  originalTokens: number;
  compressedTokens: number;
  overheadMs: number;
  maxOverheadMs: number;
}

/** Hourly waste signal tokens (kind 'waste') and pipeline stage time (kind 'stage', value in ms). */
export interface GatewayCompressionSignalRow {
  hour: string;
  mode: "SHADOW" | "ON";
  provider: string;
  kind: "waste" | "stage";
  name: string;
  count: number;
  value: number;
  maxValue: number;
}

/** Daily totals by provider, model, client and project (Headroom lifetime and historical views). */
export interface GatewaySavingsDailyRow {
  day: string;
  provider: string;
  model: string;
  client: string;
  project: string;
  requests: number;
  failed: number;
  rateLimited: number;
  cachedRequests: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  compressionBefore: number;
  compressionAfter: number;
  compressionSaved: number;
  shadowSaved: number;
  cacheBusts: number;
  cacheBustTokens: number;
}

export interface GatewayUsageSummary {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  compressionTokensSaved: number;
}

/** Request aggregates for the Headroom-compatible statistics. */
export type GatewaySpeedTier = "standard" | "fast";
/** Per-model default speed for Codex requests that do not ask for one. */
export interface GatewaySpeedDefaults {
  models: Record<string, GatewaySpeedTier>;
  updatedAt: string | null;
}

export interface GatewayRequestStats {
  total: number;
  failed: number;
  rateLimited: number;
  /** Requests that read the provider prompt cache. */
  cached: number;
  cacheCreationTokens: number;
  byProvider: Record<string, number>;
  byModel: Record<string, number>;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  compressionTokensSaved: number;
  latency: { count: number; averageMs: number; minMs: number; maxMs: number };
  ttfb: { count: number; averageMs: number; minMs: number; maxMs: number };
}

export interface GatewayRepository {
  getSettings(): Promise<GatewaySettings>;
  updateSettings(patch: GatewaySettingsUpdateRequest): Promise<GatewaySettings>;
  listAccounts(): Promise<GatewayAccountRecord[]>;
  setAccountStatus(accountId: string, status: GatewayAccountStatus, reason: string | null): Promise<GatewayAccountRecord | null>;
  /** Sets or clears (null) the operator's name for an account, and its limit warm-up opt-in. */
  updateAccountPreferences(accountId: string, patch: { alias?: string | null; warmupEnabled?: boolean }): Promise<GatewayAccountRecord | null>;
  /** Adds an account, or replaces the credentials of the same upstream account (provider + external id). */
  upsertAccount(input: GatewayAccountInsert): Promise<GatewayAccountRecord>;
  deleteAccount(accountId: string): Promise<boolean>;
  /**
   * Gives an existing account another upstream sign-in (import with overwrite: same email, different upstream
   * account). The id, alias, settings and history stay; a paused account stays paused.
   */
  replaceAccountSignIn(accountId: string, input: Omit<GatewayAccountInsert, "accountId" | "provider" | "label">): Promise<GatewayAccountRecord | null>;
  /**
   * Runs `update` with the freshest row while holding a per-account lock, so only one holder refreshes a rotating
   * token at a time. Returning null leaves the row unchanged.
   */
  withAccountCredentialLock(accountId: string, update: (current: GatewayAccountRecord) => Promise<GatewayCredentialUpdate | null>): Promise<GatewayAccountRecord | null>;
  saveUsageWindows(accountId: string, windows: GatewayUsageWindowInput[]): Promise<void>;
  recordAccountState(accountId: string, state: { status: GatewayAccountStatus; statusReason: string | null; blockedUntil: string | null }): Promise<void>;
  touchAccounts(accountIds: string[], usedAt: string): Promise<void>;
  saveResetCredits(accountId: string, available: number | null): Promise<void>;
  listApiKeys(): Promise<GatewayApiKeyRecord[]>;
  findApiKeyByHash(keyHash: string): Promise<GatewayApiKeyRecord | null>;
  createApiKey(input: GatewayApiKeyInsert): Promise<GatewayApiKeyRecord>;
  /**
   * Changes a key. `accountIds` and `limits` replace the current sets; a limit with the same type, window and model
   * filter keeps its usage unless `resetUsage` is set.
   */
  updateApiKey(keyId: string, patch: GatewayApiKeyPatch): Promise<GatewayApiKeyRecord | null>;
  /** Gives a key a new secret; its id, settings, limits and usage stay. */
  regenerateApiKey(keyId: string, secret: { keyHash: string; keyPrefix: string }): Promise<GatewayApiKeyRecord | null>;
  deleteApiKey(keyId: string): Promise<boolean>;
  /**
   * Adds one request's usage to the key's limits (windows that already reset start again from this request) and
   * stamps last use. COST_USD limits count micro-dollars.
   */
  settleApiKeyUsage(keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }): Promise<void>;
  insertRequestLogs(rows: GatewayRequestLogInsert[]): Promise<void>;
  /** Newest first; `filter` narrows by time, search text, accounts, keys, models, providers, statuses and clients. */
  listRequestLogs(query: GatewayRequestLogQuery): Promise<GatewayRequestLog[]>;
  getRequestLog(id: string): Promise<GatewayRequestLog | null>;
  /** The values present in a time range, for the request log filters. */
  requestLogFacets(filter: Pick<GatewayRequestLogFilter, "from" | "to">): Promise<GatewayRequestLogFacets>;
  /**
   * Request-log totals per group over a filter, largest first (by `orderBy`, default requests). Latency and TTFT
   * percentiles count successful requests only.
   */
  aggregateRequestLogs(filter: GatewayRequestLogFilter, group: GatewayLogGroup, options?: { limit?: number; orderBy?: "requests" | "costUsd" | "key" }): Promise<GatewayUsageAggregate[]>;
  usageSince(since: string): Promise<GatewayUsageSummary>;
  /** Lifetime totals from the daily rollups (they outlive request-log retention), for one account or one key. */
  usageTotals(scope: { accountId?: string; apiKeyId?: string }): Promise<GatewayUsageTotals>;
  /** Request logs after a log id, oldest first, warm-ups left out: the token usage page imports them. */
  requestLogsAfter(afterId: string | null, limit: number): Promise<GatewayRequestLog[]>;
  /** Claude requests started between two times, to tell which Claude Code transcript messages went through the gateway. */
  claudeLogKeys(from: string, to: string): Promise<GatewayClaudeLogKey[]>;
  /** Recorded usage-window samples of one account since a time, oldest first. */
  usageHistory(accountId: string, since: string): Promise<GatewayUsageHistoryPoint[]>;
  /** The latest limit warm-up attempt of each account. */
  latestWarmups(): Promise<GatewayWarmupRecord[]>;
  /** Records a warm-up attempt; false when this account, window and reset already had one. */
  claimWarmup(attempt: { accountId: string; window: "PRIMARY" | "SECONDARY"; resetAt: string; model: string | null; attemptedAt?: string }): Promise<number | null>;
  finishWarmup(id: number, result: { status: "SUCCEEDED" | "FAILED" | "SKIPPED"; errorCode?: string | null; errorMessage?: string | null; model?: string | null }): Promise<void>;
  /** Round trip to the database, in milliseconds. */
  ping(): Promise<number>;
  /** Counts, token totals and latency/TTFB over request logs since the given time. */
  requestStatsSince(since: string): Promise<GatewayRequestStats>;
  /** Daily rollups between two UTC dates (inclusive), grouped by day, model and account. */
  usageReport(from: string, to: string): Promise<{ days: GatewayReportRowInput[]; models: GatewayReportRowInput[]; accounts: GatewayReportRowInput[] }>;
  /** Adds compression results to the hourly rollups. */
  recordCompression(rows: GatewayCompressionRow[]): Promise<void>;
  /** Hourly compression rollups since the given time, oldest first. */
  compressionSince(since: string): Promise<GatewayCompressionRow[]>;
  /** Adds waste signal tokens and stage timings to the hourly rollups. */
  recordCompressionSignals(rows: GatewayCompressionSignalRow[]): Promise<void>;
  compressionSignalsSince(since: string): Promise<GatewayCompressionSignalRow[]>;
  /** Daily savings rows between two UTC dates (inclusive); all days when omitted. */
  savingsDaily(range?: { from?: string; to?: string }): Promise<GatewaySavingsDailyRow[]>;
  /** Deletes request logs older than the cutoff in bounded batches; returns rows removed. */
  pruneRequestLogs(before: string, batchSize?: number): Promise<number>;
  speedDefaults(): Promise<GatewaySpeedDefaults>;
  /** Sets one model's default; "standard" removes the entry. */
  setSpeedDefault(modelId: string, tier: GatewaySpeedTier): Promise<GatewaySpeedDefaults>;
  /** Stores conversation-to-account bindings, so affinity survives a gateway restart; bindings to removed accounts are skipped. */
  saveStickyBindings(rows: GatewayStickyBinding[]): Promise<void>;
  /** The unexpired binding for a key, or null. */
  findStickyBinding(keyHash: string, nowIso: string): Promise<GatewayStickyBinding | null>;
  /** Deletes expired bindings; returns rows removed. */
  pruneStickyBindings(nowIso: string): Promise<number>;
  dispose(): Promise<void>;
}

export const defaultGatewaySettings: Omit<GatewaySettings, "updatedAt"> = {
  routingStrategy: "CAPACITY_WEIGHTED",
  stickyThreadsEnabled: true,
  preferEarlierReset: false,
  planPriority: ["plus", "prolite", "pro"],
  stickyReallocationBudgetThresholdPercent: 95,
  exhaustionFloorPercent: 3,
  compressionMode: "OFF",
  compressionProfile: "TOKEN",
  compressionCodeText: "ON",
  compressionTimeBudgetMs: 250,
  compressionProviders: {},
  requestLogRetentionDays: 30,
  displayTimeFormat: "24H",
  displayAccountWindows: "BOTH",
  displayBurnProjection: true,
  upstreamStreamTransport: "DEFAULT",
  promptCacheTtlSeconds: 1800,
  importWithoutOverwrite: true,
  claudeApiKeyFallback: false,
  warmupEnabled: false,
  warmupWindows: "BOTH",
  warmupModel: "auto",
  warmupPrompt: "Say OK.",
  warmupCooldownSeconds: 3600,
  warmupMinAvailablePercent: 100,
  lanMode: "ENV",
  lanHost: null,
  lanPort: null,
  lanAllowedSources: []
};

const settingsColumns: Record<keyof Omit<GatewaySettings, "updatedAt">, string> = {
  routingStrategy: "routing_strategy",
  stickyThreadsEnabled: "sticky_threads_enabled",
  preferEarlierReset: "prefer_earlier_reset",
  planPriority: "plan_priority",
  stickyReallocationBudgetThresholdPercent: "sticky_reallocation_budget_threshold_percent",
  exhaustionFloorPercent: "exhaustion_floor_percent",
  compressionMode: "compression_mode",
  compressionProfile: "compression_profile",
  compressionCodeText: "compression_code_text",
  compressionTimeBudgetMs: "compression_time_budget_ms",
  compressionProviders: "compression_providers",
  requestLogRetentionDays: "request_log_retention_days",
  displayTimeFormat: "display_time_format",
  displayAccountWindows: "display_account_windows",
  displayBurnProjection: "display_burn_projection",
  upstreamStreamTransport: "upstream_stream_transport",
  promptCacheTtlSeconds: "prompt_cache_ttl_seconds",
  importWithoutOverwrite: "import_without_overwrite",
  claudeApiKeyFallback: "claude_api_key_fallback",
  warmupEnabled: "warmup_enabled",
  warmupWindows: "warmup_windows",
  warmupModel: "warmup_model",
  warmupPrompt: "warmup_prompt",
  warmupCooldownSeconds: "warmup_cooldown_seconds",
  warmupMinAvailablePercent: "warmup_min_available_percent",
  lanMode: "lan_mode",
  lanHost: "lan_host",
  lanPort: "lan_port",
  lanAllowedSources: "lan_allowed_sources"
};

const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string).toISOString();
const num = (value: unknown): number | null => value === null || value === undefined ? null : Number(value);

/** The per-provider object as stored; a database without migration 0184, or an unreadable value, inherits everything. */
function compressionProvidersRecord(value: unknown): GatewaySettings["compressionProviders"] {
  let raw: unknown = value ?? {};
  if (typeof raw === "string") { try { raw = JSON.parse(raw) as unknown; } catch { return {}; } }
  const parsed = gatewayCompressionProvidersSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

const copyProviders = (providers: GatewaySettings["compressionProviders"]) =>
  Object.fromEntries(Object.entries(providers).map(([provider, entry]) => [provider, { ...entry }])) as GatewaySettings["compressionProviders"];

function settingsRecord(row: Record<string, unknown>): GatewaySettings {
  return {
    routingStrategy: row.routing_strategy as GatewaySettings["routingStrategy"],
    stickyThreadsEnabled: Boolean(row.sticky_threads_enabled),
    preferEarlierReset: Boolean(row.prefer_earlier_reset),
    planPriority: (row.plan_priority as string[] | null) ?? [],
    stickyReallocationBudgetThresholdPercent: Number(row.sticky_reallocation_budget_threshold_percent),
    exhaustionFloorPercent: Number(row.exhaustion_floor_percent),
    // Shadow was removed (migration 0172); a row read before that migration keeps what Shadow did.
    compressionMode: row.compression_mode === "ON" ? "ON" : "OFF",
    compressionProfile: row.compression_profile as GatewaySettings["compressionProfile"],
    compressionCodeText: row.compression_code_text === "OFF" ? "OFF" : "ON",
    compressionTimeBudgetMs: Number(row.compression_time_budget_ms),
    compressionProviders: compressionProvidersRecord(row.compression_providers),
    requestLogRetentionDays: Number(row.request_log_retention_days),
    // A database without migration 0160 yet (an older stable during a rollout) reads as the defaults.
    displayTimeFormat: (row.display_time_format as GatewaySettings["displayTimeFormat"] | undefined) ?? defaultGatewaySettings.displayTimeFormat,
    displayAccountWindows: (row.display_account_windows as GatewaySettings["displayAccountWindows"] | undefined) ?? defaultGatewaySettings.displayAccountWindows,
    displayBurnProjection: row.display_burn_projection === undefined ? defaultGatewaySettings.displayBurnProjection : Boolean(row.display_burn_projection),
    upstreamStreamTransport: (row.upstream_stream_transport as GatewaySettings["upstreamStreamTransport"] | undefined) ?? defaultGatewaySettings.upstreamStreamTransport,
    promptCacheTtlSeconds: row.prompt_cache_ttl_seconds === undefined ? defaultGatewaySettings.promptCacheTtlSeconds : Number(row.prompt_cache_ttl_seconds),
    importWithoutOverwrite: row.import_without_overwrite === undefined ? defaultGatewaySettings.importWithoutOverwrite : Boolean(row.import_without_overwrite),
    claudeApiKeyFallback: row.claude_api_key_fallback === undefined ? defaultGatewaySettings.claudeApiKeyFallback : Boolean(row.claude_api_key_fallback),
    warmupEnabled: row.warmup_enabled === undefined ? defaultGatewaySettings.warmupEnabled : Boolean(row.warmup_enabled),
    warmupWindows: (row.warmup_windows as GatewaySettings["warmupWindows"] | undefined) ?? defaultGatewaySettings.warmupWindows,
    warmupModel: (row.warmup_model as string | undefined) ?? defaultGatewaySettings.warmupModel,
    warmupPrompt: (row.warmup_prompt as string | undefined) ?? defaultGatewaySettings.warmupPrompt,
    warmupCooldownSeconds: row.warmup_cooldown_seconds === undefined ? defaultGatewaySettings.warmupCooldownSeconds : Number(row.warmup_cooldown_seconds),
    warmupMinAvailablePercent: row.warmup_min_available_percent === undefined ? defaultGatewaySettings.warmupMinAvailablePercent : Number(row.warmup_min_available_percent),
    lanMode: (row.lan_mode as GatewaySettings["lanMode"] | undefined) ?? defaultGatewaySettings.lanMode,
    lanHost: (row.lan_host as string | null | undefined) ?? null,
    lanPort: num(row.lan_port),
    lanAllowedSources: (row.lan_allowed_sources as string[] | null | undefined) ?? [],
    updatedAt: iso(row.updated_at)!
  };
}

const emptyWindow = { usedPercent: null, resetAt: null, windowMinutes: null };

function speedDefaultsRecord(row: Record<string, unknown>): GatewaySpeedDefaults {
  const raw = row.speed_defaults && typeof row.speed_defaults === "object" ? row.speed_defaults as Record<string, unknown> : {};
  const models: Record<string, GatewaySpeedTier> = {};
  for (const [model, tier] of Object.entries(raw)) if (tier === "fast") models[model] = "fast";
  return { models, updatedAt: iso(row.speed_defaults_updated_at) };
}

function accountRecord(row: Record<string, unknown>, windows: Record<string, unknown>[]): GatewayAccountRecord {
  const window = (name: string, quotaKey = "") => {
    const found = windows.find((item) => item.account_id === row.account_id && item.usage_window === name && item.quota_key === quotaKey);
    return found
      ? { usedPercent: num(found.used_percent), resetAt: iso(found.reset_at), windowMinutes: num(found.window_minutes) }
      : { ...emptyWindow };
  };
  const quotaKeys = [...new Set(windows.filter((item) => item.account_id === row.account_id && item.quota_key !== "").map((item) => String(item.quota_key)))].sort();
  return {
    id: row.account_id as string,
    provider: row.provider as GatewayProvider,
    label: row.label as string,
    alias: (row.alias as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    planType: (row.plan_type as string | null) ?? null,
    status: row.status as GatewayAccountStatus,
    statusReason: (row.status_reason as string | null) ?? null,
    priority: Number(row.priority),
    warmupEnabled: Boolean(row.warmup_enabled),
    resetCreditsAvailable: num(row.reset_credits_available),
    primaryWindow: window("PRIMARY"),
    secondaryWindow: window("SECONDARY"),
    ...(quotaKeys.length > 0 ? { quotaGroups: quotaKeys.map((key) => ({ key, primaryWindow: window("PRIMARY", key), secondaryWindow: window("SECONDARY", key) })) } : {}),
    lastRefreshAt: iso(row.last_refresh_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: iso(row.created_at)!,
    externalAccountId: (row.external_account_id as string | null) ?? null,
    credentialsEncrypted: row.credentials_encrypted as string,
    credentialsExpiresAt: iso(row.credentials_expires_at),
    source: row.source as GatewayAccountRecord["source"],
    sourceRef: (row.source_ref as string | null) ?? null,
    blockedUntil: iso(row.blocked_until)
  };
}

const outputPolicies = new Set<GatewayOutputPolicy>(["OFF", "CONCISE", "LEAN", "BOTH"]);

function apiKeyRecord(row: Record<string, unknown>, accounts: Record<string, unknown>[], limits: Record<string, unknown>[]): GatewayApiKeyRecord {
  const keyId = row.key_id as string;
  return {
    id: keyId,
    name: row.name as string,
    keyPrefix: row.key_prefix as string,
    keyHash: row.key_hash as string,
    isActive: Boolean(row.is_active),
    trafficClass: row.traffic_class as GatewayTrafficClass,
    allowedModels: (row.allowed_models as string[] | null) ?? [],
    enforcedModel: (row.enforced_model as string | null) ?? null,
    allowedReasoningEfforts: ((row.allowed_reasoning_efforts as string[] | null) ?? []) as GatewayReasoningEffort[],
    enforcedReasoningEffort: (row.enforced_reasoning_effort as GatewayReasoningEffort | null) ?? null,
    accountScopeEnabled: Boolean(row.account_scope_enabled),
    accountIds: accounts.filter((item) => item.key_id === keyId).map((item) => item.account_id as string),
    compressionOverride: row.compression_override === "ON" ? "ON" : row.compression_override ? "OFF" : null,
    // A database without migration 0185 has no override column: the key follows the provider.
    outputPolicyOverride: outputPolicies.has(row.output_policy_override as GatewayOutputPolicy) ? row.output_policy_override as GatewayOutputPolicy : null,
    limits: limits.filter((item) => item.key_id === keyId).map((item): GatewayApiKeyLimit => ({
      limitType: item.limit_type as GatewayLimitType,
      limitWindow: item.limit_window as GatewayLimitWindow,
      maxValue: Number(item.max_value),
      currentValue: Number(item.current_value),
      modelFilter: (item.model_filter as string | null) ?? null,
      resetAt: iso(item.reset_at)!
    })),
    expiresAt: iso(row.expires_at),
    lastUsedAt: iso(row.last_used_at),
    createdAt: iso(row.created_at)!
  };
}

function requestLogRecord(row: Record<string, unknown>): GatewayRequestLog {
  return {
    id: String(row.id),
    requestId: row.request_id as string,
    requestedAt: iso(row.requested_at)!,
    provider: row.provider as GatewayProvider,
    accountId: (row.account_id as string | null) ?? null,
    apiKeyId: (row.api_key_id as string | null) ?? null,
    model: row.model as string,
    reasoningEffort: (row.reasoning_effort as string | null) ?? null,
    serviceTier: (row.service_tier as string | null) ?? null,
    transport: (row.transport as string | null) ?? null,
    status: row.status as string,
    errorCode: (row.error_code as string | null) ?? null,
    latencyMs: num(row.latency_ms),
    firstTokenMs: num(row.first_token_ms),
    inputTokens: num(row.input_tokens),
    cachedInputTokens: num(row.cached_input_tokens),
    outputTokens: num(row.output_tokens),
    reasoningTokens: num(row.reasoning_tokens),
    costUsd: num(row.cost_usd),
    compressionTokensSaved: num(row.compression_tokens_saved),
    stickyKind: (row.sticky_kind as string | null) ?? null,
    stickyKeyHash: (row.sticky_key_hash as string | null) ?? null,
    planType: (row.plan_type as string | null) ?? null,
    requestedServiceTier: (row.requested_service_tier as string | null) ?? null,
    upstreamTransport: (row.upstream_transport as string | null) ?? null,
    errorMessage: (row.error_message as string | null) ?? null,
    stickyKeySource: (row.sticky_key_source as string | null) ?? null,
    cacheCreationTokens: num(row.cache_creation_tokens),
    clientName: (row.client_name as string | null) ?? null,
    project: (row.project as string | null) ?? null,
    compressionTokensBefore: num(row.compression_tokens_before),
    compressionTokensAfter: num(row.compression_tokens_after),
    source: (row.source as string | null) ?? null,
    cacheBust: row.cache_bust === null || row.cache_bust === undefined ? null : Boolean(row.cache_bust),
    compressionDetail: (row.compression_detail as GatewayRequestLog["compressionDetail"] | undefined) ?? null
  };
}

function reportRow(row: Record<string, unknown>): GatewayReportRowInput {
  return {
    key: String(row.key ?? ""), requests: Number(row.requests ?? 0), errors: Number(row.errors ?? 0), inputTokens: Number(row.input_tokens ?? 0),
    cachedInputTokens: Number(row.cached_input_tokens ?? 0), outputTokens: Number(row.output_tokens ?? 0), reasoningTokens: Number(row.reasoning_tokens ?? 0),
    reasoningReported: Number(row.reasoning_reported ?? 0), costUsd: Number(row.cost_usd ?? 0), compressionTokensSaved: Number(row.compression_tokens_saved ?? 0)
  };
}

/** One request's contribution to the daily savings rollup (warm-up requests are left out by the caller). */
export function savingsDailyKey(row: GatewayRequestLogInsert): { key: string; day: string; provider: string; model: string; client: string; project: string } {
  const day = row.requestedAt.slice(0, 10);
  const client = (row.clientName ?? "").slice(0, 80);
  const project = (row.project ?? "").slice(0, 200);
  return { key: JSON.stringify([day, row.provider, row.model, client, project]), day, provider: row.provider, model: row.model, client, project };
}

export function savingsDailyDelta(group: GatewayRequestLogInsert[]) {
  const sum = (pick: (row: GatewayRequestLogInsert) => number | null | undefined) => group.reduce((total, row) => total + (pick(row) ?? 0), 0);
  const rateLimited = new Set(["rate_limit_exceeded", "usage_limit_reached", "rate_limit_error", "http_429"]);
  return {
    requests: group.length, failed: group.filter((row) => row.status !== "success").length,
    rateLimited: group.filter((row) => rateLimited.has(row.errorCode ?? "")).length,
    cachedRequests: group.filter((row) => (row.cachedInputTokens ?? 0) > 0).length,
    inputTokens: sum((row) => row.inputTokens), cachedInputTokens: sum((row) => row.cachedInputTokens), cacheCreationTokens: sum((row) => row.cacheCreationTokens),
    outputTokens: sum((row) => row.outputTokens), costUsd: sum((row) => row.costUsd),
    compressionBefore: sum((row) => row.compressionTokensBefore), compressionAfter: sum((row) => row.compressionTokensAfter),
    compressionSaved: sum((row) => row.compressionTokensSaved),
    shadowSaved: sum((row) => (row.compressionTokensSaved === null && row.compressionTokensBefore !== null && row.compressionTokensBefore !== undefined
      ? Math.max(0, row.compressionTokensBefore - (row.compressionTokensAfter ?? row.compressionTokensBefore)) : 0)),
    cacheBusts: group.filter((row) => row.cacheBust === true).length,
    cacheBustTokens: sum((row) => (row.cacheBust ? row.cacheCreationTokens : 0))
  };
}

/** New limits keep the usage of the limit they replace (same type, window and model filter) unless usage is reset. */
export function mergeKeyLimits(current: GatewayApiKeyLimit[], next: NonNullable<GatewayApiKeyPatch["limits"]>, resetUsage: boolean): GatewayApiKeyLimit[] {
  return next.map((limit) => {
    const previous = resetUsage ? undefined : current.find((item) => item.limitType === limit.limitType && item.limitWindow === limit.limitWindow
      && item.modelFilter === limit.modelFilter);
    return { limitType: limit.limitType, limitWindow: limit.limitWindow, maxValue: limit.maxValue, modelFilter: limit.modelFilter,
      currentValue: previous?.currentValue ?? 0, resetAt: previous?.resetAt ?? limit.resetAt };
  });
}

function warmupRecord(row: Record<string, unknown>): GatewayWarmupRecord {
  return {
    id: Number(row.id), accountId: String(row.account_id), window: row.usage_window as GatewayWarmupRecord["window"], resetAt: iso(row.reset_at)!,
    status: row.status as GatewayWarmupRecord["status"], model: (row.model as string | null) ?? null, attemptedAt: iso(row.attempted_at)!,
    completedAt: iso(row.completed_at), errorCode: (row.error_code as string | null) ?? null, errorMessage: (row.error_message as string | null) ?? null
  };
}

/** Folds the single-id query fields into the filter. */
function withLegacyIds(query: GatewayRequestLogQuery): GatewayRequestLogFilter {
  const filter: GatewayRequestLogFilter = { ...(query.filter ?? {}) };
  if (query.accountId) filter.accountIds = [query.accountId];
  if (query.apiKeyId) filter.apiKeyIds = [query.apiKeyId];
  return filter;
}

export class PostgresGatewayRepository implements GatewayRepository {
  constructor(private pool: PgPoolLike) {}
  static fromConnectionString(url: string, max = 4) { return new PostgresGatewayRepository(createSpacePgPool(url, { max })); }

  async getSettings() {
    const row = (await this.pool.query<Record<string, unknown>>(
      `INSERT INTO space_gateway_settings(settings_id) VALUES (1) ON CONFLICT (settings_id) DO UPDATE SET settings_id=1 RETURNING *`)).rows[0]!;
    return settingsRecord(row);
  }

  async updateSettings(patch: GatewaySettingsUpdateRequest) {
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined) as [keyof typeof settingsColumns, unknown][];
    if (entries.length === 0) return this.getSettings();
    const assignments = entries.map(([key], index) => `${settingsColumns[key]}=$${index + 1}`);
    const row = (await this.pool.query<Record<string, unknown>>(
      `UPDATE space_gateway_settings SET ${assignments.join(", ")}, updated_at=now() WHERE settings_id=1 RETURNING *`,
      entries.map(([key, value]) => (key === "compressionProviders" ? JSON.stringify(value) : value)))).rows[0];
    return row ? settingsRecord(row) : this.getSettings();
  }

  async listAccounts() {
    const rows = (await this.pool.query<Record<string, unknown>>(
      `SELECT * FROM space_gateway_accounts ORDER BY provider, priority, label`)).rows;
    const windows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_usage_windows`)).rows;
    return rows.map((row) => accountRecord(row, windows));
  }

  async setAccountStatus(accountId: string, status: GatewayAccountStatus, reason: string | null) {
    const row = (await this.pool.query<Record<string, unknown>>(
      `UPDATE space_gateway_accounts SET status=$2, status_reason=$3, updated_at=now() WHERE account_id=$1 RETURNING *`,
      [accountId, status, reason])).rows[0];
    if (!row) return null;
    const windows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_usage_windows WHERE account_id=$1`, [accountId])).rows;
    return accountRecord(row, windows);
  }

  async updateAccountPreferences(accountId: string, patch: { alias?: string | null; warmupEnabled?: boolean }) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE space_gateway_accounts SET
        alias = CASE WHEN $2::boolean THEN $3 ELSE alias END, warmup_enabled = COALESCE($4, warmup_enabled), updated_at = now()
      WHERE account_id = $1 RETURNING account_id`, [accountId, patch.alias !== undefined, patch.alias ?? null, patch.warmupEnabled ?? null])).rows[0];
    return row ? this.accountById(accountId) : null;
  }

  private async accountById(accountId: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_accounts WHERE account_id=$1`, [accountId])).rows[0];
    if (!row) return null;
    const windows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_usage_windows WHERE account_id=$1`, [accountId])).rows;
    return accountRecord(row, windows);
  }

  async upsertAccount(input: GatewayAccountInsert) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO space_gateway_accounts(account_id,provider,label,email,
        external_account_id,plan_type,credentials_encrypted,credentials_expires_at,source,source_ref,last_refresh_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (provider, external_account_id) WHERE external_account_id IS NOT NULL DO UPDATE SET
        email=EXCLUDED.email, plan_type=COALESCE(EXCLUDED.plan_type, space_gateway_accounts.plan_type),
        credentials_encrypted=EXCLUDED.credentials_encrypted, credentials_expires_at=EXCLUDED.credentials_expires_at,
        last_refresh_at=EXCLUDED.last_refresh_at, status=CASE WHEN space_gateway_accounts.status='PAUSED' THEN 'PAUSED' ELSE 'ACTIVE' END,
        status_reason=CASE WHEN space_gateway_accounts.status='PAUSED' THEN space_gateway_accounts.status_reason ELSE NULL END, updated_at=now()
      RETURNING account_id`,
      [input.accountId, input.provider, input.label, input.email, input.externalAccountId, input.planType, input.credentialsEncrypted,
        input.credentialsExpiresAt, input.source, input.sourceRef, input.lastRefreshAt])).rows[0]!;
    return (await this.accountById(row.account_id as string))!;
  }

  async deleteAccount(accountId: string) {
    return (await this.pool.query(`DELETE FROM space_gateway_accounts WHERE account_id=$1 RETURNING account_id`, [accountId])).rows.length === 1;
  }

  async replaceAccountSignIn(accountId: string, input: Omit<GatewayAccountInsert, "accountId" | "provider" | "label">) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE space_gateway_accounts SET email=$2, external_account_id=$3,
        plan_type=COALESCE($4, plan_type), credentials_encrypted=$5, credentials_expires_at=$6, source=$7, source_ref=$8, last_refresh_at=$9,
        status=CASE WHEN status='PAUSED' THEN 'PAUSED' ELSE 'ACTIVE' END, status_reason=CASE WHEN status='PAUSED' THEN status_reason ELSE NULL END,
        blocked_until=NULL, updated_at=now()
      WHERE account_id=$1 RETURNING account_id`,
    [accountId, input.email, input.externalAccountId, input.planType, input.credentialsEncrypted, input.credentialsExpiresAt, input.source, input.sourceRef,
      input.lastRefreshAt])).rows[0];
    return row ? this.accountById(accountId) : null;
  }

  async withAccountCredentialLock(accountId: string, update: (current: GatewayAccountRecord) => Promise<GatewayCredentialUpdate | null>) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 4920))", [accountId]);
      const row = (await client.query<Record<string, unknown>>(`SELECT * FROM space_gateway_accounts WHERE account_id=$1 FOR UPDATE`, [accountId])).rows[0];
      if (!row) { await client.query("ROLLBACK"); return null; }
      const windows = (await client.query<Record<string, unknown>>(`SELECT * FROM space_gateway_usage_windows WHERE account_id=$1`, [accountId])).rows;
      const change = await update(accountRecord(row, windows));
      if (change) {
        await client.query(`UPDATE space_gateway_accounts SET
            credentials_encrypted=COALESCE($2, credentials_encrypted),
            credentials_expires_at=CASE WHEN $3::boolean THEN $4::timestamptz ELSE credentials_expires_at END,
            last_refresh_at=CASE WHEN $5::boolean THEN $6::timestamptz ELSE last_refresh_at END,
            plan_type=CASE WHEN $7::boolean THEN $8 ELSE plan_type END,
            email=CASE WHEN $9::boolean THEN $10 ELSE email END,
            status=COALESCE($11, status),
            status_reason=CASE WHEN $12::boolean THEN $13 ELSE status_reason END,
            updated_at=now()
          WHERE account_id=$1`,
          [accountId, change.credentialsEncrypted ?? null, change.credentialsExpiresAt !== undefined, change.credentialsExpiresAt ?? null,
            change.lastRefreshAt !== undefined, change.lastRefreshAt ?? null, change.planType !== undefined, change.planType ?? null,
            change.email !== undefined, change.email ?? null, change.status ?? null, change.statusReason !== undefined, change.statusReason ?? null]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      (client as { release?: () => void }).release?.();
    }
    return this.accountById(accountId);
  }

  async saveUsageWindows(accountId: string, windows: GatewayUsageWindowInput[]) {
    for (const window of windows) {
      const quotaKey = window.quotaKey ?? "";
      await this.pool.query(`INSERT INTO space_gateway_usage_windows(account_id,quota_key,usage_window,used_percent,reset_at,window_minutes,recorded_at)
        VALUES ($1,$2,$3,$4,$5,$6,now()) ON CONFLICT (account_id,quota_key,usage_window) DO UPDATE SET used_percent=EXCLUDED.used_percent,
        reset_at=EXCLUDED.reset_at, window_minutes=COALESCE(EXCLUDED.window_minutes, space_gateway_usage_windows.window_minutes), recorded_at=now()`,
        [accountId, quotaKey, window.window, window.usedPercent === null ? null : Math.max(0, Math.min(100, window.usedPercent)), window.resetAt, window.windowMinutes]);
      if (window.usedPercent !== null) {
        await this.pool.query(`INSERT INTO space_gateway_usage_history(account_id,quota_key,usage_window,used_percent,reset_at) VALUES ($1,$2,$3,$4,$5)`,
          [accountId, quotaKey, window.window, Math.max(0, Math.min(100, window.usedPercent)), window.resetAt]);
      }
    }
  }

  async recordAccountState(accountId: string, state: { status: GatewayAccountStatus; statusReason: string | null; blockedUntil: string | null }) {
    // A paused account stays paused: only the operator resumes it.
    await this.pool.query(`UPDATE space_gateway_accounts SET status=$2, status_reason=$3, blocked_until=$4, updated_at=now()
      WHERE account_id=$1 AND status <> 'PAUSED'`, [accountId, state.status, state.statusReason?.slice(0, 500) ?? null, state.blockedUntil]);
  }

  async saveResetCredits(accountId: string, available: number | null) {
    await this.pool.query(`UPDATE space_gateway_accounts SET reset_credits_available=$2 WHERE account_id=$1`, [accountId, available]);
  }

  async touchAccounts(accountIds: string[], usedAt: string) {
    if (accountIds.length === 0) return;
    await this.pool.query(`UPDATE space_gateway_accounts SET last_used_at=GREATEST(COALESCE(last_used_at, $2::timestamptz), $2::timestamptz)
      WHERE account_id = ANY($1)`, [accountIds, usedAt]);
  }

  private async keysWhere(where: string, values: unknown[]) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_api_keys ${where} ORDER BY created_at DESC`, values)).rows;
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.key_id as string);
    const accounts = (await this.pool.query<Record<string, unknown>>(`SELECT key_id, account_id FROM space_gateway_api_key_accounts WHERE key_id = ANY($1)`, [ids])).rows;
    const limits = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_api_key_limits WHERE key_id = ANY($1) ORDER BY limit_id`, [ids])).rows;
    return rows.map((row) => apiKeyRecord(row, accounts, limits));
  }

  listApiKeys() { return this.keysWhere("", []); }

  async findApiKeyByHash(keyHash: string) {
    return (await this.keysWhere("WHERE key_hash=$1", [keyHash]))[0] ?? null;
  }

  async createApiKey(input: GatewayApiKeyInsert) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The output policy column (migration 0185) is written only when set, so a key can be created before the migration ran.
      const policy = input.outputPolicyOverride ?? null;
      await client.query(`INSERT INTO space_gateway_api_keys(key_id,name,key_hash,key_prefix,traffic_class,allowed_models,enforced_model,
          allowed_reasoning_efforts,enforced_reasoning_effort,account_scope_enabled,compression_override,expires_at,created_by${policy ? ",output_policy_override" : ""})
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13${policy ? ",$14" : ""})`,
        [input.keyId, input.name, input.keyHash, input.keyPrefix, input.trafficClass, input.allowedModels, input.enforcedModel,
          input.allowedReasoningEfforts, input.enforcedReasoningEffort, input.accountIds.length > 0, input.compressionOverride,
          input.expiresAt, input.createdBy, ...(policy ? [policy] : [])]);
      for (const accountId of input.accountIds) {
        await client.query(`INSERT INTO space_gateway_api_key_accounts(key_id,account_id) VALUES ($1,$2)`, [input.keyId, accountId]);
      }
      for (const limit of input.limits) {
        await client.query(`INSERT INTO space_gateway_api_key_limits(key_id,limit_type,limit_window,max_value,model_filter,reset_at)
          VALUES ($1,$2,$3,$4,$5,$6)`, [input.keyId, limit.limitType, limit.limitWindow, limit.maxValue, limit.modelFilter, limit.resetAt]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      (client as { release?: () => void }).release?.();
    }
    return (await this.keysWhere("WHERE key_id=$1", [input.keyId]))[0]!;
  }

  async updateApiKey(keyId: string, patch: GatewayApiKeyPatch) {
    const current = (await this.keysWhere("WHERE key_id=$1", [keyId]))[0];
    if (!current) return null;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const has = (field: keyof GatewayApiKeyPatch) => patch[field] !== undefined;
      await client.query(`UPDATE space_gateway_api_keys SET name=COALESCE($2,name), is_active=COALESCE($3,is_active),
          traffic_class=COALESCE($4,traffic_class), allowed_models=COALESCE($5,allowed_models),
          enforced_model=CASE WHEN $6::boolean THEN $7 ELSE enforced_model END,
          allowed_reasoning_efforts=COALESCE($8,allowed_reasoning_efforts),
          enforced_reasoning_effort=CASE WHEN $9::boolean THEN $10 ELSE enforced_reasoning_effort END,
          compression_override=CASE WHEN $11::boolean THEN $12 ELSE compression_override END,
          expires_at=CASE WHEN $13::boolean THEN $14::timestamptz ELSE expires_at END,
          account_scope_enabled=CASE WHEN $15::boolean THEN $16 ELSE account_scope_enabled END,${has("outputPolicyOverride") ? " output_policy_override=$17," : ""}
          updated_at=now()
        WHERE key_id=$1`,
        [keyId, patch.name ?? null, patch.isActive ?? null, patch.trafficClass ?? null, patch.allowedModels ?? null,
          has("enforcedModel"), patch.enforcedModel ?? null, patch.allowedReasoningEfforts ?? null,
          has("enforcedReasoningEffort"), patch.enforcedReasoningEffort ?? null, has("compressionOverride"), patch.compressionOverride ?? null,
          has("expiresAt"), patch.expiresAt ?? null, has("accountIds"), (patch.accountIds ?? []).length > 0,
          ...(has("outputPolicyOverride") ? [patch.outputPolicyOverride ?? null] : [])]);
      if (patch.accountIds) {
        await client.query(`DELETE FROM space_gateway_api_key_accounts WHERE key_id=$1`, [keyId]);
        for (const accountId of patch.accountIds) {
          await client.query(`INSERT INTO space_gateway_api_key_accounts(key_id,account_id) VALUES ($1,$2)`, [keyId, accountId]);
        }
      }
      if (patch.limits || patch.resetUsage) {
        const limits = patch.limits ? mergeKeyLimits(current.limits, patch.limits, patch.resetUsage === true)
          : current.limits.map((limit) => ({ ...limit, currentValue: 0 }));
        await client.query(`DELETE FROM space_gateway_api_key_limits WHERE key_id=$1`, [keyId]);
        for (const limit of limits) {
          await client.query(`INSERT INTO space_gateway_api_key_limits(key_id,limit_type,limit_window,max_value,current_value,model_filter,reset_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7)`, [keyId, limit.limitType, limit.limitWindow, limit.maxValue, limit.currentValue, limit.modelFilter, limit.resetAt]);
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      (client as { release?: () => void }).release?.();
    }
    return (await this.keysWhere("WHERE key_id=$1", [keyId]))[0] ?? null;
  }

  async regenerateApiKey(keyId: string, secret: { keyHash: string; keyPrefix: string }) {
    const row = (await this.pool.query<Record<string, unknown>>(`UPDATE space_gateway_api_keys SET key_hash=$2, key_prefix=$3, updated_at=now()
      WHERE key_id=$1 RETURNING key_id`, [keyId, secret.keyHash, secret.keyPrefix])).rows[0];
    return row ? (await this.keysWhere("WHERE key_id=$1", [keyId]))[0] ?? null : null;
  }

  async deleteApiKey(keyId: string) {
    return (await this.pool.query(`DELETE FROM space_gateway_api_keys WHERE key_id=$1 RETURNING key_id`, [keyId])).rows.length === 1;
  }

  async settleApiKeyUsage(keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) {
    await this.pool.query(`UPDATE space_gateway_api_key_limits SET
        current_value = (CASE WHEN reset_at <= $2::timestamptz THEN 0 ELSE current_value END) + (CASE limit_type
          WHEN 'TOTAL_TOKENS' THEN $3::bigint + $4::bigint WHEN 'INPUT_TOKENS' THEN $3::bigint WHEN 'OUTPUT_TOKENS' THEN $4::bigint
          WHEN 'COST_USD' THEN $5::bigint ELSE 0 END),
        reset_at = CASE WHEN reset_at > $2::timestamptz THEN reset_at
          WHEN limit_window = 'DAILY' THEN date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 day'
          WHEN limit_window = 'WEEKLY' THEN date_trunc('day', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '7 days'
          ELSE date_trunc('month', $2::timestamptz AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' + interval '1 month' END
      WHERE key_id=$1 AND (model_filter IS NULL OR model_filter=$6)`,
      [keyId, usage.at, Math.max(0, Math.round(usage.inputTokens)), Math.max(0, Math.round(usage.outputTokens)), Math.max(0, Math.round(usage.costMicros)), usage.model]);
    await this.pool.query(`UPDATE space_gateway_api_keys SET last_used_at=GREATEST(COALESCE(last_used_at, $2::timestamptz), $2::timestamptz) WHERE key_id=$1`, [keyId, usage.at]);
  }

  async insertRequestLogs(rows: GatewayRequestLogInsert[]) {
    if (rows.length === 0) return;
    const columns = ["request_id", "requested_at", "provider", "account_id", "api_key_id", "model", "plan_type", "reasoning_effort",
      "requested_service_tier", "service_tier", "transport", "upstream_transport", "status", "error_code", "error_message", "latency_ms",
      "first_token_ms", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "cost_usd", "compression_tokens_saved",
      "sticky_key_source", "sticky_kind", "sticky_key_hash", "cache_creation_tokens", "client_name", "project", "compression_tokens_before",
      "compression_tokens_after", "source", "cache_bust", "compression_detail", "upstream_request_id"];
    const values: unknown[] = [];
    const tuples = rows.map((row) => {
      const tuple = [row.requestId, row.requestedAt, row.provider, row.accountId, row.apiKeyId, row.model, row.planType ?? null,
        row.reasoningEffort, row.requestedServiceTier ?? null, row.serviceTier, row.transport, row.upstreamTransport ?? null, row.status,
        row.errorCode, row.errorMessage?.slice(0, 1000) ?? null, row.latencyMs, row.firstTokenMs, row.inputTokens, row.cachedInputTokens,
        row.outputTokens, row.reasoningTokens, row.costUsd, row.compressionTokensSaved, row.stickyKeySource ?? null, row.stickyKind,
        row.stickyKeyHash, row.cacheCreationTokens ?? null, row.clientName?.slice(0, 80) ?? null, row.project?.slice(0, 200) ?? null,
        row.compressionTokensBefore ?? null, row.compressionTokensAfter ?? null, row.source ?? null, row.cacheBust ?? null,
        row.compressionDetail ? JSON.stringify(row.compressionDetail) : null, row.upstreamRequestId ?? null];
      const placeholders = tuple.map((value) => { values.push(value); return `$${values.length}`; });
      return `(${placeholders.join(",")})`;
    });
    await this.pool.query(`INSERT INTO space_gateway_request_logs(${columns.join(",")}) VALUES ${tuples.join(",")}`, values);
    const daily = new Map<string, GatewayRequestLogInsert[]>();
    // Warm-up requests are the gateway's own; usage totals leave them out.
    for (const row of rows.filter((item) => item.source !== "limit_warmup")) {
      const key = JSON.stringify([row.requestedAt.slice(0, 10), row.provider, row.accountId ?? "", row.apiKeyId ?? "", row.model]);
      daily.set(key, [...(daily.get(key) ?? []), row]);
    }
    for (const [key, group] of daily) {
      const [day, provider, accountId, apiKeyId, model] = JSON.parse(key) as string[];
      const sum = (pick: (row: GatewayRequestLogInsert) => number | null) => group.reduce((total, row) => total + (pick(row) ?? 0), 0);
      await this.pool.query(`INSERT INTO space_gateway_usage_daily(day,provider,account_id,api_key_id,model,requests,errors,input_tokens,
          cached_input_tokens,output_tokens,reasoning_tokens,reasoning_reported,cost_usd,compression_tokens_saved)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (day,provider,account_id,api_key_id,model) DO UPDATE SET requests=space_gateway_usage_daily.requests+EXCLUDED.requests,
          errors=space_gateway_usage_daily.errors+EXCLUDED.errors, input_tokens=space_gateway_usage_daily.input_tokens+EXCLUDED.input_tokens,
          cached_input_tokens=space_gateway_usage_daily.cached_input_tokens+EXCLUDED.cached_input_tokens,
          output_tokens=space_gateway_usage_daily.output_tokens+EXCLUDED.output_tokens,
          reasoning_tokens=space_gateway_usage_daily.reasoning_tokens+EXCLUDED.reasoning_tokens,
          reasoning_reported=space_gateway_usage_daily.reasoning_reported+EXCLUDED.reasoning_reported,
          cost_usd=space_gateway_usage_daily.cost_usd+EXCLUDED.cost_usd,
          compression_tokens_saved=space_gateway_usage_daily.compression_tokens_saved+EXCLUDED.compression_tokens_saved`,
        [day, provider, accountId, apiKeyId, model, group.length, group.filter((row) => row.status !== "success").length,
          sum((row) => row.inputTokens), sum((row) => row.cachedInputTokens), sum((row) => row.outputTokens), sum((row) => row.reasoningTokens),
          group.filter((row) => row.reasoningTokens !== null).length, sum((row) => row.costUsd), sum((row) => row.compressionTokensSaved)]);
    }
    const savings = new Map<string, { key: ReturnType<typeof savingsDailyKey>; rows: GatewayRequestLogInsert[] }>();
    for (const row of rows.filter((item) => item.source !== "limit_warmup")) {
      const key = savingsDailyKey(row);
      const entry = savings.get(key.key) ?? { key, rows: [] };
      entry.rows.push(row);
      savings.set(key.key, entry);
    }
    for (const { key, rows: group } of savings.values()) {
      const delta = savingsDailyDelta(group);
      const columns = ["requests", "failed", "rate_limited", "cached_requests", "input_tokens", "cached_input_tokens", "cache_creation_tokens", "output_tokens",
        "cost_usd", "compression_before", "compression_after", "compression_saved", "shadow_saved", "cache_busts", "cache_bust_tokens"];
      const values = [delta.requests, delta.failed, delta.rateLimited, delta.cachedRequests, delta.inputTokens, delta.cachedInputTokens, delta.cacheCreationTokens,
        delta.outputTokens, delta.costUsd, delta.compressionBefore, delta.compressionAfter, delta.compressionSaved, delta.shadowSaved, delta.cacheBusts, delta.cacheBustTokens];
      await this.pool.query(`INSERT INTO space_gateway_savings_daily(day, provider, model, client, project, ${columns.join(", ")})
        VALUES ($1,$2,$3,$4,$5,${columns.map((_, index) => `$${index + 6}`).join(",")})
        ON CONFLICT (day, provider, model, client, project) DO UPDATE SET ${columns.map((column) => `${column}=space_gateway_savings_daily.${column}+EXCLUDED.${column}`).join(", ")}`,
      [key.day, key.provider, key.model, key.client, key.project, ...values]);
    }
  }

  async listRequestLogs(query: GatewayRequestLogQuery) {
    const values: unknown[] = [];
    const conditions = logFilterConditions(withLegacyIds(query), values);
    if (query.beforeId) { values.push(query.beforeId); conditions.push(`l.id < $${values.length}`); }
    values.push(Math.max(1, Math.min(query.limit, 500)));
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT l.* FROM space_gateway_request_logs l
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY l.id DESC LIMIT $${values.length}`, values)).rows;
    return rows.map(requestLogRecord);
  }

  async requestLogsAfter(afterId: string | null, limit: number) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_request_logs
      WHERE id > $1 AND source IS DISTINCT FROM 'limit_warmup' ORDER BY id LIMIT $2`,
    [afterId && /^\d{1,19}$/.test(afterId) ? afterId : "0", Math.max(1, Math.min(limit, 5000))])).rows;
    return rows.map(requestLogRecord);
  }

  async claudeLogKeys(from: string, to: string) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT upstream_request_id, requested_at, model, input_tokens, output_tokens
      FROM space_gateway_request_logs WHERE provider = 'CLAUDE' AND requested_at BETWEEN $1 AND $2`, [from, to])).rows;
    return rows.map((row) => ({ upstreamRequestId: (row.upstream_request_id as string | null) ?? null, requestedAt: iso(row.requested_at)!,
      model: String(row.model), inputTokens: num(row.input_tokens), outputTokens: num(row.output_tokens) }));
  }

  async getRequestLog(id: string) {
    if (!/^\d{1,19}$/.test(id)) return null;
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_request_logs WHERE id = $1`, [id])).rows[0];
    return row ? requestLogRecord(row) : null;
  }

  async requestLogFacets(filter: Pick<GatewayRequestLogFilter, "from" | "to">) {
    const facet = async (expression: string, limit: number) => {
      const values: unknown[] = [];
      const conditions = logFilterConditions({ from: filter.from, to: filter.to }, values);
      return (await this.pool.query<Record<string, unknown>>(`SELECT ${expression} AS value, count(*) AS n FROM space_gateway_request_logs l
        ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""} GROUP BY 1 HAVING ${expression} IS NOT NULL ORDER BY 2 DESC, 1 LIMIT ${limit}`, values)).rows
        .map((row) => ({ value: String(row.value), count: Number(row.n) }));
    };
    return {
      models: await facet("l.model", 500), providers: await facet("l.provider", 20), statuses: await facet(groupSql.status, 5),
      accounts: await facet("l.account_id", 1000), apiKeys: await facet("l.api_key_id", 1000), clients: await facet("l.client_name", 100)
    };
  }

  async aggregateRequestLogs(filter: GatewayRequestLogFilter, group: GatewayLogGroup, options: { limit?: number; orderBy?: "requests" | "costUsd" | "key" } = {}) {
    const values: unknown[] = [];
    const conditions = logFilterConditions(filter, values, { excludeWarmup: true });
    const order = options.orderBy === "key" ? "1" : options.orderBy === "costUsd" ? "cost_usd DESC, 1" : "requests DESC, 1";
    const limit = options.limit ? ` LIMIT ${Math.max(1, Math.min(Math.trunc(options.limit), 5000))}` : "";
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT ${groupSql[group]} AS key, ${aggregateSelectSql}
      FROM space_gateway_request_logs l ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      GROUP BY 1 ORDER BY ${order}${limit}`, values)).rows;
    return rows.map(aggregateRecord);
  }

  async usageSince(since: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT count(*) AS requests,
        count(*) FILTER (WHERE status <> 'success') AS errors, COALESCE(sum(input_tokens),0) AS input_tokens,
        COALESCE(sum(output_tokens),0) AS output_tokens, COALESCE(sum(cost_usd),0) AS cost_usd,
        COALESCE(sum(compression_tokens_saved),0) AS compression_tokens_saved
      FROM space_gateway_request_logs WHERE requested_at >= $1`, [since])).rows[0]!;
    return {
      requests: Number(row.requests), errors: Number(row.errors), inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens), costUsd: Number(row.cost_usd), compressionTokensSaved: Number(row.compression_tokens_saved)
    };
  }

  async usageTotals(scope: { accountId?: string; apiKeyId?: string }) {
    const column = scope.accountId ? "account_id" : "api_key_id";
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT COALESCE(sum(requests),0) AS requests, COALESCE(sum(input_tokens),0) AS input_tokens,
        COALESCE(sum(cached_input_tokens),0) AS cached_input_tokens, COALESCE(sum(output_tokens),0) AS output_tokens, COALESCE(sum(cost_usd),0) AS cost_usd
      FROM space_gateway_usage_daily WHERE ${column} = $1`, [scope.accountId ?? scope.apiKeyId ?? ""])).rows[0]!;
    return { requests: Number(row.requests), inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens),
      outputTokens: Number(row.output_tokens), costUsd: Math.round(Number(row.cost_usd) * 1e9) / 1e9 };
  }

  async usageHistory(accountId: string, since: string) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT usage_window, quota_key, used_percent, reset_at, recorded_at
      FROM space_gateway_usage_history WHERE account_id = $1 AND recorded_at >= $2 ORDER BY recorded_at, id LIMIT 20000`, [accountId, since])).rows;
    return rows.map((row): GatewayUsageHistoryPoint => ({ window: row.usage_window as GatewayUsageHistoryPoint["window"], quotaKey: String(row.quota_key ?? ""),
      usedPercent: Number(row.used_percent), resetAt: iso(row.reset_at), recordedAt: iso(row.recorded_at)! }));
  }

  async latestWarmups() {
    return (await this.pool.query<Record<string, unknown>>(`SELECT DISTINCT ON (account_id) * FROM space_gateway_warmups
      ORDER BY account_id, attempted_at DESC, id DESC`)).rows.map(warmupRecord);
  }

  async claimWarmup(attempt: { accountId: string; window: "PRIMARY" | "SECONDARY"; resetAt: string; model: string | null; attemptedAt?: string }) {
    const row = (await this.pool.query<Record<string, unknown>>(`INSERT INTO space_gateway_warmups(account_id, usage_window, reset_at, status, model, attempted_at)
      VALUES ($1,$2,$3,'PENDING',$4,COALESCE($5::timestamptz, now())) ON CONFLICT (account_id, usage_window, reset_at) DO NOTHING RETURNING id`,
    [attempt.accountId, attempt.window, attempt.resetAt, attempt.model, attempt.attemptedAt ?? null])).rows[0];
    return row ? Number(row.id) : null;
  }

  async finishWarmup(id: number, result: { status: "SUCCEEDED" | "FAILED" | "SKIPPED"; errorCode?: string | null; errorMessage?: string | null; model?: string | null }) {
    await this.pool.query(`UPDATE space_gateway_warmups SET status=$2, error_code=$3, error_message=$4, model=COALESCE($5, model), completed_at=now() WHERE id=$1`,
      [id, result.status, result.errorCode?.slice(0, 120) ?? null, result.errorMessage?.slice(0, 500) ?? null, result.model ?? null]);
  }

  async ping() {
    const started = performance.now();
    await this.pool.query("SELECT 1");
    return Math.round((performance.now() - started) * 10) / 10;
  }

  async requestStatsSince(since: string) {
    const totals = (await this.pool.query<Record<string, unknown>>(`SELECT count(*) AS total,
        count(*) FILTER (WHERE status <> 'success') AS failed,
        count(*) FILTER (WHERE error_code IN ('rate_limit_exceeded','usage_limit_reached','rate_limit_error')) AS rate_limited,
        count(*) FILTER (WHERE cached_input_tokens > 0) AS cached, COALESCE(sum(cache_creation_tokens),0) AS cache_creation_tokens,
        COALESCE(sum(input_tokens),0) AS input_tokens, COALESCE(sum(cached_input_tokens),0) AS cached_input_tokens,
        COALESCE(sum(output_tokens),0) AS output_tokens, COALESCE(sum(compression_tokens_saved),0) AS compression_tokens_saved,
        count(latency_ms) AS latency_count, COALESCE(avg(latency_ms),0) AS latency_avg, COALESCE(min(latency_ms),0) AS latency_min, COALESCE(max(latency_ms),0) AS latency_max,
        count(first_token_ms) AS ttfb_count, COALESCE(avg(first_token_ms),0) AS ttfb_avg, COALESCE(min(first_token_ms),0) AS ttfb_min, COALESCE(max(first_token_ms),0) AS ttfb_max
      FROM space_gateway_request_logs WHERE requested_at >= $1`, [since])).rows[0]!;
    const counts = async (column: "provider" | "model") => Object.fromEntries((await this.pool.query<Record<string, unknown>>(
      `SELECT ${column} AS key, count(*) AS n FROM space_gateway_request_logs WHERE requested_at >= $1 GROUP BY 1 ORDER BY 1`, [since])).rows
      .map((row) => [String(row.key), Number(row.n)]));
    const round = (value: unknown) => Math.round(Number(value) * 100) / 100;
    return {
      total: Number(totals.total), failed: Number(totals.failed), rateLimited: Number(totals.rate_limited),
      cached: Number(totals.cached), cacheCreationTokens: Number(totals.cache_creation_tokens),
      byProvider: await counts("provider"), byModel: await counts("model"),
      inputTokens: Number(totals.input_tokens), cachedInputTokens: Number(totals.cached_input_tokens), outputTokens: Number(totals.output_tokens),
      compressionTokensSaved: Number(totals.compression_tokens_saved),
      latency: { count: Number(totals.latency_count), averageMs: round(totals.latency_avg), minMs: Number(totals.latency_min), maxMs: Number(totals.latency_max) },
      ttfb: { count: Number(totals.ttfb_count), averageMs: round(totals.ttfb_avg), minMs: Number(totals.ttfb_min), maxMs: Number(totals.ttfb_max) }
    };
  }

  async usageReport(from: string, to: string) {
    const group = async (expression: string) => (await this.pool.query<Record<string, unknown>>(`SELECT ${expression} AS key,
        sum(requests) AS requests, sum(errors) AS errors, sum(input_tokens) AS input_tokens, sum(cached_input_tokens) AS cached_input_tokens,
        sum(output_tokens) AS output_tokens, sum(reasoning_tokens) AS reasoning_tokens, sum(reasoning_reported) AS reasoning_reported,
        sum(cost_usd) AS cost_usd, sum(compression_tokens_saved) AS compression_tokens_saved
      FROM space_gateway_usage_daily WHERE day BETWEEN $1::date AND $2::date GROUP BY 1 ORDER BY 1`, [from, to])).rows.map(reportRow);
    return { days: await group("to_char(day, 'YYYY-MM-DD')"), models: await group("model"), accounts: await group("account_id") };
  }

  async recordCompression(rows: GatewayCompressionRow[]) {
    for (const row of rows) {
      await this.pool.query(`INSERT INTO space_gateway_compression_rollups(hour,mode,provider,strategy,requests,modified_requests,blocks,
          rejected_blocks,error_blocks,timed_out,original_tokens,compressed_tokens,overhead_ms,max_overhead_ms)
        VALUES (date_trunc('hour', $1::timestamptz),$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (hour,mode,provider,strategy) DO UPDATE SET requests=space_gateway_compression_rollups.requests+EXCLUDED.requests,
          modified_requests=space_gateway_compression_rollups.modified_requests+EXCLUDED.modified_requests,
          blocks=space_gateway_compression_rollups.blocks+EXCLUDED.blocks,
          rejected_blocks=space_gateway_compression_rollups.rejected_blocks+EXCLUDED.rejected_blocks,
          error_blocks=space_gateway_compression_rollups.error_blocks+EXCLUDED.error_blocks,
          timed_out=space_gateway_compression_rollups.timed_out+EXCLUDED.timed_out,
          original_tokens=space_gateway_compression_rollups.original_tokens+EXCLUDED.original_tokens,
          compressed_tokens=space_gateway_compression_rollups.compressed_tokens+EXCLUDED.compressed_tokens,
          overhead_ms=space_gateway_compression_rollups.overhead_ms+EXCLUDED.overhead_ms,
          max_overhead_ms=GREATEST(space_gateway_compression_rollups.max_overhead_ms, EXCLUDED.max_overhead_ms)`,
        [row.hour, row.mode, row.provider, row.strategy, row.requests, row.modifiedRequests, row.blocks, row.rejectedBlocks, row.errorBlocks,
          row.timedOut, row.originalTokens, row.compressedTokens, row.overheadMs, row.maxOverheadMs]);
    }
  }

  async compressionSince(since: string) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_compression_rollups WHERE hour >= date_trunc('hour', $1::timestamptz)
      ORDER BY hour, mode, provider, strategy`, [since])).rows;
    return rows.map((row): GatewayCompressionRow => ({
      hour: iso(row.hour)!, mode: row.mode as "SHADOW" | "ON", provider: String(row.provider), strategy: String(row.strategy),
      requests: Number(row.requests), modifiedRequests: Number(row.modified_requests), blocks: Number(row.blocks), rejectedBlocks: Number(row.rejected_blocks),
      errorBlocks: Number(row.error_blocks), timedOut: Number(row.timed_out), originalTokens: Number(row.original_tokens),
      compressedTokens: Number(row.compressed_tokens), overheadMs: Number(row.overhead_ms), maxOverheadMs: Number(row.max_overhead_ms)
    }));
  }

  async recordCompressionSignals(rows: GatewayCompressionSignalRow[]) {
    for (const row of rows) {
      await this.pool.query(`INSERT INTO space_gateway_compression_signals(hour, mode, provider, kind, name, count, value, max_value)
        VALUES (date_trunc('hour', $1::timestamptz), $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (hour, mode, provider, kind, name) DO UPDATE SET count = space_gateway_compression_signals.count + EXCLUDED.count,
          value = space_gateway_compression_signals.value + EXCLUDED.value, max_value = GREATEST(space_gateway_compression_signals.max_value, EXCLUDED.max_value)`,
      [row.hour, row.mode, row.provider, row.kind, row.name.slice(0, 60), row.count, row.value, row.maxValue]);
    }
  }

  async compressionSignalsSince(since: string) {
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT * FROM space_gateway_compression_signals WHERE hour >= date_trunc('hour', $1::timestamptz)
      ORDER BY hour, mode, provider, kind, name`, [since])).rows;
    return rows.map((row): GatewayCompressionSignalRow => ({ hour: iso(row.hour)!, mode: row.mode as "SHADOW" | "ON", provider: String(row.provider),
      kind: row.kind as "waste" | "stage", name: String(row.name), count: Number(row.count), value: Number(row.value), maxValue: Number(row.max_value) }));
  }

  async savingsDaily(range: { from?: string; to?: string } = {}) {
    // The day as text: pg turns a date into local midnight, which is the previous day in UTC east of Greenwich.
    const rows = (await this.pool.query<Record<string, unknown>>(`SELECT *, to_char(day, 'YYYY-MM-DD') AS day_text FROM space_gateway_savings_daily
      WHERE ($1::date IS NULL OR day >= $1::date) AND ($2::date IS NULL OR day <= $2::date) ORDER BY day, provider, model, client, project`,
    [range.from ?? null, range.to ?? null])).rows;
    return rows.map((row): GatewaySavingsDailyRow => ({
      day: String(row.day_text), provider: String(row.provider), model: String(row.model),
      client: String(row.client), project: String(row.project), requests: Number(row.requests), failed: Number(row.failed), rateLimited: Number(row.rate_limited),
      cachedRequests: Number(row.cached_requests), inputTokens: Number(row.input_tokens), cachedInputTokens: Number(row.cached_input_tokens),
      cacheCreationTokens: Number(row.cache_creation_tokens), outputTokens: Number(row.output_tokens), costUsd: Number(row.cost_usd),
      compressionBefore: Number(row.compression_before), compressionAfter: Number(row.compression_after), compressionSaved: Number(row.compression_saved),
      shadowSaved: Number(row.shadow_saved), cacheBusts: Number(row.cache_busts), cacheBustTokens: Number(row.cache_bust_tokens)
    }));
  }

  async pruneRequestLogs(before: string, batchSize = 5000) {
    let removed = 0;
    for (;;) {
      const count = (await this.pool.query(`DELETE FROM space_gateway_request_logs WHERE id IN
        (SELECT id FROM space_gateway_request_logs WHERE requested_at < $1 ORDER BY id LIMIT $2)`, [before, batchSize])).rowCount ?? 0;
      removed += count;
      if (count < batchSize) return removed;
    }
  }

  async speedDefaults() {
    const row = (await this.pool.query<Record<string, unknown>>(
      `INSERT INTO space_gateway_settings(settings_id) VALUES (1) ON CONFLICT (settings_id) DO UPDATE SET settings_id=1
       RETURNING speed_defaults, speed_defaults_updated_at`)).rows[0]!;
    return speedDefaultsRecord(row);
  }

  async setSpeedDefault(modelId: string, tier: GatewaySpeedTier) {
    await this.speedDefaults();
    const row = (await this.pool.query<Record<string, unknown>>(
      tier === "fast"
        ? `UPDATE space_gateway_settings SET speed_defaults = speed_defaults || jsonb_build_object($1::text, 'fast'), speed_defaults_updated_at = now()
           WHERE settings_id = 1 RETURNING speed_defaults, speed_defaults_updated_at`
        : `UPDATE space_gateway_settings SET speed_defaults = speed_defaults - $1::text, speed_defaults_updated_at = now()
           WHERE settings_id = 1 RETURNING speed_defaults, speed_defaults_updated_at`, [modelId])).rows[0]!;
    return speedDefaultsRecord(row);
  }

  async saveStickyBindings(rows: GatewayStickyBinding[]) {
    if (rows.length === 0) return;
    await this.pool.query(`INSERT INTO space_gateway_sticky_bindings(key_hash, kind, provider, account_id, expires_at)
      SELECT b.key_hash, b.kind, b.provider, b.account_id, b.expires_at
      FROM jsonb_to_recordset($1::jsonb) AS b(key_hash text, kind text, provider text, account_id text, expires_at timestamptz)
      WHERE EXISTS (SELECT 1 FROM space_gateway_accounts a WHERE a.account_id = b.account_id)
      ON CONFLICT (key_hash) DO UPDATE SET kind = EXCLUDED.kind, provider = EXCLUDED.provider, account_id = EXCLUDED.account_id,
        expires_at = EXCLUDED.expires_at, updated_at = now()`,
    [JSON.stringify(rows.map((row) => ({ key_hash: row.keyHash, kind: row.kind, provider: row.provider, account_id: row.accountId, expires_at: row.expiresAt })))]);
  }

  async findStickyBinding(keyHash: string, nowIso: string) {
    const row = (await this.pool.query<Record<string, unknown>>(`SELECT key_hash, kind, provider, account_id, expires_at FROM space_gateway_sticky_bindings
      WHERE key_hash = $1 AND (expires_at IS NULL OR expires_at > $2)`, [keyHash, nowIso])).rows[0];
    return row ? { keyHash: String(row.key_hash), kind: row.kind as GatewayStickyKind, provider: row.provider as GatewayProvider,
      accountId: String(row.account_id), expiresAt: iso(row.expires_at) } : null;
  }

  async pruneStickyBindings(nowIso: string) {
    return (await this.pool.query("DELETE FROM space_gateway_sticky_bindings WHERE expires_at IS NOT NULL AND expires_at <= $1", [nowIso])).rowCount ?? 0;
  }

  async dispose() { await (this.pool as PgPoolLike & { end?: () => Promise<void> }).end?.(); }
}

/** In-memory twin for tests and demo mode. */
export class InMemoryGatewayRepository implements GatewayRepository {
  settings: GatewaySettings = { ...defaultGatewaySettings, planPriority: [...defaultGatewaySettings.planPriority],
    lanAllowedSources: [...defaultGatewaySettings.lanAllowedSources], compressionProviders: {}, updatedAt: new Date(0).toISOString() };
  accounts: GatewayAccountRecord[] = [];
  keys: GatewayApiKeyRecord[] = [];
  logs: GatewayRequestLog[] = [];
  private nextLogId = 1;
  private readonly upstreamRequestIds = new Map<string, string>();

  async getSettings() {
    return { ...this.settings, planPriority: [...this.settings.planPriority], lanAllowedSources: [...this.settings.lanAllowedSources],
      compressionProviders: copyProviders(this.settings.compressionProviders) };
  }
  async updateSettings(patch: GatewaySettingsUpdateRequest) {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    this.settings = { ...this.settings, ...defined, updatedAt: new Date().toISOString() };
    return this.getSettings();
  }
  async listAccounts() { return this.accounts.map((account) => ({ ...account })); }
  async setAccountStatus(accountId: string, status: GatewayAccountStatus, reason: string | null) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) return null;
    account.status = status;
    account.statusReason = reason;
    return { ...account };
  }
  async updateAccountPreferences(accountId: string, patch: { alias?: string | null; warmupEnabled?: boolean }) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) return null;
    if (patch.alias !== undefined) account.alias = patch.alias;
    if (patch.warmupEnabled !== undefined) account.warmupEnabled = patch.warmupEnabled;
    return { ...account };
  }
  private locks = new Map<string, Promise<unknown>>();
  async upsertAccount(input: GatewayAccountInsert) {
    const existing = input.externalAccountId
      ? this.accounts.find((account) => account.provider === input.provider && account.externalAccountId === input.externalAccountId) : undefined;
    if (existing) {
      Object.assign(existing, {
        email: input.email, planType: input.planType ?? existing.planType, credentialsEncrypted: input.credentialsEncrypted,
        credentialsExpiresAt: input.credentialsExpiresAt, lastRefreshAt: input.lastRefreshAt,
        status: existing.status === "PAUSED" ? "PAUSED" : "ACTIVE", statusReason: existing.status === "PAUSED" ? existing.statusReason : null
      });
      return { ...existing };
    }
    const record: GatewayAccountRecord = {
      id: input.accountId, provider: input.provider, label: input.label, alias: null, email: input.email, planType: input.planType, status: "ACTIVE",
      statusReason: null, priority: 100, warmupEnabled: false, resetCreditsAvailable: null, primaryWindow: { ...emptyWindow }, secondaryWindow: { ...emptyWindow },
      lastRefreshAt: input.lastRefreshAt, lastUsedAt: null, createdAt: new Date().toISOString(), externalAccountId: input.externalAccountId,
      credentialsEncrypted: input.credentialsEncrypted, credentialsExpiresAt: input.credentialsExpiresAt, source: input.source,
      sourceRef: input.sourceRef, blockedUntil: null
    };
    this.accounts.push(record);
    return { ...record };
  }
  async deleteAccount(accountId: string) {
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => account.id !== accountId);
    for (const [key, binding] of this.sticky) if (binding.accountId === accountId) this.sticky.delete(key);
    return this.accounts.length < before;
  }
  async replaceAccountSignIn(accountId: string, input: Omit<GatewayAccountInsert, "accountId" | "provider" | "label">) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) return null;
    Object.assign(account, { email: input.email, externalAccountId: input.externalAccountId, planType: input.planType ?? account.planType,
      credentialsEncrypted: input.credentialsEncrypted, credentialsExpiresAt: input.credentialsExpiresAt, source: input.source, sourceRef: input.sourceRef,
      lastRefreshAt: input.lastRefreshAt, blockedUntil: null, status: account.status === "PAUSED" ? "PAUSED" : "ACTIVE",
      statusReason: account.status === "PAUSED" ? account.statusReason : null });
    return { ...account };
  }
  async withAccountCredentialLock(accountId: string, update: (current: GatewayAccountRecord) => Promise<GatewayCredentialUpdate | null>) {
    const previous = this.locks.get(accountId) ?? Promise.resolve();
    const run = previous.then(async () => {
      const account = this.accounts.find((item) => item.id === accountId);
      if (!account) return null;
      const change = await update({ ...account });
      if (change) {
        const defined = Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined));
        Object.assign(account, defined);
      }
      return { ...account };
    });
    this.locks.set(accountId, run.catch(() => undefined));
    return run;
  }
  async saveUsageWindows(accountId: string, windows: GatewayUsageWindowInput[]) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account) return;
    for (const window of windows) {
      const target = window.window === "PRIMARY" ? "primaryWindow" : "secondaryWindow";
      const quotaKey = window.quotaKey ?? "";
      if (quotaKey !== "") {
        const groups = account.quotaGroups ?? [];
        let group = groups.find((item) => item.key === quotaKey);
        if (!group) {
          group = { key: quotaKey, primaryWindow: { ...emptyWindow }, secondaryWindow: { ...emptyWindow } };
          groups.push(group);
          groups.sort((a, b) => a.key.localeCompare(b.key));
        }
        group[target] = { usedPercent: window.usedPercent, resetAt: window.resetAt, windowMinutes: window.windowMinutes ?? group[target].windowMinutes };
        account.quotaGroups = groups;
        continue;
      }
      account[target] = { usedPercent: window.usedPercent, resetAt: window.resetAt, windowMinutes: window.windowMinutes ?? account[target].windowMinutes };
      if (window.usedPercent !== null) {
        this.history.push({ accountId, window: window.window, quotaKey, usedPercent: window.usedPercent, resetAt: window.resetAt, recordedAt: new Date().toISOString() });
      }
    }
  }
  async recordAccountState(accountId: string, state: { status: GatewayAccountStatus; statusReason: string | null; blockedUntil: string | null }) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (!account || account.status === "PAUSED") return;
    account.status = state.status;
    account.statusReason = state.statusReason;
    account.blockedUntil = state.blockedUntil;
  }
  async touchAccounts(accountIds: string[], usedAt: string) {
    for (const account of this.accounts) if (accountIds.includes(account.id)) account.lastUsedAt = usedAt;
  }
  async saveResetCredits(accountId: string, available: number | null) {
    const account = this.accounts.find((item) => item.id === accountId);
    if (account) account.resetCreditsAvailable = available;
  }
  async listApiKeys() { return this.keys.map((key) => ({ ...key })); }
  async findApiKeyByHash(keyHash: string) { const key = this.keys.find((item) => item.keyHash === keyHash); return key ? { ...key } : null; }
  async createApiKey(input: GatewayApiKeyInsert) {
    if (this.keys.some((key) => key.keyHash === input.keyHash)) throw new Error("duplicate key hash");
    const record: GatewayApiKeyRecord = {
      id: input.keyId, name: input.name, keyPrefix: input.keyPrefix, keyHash: input.keyHash, isActive: true, trafficClass: input.trafficClass,
      allowedModels: [...input.allowedModels], enforcedModel: input.enforcedModel, allowedReasoningEfforts: [...input.allowedReasoningEfforts],
      enforcedReasoningEffort: input.enforcedReasoningEffort, accountScopeEnabled: input.accountIds.length > 0, accountIds: [...input.accountIds],
      compressionOverride: input.compressionOverride, outputPolicyOverride: input.outputPolicyOverride ?? null,
      limits: input.limits.map((limit) => ({ ...limit, currentValue: 0 })),
      expiresAt: input.expiresAt, lastUsedAt: null, createdAt: new Date().toISOString()
    };
    this.keys.unshift(record);
    return { ...record };
  }
  async updateApiKey(keyId: string, patch: GatewayApiKeyPatch) {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return null;
    if (patch.name !== undefined) key.name = patch.name;
    if (patch.isActive !== undefined) key.isActive = patch.isActive;
    if (patch.trafficClass !== undefined) key.trafficClass = patch.trafficClass;
    if (patch.allowedModels !== undefined) key.allowedModels = [...patch.allowedModels];
    if (patch.enforcedModel !== undefined) key.enforcedModel = patch.enforcedModel;
    if (patch.allowedReasoningEfforts !== undefined) key.allowedReasoningEfforts = [...patch.allowedReasoningEfforts];
    if (patch.enforcedReasoningEffort !== undefined) key.enforcedReasoningEffort = patch.enforcedReasoningEffort;
    if (patch.compressionOverride !== undefined) key.compressionOverride = patch.compressionOverride;
    if (patch.outputPolicyOverride !== undefined) key.outputPolicyOverride = patch.outputPolicyOverride;
    if (patch.expiresAt !== undefined) key.expiresAt = patch.expiresAt;
    if (patch.accountIds !== undefined) { key.accountIds = [...patch.accountIds]; key.accountScopeEnabled = patch.accountIds.length > 0; }
    if (patch.limits) key.limits = mergeKeyLimits(key.limits, patch.limits, patch.resetUsage === true);
    else if (patch.resetUsage) key.limits = key.limits.map((limit) => ({ ...limit, currentValue: 0 }));
    return { ...key, limits: key.limits.map((limit) => ({ ...limit })) };
  }
  async regenerateApiKey(keyId: string, secret: { keyHash: string; keyPrefix: string }) {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return null;
    key.keyHash = secret.keyHash;
    key.keyPrefix = secret.keyPrefix;
    return { ...key };
  }
  async deleteApiKey(keyId: string) {
    const before = this.keys.length;
    this.keys = this.keys.filter((key) => key.id !== keyId);
    return this.keys.length < before;
  }
  async settleApiKeyUsage(keyId: string, usage: { inputTokens: number; outputTokens: number; costMicros: number; model: string | null; at: string }) {
    const key = this.keys.find((item) => item.id === keyId);
    if (!key) return;
    for (const limit of key.limits) {
      if (limit.modelFilter !== null && limit.modelFilter !== usage.model) continue;
      const delta = limit.limitType === "TOTAL_TOKENS" ? usage.inputTokens + usage.outputTokens : limit.limitType === "INPUT_TOKENS" ? usage.inputTokens
        : limit.limitType === "OUTPUT_TOKENS" ? usage.outputTokens : usage.costMicros;
      if (limit.resetAt <= usage.at) {
        limit.currentValue = 0;
        const next = new Date(usage.at);
        next.setUTCHours(0, 0, 0, 0);
        if (limit.limitWindow === "DAILY") next.setUTCDate(next.getUTCDate() + 1);
        else if (limit.limitWindow === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
        else next.setUTCMonth(next.getUTCMonth() + 1, 1);
        limit.resetAt = next.toISOString();
      }
      limit.currentValue += Math.max(0, Math.round(delta));
    }
    key.lastUsedAt = usage.at;
  }
  async insertRequestLogs(rows: GatewayRequestLogInsert[]) {
    const groups = new Map<string, { key: ReturnType<typeof savingsDailyKey>; rows: GatewayRequestLogInsert[] }>();
    for (const row of rows.filter((item) => item.source !== "limit_warmup")) {
      const key = savingsDailyKey(row);
      const entry = groups.get(key.key) ?? { key, rows: [] };
      entry.rows.push(row);
      groups.set(key.key, entry);
    }
    for (const { key, rows: group } of groups.values()) {
      const delta = savingsDailyDelta(group);
      const existing = this.savings.find((item) => item.day === key.day && item.provider === key.provider && item.model === key.model
        && item.client === key.client && item.project === key.project);
      if (!existing) { this.savings.push({ day: key.day, provider: key.provider, model: key.model, client: key.client, project: key.project, ...delta }); continue; }
      for (const [field, value] of Object.entries(delta) as [keyof typeof delta, number][]) existing[field] += value;
    }
    for (const row of rows) {
      if (row.upstreamRequestId) this.upstreamRequestIds.set(String(this.nextLogId), row.upstreamRequestId);
      this.logs.unshift({
        id: String(this.nextLogId++), requestId: row.requestId, requestedAt: row.requestedAt, provider: row.provider, accountId: row.accountId,
        apiKeyId: row.apiKeyId, model: row.model, reasoningEffort: row.reasoningEffort, serviceTier: row.serviceTier, transport: row.transport,
        status: row.status, errorCode: row.errorCode, latencyMs: row.latencyMs, firstTokenMs: row.firstTokenMs, inputTokens: row.inputTokens,
        cachedInputTokens: row.cachedInputTokens, outputTokens: row.outputTokens, reasoningTokens: row.reasoningTokens, costUsd: row.costUsd,
        compressionTokensSaved: row.compressionTokensSaved, stickyKind: row.stickyKind, stickyKeyHash: row.stickyKeyHash,
        planType: row.planType ?? null, requestedServiceTier: row.requestedServiceTier ?? null, upstreamTransport: row.upstreamTransport ?? null,
        errorMessage: row.errorMessage?.slice(0, 1000) ?? null, stickyKeySource: row.stickyKeySource ?? null,
        cacheCreationTokens: row.cacheCreationTokens ?? null, clientName: row.clientName?.slice(0, 80) ?? null, project: row.project?.slice(0, 200) ?? null,
        compressionTokensBefore: row.compressionTokensBefore ?? null, compressionTokensAfter: row.compressionTokensAfter ?? null,
        source: row.source ?? null, cacheBust: row.cacheBust ?? null, compressionDetail: row.compressionDetail ?? null
      });
    }
  }
  private searchNames() {
    return {
      account: (id: string) => { const account = this.accounts.find((item) => item.id === id); return account ? [account.label, account.alias, account.email].filter((value): value is string => Boolean(value)) : []; },
      key: (id: string) => { const key = this.keys.find((item) => item.id === id); return key ? [key.name, key.keyPrefix] : []; }
    };
  }
  async listRequestLogs(query: GatewayRequestLogQuery) {
    const filter = withLegacyIds(query);
    const names = this.searchNames();
    return this.logs
      .filter((log) => !query.beforeId || Number(log.id) < query.beforeId)
      .filter((log) => matchesLogFilter(log, filter, names))
      .slice(0, Math.max(1, Math.min(query.limit, 500)));
  }
  async getRequestLog(id: string) {
    const log = this.logs.find((item) => item.id === id);
    return log ? { ...log } : null;
  }
  async requestLogFacets(filter: Pick<GatewayRequestLogFilter, "from" | "to">) {
    const rows = this.logs.filter((log) => matchesLogFilter(log, { from: filter.from, to: filter.to }));
    const facet = (pick: (log: GatewayRequestLog) => string | null, limit: number) => {
      const counts = new Map<string, number>();
      for (const log of rows) { const value = pick(log); if (value !== null) counts.set(value, (counts.get(value) ?? 0) + 1); }
      return [...counts].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, limit);
    };
    return {
      models: facet((log) => log.model, 500), providers: facet((log) => log.provider, 20), statuses: facet((log) => gatewayLogStatusCategory(log), 5),
      accounts: facet((log) => log.accountId, 1000), apiKeys: facet((log) => log.apiKeyId, 1000), clients: facet((log) => log.clientName, 100)
    };
  }
  async aggregateRequestLogs(filter: GatewayRequestLogFilter, group: GatewayLogGroup, options: { limit?: number; orderBy?: "requests" | "costUsd" | "key" } = {}) {
    const names = this.searchNames();
    return aggregateLogs(this.logs.filter((log) => matchesLogFilter(log, filter, names)), group, options);
  }
  async usageSince(since: string) {
    const recent = this.logs.filter((log) => log.requestedAt >= since);
    const sum = (pick: (log: GatewayRequestLog) => number | null) => recent.reduce((total, log) => total + (pick(log) ?? 0), 0);
    return {
      requests: recent.length, errors: recent.filter((log) => log.status !== "success").length, inputTokens: sum((log) => log.inputTokens),
      outputTokens: sum((log) => log.outputTokens), costUsd: sum((log) => log.costUsd), compressionTokensSaved: sum((log) => log.compressionTokensSaved)
    };
  }
  async usageTotals(scope: { accountId?: string; apiKeyId?: string }) {
    const rows = this.logs.filter((log) => log.source !== "limit_warmup"
      && (scope.accountId ? log.accountId === scope.accountId : log.apiKeyId === (scope.apiKeyId ?? "")));
    const sum = (pick: (log: GatewayRequestLog) => number | null) => rows.reduce((total, log) => total + (pick(log) ?? 0), 0);
    return { requests: rows.length, inputTokens: sum((log) => log.inputTokens), cachedInputTokens: sum((log) => log.cachedInputTokens),
      outputTokens: sum((log) => log.outputTokens), costUsd: Math.round(sum((log) => log.costUsd) * 1e9) / 1e9 };
  }
  async requestLogsAfter(afterId: string | null, limit: number) {
    const after = Number(afterId ?? 0);
    return this.logs.filter((log) => Number(log.id) > after && log.source !== "limit_warmup")
      .sort((left, right) => Number(left.id) - Number(right.id)).slice(0, Math.max(1, Math.min(limit, 5000))).map((log) => ({ ...log }));
  }
  async claudeLogKeys(from: string, to: string) {
    return this.logs.filter((log) => log.provider === "CLAUDE" && log.requestedAt >= from && log.requestedAt <= to)
      .map((log) => ({ upstreamRequestId: this.upstreamRequestIds.get(log.id) ?? null, requestedAt: log.requestedAt, model: log.model,
        inputTokens: log.inputTokens, outputTokens: log.outputTokens }));
  }
  history: (GatewayUsageHistoryPoint & { accountId: string })[] = [];
  async usageHistory(accountId: string, since: string) {
    return this.history.filter((point) => point.accountId === accountId && point.recordedAt >= since)
      .map(({ accountId: _account, ...point }) => point).sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }
  warmups: GatewayWarmupRecord[] = [];
  async latestWarmups() {
    const latest = new Map<string, GatewayWarmupRecord>();
    for (const row of [...this.warmups].sort((a, b) => a.attemptedAt.localeCompare(b.attemptedAt) || a.id - b.id)) latest.set(row.accountId, row);
    return [...latest.values()].map((row) => ({ ...row }));
  }
  async claimWarmup(attempt: { accountId: string; window: "PRIMARY" | "SECONDARY"; resetAt: string; model: string | null; attemptedAt?: string }) {
    if (this.warmups.some((row) => row.accountId === attempt.accountId && row.window === attempt.window && row.resetAt === attempt.resetAt)) return null;
    const id = this.warmups.length + 1;
    this.warmups.push({ id, accountId: attempt.accountId, window: attempt.window, resetAt: attempt.resetAt, status: "PENDING", model: attempt.model,
      attemptedAt: attempt.attemptedAt ?? new Date().toISOString(), completedAt: null, errorCode: null, errorMessage: null });
    return id;
  }
  async finishWarmup(id: number, result: { status: "SUCCEEDED" | "FAILED" | "SKIPPED"; errorCode?: string | null; errorMessage?: string | null; model?: string | null }) {
    const row = this.warmups.find((item) => item.id === id);
    if (!row) return;
    Object.assign(row, { status: result.status, errorCode: result.errorCode ?? null, errorMessage: result.errorMessage ?? null,
      model: result.model ?? row.model, completedAt: new Date().toISOString() });
  }
  async ping() { return 0; }
  async requestStatsSince(since: string) {
    const recent = this.logs.filter((log) => log.requestedAt >= since);
    const sum = (pick: (log: GatewayRequestLog) => number | null) => recent.reduce((total, log) => total + (pick(log) ?? 0), 0);
    const counts = (pick: (log: GatewayRequestLog) => string) => {
      const map: Record<string, number> = {};
      for (const log of recent) map[pick(log)] = (map[pick(log)] ?? 0) + 1;
      return map;
    };
    const timing = (pick: (log: GatewayRequestLog) => number | null) => {
      const values = recent.map(pick).filter((value): value is number => value !== null);
      return values.length === 0 ? { count: 0, averageMs: 0, minMs: 0, maxMs: 0 }
        : { count: values.length, averageMs: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
          minMs: Math.min(...values), maxMs: Math.max(...values) };
    };
    return {
      total: recent.length, failed: recent.filter((log) => log.status !== "success").length,
      rateLimited: recent.filter((log) => ["rate_limit_exceeded", "usage_limit_reached", "rate_limit_error"].includes(log.errorCode ?? "")).length,
      cached: recent.filter((log) => (log.cachedInputTokens ?? 0) > 0).length, cacheCreationTokens: sum((log) => log.cacheCreationTokens),
      byProvider: counts((log) => log.provider), byModel: counts((log) => log.model),
      inputTokens: sum((log) => log.inputTokens), cachedInputTokens: sum((log) => log.cachedInputTokens), outputTokens: sum((log) => log.outputTokens),
      compressionTokensSaved: sum((log) => log.compressionTokensSaved), latency: timing((log) => log.latencyMs), ttfb: timing((log) => log.firstTokenMs)
    };
  }
  async usageReport(from: string, to: string) {
    const rows = this.logs.filter((log) => log.requestedAt.slice(0, 10) >= from && log.requestedAt.slice(0, 10) <= to);
    const group = (keyOf: (log: GatewayRequestLog) => string) => {
      const map = new Map<string, GatewayReportRowInput>();
      for (const log of rows) {
        const key = keyOf(log);
        const row = map.get(key) ?? { key, requests: 0, errors: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0, reasoningReported: 0, costUsd: 0, compressionTokensSaved: 0 };
        row.requests += 1;
        if (log.status !== "success") row.errors += 1;
        row.inputTokens += log.inputTokens ?? 0;
        row.cachedInputTokens += log.cachedInputTokens ?? 0;
        row.outputTokens += log.outputTokens ?? 0;
        row.reasoningTokens += log.reasoningTokens ?? 0;
        if (log.reasoningTokens !== null) row.reasoningReported += 1;
        row.costUsd += log.costUsd ?? 0;
        row.compressionTokensSaved += log.compressionTokensSaved ?? 0;
        map.set(key, row);
      }
      return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
    };
    return { days: group((log) => log.requestedAt.slice(0, 10)), models: group((log) => log.model), accounts: group((log) => log.accountId ?? "") };
  }
  compression: GatewayCompressionRow[] = [];
  async recordCompression(rows: GatewayCompressionRow[]) {
    for (const row of rows) {
      const hour = new Date(row.hour);
      hour.setUTCMinutes(0, 0, 0);
      const key = { ...row, hour: hour.toISOString() };
      const existing = this.compression.find((item) => item.hour === key.hour && item.mode === key.mode && item.provider === key.provider && item.strategy === key.strategy);
      if (!existing) { this.compression.push(key); continue; }
      for (const field of ["requests", "modifiedRequests", "blocks", "rejectedBlocks", "errorBlocks", "timedOut", "originalTokens", "compressedTokens", "overheadMs"] as const) {
        existing[field] += key[field];
      }
      existing.maxOverheadMs = Math.max(existing.maxOverheadMs, key.maxOverheadMs);
    }
  }
  async compressionSince(since: string) {
    const from = new Date(since);
    from.setUTCMinutes(0, 0, 0);
    return this.compression.filter((row) => row.hour >= from.toISOString()).map((row) => ({ ...row }))
      .sort((a, b) => a.hour.localeCompare(b.hour) || a.mode.localeCompare(b.mode) || a.strategy.localeCompare(b.strategy));
  }
  signals: GatewayCompressionSignalRow[] = [];
  async recordCompressionSignals(rows: GatewayCompressionSignalRow[]) {
    for (const row of rows) {
      const hour = new Date(row.hour);
      hour.setUTCMinutes(0, 0, 0);
      const key = { ...row, hour: hour.toISOString(), name: row.name.slice(0, 60) };
      const existing = this.signals.find((item) => item.hour === key.hour && item.mode === key.mode && item.provider === key.provider && item.kind === key.kind && item.name === key.name);
      if (!existing) { this.signals.push(key); continue; }
      existing.count += key.count;
      existing.value += key.value;
      existing.maxValue = Math.max(existing.maxValue, key.maxValue);
    }
  }
  async compressionSignalsSince(since: string) {
    const from = new Date(since);
    from.setUTCMinutes(0, 0, 0);
    return this.signals.filter((row) => row.hour >= from.toISOString()).map((row) => ({ ...row }))
      .sort((a, b) => a.hour.localeCompare(b.hour) || a.mode.localeCompare(b.mode) || a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  }
  savings: GatewaySavingsDailyRow[] = [];
  async savingsDaily(range: { from?: string; to?: string } = {}) {
    return this.savings.filter((row) => (!range.from || row.day >= range.from) && (!range.to || row.day <= range.to)).map((row) => ({ ...row }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
        || a.client.localeCompare(b.client) || a.project.localeCompare(b.project));
  }
  async pruneRequestLogs(before: string) {
    const kept = this.logs.filter((log) => log.requestedAt >= before);
    const removed = this.logs.length - kept.length;
    this.logs = kept;
    return removed;
  }
  speed: GatewaySpeedDefaults = { models: {}, updatedAt: null };
  async speedDefaults() { return { models: { ...this.speed.models }, updatedAt: this.speed.updatedAt }; }
  async setSpeedDefault(modelId: string, tier: GatewaySpeedTier) {
    const models = { ...this.speed.models };
    if (tier === "fast") models[modelId] = "fast"; else delete models[modelId];
    this.speed = { models, updatedAt: new Date().toISOString() };
    return this.speedDefaults();
  }
  sticky = new Map<string, GatewayStickyBinding>();
  async saveStickyBindings(rows: GatewayStickyBinding[]) {
    for (const row of rows) if (this.accounts.some((account) => account.id === row.accountId)) this.sticky.set(row.keyHash, { ...row });
  }
  async findStickyBinding(keyHash: string, nowIso: string) {
    const row = this.sticky.get(keyHash);
    return row && (row.expiresAt === null || row.expiresAt > nowIso) ? { ...row } : null;
  }
  async pruneStickyBindings(nowIso: string) {
    let removed = 0;
    for (const [key, row] of this.sticky) if (row.expiresAt !== null && row.expiresAt <= nowIso) { this.sticky.delete(key); removed += 1; }
    return removed;
  }
  async dispose() {}
}
