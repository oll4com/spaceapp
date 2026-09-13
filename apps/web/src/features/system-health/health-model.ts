import type {
  CodexEnvironment,
  CodexUsageAccount,
  CodexUsageAccountList,
  SystemHealthMetric,
  SystemHealthService
} from "@space/contracts";

export type HealthTone =
  "healthy" | "warning" | "critical" | "unavailable" | "stale" | "disabled";
export type ThresholdKey =
  | "cpu"
  | "memory"
  | "swap"
  | "disk"
  | "diskBusy"
  | "network"
  | "accounts"
  | "rtt"
  | "p95"
  | "errors";
export interface Threshold {
  warning: number;
  critical: number;
}
export type HealthThresholds = Record<ThresholdKey, Threshold>;
export const thresholdDefinitions: Array<{
  key: ThresholdKey;
  label: string;
  unit: string;
  low?: boolean;
  max?: number;
}> = [
  { key: "cpu", label: "CPU", unit: "%", max: 100 },
  { key: "memory", label: "Memory", unit: "%", max: 100 },
  { key: "swap", label: "Swap", unit: "%", max: 100 },
  { key: "disk", label: "Disk space used", unit: "%", max: 100 },
  { key: "diskBusy", label: "Disk active time", unit: "%", max: 100 },
  { key: "network", label: "Link utilization", unit: "%", max: 100 },
  {
    key: "accounts",
    label: "Account remaining",
    unit: "%",
    low: true,
    max: 100,
  },
  { key: "rtt", label: "Connection latency", unit: "ms" },
  { key: "p95", label: "API p95", unit: "ms" },
  { key: "errors", label: "API errors (5 min)", unit: "%", max: 100 },
];
export const defaultHealthThresholds: HealthThresholds = {
  cpu: { warning: 85, critical: 95 },
  memory: { warning: 80, critical: 90 },
  swap: { warning: 50, critical: 80 },
  disk: { warning: 80, critical: 90 },
  diskBusy: { warning: 85, critical: 95 },
  network: { warning: 80, critical: 95 },
  accounts: { warning: 20, critical: 10 },
  rtt: { warning: 300, critical: 425 },
  p95: { warning: 1000, critical: 2500 },
  errors: { warning: 1, critical: 5 },
};
export function validHealthThresholds(
  input: unknown,
): input is HealthThresholds {
  if (!input || typeof input !== "object") return false;
  return thresholdDefinitions.every((d) => {
    const t = (input as HealthThresholds)[d.key];
    return (
      t &&
      Number.isFinite(t.warning) &&
      Number.isFinite(t.critical) &&
      t.warning >= 0 &&
      t.critical >= 0 &&
      (d.max === undefined || Math.max(t.warning, t.critical) <= d.max) &&
      (d.low ? t.critical < t.warning : t.warning < t.critical)
    );
  });
}
export const healthThresholdStorageKey = (userId: string) =>
  `space.systemHealth.thresholds.v1.${userId}`;
export const healthRailStorageKey = (userId: string) =>
  `space.systemHealth.indicators.v1.${userId}`;
