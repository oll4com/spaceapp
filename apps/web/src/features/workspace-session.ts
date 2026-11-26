export const WORKSPACE_DOCK_SESSION_KEY = "space.workspace.dock.v1";

export type DockSession = { surface: string; desktopOpen: boolean; compactOpen: boolean };

/**
 * The first storage holding a valid dock wins: callers pass this tab's sessionStorage (a reload keeps each tab's own dock), then
 * localStorage (closing and reopening the desktop app or browser comes back on the last dock, operator 16/11 nous_msg:6679a54e).
 */
export function readDockSession(storages: readonly Pick<Storage, "getItem">[], surfaces: readonly string[]): DockSession | null {
  for (const storage of storages) {
    try {
      const value: unknown = JSON.parse(storage.getItem(WORKSPACE_DOCK_SESSION_KEY) ?? "null");
      if (!value || typeof value !== "object") continue;
      const state = value as Partial<DockSession>;
      if (typeof state.surface !== "string" || !surfaces.includes(state.surface)
        || typeof state.desktopOpen !== "boolean" || typeof state.compactOpen !== "boolean") continue;
      return state as DockSession;
    } catch { /* Next storage. */ }
  }
  return null;
}

export function writeDockSession(storages: readonly Pick<Storage, "setItem">[], state: DockSession): void {
  for (const storage of storages) {
    try { storage.setItem(WORKSPACE_DOCK_SESSION_KEY, JSON.stringify(state)); } catch { /* Best effort. */ }
  }
}
