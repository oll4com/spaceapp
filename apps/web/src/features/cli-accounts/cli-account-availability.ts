import type {
  AntigravityUsageAccount,
  ClaudeUsageAccount,
  CliAccountBalance,
  CliAccountIdentity,
  CodexUsageAccount,
  CodexUsageAccountList,
} from "@space/contracts";
import type { SharedQuotaCache } from "../desktop-widgets/shared-quota-cache.js";
import { availabilityLabel, bestAvailability, classifyQuota, formatUntil, quotaCapacity, type AvailabilityState } from "../toolbar-metrics/account-availability.js";
import {
  antigravityAccountEntries,
  antigravityStatusLabel,
  claudeAccountEntries,
  claudeStatusLabel,
  codexAccountEntries,
} from "../toolbar-metrics/account-entries.js";

export type CliAccountRuntimeId = "cli:gemini" | "cli:claude" | "cli:copilot" | "cli:cursor" | "cli:kimi";
// The pane account menu also serves Codex, which has no account profiles: its panes reach the ChatGPT accounts of
// Space Gateway, which picks one for each thread.
export type CliAccountMenuRuntimeId = CliAccountRuntimeId | "cli:codex";
export const CODEX_GATEWAY_PROFILE_ID = "space-gateway";
// Antigravity's Space Gateway profile (the same id Claude and Copilot use).
const GATEWAY_PROFILE_ID = CODEX_GATEWAY_PROFILE_ID;

// Antigravity meters Gemini models and Claude/GPT models separately.
export type AntigravityModelGroup = "gemini" | "claude";

export function antigravityModelGroup(modelId: string | null | undefined): AntigravityModelGroup | null {
  if (!modelId) return null;
  if (/gemini/i.test(modelId)) return "gemini";
  if (/claude|sonnet|opus|haiku|gpt/i.test(modelId)) return "claude";
  return null;
}

// ready: usable now; blocked: not usable right now (limit, expired, signed out);
// neutral: signed in without quota data; pending: nothing known yet;
// off: kept out of Auto (a pay-per-token API key); can serve an explicitly enabled gateway fallback.
export type CliAccountTone = "ready" | "blocked" | "neutral" | "pending" | "off";

export interface CliAccountQuotaWindow {
  label: string;
  percent: number | null;
}

export interface CliAccountAvailability {
  tone: CliAccountTone;
  // Remaining share of the tightest quota window, when the provider reports one.
  percent: number | null;
  color: string;
  // Short status for the list, e.g. "82%", "Back in 2h", "Not signed in".
  label: string;
  // Longer sentence for tooltips and screen readers.
  description: string;
  // Short line under the name for accounts without an email or login; the description is too long for a narrow menu.
  detail?: string;
  // Recent successful API traffic while the gateway's subscription pool is unavailable.
  gatewayInUse?: boolean;
  windows: CliAccountQuotaWindow[];
}

// An account Space Gateway routes the CLI's requests to; the menu lists them under the gateway row.
export interface CliAccountPoolMember {
  id: string;
  name: string;
  plan: string | null;
  availability: CliAccountAvailability;
}

export const CLI_ACCOUNT_BLOCKED_COLOR = "hsl(0 82% 58%)";
export const CLI_ACCOUNT_NEUTRAL_COLOR = "hsl(186 34% 58%)";
export const CLI_ACCOUNT_PENDING_COLOR = "hsl(195 10% 50%)";
export const CLI_ACCOUNT_OFF_COLOR = "hsl(215 8% 46%)";

// Remaining quota maps continuously from deep orange (nearly empty) through amber and
// yellow to green (full); red itself is reserved for accounts that cannot be used now.
export function cliAccountAvailabilityColor(percent: number): string {
  const share = Math.min(Math.max(percent, 0), 100) / 100;
  const hue = 16 + share * (142 - 16);
  const saturation = 78 - share * 14;
  return `hsl(${Math.round(hue)} ${Math.round(saturation)}% 52%)`;
}

function percentText(value: number): string {
  return `${Math.round(value)}%`;
}

