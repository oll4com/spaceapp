import { randomBytes } from "node:crypto";
import {
  gatewayAccountListSchema, gatewayApiKeyCreatedResponseSchema, gatewayApiKeyListSchema, gatewayRequestLogListSchema, gatewayRequestLogFacetsSchema,
  gatewayRequestLogSchema, gatewayCompressionStatsSchema, gatewayReportSchema, gatewaySettingsSchema, type GatewayCompressionStats, gatewayStatusSchema,
  gatewayClaudeApiKeyUseSchema, type GatewayClaudeApiKeyUse, gatewayAnthropicAdminStatusSchema, gatewayAnthropicBillingReportSchema,
  type GatewayAnthropicAdminStatus, type GatewayAnthropicBillingReport,
  type GatewayReport, type GatewayReportRow, type GatewayLostTokens, type GatewayAccount, type GatewayAccountDetail, type GatewayApiKey, type GatewayApiKeyCreateRequest,
  type GatewayApiKeyCreatedResponse, type GatewayApiKeyDetail, type GatewayDashboard, type GatewayDashboardRange, type GatewayHealth,
  type GatewayProvider, type GatewayApiKeyProvider, type GatewayRequestLog, type GatewayRequestLogFacets, type GatewayRequestLogFilter, type GatewayRequestLogList,
  type GatewaySettings, type GatewaySettingsUpdateRequest, type GatewayStatus, gatewayApiKeyUpdateRequestSchema, gatewayAccountUpdateRequestSchema,
  type GatewayHeadroomHistory, type GatewayHeadroomLifetime, type GatewayHeadroomSession, type GatewayHistorySeries, isGatewayFreePlan, gatewayFreeKeyProviderOf,
  gatewayPoolModelsSchema, type GatewayPoolModels, type GatewayFreeLedger
} from "@space/contracts";
import type { z } from "zod";
import type { GatewayAccountRecord, GatewayApiKeyRecord, GatewayProjectDayUsage, GatewayReportRowInput, GatewayRepository, GatewaySavingsDailyRow, GatewayUsageHistoryPoint } from "@space/db";
import { readFile } from "node:fs/promises";
import { loadFreeLedger } from "./free-ledger.js";
import { createPaceDayStarts } from "@space/db";
import { anthropicAdminStatus, anthropicBillingReport, createApiBudgetPacer, generateGatewayApiKey, lanAccessFromSettings } from "@space/gateway";
import { discoverAntigravityProfiles, extractEmailFromIdToken, type AntigravityProfileLocation } from "../antigravity-usage-services.js";
import {
  buildAccountDetail, buildApiKeyDetail, buildGatewayDashboard, defaultHealthProbes, GatewayHealthSampler, requestLogCsv, type GatewayHealthProbes
} from "./gateway-stats.js";
import { weeklyLostTokens } from "./lost-tokens.js";
import { buildHeadroomHistory, buildHeadroomLifetime, buildHeadroomSession, historyCsv } from "./gateway-headroom.js";
import { SPACE_INSTALL_ROOT } from "@space/contracts";

export type GatewayApiKeyUpdate = z.output<typeof gatewayApiKeyUpdateRequestSchema>;
export type GatewayAccountUpdate = z.output<typeof gatewayAccountUpdateRequestSchema>;

export interface GatewayRequestLogQuery {
  limit: number;
  cursor?: string | null;
  accountId?: string | null;
  apiKeyId?: string | null;
  filter?: GatewayRequestLogFilter;
}

/**
 * Operator 7/11 10:53 BKK (nous_msg:c1272a0c, «… να μπαίνουν απευθείας στο spaceapp gateway χωρίς να σε ρωτήσω»): a free or granted provider's
 * key saved in the Vault joins its Space Gateway key pool at once, asking no one. The gateway's own check refuses a key that is not that
 * provider's; the same key twice stays one account. The log names the provider and the answer's code, never the key or the provider's text.
 */
export function gatewayKeyJoiner(service: Pick<GatewayAdminService, "addOpenAiApiKey">, log: { info(fields: object, message: string): void; warn(fields: object, message: string): void }) {
  return (owner: string, key: { label: string; value: string }): void => {
    // The Vault save already happened and never fails for the gateway's sake.
    void (async () => {
      const provider = gatewayFreeKeyProviderOf(key.label);
      if (!provider) return;
      const result = await service.addOpenAiApiKey({ provider, apiKey: key.value, label: key.label.trim().slice(0, 80) }).catch(() => null);
      if (!result) return log.warn({ owner, provider }, "Vault key could not reach Space Gateway.");
      const code = (result.body as { error?: { code?: unknown } } | null)?.error?.code;
      log[result.status < 300 ? "info" : "warn"]({ owner, provider, status: result.status, ...(code ? { code: String(code) } : {}) }, "Vault key offered to Space Gateway.");
    })().catch(() => log.warn({ owner }, "Vault key was not offered to Space Gateway."));
  };
}

/**
 * The same join for keys the Vault already held (7/11: Inception's and SiliconFlow's keys were saved before their pools could take them, and
 * the joiner runs only on a save, so they never joined): every kept key whose label names a free provider and that is no account yet is
 * offered once more. Run at start and every six hours; a key the gateway refuses is tried again only on the next run.
 */
