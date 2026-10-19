import type { GatewaySettings } from "@space/contracts";
import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import type { StickyStore } from "../../accounts/sticky-store.js";
import { selectAccount } from "../../router/balancer.js";
import type { AntigravityQuotaGroup } from "./code-assist.js";
import { parseResetsIn } from "./stream.js";

type Json = Record<string, unknown>;

/**
 * Account choice and failure bookkeeping for calls on the Antigravity pool, shared by the Antigravity proxy and the
 * image route: the sticky account while it has budget, else the routing strategy's pick within the model's quota group.
 */
export function createAntigravityPoolAccess(options: { pool: AccountPool; repository: GatewayRepository; sticky: StickyStore; now: () => number }) {
  const { pool, sticky, now } = options;

  async function pick(group: AntigravityQuotaGroup, tried: Set<string>, stickyHash: string | null, settings: GatewaySettings): Promise<GatewayAccountRecord | undefined> {
    const accounts = (await pool.accounts()).filter((account) => !tried.has(account.id));
    const states = accounts.map((account) => pool.toBalancerState(account, group));
    const stickyId = stickyHash ? await sticky.get(stickyHash) : undefined;
    const stickyState = stickyId ? states.find((state) => state.accountId === stickyId) : undefined;
    if (stickyState) {
      const check = selectAccount([stickyState], { now: now() / 1000, routingStrategy: "SINGLE_ACCOUNT", allowUsageExhaustionError: false });
      const used = Math.max(stickyState.usedPercent ?? 0, stickyState.secondaryUsedPercent ?? 0);
      if (check.account && used < settings.stickyReallocationBudgetThresholdPercent) return accounts.find((account) => account.id === stickyState.accountId);
    }
    const result = selectAccount(states, { now: now() / 1000, routingStrategy: settings.routingStrategy, preferEarlierReset: settings.preferEarlierReset });
    for (const state of states) pool.absorb(state);
    return result.account ? accounts.find((account) => account.id === result.account!.accountId) : undefined;
  }

  /**
   * Notes what a failure says about the account. `failover`: another account may serve the request; `retryWith` (a 401
   * only): the same account once more with its refreshed token, or null when the refresh failed.
   */
  async function recordFailure(account: GatewayAccountRecord, group: AntigravityQuotaGroup, status: number, text: string):
    Promise<{ failover: boolean; retryWith?: GatewayAccountRecord | null }> {
    let message = "";
    try { message = String(((JSON.parse(text) as Json).error as Json | undefined)?.message ?? ""); } catch { message = text.slice(0, 300); }
    if (status === 429) {
      const resetIn = parseResetsIn(message);
      const quota = /quota|RESOURCE_EXHAUSTED/i.test(message) || text.includes("RESOURCE_EXHAUSTED");
      if (quota) {
        await options.repository.saveUsageWindows(account.id, [{ quotaKey: group, window: "PRIMARY", usedPercent: 100,
          resetAt: new Date(now() + (resetIn ?? 3600) * 1000).toISOString(), windowMinutes: 300 }]);
        pool.invalidate();
      } else {
        pool.markTransientError(account.id);
      }
      return { failover: true };
    }
    if (status === 401) return { failover: true, retryWith: await pool.refreshRejectedToken(account, "token_invalidated") };
    if (status === 403 || status >= 500) {
      pool.markTransientError(account.id);
      return { failover: true };
    }
    return { failover: false };
  }

  return { pick, recordFailure };
}
