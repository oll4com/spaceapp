import {
  claudeSubscriptionAccounts,
  type AntigravityUsageAccount,
  type AntigravityUsageAccountList,
  type ApiProviderAccount,
  type ApiProviderAccountList,
  type ClaudeUsageAccountList,
  type CodexUsageAccount,
  type CodexUsageAccountList
} from "@space/contracts";

// Pure quota accounting shared by the AI quota widget and System Health.
// Kept free of React/UI imports so System Health does not pull the widget in.
export interface QuotaBreakdownItem {
  id: string;
  label: string;
  status?: string;
  tier?: string | null;
  weight?: number;
  fiveHourPercent: number | null;
  fiveHourResetAt?: string | null;
  weeklyPercent: number | null;
  weeklyResetAt?: string | null;
  subType?: "gemini" | "claude" | "codex" | "claude-max";
}

export function getCodexTierMultiplier(planType?: string | null): number {
  const norm = (planType || "").trim().toLowerCase();
  if (norm === "pro") return 20;
  if (norm === "prolite" || norm === "pro-lite" || norm === "pro_lite") return 5;
  if (norm === "plus") return 1;
  if (norm === "free") return 0;
  return 1;
}

export function getAntigravityTierMultiplier(tier?: string | null, status?: string): number {
  if (status === "UNLICENSED" || status === "EXPIRED" || status === "ERROR") return 0;
  const norm = (tier || "").trim().toLowerCase();
  if (norm.includes("pro") || norm.includes("ultra") || norm.includes("enterprise") || norm.includes("paid")) return 5;
  if (norm.includes("free")) return 0;
  return 1;
}


export interface ProviderQuotaMetrics {
  name: string;
  providerKey: "codex" | "gemini" | "claude" | "antigravity" | "claude-max" | "total";
  totalAccounts: number;
  activeAccounts: number;
  exhaustedAccounts: number;
  activeAccounts5h?: number;
  activeAccountsWeekly?: number;
  pool5h: number;
  available5h: number | null;
  percent5h: number | null;
  poolWeekly: number;
  availableWeekly: number | null;
  percentWeekly: number | null;
  accounts: QuotaBreakdownItem[];
}

export interface ApiProviderMetrics {
  name: string;
  totalProviders: number;
  connectedProviders: number;
  exhaustedProviders: number;
  unconfiguredProviders: number;
  errorProviders: number;
  totalBalanceUsd: number;
  providers: ApiProviderAccount[];
}

export interface AllQuotaAggregates {
  codex: ProviderQuotaMetrics;
  gemini: ProviderQuotaMetrics;
  claude: ProviderQuotaMetrics;
  antigravityCombined: ProviderQuotaMetrics;
  /** Claude Max subscription accounts (Claude Code profiles and the gateway's pool), each counted once. */
  claudeMax: ProviderQuotaMetrics;
  apiProviders: ApiProviderMetrics;
  totalAiPool: {
    pool5h: number;
    available5h: number | null;
    percent5h: number | null;
    poolWeekly: number;
    availableWeekly: number | null;
    percentWeekly: number | null;
    totalAccounts: number;
  };
  lastCheckedAt: string | null;
  isStale: boolean;
}

// The balance service lists every provider it knows; one without a key (UNCONFIGURED) is not in this installation
// (operator 5/11, plan clipboard:sJpyQIBFGszW). The pane account menus keep their "No key" rows: they read the list directly.
// Nothing left to spend stays out too (operator 6/11 21:49 BKK, nous_msg:71a41c2e: DeepSeek, OpenRouter, Vercel at $0 or below): EXHAUSTED, or a
// balance of $0 or less; it comes back by itself once it has credit again. A Gateway pool paused in Space Gateway is not listed by the API at all.
export function configuredApiProviders(apiList?: ApiProviderAccountList | null): ApiProviderAccount[] {
  return (apiList?.data ?? []).filter((account) => account.status !== "UNCONFIGURED" && account.status !== "EXHAUSTED" && !(dollars(account.balance) <= 0));
}
/** A "$12.34" / "$-3.20" balance as a number; NaN for none or another form ("Connected"), which never hides a row. */
const dollars = (balance: string | null | undefined) => balance?.startsWith("$") ? Number.parseFloat(balance.slice(1)) : Number.NaN;

