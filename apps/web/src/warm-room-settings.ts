import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const WARM_ROOM_ENABLED_STORAGE_KEY = "space.warmRoom.enabled.v1";
export const DEFAULT_WARM_ROOM_ENABLED = true;
export const LEGACY_WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY =
  "space.warmRoom.connectedPaneLimit.v1";

export function readStoredWarmRoomEnabled(): boolean {
  if (typeof window === "undefined") return DEFAULT_WARM_ROOM_ENABLED;
  try {
    const stored = getSpaceRuntime().platform.localStorage.getItem(WARM_ROOM_ENABLED_STORAGE_KEY);
    if (stored === null) return DEFAULT_WARM_ROOM_ENABLED;
    return stored === "true";
  } catch {
    return DEFAULT_WARM_ROOM_ENABLED;
  }
}

export function writeStoredWarmRoomEnabled(enabled: boolean): boolean {
  if (typeof window === "undefined") return enabled;
  try {
    getSpaceRuntime().platform.localStorage.setItem(WARM_ROOM_ENABLED_STORAGE_KEY, String(enabled));
  } catch {
    // The effective in-memory setting still applies when browser storage is unavailable.
  }
  return enabled;
}

export function removeLegacyWarmRoomConnectedPaneLimit(): void {
  if (typeof window === "undefined") return;
  try {
    getSpaceRuntime().platform.localStorage.removeItem(
      LEGACY_WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY
    );
  } catch {
    // The adaptive controller remains authoritative when browser storage is unavailable.
  }
}
