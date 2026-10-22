import type { ReactNode } from "react";
import type {
  AntigravityUsageAccount,
  ClaudeUsageAccount,
  CodexUsageAccount,
  GatewayAnthropicBillingReport,
} from "@space/contracts";
import { browserTimeZone, formatUserTime, readDateTimeSettings, type DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import { CODEX_EXHAUSTION_THRESHOLD_PERCENT } from "../system-health/health-model.js";
import type { AccountQuotaEntry, AccountQuotaRow } from "./AccountQuotaCards.js";
import {
  ACCOUNT_AVAILABLE_THRESHOLD_PERCENT,
  bestAvailability,
  classifyQuota,
  quotaCapacity,
  type AvailabilityState,
} from "./account-availability.js";

// Turns each provider's usage sample into the shared card model of Accounts & quotas.
const offline: AvailabilityState = { state: "offline", backAt: null };

function details(...values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

export function antigravityStatusLabel(status: AntigravityUsageAccount["status"]): string {
  switch (status) {
    case "UNLICENSED": return "Unlicensed";
    case "EXPIRED": return "Sign-in expired";
    case "CONNECTED": return "Connected";
    default: return "Unavailable";
  }
}

function antigravityStatusHint(status: AntigravityUsageAccount["status"]): string {
  switch (status) {
    case "UNLICENSED": return "No quota allocation for this profile.";
    case "EXPIRED": return "Sign in again from a Gemini pane that uses this profile.";
    default: return "Usage is temporarily unavailable.";
  }
}

export function claudeStatusLabel(account: ClaudeUsageAccount): string {
  switch (account.status) {
    case "CONNECTED": return "Connected";
    case "NOT_CONNECTED": return "Not signed in";
    case "EXPIRED": return "Sign-in expired";
    case "API_KEY": return account.apiKeyVerified === false ? "API key rejected" : account.apiKeyVerified ? "Connected · API key" : "API key";
    case "GATEWAY": return "Space Gateway";
    default: return "Unavailable";
  }
}

/** What Space Gateway sent through the key: nothing while a subscription account could serve. */
export function claudeApiKeyUsageText(account: ClaudeUsageAccount, clock: number): string | null {
  const usage = account.apiKeyUsage;
  if (!usage) return null;
  if (usage.requests === 0 && !usage.lastUsedAt) return "Never used by Space Gateway.";
  const last = usage.lastUsedAt ? formatAgoShort(usage.lastUsedAt, clock) : null;
  const cost = usage.costUsd >= 0.005 ? ` ($${usage.costUsd.toFixed(2)})` : "";
  return `Used ${usage.requests} ${usage.requests === 1 ? "time" : "times"} through Space Gateway${cost}${last ? `, last ${last}` : ""}.`;
}

/**
 * Anthropic's own bill (Admin API, operator request 2026-10-20) for the Claude API-key card, per Anthropic's UTC days: a day
 * Anthropic has not posted yet counts Space Gateway's list-price estimate. The month is the owner's working time zone's.
 */
export function anthropicBillLines(report: GatewayAnthropicBillingReport | null | undefined, clock: number, settings?: DateTimeSettings): string[] {
  if (!report?.status?.configured) return [];
  const active = settings ?? readDateTimeSettings();
  const today = new Date(clock).toISOString().slice(0, 10);
  const weekStart = new Date(clock - 6 * 86_400_000).toISOString().slice(0, 10);
  let month = today.slice(0, 7);
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: active.timeZone && active.timeZone !== "system" ? active.timeZone : browserTimeZone(), year: "numeric", month: "2-digit" }).formatToParts(clock);
    month = `${parts.find((part) => part.type === "year")!.value}-${parts.find((part) => part.type === "month")!.value}`;
  } catch { /* an unknown zone keeps UTC's month */ }
  const usd = (day: GatewayAnthropicBillingReport["days"][number]) => (day.reported ? day.organizationUsd : day.gatewayEstimateUsd);
  const total = (keep: (day: string) => boolean) => `$${report.days.filter((day) => keep(day.day)).reduce((sum, day) => sum + usd(day), 0).toFixed(2)}`;
  const reported = report.days.find((day) => day.day === today)?.reported ?? false;
  const { lastSyncAt, lastError } = report.status;
  return [
    `Anthropic bill: today ${total((day) => day === today)}${reported ? "" : " (estimate)"} · 7 days ${total((day) => day >= weekStart)} · this month ${total((day) => day.startsWith(month))} · 31 days ${total(() => true)}.`,
    lastSyncAt ? `Synced ${formatUserTime(lastSyncAt, {}, active)}.` : "Not synced with Anthropic yet.",
    ...(lastError ? [`The last sync failed (${lastError}).`] : [])
  ];
}

