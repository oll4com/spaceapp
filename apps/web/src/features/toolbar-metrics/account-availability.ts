import {
  formatAppTime,
  readDateTimeSettings,
  type DateTimeSettings,
} from "../date-time-settings/date-time-settings.js";

// One vocabulary for every provider card: usable now, usable again within a few hours,
// or blocked until the weekly window resets. Offline means the account cannot report.
export type AccountAvailability = "available" | "soon" | "exhausted" | "unknown" | "offline";
export type AccountAvailabilityFilter = "all" | "available" | "soon" | "exhausted";

export const ACCOUNT_AVAILABLE_THRESHOLD_PERCENT = 1;
// A weekly limit that resets within one 5h window is reported as "back soon".
export const ACCOUNT_SOON_WINDOW_MS = 5 * 3600_000;

export interface QuotaWindows {
  fiveHourRemainingPercent?: number | null;
  fiveHourResetAt?: string | null;
  weeklyRemainingPercent?: number | null;
  weeklyResetAt?: string | null;
}

export interface AvailabilityState {
  state: AccountAvailability;
  // When the account becomes usable again; null when it already is or nobody knows.
  backAt: string | null;
}

const availabilityRank: Record<AccountAvailability, number> = {
  available: 0,
  soon: 1,
  exhausted: 2,
  unknown: 3,
  offline: 4,
};

function timeMs(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

export function classifyQuota(
  quota: QuotaWindows,
  clock: number,
  threshold: number = ACCOUNT_AVAILABLE_THRESHOLD_PERCENT,
): AvailabilityState {
  const fiveHour = quota.fiveHourRemainingPercent;
  const weekly = quota.weeklyRemainingPercent;
  if (fiveHour == null && weekly == null) return { state: "unknown", backAt: null };
  if (weekly != null && weekly < threshold) {
    const backAt = quota.weeklyResetAt ?? null;
    return { state: timeMs(backAt) - clock <= ACCOUNT_SOON_WINDOW_MS ? "soon" : "exhausted", backAt };
  }
  if (fiveHour != null && fiveHour < threshold) return { state: "soon", backAt: quota.fiveHourResetAt ?? null };
  return { state: "available", backAt: null };
}

// An account with several model groups is as available as its best group.
export function bestAvailability(states: AvailabilityState[]): AvailabilityState {
  if (!states.length) return { state: "unknown", backAt: null };
  return [...states].sort((left, right) =>
    availabilityRank[left.state] - availabilityRank[right.state] || timeMs(left.backAt) - timeMs(right.backAt)
  )[0]!;
}

export function compareAvailability(
  left: { availability: AvailabilityState; capacity: number; title: string },
  right: { availability: AvailabilityState; capacity: number; title: string },
): number {
  return availabilityRank[left.availability.state] - availabilityRank[right.availability.state]
    || timeMs(left.availability.backAt) - timeMs(right.availability.backAt)
    || right.capacity - left.capacity
    || left.title.localeCompare(right.title);
}

// Remaining share of the tightest window in the roomiest group; -1 when nothing is known.
export function quotaCapacity(quotas: QuotaWindows[]): number {
  return Math.max(-1, ...quotas.map((quota) =>
    quota.fiveHourRemainingPercent == null && quota.weeklyRemainingPercent == null
      ? -1
      : Math.min(quota.fiveHourRemainingPercent ?? 100, quota.weeklyRemainingPercent ?? 100)
  ));
}

export function matchesAvailabilityFilter(state: AccountAvailability, filter: AccountAvailabilityFilter): boolean {
  return filter === "all" || state === filter;
}

function resetMoment(ms: number, settings?: DateTimeSettings): string {
  const active = settings ?? readDateTimeSettings();
  const timeZone = active.timeZone && active.timeZone !== "system" ? active.timeZone : undefined;
  let weekday = "";
  try {
    weekday = new Intl.DateTimeFormat("en-US", { weekday: "short", ...(timeZone ? { timeZone } : {}) }).format(new Date(ms));
  } catch {
    weekday = "";
  }
  const time = formatAppTime(new Date(ms), { hour: "2-digit", minute: "2-digit" }, active);
  return weekday ? `${weekday} ${time}` : time;
}

// "in 52m" and "in 3h 20m" inside a day; a weekday and time further out (a week at most).
export function formatUntil(value: string | null | undefined, clock: number, settings?: DateTimeSettings): string | null {
  const ms = timeMs(value);
  if (!Number.isFinite(ms)) return null;
  const diffMs = ms - clock;
  if (diffMs <= 0) return "now";
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  if (minutes < 24 * 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `in ${hours}h ${rest}m` : `in ${hours}h`;
  }
  return resetMoment(ms, settings);
}

export function availabilityLabel(availability: AvailabilityState, clock: number, settings?: DateTimeSettings): string {
  switch (availability.state) {
    case "available": return "Available";
    case "soon": {
      const until = formatUntil(availability.backAt, clock, settings);
      if (until === "now") return "Back now";
      return until ? `Back ${until}` : "Limit reached";
    }
    case "exhausted": return "Week exhausted";
    case "unknown": return "No data";
    default: return "Offline";
  }
}
