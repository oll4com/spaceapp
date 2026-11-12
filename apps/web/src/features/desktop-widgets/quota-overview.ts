import { claudeSubscriptionAccounts, subscriptionQuotaAtReset, type QuotaLeftAtReset, type QuotaResetCredits } from "@space/contracts";
import type { AccountQuotaEntry, AvailabilityCounts } from "../toolbar-metrics/AccountQuotaCards.js";
import { countAvailability } from "../toolbar-metrics/AccountQuotaCards.js";
import { compareAvailability } from "../toolbar-metrics/account-availability.js";
import { antigravityAccountEntries, claudeAccountEntries, codexAccountEntries } from "../toolbar-metrics/account-entries.js";
import type { SharedQuotaCache } from "./shared-quota-cache.js";
import type { QuotaWindows } from "../toolbar-metrics/account-availability.js";

// The AI Quota & Usage widget reads the same account cards as Resources > Accounts & quotas
// and condenses them into provider summaries and the reset alert's watch list.
export type QuotaProvider = "codex" | "antigravity" | "claude";
export type QuotaAlertProvider = "all" | "codex" | "gemini" | "claude";

export const quotaProviderLabels: Record<QuotaProvider, string> = {
  codex: "Codex",
  antigravity: "Antigravity",
  claude: "Claude",
};

export interface NextAccountBack {
  title: string;
  provider: string;
  backAt: string;
}

export interface ProviderQuotaOverview {
  provider: QuotaProvider;
  label: string;
  entries: AccountQuotaEntry[];
  counts: AvailabilityCounts;
  fiveHourAverage: number | null;
  weeklyAverage: number | null;
  // Each window's next reset still ahead among the accounts that report it (operator 6/11: the Nous dock's card says when).
  fiveHourResetAt: string | null;
  weeklyResetAt: string | null;
  // The share free at the weekly reset, the pane account menu's figure.
  atReset: ProviderAtReset;
  next: NextAccountBack | null;
}

export interface QuotaOverview {
  providers: ProviderQuotaOverview[];
  // Every account across providers, its provider named first in the card details.
  entries: AccountQuotaEntry[];
  counts: AvailabilityCounts;
  next: NextAccountBack | null;
}

export interface WatchedQuota {
  available: number;
  total: number;
  availableAccounts: Array<{ title: string; provider: string; fiveHourPercent: number | null; weeklyPercent: number | null }>;
  next: NextAccountBack | null;
}

function average(values: Array<number | null | undefined>): number | null {
  const known = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : null;
}

function nextBack(entries: Array<{ entry: AccountQuotaEntry; provider: string }>): NextAccountBack | null {
  let best: NextAccountBack | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const { entry, provider } of entries) {
    const state = entry.availability.state;
    if ((state !== "soon" && state !== "exhausted") || !entry.availability.backAt) continue;
    const ms = Date.parse(entry.availability.backAt);
    if (Number.isFinite(ms) && ms < bestMs) {
      bestMs = ms;
      best = { title: entry.title, provider, backAt: entry.availability.backAt };
    }
  }
  return best;
}

export type QuotaAtResetEntry = QuotaLeftAtReset & { scope: string | null; resetCredits?: QuotaResetCredits };

export interface ProviderAtReset {
  entries: QuotaAtResetEntry[];
  // Why there is no figure, when there is none: "no connected account", "no weekly usage reported", ...
  unknown: string | null;
}

type WeeklySample = { weeklyRemainingPercent?: number | null; weeklyResetAt?: string | null };

/**
 * quotaLeftAtReset over one provider's subscription accounts, counted as the pane account menus count them (subscriptionQuotaAtReset),
 * and, when no account has a live week, why not.
 */
export function providerQuotaAtReset(provider: QuotaProvider, cache: Pick<SharedQuotaCache, "codex" | "agy" | "claude"> | null, clock: number): ProviderAtReset {
  const list = provider === "codex" ? cache?.codex : provider === "claude" ? cache?.claude : cache?.agy;
  const entries = subscriptionQuotaAtReset(provider, list?.data ?? [], clock);
  if (entries.length) return { entries, unknown: null };
  if (!list) return { entries, unknown: "not read yet" };
  const counted: WeeklySample[] = provider === "codex" ? cache?.codex?.data ?? []
    : provider === "claude" ? claudeSubscriptionAccounts(cache?.claude?.data ?? [])
      : (cache?.agy?.data ?? []).filter((account) => account.status === "CONNECTED").flatMap((account) => [account.gemini, account.claude]);
  const weeks = counted.filter((week) => week.weeklyRemainingPercent != null);
  const unknown = !counted.length ? (provider === "codex" ? "no account reported" : provider === "claude" ? "no subscription account" : "no connected account")
    : !weeks.length ? "no weekly usage reported"
      : weeks.every((week) => !week.weeklyResetAt) ? "no weekly reset time reported" : "weekly sample out of date";
  return { entries, unknown };
}

