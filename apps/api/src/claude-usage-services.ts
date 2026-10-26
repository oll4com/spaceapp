import { z } from "zod";
import {
  claudeUsageAccountListSchema,
  isoDateTimeSchema,
  type ClaudeGatewayPoolAccount,
  type ClaudeUsageAccount,
  type ClaudeUsageAccountList,
  type GatewayAnthropicBillingReport
} from "@space/contracts";
import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { ClaudeProfileUsage } from "./claude-usage.js";

const usageCacheTtlMs = 120_000;
const usageStaleFallbackMs = 10 * 60_000;
const percentSchema = z.number().min(0).max(100).nullable();
const timeSchema = isoDateTimeSchema.nullable();

// The wrapper's stdout is the only thing that crosses from the CLI owner into the API.
export const claudeProfileUsageSchema = z
  .object({
    status: z.enum(["CONNECTED", "IDLE", "NOT_CONNECTED", "EXPIRED", "API_KEY", "GATEWAY", "ERROR"]),
    email: z.string().email().nullable(),
    plan: z.string().max(120).nullable(),
    fiveHourUsedPercent: percentSchema,
    fiveHourResetAt: timeSchema,
    weeklyUsedPercent: percentSchema,
    weeklyResetAt: timeSchema,
    weeklyScope: z.string().max(60).nullable(),
    apiKeyVerified: z.boolean().nullable().optional()
  })
  .strict();

export interface ClaudeUsageProviderOptions {
  listProfiles: () => Promise<Array<{ profileId: string; displayName: string }>>;
  readUsage: (profileId: string) => Promise<ClaudeProfileUsage>;
  /** The Claude accounts Space Gateway holds: the gateway profile's pool, and the usage of an idle profile's account. */
  gatewayAccounts?: () => Promise<GatewayAccountRecord[]>;
  /** Space Gateway's settings: whether the Claude API key serves as its fallback, and the operator's monthly API budget. */
  gatewaySettings?: () => Promise<GatewayClaudeSettings>;
  /** This UTC month's Anthropic bill in USD from the Admin API key's reports; null without an admin key. */
  anthropicMonthUsd?: () => Promise<number | null>;
  /** Lifetime totals of one gateway account (the request log's daily rollups), for what went through the key. */
  gatewayAccountUsage?: (accountId: string) => Promise<{ requests: number; costUsd: number; lastRequest?: { at: string; succeeded: boolean } | null }>;
  now?: () => Date;
}

type ProfileUsage = z.infer<typeof claudeProfileUsageSchema>;
type GatewayClaudeSettings = { claudeApiKeyFallback: boolean; anthropicMonthlyBudgetUsd?: number | null };

/** Lifetime usage plus the latest request outcome; a recent failed request must not look like a working fallback. */
export async function claudeGatewayApiKeyUsage(repository: Pick<GatewayRepository, "usageTotals" | "listRequestLogs">, accountId: string, nowMs: number) {
  const [totals, logs] = await Promise.all([
    repository.usageTotals({ accountId }),
    repository.listRequestLogs({ limit: 1, accountId, filter: { from: new Date(nowMs - 5 * 60_000).toISOString() } }).catch(() => [])
  ]);
  const latest = logs[0];
  return { ...totals, lastRequest: latest ? { at: latest.requestedAt, succeeded: latest.status === "success" } : null };
}

/** This UTC month's bill in a billing report: Anthropic's posted days, Space Gateway's estimate for days not posted yet. */
export function anthropicMonthSpendUsd(report: GatewayAnthropicBillingReport, nowMs: number): number | null {
  if (!report.status.configured) return null;
  const month = new Date(nowMs).toISOString().slice(0, 7);
  return report.days.filter((day) => day.day.startsWith(month))
    .reduce((sum, day) => sum + (day.reported ? day.organizationUsd : day.gatewayEstimateUsd), 0);
}

/** A Claude account's two quota windows as the gateway last sampled them, in the profile reader's used-percent terms. */
export interface ClaudeGatewayAccountUsage {
  fiveHourUsedPercent: number | null;
  fiveHourResetAt: string | null;
  weeklyUsedPercent: number | null;
  weeklyResetAt: string | null;
}

function remaining(used: number | null): number | null {
  return used === null ? null : Math.round((100 - used) * 10) / 10;
}