export function readHealthThresholds(
  storage: Pick<Storage, "getItem">,
  userId: string,
): HealthThresholds {
  try {
    const value: unknown = JSON.parse(
      storage.getItem(healthThresholdStorageKey(userId)) ?? "null",
    );
    if (validHealthThresholds(value)) return value;
  } catch {
    /* Browser storage can be unavailable. */
  }
  return structuredClone(defaultHealthThresholds);
}
export function thresholdKey(id: string): ThresholdKey | null {
  if (["cpu", "memory", "swap", "accounts", "rtt"].includes(id))
    return id as ThresholdKey;
  if (id === "disk-root" || id === "disk-app") return "disk";
  if (id.startsWith("disk:") && id.endsWith(":busy")) return "diskBusy";
  if (id.startsWith("network:") && id.endsWith(":usage")) return "network";
  if (id === "request-p95") return "p95";
  if (id === "request-errors") return "errors";
  return null;
}
export function numericHealthTone(
  id: string,
  value: number | null | undefined,
  thresholds: HealthThresholds,
): HealthTone {
  if (value == null || !Number.isFinite(value)) return "unavailable";
  const key = thresholdKey(id);
  if (!key) return "healthy";
  const t = thresholds[key];
  if (key === "accounts")
    return value <= t.critical
      ? "critical"
      : value <= t.warning
        ? "warning"
        : "healthy";
  return value >= t.critical
    ? "critical"
    : value >= t.warning
      ? "warning"
      : "healthy";
}
export interface ToneState {
  tone: HealthTone;
  pending: HealthTone;
  count: number;
  at: string;
  since: string;
}
export function advanceHealthTone(
  previous: ToneState | undefined,
  next: HealthTone,
  at: string,
): ToneState {
  if (previous?.at === at) return previous;
  if (!previous)
    return {
      tone: next === "critical" || next === "warning" ? "unavailable" : next,
      pending: next,
      count: 1,
      at,
      since: at,
    };
  const count = previous.pending === next ? previous.count + 1 : 1;
  const immediate =
    next === "unavailable" || next === "stale" || next === "disabled";
  const tone = immediate || count >= 2 ? next : previous.tone;
  return {
    tone,
    pending: next,
    count,
    at,
    since: tone === previous.tone ? previous.since : at,
  };
}
export function formatHealthValue(
  value: number | null | undefined,
  unit: SystemHealthMetric["unit"],
): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (unit === "PERCENT") return `${Math.round(value)}%`;
  if (unit === "MILLISECONDS") return `${Math.round(value)} ms`;
  if (unit === "COUNT") return String(Math.round(value));
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let n = value,
    i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}${unit === "BYTES_PER_SECOND" ? "/s" : ""}`;
}
export function serviceTone(
  service: SystemHealthService,
  now: number,
): HealthTone {
  return now - Date.parse(service.checkedAt) > 30_000
    ? "stale"
    : service.status;
}
export function overallHealth(tones: HealthTone[]): HealthTone {
  if (tones.includes("critical")) return "critical";
  if (tones.includes("warning")) return "warning";
  if (tones.some((t) => t === "stale" || t === "unavailable"))
    return "unavailable";
  return tones.some((t) => t === "healthy") ? "healthy" : "unavailable";
}
export const toneLabels: Record<HealthTone, string> = {
  healthy: "Healthy",
  warning: "Warning",
  critical: "Critical",
  unavailable: "Unavailable",
  stale: "Stale",
  disabled: "Disabled",
};

export type HealthSection =
  "overview" | "performance" | "processes" | "services" | "ai" | "alerts" | "usage";
export function openSystemHealth(
  section: HealthSection = "overview",
  metric?: string,
) {
  window.dispatchEvent(
    new CustomEvent("space:system-health", {
      detail: { section, metric, resources: false },
    }),
  );
}
export function openSystemResources(metric?: string) {
  window.dispatchEvent(
    new CustomEvent("space:system-health", {
      detail: { metric, resources: true },
    }),
  );
}

export interface CodexCooldownState {
  isExhausted: boolean;
  minutesRemaining: number;
  secondsRemaining: number;
  formatted: string;
  accountLabel: string | null;
  resetAt: string | null;
}

export const CODEX_EXHAUSTION_THRESHOLD_PERCENT = 3;

export function isCodexAccountActive(
  account: { fiveHourRemainingPercent?: number | null; weeklyRemainingPercent?: number | null },
  threshold: number = CODEX_EXHAUSTION_THRESHOLD_PERCENT,
): boolean {
  const fiveHour = account.fiveHourRemainingPercent ?? 0;
  const weekly = account.weeklyRemainingPercent ?? 0;
  return fiveHour >= threshold && weekly >= threshold;
}

export function computeCodexCooldown(
  accounts: CodexUsageAccountList | null | undefined,
  environment: CodexEnvironment | null | undefined,
  clock: number,
  threshold: number = CODEX_EXHAUSTION_THRESHOLD_PERCENT,
): CodexCooldownState | null {
  if (environment?.isCodexEnabled === false) return null;
  if (!accounts?.data || accounts.data.length === 0) return null;

  const hasActiveAccount = accounts.data.some((account) =>
    isCodexAccountActive(account, threshold),
  );

  if (hasActiveAccount) {
    return null;
  }

  let soonestResetMs: number | null = null;
  let soonestAccount: CodexUsageAccount | null = null;
  let soonestResetIso: string | null = null;

  for (const account of accounts.data) {
    const weekly = account.weeklyRemainingPercent ?? 0;
    const fiveHour = account.fiveHourRemainingPercent ?? 0;

    let targetIso: string | null = null;
    if (weekly >= threshold && fiveHour < threshold) {
      targetIso = account.fiveHourResetAt ?? null;
    } else if (weekly < threshold && fiveHour >= threshold) {
      targetIso = account.weeklyResetAt ?? null;
    } else if (weekly < threshold && fiveHour < threshold) {
      targetIso = account.weeklyResetAt ?? account.fiveHourResetAt ?? null;
    }

    if (!targetIso) continue;
    const targetMs = Date.parse(targetIso);
    if (!Number.isFinite(targetMs)) continue;

    if (soonestResetMs === null || targetMs < soonestResetMs) {
      soonestResetMs = targetMs;
      soonestAccount = account;
      soonestResetIso = targetIso;
    }
  }

  if (soonestResetMs === null) return null;

  const diffMs = soonestResetMs - clock;
  const totalSeconds = Math.max(0, Math.round(diffMs / 1000));
  const totalMinutes = Math.max(0, Math.round(totalSeconds / 60));

  let formatted = "";
  if (totalSeconds >= 3600) {
    const hours = Math.floor(totalSeconds / 3600);
    const mins = Math.floor((totalSeconds % 3600) / 60);
    formatted = `${hours}h ${mins}m`;
  } else if (totalSeconds >= 60) {
    formatted = `${totalMinutes}m`;
  } else if (totalSeconds > 0) {
    formatted = `${totalSeconds}s`;
  } else {
    formatted = "<1m";
  }

  return {
    isExhausted: true,
    minutesRemaining: totalMinutes,
    secondsRemaining: totalSeconds,
    formatted,
    accountLabel: soonestAccount?.label ?? null,
    resetAt: soonestResetIso,
  };
}

