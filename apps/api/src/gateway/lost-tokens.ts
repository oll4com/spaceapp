import type { GatewayAccount, GatewayLostTokens, GatewayLostWindow } from "@space/contracts";
import type { GatewayAccountDayUsage, GatewayWeeklyPeak } from "@space/db";
import { quotaGroupForModel } from "@space/gateway";

/**
 * Lost tokens (operator 5/11 10:27 BKK, research 20261105-lost-tokens-november.md): the share of a weekly limit still unused at
 * its reset does not carry over. Per past weekly (SECONDARY) window of an account or quota group: lost % = 100 - the peak used %
 * sampled before the reset; tokens and API value per 1 % = what the account sent through Space Gateway over the 7 UTC days before
 * the reset's day, divided by that peak (the account's nearest measured window when that week has none). An estimate, not a bill.
 * Tokens are input (cache reads and writes included, as the daily rollups count them) plus output.
 * The one computation behind the Gateway report, Nous's space_ops_gateway "lost" view and Nous's score.
 */
export type LostTokensAccount = Pick<GatewayAccount, "id" | "label" | "alias" | "provider" | "planType" | "secondaryWindow" | "quotaGroups">;

const DAY_MS = 86_400_000;
const WEEK_MINUTES = 7 * 24 * 60;
// One reset reported seconds to an hour apart (Codex, Antigravity, Anthropic's rounding) is one window; weekly resets are days apart.
const RESET_JITTER_MS = 6 * 3_600_000;
// What was unused at a reset is known only from a sample near it: an account no longer polled (paused, signed out) stopped
// days before and would read as a false loss. Its window is counted as unobserved instead (polls run every few minutes).
const OBSERVED_BEFORE_RESET_MS = 6 * 3_600_000;

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const cents = (value: number) => Math.round(value * 100) / 100;
/** The UTC Monday of a time's week. */
export function lostWeekOf(at: string): string {
  const day = Date.parse(`${at.slice(0, 10)}T00:00:00Z`);
  return dayOf(day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS);
}

