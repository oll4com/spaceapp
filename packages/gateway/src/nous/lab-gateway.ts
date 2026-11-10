import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { claudeCostUsd, type ClaudeCostUsage } from "../pricing/pricing.js";
import { selectAccount, type AccountState } from "../router/balancer.js";
import { admit, settle, type PoolPressure, type TrafficClass } from "./ledger.js";
import type { TenantKey, TenantKeyResolver } from "./tenant-keys.js";

/**
 * One Nous Gateway turn in the lab (plan clipboard:_0qBSFCftZuD step 3): tenant key → the tenant's pool → admission on the shared
 * ledger → the Space Gateway's own `selectAccount` (weekly pace, 85% five-hour soft cap, 3% floor) inside that pool → provider →
 * settlement at `pricing.ts` list cost. Synthetic accounts and a mocked provider only; nothing here is wired into `server.ts`.
 * shortcut: Claude-format usage only and no in-pool failover (the proxies' 3-account failover is reused when this joins them in K5).
 */
export interface PoolAccount extends AccountState {
  pool: string;
  provider: string;
  /** List value one full 5-hour window of this account serves (a lab fixture; production derives it from measured windows). */
  fiveHourCapacityMicros: number;
}

/** Trials and NEW-risk tenants get their own pool, so pressure there never reaches paying users; a region's pools are its own. */
export const tenantPool = (key: Pick<TenantKey, "plan" | "region" | "riskTier">) =>
  `${key.region}:${key.plan === "TRIAL" || key.riskTier === "NEW" ? "trial" : "paid"}`;

/** Sticky binding per (tenant, session): two tenants sending the same session id never share an account binding. */
export const tenantStickyKey = (tenantId: string, provider: string, sessionId: string) =>
  createHash("sha256").update(`${tenantId}:${provider}:${sessionId}`).digest("hex");

export function poolPressure(accounts: readonly PoolAccount[]): PoolPressure {
  const healthy = accounts.filter((account) => account.status === "ACTIVE");
  if (healthy.length === 0) return { fiveHourMeanPercent: 100, roomMicros: 0 };
  const used = (account: PoolAccount) => Math.min(100, Math.max(0, account.usedPercent ?? 0));
  return {
    fiveHourMeanPercent: healthy.reduce((sum, account) => sum + used(account), 0) / healthy.length,
    roomMicros: Math.floor(healthy.reduce((sum, account) => sum + (100 - used(account)) / 100 * account.fiveHourCapacityMicros, 0))
  };
}

export const LAB_COST_RESERVE_MICROS = 200_000; // the Space Gateway's $0.20 reserve per request (SPACE_GATEWAY_COST_RESERVE_MICROS)

/** The admission estimate: the input at list price plus the reserve; null for a model `pricing.ts` cannot price. */
export function estimateMicros(model: string, inputTokens: number): number | null {
  const input = claudeCostUsd({ inputTokens, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, model);
  return input === null ? null : Math.ceil(input * 1e6) + LAB_COST_RESERVE_MICROS;
}

/** The user's limit message names a time, never accounts or how many there are (install plan §3.4). */
export const continuesAt = (at: Date) => `Your AI continues at ${at.toISOString().slice(11, 16)} UTC.`;

export type LabProvider = (account: PoolAccount, request: { model: string; inputTokens: number }) => Promise<{ usage: ClaudeCostUsage }>;
export type TurnResult =
  | { status: 200; requestId: string; accountId: string; costMicros: number }
  | { status: 400 | 401 | 429 | 502; message: string; retryAt?: Date };

export async function serveTenantTurn(deps: { app: pg.Pool; resolver: TenantKeyResolver; accounts: readonly PoolAccount[]; provider: LabProvider; now?: () => Date },
  request: { presentedKey: string; model: string; inputTokens: number; trafficClass?: TrafficClass; requestId?: string }): Promise<TurnResult> {
  const key = await deps.resolver.resolve(request.presentedKey);
  if (!key) return { status: 401, message: "Invalid, revoked or frozen key." };
  const estimate = estimateMicros(request.model, request.inputTokens);
  if (estimate === null) return { status: 400, message: `Model '${request.model}' is not available.` };
  const now = deps.now?.() ?? new Date();
  const pool = tenantPool(key);
  const accounts = deps.accounts.filter((account) => account.pool === pool && account.provider === "claude");
  const requestId = request.requestId ?? `ngwreq:${randomUUID()}`;
  const trafficClass = request.trafficClass ?? "FOREGROUND";
  const admission = await admit(deps.app, { requestId, key, pool, trafficClass, estimateMicros: estimate, pressure: poolPressure(accounts), now });
  if (!admission.admitted) {
    return { status: 429, message: admission.retryAt ? continuesAt(admission.retryAt) : "Your included AI is not active.", ...(admission.retryAt ? { retryAt: admission.retryAt } : {}) };
  }
  const finish = (accountId: string | null, status: "OK" | "ERROR", costMicros: number, usage?: ClaudeCostUsage) => settle(deps.app, {
    requestId, key, pool, accountId, provider: "claude", model: request.model, trafficClass, status, costMicros, now,
    inputTokens: usage?.inputTokens ?? 0, cachedInputTokens: usage?.cacheReadInputTokens ?? 0, cacheWriteTokens: usage?.cacheCreationInputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0
  });
  const selection = selectAccount(accounts, { now: now.getTime() / 1000, weeklyPace: true });
  if (!selection.account) {
    await finish(null, "ERROR", 0);
    const retryAt = new Date(selection.resetsAt ? selection.resetsAt * 1000 : now.getTime() + 300_000);
    return { status: 429, message: continuesAt(retryAt), retryAt };
  }
  const account = selection.account as PoolAccount;
  try {
    const { usage } = await deps.provider(account, { model: request.model, inputTokens: request.inputTokens });
    const cost = claudeCostUsd(usage, request.model);
    // Usage the provider did not report is charged at the reservation, so the hard cap never misses a request.
    const costMicros = cost === null ? estimate : Math.round(cost * 1e6);
    await finish(account.accountId, "OK", costMicros, usage);
    return { status: 200, requestId, accountId: account.accountId, costMicros };
  } catch {
    await finish(account.accountId, "ERROR", 0);
    return { status: 502, message: "The AI did not answer; try again." };
  }
}
