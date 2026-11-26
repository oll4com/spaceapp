import { isGatewayFreePlan, type GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import type { StickyStore } from "../../accounts/sticky-store.js";
import { selectAccount, type AccountState } from "../../router/balancer.js";
import { antigravityModelRequiresPaidPlan, type AntigravityQuotaGroup } from "./code-assist.js";
import { parseResetsIn } from "./stream.js";

type Json = Record<string, unknown>;

/**
 * Account choice and failure bookkeeping for calls on the Antigravity pool, shared by the Antigravity proxy and the
 * image route: the sticky account while it has budget and supports the model's plan tier, else the routing strategy's
 * pick within the model's quota group. Models offered only on paid plans skip free-plan accounts.
 */
export function createAntigravityPoolAccess(options: { pool: AccountPool; repository: GatewayRepository; sticky: StickyStore; now: () => number }) {
  const { pool, sticky, now } = options;

  async function pick(group: AntigravityQuotaGroup, tried: Set<string>, stickyHash: string | null, settings: GatewaySettings,
    scope: ReadonlySet<string> | null = null, model: string | null = null): Promise<GatewayAccountRecord | undefined> {
    const inScope = (await pool.accounts()).filter((account) => !tried.has(account.id) && (!scope || scope.has(account.id)));
    const paidOnly = antigravityModelRequiresPaidPlan(model);
    const accounts = paidOnly ? inScope.filter((account) => !isGatewayFreePlan(account.planType)) : inScope;
    if (accounts.length === 0) return undefined;
    const nowSec = now() / 1000;
    const windowExhausted = (used: number | null | undefined, resetAt: number | null | undefined) =>
      (used ?? 0) >= 100 && (resetAt === null || resetAt === undefined || resetAt > nowSec);
    const groupExhausted = (state: AccountState) =>
      (!isGatewayFreePlan(state.planType) && windowExhausted(state.usedPercent, state.primaryResetAt))
      || windowExhausted(state.secondaryUsedPercent, state.secondaryResetAt);
    const states = accounts.map((account) => pool.toBalancerState(account, group));
    const stickyId = stickyHash ? await sticky.get(stickyHash) : undefined;
    const stickyState = stickyId ? states.find((state) => state.accountId === stickyId) : undefined;
    if (stickyState && !groupExhausted(stickyState)) {
      const check = selectAccount([stickyState], { now: nowSec, routingStrategy: "SINGLE_ACCOUNT", allowUsageExhaustionError: false });
      const used = Math.max(stickyState.usedPercent ?? 0, stickyState.secondaryUsedPercent ?? 0);
      if (check.account && used < settings.stickyReallocationBudgetThresholdPercent) return accounts.find((account) => account.id === stickyState.accountId);
    }
    const openStates = states.filter((state) => !groupExhausted(state));
    const openPaidStates = openStates.filter((state) => !isGatewayFreePlan(state.planType));
    const selectFrom = (candidateStates: AccountState[]) => {
      const result = selectAccount(candidateStates, { now: nowSec, routingStrategy: settings.routingStrategy, preferEarlierReset: settings.preferEarlierReset });
      for (const state of candidateStates) pool.absorb(state);
      return result.account ? accounts.find((account) => account.id === result.account!.accountId) : undefined;
    };
    if (openPaidStates.length > 0) {
      const paid = selectFrom(openPaidStates);
      if (paid) return paid;
    }
    return selectFrom(openStates.length > 0 ? openStates : states);
  }

  /**
   * Notes what a failure says about the account. `failover`: another account may serve the request; `retryWith` (a 401
   * only): the same account once more with its refreshed token, or null when the refresh failed.
   */
  async function recordFailure(account: GatewayAccountRecord, group: AntigravityQuotaGroup, status: number, text: string):
    Promise<{ failover: boolean; retryWith?: GatewayAccountRecord | null }> {
    let message: string;
    try { message = String(((JSON.parse(text) as Json).error as Json | undefined)?.message ?? ""); } catch { message = text.slice(0, 300); }
    if (status === 429) {
      const resetIn = parseResetsIn(message);
      const quota = /quota|RESOURCE_EXHAUSTED/i.test(message) || text.includes("RESOURCE_EXHAUSTED");
      if (quota) {
        const resetAt = new Date(now() + (resetIn ?? 3600) * 1000).toISOString();
        const windows: Array<{ quotaKey: AntigravityQuotaGroup; window: "PRIMARY" | "SECONDARY"; usedPercent: number; resetAt: string; windowMinutes: number }> = [
          { quotaKey: group, window: "PRIMARY", usedPercent: 100, resetAt, windowMinutes: 300 }
        ];
        if (resetIn !== null && resetIn > 5 * 3600) {
          windows.push({ quotaKey: group, window: "SECONDARY", usedPercent: 100, resetAt, windowMinutes: 7 * 24 * 60 });
        }
        await options.repository.saveUsageWindows(account.id, windows);
        pool.invalidate();
      } else {
        pool.markTransientError(account.id);
      }
      return { failover: true };
    }
    if (status === 401) return { failover: true, retryWith: await pool.refreshRejectedToken(account, "token_invalidated") };
    // A free account answers 404 NOT_FOUND for a model offered only on paid plans: try another account.
    if (status === 404 && isGatewayFreePlan(account.planType)) return { failover: true };
    // Google suspends the account itself (25/11: every Pro-only call failed with this); retrying it only adds traffic, so it leaves rotation.
    if (status === 403 && /violation of Terms of Service|disabled in this account/i.test(message)) {
      await pool.markPermanentFailure(account, "account_suspended", false);
      return { failover: true };
    }
    if (status === 403 || status >= 500) {
      pool.markTransientError(account.id);
      return { failover: true };
    }
    return { failover: false };
  }

  return { pick, recordFailure };
}
