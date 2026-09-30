import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Gauge,
  Globe,
  Layers,
  Pause,
  Play,
  RotateCw,
  TrendingDown,
  TrendingUp,
  XCircle,
  Zap
} from "lucide-react";
import type {
  AntigravityUsageAccount,
  AntigravityUsageAccountList,
  ApiProviderAccount,
  ApiProviderAccountList,
  CodexUsageAccount,
  CodexUsageAccountList
} from "@space/contracts";
import { api } from "../../api.js";
import { formatAppTime } from "../date-time-settings/date-time-settings.js";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import type { AiQuotaWidgetConfig, DesktopWidgetState } from "./types.js";
import { DEFAULT_AI_QUOTA_CONFIG, loadWidgetConfig, saveWidgetConfig } from "./widget-storage.js";

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
  available5h: number;
  percent5h: number;
  poolWeekly: number;
  availableWeekly: number;
  percentWeekly: number;
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
    available5h: number;
    percent5h: number;
    poolWeekly: number;
    availableWeekly: number;
    percentWeekly: number;
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
      status: isExceeded ? "QUOTA_EXCEEDED" : "ACTIVE",
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
    const weekOk = week == null || week >= 1;
    const fiveHOk = fiveH == null || fiveH >= 1;
    return weekOk && fiveHOk;
  };

  const isCodexActiveW = (a: CodexUsageAccount) => {
    const week = a.weeklyRemainingPercent;
    return week == null || week >= 1;
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
    exhaustedAccounts: Math.max(0, codexTotal - codexActive5h),
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
    const weekOk = week == null || week >= 1;
    const fiveHOk = fiveH == null || fiveH >= 1;
    return weekOk && fiveHOk;
  };

  const isAgyGroupActiveW = (
    group?: { weeklyRemainingPercent?: number | null } | null,
    status?: string
  ) => {
    if (!group || status === "UNLICENSED" || status === "EXPIRED" || status === "ERROR") return false;
    const week = group.weeklyRemainingPercent;
    return week == null || week >= 1;
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
      const status = isUnlicensed ? a.status : isExceeded ? "QUOTA_EXCEEDED" : (a.status || "ACTIVE");
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
    exhaustedAccounts: Math.max(0, geminiTotal - geminiActive5h),
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
      const status = isUnlicensed ? a.status : isExceeded ? "QUOTA_EXCEEDED" : (a.status || "ACTIVE");
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
    exhaustedAccounts: Math.max(0, claudeTotal - claudeActive5h),
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

  return {
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
}

/**
 * Format reset duration into readable text
 */
function formatTimeRemaining(isoDate?: string | null): string | null {
  if (!isoDate) return null;
  const target = new Date(isoDate).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = target - Date.now();
  if (diffMs <= 0) return "resets now";
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 60) return `${diffMinutes}m`;
  const hours = Math.floor(diffMinutes / 60);
  const mins = diffMinutes % 60;
  if (hours < 24) return `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

/**
 * SVG Speedometer / Gauge Component with live animated transition needle
 */
interface SpeedometerGaugeProps {
  percent: number;
  availablePercent: number;
  totalPoolPercent: number;
  label: string;
  subLabel?: string;
  size?: "lg" | "md" | "sm";
  trendDelta?: number | null;
  idPrefix?: string;
}

export function SpeedometerGauge({
  percent,
  availablePercent,
  totalPoolPercent,
  label,
  subLabel,
  size = "lg",
  trendDelta = null,
  idPrefix = "main"
}: SpeedometerGaugeProps) {
  const isLarge = size === "lg";
  const isMedium = size === "md";
  const clampedPercent = Math.min(100, Math.max(0, percent));

  // Determine color tone
  const colorTone =
    clampedPercent >= 50 ? "emerald" : clampedPercent >= 20 ? "amber" : "rose";
  const strokeColor =
    colorTone === "emerald"
      ? "var(--gauge-emerald, #10b981)"
      : colorTone === "amber"
      ? "var(--gauge-amber, #f59e0b)"
      : "var(--gauge-rose, #ef4444)";

  const glowColor =
    colorTone === "emerald"
      ? "rgba(16, 185, 129, 0.4)"
      : colorTone === "amber"
      ? "rgba(245, 158, 11, 0.4)"
      : "rgba(239, 68, 68, 0.4)";

  // Geometry:
  // Large: viewBox 0 0 190 140, cx 95, cy 95, r 68, span 250deg
  // Medium: viewBox 0 0 160 125, cx 80, cy 80, r 56, span 250deg
  // Small: viewBox 0 0 110 88, cx 55, cy 56, r 38, span 240deg
  const cx = isLarge ? 95 : isMedium ? 80 : 55;
  const cy = isLarge ? 95 : isMedium ? 80 : 56;
  const r = isLarge ? 68 : isMedium ? 56 : 38;
  const startAngle = isLarge || isMedium ? 145 : 150;
  const angleSpan = isLarge || isMedium ? 250 : 240;

  // Needle angle with smooth spring easing
  const needleAngle = startAngle + (clampedPercent / 100) * angleSpan;

  // Arc length
  const arcLength = (angleSpan / 360) * 2 * Math.PI * r;
  const strokeOffset = arcLength * (1 - clampedPercent / 100);

  // Start & End points for background arc path
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const x1 = cx + r * Math.cos(rad(startAngle));
  const y1 = cy + r * Math.sin(rad(startAngle));
  const x2 = cx + r * Math.cos(rad(startAngle + angleSpan));
  const y2 = cy + r * Math.sin(rad(startAngle + angleSpan));

  const arcPath = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 1 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;

  const strokeWidth = isLarge ? 10 : isMedium ? 8 : 6;
  const needleLength = isLarge ? r - 12 : isMedium ? r - 10 : r - 8;
  const viewBox = isLarge ? "0 0 190 140" : isMedium ? "0 0 160 125" : "0 0 110 88";

  const gradId = `ai-gauge-grad-${idPrefix}-${colorTone}`;
  const filterId = `ai-gauge-glow-${idPrefix}`;

  return (
    <div className={`ai-speedometer-wrapper is-${size}`}>
      <svg
        className="ai-speedometer-svg"
        viewBox={viewBox}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradId} x1="0%" y1="100%" x2="100%" y2="0%">
            {colorTone === "emerald" ? (
              <>
                <stop offset="0%" stopColor="#059669" />
                <stop offset="100%" stopColor="#34d399" />
              </>
            ) : colorTone === "amber" ? (
              <>
                <stop offset="0%" stopColor="#d97706" />
                <stop offset="100%" stopColor="#fbbf24" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="#dc2626" />
                <stop offset="100%" stopColor="#f87171" />
              </>
            )}
          </linearGradient>
          <filter id={filterId} x="-20%" y="-20%" width="140%" height="140%">
            <feDropShadow dx="0" dy="0" stdDeviation={isLarge ? "4" : "2"} floodColor={glowColor} />
          </filter>
        </defs>

        {/* Background Arc Track */}
        <path
          d={arcPath}
          fill="none"
          stroke="var(--modern-surface-soft, rgba(255, 255, 255, 0.08))"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />

        {/* Animated Progress Arc */}
        <path
          d={arcPath}
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={arcLength}
          strokeDashoffset={strokeOffset}
          filter={`url(#${filterId})`}
          className="ai-gauge-progress-arc"
        />

        {/* Needle */}
        <g
          className="ai-gauge-needle-group"
          style={{
            transform: `rotate(${needleAngle}deg)`,
            transformOrigin: `${cx}px ${cy}px`,
            transition: "transform 0.85s cubic-bezier(0.34, 1.56, 0.64, 1)"
          }}
        >
          {/* Tapered pointer needle */}
          <polygon
            points={`${cx - (isLarge ? 3 : 2)},${cy} ${cx},${cy - needleLength} ${cx + (isLarge ? 3 : 2)},${cy} ${cx},${cy + (isLarge ? 5 : 3)}`}
            fill={strokeColor}
            opacity="0.95"
          />
        </g>

        {/* Center Pivot Hub */}
        <circle cx={cx} cy={cy} r={isLarge ? 6 : 3.5} fill="#1e293b" stroke={strokeColor} strokeWidth={isLarge ? 2 : 1.5} />
        <circle cx={cx} cy={cy} r={isLarge ? 2.5 : 1.5} fill="#ffffff" />
      </svg>

      {/* Numerical Readout below gauge */}
      <div className="ai-gauge-readout">
        <div className="ai-gauge-main-percent" style={{ color: strokeColor }}>
          <span>{Math.round(clampedPercent)}%</span>
          {trendDelta !== null && trendDelta !== 0 ? (
            <span
              className={`ai-gauge-trend-badge ${trendDelta > 0 ? "is-up" : "is-down"}`}
              title={`Shifted ${trendDelta > 0 ? "+" : ""}${trendDelta}%`}
            >
              {trendDelta > 0 ? <TrendingUp className="ai-trend-svg" /> : <TrendingDown className="ai-trend-svg" />}
              {Math.abs(trendDelta)}%
            </span>
          ) : null}
        </div>

        <div className="ai-gauge-fraction-text" title="Available quota sum out of total maximum capacity">
          <strong>{Math.round(availablePercent)}%</strong>
          <span className="ai-gauge-sep">/</span>
          <span>{totalPoolPercent}%</span>
        </div>

        <div className="ai-gauge-labels">
          <span className="ai-gauge-title">{label}</span>
          {subLabel ? <small className="ai-gauge-subtitle">{subLabel}</small> : null}
        </div>
      </div>
    </div>
  );
}

