import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export const WARM_ROOM_ENABLED_STORAGE_KEY = "space.warmRoom.enabled.v1";
export const DEFAULT_WARM_ROOM_ENABLED = true;
export const WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY =
  "space.warmRoom.connectedPaneLimit.v1";
export const DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT = 96;
export const MIN_WARM_ROOM_CONNECTED_PANE_LIMIT = 6;
export const MAX_WARM_ROOM_CONNECTED_PANE_LIMIT = 96;

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

export function normalizeWarmRoomConnectedPaneLimit(value: unknown): number {
  if (value === null || value === undefined || value === "") {
    return DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT;
  const integer = Math.trunc(numeric);
  return Math.min(
    MAX_WARM_ROOM_CONNECTED_PANE_LIMIT,
    Math.max(MIN_WARM_ROOM_CONNECTED_PANE_LIMIT, integer)
  );
}

export function readStoredWarmRoomConnectedPaneLimit(): number {
  if (typeof window === "undefined") return DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT;
  try {
    return normalizeWarmRoomConnectedPaneLimit(
      getSpaceRuntime().platform.localStorage.getItem(WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY)
    );
  } catch {
    return DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT;
  }
}

export function writeStoredWarmRoomConnectedPaneLimit(value: unknown): number {
  const normalized = normalizeWarmRoomConnectedPaneLimit(value);
  if (typeof window === "undefined") return normalized;
  try {
    getSpaceRuntime().platform.localStorage.setItem(
      WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY,
      String(normalized)
    );
  } catch {
    // The effective in-memory setting still applies when browser storage is unavailable.
  }
  return normalized;
}