export function gatewayVaultKeyReconciler(service: Pick<GatewayAdminService, "addOpenAiApiKey" | "apiKeyKnown">, log: { info(fields: object, message: string): void; warn(fields: object, message: string): void }) {
  return async (keys: Array<{ owner: string; id: string; label: string; value: string }>): Promise<{ offered: number; joined: number }> => {
    let offered = 0;
    let joined = 0;
    for (const key of keys) {
      const provider = gatewayFreeKeyProviderOf(key.label);
      if (!provider) continue;
      const known = await service.apiKeyKnown(provider, key.value).catch(() => null);
      if (known !== false) continue;
      offered++;
      const result = await service.addOpenAiApiKey({ provider, apiKey: key.value, label: key.label.trim().slice(0, 80) }).catch(() => null);
      const code = (result?.body as { error?: { code?: unknown } } | null)?.error?.code;
      if (result && result.status < 300) joined++;
      log[result && result.status < 300 ? "info" : "warn"]({ owner: key.owner, vaultKeyId: key.id, provider, status: result?.status ?? 0, ...(code ? { code: String(code) } : {}) },
        "Vault key reconciled with Space Gateway.");
    }
    return { offered, joined };
  };
}

export interface GatewayAdminService {
  /** Whether this provider key is already a gateway account (by its hash; nothing reaches the provider); null when the gateway cannot say. */
  apiKeyKnown(provider: GatewayApiKeyProvider, apiKey: string): Promise<boolean | null>;
  status(): Promise<GatewayStatus>;
  /** True when the gateway answers and has at least one ACTIVE account of the provider (cheap: no usage totals). */
  serves(provider: GatewayProvider): Promise<boolean>;
  listAccounts(): Promise<{ data: GatewayAccount[] }>;
  setAccountPaused(accountId: string, paused: boolean): Promise<GatewayAccount | null>;
  listApiKeys(): Promise<{ data: GatewayApiKey[] }>;
  createApiKey(input: GatewayApiKeyCreateRequest, actorUserId: string | null): Promise<GatewayApiKeyCreatedResponse>;
  updateApiKey(keyId: string, patch: GatewayApiKeyUpdate): Promise<GatewayApiKey | null>;
  /** A new secret for a key; the plain key is returned once. Settings, limits and usage stay. */
  regenerateApiKey(keyId: string): Promise<GatewayApiKeyCreatedResponse | null>;
  deleteApiKey(keyId: string): Promise<boolean>;
  listRequestLogs(query: GatewayRequestLogQuery): Promise<GatewayRequestLogList>;
  requestLog(id: string): Promise<GatewayRequestLog | null>;
  requestLogFacets(range: { from?: string; to?: string }): Promise<GatewayRequestLogFacets>;
  /** Up to 10,000 matching request logs as CSV, newest first. */
  requestLogCsv(filter: GatewayRequestLogFilter): Promise<string>;
  dashboard(range: GatewayDashboardRange): Promise<GatewayDashboard>;
  health(): Promise<GatewayHealth>;
  /** The Claude API key account and what went through it, for the "never used without reason" check. */
  claudeApiKeyUse(): Promise<GatewayClaudeApiKeyUse>;
  /** The sealed Anthropic Admin API key's hint and last sync (never the key). */
  anthropicAdminStatus(): Promise<GatewayAnthropicAdminStatus>;
  /** The last `days` UTC days of Anthropic's bill next to the gateway's estimate. */
  anthropicBilling(days: number): Promise<GatewayAnthropicBillingReport>;
  accountDetail(accountId: string): Promise<GatewayAccountDetail | null>;
  /** Pause or resume, alias and warm-up opt-in. */
  updateAccount(accountId: string, patch: GatewayAccountUpdate): Promise<GatewayAccount | null>;
  apiKeyDetail(keyId: string): Promise<GatewayApiKeyDetail | null>;
  /** Headroom views: since the gateway worker started, lifetime, and by day/week/month. */
  headroomSession(): Promise<GatewayHeadroomSession>;
  headroomLifetime(): Promise<GatewayHeadroomLifetime>;
  headroomHistory(): Promise<GatewayHeadroomHistory>;
  headroomHistoryCsv(series: GatewayHistorySeries): Promise<string>;
  getSettings(): Promise<GatewaySettings>;
  updateSettings(patch: GatewaySettingsUpdateRequest): Promise<GatewaySettings>;
  deleteAccount(accountId: string): Promise<boolean>;
  /** Every statistic between two UTC dates: rollups by day, model, account and provider, 429s, fallbacks, windows and lost tokens. */
  report(from: string, to: string): Promise<GatewayReport>;
  /** Weekly lost tokens of the resets between two UTC dates (weeklyLostTokens). */
  lostTokens(from: string, to: string): Promise<GatewayLostTokens>;
  /** Nous's daily token table (plan clipboard:ctqx7SPqkWR2 step 6): the daily rollups by project from a UTC day, and each subscription account's 5-hour samples since a time. */
  tokenReview(fromDay: string, since: string): Promise<{ projects: GatewaySavingsDailyRow[]; accounts: Array<{ label: string; provider: string; fiveHour: GatewayUsageHistoryPoint[] }> }>;
  /** Token usage by process (plan clipboard:qH5emwVaV6yO): request logs in [since, until) by day in `timeZone`, project, provider and account (`minutesOf`: one project by UTC minute). */
  projectUsage(since: string, until: string, timeZone: string, minutesOf?: string): Promise<GatewayProjectDayUsage[]>;
  compressionStats(hours: number): Promise<GatewayCompressionStats>;
  /** Calls a gateway admin endpoint (loopback, internal token). Credentials stay inside the gateway. */
  gatewayAdmin(path: string, body?: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  /** Space Antigravity profiles that are signed in, and whether their account is already in Space Gateway. */
  antigravityProfiles(): Promise<{ data: Array<{ profileId: string; email: string | null; inGateway: boolean }> }>;
  /** Hands a profile's Antigravity sign-in to the gateway (Google refresh tokens do not rotate, so the profile keeps working). */
  importAntigravityProfile(profileId: string): Promise<{ status: number; body: unknown }>;
  /** Adds an OpenAI API key account: a pasted key, or the server's Space OpenAI key file. */
  /** OpenAI, OpenRouter or DeepSeek API keys (OpenAI may use this server's key). */
  addOpenAiApiKey(input: { provider?: GatewayApiKeyProvider; apiKey?: string; useSpaceKey?: boolean; label?: string }): Promise<{ status: number; body: unknown }>;
  /** Every key pool's supported models (the gateway lists them live); kept until a key is added or `fresh` (an account's usage refresh). */
  poolModels(fresh?: boolean): Promise<GatewayPoolModels>;
  /** The free-token ledger: per free or granted pool what was granted, spent and is left (free-ledger.ts). */
  freeLedger(): Promise<GatewayFreeLedger>;
}

export class GatewayAccountNotFoundError extends Error {}
/** A key change that contradicts itself (an enforced model outside the allowed models). */
export class GatewayKeyPolicyError extends Error {}
/** Settings the gateway could not apply (LAN access outside the private ranges, ...). */
export class GatewaySettingsError extends Error {}
/** A free-plan account stays paused: the gateway never sends it traffic (operator rule 2026-10-13). */
export class GatewayAccountFreePlanError extends Error {
  constructor() { super("Free plan accounts stay paused. Sign in again on a paid plan, then resume."); }
}

/** Strips the encrypted credential envelope and the key hash before anything leaves the API. */
function publicAccount(record: GatewayAccountRecord): GatewayAccount {
  const { externalAccountId: _external, credentialsEncrypted: _credentials, credentialsExpiresAt: _expires, source: _source,
    sourceRef: _sourceRef, blockedUntil: _blocked, ...account } = record;
  return account;
}

function publicKey(record: GatewayApiKeyRecord): GatewayApiKey {
  const { keyHash: _hash, ...key } = record;
  return key;
}

function nextReset(window: "DAILY" | "WEEKLY" | "MONTHLY", now: Date): string {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (window === "DAILY") next.setUTCDate(next.getUTCDate() + 1);
  else if (window === "WEEKLY") next.setUTCDate(next.getUTCDate() + 7);
  else next.setUTCMonth(next.getUTCMonth() + 1, 1);
  return next.toISOString();
}

export function createGatewayAdminService(options: {
  repository: GatewayRepository;
  gatewayUrl: string;
  internalToken?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  statusTimeoutMs?: number;
  antigravityProfileSource?: { list(): Promise<AntigravityProfileLocation[]>; read(path: string): Promise<string> };
  /** The server's own OpenAI API key (the one Space uses for voice). */
  spaceOpenAiKeyFile?: string;
  /** The Claude API key the "api" pane profile bills (the Space installation key). */
  spaceClaudeKeyFile?: string;
  /** The OpenRouter and DeepSeek keys SpaceApp already holds (API providers card, voice), offered to their key pools. */
  spaceKeyFiles?: Partial<Record<"OPENROUTER" | "DEEPSEEK", string>>;
  healthProbes?: GatewayHealthProbes;
}): GatewayAdminService {
  const { repository } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const paceDayStarts = createPaceDayStarts(repository);
  let lastStatusBody: { lanListen?: unknown; inFlightByAccount?: unknown; startedAt?: unknown; inFlightRequests?: unknown; activeWebSockets?: unknown;
    relayTasks?: unknown; compressionQueue?: unknown } | null = null;
  const sampler = new GatewayHealthSampler({
    repository, now: () => now().getTime(),
    probes: options.healthProbes ?? defaultHealthProbes({ gatewayUrl: options.gatewayUrl, fetchImpl, lanListen: async () => {
      await serviceState();
      return typeof lastStatusBody?.lanListen === "string" ? lastStatusBody.lanListen : null;
    } })
  });
  // The Claude API-key account's pace to the monthly budget, as the proxy computes it (cached a minute).
  const apiBudget = createApiBudgetPacer({ repository, settings: () => repository.getSettings(), now: () => now().getTime() });
  const dashboardCache = new Map<GatewayDashboardRange, { at: number; value: Promise<GatewayDashboard> }>();
  const knownAccount = async (accountId: string) => (await repository.listAccounts()).find((account) => account.id === accountId) ?? null;
  const knownKey = async (keyId: string) => (await repository.listApiKeys()).find((key) => key.id === keyId) ?? null;

  const profileSource = options.antigravityProfileSource ?? { list: () => discoverAntigravityProfiles(), read: (path: string) => readFile(path, "utf8") };

  /** Profiles with a readable sign-in file; the file contents never leave the API except to the gateway. */
  async function signedInAntigravityProfiles() {
    const found: Array<{ profileId: string; email: string | null; tokenJson: string }> = [];
    for (const location of await profileSource.list().catch(() => [])) {
      const tokenJson = await profileSource.read(location.tokenPath).catch(() => null);
      if (!tokenJson) continue;
      let email: string | null = null;
      try {
        const parsed = JSON.parse(tokenJson) as { id_token?: string; id_token_email?: string };
        email = extractEmailFromIdToken(parsed.id_token, parsed.id_token_email);
      } catch { continue; }
      found.push({ profileId: location.profileId, email, tokenJson });
    }
    return found;
  }

  async function recheckFreePlanAccount(account: GatewayAccountRecord | null): Promise<GatewayAccountRecord | null> {
    if (!account || !isGatewayFreePlan(account.planType)) return account;
    await gatewayAdmin(`/__space-gateway/admin/accounts/${account.id}/test`);
    return knownAccount(account.id);
  }

  let poolModels: Promise<GatewayPoolModels> | null = null;
  async function gatewayAdmin(path: string, body: Record<string, unknown> = {}): Promise<{ status: number; body: unknown }> {
    if (!options.internalToken) {
      return { status: 503, body: { error: { code: "gateway_admin_unavailable", message: "SPACE_INTERNAL_API_TOKEN is not configured." } } };
    }
    try {
      const response = await fetchImpl(`${options.gatewayUrl}${path}`, {
        method: "POST", signal: AbortSignal.timeout(45_000), body: JSON.stringify(body),
        headers: { "content-type": "application/json", "x-space-internal-token": options.internalToken }
      });
      const text = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = { error: { code: "gateway_invalid_response", message: "Space Gateway returned an invalid response." } }; }
      return { status: response.status, body: parsed };
    } catch {
      return { status: 503, body: { error: { code: "gateway_unreachable", message: "Space Gateway is not running." } } };
    }
  }

