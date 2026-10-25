import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { startAccountUsagePoller } from "../../accounts/usage-poller.js";
import { isClaudeApiKeyAccount } from "./api-key.js";
import { ClaudeUsageError, fetchClaudeUsage, type ClaudeUsage } from "./usage.js";

const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;

export async function storeClaudeUsage(repository: GatewayRepository, account: GatewayAccountRecord, usage: ClaudeUsage): Promise<void> {
  await repository.saveUsageWindows(account.id, [
    ...(usage.fiveHourUsedPercent !== null ? [{ window: "PRIMARY" as const, usedPercent: usage.fiveHourUsedPercent, resetAt: usage.fiveHourResetAt, windowMinutes: FIVE_HOURS_MINUTES }] : []),
    ...(usage.weeklyUsedPercent !== null ? [{ window: "SECONDARY" as const, usedPercent: usage.weeklyUsedPercent, resetAt: usage.weeklyResetAt, windowMinutes: WEEK_MINUTES }] : [])
  ]);
}

export async function refreshClaudeAccountUsage(input: {
  repository: GatewayRepository; pool: AccountPool; account: GatewayAccountRecord; fetchImpl?: typeof fetch;
}): Promise<ClaudeUsage> {
  const credentials = await input.pool.credentials(input.account);
  const usage = await fetchClaudeUsage(credentials.accessToken, input.fetchImpl);
  await storeClaudeUsage(input.repository, input.account, usage);
  input.pool.invalidate();
  return usage;
}

export function startClaudeUsagePoller(input: {
  repository: GatewayRepository; pool: AccountPool; intervalMs: number; fetchImpl?: typeof fetch;
  onError?: (accountId: string, error: unknown) => void;
}) {
  return startAccountUsagePoller({
    pool: input.pool, intervalMs: input.intervalMs, onError: input.onError,
    // An API key has no plan usage to read; the OAuth usage endpoint would only reject it.
    refresh: (account) => isClaudeApiKeyAccount(account) ? Promise.resolve(null)
      : refreshClaudeAccountUsage({ repository: input.repository, pool: input.pool, account, fetchImpl: input.fetchImpl }),
    isAuthError: (error) => error instanceof ClaudeUsageError && (error.statusCode === 401 || error.statusCode === 403),
    isTokenRejected: (error) => error instanceof ClaudeUsageError && error.statusCode === 401
  });
}
