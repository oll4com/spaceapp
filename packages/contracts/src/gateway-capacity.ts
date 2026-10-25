import type { GatewayAccount, GatewayPool, GatewayPoolAccount, GatewayPoolWindow, GatewayProvider } from "./gateway.js";

/**
 * Account capacity in plan credits, after codex-lb (MIT, Soju06/codex-lb): each plan holds a number of credits per
 * window, an account's remaining credits are its capacity times its unused share, and a pool adds its accounts up.
 * Pools are reported in Plus-equivalents (Plus = 1, Pro Lite = 5, Pro = 20 in both windows), as the operator reads
 * them. Claude subscriptions form their own pool (Pro = 1, Max 5x = 5, Max 20x = 20); other providers count 1 per
 * account.
 */
export type GatewayCapacityWindow = "primary" | "secondary";

const PLUS_PRIMARY = 225;
const PLUS_SECONDARY = 7560;

const codexCredits: Record<string, [number, number]> = {
  free: [0, 1134], plus: [225, 7560], business: [225, 7560], team: [225, 7560], edu: [225, 7560], prolite: [1125, 37800],
  pro: [4500, 151200], enterprise: [1500, 50400]
};
const claudeMultiples: Record<string, number> = { free: 0, pro: 1, max5x: 5, max20x: 20, team: 1, enterprise: 5 };
const planAliases: Record<string, string> = {
  education: "edu", k12: "edu", guest: "free", go: "free", free_workspace: "free", quorum: "free", max: "max5x", "pro-lite": "prolite", pro_lite: "prolite"
};

function normalizedPlan(planType: string | null | undefined): string {
  const plan = (planType ?? "").trim().toLowerCase();
  return planAliases[plan] ?? plan;
}

/** Raw plan credits of one account for a window (codex-lb units: a Plus account holds 225 per 5h and 7560 per week). */
export function gatewayPlanCredits(provider: GatewayProvider, planType: string | null | undefined, window: GatewayCapacityWindow): number {
  const base = window === "primary" ? PLUS_PRIMARY : PLUS_SECONDARY;
  const plan = normalizedPlan(planType);
  if (provider === "CODEX") {
    const credits = codexCredits[plan] ?? codexCredits.plus!;
    return window === "primary" ? credits[0] : credits[1];
  }
  if (provider === "CLAUDE") return base * (claudeMultiples[plan] ?? 1);
  return base;
}

/** Plus-equivalents of a raw credit amount. */
export function gatewayPlusEquivalents(credits: number, window: GatewayCapacityWindow): number {
  return credits / (window === "primary" ? PLUS_PRIMARY : PLUS_SECONDARY);
}

interface WindowUsage { usedPercent: number | null; resetAt: string | null; windowMinutes: number | null }

/** The most used quota group stands for an account with several (Antigravity), else the account's own window. */
function accountWindow(account: GatewayAccount, window: GatewayCapacityWindow): WindowUsage {
  const own = window === "primary" ? account.primaryWindow : account.secondaryWindow;
  if (own.usedPercent !== null || !account.quotaGroups?.length) return own;
  const groups = account.quotaGroups.map((group) => (window === "primary" ? group.primaryWindow : group.secondaryWindow))
    .filter((item) => item.usedPercent !== null);
  return groups.sort((a, b) => (b.usedPercent ?? 0) - (a.usedPercent ?? 0))[0] ?? own;
}

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

/**
 * Used percent as the pool counts it: an account out of quota, or with its week used up, has no 5h capacity left
 * (codex-lb `apply_usage_quota` and `normalize_weekly_only_rows`). Unknown usage counts as unused.
 */
export function gatewayEffectiveUsedPercent(account: GatewayAccount, window: GatewayCapacityWindow): number | null {
  const own = accountWindow(account, window).usedPercent;
  if (window === "primary") {
    const weekly = accountWindow(account, "secondary").usedPercent;
    if (account.status === "QUOTA_EXCEEDED" || (weekly !== null && weekly >= 100)) return 100;
  }
  return own === null ? null : clampPercent(own);
}

/**
 * codex-lb burn projection for one account: the share of its window it will have used by the reset at the current
 * pace. Without a reset time it is the share used so far.
 */
