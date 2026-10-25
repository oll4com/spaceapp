import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { startAccountUsagePoller } from "../../accounts/usage-poller.js";
import { CodeAssistError, fetchQuotaSummary, type AntigravityGroupUsage, type AntigravityQuotaGroup } from "./code-assist.js";

const FIVE_HOURS_MINUTES = 300;
const WEEK_MINUTES = 7 * 24 * 60;

/** Stores each quota group (Gemini, Claude/GPT) of an Antigravity account under its own quota key. */
export async function storeAntigravityUsage(repository: GatewayRepository, accountId: string, groups: Record<AntigravityQuotaGroup, AntigravityGroupUsage>) {
  const windows = [];
  for (const [quotaKey, usage] of Object.entries(groups)) {
    if (usage.fiveHourUsedPercent !== null) {
      windows.push({ quotaKey, window: "PRIMARY" as const, usedPercent: usage.fiveHourUsedPercent, resetAt: usage.fiveHourResetAt, windowMinutes: FIVE_HOURS_MINUTES });
    }
    if (usage.weeklyUsedPercent !== null) {
      windows.push({ quotaKey, window: "SECONDARY" as const, usedPercent: usage.weeklyUsedPercent, resetAt: usage.weeklyResetAt, windowMinutes: WEEK_MINUTES });
    }
  }
  if (windows.length > 0) await repository.saveUsageWindows(accountId, windows);
}

export async function refreshAntigravityAccountUsage(input: { repository: GatewayRepository; pool: AccountPool; account: GatewayAccountRecord; fetchImpl?: typeof fetch }) {
  const credentials = await input.pool.credentials(input.account);
  const groups = await fetchQuotaSummary(credentials.accessToken, credentials.upstreamAccountId, { fetchImpl: input.fetchImpl });
  await storeAntigravityUsage(input.repository, input.account.id, groups);
  input.pool.invalidate();
  return groups;
}

export function startAntigravityUsagePoller(input: { repository: GatewayRepository; pool: AccountPool; intervalMs: number; fetchImpl?: typeof fetch;
  onError?: (accountId: string, error: unknown) => void }) {
  return startAccountUsagePoller({
    pool: input.pool, intervalMs: input.intervalMs, onError: input.onError,
    refresh: (account) => refreshAntigravityAccountUsage({ repository: input.repository, pool: input.pool, account, fetchImpl: input.fetchImpl }),
    isAuthError: (error) => error instanceof CodeAssistError && (error.statusCode === 401 || error.statusCode === 403),
    isTokenRejected: (error) => error instanceof CodeAssistError && error.statusCode === 401
  });
}