function formatAgoShort(value: string, clock: number): string {
  const ms = clock - Date.parse(value);
  if (!Number.isFinite(ms) || ms < 0) return "just now";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/** Panes never pick the key on their own; Space Gateway may fall back to it when every pooled account is out of quota. */
export function claudeApiKeyHint(account: ClaudeUsageAccount, clock = Date.now()): string {
  const key = account.apiKeyVerified === false ? "Anthropic rejected this API key." : "Paid per token; panes never choose it automatically.";
  const used = claudeApiKeyUsageText(account, clock);
  const usage = used ? ` ${used}` : "";
  switch (account.gatewayFallback) {
    case "ON": return `${key} Space Gateway uses it while every pooled Claude account is out of quota, and returns to the accounts at their reset.${usage}`;
    case "OFF": return `${key} Space Gateway fallback is off (Space Gateway › Settings › Routing).${usage}`;
    case "NOT_ADDED": return `${key} Add it to Space Gateway (Accounts › Add account › Claude › API key) to serve requests when every account is out of quota.`;
    default: return `${key}${usage}`;
  }
}

export function claudeStatusHint(account: ClaudeUsageAccount): string {
  switch (account.status) {
    case "NOT_CONNECTED": return "Sign in from a Claude pane that uses this profile.";
    case "EXPIRED": return "Open a Claude pane on this profile to renew the sign-in.";
    case "API_KEY": return claudeApiKeyHint(account);
    case "GATEWAY": return "Space Gateway picks one of its pooled Claude accounts for each request.";
    default: return "Usage is temporarily unavailable.";
  }
}

export function antigravityAccountEntries(
  accounts: AntigravityUsageAccount[],
  clock: number,
  options: { proOnly: boolean; geminiOnly: boolean },
): AccountQuotaEntry[] {
  return accounts
    .filter((account) => !options.proOnly || Boolean(account.tier?.toLowerCase().includes("pro")))
    .flatMap((account) => {
      const rows: AccountQuotaRow[] = [
        { key: "gemini", label: "Gemini", quota: account.gemini, threshold: ACCOUNT_AVAILABLE_THRESHOLD_PERCENT },
        ...(options.geminiOnly ? [] : [{ key: "claude", label: "Claude · GPT", quota: account.claude, threshold: ACCOUNT_AVAILABLE_THRESHOLD_PERCENT }]),
      ].filter((row) => row.quota && (row.quota.fiveHourRemainingPercent != null || row.quota.weeklyRemainingPercent != null));
      if (options.geminiOnly && !rows.length) return [];
      const connected = account.status === "CONNECTED";
      return [{
        id: account.id,
        title: account.label || account.email || account.id,
        details: details(account.email !== account.label ? account.email : null, account.tier),
        availability: connected ? bestAvailability(rows.map((row) => classifyQuota(row.quota, clock, row.threshold))) : offline,
        offlineLabel: antigravityStatusLabel(account.status),
        hint: connected ? "No quota data reported." : antigravityStatusHint(account.status),
        rows: connected ? rows : [],
        capacity: quotaCapacity(rows.map((row) => row.quota)),
      }];
    });
}

// Codex routing skips accounts under its own floor, so cards use the same threshold.
export function codexAccountEntries(
  accounts: CodexUsageAccount[],
  clock: number,
  action?: (account: CodexUsageAccount) => ReactNode,
): AccountQuotaEntry[] {
  return accounts.map((account) => ({
    id: account.id,
    title: account.label,
    details: details(account.planType ? `${account.planType[0]!.toUpperCase()}${account.planType.slice(1)}` : null),
    availability: classifyQuota(account, clock, CODEX_EXHAUSTION_THRESHOLD_PERCENT),
    rows: [{ key: "codex", label: null, quota: account, threshold: CODEX_EXHAUSTION_THRESHOLD_PERCENT }],
    capacity: quotaCapacity([account]),
    action: action?.(account),
  }));
}

// The gateway profile is as available as the best account in its pool; without pool data it stays a plain label.
function claudeGatewayEntry(account: ClaudeUsageAccount, pool: NonNullable<ClaudeUsageAccount["pool"]>, clock: number): AccountQuotaEntry {
  const usable = pool.filter((member) => !member.signInRequired);
  const states = usable.map((member) => classifyQuota(member, clock));
  const ready = states.filter((state) => state.state === "available").length;
  return {
    id: account.id,
    title: account.label,
    details: details(pool.length ? `Pools ${pool.map((member) => member.label).join(", ")}` : null),
    availability: usable.length ? bestAvailability(states) : offline,
    offlineLabel: pool.length ? "Sign-in required" : "No accounts",
    hint: pool.length
      ? `${ready} of ${pool.length} pooled ${pool.length === 1 ? "account" : "accounts"} available now.`
      : "Space Gateway has no Claude accounts to route to.",
    rows: [],
    capacity: quotaCapacity(usable),
  };
}

/** `bill`: anthropicBillLines for API-key cards. */
export function claudeAccountEntries(accounts: ClaudeUsageAccount[], clock: number, bill: string[] = []): AccountQuotaEntry[] {
  return accounts.map((account) => {
    if (account.status === "GATEWAY" && account.pool) return claudeGatewayEntry(account, account.pool, clock);
    const connected = account.status === "CONNECTED";
    return {
      id: account.id,
      title: account.label,
      details: details(account.email !== account.label ? account.email : null, account.plan),
      availability: connected ? classifyQuota(account, clock) : offline,
      offlineLabel: claudeStatusLabel(account),
      hint: account.status === "API_KEY" ? claudeApiKeyHint(account, clock) : claudeStatusHint(account),
      ...(account.status === "API_KEY" && bill.length ? { notes: bill } : {}),
      rows: connected
        ? [{ key: "claude", label: null, quota: account, threshold: ACCOUNT_AVAILABLE_THRESHOLD_PERCENT, weeklyScope: account.weeklyScope }]
        : [],
      capacity: quotaCapacity([account]),
    };
  });
}