export function gatewayProjectedUse(usedPercent: number, resetAt: string | null, windowMinutes: number | null, now: number,
  quotaExceeded = false): number {
  const used = clampPercent(usedPercent) / 100;
  let projected = used;
  if (resetAt && windowMinutes && windowMinutes > 0) {
    const windowSeconds = windowMinutes * 60;
    const untilReset = Math.max(0, (Date.parse(resetAt) - now) / 1000);
    const elapsed = windowSeconds - untilReset;
    projected = elapsed > 0 ? used * (windowSeconds / elapsed) : used;
  }
  return quotaExceeded ? Math.max(projected, 1) : projected;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** A pool's capacity and remaining Plus-equivalents for one window, with each account's share. */
export function gatewayPoolWindow(accounts: GatewayAccount[], window: GatewayCapacityWindow, now = Date.now()): GatewayPoolWindow {
  let capacity = 0;
  let remaining = 0;
  let burn = 0;
  let burnAccounts = 0;
  const resets: string[] = [];
  const rows: GatewayPoolAccount[] = [];
  for (const account of accounts) {
    const usage = accountWindow(account, window);
    const used = gatewayEffectiveUsedPercent(account, window);
    const credits = gatewayPlanCredits(account.provider, account.planType, window);
    let left = Math.max(0, credits - credits * (used ?? 0) / 100);
    if (window === "primary") {
      // A 5h window cannot hold more than the week has left.
      const weeklyCredits = gatewayPlanCredits(account.provider, account.planType, "secondary");
      const weeklyLeft = Math.max(0, weeklyCredits - weeklyCredits * (gatewayEffectiveUsedPercent(account, "secondary") ?? 0) / 100);
      left = Math.min(left, weeklyLeft);
    }
    capacity += credits;
    remaining += left;
    if (usage.resetAt) resets.push(usage.resetAt);
    if (used !== null && credits > 0) {
      burn += gatewayProjectedUse(used, usage.resetAt, usage.windowMinutes, now, window === "secondary" && account.status === "QUOTA_EXCEEDED");
      burnAccounts += 1;
    }
    rows.push({
      accountId: account.id, label: account.alias ?? account.label, planType: account.planType, status: account.status,
      capacityCredits: round2(gatewayPlusEquivalents(credits, window)), remainingCredits: round2(gatewayPlusEquivalents(left, window)),
      remainingPercent: credits > 0 ? round2((left / credits) * 100) : null, resetAt: usage.resetAt
    });
  }
  rows.sort((a, b) => b.capacityCredits - a.capacityCredits || a.label.localeCompare(b.label));
  return {
    capacityCredits: round2(gatewayPlusEquivalents(capacity, window)),
    remainingCredits: round2(gatewayPlusEquivalents(remaining, window)),
    remainingPercent: capacity > 0 ? round2((remaining / capacity) * 100) : null,
    resetAt: resets.sort()[0] ?? null,
    burnAccounts: burnAccounts > 0 ? round2(Math.max(0, Math.min(burnAccounts, burn))) : null,
    accounts: rows
  };
}

const pooledProviders: GatewayProvider[] = ["CODEX", "CLAUDE", "ANTIGRAVITY"];

/** Capacity pools per provider (accounts without usage windows, such as API keys, are left out); deactivated accounts do not count. */
export function gatewayPools(accounts: GatewayAccount[], now = Date.now()): GatewayPool[] {
  return pooledProviders.map((provider) => {
    const members = accounts.filter((account) => account.provider === provider && account.status !== "DEACTIVATED");
    return { provider, accounts: members.length, primary: gatewayPoolWindow(members, "primary", now), secondary: gatewayPoolWindow(members, "secondary", now) };
  }).filter((pool) => pool.accounts > 0);
}

/**
 * Remaining percent of the accounts a gateway key may use (its assigned accounts, or every account), without paused
 * and deactivated ones, as codex-lb shows next to each key. The 5h value is null when the pool has no 5h capacity.
 */
export function gatewayPooledRemaining(accounts: GatewayAccount[], scope: { accountScopeEnabled: boolean; accountIds: string[] }, now = Date.now()) {
  const members = accounts.filter((account) => (!scope.accountScopeEnabled || scope.accountIds.includes(account.id))
    && account.status !== "PAUSED" && account.status !== "DEACTIVATED" && pooledProviders.includes(account.provider));
  const primary = gatewayPoolWindow(members, "primary", now);
  const secondary = gatewayPoolWindow(members, "secondary", now);
  return {
    primaryRemainingPercent: primary.capacityCredits > 0 ? primary.remainingPercent : null,
    secondaryRemainingPercent: secondary.remainingPercent,
    accounts: members.length
  };
}