export interface SharedQuotaCache {
  codex: CodexUsageAccountList | null;
  agy: AntigravityUsageAccountList | null;
  api: ApiProviderAccountList | null;
  fetchedAt: number;
}

let sharedQuotaCache: SharedQuotaCache | null = null;
let sharedQuotaInFlight: Promise<SharedQuotaCache> | null = null;

export async function fetchSharedQuotaMetrics(force = false): Promise<SharedQuotaCache> {
  const now = Date.now();
  if (!force && sharedQuotaCache && now - sharedQuotaCache.fetchedAt < 60_000) {
    return sharedQuotaCache;
  }
  if (sharedQuotaInFlight) {
    return sharedQuotaInFlight;
  }

  const promise = (async () => {
    try {
      let cRes: CodexUsageAccountList | null = null;
      let aRes: AntigravityUsageAccountList | null = null;
      let pRes: ApiProviderAccountList | null = null;
      try {
        [cRes, aRes, pRes] = await Promise.all([
          api.toolbarUsageAccounts().catch(() => null),
          api.toolbarAntigravityUsageAccounts().catch(() => null),
          api.toolbarApiProviderAccounts().catch(() => null)
        ]);
      } catch {
        // SpaceRuntimeProvider not mounted (e.g. in isolated test environments)
      }
      const result: SharedQuotaCache = {
        codex: cRes ?? sharedQuotaCache?.codex ?? null,
        agy: aRes ?? sharedQuotaCache?.agy ?? null,
        api: pRes ?? sharedQuotaCache?.api ?? null,
        fetchedAt: Date.now()
      };
      sharedQuotaCache = result;
      return result;
    } finally {
      sharedQuotaInFlight = null;
    }
  })();

  sharedQuotaInFlight = promise;
  return promise;
}