function nextReset(windows: QuotaWindows[], percent: "fiveHourRemainingPercent" | "weeklyRemainingPercent", reset: "fiveHourResetAt" | "weeklyResetAt", clock: number): string | null {
  const next = Math.min(...windows.filter((window) => window[percent] != null).map((window) => Date.parse(window[reset] ?? "")).filter((ms) => ms > clock));
  return Number.isFinite(next) ? new Date(next).toISOString() : null;
}

function providerOverview(provider: QuotaProvider, entries: AccountQuotaEntry[], cache: SharedQuotaCache | null, clock: number): ProviderQuotaOverview {
  // Claude: each subscription account once, the Space Gateway pool's accounts included (the pool card alone has no rows).
  const windows: QuotaWindows[] = provider === "claude" ? claudeSubscriptionAccounts(cache?.claude?.data ?? [])
    : entries.filter((entry) => entry.availability.state !== "offline").flatMap((entry) => entry.rows.map((row) => row.quota));
  const label = quotaProviderLabels[provider];
  return {
    provider,
    label,
    entries: [...entries].sort(compareAvailability),
    counts: countAvailability(entries),
    fiveHourAverage: average(windows.map((window) => window.fiveHourRemainingPercent)),
    weeklyAverage: average(windows.map((window) => window.weeklyRemainingPercent)),
    fiveHourResetAt: nextReset(windows, "fiveHourRemainingPercent", "fiveHourResetAt", clock),
    weeklyResetAt: nextReset(windows, "weeklyRemainingPercent", "weeklyResetAt", clock),
    atReset: providerQuotaAtReset(provider, cache, clock),
    next: nextBack(entries.map((entry) => ({ entry, provider: label }))),
  };
}

export function buildQuotaOverview(cache: SharedQuotaCache | null, clock: number): QuotaOverview {
  const providers = [
    providerOverview("codex", codexAccountEntries(cache?.codex?.data ?? [], clock), cache, clock),
    providerOverview("antigravity", antigravityAccountEntries(cache?.agy?.data ?? [], clock, { proOnly: false, geminiOnly: false }), cache, clock),
    providerOverview("claude", claudeAccountEntries(cache?.claude?.data ?? [], clock), cache, clock),
  ].filter((overview) => overview.entries.length > 0);
  const tagged = providers.flatMap((overview) => overview.entries.map((entry) => ({ entry, provider: overview.label })));
  return {
    providers,
    entries: tagged
      .map(({ entry, provider }) => ({ ...entry, id: `${provider}:${entry.id}`, details: [provider, ...entry.details] }))
      .sort(compareAvailability),
    counts: countAvailability(tagged.map(({ entry }) => entry)),
    next: nextBack(tagged),
  };
}

// "Pro only" keeps the former reminder's meaning: Codex Pro plans and Google AI Pro tiers.
// Claude accounts are all paid team or Max plans and are always watched.
export function watchedQuota(
  cache: SharedQuotaCache | null,
  clock: number,
  options: { provider: QuotaAlertProvider; proOnly: boolean },
): WatchedQuota {
  const watchCodex = options.provider === "all" || options.provider === "codex";
  const watchGemini = options.provider === "all" || options.provider === "gemini";
  const watchClaude = options.provider === "all" || options.provider === "claude";
  const codex = (cache?.codex?.data ?? []).filter((account) =>
    !options.proOnly || !account.planType || account.planType.toLowerCase().includes("pro"));
  const watched = [
    ...(watchCodex ? codexAccountEntries(codex, clock).map((entry) => ({ entry, provider: "Codex" })) : []),
    ...(watchGemini
      ? antigravityAccountEntries(cache?.agy?.data ?? [], clock, { proOnly: options.proOnly, geminiOnly: true })
        .map((entry) => ({ entry, provider: "Gemini" }))
      : []),
    // The Space Gateway profile routes to accounts already listed here; counting it would count them twice.
    ...(watchClaude
      ? claudeAccountEntries((cache?.claude?.data ?? []).filter((account) => account.status !== "GATEWAY"), clock)
        .map((entry) => ({ entry, provider: "Claude" }))
      : []),
  ].filter(({ entry }) => entry.availability.state !== "offline" && entry.availability.state !== "unknown");
  const available = watched.filter(({ entry }) => entry.availability.state === "available");
  return {
    available: available.length,
    total: watched.length,
    availableAccounts: available.map(({ entry, provider }) => ({
      title: entry.title,
      provider,
      fiveHourPercent: entry.rows[0]?.quota.fiveHourRemainingPercent ?? null,
      weeklyPercent: entry.rows[0]?.quota.weeklyRemainingPercent ?? null,
    })),
    next: nextBack(watched),
  };
}