  async function serviceState(): Promise<GatewayStatus["service"]> {
    try {
      const response = await fetchImpl(`${options.gatewayUrl}/__space-gateway/status`, {
        signal: AbortSignal.timeout(options.statusTimeoutMs ?? 1500)
      });
      if (!response.ok) {
        return { state: "UNREACHABLE", version: null, startedAt: null, inFlightRequests: null, listen: null, error: `Status check returned HTTP ${response.status}.` };
      }
      const body = await response.json() as {
        version?: unknown; startedAt?: unknown; inFlightRequests?: unknown; draining?: unknown; listen?: unknown; lanListen?: unknown; inFlightByAccount?: unknown;
      };
      lastStatusBody = body;
      const listen = typeof body.listen === "string" ? body.listen : null;
      const lanListen = typeof body.lanListen === "string" ? `LAN ${body.lanListen}` : null;
      return {
        state: body.draining === true ? "DRAINING" : "RUNNING",
        version: typeof body.version === "string" ? body.version.slice(0, 80) : null,
        startedAt: typeof body.startedAt === "string" ? body.startedAt.slice(0, 40) : null,
        inFlightRequests: typeof body.inFlightRequests === "number" ? Math.max(0, Math.trunc(body.inFlightRequests)) : null,
        listen: listen === null && lanListen === null ? null : [listen, lanListen].filter(Boolean).join(", ").slice(0, 120),
        error: null
      };
    } catch (error) {
      const refused = error instanceof Error && /ECONNREFUSED/.test(String((error as { cause?: unknown }).cause ?? error.message));
      return {
        state: refused ? "NOT_INSTALLED" : "UNREACHABLE", version: null, startedAt: null, inFlightRequests: null, listen: null,
        error: refused ? "Space Gateway is not running." : "Space Gateway did not answer the status check."
      };
    }
  }

