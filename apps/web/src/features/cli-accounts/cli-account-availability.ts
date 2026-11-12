import {
  antigravityAccountGroup,
  claudeSubscriptionAccounts,
  quotaLeftAtReset,
  quotaResetCreditsText,
  type QuotaResetCredits,
  subscriptionQuotaAtReset,
  type QuotaLeftAtReset,
  type ApiProviderAccount,
  type AntigravityUsageAccount,
  type AntigravityUsageAccountList,
  type ClaudeUsageAccount,
  type CliAccountBalance,
  type CliAccountIdentity,
  type CodexUsageAccount,
  type CodexUsageAccountList,
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

// Antigravity meters each quota group Google reports apart: "gemini", "claude" (Claude · GPT) and Google's own ids
// (e.g. "gemini-argon-wtu" for Gemini 4 Argon).
export type AntigravityModelGroup = string;

export function antigravityGroupLabel(id: string, displayName?: string | null): string {
  if (id === "gemini") return "Gemini";
  if (id === "claude") return "Claude · GPT";
  return displayName?.replace(/\s+models?$/i, "").trim() || id;
}

// The quota groups Google reports for the accounts, in its order: a group no account reports any more is not offered.
// A list without per-account groups (an older server, the demo) offers the Gemini and Claude · GPT groups it has data for.
export function antigravityQuotaGroups(agy: AntigravityUsageAccountList | null | undefined): Array<{ id: string; label: string }> {
  const accounts = [...(agy?.data ?? []), ...(agy?.outOfRotation ?? [])];
  const groups = new Map<string, string>();
  for (const account of accounts) {
    const listed = account.groups ?? (["gemini", "claude"] as const)
      .map((id) => ({ id, ...account[id] }))
      .filter((group) => group.fiveHourRemainingPercent != null || group.weeklyRemainingPercent != null);
    for (const group of listed) if (!groups.has(group.id)) groups.set(group.id, antigravityGroupLabel(group.id, group.displayName));
  }
  return [...groups].map(([id, label]) => ({ id, label }));
}

// True when Google lists this account's groups without the given one (a Free account has no Gemini 4 Argon); an account
// Google did not answer for (expired, error) lacks nothing.
function lacksGroup(account: AntigravityUsageAccount, group: AntigravityModelGroup | null): boolean {
  return Boolean(group && account.groups && !account.groups.some((candidate) => candidate.id === group));
}

export function antigravityAccountLacksGroup(quota: SharedQuotaCache | null, profileId: string, group: AntigravityModelGroup | null): boolean {
  const account = quota?.agy?.data.find((candidate) => candidate.id === profileId)
    ?? quota?.agy?.outOfRotation?.find((candidate) => candidate.id === profileId);
  return account ? lacksGroup(account, group) : false;
}

export function antigravityModelGroup(
  modelId: string | null | undefined,
  groups: Array<{ id: string; label: string }> = [],
): AntigravityModelGroup | null {
  if (!modelId) return null;
  // A group Google names after its models ("Gemini 4 Argon" → gemini-4-argon-high) wins over the family groups below.
  const words = (label: string) => label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const named = groups.find((group) => group.id !== "gemini" && group.id !== "claude" && words(group.label).length > 0
    && words(group.label).every((word) => words(modelId).includes(word)));
  if (named) return named.id;
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
  // When the window resets; the tooltip names it.
  resetAt?: string | null;
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
  // Signed out on this profile while Space Gateway holds the account: picking it runs the pane through the Gateway on that account.
  heldByGateway?: boolean;
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

// "in 3h 20m", "now" or "at Tue 10:00"; null when the time is unknown.
const resetText = (until: string | null) => (!until ? null : until === "now" || until.startsWith("in ") ? until : `at ${until}`);

// With a clock, each window also says when it resets (tooltips); without one it stays short (the line under a name).
function windowsSummary(windows: CliAccountQuotaWindow[], clock?: number): string {
  return windows
    .filter((window) => window.percent != null)
    .map((window) => {
      const reset = clock === undefined ? null : resetText(formatUntil(window.resetAt, clock));
      return `${window.label} ${percentText(window.percent!)}${reset ? ` (resets ${reset})` : ""}`;
    })
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
  const summary = `${scope}${windowsSummary(windows, clock)}`;
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
      // A spent week says when it comes back, "Back Fri 13 Nov 06:00" (operator 8/11); the tooltip keeps "Week exhausted".
      const back = entry.availability.state === "exhausted" ? formatUntil(entry.availability.backAt, clock) : null;
      const text = back ? `${label} · back ${back}` : label;
      return blocked(back ? `Back ${back}` : label, `Not available now · ${text}${summary ? ` · ${summary}` : ""}`, windows);
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
    // The API key never serves Claude Code (operator rule 2026-10-27): this row shows the subscription pool only.
    return { ...fromQuota(entry, [], clock, detail), detail };
  }
  if (account.status === "GATEWAY") {
    return { tone: "ready", percent: null, color: cliAccountAvailabilityColor(100), label: "Ready", description: "Available now · Space Gateway picks a pooled Claude account",
      detail: "Picks a pooled Claude account", windows: [] };
  }
  const held = account.status === "NOT_CONNECTED" ? subscriptionWindows(account).filter((window) => window.percent != null) : [];
  if (held.length) {
    // Operator 12/11: picking it works; the launcher sends the pane through Space Gateway pinned to this account (x-space-gateway-account).
    const usage = fromQuota(claudeAccountEntries([account], clock)[0]!, held, clock);
    return { ...usage, heldByGateway: true, detail: "Signed out here · runs through Space Gateway",
      description: `Signed out here · runs through Space Gateway · ${windowsSummary(held, clock)}` };
  }
  if (account.status !== "CONNECTED") {
    const label = claudeStatusLabel(account);
    return blocked(label, `Not available now · ${label}`);
  }
  const entry = claudeAccountEntries([account], clock)[0]!;
  return fromQuota(entry, subscriptionWindows(account), clock);
}

function subscriptionWindows(account: ClaudeUsageAccount | CodexUsageAccount): CliAccountQuotaWindow[] {
  return [
    { label: "5h", percent: account.fiveHourRemainingPercent ?? null, resetAt: account.fiveHourResetAt },
    { label: "Week", percent: account.weeklyRemainingPercent ?? null, resetAt: account.weeklyResetAt },
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
    const windows = subscriptionWindows(account);
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
  const group = modelGroup ? antigravityAccountGroup(account, modelGroup) : undefined;
  if (modelGroup && group && (group.fiveHourRemainingPercent != null || group.weeklyRemainingPercent != null)) {
    return { entry: { availability: classifyQuota(group, clock), capacity: quotaCapacity([group]) },
      scope: `For ${antigravityGroupLabel(modelGroup, group.displayName)} models · ` };
  }
  // 8/11: When the pane's model group has no data, show "Signed in" (unknown) rather than the other group's exhaustion.
  if (modelGroup) {
    return { entry: { availability: { state: "unknown", backAt: null }, capacity: -1, hint: "No quota data reported for this model group." }, scope: "" };
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
  // Each group's tightest window, with that window's reset. When the pane runs a known model group,
  // only that group's window shows (8/11: operator request — show only Gemini data in a Gemini pane).
  const groupWindow = (label: string, group: AntigravityUsageAccount["gemini"]): CliAccountQuotaWindow => {
    const weekly = group.weeklyRemainingPercent != null && (group.fiveHourRemainingPercent == null || group.weeklyRemainingPercent <= group.fiveHourRemainingPercent);
    return { label, percent: tightest(group.fiveHourRemainingPercent, group.weeklyRemainingPercent), resetAt: weekly ? group.weeklyResetAt : group.fiveHourResetAt };
  };
  const groups = account.groups ?? [{ id: "gemini", ...account.gemini }, { id: "claude", ...account.claude }];
  const windows = groups
    .filter((group) => !modelGroup || group.id === modelGroup)
    .map((group) => groupWindow(antigravityGroupLabel(group.id, group.displayName), group))
    .filter((window) => window.percent != null);
  const { entry, scope } = antigravityEntry(account, clock, modelGroup);
  return fromQuota(entry, windows, clock, scope);
}

// Space Gateway picks a pooled Google account for each model call, so it is as available as the best of them.
// shortcut: judges the pool by the Space profiles' quota (every profile's account is in the pool today); read the
// gateway's own Antigravity accounts if the two ever differ.
function antigravityGatewayAvailability(accounts: AntigravityUsageAccount[], clock: number, modelGroup: AntigravityModelGroup | null): CliAccountAvailability {
  const entries = accounts.filter((account) => account.status === "CONNECTED" && !lacksGroup(account, modelGroup))
    .map((account) => antigravityEntry(account, clock, modelGroup).entry);
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
  const windows: CliAccountQuotaWindow[] = usage.windows.map((window) => ({ label: window.label, percent: window.remainingPercent, resetAt: window.resetAt }));
  const summary = windowsSummary(windows, clock);
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
  const claudeAccount = runtimeId === "cli:claude" ? quota?.claude?.data.find((candidate) => candidate.id === profileId) : undefined;
  // An API key, the gateway or a held account has no login of its own; the quota sample says more than the sign-in check.
  if (identity?.authStatus === "NOT_CONNECTED" && (!claudeAccount || claudeAccount.status === "CONNECTED")) return identityAvailability(identity);
  // Claude, Antigravity and Codex report quota; until the first sample arrives the account is still being checked.
  if (!quota && (runtimeId === "cli:claude" || runtimeId === "cli:gemini" || runtimeId === "cli:codex")) return identityAvailability(null);
  if (runtimeId === "cli:codex") return codexGatewayAvailability(quota?.codex ?? null, clock);
  if (claudeAccount) return claudeAvailability(claudeAccount, clock, claudeApiFallback(quota, clock));
  if (runtimeId === "cli:gemini") {
    if (profileId === GATEWAY_PROFILE_ID && quota?.agy) return antigravityGatewayAvailability(quota.agy.data, clock, input.modelGroup ?? null);
    const account = quota?.agy?.data.find((candidate) => candidate.id === profileId)
      ?? quota?.agy?.outOfRotation?.find((candidate) => candidate.id === profileId);
    if (account) return antigravityAvailability(account, clock, input.modelGroup ?? null);
  }
  const entry = input.balance?.runtimeId === runtimeId ? input.balance.profiles.find((candidate) => candidate.profileId === profileId) : undefined;
  return (entry ? balanceAvailability(entry, clock) : null) ?? identityAvailability(identity);
}

const weekMs = 7 * 24 * 3_600_000;

export interface CliAccountForecast {
  // Share of the accounts' quota still free when the last of their periods resets, at the current pace; null when unknown.
  percent: number | null;
  // Share of the accounts' quota free now (operator 7/11 nous_msg:e768734b: the header led with a forecast while 3 of 5 accounts were spent).
  now?: number;
  accounts: number;
  color: string;
  // When the last of the accounts' periods resets: "at Tue 10:00", or "in 3h 20m" within a day; "at reset" when unknown.
  resetWhen: string;
  // "weekly" or "monthly"; empty when the accounts' periods differ or are unknown.
  period: string;
  // Antigravity: the model group the figure is for.
  scope: string | null;
  // Unknown only: why there is no figure (the header's tooltip).
  reason?: string;
  // Codex: "+4 resets (≈ +100% of a week)", the pool's weekly reset credits beyond the figure (operator 2/11 15:38 BKK).
  credits?: string;
  // Space has not read the quota yet (the menu just opened): "Checking…", never "Unknown".
  checking?: boolean;
  // The accounts' average pace: used minus the share of their period passed (AHEAD runs out early, UNDER leaves quota unused); null when unknown.
  pace: QuotaLeftAtReset["pace"] | null;
}

const paceText: Record<QuotaLeftAtReset["pace"], string> = { AHEAD: "ahead of pace", ON: "on pace", UNDER: "under pace" };

// The menu header's and the provider cards' "56% free at Fri 06:00" in words, for their tooltips; an unknown figure gives its reason.
export function cliAccountForecastTitle(forecast: CliAccountForecast): string {
  if (forecast.checking) return `${forecast.scope ? `${forecast.scope}: ` : ""}checking the accounts' quota…`;
  if (forecast.percent === null) return `${forecast.scope ? `${forecast.scope}: ` : ""}share free at reset unknown. ${forecast.reason ?? ""}`.trim();
  return `${Math.round(forecast.now ?? 0)}% is free now. At the current pace, ${Math.round(forecast.percent)}% of the ${forecast.scope ? `${forecast.scope} ` : ""}${forecast.period ? `${forecast.period} ` : ""}quota of ${forecast.accounts} subscription ${forecast.accounts === 1 ? "account" : "accounts"} is still free when the last of them resets ${forecast.resetWhen} (${paceText[forecast.pace!]}).${forecast.credits ? ` Plus ${forecast.credits.slice(1)}: each reset credit gives its account a fresh week.` : ""} API keys are not counted.`;
}

export function cliAccountForecastPace(forecast: CliAccountForecast): string {
  return forecast.pace ? paceText[forecast.pace] : "pace unknown";
}

type QuotaPeriod = Parameters<typeof quotaLeftAtReset>[0][number];

// A calendar month before the reset (Copilot's premium requests reset on the 1st).
function monthBefore(resetAt: string): number {
  const start = new Date(resetAt);
  start.setUTCMonth(start.getUTCMonth() - 1);
  return Date.parse(resetAt) - start.getTime();
}

// Copilot, Cursor and Kimi Code: each account's tightest window longer than 5 hours (Kimi's week or month, Copilot's month).
// shortcut: reads the period from the window id (limit_7d is a week, the rest a calendar month); add its length to
// usage-info if a CLI reports another period.
function balancePeriods(balance: CliAccountBalance): QuotaPeriod[] {
  return balance.profiles.flatMap(({ usage }) => {
    const window = usage.windows.filter((entry) => entry.id !== "limit_5h" && entry.resetAt)
      .sort((left, right) => left.remainingPercent - right.remainingPercent)[0];
    return window?.resetAt ? [{ remaining: window.remainingPercent, resetAt: window.resetAt, periodMs: window.id === "limit_7d" ? weekMs : monthBefore(window.resetAt) }] : [];
  });
}

// No figure, and why (operator 31/10 16:59 BKK: a picker never shows nothing; it says what the provider did not report).
function unknownForecast(reason: string, scope: string | null = null): CliAccountForecast {
  return { percent: null, accounts: 0, color: CLI_ACCOUNT_PENDING_COLOR, resetWhen: "at reset", period: "", scope, reason, pace: null };
}

// Before the first quota sample arrives (stable 31/10: the header read "Unknown" while every row still said "Checking…").
const checkingForecast = (scope: string | null = null): CliAccountForecast => ({ ...unknownForecast("Space is reading the accounts' quota", scope), checking: true });

function forecastFrom(left: QuotaLeftAtReset & { resetCredits?: QuotaResetCredits }, period: string, clock: number, scope: string | null): CliAccountForecast {
  return {
    ...(left.resetCredits ? { credits: quotaResetCreditsText(left.resetCredits) } : {}),
    percent: left.percent,
    now: left.now,
    accounts: left.accounts,
    color: left.percent >= 1 ? cliAccountAvailabilityColor(left.percent) : CLI_ACCOUNT_BLOCKED_COLOR,
    resetWhen: cliResetWhen(left.resetAt, clock),
    period,
    scope,
    pace: left.pace,
  };
}

function forecastOf(periods: QuotaPeriod[], clock: number, unknown: string): CliAccountForecast {
  const left = quotaLeftAtReset(periods, clock);
  if (!left) return unknownForecast(unknown);
  const lengths = new Set(periods.map((period) => (period.periodMs === weekMs ? "weekly" : "monthly")));
  return forecastFrom(left, lengths.size === 1 ? [...lengths][0]! : "", clock, null);
}

// When a quota period resets, as the menu headers say it: "at Tue 10:00", "in 3h 20m" within a day.
export const cliResetWhen = (resetAt: string, clock: number) => resetText(formatUntil(resetAt, clock)) ?? "at reset";

// "3% now · 54% free at Tue 10:00" or "Unknown free at reset": the pickers' figure as one line (model picker providers, Nous's provider list).
export function cliAccountForecastText(forecast: CliAccountForecast): string {
  return forecast.checking ? "Checking…" : `${forecast.percent === null ? "Unknown" : `${Math.round(forecast.now ?? 0)}% now · ${Math.round(forecast.percent)}%`} free ${forecast.resetWhen}${forecast.credits ? ` · ${forecast.credits}` : ""}`;
}

const accountsText = (count: number) => `${count} signed-in ${count === 1 ? "account" : "accounts"}`;
const noSample = "Space has no quota sample for these accounts yet";

// The menu header's "54% free at Tue 10:00" for every CLI: Claude, Codex, Antigravity (each model group, the pane's first),
// Copilot, Cursor and Kimi Code (their balance); "Unknown" with the reason where the provider reports no quota period. API keys
// and Space Gateway rows are not subscriptions of their own. Pure arithmetic over the cached samples, so the menu opens without waiting.
export function cliAccountForecasts(
  runtimeId: CliAccountMenuRuntimeId,
  quota: SharedQuotaCache | null,
  clock: number,
  modelGroup: AntigravityModelGroup | null = null,
  balance: CliAccountBalance | null = null,
): CliAccountForecast[] {
  const weekly = (left: Array<QuotaLeftAtReset & { scope: string | null }>, unknown: string, scope: string | null = null) =>
    left.length ? left.map((entry) => forecastFrom(entry, "weekly", clock, entry.scope ?? scope)) : [unknownForecast(unknown, scope)];
  if (runtimeId === "cli:claude") {
    if (!quota) return [checkingForecast()];
    if (!quota.claude) return [unknownForecast(noSample)];
    const counted = claudeSubscriptionAccounts(quota.claude.data).length;
    return weekly(subscriptionQuotaAtReset("claude", quota.claude.data, clock), `None of the ${counted} subscription ${counted === 1 ? "account" : "accounts"} reported a current weekly limit`);
  }
  if (runtimeId === "cli:codex") {
    if (!quota) return [checkingForecast()];
    if (!quota.codex) return [unknownForecast("Space Gateway did not report its ChatGPT accounts")];
    return weekly(subscriptionQuotaAtReset("codex", quota.codex.data, clock), `None of the ${quota.codex.data.length} pooled ChatGPT accounts reported a current weekly limit`);
  }
  if (runtimeId === "cli:gemini") {
    // 8/11: The chosen model group only; without one (no model known yet), every group Google reports.
    const options = antigravityQuotaGroups(quota?.agy);
    const chosen = modelGroup ? [options.find((option) => option.id === modelGroup) ?? { id: modelGroup, label: antigravityGroupLabel(modelGroup) }] : options;
    const groups = chosen.length ? chosen : [{ id: null, label: null }];
    if (!quota) return groups.map(({ label }) => checkingForecast(label));
    const agy = quota.agy;
    if (!agy) return groups.map(({ label }) => unknownForecast(noSample, label));
    const connected = agy.data.filter((account) => account.status === "CONNECTED").length;
    return groups.flatMap(({ id, label }) => id ? weekly(subscriptionQuotaAtReset("antigravity", agy.data, clock, id),
      `Google reported no current ${label} weekly limit for the ${accountsText(connected)}`, label)
      : [unknownForecast(`Google reported no quota group for the ${accountsText(connected)}`)]);
  }
  if (!balance) return [checkingForecast()];
  if (balance.runtimeId !== runtimeId) return [unknownForecast(noSample)];
  return [forecastOf(balancePeriods(balance), clock, `None of the ${balance.profiles.length} ${balance.profiles.length === 1 ? "account" : "accounts"} reported a quota period that resets`)];
}

// API keys (OpenRouter, DeepSeek, OpenAI, Claude API): the balance or budget left as the provider reports it; paid per token.
export function apiProviderAvailability(account: ApiProviderAccount | undefined): CliAccountAvailability {
  if (!account || account.status === "ERROR") {
    return { tone: "pending", percent: null, color: CLI_ACCOUNT_PENDING_COLOR, label: "Unknown", description: `Balance unknown${account?.detail ? ` · ${account.detail}` : ""}`, windows: [] };
  }
  if (account.status === "UNCONFIGURED") return blocked("No key", `Not available now · ${account.detail ?? "no API key"}`);
  const percent = account.remainingPercent ?? null;
  const money = account.balance && /^\$/.test(account.balance) ? account.balance : null;
  const left = [percent == null ? null : `${percentText(percent)} left`, money ? `${money} left` : null, "paid per token", account.detail ?? null].filter(Boolean).join(" · ");
  if (account.status === "EXHAUSTED") return blocked("No balance", `Not available now · ${left}`);
  return {
    tone: "off",
    percent,
    color: percent == null ? CLI_ACCOUNT_OFF_COLOR : percent >= 1 ? cliAccountAvailabilityColor(percent) : CLI_ACCOUNT_BLOCKED_COLOR,
    label: money ? `${money} left` : percent == null ? "Unknown" : percentText(percent),
    description: percent == null && !money ? `Balance not reported · ${left}` : left,
    windows: [],
  };
}

// A model picker's provider (OpenCode's providers, API keys): the Codex pool's share free at its reset (the account menus' figure),
// an API key's balance (paid per token, nothing resets), or "Unknown" with the reason for a provider Space reads no quota for.
const modelProviderApi: Record<string, string> = { openrouter: "openrouter", deepseek: "deepseek", openai: "openai", anthropic: "anthropic", "space-gateway-claude": "anthropic" };
export function modelProviderAvailability(providerId: string, quota: SharedQuotaCache | null, clock: number): CliAccountAvailability {
  // Space Gateway's OpenAI-compatible provider serves the ChatGPT (Codex) pool; OpenCode's Claude Agent runs Claude Code on
  // Space Gateway, which serves Claude Code from the Claude Max accounts only (plan clipboard:93WlxXgZhOkv).
  const claudeAgent = providerId === "claude-agent";
  if (providerId === "space-gateway" || providerId === "codex-lb" || claudeAgent) {
    const room = !quota ? identityAvailability(null) : claudeAgent
      ? cliAccountAvailability({ runtimeId: "cli:claude", profileId: GATEWAY_PROFILE_ID, quota, identity: null, clock })
      : codexGatewayAvailability(quota.codex, clock);
    const forecast = cliAccountForecasts(claudeAgent ? "cli:claude" : "cli:codex", quota, clock)[0]!;
    return { ...room, label: cliAccountForecastText(forecast), color: forecast.percent === null ? room.color : forecast.color,
      description: `${cliAccountForecastText(forecast)}${forecast.reason ? ` (${forecast.reason})` : " at this pace"} · ${room.description}` };
  }
  const apiId = modelProviderApi[providerId];
  if (!apiId) {
    return { tone: "pending", percent: null, color: CLI_ACCOUNT_PENDING_COLOR, label: "Unknown free at reset",
      description: `${providerId || "This provider"} reports no quota to Space, so its share free at reset is unknown`, windows: [] };
  }
  if (!quota) return identityAvailability(null);
  const account = quota.api?.data.find((candidate) => candidate.providerId === apiId);
  const room = apiProviderAvailability(account);
  if (account?.status !== "CONNECTED") return room;
  // The Claude API key without prepaid credits is paced to Space Gateway's monthly budget, which renews on the 1st (UTC).
  if (apiId === "anthropic" && !account.balance && account.remainingPercent != null) {
    const now = new Date(clock);
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    const left = quotaLeftAtReset([{ remaining: account.remainingPercent, resetAt: new Date(reset).toISOString(), periodMs: reset - start }], clock);
    if (left) {
      const text = `${Math.round(left.percent)}% free ${cliResetWhen(left.resetAt, clock)}`;
      return { ...room, label: text, color: left.percent >= 1 ? cliAccountAvailabilityColor(left.percent) : CLI_ACCOUNT_BLOCKED_COLOR,
        description: `${text}: the monthly budget left when it renews, at this pace · ${room.description}` };
    }
  }
  // Prepaid credits are spent down and never renew.
  return { ...room, label: `${room.label} · no reset`, description: `Prepaid balance, it does not reset · ${room.description}` };
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
    const account = quota?.agy?.data.find((candidate) => candidate.id === profileId)
      ?? quota?.agy?.outOfRotation?.find((candidate) => candidate.id === profileId);
    const tier = account?.tier?.trim();
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
