import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const SUPPRESS_NOTIFICATIONS_STORAGE_KEY = "space.notifications.suppress.v1";
export const DEFAULT_SUPPRESS_NOTIFICATIONS = false;

export function readStoredSuppressNotifications(): boolean {
  if (typeof window === "undefined") return DEFAULT_SUPPRESS_NOTIFICATIONS;
  try {
    const stored = getSpaceRuntime().platform.localStorage.getItem(SUPPRESS_NOTIFICATIONS_STORAGE_KEY);
    if (stored === null) return DEFAULT_SUPPRESS_NOTIFICATIONS;
    return stored === "true";
  } catch {
    return DEFAULT_SUPPRESS_NOTIFICATIONS;
  }
}

export function writeStoredSuppressNotifications(suppressed: boolean): boolean {
  if (typeof window === "undefined") return suppressed;
  try {
    getSpaceRuntime().platform.localStorage.setItem(
      SUPPRESS_NOTIFICATIONS_STORAGE_KEY,
      String(suppressed)
    );
  } catch {
    // The effective in-memory setting still applies when browser storage is unavailable.
  }
  return suppressed;
}