// A quota window whose reset time has passed is full again.
function afterResets(usage: ProfileUsage, nowMs: number): ProfileUsage {
  const lapsed = (resetAt: string | null) => resetAt !== null && Date.parse(resetAt) <= nowMs;
  const fiveHour = lapsed(usage.fiveHourResetAt);
  const weekly = lapsed(usage.weeklyResetAt);
  return {
    ...usage,
    fiveHourUsedPercent: fiveHour ? 0 : usage.fiveHourUsedPercent,
    fiveHourResetAt: fiveHour ? null : usage.fiveHourResetAt,
    weeklyUsedPercent: weekly ? 0 : usage.weeklyUsedPercent,
    weeklyResetAt: weekly ? null : usage.weeklyResetAt,
    weeklyScope: weekly ? null : usage.weeklyScope
  };
}

const shortLabel = (label: string) => (label.includes("@") ? label.slice(0, label.indexOf("@")) || label : label).slice(0, 120);
const isoOrNull = (value: string | null) => (value && isoDateTimeSchema.safeParse(value).success ? value : null);
const usedOrNull = (value: number | null) => (value !== null && Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) : null);

const isClaudeApiKeyAccount = (account: GatewayAccountRecord) => account.provider === "CLAUDE" && account.source === "API_KEY";

// The Claude subscription accounts the gateway routes to and keeps sampling (its usage poller skips the same two
// states). The API-key fallback account has no quota windows and is not part of the pool.
const routedClaudeAccounts = (accounts: GatewayAccountRecord[]) =>
  accounts.filter((account) => account.provider === "CLAUDE" && !isClaudeApiKeyAccount(account)
    && account.status !== "PAUSED" && account.status !== "DEACTIVATED");

/** The gateway's Claude API key account that routing can fall back to, if any. */
export function claudeGatewayApiKeyAccount(accounts: GatewayAccountRecord[]): GatewayAccountRecord | null {
  return accounts.find((account) => isClaudeApiKeyAccount(account) && account.status !== "PAUSED" && account.status !== "DEACTIVATED") ?? null;
}

/** Whether Space Gateway uses a Claude API key when every pooled account is out of quota. */
export function claudeGatewayFallbackState(accounts: GatewayAccountRecord[], settings: { claudeApiKeyFallback: boolean }): "ON" | "OFF" | "NOT_ADDED" {
  return !claudeGatewayApiKeyAccount(accounts) ? "NOT_ADDED" : settings.claudeApiKeyFallback ? "ON" : "OFF";
}

/**
 * One gateway account's windows as the gateway holds them. A rate-limited account stays out of routing until its
 * blockedUntil, so it counts as used up until then even when its last usage sample says otherwise.
 */
function gatewayAccountUsage(account: GatewayAccountRecord, nowMs: number): ClaudeGatewayAccountUsage & { signInRequired: boolean } {
  const lapsed = (resetAt: string | null) => resetAt !== null && Date.parse(resetAt) <= nowMs;
  const window = (used: number | null, resetAt: string | null) => lapsed(resetAt)
    ? { used: 0, resetAt: null }
    : { used: usedOrNull(used), resetAt: isoOrNull(resetAt) };
  let fiveHour = window(account.primaryWindow.usedPercent, account.primaryWindow.resetAt);
  const weekly = window(account.secondaryWindow.usedPercent, account.secondaryWindow.resetAt);
  const blockedUntil = (account.status === "RATE_LIMITED" || account.status === "QUOTA_EXCEEDED")
    && account.blockedUntil && !lapsed(account.blockedUntil) ? isoOrNull(account.blockedUntil) : null;
  if (blockedUntil && (remaining(fiveHour.used) ?? 100) >= 1 && (remaining(weekly.used) ?? 100) >= 1) fiveHour = { used: 100, resetAt: blockedUntil };
  return {
    signInRequired: account.status === "REAUTH_REQUIRED",
    fiveHourUsedPercent: fiveHour.used,
    fiveHourResetAt: fiveHour.resetAt,
    weeklyUsedPercent: weekly.used,
    weeklyResetAt: weekly.resetAt
  };
}

/** The gateway's Claude accounts as the gateway holds them, for the gateway profile's pool. */
export function claudeGatewayPool(accounts: GatewayAccountRecord[], nowMs: number): ClaudeGatewayPoolAccount[] {
  return routedClaudeAccounts(accounts)
    .slice(0, 50)
    .map((account) => {
      const usage = gatewayAccountUsage(account, nowMs);
      return {
        label: shortLabel(account.alias ?? account.label),
        signInRequired: usage.signInRequired,
        fiveHourRemainingPercent: remaining(usage.fiveHourUsedPercent),
        fiveHourResetAt: usage.fiveHourResetAt,
        weeklyRemainingPercent: remaining(usage.weeklyUsedPercent),
        weeklyResetAt: usage.weeklyResetAt
      };
    });
}

