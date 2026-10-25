export const WORKSPACE_DOCK_SESSION_KEY = "space.workspace.dock.v1";

export type DockSession = { surface: string; desktopOpen: boolean; compactOpen: boolean };

export function readDockSession(storage: Pick<Storage, "getItem">, surfaces: readonly string[]): DockSession | null {
  try {
    const value: unknown = JSON.parse(storage.getItem(WORKSPACE_DOCK_SESSION_KEY) ?? "null");
    if (!value || typeof value !== "object") return null;
    const state = value as Partial<DockSession>;
    if (typeof state.surface !== "string" || !surfaces.includes(state.surface)
      || typeof state.desktopOpen !== "boolean" || typeof state.compactOpen !== "boolean") return null;
    return state as DockSession;
  } catch { return null; }
}

export function writeDockSession(storage: Pick<Storage, "setItem">, state: DockSession): void {
  try { storage.setItem(WORKSPACE_DOCK_SESSION_KEY, JSON.stringify(state)); } catch { /* Best effort. */ }
}