export function weeklyLostTokens(input: { from: string; to: string; now: number; accounts: LostTokensAccount[]; peaks: GatewayWeeklyPeak[];
  usage: GatewayAccountDayUsage[] }): GatewayLostTokens {
  const accounts = new Map(input.accounts.map((account) => [account.id, account]));
  // Peaks of one account and quota, oldest reset first, merged into windows.
  const series = new Map<string, GatewayWeeklyPeak[]>();
  for (const peak of [...input.peaks].sort((a, b) => a.resetAt.localeCompare(b.resetAt))) {
    // A removed account has no name or provider to report under.
    if (!accounts.has(peak.accountId)) continue;
    const key = `${peak.accountId}\0${peak.quotaKey}`;
    const windows = series.get(key) ?? [];
    const last = windows.at(-1);
    if (last && Date.parse(peak.resetAt) - Date.parse(last.resetAt) <= RESET_JITTER_MS) {
      windows[windows.length - 1] = { ...last, resetAt: peak.resetAt, usedPercent: Math.max(last.usedPercent, peak.usedPercent),
        lastSampleAt: peak.lastSampleAt > last.lastSampleAt ? peak.lastSampleAt : last.lastSampleAt };
    } else windows.push(peak);
    series.set(key, windows);
  }

  const usage = new Map<string, { tokens: number; costUsd: number }>();
  const addUsage = (key: string, row: GatewayAccountDayUsage) => {
    const entry = usage.get(key) ?? { tokens: 0, costUsd: 0 };
    usage.set(key, { tokens: entry.tokens + row.tokens, costUsd: entry.costUsd + row.costUsd });
  };
  for (const row of input.usage) {
    addUsage(`${row.accountId}\0\0${row.day}`, row);
    // A quota group (Antigravity's "claude", "gemini") draws only on its own models.
    if (accounts.get(row.accountId)?.quotaGroups?.length) addUsage(`${row.accountId}\0${quotaGroupForModel(row.model)}\0${row.day}`, row);
  }

  const windows: GatewayLostWindow[] = [];
  let unobserved = 0;
  for (const [key, peaks] of series) {
    const [accountId, quotaKey] = key.split("\0") as [string, string];
    const account = accounts.get(accountId)!;
    const minutes = (quotaKey ? account.quotaGroups?.find((group) => group.key === quotaKey)?.secondaryWindow : account.secondaryWindow)?.windowMinutes ?? WEEK_MINUTES;
    const past = peaks.filter((peak) => Date.parse(peak.resetAt) <= input.now);
    unobserved += past.filter((peak) => Date.parse(peak.resetAt) - Date.parse(peak.lastSampleAt) > OBSERVED_BEFORE_RESET_MS).length;
    const measured = past.filter((peak) => Date.parse(peak.resetAt) - Date.parse(peak.lastSampleAt) <= OBSERVED_BEFORE_RESET_MS).map((peak) => {
      const resetDay = Date.parse(`${peak.resetAt.slice(0, 10)}T00:00:00Z`);
      let tokens = 0;
      let costUsd = 0;
      for (let day = resetDay - Math.max(1, Math.round(minutes / 1440)) * DAY_MS; day < resetDay; day += DAY_MS) {
        const used = usage.get(`${key}\0${dayOf(day)}`);
        tokens += used?.tokens ?? 0;
        costUsd += used?.costUsd ?? 0;
      }
      const own = peak.usedPercent >= 1 && tokens > 0 ? { tokensPerPercent: tokens / peak.usedPercent, costUsdPerPercent: costUsd / peak.usedPercent } : null;
      return { peak, own };
    });
    for (const { peak, own } of measured) {
      const at = Date.parse(peak.resetAt);
      // Nearest in time; an earlier window wins a tie.
      const nearest = own ? null : measured.filter((other) => other.own).sort((a, b) =>
        Math.abs(Date.parse(a.peak.resetAt) - at) - Math.abs(Date.parse(b.peak.resetAt) - at) || a.peak.resetAt.localeCompare(b.peak.resetAt))[0]?.own ?? null;
      const rate = own ?? nearest;
      const lostPercent = Math.round(Math.max(0, 100 - peak.usedPercent) * 10) / 10;
      windows.push({ accountId, label: account.alias ?? account.label, provider: account.provider, planType: account.planType, quotaKey,
        week: lostWeekOf(peak.resetAt), resetAt: peak.resetAt, lastSampleAt: peak.lastSampleAt, usedPercent: peak.usedPercent, lostPercent,
        tokensPerPercent: rate ? Math.round(rate.tokensPerPercent) : null, costUsdPerPercent: rate ? cents(rate.costUsdPerPercent) : null,
        rateFrom: own ? "own" : nearest ? "nearest" : null,
        lostTokens: rate ? Math.round(lostPercent * rate.tokensPerPercent) : null, lostCostUsd: rate ? cents(lostPercent * rate.costUsdPerPercent) : null });
    }
  }
  windows.sort((a, b) => a.resetAt.localeCompare(b.resetAt) || a.label.localeCompare(b.label) || a.quotaKey.localeCompare(b.quotaKey));

  const sum = (rows: GatewayLostWindow[]) => ({ windows: rows.length, lostPercent: Math.round(rows.reduce((total, row) => total + row.lostPercent, 0) * 10) / 10,
    lostTokens: rows.reduce((total, row) => total + (row.lostTokens ?? 0), 0), lostCostUsd: cents(rows.reduce((total, row) => total + (row.lostCostUsd ?? 0), 0)),
    unpriced: rows.filter((row) => row.lostPercent > 0 && row.lostTokens === null).length });
  const weeks = new Map<string, GatewayLostWindow[]>();
  for (const row of windows) weeks.set(`${row.week}\0${row.provider}`, [...weeks.get(`${row.week}\0${row.provider}`) ?? [], row]);
  return { from: input.from, to: input.to, windows,
    weeks: [...weeks.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, rows]) => ({ week: key.split("\0")[0]!, provider: rows[0]!.provider, ...sum(rows) })),
    totals: { ...sum(windows), unobserved } };
}
