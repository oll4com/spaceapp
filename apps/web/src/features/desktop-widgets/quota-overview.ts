import type { AccountQuotaEntry, AvailabilityCounts } from "../toolbar-metrics/AccountQuotaCards.js";
import { countAvailability } from "../toolbar-metrics/AccountQuotaCards.js";
import { compareAvailability } from "../toolbar-metrics/account-availability.js";
import { antigravityAccountEntries, claudeAccountEntries, codexAccountEntries } from "../toolbar-metrics/account-entries.js";
import type { SharedQuotaCache } from "./shared-quota-cache.js";

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

function providerOverview(provider: QuotaProvider, entries: AccountQuotaEntry[]): ProviderQuotaOverview {
  const rows = entries.filter((entry) => entry.availability.state !== "offline").flatMap((entry) => entry.rows);
  const label = quotaProviderLabels[provider];
  return {
    provider,
    label,
    entries: [...entries].sort(compareAvailability),
    counts: countAvailability(entries),
    fiveHourAverage: average(rows.map((row) => row.quota.fiveHourRemainingPercent)),
    weeklyAverage: average(rows.map((row) => row.quota.weeklyRemainingPercent)),
    next: nextBack(entries.map((entry) => ({ entry, provider: label }))),
  };
}

export function buildQuotaOverview(cache: SharedQuotaCache | null, clock: number): QuotaOverview {
  const providers = [
    providerOverview("codex", codexAccountEntries(cache?.codex?.data ?? [], clock)),
    providerOverview("antigravity", antigravityAccountEntries(cache?.agy?.data ?? [], clock, { proOnly: false, geminiOnly: false })),
    providerOverview("claude", claudeAccountEntries(cache?.claude?.data ?? [], clock)),
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
