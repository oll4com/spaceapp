import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayAccountRecord } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { fallbackSecondaryCapacityCredits } from "../../router/balancer.js";
import type { GatewayRouteHelpers } from "../../server.js";

/**
 * Pooled weekly Codex quota (`/api/codex/weekly-remaining`), after codex-lb's endpoint of the same name: credits are
 * each account's weekly capacity for its plan, used by its weekly window. Free accounts do not count. Space reads
 * `remaining_percent` and `active_accounts_count` to decide whether Codex can take a task. An account without weekly
 * usage stays out of the sums: counting it as unused showed spare capacity on exhausted accounts.
 */
const round2 = (value: number) => Math.round(value * 100) / 100;

/** An account that reports only its weekly window gets it in the primary slot (seen on Prolite). */
export function codexUsageWindows(account: Pick<GatewayAccountRecord, "primaryWindow" | "secondaryWindow">) {
  const weeklyOnly = account.secondaryWindow.usedPercent === null && (account.primaryWindow.windowMinutes ?? 0) >= 7 * 24 * 60;
  return weeklyOnly ? { fiveHour: null, weekly: account.primaryWindow } : { fiveHour: account.primaryWindow, weekly: account.secondaryWindow };
}
const weeklyUsedPercent = (account: GatewayAccountRecord) => codexUsageWindows(account).weekly.usedPercent;

export function registerWeeklyRemainingRoute(app: FastifyInstance, helpers: GatewayRouteHelpers, options: { pool: AccountPool; now?: () => number }) {
  const now = options.now ?? Date.now;
  async function weeklyRemaining(request: FastifyRequest, reply: FastifyReply) {
    if (!(await helpers.authenticate(request, reply))) return reply;
    const accounts = (await options.pool.accounts()).filter((account) => (account.planType ?? "").toLowerCase() !== "free");
    const active = accounts.filter((account) => {
      const state = options.pool.toBalancerState(account);
      const blocked = state.status !== "ACTIVE" && !(state.resetAt !== null && state.resetAt !== undefined && state.resetAt * 1000 <= now());
      return !blocked && (state.secondaryUsedPercent ?? 0) < 100;
    });
    const totals = (list: typeof accounts) => {
      let capacity = 0;
      let used = 0;
      for (const account of list) {
        const weekly = weeklyUsedPercent(account);
        if (weekly === null) continue;
        const credits = fallbackSecondaryCapacityCredits(account.planType);
        capacity += credits;
        used += credits * Math.min(100, Math.max(0, weekly)) / 100;
      }
      return { capacity: Math.round(capacity), used: Math.round(used) };
    };
    const average = (list: typeof accounts) => {
      const known = list.map(weeklyUsedPercent).filter((value): value is number => value !== null);
      return known.length === 0 ? null : round2(known.reduce((sum, value) => sum + (100 - value), 0) / known.length);
    };
    const all = totals(accounts);
    const pooled = totals(active);
    const usedPercent = all.capacity > 0 ? (all.used / all.capacity) * 100 : null;
    const resets = accounts.map((account) => account.secondaryWindow.resetAt).filter((value): value is string => Boolean(value)).sort();
    return {
      object: "space_gateway.weekly_remaining",
      window: "7d",
      window_key: "secondary",
      used_percent: usedPercent === null ? null : round2(usedPercent),
      remaining_percent: usedPercent === null ? null : round2(Math.max(0, 100 - usedPercent)),
      capacity_credits: all.capacity,
      used_credits: all.used,
      remaining_credits: Math.max(0, all.capacity - all.used),
      reset_at: resets[0] ?? null,
      all_accounts_remaining_percent: average(accounts),
      all_accounts_count: accounts.length,
      active_accounts_remaining_percent: average(active),
      active_accounts_count: active.length,
      active_pooled_used_percent: pooled.capacity > 0 ? round2((pooled.used / pooled.capacity) * 100) : null,
      active_pooled_remaining_percent: pooled.capacity > 0 ? round2(100 - (pooled.used / pooled.capacity) * 100) : null,
      active_capacity_credits: pooled.capacity,
      active_used_credits: pooled.used,
      active_remaining_credits: Math.max(0, pooled.capacity - pooled.used)
    };
  }
  // Space clients built the address from a base URL that already ends in /v1, so answer there too.
  for (const path of ["/api/codex/weekly-remaining", "/v1/api/codex/weekly-remaining"]) app.get(path, weeklyRemaining);
}
