import { formatAppTime } from "../date-time-settings/date-time-settings.js";
import type { NextAccountBack, QuotaAlertProvider, WatchedQuota } from "./quota-overview.js";

export interface QuotaAlarmLogEntry {
  id: string;
  timestamp: string; // ISO 8601
  localTime: string; // Human-readable local timestamp
  // claude_api_key_fallback: Space Gateway served a Claude request through the API key (every account was out of quota).
  triggerSource: "quota_available_transition" | "manual_test" | "claude_api_key_fallback";
  provider: QuotaAlertProvider;
  proOnly: boolean;
  availableCount: number;
  totalCount: number;
  availableAccounts: WatchedQuota["availableAccounts"];
  nextBack: NextAccountBack | null;
}

// A new key: entries of the former AI Token Reminder have another shape.
export const ALARM_LOG_STORAGE_KEY = "space:ai-quota:alarm-log";
export const ALARM_LOG_UPDATED_EVENT = "space:ai-quota:alarm-log-updated";
const MAX_LOG_ENTRIES = 100;

export function getAlarmLogs(): QuotaAlarmLogEntry[] {
  try {
    const raw = localStorage.getItem(ALARM_LOG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordAlarmEvent(entry: Omit<QuotaAlarmLogEntry, "id" | "timestamp" | "localTime">): QuotaAlarmLogEntry {
  const now = new Date();
  const fullEntry: QuotaAlarmLogEntry = {
    id: `alarm_${now.getTime()}_${Math.random().toString(36).slice(2, 7)}`,
    timestamp: now.toISOString(),
    localTime: formatAppTime(now.toISOString()),
    ...entry,
  };
  try {
    localStorage.setItem(ALARM_LOG_STORAGE_KEY, JSON.stringify([fullEntry, ...getAlarmLogs()].slice(0, MAX_LOG_ENTRIES)));
    window.dispatchEvent(new CustomEvent(ALARM_LOG_UPDATED_EVENT, { detail: fullEntry }));
  } catch {
    // Best-effort persistence
  }
  return fullEntry;
}

export function clearAlarmLogs(): void {
  try {
    localStorage.removeItem(ALARM_LOG_STORAGE_KEY);
    window.dispatchEvent(new CustomEvent(ALARM_LOG_UPDATED_EVENT));
  } catch {
    // Best-effort persistence
  }
}
