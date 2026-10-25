import type { GatewayAccountRecord } from "@space/db";
import type { AccountPool } from "./account-pool.js";

/**
 * Keeps every usable account's provider-reported usage current, like codex-lb's usage updater, so routing and the
 * quota views see limits even for accounts that carried no traffic. Accounts are polled one at a time. Each read also
 * checks the account: a rejected sign-in is refreshed once and otherwise marked for a new sign-in (out of rotation),
 * and a limit whose time is over is stored as active again. Signed-out accounts wait for their new sign-in.
 */
export function startAccountUsagePoller(input: {
  pool: AccountPool;
  intervalMs: number;
  refresh: (account: GatewayAccountRecord) => Promise<unknown>;
  /** An authorization failure counts as an account error for routing. */
  isAuthError?: (error: unknown) => boolean;
  /** The provider rejected the account's access token (HTTP 401). */
  isTokenRejected?: (error: unknown) => boolean;
  onError?: (accountId: string, error: unknown) => void;
}): { stop(): void; runOnce(): Promise<number> } {
  let running = false;
  const runOnce = async () => {
    if (running) return 0;
    running = true;
    let refreshed = 0;
    try {
      const accounts = (await input.pool.accounts())
        .filter((account) => account.status !== "PAUSED" && account.status !== "DEACTIVATED" && !input.pool.isSignedOut(account));
      for (const account of accounts) {
        try {
          await input.refresh(account);
          refreshed += 1;
          await input.pool.liftExpiredBlock(account);
        } catch (error) {
          if (input.isTokenRejected?.(error)) await input.pool.refreshRejectedToken(account, "token_invalidated").catch(() => null);
          else if (input.isAuthError?.(error)) input.pool.markTransientError(account.id);
          input.onError?.(account.id, error);
        }
      }
    } finally {
      running = false;
    }
    return refreshed;
  };
  const timer = setInterval(() => { void runOnce(); }, input.intervalMs);
  timer.unref();
  const first = setTimeout(() => { void runOnce(); }, 15_000);
  first.unref();
  return { stop() { clearInterval(timer); clearTimeout(first); }, runOnce };
}
