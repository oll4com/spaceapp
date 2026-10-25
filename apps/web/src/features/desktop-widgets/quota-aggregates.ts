import type {
  AntigravityUsageAccount,
  AntigravityUsageAccountList,
  ApiProviderAccount,
  ApiProviderAccountList,
  CodexUsageAccount,
  CodexUsageAccountList
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
  subType?: "gemini" | "claude" | "codex";
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
  providerKey: "codex" | "gemini" | "claude" | "antigravity" | "total";
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

export function computeApiProviderMetrics(apiList?: ApiProviderAccountList | null): ApiProviderMetrics {
  const accounts: ApiProviderAccount[] = apiList?.data ?? [];
  const total = accounts.length;
  const connected = accounts.filter((a) => a.status === "CONNECTED").length;
  const exhausted = accounts.filter((a) => a.status === "EXHAUSTED").length;
  const unconfigured = accounts.filter((a) => a.status === "UNCONFIGURED").length;
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
  apiList?: ApiProviderAccountList | null
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
  const codexPool5h = codexItems.reduce((sum, item) => sum + (item.weight ?? 1) * 100, 0);

  // Available 5h quota cannot exceed remaining weekly quota, and accounts with exhausted weekly quota have 0 usable quota.
  const codexAvail5h = codexItems.reduce((sum, item) => {
    const effective5h =
      item.weeklyPercent !== null && item.weeklyPercent !== undefined
        ? Math.min(item.fiveHourPercent ?? 0, item.weeklyPercent)
        : (item.fiveHourPercent ?? 0);
    return sum + Math.max(0, effective5h) * (item.weight ?? 1);
  }, 0);

  const codexPoolW = codexPool5h;
  const codexAvailW = codexItems.reduce(
    (sum, item) => sum + Math.max(0, item.weeklyPercent ?? 0) * (item.weight ?? 1),
    0
  );

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

  const codexMetrics: ProviderQuotaMetrics = {
    name: "Codex",
    providerKey: "codex",
    totalAccounts: codexTotal,
    activeAccounts: codexActive5h,
    activeAccounts5h: codexActive5h,
    activeAccountsWeekly: codexActiveW,
    exhaustedAccounts: codexItems.filter(item => item.status === "QUOTA_EXCEEDED").length,
    pool5h: codexPool5h,
    available5h: Math.round(codexAvail5h),
    percent5h: codexPool5h > 0 ? (codexAvail5h / codexPool5h) * 100 : 0,
    poolWeekly: codexPoolW,
    availableWeekly: Math.round(codexAvailW),
    percentWeekly: codexPoolW > 0 ? (codexAvailW / codexPoolW) * 100 : 0,
    accounts: codexItems
  };

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
  const geminiPool5h = geminiItems.reduce((sum, item) => sum + (item.weight ?? 1) * 100, 0);
  const geminiAvail5h = geminiItems.reduce((sum, item) => {
    const effective5h =
      item.weeklyPercent !== null && item.weeklyPercent !== undefined
        ? Math.min(item.fiveHourPercent ?? 0, item.weeklyPercent)
        : (item.fiveHourPercent ?? 0);
    return sum + Math.max(0, effective5h) * (item.weight ?? 1);
  }, 0);
  const geminiPoolW = geminiPool5h;
  const geminiAvailW = geminiItems.reduce(
    (sum, item) => sum + Math.max(0, item.weeklyPercent ?? 0) * (item.weight ?? 1),
    0
  );

  const geminiActive5h = agyAccounts.filter((a) => isAgyGroupActive5h(a.gemini, a.status)).length;
  const geminiActiveW = agyAccounts.filter((a) => isAgyGroupActiveW(a.gemini, a.status)).length;

  const geminiMetrics: ProviderQuotaMetrics = {
    name: "Antigravity Gemini",
    providerKey: "gemini",
    totalAccounts: geminiTotal,
    activeAccounts: geminiActive5h,
    activeAccounts5h: geminiActive5h,
    activeAccountsWeekly: geminiActiveW,
    exhaustedAccounts: geminiItems.filter(item => item.status === "QUOTA_EXCEEDED").length,
    pool5h: geminiPool5h,
    available5h: Math.round(geminiAvail5h),
    percent5h: geminiPool5h > 0 ? (geminiAvail5h / geminiPool5h) * 100 : 0,
    poolWeekly: geminiPoolW,
    availableWeekly: Math.round(geminiAvailW),
    percentWeekly: geminiPoolW > 0 ? (geminiAvailW / geminiPoolW) * 100 : 0,
    accounts: geminiItems
  };

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

  const claudeTotal = agyAccounts.length;
  const claudePool5h = claudeItems.reduce((sum, item) => sum + (item.weight ?? 1) * 100, 0);
  const claudeAvail5h = claudeItems.reduce((sum, item) => {
    const effective5h =
      item.weeklyPercent !== null && item.weeklyPercent !== undefined
        ? Math.min(item.fiveHourPercent ?? 0, item.weeklyPercent)
        : (item.fiveHourPercent ?? 0);
    return sum + Math.max(0, effective5h) * (item.weight ?? 1);
  }, 0);
  const claudePoolW = claudePool5h;
  const claudeAvailW = claudeItems.reduce(
    (sum, item) => sum + Math.max(0, item.weeklyPercent ?? 0) * (item.weight ?? 1),
    0
  );

  const claudeActive5h = agyAccounts.filter((a) => isAgyGroupActive5h(a.claude, a.status)).length;
  const claudeActiveW = agyAccounts.filter((a) => isAgyGroupActiveW(a.claude, a.status)).length;

  const claudeMetrics: ProviderQuotaMetrics = {
    name: "Antigravity Claude",
    providerKey: "claude",
    totalAccounts: claudeTotal,
    activeAccounts: claudeActive5h,
    activeAccounts5h: claudeActive5h,
    activeAccountsWeekly: claudeActiveW,
    exhaustedAccounts: claudeItems.filter(item => item.status === "QUOTA_EXCEEDED").length,
    pool5h: claudePool5h,
    available5h: Math.round(claudeAvail5h),
    percent5h: claudePool5h > 0 ? (claudeAvail5h / claudePool5h) * 100 : 0,
    poolWeekly: claudePoolW,
    availableWeekly: Math.round(claudeAvailW),
    percentWeekly: claudePoolW > 0 ? (claudeAvailW / claudePoolW) * 100 : 0,
    accounts: claudeItems
  };

  // Antigravity Combined
  const agyPool5h = geminiPool5h + claudePool5h;
  const agyAvail5h = geminiAvail5h + claudeAvail5h;
  const agyPoolW = geminiPoolW + claudePoolW;
  const agyAvailW = geminiAvailW + claudeAvailW;

  const antigravityCombined: ProviderQuotaMetrics = {
    name: "Antigravity (Google + Claude)",
    providerKey: "antigravity",
    totalAccounts: geminiTotal,
    activeAccounts: Math.max(geminiActive5h, claudeActive5h),
    activeAccounts5h: Math.max(geminiActive5h, claudeActive5h),
    activeAccountsWeekly: Math.max(geminiActiveW, claudeActiveW),
    exhaustedAccounts: Math.min(geminiMetrics.exhaustedAccounts, claudeMetrics.exhaustedAccounts),
    pool5h: agyPool5h,
    available5h: Math.round(agyAvail5h),
    percent5h: agyPool5h > 0 ? (agyAvail5h / agyPool5h) * 100 : 0,
    poolWeekly: agyPoolW,
    availableWeekly: Math.round(agyAvailW),
    percentWeekly: agyPoolW > 0 ? (agyAvailW / agyPoolW) * 100 : 0,
    accounts: [...geminiItems, ...claudeItems]
  };

  // Overall Total AI Pool
  const totalPool5h = codexPool5h + geminiPool5h + claudePool5h;
  const totalAvail5h = codexAvail5h + geminiAvail5h + claudeAvail5h;
  const totalPoolW = codexPoolW + geminiPoolW + claudePoolW;
  const totalAvailW = codexAvailW + geminiAvailW + claudeAvailW;

  const result: AllQuotaAggregates = {
    codex: codexMetrics,
    gemini: geminiMetrics,
    claude: claudeMetrics,
    antigravityCombined,
    apiProviders: apiMetrics,
    totalAiPool: {
      pool5h: totalPool5h,
      available5h: Math.round(totalAvail5h),
      percent5h: totalPool5h > 0 ? (totalAvail5h / totalPool5h) * 100 : 0,
      poolWeekly: totalPoolW,
      availableWeekly: Math.round(totalAvailW),
      percentWeekly: totalPoolW > 0 ? (totalAvailW / totalPoolW) * 100 : 0,
      totalAccounts: codexTotal + geminiTotal + apiMetrics.totalProviders
    },
    lastCheckedAt: codexList?.checkedAt || agyList?.checkedAt || apiList?.checkedAt || null,
    isStale: Boolean(codexList?.isStale || agyList?.isStale || apiList?.isStale)
  };
  const codexFailed = Boolean(codexList?.isStale || codexList?.error);
  const agyFailed = Boolean(agyList?.isStale || agyList?.error);
  // Unknown limits cannot contribute a fabricated zero to capacity totals.
  function preserveUnknown(metric: { percent5h: number | null; available5h: number | null; percentWeekly: number | null; availableWeekly: number | null }, items: QuotaBreakdownItem[], failed: boolean) {
    if (failed || !items.length || items.some(item => item.fiveHourPercent == null || item.weeklyPercent == null)) {
      // Either observed zero limit is sufficient to establish unusable short-window quota.
      if (failed || !items.length || items.some(item => item.fiveHourPercent !== 0 && item.weeklyPercent !== 0 &&
        (item.fiveHourPercent == null || item.weeklyPercent == null))) metric.percent5h = metric.available5h = null;
    }
    if (failed || !items.length || items.some(item => item.weeklyPercent == null)) metric.percentWeekly = metric.availableWeekly = null;
  }
  preserveUnknown(codexMetrics, codexItems, codexFailed);
  preserveUnknown(geminiMetrics, geminiItems, agyFailed);
  preserveUnknown(claudeMetrics, claudeItems, agyFailed);
  preserveUnknown(antigravityCombined, [...geminiItems, ...claudeItems], agyFailed);
  preserveUnknown(result.totalAiPool, [...codexItems, ...geminiItems, ...claudeItems], codexFailed || agyFailed);
  return result;
}
