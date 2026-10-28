import type { GatewayAccountRecord, GatewayRepository } from "@space/db";
import type { AccountPool } from "../../accounts/account-pool.js";
import { startAccountUsagePoller } from "../../accounts/usage-poller.js";
import { CodexUsageError, fetchCodexUsage, type CodexUsage } from "./usage.js";

const iso = (seconds: number | null) => (seconds ? new Date(seconds * 1000).toISOString() : null);
const minutes = (seconds: number | null) => (seconds ? Math.round(seconds / 60) : null);

/** Stores the provider-reported 5h/weekly usage of one Codex account and its current plan. */
export async function storeCodexUsage(repository: GatewayRepository, account: GatewayAccountRecord, usage: CodexUsage): Promise<void> {
  await repository.saveUsageWindows(account.id, [
    // No 5-hour window (a weekly-only plan): blank the slot an older parse filled with the week.
    ...(!usage.primary && usage.secondary ? [{ window: "PRIMARY" as const, usedPercent: null, resetAt: null, windowMinutes: null }] : []),
    ...(usage.primary ? [{ window: "PRIMARY" as const, usedPercent: usage.primary.usedPercent, resetAt: iso(usage.primary.resetAt), windowMinutes: minutes(usage.primary.limitWindowSeconds) }] : []),
    ...(usage.secondary ? [{ window: "SECONDARY" as const, usedPercent: usage.secondary.usedPercent, resetAt: iso(usage.secondary.resetAt), windowMinutes: minutes(usage.secondary.limitWindowSeconds) }] : [])
  ]);
  await repository.saveResetCredits(account.id, usage.resetCreditsAvailable);
  if (usage.planType && usage.planType !== account.planType) {
    await repository.withAccountCredentialLock(account.id, async () => ({ planType: usage.planType }));
  }
}

/** Whether the usage shows no used-up Codex limit, the per-model ones included. */
export function codexUsageClear(usage: CodexUsage): boolean {
  const used = [usage.primary, usage.secondary, ...usage.additional.flatMap((limit) => [limit.primary, limit.secondary])]
    .map((window) => window?.usedPercent ?? null).filter((value): value is number => value !== null);
  return used.length > 0 && used.every((value) => value < 100);
}

export async function refreshCodexAccountUsage(input: {
  repository: GatewayRepository; pool: AccountPool; account: GatewayAccountRecord; fetchImpl?: typeof fetch;
}): Promise<CodexUsage> {
  const credentials = await input.pool.credentials(input.account);
  const usage = await fetchCodexUsage({ accessToken: credentials.accessToken, accountId: credentials.upstreamAccountId, fetchImpl: input.fetchImpl, maxRetries: 1 });
  await storeCodexUsage(input.repository, input.account, usage);
  await input.pool.liftExpiredBlock(input.account, codexUsageClear(usage));
  input.pool.invalidate();
  return usage;
}

/** Polls every usable Codex account's usage in the background. */
export function startCodexUsagePoller(input: {
  repository: GatewayRepository; pool: AccountPool; intervalMs: number; fetchImpl?: typeof fetch;
  onError?: (accountId: string, error: unknown) => void;
}): { stop(): void; runOnce(): Promise<number> } {
  return startAccountUsagePoller({
    pool: input.pool, intervalMs: input.intervalMs, onError: input.onError,
    refresh: (account) => refreshCodexAccountUsage({ repository: input.repository, pool: input.pool, account, fetchImpl: input.fetchImpl }),
    isAuthError: (error) => error instanceof CodexUsageError && (error.statusCode === 401 || error.statusCode === 403),
    isTokenRejected: (error) => error instanceof CodexUsageError && error.statusCode === 401
  });
}