export function computeApiProviderMetrics(apiList?: ApiProviderAccountList | null): ApiProviderMetrics {
  const accounts = configuredApiProviders(apiList);
  const total = accounts.length;
  const connected = accounts.filter((a) => a.status === "CONNECTED").length;
  const exhausted = accounts.filter((a) => a.status === "EXHAUSTED").length;
  const unconfigured = (apiList?.data ?? []).filter((a) => a.status === "UNCONFIGURED").length;
  const error = accounts.filter((a) => a.status === "ERROR").length;

  let totalBalanceUsd = 0;
  for (const acc of accounts) {
    if (acc.balance && acc.balance.startsWith("$")) {
      const num = parseFloat(acc.balance.slice(1));
      if (!isNaN(num)) totalBalanceUsd += num;
    }
  }

  return {
    name: "API Providers",
    totalProviders: total,
    connectedProviders: connected,
    exhaustedProviders: exhausted,
    unconfiguredProviders: unconfigured,
    errorProviders: error,
    totalBalanceUsd: Math.round(totalBalanceUsd * 100) / 100,
    providers: accounts
  };
}

export function computeQuotaAggregates(
  codexList?: CodexUsageAccountList | null,
  agyList?: AntigravityUsageAccountList | null,
  apiList?: ApiProviderAccountList | null,
  claudeList?: ClaudeUsageAccountList | null
): AllQuotaAggregates {
  const codexAccounts: CodexUsageAccount[] = codexList?.data ?? [];
  const agyAccounts: AntigravityUsageAccount[] = agyList?.data ?? [];
  const apiMetrics = computeApiProviderMetrics(apiList);

  // Codex metrics
  const codexItems: QuotaBreakdownItem[] = codexAccounts.map((a) => {
    const weight = getCodexTierMultiplier(a.planType);
    const isExceeded =
      (a.weeklyRemainingPercent !== null && a.weeklyRemainingPercent !== undefined && a.weeklyRemainingPercent <= 0) ||
      (a.fiveHourRemainingPercent !== null && a.fiveHourRemainingPercent !== undefined && a.fiveHourRemainingPercent <= 0);
    return {
      id: a.id,
      label: a.label,
      status: isExceeded ? "QUOTA_EXCEEDED" : a.fiveHourRemainingPercent == null || a.weeklyRemainingPercent == null ? "UNKNOWN" : "ACTIVE",
      tier: a.planType || "plus",
      weight,
      fiveHourPercent: a.fiveHourRemainingPercent,
      fiveHourResetAt: a.fiveHourResetAt,
      weeklyPercent: a.weeklyRemainingPercent,
      weeklyResetAt: a.weeklyResetAt,
      subType: "codex"
    };
  });

  const codexTotal = codexAccounts.length;
  const codexFailed = Boolean(codexList?.isStale || codexList?.error);
  const agyFailed = Boolean(agyList?.isStale || agyList?.error);

  const isCodexActive5h = (a: CodexUsageAccount) => {
    const week = a.weeklyRemainingPercent;
    const fiveH = a.fiveHourRemainingPercent;
    const weekOk = week != null && week >= 1;
    const fiveHOk = fiveH != null && fiveH >= 1;
    return weekOk && fiveHOk;
  };

  const isCodexActiveW = (a: CodexUsageAccount) => {
    const week = a.weeklyRemainingPercent;
    return week != null && week >= 1;
  };

  const codexActive5h = codexAccounts.filter(isCodexActive5h).length;
  const codexActiveW = codexAccounts.filter(isCodexActiveW).length;

  const codexMetrics = poolMetrics("Codex", "codex", codexItems, codexTotal, codexActive5h, codexActiveW,
    codexItems.filter(item => item.status === "QUOTA_EXCEEDED").length, codexFailed);

  const isAgyGroupActive5h = (
    group?: { fiveHourRemainingPercent?: number | null; weeklyRemainingPercent?: number | null } | null,
    status?: string
  ) => {
    if (!group || status === "UNLICENSED" || status === "EXPIRED" || status === "ERROR") return false;
    const week = group.weeklyRemainingPercent;
    const fiveH = group.fiveHourRemainingPercent;
    const weekOk = week != null && week >= 1;
    const fiveHOk = fiveH != null && fiveH >= 1;
    return weekOk && fiveHOk;
  };

  const isAgyGroupActiveW = (
    group?: { weeklyRemainingPercent?: number | null } | null,
    status?: string
  ) => {
    if (!group || status === "UNLICENSED" || status === "EXPIRED" || status === "ERROR") return false;
    const week = group.weeklyRemainingPercent;
    return week != null && week >= 1;
  };

  // Antigravity Gemini metrics
  const geminiItems: QuotaBreakdownItem[] = agyAccounts
    .filter((a) => a.gemini)
    .map((a) => {
      const weight = getAntigravityTierMultiplier(a.tier, a.status);
      const isUnlicensed = a.status === "UNLICENSED" || a.status === "EXPIRED" || a.status === "ERROR";
      const isExceeded =
        (a.gemini?.weeklyRemainingPercent !== null && a.gemini?.weeklyRemainingPercent !== undefined && a.gemini.weeklyRemainingPercent <= 0) ||
        (a.gemini?.fiveHourRemainingPercent !== null && a.gemini?.fiveHourRemainingPercent !== undefined && a.gemini.fiveHourRemainingPercent <= 0);
      const status = isUnlicensed ? a.status : isExceeded ? "QUOTA_EXCEEDED" :
        a.gemini.fiveHourRemainingPercent == null || a.gemini.weeklyRemainingPercent == null ? "UNKNOWN" : (a.status || "ACTIVE");
      return {
        id: `${a.id}-gemini`,
        label: `${a.label || a.email || a.id} (Gemini)`,
        status,
        tier: a.tier || "Standard",
        weight,
        fiveHourPercent: a.gemini.fiveHourRemainingPercent,
        fiveHourResetAt: a.gemini.fiveHourResetAt,
        weeklyPercent: a.gemini.weeklyRemainingPercent,
        weeklyResetAt: a.gemini.weeklyResetAt,
        subType: "gemini"
      };
    });

  const geminiTotal = agyAccounts.length;
  const geminiActive5h = agyAccounts.filter((a) => isAgyGroupActive5h(a.gemini, a.status)).length;
  const geminiActiveW = agyAccounts.filter((a) => isAgyGroupActiveW(a.gemini, a.status)).length;
  const geminiMetrics = poolMetrics("Antigravity Gemini", "gemini", geminiItems, geminiTotal, geminiActive5h, geminiActiveW,
    geminiItems.filter(item => item.status === "QUOTA_EXCEEDED").length, agyFailed);

  // Antigravity Claude metrics
  const claudeItems: QuotaBreakdownItem[] = agyAccounts
    .filter((a) => a.claude)
    .map((a) => {
      const weight = getAntigravityTierMultiplier(a.tier, a.status);
      const isUnlicensed = a.status === "UNLICENSED" || a.status === "EXPIRED" || a.status === "ERROR";
      const isExceeded =
        (a.claude?.weeklyRemainingPercent !== null && a.claude?.weeklyRemainingPercent !== undefined && a.claude.weeklyRemainingPercent <= 0) ||
        (a.claude?.fiveHourRemainingPercent !== null && a.claude?.fiveHourRemainingPercent !== undefined && a.claude.fiveHourRemainingPercent <= 0);
      const status = isUnlicensed ? a.status : isExceeded ? "QUOTA_EXCEEDED" :
        a.claude.fiveHourRemainingPercent == null || a.claude.weeklyRemainingPercent == null ? "UNKNOWN" : (a.status || "ACTIVE");
      return {
        id: `${a.id}-claude`,
        label: `${a.label || a.email || a.id} (Claude)`,
        status,
        tier: a.tier || "Standard",
        weight,
        fiveHourPercent: a.claude.fiveHourRemainingPercent,
        fiveHourResetAt: a.claude.fiveHourResetAt,
        weeklyPercent: a.claude.weeklyRemainingPercent,
        weeklyResetAt: a.claude.weeklyResetAt,
        subType: "claude"
      };
    });

  const claudeActive5h = agyAccounts.filter((a) => isAgyGroupActive5h(a.claude, a.status)).length;
  const claudeActiveW = agyAccounts.filter((a) => isAgyGroupActiveW(a.claude, a.status)).length;
  const claudeMetrics = poolMetrics("Antigravity Claude", "claude", claudeItems, agyAccounts.length, claudeActive5h, claudeActiveW,
    claudeItems.filter(item => item.status === "QUOTA_EXCEEDED").length, agyFailed);

  const antigravityCombined = poolMetrics("Antigravity (Google + Claude)", "antigravity", [...geminiItems, ...claudeItems], geminiTotal,
    Math.max(geminiActive5h, claudeActive5h), Math.max(geminiActiveW, claudeActiveW),
    Math.min(geminiMetrics.exhaustedAccounts, claudeMetrics.exhaustedAccounts), agyFailed);

  const claudeMaxItems: QuotaBreakdownItem[] = claudeSubscriptionAccounts(claudeList?.data ?? []).map((a) => ({
    id: `claude-max-${a.label}`,
    label: a.label,
    status: a.fiveHourRemainingPercent === 0 || a.weeklyRemainingPercent === 0 ? "QUOTA_EXCEEDED"
      : a.fiveHourRemainingPercent == null || a.weeklyRemainingPercent == null ? "UNKNOWN" : "ACTIVE",
    weight: 1,
    fiveHourPercent: a.fiveHourRemainingPercent ?? null,
    fiveHourResetAt: a.fiveHourResetAt,
    weeklyPercent: a.weeklyRemainingPercent ?? null,
    weeklyResetAt: a.weeklyResetAt,
    subType: "claude-max"
  }));
  const claudeMax = poolMetrics("Claude Max", "claude-max", claudeMaxItems, claudeMaxItems.length,
    claudeMaxItems.filter((item) => (item.fiveHourPercent ?? 0) >= 1 && (item.weeklyPercent ?? 0) >= 1).length,
    claudeMaxItems.filter((item) => (item.weeklyPercent ?? 0) >= 1).length,
    claudeMaxItems.filter((item) => item.status === "QUOTA_EXCEEDED").length,
    Boolean(claudeList?.isStale || claudeList?.error));

  const allItems = [...codexItems, ...geminiItems, ...claudeItems];
  const total5h = windowShare(allItems, "5h", codexFailed || agyFailed);
  const totalWeekly = windowShare(allItems, "weekly", codexFailed || agyFailed);

  const result: AllQuotaAggregates = {
    codex: codexMetrics,
    gemini: geminiMetrics,
    claude: claudeMetrics,
    antigravityCombined,
    apiProviders: apiMetrics,
    claudeMax,
    totalAiPool: {
      pool5h: total5h.pool,
      available5h: total5h.available,
      percent5h: total5h.percent,
      poolWeekly: totalWeekly.pool,
      availableWeekly: totalWeekly.available,
      percentWeekly: totalWeekly.percent,
      totalAccounts: codexTotal + geminiTotal + apiMetrics.totalProviders
    },
    lastCheckedAt: codexList?.checkedAt || agyList?.checkedAt || claudeList?.checkedAt || apiList?.checkedAt || null,
    isStale: Boolean(codexList?.isStale || agyList?.isStale || claudeList?.isStale || apiList?.isStale)
  };
  return result;
}

