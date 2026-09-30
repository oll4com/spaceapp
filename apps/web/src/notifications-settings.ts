import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";
import { api } from "./api.js";

export const SUPPRESS_NOTIFICATIONS_STORAGE_KEY = "space.notifications.suppress.v1";
export const DEFAULT_SUPPRESS_NOTIFICATIONS = false;

function syncDocumentNotificationAttribute(suppressed: boolean): void {
  if (typeof document === "undefined") return;
  try {
    document.documentElement.setAttribute("data-suppress-notifications", String(suppressed));
    document.body?.setAttribute("data-suppress-notifications", String(suppressed));
  } catch {
    // Ignore DOM errors
  }
}

function getPlatformLocalStorage(): Storage | null {
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    if (typeof window !== "undefined" && window.localStorage) {
      return window.localStorage;
    }
    return null;
  }
}

export function readStoredSuppressNotifications(): boolean {
  if (typeof window === "undefined") return DEFAULT_SUPPRESS_NOTIFICATIONS;
  try {
    const storage = getPlatformLocalStorage();
    if (!storage) return DEFAULT_SUPPRESS_NOTIFICATIONS;
    const stored = storage.getItem(SUPPRESS_NOTIFICATIONS_STORAGE_KEY);
    if (stored === null) return DEFAULT_SUPPRESS_NOTIFICATIONS;
    const value = stored === "true";
    syncDocumentNotificationAttribute(value);
    return value;
  } catch {
    return DEFAULT_SUPPRESS_NOTIFICATIONS;
  }
}

export function applyServerSuppressNotifications(suppressed: boolean): boolean {
  if (typeof window === "undefined") return suppressed;
  try {
    getPlatformLocalStorage()?.setItem(
      SUPPRESS_NOTIFICATIONS_STORAGE_KEY,
      String(suppressed)
    );
    syncDocumentNotificationAttribute(suppressed);
  } catch {
    // Ignore storage errors
  }
  return suppressed;
}

export function writeStoredSuppressNotifications(suppressed: boolean): boolean {
  if (typeof window === "undefined") return suppressed;
  try {
    getPlatformLocalStorage()?.setItem(
      SUPPRESS_NOTIFICATIONS_STORAGE_KEY,
      String(suppressed)
    );
    syncDocumentNotificationAttribute(suppressed);
  } catch {
    // The effective in-memory setting still applies when browser storage is unavailable.
  }
  try {
    void api.updateUserSettings({ suppressNotifications: suppressed }).catch(() => {
      // Session/offline fallback
    });
  } catch {
    // Runtime unavailable (e.g. isolated unit tests)
  }
  return suppressed;
}