/**
 * Main AI Quota Card Component - used both in DesktopWidget and in ToolbarMetrics panel
 */
export interface AiQuotaGaugeCardProps {
  embedded?: boolean;
  onOpenDesktopWidget?: () => void;
  isDesktopWidgetActive?: boolean;
  externalConfig?: AiQuotaWidgetConfig;
  hideScopeControls?: boolean;
  onUpdateConfig?: (patch: Partial<AiQuotaWidgetConfig>) => void;
}

export function AiQuotaGaugeCard({
  embedded = false,
  onOpenDesktopWidget,
  isDesktopWidgetActive = false,
  externalConfig,
  hideScopeControls = false,
  onUpdateConfig
}: AiQuotaGaugeCardProps) {
  const [internalConfig, setInternalConfig] = useState<AiQuotaWidgetConfig>(() =>
    loadWidgetConfig("ai-quota", DEFAULT_AI_QUOTA_CONFIG)
  );
  const config = externalConfig ?? internalConfig;
  const updateConfig = (patch: Partial<AiQuotaWidgetConfig>) => {
    if (onUpdateConfig) {
      onUpdateConfig(patch);
    } else {
      setInternalConfig((prev) => {
        const next = { ...prev, ...patch };
        saveWidgetConfig("ai-quota", next);
        return next;
      });
    }
  };

  const [codexData, setCodexData] = useState<CodexUsageAccountList | null>(() => sharedQuotaCache?.codex ?? null);
  const [agyData, setAgyData] = useState<AntigravityUsageAccountList | null>(() => sharedQuotaCache?.agy ?? null);
  const [apiData, setApiData] = useState<ApiProviderAccountList | null>(() => sharedQuotaCache?.api ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAccounts, setExpandedAccounts] = useState(false);
  const [lastUpdatedTime, setLastUpdatedTime] = useState<string | null>(() =>
    sharedQuotaCache
      ? formatAppTime(sharedQuotaCache.fetchedAt)
      : null
  );

  // Keep track of previous percentages to calculate live transitions & deltas
  const prevCodex5h = useRef<number | null>(null);
  const prevGemini5h = useRef<number | null>(null);
  const prevClaude5h = useRef<number | null>(null);
  const prevTotal5h = useRef<number | null>(null);

  const [deltas, setDeltas] = useState<{
    codex: number | null;
    gemini: number | null;
    claude: number | null;
    total: number | null;
  }>({ codex: null, gemini: null, claude: null, total: null });

  const fetchMetrics = useCallback(async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchSharedQuotaMetrics(force);
      if (data.codex) setCodexData(data.codex);
      if (data.agy) setAgyData(data.agy);
      if (data.api) setApiData(data.api);

      setLastUpdatedTime(formatAppTime(data.fetchedAt));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load quota metrics");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial load
  useEffect(() => {
    void fetchMetrics();
  }, [fetchMetrics]);

  // Periodic live refresh (clamped to at least 60s, paused when hidden)
  useEffect(() => {
    if (!config.autoRefresh) return;
    const intervalMs = Math.max(60, config.refreshIntervalSeconds || 90) * 1000;
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") {
        void fetchMetrics();
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [config.autoRefresh, config.refreshIntervalSeconds, fetchMetrics]);

  // Compute aggregates
  const aggregates = useMemo(
    () => computeQuotaAggregates(codexData, agyData, apiData),
    [codexData, agyData, apiData]
  );

  // Compute deltas whenever aggregates change
  useEffect(() => {
    const is5h = config.windowMode === "5h";
    const currentCodex = is5h ? aggregates.codex.percent5h : aggregates.codex.percentWeekly;
    const currentGemini = is5h ? aggregates.gemini.percent5h : aggregates.gemini.percentWeekly;
    const currentClaude = is5h ? aggregates.claude.percent5h : aggregates.claude.percentWeekly;
    const currentTotal = is5h
      ? aggregates.totalAiPool.percent5h
      : aggregates.totalAiPool.percentWeekly;

    const deltaC = prevCodex5h.current !== null ? Math.round(currentCodex - prevCodex5h.current) : null;
    const deltaG = prevGemini5h.current !== null ? Math.round(currentGemini - prevGemini5h.current) : null;
    const deltaCl = prevClaude5h.current !== null ? Math.round(currentClaude - prevClaude5h.current) : null;
    const deltaT = prevTotal5h.current !== null ? Math.round(currentTotal - prevTotal5h.current) : null;

    setDeltas({ codex: deltaC, gemini: deltaG, claude: deltaCl, total: deltaT });

    prevCodex5h.current = currentCodex;
    prevGemini5h.current = currentGemini;
    prevClaude5h.current = currentClaude;
    prevTotal5h.current = currentTotal;
  }, [aggregates, config.windowMode]);



  const is5h = config.windowMode === "5h";
  const codexActiveCount =
    (is5h ? aggregates.codex.activeAccounts5h : aggregates.codex.activeAccountsWeekly) ??
    aggregates.codex.activeAccounts;
  const codexExhaustedCount = Math.max(0, aggregates.codex.totalAccounts - codexActiveCount);
  const geminiActiveCount =
    (is5h ? aggregates.gemini.activeAccounts5h : aggregates.gemini.activeAccountsWeekly) ??
    aggregates.gemini.activeAccounts;
  const claudeActiveCount =
    (is5h ? aggregates.claude.activeAccounts5h : aggregates.claude.activeAccountsWeekly) ??
    aggregates.claude.activeAccounts;

  return (
    <div className={`ai-quota-card ${embedded ? "is-embedded" : "is-standalone"}`}>
      {/* Top Header & Live Indicators */}
      <div className="ai-quota-card-header">
        <div className="ai-quota-header-left">
          <div className="ai-quota-badge-live" title="Live telemetry with automatic transition tracking">
            <span className="ai-live-pulse-dot" />
            <span className="ai-live-text">LIVE QUOTA</span>
          </div>
          {lastUpdatedTime ? (
            <span className="ai-quota-updated-stamp">{lastUpdatedTime}</span>
          ) : null}
          {aggregates.isStale ? (
            <span className="ai-quota-stale-tag">Stale cache</span>
          ) : null}
        </div>

        <div className="ai-quota-header-actions">
          {/* 5h vs Weekly Window Pill Switcher */}
          {!hideScopeControls && <div className="ai-quota-window-pills" role="radiogroup" aria-label="Quota window">
            <button
              type="button"
              className={`ai-window-pill-btn ${is5h ? "is-active" : ""}`}
              onClick={() => updateConfig({ windowMode: "5h" })}
              title="5-Hour Rolling Usage Window"
            >
              <Zap className="ai-pill-svg" /> 5h
            </button>
            <button
              type="button"
              className={`ai-window-pill-btn ${!is5h ? "is-active" : ""}`}
              onClick={() => updateConfig({ windowMode: "weekly" })}
              title="Weekly Allocation Window"
            >
              <Calendar className="ai-pill-svg" /> Week
            </button>
          </div>}

          {/* Auto refresh pause/play toggle */}
          <button
            type="button"
            className={`ai-quota-icon-btn ${config.autoRefresh ? "is-active" : ""}`}
            onClick={() => updateConfig({ autoRefresh: !config.autoRefresh })}
            title={config.autoRefresh ? "Pause auto-refresh" : "Enable live auto-refresh"}
            aria-label="Toggle auto-refresh"
          >
            {config.autoRefresh ? <Pause className="ai-action-svg" /> : <Play className="ai-action-svg" />}
          </button>

          {/* Manual Refresh Trigger */}
          <button
            type="button"
            className={`ai-quota-icon-btn ${loading ? "is-spinning" : ""}`}
            onClick={() => void fetchMetrics(true)}
            title="Refresh now"
            aria-label="Refresh quota"
            disabled={loading}
          >
            <RotateCw className="ai-action-svg" />
          </button>

          {/* Mini badge / auto-cycle interval setting */}
          <div
            className="ai-quota-interval-wrap"
            title="Auto-cycle interval in seconds (for 5h / wk toggle)"
          >
            <input
              type="number"
              min={2}
              max={300}
              step={5}
              value={config.miniCycleIntervalSeconds ?? 30}
              onChange={(e) => {
                const parsed = parseInt(e.target.value, 10);
                if (!isNaN(parsed) && parsed > 0) {
                  updateConfig({
                    miniCycleIntervalSeconds: parsed
                  });
                }
              }}
              className="ai-quota-interval-input"
              aria-label="Cycle interval seconds"
            />
            <span className="ai-quota-interval-unit">sec</span>
          </div>

          {/* Popout button when embedded */}
          {embedded && onOpenDesktopWidget ? (
            <button
              type="button"
              className={`ai-quota-tag-btn ${isDesktopWidgetActive ? "is-active" : ""}`}
              onClick={onOpenDesktopWidget}
              title="Float this widget on your desktop workspace"
            >
              <Gauge className="ai-pill-svg" /> {isDesktopWidgetActive ? "Floated" : "Float"}
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <div className="ai-quota-error-banner" role="alert">
          <AlertTriangle className="ai-error-svg" /> {error}
        </div>
      ) : null}

      {/* Provider Filter Tabs */}
      {!hideScopeControls && <div className="ai-quota-provider-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={config.activeTab === "all"}
          className={`ai-provider-tab ${config.activeTab === "all" ? "is-active" : ""}`}
          onClick={() => updateConfig({ activeTab: "all" })}
        >
          <Layers className="ai-tab-icon" /> All Providers
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={config.activeTab === "codex"}
          className={`ai-provider-tab ${config.activeTab === "codex" ? "is-active" : ""}`}
          onClick={() => updateConfig({ activeTab: "codex" })}
        >
          Codex ({aggregates.codex.totalAccounts})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={config.activeTab === "antigravity"}
          className={`ai-provider-tab ${config.activeTab === "antigravity" ? "is-active" : ""}`}
          onClick={() => updateConfig({ activeTab: "antigravity" })}
        >
          Antigravity ({aggregates.antigravityCombined.totalAccounts})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={config.activeTab === "api"}
          className={`ai-provider-tab ${config.activeTab === "api" ? "is-active" : ""}`}
          onClick={() => updateConfig({ activeTab: "api" })}
        >
          <Globe className="ai-tab-icon" /> API Providers ({aggregates.apiProviders.totalProviders})
        </button>
      </div>}

      {/* MAIN GAUGES DISPLAY */}
      <div className="ai-quota-gauges-section">
        {config.activeTab === "all" && (
          <div className="ai-all-providers-view">
            {/* Master Combined Speedometer */}
            <div className="ai-master-gauge-box">
              <SpeedometerGauge
                percent={is5h ? aggregates.totalAiPool.percent5h : aggregates.totalAiPool.percentWeekly}
                availablePercent={is5h ? aggregates.totalAiPool.available5h : aggregates.totalAiPool.availableWeekly}
                totalPoolPercent={is5h ? aggregates.totalAiPool.pool5h : aggregates.totalAiPool.poolWeekly}
                label="Total AI Capacity"
                subLabel={`${aggregates.totalAiPool.totalAccounts} pooled accounts across all providers`}
                size="lg"
                trendDelta={deltas.total}
                idPrefix="master"
              />
            </div>

            {/* Sub-Gauges Triad: Codex, AGY Gemini, AGY Claude */}
            <div className="ai-triad-gauges-row">
              {/* Codex Companion Gauge */}
              <div className="ai-triad-item">
                <SpeedometerGauge
                  percent={is5h ? aggregates.codex.percent5h : aggregates.codex.percentWeekly}
                  availablePercent={is5h ? aggregates.codex.available5h : aggregates.codex.availableWeekly}
                  totalPoolPercent={is5h ? aggregates.codex.pool5h : aggregates.codex.poolWeekly}
                  label="Codex"
                  subLabel={`${codexActiveCount}/${aggregates.codex.totalAccounts} active`}
                  size="sm"
                  trendDelta={deltas.codex}
                  idPrefix="triad-codex"
                />
              </div>

              {/* Antigravity Gemini Companion Gauge */}
              <div className="ai-triad-item">
                <SpeedometerGauge
                  percent={is5h ? aggregates.gemini.percent5h : aggregates.gemini.percentWeekly}
                  availablePercent={is5h ? aggregates.gemini.available5h : aggregates.gemini.availableWeekly}
                  totalPoolPercent={is5h ? aggregates.gemini.pool5h : aggregates.gemini.poolWeekly}
                  label="AGY Gemini"
                  subLabel={`${geminiActiveCount}/${aggregates.gemini.totalAccounts} active`}
                  size="sm"
                  trendDelta={deltas.gemini}
                  idPrefix="triad-gemini"
                />
              </div>

              {/* Antigravity Claude Companion Gauge */}
              <div className="ai-triad-item">
                <SpeedometerGauge
                  percent={is5h ? aggregates.claude.percent5h : aggregates.claude.percentWeekly}
                  availablePercent={is5h ? aggregates.claude.available5h : aggregates.claude.availableWeekly}
                  totalPoolPercent={is5h ? aggregates.claude.pool5h : aggregates.claude.poolWeekly}
                  label="AGY Claude"
                  subLabel={`${claudeActiveCount}/${aggregates.claude.totalAccounts} active`}
                  size="sm"
                  trendDelta={deltas.claude}
                  idPrefix="triad-claude"
                />
              </div>
            </div>

            {/* API Providers Quick Strip */}
            <div className="ai-api-quick-strip">
              <div className="ai-api-quick-left">
                <Globe className="ai-api-quick-icon" />
                <span className="ai-api-quick-title">API Providers:</span>
                <span className="ai-api-quick-status is-good">
                  {aggregates.apiProviders.connectedProviders}/{aggregates.apiProviders.totalProviders} Active
                </span>
                {aggregates.apiProviders.totalBalanceUsd > 0 && (
                  <span className="ai-api-quick-bal">
                    (${aggregates.apiProviders.totalBalanceUsd.toFixed(2)} Balance)
                  </span>
                )}
              </div>
              <button
                type="button"
                className="ai-api-quick-btn"
                onClick={() => updateConfig({ activeTab: "api" })}
              >
                View APIs →
              </button>
            </div>
          </div>
        )}

        {config.activeTab === "codex" && (
          <div className="ai-single-provider-view">
            <div className="ai-master-gauge-box">
              <SpeedometerGauge
                percent={is5h ? aggregates.codex.percent5h : aggregates.codex.percentWeekly}
                availablePercent={is5h ? aggregates.codex.available5h : aggregates.codex.availableWeekly}
                totalPoolPercent={is5h ? aggregates.codex.pool5h : aggregates.codex.poolWeekly}
                label="Codex Total Quota"
                subLabel={`${aggregates.codex.totalAccounts} accounts (${codexActiveCount} active, ${codexExhaustedCount} exhausted)`}
                size="lg"
                trendDelta={deltas.codex}
                idPrefix="solo-codex"
              />
            </div>
          </div>
        )}

        {config.activeTab === "antigravity" && (
          <div className="ai-dual-agy-view">
            <div className="ai-dual-gauges-row">
              <div className="ai-dual-gauge-col">
                <SpeedometerGauge
                  percent={is5h ? aggregates.gemini.percent5h : aggregates.gemini.percentWeekly}
                  availablePercent={is5h ? aggregates.gemini.available5h : aggregates.gemini.availableWeekly}
                  totalPoolPercent={is5h ? aggregates.gemini.pool5h : aggregates.gemini.poolWeekly}
                  label="Antigravity Gemini"
                  subLabel={`${geminiActiveCount}/${aggregates.gemini.totalAccounts} active`}
                  size="md"
                  trendDelta={deltas.gemini}
                  idPrefix="dual-gemini"
                />
              </div>
              <div className="ai-dual-gauge-col">
                <SpeedometerGauge
                  percent={is5h ? aggregates.claude.percent5h : aggregates.claude.percentWeekly}
                  availablePercent={is5h ? aggregates.claude.available5h : aggregates.claude.availableWeekly}
                  totalPoolPercent={is5h ? aggregates.claude.pool5h : aggregates.claude.poolWeekly}
                  label="Antigravity Claude"
                  subLabel={`${claudeActiveCount}/${aggregates.claude.totalAccounts} active`}
                  size="md"
                  trendDelta={deltas.claude}
                  idPrefix="dual-claude"
                />
              </div>
            </div>
          </div>
        )}

        {config.activeTab === "api" && (
          <div className="ai-api-providers-view">
            <div className="ai-api-overview-strip">
              <div className="ai-api-stat-col">
                <span className="ai-api-stat-val is-green">
                  {aggregates.apiProviders.connectedProviders}/{aggregates.apiProviders.totalProviders}
                </span>
                <span className="ai-api-stat-lbl">Active</span>
              </div>
              <div className="ai-api-stat-col">
                <span className="ai-api-stat-val">
                  {aggregates.apiProviders.totalBalanceUsd > 0
                    ? `$${aggregates.apiProviders.totalBalanceUsd.toFixed(2)}`
                    : "Pay-as-you-go"}
                </span>
                <span className="ai-api-stat-lbl">Tracked Balance</span>
              </div>
              <div className="ai-api-stat-col">
                <span className="ai-api-stat-val is-green">
                  {aggregates.apiProviders.totalProviders > 0
                    ? Math.round(
                        (aggregates.apiProviders.connectedProviders /
                          aggregates.apiProviders.totalProviders) *
                          100
                      )
                    : 100}
                  %
                </span>
                <span className="ai-api-stat-lbl">Health</span>
              </div>
            </div>

            <div className="ai-api-cards-grid">
              {aggregates.apiProviders.providers.map((p) => (
                <ApiProviderCard key={p.id} provider={p} />
              ))}
              {!aggregates.apiProviders.providers.length && (
                <p className="ai-quota-stale-tag">No API providers discovered.</p>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Account Breakdown Drawer Toggle */}
      <div className="ai-quota-breakdown-control">
        <button
          type="button"
          className="ai-quota-breakdown-toggle-btn"
          onClick={() => setExpandedAccounts((prev) => !prev)}
          aria-expanded={expandedAccounts}
        >
          <span>All Accounts Breakdown ({aggregates.totalAiPool.totalAccounts} accounts)</span>
          {expandedAccounts ? <ChevronUp className="ai-chevron-svg" /> : <ChevronDown className="ai-chevron-svg" />}
        </button>
      </div>

      {/* Expandable Individual Account Bars */}
      {expandedAccounts && (
        <div className="ai-quota-accounts-drawer">
          <ul className="ai-quota-accounts-list">
            {(config.activeTab === "all" || config.activeTab === "codex") &&
              aggregates.codex.accounts.map((acc) => (
                <AccountQuotaItemRow key={acc.id} item={acc} is5h={is5h} />
              ))}
            {(config.activeTab === "all" || config.activeTab === "antigravity") &&
              aggregates.antigravityCombined.accounts.map((acc) => (
                <AccountQuotaItemRow key={acc.id} item={acc} is5h={is5h} />
              ))}
            {(config.activeTab === "all" || config.activeTab === "api") &&
              aggregates.apiProviders.providers.map((acc) => (
                <ApiProviderAccountRow key={acc.id} provider={acc} />
              ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ApiProviderCard({ provider }: { provider: ApiProviderAccount }) {
  const isConnected = provider.status === "CONNECTED";
  const isExhausted = provider.status === "EXHAUSTED";
  const isError = provider.status === "ERROR";
  const statusClass = isConnected
    ? "is-connected"
    : isExhausted
    ? "is-exhausted"
    : isError
    ? "is-error"
    : "is-unconfigured";

  const remainingPct =
    provider.remainingPercent !== undefined && provider.remainingPercent !== null
      ? Math.round(provider.remainingPercent)
      : null;

  return (
    <div className="ai-api-card">
      <div className="ai-api-card-head">
        <div className="ai-api-card-title-group">
          <Globe className="ai-tab-icon" />
          <span className="ai-api-card-title">{provider.label}</span>
        </div>
        <div className="ai-api-card-badges">
          <span className={`ai-api-badge ${statusClass}`}>{provider.status}</span>
          {provider.balance && (
            <span className="ai-api-balance-badge">{provider.balance}</span>
          )}
        </div>
      </div>

      {remainingPct !== null && (
        <div className="ai-account-bar-track">
          <div
            className={`ai-account-bar-fill ${remainingPct > 50 ? "is-good" : remainingPct > 15 ? "is-warning" : "is-critical"}`}
            style={{ width: `${remainingPct}%` }}
          />
        </div>
      )}

      {provider.models && provider.models.length > 0 && (
        <div className="ai-api-card-models">
          {provider.models.map((m) => (
            <span key={m} className="ai-api-model-pill">{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

export function ApiProviderAccountRow({ provider }: { provider: ApiProviderAccount }) {
  const isConnected = provider.status === "CONNECTED";
  const remainingPct =
    provider.remainingPercent !== undefined && provider.remainingPercent !== null
      ? Math.round(provider.remainingPercent)
      : isConnected
      ? 100
      : 0;

  const tone = isConnected ? "is-good" : "is-critical";

  return (
    <li className="ai-account-row">
      <div className="ai-account-row-head">
        <span className="ai-account-label" title={provider.label}>
          {provider.label}
        </span>
        <div className="ai-account-meta">
          <span className="ai-account-badge is-tier">API</span>
          <span
            className={`ai-account-badge ${isConnected ? "is-connected" : "is-error"}`}
          >
            {provider.status}
          </span>
          <span className={`ai-account-pct-text ${tone}`}>
            {provider.balance || (isConnected ? "Active" : "--")}
          </span>
        </div>
      </div>

      <div className="ai-account-bar-track">
        <div
          className={`ai-account-bar-fill ${tone}`}
          style={{ width: `${remainingPct}%` }}
        />
      </div>
    </li>
  );
}

function AccountQuotaItemRow({
  item,
  is5h
}: {
  item: QuotaBreakdownItem;
  is5h: boolean;
}) {
  const percent = is5h ? item.fiveHourPercent : item.weeklyPercent;
  const resetAt = is5h ? item.fiveHourResetAt : item.weeklyResetAt;
  const timeStr = formatTimeRemaining(resetAt);

  const displayPercent =
    typeof percent === "number" && Number.isFinite(percent) ? Math.round(percent) : null;

  const isExceeded = item.status === "QUOTA_EXCEEDED";

  const tone =
    isExceeded
      ? "is-critical"
      : displayPercent === null
      ? "dim"
      : displayPercent > 50
      ? "is-good"
      : displayPercent > 15
      ? "is-warning"
      : "is-critical";

  return (
    <li className="ai-account-row">
      <div className="ai-account-row-head">
        <span className="ai-account-label" title={item.label}>
          {item.label}
        </span>
        <div className="ai-account-meta">
          {item.tier ? (
            <span className="ai-account-badge is-tier" title={`Tier: ${item.tier} (weight: ${item.weight ?? 1}x)`}>
              {item.tier}
              {item.weight && item.weight > 1 ? ` · ${item.weight}x` : item.weight === 0 ? " · 0x" : ""}
            </span>
          ) : null}
          {item.status && item.status !== "CONNECTED" && item.status !== "ACTIVE" ? (
            <span
              className={`ai-account-badge ${
                item.status === "UNLICENSED"
                  ? "is-unlicensed"
                  : "is-error"
              }`}
            >
              {item.status === "QUOTA_EXCEEDED" ? "Quota exceeded" : item.status}
            </span>
          ) : null}
          <span className={`ai-account-pct-text ${tone}`}>
            {displayPercent !== null ? `${displayPercent}%` : "--"}
            {item.weight && item.weight > 1 && displayPercent !== null ? (
              <small className="ai-account-weight-text" title={`Weighted credits: ${Math.round(displayPercent * item.weight)} / ${item.weight * 100} credits`}>
                {" "}({Math.round(displayPercent * item.weight)})
              </small>
            ) : null}
          </span>
        </div>
      </div>

      <div className="ai-account-bar-track">
        <div
          className={`ai-account-bar-fill ${tone}`}
          style={{ width: `${displayPercent ?? 0}%` }}
        />
      </div>

      {timeStr ? (
        <div className="ai-account-reset-time">
          <Clock className="ai-time-icon" />
          <span>{is5h ? "5h reset" : "week reset"} in {timeStr}</span>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Desktop Floating Widget Component
 */
interface AiQuotaWidgetProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus?: () => void;
}

export function AiQuotaWidget({
  state,
  isMultiColumn = false,
  isHeaderDockActive,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus
}: AiQuotaWidgetProps) {
  const [config, setConfig] = useState<AiQuotaWidgetConfig>(() =>
    loadWidgetConfig("ai-quota", DEFAULT_AI_QUOTA_CONFIG)
  );

  const updateConfig = (patch: Partial<AiQuotaWidgetConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      saveWidgetConfig("ai-quota", next);
      return next;
    });
  };

  return (
    <DesktopWidgetContainer
      id="ai-quota"
      title="AI Quota & Usage"
      icon={<Gauge className="widget-header-svg" />}
      x={state.x}
      y={state.y}
      zIndex={state.zIndex}
      minimized={state.minimized}
      dockedToRail={state.dockedToRail}
      dockPosition={state.dockPosition}
      isMultiColumn={isMultiColumn}
      isHeaderDockActive={isHeaderDockActive}
      hideTitleOnMinimize={true}
      onPositionChange={onPositionChange}
      onToggleMinimize={onToggleMinimize}
      onClose={onClose}
      onFocus={onFocus}
      minimizedSummary={<AiQuotaMinimizedSummary config={config} />}
      dockedSummary={<AiQuotaDockedSummary config={config} />}
      className="widget-ai-quota-container"
    >
      <div className="widget-ai-quota-content">
        <AiQuotaGaugeCard
          embedded={false}
          externalConfig={config}
          onUpdateConfig={updateConfig}
        />
      </div>
    </DesktopWidgetContainer>
  );
}

/**
 * Minimized summary badge shown when widget is collapsed
 */
function AiQuotaMinimizedSummary({ config }: { config?: AiQuotaWidgetConfig }) {
  const [data, setData] = useState<SharedQuotaCache | null>(() => sharedQuotaCache);
  const cycleSec = config?.miniCycleIntervalSeconds ?? 30;
  const isAutoRefresh = config?.autoRefresh ?? true;
  const windowMode = config?.windowMode === "weekly" ? "wk" : "5h";
  const [viewMode, setViewMode] = useState<"5h" | "wk">(windowMode);

  useEffect(() => {
    void fetchSharedQuotaMetrics(false).then((res) => {
      setData(res);
    });
  }, []);

  // When autoRefresh is stopped (paused), freeze and do NOT alternate!
  useEffect(() => {
    if (!isAutoRefresh) {
      setViewMode(windowMode);
      return;
    }

    const intervalMs = Math.max(2, cycleSec) * 1000;
    const timer = setInterval(() => {
      setViewMode((prev) => (prev === "5h" ? "wk" : "5h"));
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isAutoRefresh, cycleSec, windowMode]);

  const aggregates = useMemo(
    () => computeQuotaAggregates(data?.codex, data?.agy, data?.api),
    [data]
  );

  const is5h = viewMode === "5h";
  const codexPct = Math.round(is5h ? aggregates.codex.percent5h : aggregates.codex.percentWeekly);
  const agyPct = Math.round(
    is5h ? aggregates.antigravityCombined.percent5h : aggregates.antigravityCombined.percentWeekly
  );

  return (
    <span
      className="widget-ai-quota-mini-badge"
      title={`AI Capacity Overview (${is5h ? "5-Hour Quota" : "Weekly Quota"})`}
    >
      <span className="ai-mini-mode-tag">{viewMode}</span>
      <span className="ai-mini-tag">Codex {codexPct}%</span>
      <span className="ai-mini-dot">·</span>
      <span className="ai-mini-tag">AGY {agyPct}%</span>
    </span>
  );
}

/**
 * Docked summary for AI Quota widget when docked on right rail
 */
function AiQuotaDockedSummary({ config }: { config?: AiQuotaWidgetConfig }) {
  const [data, setData] = useState<SharedQuotaCache | null>(() => sharedQuotaCache);
  const windowMode = config?.windowMode === "weekly" ? "wk" : "5h";

  useEffect(() => {
    void fetchSharedQuotaMetrics(false).then((res) => {
      setData(res);
    });
  }, []);

  const aggregates = useMemo(
    () => computeQuotaAggregates(data?.codex, data?.agy, data?.api),
    [data]
  );

  const is5h = windowMode === "5h";
  const codexPct = Math.round(is5h ? aggregates.codex.percent5h : aggregates.codex.percentWeekly);
  const agyPct = Math.round(
    is5h ? aggregates.antigravityCombined.percent5h : aggregates.antigravityCombined.percentWeekly
  );

  return (
    <div className="widget-docked-rail-body ai-quota-docked-body">
      <div className="ai-quota-docked-row">
        <span className="widget-docked-badge">{windowMode}</span>
        <span className="widget-docked-title">Codex</span>
        <span className="widget-docked-countdown">{codexPct}%</span>
      </div>
      <div className="ai-quota-docked-row">
        <span className="widget-docked-title">AGY</span>
        <span className="widget-docked-countdown">{agyPct}%</span>
      </div>
    </div>
  );
}