/**
 * One window's share left, weighted by tier, over the accounts that report it: unknown limits never add a fabricated zero, and a
 * pool is unknown (null) only when no account reports. An account without a 5h window counts in the 5h share at its weekly share
 * (the week caps the 5h; Google gives Free accounts no 5h bucket); one without a weekly share counts nowhere unless its 5h is used up.
 */
function windowShare(items: QuotaBreakdownItem[], window: "5h" | "weekly", failed: boolean) {
  const counted = failed ? [] : items.filter((item) =>
    item.weeklyPercent != null || (window === "5h" && item.fiveHourPercent === 0));
  const pool = counted.reduce((sum, item) => sum + (item.weight ?? 1) * 100, 0);
  const left = counted.reduce((sum, item) => sum + (item.weight ?? 1) * Math.max(0, window === "weekly"
    ? item.weeklyPercent ?? 0
    : Math.min(item.fiveHourPercent ?? 100, item.weeklyPercent ?? 100)), 0);
  if (!counted.length) return { pool, available: null, percent: null };
  return { pool, available: Math.round(left), percent: pool > 0 ? (left / pool) * 100 : 0 };
}

function poolMetrics(name: string, providerKey: ProviderQuotaMetrics["providerKey"], items: QuotaBreakdownItem[], totalAccounts: number,
  active5h: number, activeWeekly: number, exhaustedAccounts: number, failed: boolean): ProviderQuotaMetrics {
  const fiveHour = windowShare(items, "5h", failed);
  const weekly = windowShare(items, "weekly", failed);
  return {
    name,
    providerKey,
    totalAccounts,
    activeAccounts: active5h,
    activeAccounts5h: active5h,
    activeAccountsWeekly: activeWeekly,
    exhaustedAccounts,
    pool5h: fiveHour.pool,
    available5h: fiveHour.available,
    percent5h: fiveHour.percent,
    poolWeekly: weekly.pool,
    availableWeekly: weekly.available,
    percentWeekly: weekly.percent,
    accounts: items
  };
}
