import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

// Tab-scoped string preferences (session storage); an empty value is the same as none.

export function readStoredSessionString(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const value = getSpaceRuntime().platform.sessionStorage.getItem(key);
    return value || null;
  } catch {
    return null;
  }
}

export function writeStoredSessionString(key: string, value: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (value) {
      getSpaceRuntime().platform.sessionStorage.setItem(key, value);
    } else {
      getSpaceRuntime().platform.sessionStorage.removeItem(key);
    }
  } catch {
    // Session-only preference when storage is blocked.
  }
}