/**
 * The gateway's sample of the Claude account a profile is signed in to, by email. Quota belongs to the account, not
 * to a sign-in: the gateway holds its own sign-in to the same account and samples its usage every few minutes, so a
 * profile whose token lapsed while no pane used it still shows the account's real quota. Null when the gateway does
 * not hold that account, needs to sign in to it again, or has no sample of it yet.
 */
export function claudeGatewayAccountUsage(accounts: GatewayAccountRecord[], email: string | null, nowMs: number): ClaudeGatewayAccountUsage | null {
  const wanted = email?.trim().toLowerCase();
  if (!wanted) return null;
  const account = routedClaudeAccounts(accounts).find((candidate) => (candidate.email ?? candidate.label).trim().toLowerCase() === wanted);
  if (!account) return null;
  const { signInRequired, ...usage } = gatewayAccountUsage(account, nowMs);
  if (signInRequired || (usage.fiveHourUsedPercent === null && usage.weeklyUsedPercent === null)) return null;
  return usage;
}

export function createClaudeUsageAccountProvider(
  options: ClaudeUsageProviderOptions
): () => Promise<ClaudeUsageAccountList> {
  const now = options.now ?? (() => new Date());
  let cached: { value: ClaudeUsageAccountList; collectedAtMs: number } | null = null;
  let inFlight: Promise<ClaudeUsageAccountList> | null = null;
  let collectFailed = false;
  const lastConnected = new Map<string, { usage: ProfileUsage; sampledAt: Date }>();

  // An idle account is still signed in, but its expired token cannot ask for usage. The gateway's sample of the
  // same account is current; failing that, the profile's last own sample is the best estimate until a pane uses
  // it again, so it keeps that sample's time.
  function resolveIdle(profileId: string, usage: ProfileUsage | null, held: ClaudeGatewayAccountUsage | null):
    { usage: ProfileUsage | null; sampledAt: Date | null } {
    const current = now();
    if (usage?.status === "CONNECTED") lastConnected.set(profileId, { usage, sampledAt: current });
    else if (usage && usage.status !== "IDLE" && usage.status !== "ERROR") lastConnected.delete(profileId);
    if (usage?.status !== "IDLE") return { usage, sampledAt: current };
    if (held) return { usage: { ...usage, ...held, weeklyScope: null, status: "CONNECTED" }, sampledAt: current };
    const last = lastConnected.get(profileId);
    if (!last) return { usage: { ...usage, status: "CONNECTED" }, sampledAt: null };
    return {
      usage: { ...afterResets(last.usage, current.getTime()), email: usage.email ?? last.usage.email, plan: usage.plan ?? last.usage.plan, status: "CONNECTED" },
      sampledAt: last.sampledAt
    };
  }

  async function account(profile: { profileId: string; displayName: string },
    gateway: () => Promise<GatewayAccountRecord[] | null>,
    gatewaySettings: () => Promise<GatewayClaudeSettings | null>): Promise<ClaudeUsageAccount> {
    const sampled = await options.readUsage(profile.profileId)
      .then((value) => claudeProfileUsageSchema.parse(value))
      .catch(() => null);
    const held = sampled?.status === "IDLE" ? claudeGatewayAccountUsage((await gateway()) ?? [], sampled.email, now().getTime()) : null;
    const { usage, sampledAt } = resolveIdle(profile.profileId, sampled, held);
    const status = usage?.status ?? "ERROR";
    const accounts = status === "GATEWAY" ? await gateway() : null;
    const pool = accounts ? claudeGatewayPool(accounts, now().getTime()) : null;
    // An API-key profile: whether the key works, whether the gateway falls back to a Claude API key, and what it sent through it.
    const apiKey = status === "API_KEY" ? { apiKeyVerified: usage?.apiKeyVerified ?? null, settings: await gatewaySettings(), accounts: await gateway() } : null;
    const gatewayFallback = apiKey?.settings && apiKey.accounts ? claudeGatewayFallbackState(apiKey.accounts, apiKey.settings) : undefined;
    const keyAccount = apiKey?.accounts ? claudeGatewayApiKeyAccount(apiKey.accounts) : null;
    const keyTotals = keyAccount && options.gatewayAccountUsage ? await options.gatewayAccountUsage(keyAccount.id).catch(() => null) : null;
    const apiKeyUsage = keyAccount && keyTotals ? {
      requests: keyTotals.requests, costUsd: keyTotals.costUsd, lastUsedAt: keyAccount.lastUsedAt,
      ...(keyTotals.lastRequest !== undefined ? { lastRequest: keyTotals.lastRequest } : {})
    } : undefined;
    const apiKeyMonth = apiKey ? {
      spentUsd: options.anthropicMonthUsd ? await options.anthropicMonthUsd().catch(() => null) : null,
      budgetUsd: apiKey.settings?.anthropicMonthlyBudgetUsd ?? null
    } : null;
    return {
      id: profile.profileId,
      label: profile.displayName,
      email: usage?.email ?? null,
      plan: usage?.plan ?? null,
      status: status === "IDLE" ? "CONNECTED" : status,
      fiveHourRemainingPercent: remaining(usage?.fiveHourUsedPercent ?? null),
      fiveHourResetAt: usage?.fiveHourResetAt ?? null,
      weeklyRemainingPercent: remaining(usage?.weeklyUsedPercent ?? null),
      weeklyResetAt: usage?.weeklyResetAt ?? null,
      weeklyScope: usage?.weeklyScope ?? null,
      sampledAt: sampledAt?.toISOString() ?? null,
      ...(pool ? { pool } : {}),
      ...(apiKey ? { apiKeyVerified: apiKey.apiKeyVerified } : {}),
      ...(gatewayFallback ? { gatewayFallback } : {}),
      ...(apiKeyUsage ? { apiKeyUsage } : {}),
      ...(apiKeyMonth && (apiKeyMonth.spentUsd !== null || apiKeyMonth.budgetUsd !== null) ? { apiKeyMonth } : {})
    };
  }

  async function collect(): Promise<ClaudeUsageAccountList> {
    const profiles = await options.listProfiles();
    // Read once per collection, and only when a profile signs in through the gateway, sits idle or bills a key.
    let accounts: Promise<GatewayAccountRecord[] | null> | null = null;
    const gateway = () => (accounts ??= options.gatewayAccounts ? options.gatewayAccounts().catch(() => null) : Promise.resolve(null));
    let settings: Promise<GatewayClaudeSettings | null> | null = null;
    const gatewaySettings = () => (settings ??= options.gatewaySettings ? options.gatewaySettings().catch(() => null) : Promise.resolve(null));
    const data = await Promise.all(profiles.slice(0, 100).map((profile) => account(profile, gateway, gatewaySettings)));
    const collectedAt = now();
    const value = claudeUsageAccountListSchema.parse({
      data,
      pagination: { page: 1, pageSize: 100, totalItems: data.length, totalPages: data.length ? 1 : 0 },
      source: "space-claude-profiles",
      isStale: false,
      error: null,
      checkedAt: collectedAt.toISOString()
    });
    cached = { value, collectedAtMs: collectedAt.getTime() };
    return value;
  }

  function unavailable(): ClaudeUsageAccountList {
    const current = now();
    const error = "Claude usage data is temporarily unavailable.";
    if (cached && current.getTime() - cached.collectedAtMs <= usageStaleFallbackMs) {
      return claudeUsageAccountListSchema.parse({ ...cached.value, isStale: true, error, checkedAt: current.toISOString() });
    }
    return claudeUsageAccountListSchema.parse({
      data: [],
      pagination: { page: 1, pageSize: 100, totalItems: 0, totalPages: 0 },
      source: "space-claude-profiles",
      isStale: true,
      error,
      checkedAt: current.toISOString()
    });
  }

  function refresh(): Promise<ClaudeUsageAccountList> {
    if (inFlight) return inFlight;
    const request = collect().then((value) => {
      collectFailed = false;
      return value;
    }, () => {
      collectFailed = true;
      return unavailable();
    });
    inFlight = request;
    const clear = () => {
      if (inFlight === request) inFlight = null;
    };
    void request.then(clear, clear);
    return request;
  }

  // The last sample answers at once and an old one starts a fresh collection: the account menus never wait for the profile
  // wrappers (each may take seconds), only the first read after the API starts does. A sample past the stale window is
  // dropped only while collecting keeps failing.
  const provider = async () => {
    if (!cached) return refresh();
    const ageMs = now().getTime() - cached.collectedAtMs;
    if (ageMs > usageCacheTtlMs) void refresh();
    return ageMs > usageStaleFallbackMs && collectFailed ? unavailable() : cached.value;
  };
  // Nous's world may read the last sample, but must never start a profile probe or a refresh.
  return Object.assign(provider, { peek: (): ClaudeUsageAccountList | null => cached?.value ?? null });
}