const usdText = (value: number) => `$${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function tightest(...values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? Math.min(...known) : null;
}

function windowsSummary(windows: CliAccountQuotaWindow[]): string {
  return windows
    .filter((window) => window.percent != null)
    .map((window) => `${window.label} ${percentText(window.percent!)}`)
    .join(" · ");
}

function blocked(label: string, description: string, windows: CliAccountQuotaWindow[] = []): CliAccountAvailability {
  return { tone: "blocked", percent: windows.length ? tightest(...windows.map((window) => window.percent)) : null, color: CLI_ACCOUNT_BLOCKED_COLOR, label, description, windows };
}

type QuotaEntry = Pick<ReturnType<typeof claudeAccountEntries>[number], "availability" | "capacity" | "offlineLabel" | "hint">;

function poolDetail(states: AvailabilityState[], total: number): string {
  const ready = states.filter((state) => state.state === "available").length;
  return `${ready} of ${total} pooled ${total === 1 ? "account" : "accounts"} ready`;
}

function fromQuota(
  entry: QuotaEntry,
  windows: CliAccountQuotaWindow[],
  clock: number,
  scope = "",
): CliAccountAvailability {
  const summary = `${scope}${windowsSummary(windows)}`;
  switch (entry.availability.state) {
    case "available": {
      const percent = entry.capacity >= 0 ? entry.capacity : null;
      if (percent == null) {
        return { tone: "ready", percent: null, color: cliAccountAvailabilityColor(100), label: "Ready", description: "Available now", windows };
      }
      return {
        tone: "ready",
        percent,
        color: cliAccountAvailabilityColor(percent),
        label: percentText(percent),
        description: `Available now · ${percentText(percent)} left${summary ? ` · ${summary}` : ""}`,
        windows,
      };
    }
    case "soon":
    case "exhausted": {
      const label = availabilityLabel(entry.availability, clock);
      return blocked(label, `Not available now · ${label}${summary ? ` · ${summary}` : ""}`, windows);
    }
    case "unknown":
      return { tone: "neutral", percent: null, color: CLI_ACCOUNT_NEUTRAL_COLOR, label: "Signed in", description: "Signed in · no quota data reported", windows };
    default:
      return blocked(entry.offlineLabel ?? "Offline", entry.hint ?? "Not available now");
  }
}

const recentApiUseMs = 5 * 60_000;

function claudeApiFallback(quota: SharedQuotaCache | null, clock: number): { api: ClaudeUsageAccount; inUse: boolean } | null {
  const sample = quota?.claude;
  const api = sample?.data.find((account) => account.status === "API_KEY" && account.gatewayFallback === "ON" && account.apiKeyVerified === true);
  const gateway = sample?.data.find((account) => account.status === "GATEWAY");
  if (!sample || !api || !gateway?.pool) return null;
  const remainingAfterReset = (percent: number | null, reset: string | null) => reset && Date.parse(reset) <= clock ? 100 : percent;
  const poolMayServe = gateway.pool.some((member) => {
    if (member.signInRequired) return false;
    const state = classifyQuota({
      ...member,
      fiveHourRemainingPercent: remainingAfterReset(member.fiveHourRemainingPercent, member.fiveHourResetAt),
      weeklyRemainingPercent: remainingAfterReset(member.weeklyRemainingPercent, member.weeklyResetAt),
    }, clock).state;
    return state === "available" || state === "unknown";
  });
  if (poolMayServe) return null;
  const lastRequest = api.apiKeyUsage?.lastRequest;
  const lastUseAge = clock - Date.parse(lastRequest?.at ?? "");
  const sampleAge = clock - Date.parse(sample.checkedAt);
  // A configured fallback is not proof of traffic. Old samples and a free model-list check never light up "In use".
  const inUse = !sample.isStale && sampleAge >= 0 && sampleAge <= recentApiUseMs
    && lastRequest?.succeeded === true && lastUseAge >= 0 && lastUseAge <= recentApiUseMs;
  return { api, inUse };
}

function claudeAvailability(account: ClaudeUsageAccount, clock: number, fallback: ReturnType<typeof claudeApiFallback>): CliAccountAvailability {
  if (account.status === "API_KEY") {
    const label = account.apiKeyVerified === false ? "Key rejected" : account.apiKeyVerified ? "Paid · ready" : "Paid · not used";
    const fallbackText = account.gatewayFallback === "ON" ? " · Space Gateway fallback on" : account.gatewayFallback === "OFF" ? " · Space Gateway fallback off" : "";
    const gatewayInUse = fallback?.inUse === true && fallback.api.id === account.id;
    const activity = gatewayInUse ? " · Used by Space Gateway in the last 5 minutes; subscription accounts unavailable" : "";
    const use = account.gatewayFallback === "ON" ? "Space Gateway fallback on" : "only when picked by hand";
    const { spentUsd = null, budgetUsd = null } = account.apiKeyMonth ?? {};
    // Share of the operator's monthly budget still free after this month's Anthropic bill; still "off", so Auto never picks it.
    if (spentUsd !== null && budgetUsd && account.apiKeyVerified !== false) {
      const percent = Math.max(0, 100 - (spentUsd / budgetUsd) * 100);
      const month = `${usdText(spentUsd)} of ${usdText(budgetUsd)} this month`;
      return { tone: "off", percent, color: percent >= 1 ? cliAccountAvailabilityColor(percent) : CLI_ACCOUNT_BLOCKED_COLOR,
        label: `${usdText(Math.max(0, budgetUsd - spentUsd))} left`,
        description: `${percentText(percent)} of the monthly API budget left · ${month} (Anthropic bill, including estimates until posted; not a credit balance) · Paid per token · never chosen by Auto${fallbackText}${activity}`,
        detail: `${month} · budget`, gatewayInUse, windows: [] };
    }
    const spent = spentUsd === null ? null : `${usdText(spentUsd)} this month`;
    return { tone: "off", percent: null, color: CLI_ACCOUNT_OFF_COLOR, label,
      description: `Paid per token · never chosen by Auto${fallbackText}${spent ? ` · ${spent} (Anthropic bill)` : ""}${activity}`,
      detail: `${spent ?? "Per token"} · ${use}`, gatewayInUse, windows: [] };
  }
  if (account.status === "GATEWAY" && account.pool) {
    const entry = claudeAccountEntries([account], clock)[0]!;
    const usable = account.pool.filter((member) => !member.signInRequired);
    const detail = account.pool.length ? poolDetail(usable.map((member) => classifyQuota(member, clock)), account.pool.length) : "No pooled accounts";
    if (fallback) {
      const api = claudeAvailability(fallback.api, clock, fallback);
      const { spentUsd, budgetUsd } = fallback.api.apiKeyMonth ?? {};
      const budget = spentUsd != null && budgetUsd != null
        ? `${usdText(Math.max(0, budgetUsd - spentUsd))} of ${usdText(budgetUsd)} budget left`
        : budgetUsd == null ? "Monthly API budget not set" : "Monthly API spend unavailable";
      return { tone: fallback.inUse ? "ready" : "neutral", percent: api.percent, color: api.percent === null ? CLI_ACCOUNT_NEUTRAL_COLOR : api.color,
        label: fallback.inUse ? "Using API" : "API fallback",
        description: `${fallback.inUse ? "API fallback used in the last 5 minutes" : "API fallback enabled; no recent successful use confirmed"} · ${detail} · ${api.description}`,
        detail: budget, windows: [] };
    }
    return { ...fromQuota(entry, [], clock, detail), detail };
  }
  if (account.status === "GATEWAY") {
    return { tone: "ready", percent: null, color: cliAccountAvailabilityColor(100), label: "Ready", description: "Available now · Space Gateway picks a pooled Claude account",
      detail: "Picks a pooled Claude account", windows: [] };
  }
  if (account.status !== "CONNECTED") {
    const label = claudeStatusLabel(account);
    return blocked(label, `Not available now · ${label}`);
  }
  const entry = claudeAccountEntries([account], clock)[0]!;
  const windows: CliAccountQuotaWindow[] = [
    { label: "5h", percent: account.fiveHourRemainingPercent ?? null },
    { label: "Week", percent: account.weeklyRemainingPercent ?? null },
  ];
  return fromQuota(entry, windows, clock);
}

function codexWindows(account: CodexUsageAccount): CliAccountQuotaWindow[] {
  return [
    { label: "5h", percent: account.fiveHourRemainingPercent ?? null },
    { label: "Week", percent: account.weeklyRemainingPercent ?? null },
  ];
}

// The gateway is as available as the best ChatGPT account in its pool.
function codexGatewayAvailability(codex: CodexUsageAccountList | null, clock: number): CliAccountAvailability {
  if (!codex) {
    return { tone: "pending", percent: null, color: CLI_ACCOUNT_PENDING_COLOR, label: "Unknown", description: "Space Gateway did not report its ChatGPT accounts",
      detail: "Picks a pooled ChatGPT account", windows: [] };
  }
  if (!codex.data.length) return { ...blocked("No accounts", "Not available now · Space Gateway has no ChatGPT accounts"), detail: "No pooled accounts" };
  const entries = codexAccountEntries(codex.data, clock);
  const states = entries.map((entry) => entry.availability);
  const detail = poolDetail(states, entries.length);
  const entry: QuotaEntry = { availability: bestAvailability(states), capacity: Math.max(-1, ...entries.map((candidate) => candidate.capacity)) };
  return { ...fromQuota(entry, [], clock, detail), detail };
}

// The ChatGPT accounts behind a Codex pane, each judged like the toolbar's Codex cards; null without a sample.
export function cliAccountPool(runtimeId: CliAccountMenuRuntimeId, quota: SharedQuotaCache | null, clock: number): CliAccountPoolMember[] | null {
  if (runtimeId !== "cli:codex" || !quota?.codex) return null;
  return quota.codex.data.map((account) => {
    const entry = codexAccountEntries([account], clock)[0]!;
    const windows = codexWindows(account);
    const availability = fromQuota(entry, windows, clock);
    return {
      id: account.id,
      name: account.label,
      plan: account.planType ? `${account.planType[0]!.toUpperCase()}${account.planType.slice(1)}` : null,
      availability: { ...availability, detail: windowsSummary(windows) || undefined },
    };
  });
}

// A pane on a known model group is judged by that group's quota; otherwise by the best group.
function antigravityEntry(account: AntigravityUsageAccount, clock: number, modelGroup: AntigravityModelGroup | null): { entry: QuotaEntry; scope: string } {
  const group = modelGroup === "gemini" ? account.gemini : modelGroup === "claude" ? account.claude : null;
  if (group && (group.fiveHourRemainingPercent != null || group.weeklyRemainingPercent != null)) {
    return { entry: { availability: classifyQuota(group, clock), capacity: quotaCapacity([group]) },
      scope: modelGroup === "gemini" ? "For Gemini models · " : "For Claude · GPT models · " };
  }
  return { entry: antigravityAccountEntries([account], clock, { proOnly: false, geminiOnly: false })[0]!, scope: "" };
}

function antigravityAvailability(
  account: AntigravityUsageAccount,
  clock: number,
  modelGroup: AntigravityModelGroup | null,
): CliAccountAvailability {
  if (account.status !== "CONNECTED") {
    const label = antigravityStatusLabel(account.status);
    return blocked(label, `Not available now · ${label}`);
  }
  const windows: CliAccountQuotaWindow[] = [
    { label: "Gemini", percent: tightest(account.gemini.fiveHourRemainingPercent, account.gemini.weeklyRemainingPercent) },
    { label: "Claude · GPT", percent: tightest(account.claude.fiveHourRemainingPercent, account.claude.weeklyRemainingPercent) },
  ].filter((window) => window.percent != null);
  const { entry, scope } = antigravityEntry(account, clock, modelGroup);
  return fromQuota(entry, windows, clock, scope);
}

// Space Gateway picks a pooled Google account for each model call, so it is as available as the best of them.
// shortcut: judges the pool by the Space profiles' quota (every profile's account is in the pool today); read the
// gateway's own Antigravity accounts if the two ever differ.
function antigravityGatewayAvailability(accounts: AntigravityUsageAccount[], clock: number, modelGroup: AntigravityModelGroup | null): CliAccountAvailability {
  const entries = accounts.filter((account) => account.status === "CONNECTED").map((account) => antigravityEntry(account, clock, modelGroup).entry);
  if (!entries.length) return { ...blocked("No accounts", "Not available now · no pooled Google account is signed in"), detail: "No pooled accounts" };
  const states = entries.map((entry) => entry.availability);
  const detail = poolDetail(states, accounts.length);
  const entry: QuotaEntry = { availability: bestAvailability(states), capacity: Math.max(-1, ...entries.map((candidate) => candidate.capacity)) };
  return { ...fromQuota(entry, [], clock, detail), detail };
}

function identityAvailability(identity: CliAccountIdentity | null): CliAccountAvailability {
  switch (identity?.authStatus) {
    case "CONNECTED":
      return { tone: "neutral", percent: null, color: CLI_ACCOUNT_NEUTRAL_COLOR, label: "Signed in", description: "Signed in · no quota data reported", windows: [] };
    case "NOT_CONNECTED":
      return blocked("Not signed in", "Not available now · sign in from a pane that uses this account");
    case "UNAVAILABLE":
      return { tone: "pending", percent: null, color: CLI_ACCOUNT_PENDING_COLOR, label: "Unknown", description: "Sign-in status is unavailable", windows: [] };
    default:
      return { tone: "pending", percent: null, color: CLI_ACCOUNT_PENDING_COLOR, label: "Checking…", description: "Checking availability…", windows: [] };
  }
}

type BalanceEntry = CliAccountBalance["profiles"][number];

// Copilot, Cursor and Kimi Code: the quota each account's CLI reports, and the limits Space saw it hit. Null when the
// reading says nothing (no quota reported or a failed read), so the sign-in status speaks instead.
function balanceAvailability(entry: BalanceEntry, clock: number): CliAccountAvailability | null {
  const { usage } = entry;
  const windows: CliAccountQuotaWindow[] = usage.windows.map((window) => ({ label: window.label, percent: window.remainingPercent }));
  const summary = windowsSummary(windows);
  if (entry.exhaustedUntil && Date.parse(entry.exhaustedUntil) > clock) {
    const label = availabilityLabel({ state: "soon", backAt: entry.exhaustedUntil }, clock);
    return blocked(label, `Not available now · this account reached its limit · ${label}`, windows);
  }
  if (usage.status === "NOT_CONNECTED") return blocked("Not signed in", "Not available now · sign in from a pane that uses this account");
  if (usage.status === "GATEWAY") {
    return { tone: "ready", percent: null, color: cliAccountAvailabilityColor(100), label: "Ready", description: "Available now · served through Space Gateway", windows: [] };
  }
  if (usage.status !== "OK") return null;
  const percent = usage.remainingPercent;
  if (percent == null) {
    return { tone: "ready", percent: null, color: cliAccountAvailabilityColor(100), label: "Ready", description: "Available now", windows };
  }
  if (percent <= 0) {
    const label = usage.resetAt ? availabilityLabel({ state: "soon", backAt: usage.resetAt }, clock) : "Limit reached";
    return blocked(label, `Not available now · ${label}${summary ? ` · ${summary}` : ""}`, windows);
  }
  return {
    tone: "ready",
    percent,
    color: cliAccountAvailabilityColor(percent),
    label: percentText(percent),
    description: `Available now · ${percentText(percent)} left${summary ? ` · ${summary}` : ""}`,
    windows,
  };
}

export function cliAccountAvailability(input: {
  runtimeId: CliAccountMenuRuntimeId;
  profileId: string;
  quota: SharedQuotaCache | null;
  identity: CliAccountIdentity | null;
  clock: number;
  // Antigravity only: the model group the pane runs.
  modelGroup?: AntigravityModelGroup | null;
  // Copilot, Cursor and Kimi Code: the balance Auto works from.
  balance?: CliAccountBalance | null;
}): CliAccountAvailability {
  const { runtimeId, profileId, quota, identity, clock } = input;
  if (identity?.authStatus === "NOT_CONNECTED") return identityAvailability(identity);
  // Claude, Antigravity and Codex report quota; until the first sample arrives the account is still being checked.
  if (!quota && (runtimeId === "cli:claude" || runtimeId === "cli:gemini" || runtimeId === "cli:codex")) return identityAvailability(null);
  if (runtimeId === "cli:codex") return codexGatewayAvailability(quota?.codex ?? null, clock);
  if (runtimeId === "cli:claude") {
    const account = quota?.claude?.data.find((candidate) => candidate.id === profileId);
    if (account) return claudeAvailability(account, clock, claudeApiFallback(quota, clock));
  }
  if (runtimeId === "cli:gemini") {
    if (profileId === GATEWAY_PROFILE_ID && quota?.agy) return antigravityGatewayAvailability(quota.agy.data, clock, input.modelGroup ?? null);
    const account = quota?.agy?.data.find((candidate) => candidate.id === profileId);
    if (account) return antigravityAvailability(account, clock, input.modelGroup ?? null);
  }
  const entry = input.balance?.runtimeId === runtimeId ? input.balance.profiles.find((candidate) => candidate.profileId === profileId) : undefined;
  return (entry ? balanceAvailability(entry, clock) : null) ?? identityAvailability(identity);
}

const weekMs = 7 * 24 * 3_600_000;

export interface CliAccountWeeklyForecast {
  // Share of the subscription accounts' weekly quota still free when their weeks reset, at this week's pace.
  percent: number;
  accounts: number;
  color: string;
  // When the last of the accounts' weeks resets: "at Tue 10:00", or "in 3h 20m" within a day.
  resetWhen: string;
}

const resetWhen = (until: string | null) => (!until ? "at reset" : until.startsWith("in ") ? until : `at ${until}`);

// Claude, Codex and Antigravity (the pane's model group) report weekly windows; API keys and Space Gateway rows are
// not subscriptions of their own. Pure arithmetic over the cached quota sample, so the menu opens without waiting.
// shortcut: extrapolates each account's average pace since its week began and lets one account's overflow use another's
// room (Auto and Space Gateway move work between accounts); keep a usage history if a recent-days pace is wanted.
export function cliAccountWeeklyForecast(
  runtimeId: CliAccountMenuRuntimeId,
  quota: SharedQuotaCache | null,
  clock: number,
  modelGroup: AntigravityModelGroup | null = null,
): CliAccountWeeklyForecast | null {
  const weeks: Array<{ remaining: number | null | undefined; resetAt: string | null | undefined }> =
    runtimeId === "cli:claude" ? (quota?.claude?.data ?? []).filter((account) => account.status === "CONNECTED")
      .map((account) => ({ remaining: account.weeklyRemainingPercent, resetAt: account.weeklyResetAt }))
    : runtimeId === "cli:codex" ? (quota?.codex?.data ?? []).map((account) => ({ remaining: account.weeklyRemainingPercent, resetAt: account.weeklyResetAt }))
    : runtimeId === "cli:gemini" && modelGroup ? (quota?.agy?.data ?? []).filter((account) => account.status === "CONNECTED")
      .map((account) => ({ remaining: account[modelGroup].weeklyRemainingPercent, resetAt: account[modelGroup].weeklyResetAt }))
    : [];
  let used = 0;
  let accounts = 0;
  let lastReset = 0;
  for (const week of weeks) {
    const resetMs = week.resetAt ? Date.parse(week.resetAt) : Number.NaN;
    if (week.remaining == null || !(resetMs > clock)) continue;
    const spent = 100 - week.remaining;
    // At least an hour, so the first minutes of a week do not extrapolate wildly.
    const elapsed = Math.max(clock - (resetMs - weekMs), 3_600_000);
    // An account at its limit uses nothing more until its week resets.
    used += week.remaining > 0 ? spent + (spent / elapsed) * (resetMs - clock) : spent;
    accounts += 1;
    lastReset = Math.max(lastReset, resetMs);
  }
  if (!accounts) return null;
  const percent = Math.max(0, 100 - used / accounts);
  return {
    percent,
    accounts,
    color: percent >= 1 ? cliAccountAvailabilityColor(percent) : CLI_ACCOUNT_BLOCKED_COLOR,
    resetWhen: resetWhen(formatUntil(new Date(lastReset).toISOString(), clock)),
  };
}

// The plan each provider reports, shortened for a badge: "Google AI Pro" -> "AI Pro".
export function cliAccountPlan(runtimeId: CliAccountMenuRuntimeId, profileId: string, quota: SharedQuotaCache | null, balance: CliAccountBalance | null = null): string | null {
  if (runtimeId === "cli:claude") {
    const account = quota?.claude?.data.find((candidate) => candidate.id === profileId);
    if (account?.status === "API_KEY") return "API key";
    // The account's name already says Space Gateway.
    if (account?.status === "GATEWAY") return null;
    return account?.plan?.trim() || null;
  }
  if (runtimeId === "cli:gemini") {
    const tier = quota?.agy?.data.find((candidate) => candidate.id === profileId)?.tier?.trim();
    return tier ? tier.replace(/^Google\s+/i, "") : null;
  }
  if (balance?.runtimeId !== runtimeId) return null;
  return balance.profiles.find((candidate) => candidate.profileId === profileId)?.usage.plan?.trim() || null;
}

export function cliAccountInitials(displayName: string): string {
  const words = displayName.trim().split(/[\s._@-]+/).filter(Boolean);
  if (words.length >= 2) return `${words[0]![0]}${words[1]![0]}`.toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}