  const lostTokens = async (from: string, to: string) => {
    // The 7 days before the first reset's day measure its rate.
    const usageFrom = new Date(Date.parse(`${from}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10);
    const [accounts, peaks, usage] = await Promise.all([repository.listAccounts(), repository.weeklyPeaks(from, to), repository.accountDailyUsage(usageFrom, to)]);
    return weeklyLostTokens({ from, to, now: now().getTime(), accounts, peaks, usage });
  };

  return {
    async status() {
      const [service, accounts, keys, usage, settings] = await Promise.all([
        serviceState(), repository.listAccounts(), repository.listApiKeys(),
        repository.usageSince(new Date(now().getTime() - 86_400_000).toISOString()), repository.getSettings()
      ]);
      const providers = new Map<GatewayProvider, { total: number; active: number }>();
      for (const account of accounts) {
        const entry = providers.get(account.provider) ?? { total: 0, active: 0 };
        entry.total += 1;
        if (account.status === "ACTIVE") entry.active += 1;
        providers.set(account.provider, entry);
      }
      return gatewayStatusSchema.parse({
        service,
        accounts: {
          total: accounts.length,
          active: accounts.filter((account) => account.status === "ACTIVE").length,
          byProvider: [...providers].map(([provider, counts]) => ({ provider, ...counts }))
        },
        apiKeys: { total: keys.length, active: keys.filter((key) => key.isActive).length },
        last24h: usage,
        settings,
        apiBudget: await apiBudget.read().catch(() => null),
        checkedAt: now().toISOString()
      });
    },

    async serves(provider) {
      const accounts = await repository.listAccounts();
      if (!accounts.some((account) => account.provider === provider && account.status === "ACTIVE")) return false;
      return (await serviceState()).state === "RUNNING";
    },

    async listAccounts() {
      const [accounts, checks] = await Promise.all([repository.listAccounts(), repository.listModelChecks().catch(() => [])]);
      const dead = checks.filter((check) => check.dead);
      const starts = await paceDayStarts(accounts, now().getTime());
      return gatewayAccountListSchema.parse({ data: accounts.map((record) => {
        const hidden = dead.filter((check) => check.provider === record.provider)
          .map((check) => ({ model: check.model, status: check.status, reason: check.reason, since: check.deadSince }));
        const start = starts.get(record.id);
        return { ...publicAccount(record), ...(hidden.length ? { hiddenModels: hidden } : {}), ...(start ? { paceDayStart: start } : {}) };
      }) });
    },

    async anthropicAdminStatus() {
      return gatewayAnthropicAdminStatusSchema.parse(anthropicAdminStatus(await repository.getAnthropicAdmin()));
    },

    async anthropicBilling(days) {
      return gatewayAnthropicBillingReportSchema.parse(await anthropicBillingReport(repository, days, now().getTime()));
    },

    async claudeApiKeyUse() {
      const [accounts, settings] = await Promise.all([repository.listAccounts(), repository.getSettings()]);
      const key = accounts.find((account) => account.provider === "CLAUDE" && account.source === "API_KEY"
        && account.status !== "PAUSED" && account.status !== "DEACTIVATED") ?? null;
      const totals = key ? await repository.usageTotals({ accountId: key.id }) : null;
      return gatewayClaudeApiKeyUseSchema.parse({
        fallbackEnabled: settings.claudeApiKeyFallback,
        account: key && totals ? { id: key.id, label: key.alias ?? key.label, status: key.status, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt,
          requests: totals.requests, costUsd: totals.costUsd } : null,
        checkedAt: now().toISOString()
      });
    },

    async setAccountPaused(accountId, paused) {
      if (!paused && isGatewayFreePlan((await recheckFreePlanAccount(await knownAccount(accountId)))?.planType)) throw new GatewayAccountFreePlanError();
      const updated = await repository.setAccountStatus(accountId, paused ? "PAUSED" : "ACTIVE", paused ? "Paused by an administrator." : null);
      return updated ? publicAccount(updated) : null;
    },

    async listApiKeys() {
      return gatewayApiKeyListSchema.parse({ data: (await repository.listApiKeys()).map(publicKey) });
    },

    async createApiKey(input, actorUserId) {
      const known = new Set((await repository.listAccounts()).map((account) => account.id));
      const unknown = input.accountIds.find((accountId) => !known.has(accountId));
      if (unknown) throw new GatewayAccountNotFoundError("One of the selected accounts no longer exists.");
      const generated = generateGatewayApiKey();
      const current = now();
      const record = await repository.createApiKey({
        keyId: `gw_key:${randomBytes(16).toString("hex")}`,
        name: input.name,
        keyHash: generated.keyHash,
        keyPrefix: generated.keyPrefix,
        trafficClass: input.trafficClass,
        allowedModels: input.allowedModels,
        enforcedModel: input.enforcedModel,
        allowedReasoningEfforts: input.allowedReasoningEfforts,
        enforcedReasoningEffort: input.enforcedReasoningEffort,
        accountIds: input.accountIds,
        compressionOverride: input.compressionOverride,
        outputPolicyOverride: input.outputPolicyOverride,
        limits: input.limits.map((limit) => ({ ...limit, resetAt: nextReset(limit.limitWindow, current) })),
        expiresAt: input.expiresAt,
        createdBy: actorUserId
      });
      return gatewayApiKeyCreatedResponseSchema.parse({ key: publicKey(record), plainKey: generated.plainKey });
    },

    async updateApiKey(keyId, patch) {
      const current = await knownKey(keyId);
      if (!current) return null;
      if (patch.accountIds) {
        const known = new Set((await repository.listAccounts()).map((account) => account.id));
        if (patch.accountIds.some((accountId) => !known.has(accountId))) throw new GatewayAccountNotFoundError("One of the selected accounts no longer exists.");
      }
      const allowed = patch.allowedModels ?? current.allowedModels;
      const enforced = patch.enforcedModel !== undefined ? patch.enforcedModel : current.enforcedModel;
      if (enforced && allowed.length > 0 && !allowed.includes(enforced)) throw new GatewayKeyPolicyError("The enforced model must be one of the allowed models.");
      const efforts = patch.allowedReasoningEfforts ?? current.allowedReasoningEfforts;
      const enforcedEffort = patch.enforcedReasoningEffort !== undefined ? patch.enforcedReasoningEffort : current.enforcedReasoningEffort;
      if (enforcedEffort && efforts.length > 0 && !efforts.includes(enforcedEffort)) {
        throw new GatewayKeyPolicyError("The enforced reasoning effort must be one of the allowed efforts.");
      }
      const at = now();
      const { limits, ...rest } = patch;
      const updated = await repository.updateApiKey(keyId, {
        ...rest,
        ...(limits ? { limits: limits.map((limit) => ({ ...limit, modelFilter: limit.modelFilter ?? null, resetAt: nextReset(limit.limitWindow, at) })) } : {})
      });
      return updated ? publicKey(updated) : null;
    },

    async regenerateApiKey(keyId) {
      const generated = generateGatewayApiKey();
      const updated = await repository.regenerateApiKey(keyId, { keyHash: generated.keyHash, keyPrefix: generated.keyPrefix });
      return updated ? gatewayApiKeyCreatedResponseSchema.parse({ key: publicKey(updated), plainKey: generated.plainKey }) : null;
    },

    deleteApiKey: (keyId) => repository.deleteApiKey(keyId),

    async listRequestLogs(query) {
      const beforeId = query.cursor && /^\d{1,19}$/.test(query.cursor) ? Number(query.cursor) : null;
      const limit = Math.max(1, Math.min(query.limit, 200));
      const rows = await repository.listRequestLogs({ limit: limit + 1, beforeId, accountId: query.accountId, apiKeyId: query.apiKeyId, filter: query.filter });
      const data = rows.slice(0, limit);
      return gatewayRequestLogListSchema.parse({ data, nextCursor: rows.length > limit ? data[data.length - 1]!.id : null });
    },

    async requestLog(id) {
      const row = await repository.getRequestLog(id);
      return row ? gatewayRequestLogSchema.parse(row) : null;
    },

    async requestLogFacets(range) {
      return gatewayRequestLogFacetsSchema.parse(await repository.requestLogFacets(range));
    },

    async requestLogCsv(filter) {
      const rows: GatewayRequestLog[] = [];
      let beforeId: number | null = null;
      // Technical: the file is built in the API's memory; 10,000 rows a file, a narrower range or filter exports older ones.
      while (rows.length < 10_000) {
        const page = await repository.listRequestLogs({ limit: 500, beforeId, filter });
        rows.push(...page);
        if (page.length < 500) break;
        beforeId = Number(page[page.length - 1]!.id);
      }
      const [accounts, keys] = await Promise.all([repository.listAccounts(), repository.listApiKeys()]);
      const accountNames = new Map(accounts.map((account) => [account.id, account.alias ?? account.label]));
      const keyNames = new Map(keys.map((key) => [key.id, key.name]));
      return requestLogCsv(rows.slice(0, 10_000), {
        account: (id) => (id ? accountNames.get(id) ?? "Removed account" : ""),
        key: (id) => (id ? keyNames.get(id) ?? "Removed key" : "")
      });
    },

    async dashboard(range) {
      const at = now().getTime();
      const cached = dashboardCache.get(range);
      if (cached && at - cached.at < 10_000) return cached.value;
      const value = (async () => {
        const [accounts, keys] = await Promise.all([repository.listAccounts(), repository.listApiKeys(), serviceState()]);
        const inFlight = lastStatusBody?.inFlightByAccount;
        const inFlightByAccount = inFlight && typeof inFlight === "object" && !Array.isArray(inFlight)
          ? Object.fromEntries(Object.entries(inFlight as Record<string, unknown>).filter(([, count]) => typeof count === "number").map(([id, count]) => [id, Math.max(0, Math.trunc(count as number))]))
          : null;
        return buildGatewayDashboard({ repository, range, accounts: accounts.map(publicAccount), keys: keys.map(publicKey), live: { inFlightByAccount }, now: at });
      })();
      dashboardCache.set(range, { at, value });
      value.catch(() => dashboardCache.delete(range));
      return value;
    },

    health: () => sampler.snapshot(),

    async accountDetail(accountId) {
      const account = await knownAccount(accountId);
      if (!account) return null;
      const result = await gatewayAdmin(`/__space-gateway/admin/accounts/${accountId}/token-status`);
      const body = result.body as { accessExpiresAt?: unknown; refreshStored?: unknown; idTokenParsed?: unknown } | null;
      const tokenStatus = result.status === 200 && body ? {
        accessExpiresAt: typeof body.accessExpiresAt === "string" ? body.accessExpiresAt : null,
        refreshStored: typeof body.refreshStored === "boolean" ? body.refreshStored : null,
        idTokenParsed: typeof body.idTokenParsed === "boolean" ? body.idTokenParsed : null
      } : null;
      const { credentialsEncrypted: _credentials, externalAccountId: _external, sourceRef: _sourceRef, blockedUntil: _blocked, ...rest } = account;
      return buildAccountDetail({ repository, account: rest, tokenStatus, now: now().getTime() });
    },

    async updateAccount(accountId, patch) {
      let record: GatewayAccountRecord | null = await knownAccount(accountId);
      if (!record) return null;
      if (patch.paused === false) {
        record = await recheckFreePlanAccount(record);
        if (!record) return null;
        if (isGatewayFreePlan(record.planType)) throw new GatewayAccountFreePlanError();
      }
      if (patch.alias !== undefined || patch.warmupEnabled !== undefined) {
        record = await repository.updateAccountPreferences(accountId, { alias: patch.alias, warmupEnabled: patch.warmupEnabled });
      }
      if (record && patch.paused !== undefined) {
        record = await repository.setAccountStatus(accountId, patch.paused ? "PAUSED" : "ACTIVE", patch.paused ? "Paused by an administrator." : null);
      }
      return record ? publicAccount(record) : null;
    },

    async headroomSession() {
      const [service, accounts, settings] = await Promise.all([serviceState(), repository.listAccounts(), repository.getSettings()]);
      const body = service.state === "RUNNING" || service.state === "DRAINING" ? lastStatusBody : null;
      const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
      return buildHeadroomSession({
        repository, startedAt: service.startedAt, compressionMode: settings.compressionMode, accounts: accounts.map(publicAccount), now: now().getTime(),
        live: body ? { activeRequests: number(body.inFlightRequests), activeWebSockets: number(body.activeWebSockets), relayTasks: number(body.relayTasks),
          compressionQueue: number(body.compressionQueue) } : null
      });
    },

    headroomLifetime: () => buildHeadroomLifetime({ repository, now: now().getTime() }),

    async headroomHistory() {
      return buildHeadroomHistory({ repository, retentionDays: (await repository.getSettings()).requestLogRetentionDays, now: now().getTime() });
    },

    async headroomHistoryCsv(series) {
      return historyCsv(await buildHeadroomHistory({ repository, retentionDays: (await repository.getSettings()).requestLogRetentionDays, now: now().getTime() }), series);
    },

    async apiKeyDetail(keyId) {
      const key = await knownKey(keyId);
      if (!key) return null;
      return buildApiKeyDetail({ repository, key: publicKey(key), accounts: (await repository.listAccounts()).map(publicAccount), now: now().getTime() });
    },

    deleteAccount: (accountId) => repository.deleteAccount(accountId),

    async compressionStats(hours) {
      const rows = await repository.compressionSince(new Date(now().getTime() - hours * 3_600_000).toISOString());
      const totals = (mode: "ON" | "SHADOW") => {
        const requestRows = rows.filter((row) => row.mode === mode && row.strategy === "");
        const blockRows = rows.filter((row) => row.mode === mode && row.strategy !== "");
        const sum = (list: typeof rows, pick: (row: (typeof rows)[number]) => number) => list.reduce((total, row) => total + pick(row), 0);
        const originalTokens = sum(requestRows, (row) => row.originalTokens);
        const compressedTokens = sum(requestRows, (row) => row.compressedTokens);
        const requests = sum(requestRows, (row) => row.requests);
        return {
          requests, modifiedRequests: sum(requestRows, (row) => row.modifiedRequests), blocks: sum(blockRows, (row) => row.blocks),
          rejectedBlocks: sum(blockRows, (row) => row.rejectedBlocks), errorBlocks: sum(blockRows, (row) => row.errorBlocks),
          timedOut: sum(requestRows, (row) => row.timedOut), originalTokens, compressedTokens, tokensSaved: Math.max(0, originalTokens - compressedTokens),
          savingsPercent: originalTokens > 0 ? Math.min(100, ((originalTokens - compressedTokens) / originalTokens) * 100) : 0,
          averageOverheadMs: requests > 0 ? sum(requestRows, (row) => row.overheadMs) / requests : 0,
          maxOverheadMs: requestRows.reduce((max, row) => Math.max(max, row.maxOverheadMs), 0)
        };
      };
      const strategies = new Map<string, { mode: "SHADOW" | "ON"; strategy: string; blocks: number; rejectedBlocks: number; errorBlocks: number; original: number; compressed: number }>();
      for (const row of rows.filter((item) => item.strategy !== "")) {
        const key = `${row.mode}:${row.strategy}`;
        const entry = strategies.get(key) ?? { mode: row.mode, strategy: row.strategy, blocks: 0, rejectedBlocks: 0, errorBlocks: 0, original: 0, compressed: 0 };
        entry.blocks += row.blocks; entry.rejectedBlocks += row.rejectedBlocks; entry.errorBlocks += row.errorBlocks;
        entry.original += row.originalTokens; entry.compressed += row.compressedTokens;
        strategies.set(key, entry);
      }
      const providers = new Map<string, { provider: string; requests: number; modifiedRequests: number; original: number; compressed: number }>();
      for (const row of rows.filter((item) => item.mode === "ON" && item.strategy === "")) {
        const entry = providers.get(row.provider) ?? { provider: row.provider, requests: 0, modifiedRequests: 0, original: 0, compressed: 0 };
        entry.requests += row.requests; entry.modifiedRequests += row.modifiedRequests;
        entry.original += row.originalTokens; entry.compressed += row.compressedTokens;
        providers.set(row.provider, entry);
      }
      const history = new Map<string, { hour: string; appliedSaved: number; shadowSaved: number; requests: number }>();
      for (const row of rows.filter((item) => item.strategy === "")) {
        const entry = history.get(row.hour) ?? { hour: row.hour, appliedSaved: 0, shadowSaved: 0, requests: 0 };
        const saved = Math.max(0, row.originalTokens - row.compressedTokens);
        if (row.mode === "ON") entry.appliedSaved += saved; else entry.shadowSaved += saved;
        entry.requests += row.requests;
        history.set(row.hour, entry);
      }
      return gatewayCompressionStatsSchema.parse({
        hours, applied: totals("ON"), shadow: totals("SHADOW"),
        byProvider: [...providers.values()].sort((left, right) => left.provider.localeCompare(right.provider)).map((entry) => ({ provider: entry.provider,
          requests: entry.requests, modifiedRequests: entry.modifiedRequests, originalTokens: entry.original, compressedTokens: entry.compressed,
          tokensSaved: Math.max(0, entry.original - entry.compressed),
          savingsPercent: entry.original > 0 ? Math.min(100, ((entry.original - entry.compressed) / entry.original) * 100) : 0 })),
        byStrategy: [...strategies.values()].map((entry) => ({ mode: entry.mode, strategy: entry.strategy, blocks: entry.blocks, rejectedBlocks: entry.rejectedBlocks,
          errorBlocks: entry.errorBlocks, tokensSaved: Math.max(0, entry.original - entry.compressed),
          savingsPercent: entry.original > 0 ? Math.min(100, ((entry.original - entry.compressed) / entry.original) * 100) : 0 })),
        history: [...history.values()]
      });
    },

    projectUsage: (since, until, timeZone, minutesOf) => repository.projectUsage(since, until, timeZone, minutesOf),

    async tokenReview(fromDay, since) {
      const accounts = (await repository.listAccounts()).filter((account) => (account.provider === "CLAUDE" || account.provider === "CODEX") && account.status !== "DEACTIVATED"
        && account.source !== "API_KEY");
      return { projects: await repository.savingsDaily({ from: fromDay }),
        accounts: await Promise.all(accounts.map(async (account) => ({ label: account.alias ?? account.label, provider: account.provider,
          fiveHour: (await repository.usageHistory(account.id, since)).filter((point) => point.window === "PRIMARY") }))) };
    },
    lostTokens,
    async report(from, to) {
      const [{ days, models, accounts, providers }, savings, fallbacks, records, lost] = await Promise.all([repository.usageReport(from, to),
        repository.savingsDaily({ from, to }), repository.providerFallbacks(from, to), repository.listAccounts(), lostTokens(from, to)]);
      const limited = (pick: (row: GatewaySavingsDailyRow) => string) => {
        const counts = new Map<string, number>();
        for (const row of savings) counts.set(pick(row), (counts.get(pick(row)) ?? 0) + row.rateLimited);
        return (row: GatewayReportRowInput) => ({ ...row, rateLimited: counts.get(row.key) ?? 0 });
      };
      const windows = records.flatMap((account) => [{ quotaKey: "", primary: account.primaryWindow, secondary: account.secondaryWindow },
        ...(account.quotaGroups ?? []).map((group) => ({ quotaKey: group.key, primary: group.primaryWindow, secondary: group.secondaryWindow }))]
        .filter((window) => window.primary.usedPercent !== null || window.secondary.usedPercent !== null)
        .map((window) => ({ accountId: account.id, label: account.alias ?? account.label, provider: account.provider, status: account.status, ...window })));
      const zero: GatewayReportRow = { key: "total", requests: 0, errors: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0,
        reasoningTokens: 0, reasoningReported: 0, costUsd: 0, compressionTokensSaved: 0, rateLimited: savings.reduce((sum, row) => sum + row.rateLimited, 0) };
      const totals = days.reduce<GatewayReportRow>((sum, row) => ({ ...sum,
        key: "total", requests: sum.requests + row.requests, errors: sum.errors + row.errors, inputTokens: sum.inputTokens + row.inputTokens,
        cachedInputTokens: sum.cachedInputTokens + row.cachedInputTokens, outputTokens: sum.outputTokens + row.outputTokens,
        reasoningTokens: sum.reasoningTokens + row.reasoningTokens, reasoningReported: sum.reasoningReported + row.reasoningReported,
        costUsd: sum.costUsd + row.costUsd, compressionTokensSaved: sum.compressionTokensSaved + row.compressionTokensSaved
      }), zero);
      return gatewayReportSchema.parse({ from, to, days: days.map(limited((row) => row.day)), models: models.map(limited((row) => row.model)), accounts,
        providers: providers.map(limited((row) => row.provider)), totals, fallbacks, windows, lost });
    },

    gatewayAdmin,

    async antigravityProfiles() {
      const profiles = await signedInAntigravityProfiles();
      const emails = new Set((await repository.listAccounts()).filter((account) => account.provider === "ANTIGRAVITY" && account.email)
        .map((account) => account.email!.toLowerCase()));
      return { data: profiles.map(({ profileId, email }) => ({ profileId, email, inGateway: Boolean(email && emails.has(email.toLowerCase())) })) };
    },

    async importAntigravityProfile(profileId) {
      const profile = (await signedInAntigravityProfiles()).find((item) => item.profileId === profileId);
      if (!profile) return { status: 404, body: { error: { code: "profile_not_found", message: "That Antigravity profile is not signed in." } } };
      return gatewayAdmin("/__space-gateway/admin/antigravity/import", { tokenJson: profile.tokenJson, sourceRef: profileId });
    },

    async apiKeyKnown(provider, apiKey) {
      const answer = await gatewayAdmin("/__space-gateway/admin/api-key/known", { provider, apiKey });
      return answer.status === 200 && typeof (answer.body as { known?: unknown } | null)?.known === "boolean" ? (answer.body as { known: boolean }).known : null;
    },

    async addOpenAiApiKey(input) {
      let apiKey = input.apiKey?.trim() ?? "";
      let sourceRef: string | undefined;
      const spaceKeys = {
        CLAUDE: [options.spaceClaudeKeyFile ?? `${SPACE_INSTALL_ROOT}/secrets/space-claude.key`, "space-claude", "Claude"],
        OPENAI_API: [options.spaceOpenAiKeyFile ?? `${SPACE_INSTALL_ROOT}/secrets/space-openai-voice.key`, "space-openai-voice", "OpenAI"],
        OPENROUTER: [options.spaceKeyFiles?.OPENROUTER ?? `${SPACE_INSTALL_ROOT}/secrets/space-openrouter.key`, "space-openrouter", "OpenRouter"],
        DEEPSEEK: [options.spaceKeyFiles?.DEEPSEEK ?? `${SPACE_INSTALL_ROOT}/secrets/space-deepseek.key`, "space-deepseek", "DeepSeek"]
      } as const;
      const spaceKey = input.useSpaceKey ? spaceKeys[(input.provider ?? "OPENAI_API") as keyof typeof spaceKeys] : undefined;
      if (input.useSpaceKey) {
        if (!spaceKey) return { status: 422, body: { error: { code: "space_key_missing", message: "This server holds no key of that provider for Space Gateway." } } };
        apiKey = (await readFile(spaceKey[0], "utf8").catch(() => "")).trim();
        if (!apiKey) return { status: 404, body: { error: { code: "space_key_missing", message: `This server has no readable Space ${spaceKey[2]} key.` } } };
        sourceRef = spaceKey[1];
      }
      const added = await gatewayAdmin("/__space-gateway/admin/api-key/add", { provider: input.provider ?? "OPENAI_API", apiKey, ...(input.label ? { label: input.label } : {}),
        ...(sourceRef ? { sourceRef } : {}) });
      if (added.status < 300) poolModels = null;
      return added;
    },

    async poolModels(fresh = false) {
      if (fresh || !poolModels) {
        poolModels = gatewayAdmin("/__space-gateway/admin/pool-models").then((result) => {
          if (result.status !== 200) throw new Error("Space Gateway could not list its pools' models.");
          return gatewayPoolModelsSchema.parse(result.body);
        });
      }
      const pending = poolModels;
      // A failed list is asked again next time.
      return pending.catch((error: unknown) => { if (poolModels === pending) poolModels = null; throw error; });
    },

    async freeLedger() { return loadFreeLedger(repository, () => this.poolModels()); },

    async getSettings() { return gatewaySettingsSchema.parse(await repository.getSettings()); },
    async updateSettings(patch) {
      if (patch.lanMode !== undefined || patch.lanHost !== undefined || patch.lanPort !== undefined || patch.lanAllowedSources !== undefined) {
        const merged = { ...(await repository.getSettings()), ...patch };
        const checked = lanAccessFromSettings(merged);
        if (checked.error) throw new GatewaySettingsError(checked.error);
      }
      const ordered = patch.planPriority ? [...new Set(patch.planPriority.map((plan) => plan.trim().toLowerCase()).filter(Boolean))] : undefined;
      return gatewaySettingsSchema.parse(await repository.updateSettings({ ...patch, ...(ordered ? { planPriority: ordered } : {}) }));
    }
  };
}
