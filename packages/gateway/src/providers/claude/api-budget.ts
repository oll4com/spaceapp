import type { GatewayAnthropicBillingReport, GatewayApiBudgetPace, GatewaySettings } from "@space/contracts";
import type { GatewayRepository } from "@space/db";
import { anthropicBillingReport } from "../../anthropic-billing.js";

/**
 * The Claude API-key account paced to the operator's monthly budget (plan clipboard:nUloPOH3blDT step 6; operator 27/10: use the
 * month's API budget fully, never above it). Spend is the Accounts card's figure: Anthropic's posted days, the gateway's estimate
 * for days not posted yet (UTC month). Today's allowance is what the month has left before today, shared over the days left with
 * today included, so the last day gets the whole remainder. The key's own daily cap still applies: the lower limit wins.
 */
export const MONTHLY_BUDGET_REACHED = "MONTHLY_BUDGET_REACHED";
export const DAILY_ALLOWANCE_REACHED = "DAILY_ALLOWANCE_REACHED";

const round = (value: number) => Math.round(value * 100) / 100;

/** The pace from the billing report's days; null with no budget (unset or 0: the feature is off). */
export function apiBudgetPace(budgetUsd: number | null | undefined, days: GatewayAnthropicBillingReport["days"], now: number, extraTodayUsd = 0): GatewayApiBudgetPace | null {
  if (!budgetUsd || budgetUsd <= 0) return null;
  const date = new Date(now);
  const today = date.toISOString().slice(0, 10);
  const spent = (day: GatewayAnthropicBillingReport["days"][number]) => day.reported ? day.organizationUsd : day.gatewayEstimateUsd;
  const month = days.filter((day) => day.day.startsWith(today.slice(0, 7)));
  const todaySpentUsd = (month.find((day) => day.day === today) ? spent(month.find((day) => day.day === today)!) : 0) + extraTodayUsd;
  const monthSpentUsd = month.filter((day) => day.day !== today).reduce((sum, day) => sum + spent(day), 0) + todaySpentUsd;
  const daysLeft = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate() - date.getUTCDate() + 1;
  const remainingUsd = budgetUsd - monthSpentUsd;
  const allowanceTodayUsd = Math.max(0, budgetUsd - (monthSpentUsd - todaySpentUsd)) / daysLeft;
  const stop = remainingUsd <= 0 ? MONTHLY_BUDGET_REACHED : todaySpentUsd >= allowanceTodayUsd ? DAILY_ALLOWANCE_REACHED : null;
  return { budgetUsd, monthSpentUsd: round(monthSpentUsd), remainingUsd: round(remainingUsd), daysLeft, allowanceTodayUsd: round(allowanceTodayUsd),
    todaySpentUsd: round(todaySpentUsd), stop };
}

/**
 * The pace as the proxy and the admin status see it (null without a budget or without Anthropic billing set up: no month figure),
 * read again every `ttlMs` (the report aggregates the month's request logs): between reads, what the API-key
 * account spent is added to today's spend, so a burst cannot outrun the cache.
 */
export function createApiBudgetPacer(deps: { repository: GatewayRepository; settings: () => Promise<GatewaySettings>; now?: () => number; ttlMs?: number }) {
  const now = deps.now ?? Date.now;
  let cached: { at: number; day: string; days: GatewayAnthropicBillingReport["days"]; budgetUsd: number | null; configured: boolean } | null = null;
  let since = 0;
  return {
    async read(): Promise<GatewayApiBudgetPace | null> {
      const at = now();
      const day = new Date(at).toISOString().slice(0, 10);
      if (!cached || cached.day !== day || at - cached.at >= (deps.ttlMs ?? 60_000)) {
        const budgetUsd = (await deps.settings()).anthropicMonthlyBudgetUsd;
        const report = budgetUsd ? await anthropicBillingReport(deps.repository, new Date(at).getUTCDate(), at) : null;
        cached = { at, day, days: report?.days ?? [], budgetUsd, configured: report?.status.configured ?? false };
        since = 0;
      }
      return cached.configured ? apiBudgetPace(cached.budgetUsd, cached.days, at, since) : null;
    },
    /** A request the API-key account served (its estimate), counted until the next read of the report. */
    record(costUsd: number | null) { if (costUsd && costUsd > 0) since += costUsd; }
  };
}

export function apiBudgetMessage(pace: GatewayApiBudgetPace): string {
  const usd = (value: number) => `$${value.toFixed(2)}`;
  return pace.stop === MONTHLY_BUDGET_REACHED
    ? `The Claude API key reached this month's API budget (${usd(pace.monthSpentUsd)} of ${usd(pace.budgetUsd)}); it serves again next month.`
    : `The Claude API key reached today's share of the monthly API budget (${usd(pace.todaySpentUsd)} of ${usd(pace.allowanceTodayUsd)} today; ${usd(pace.remainingUsd)} left for ${pace.daysLeft} day${pace.daysLeft === 1 ? "" : "s"}); it serves again after 00:00 UTC.`;
}
