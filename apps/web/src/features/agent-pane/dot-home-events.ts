// Requests from a Dot pane that the app shell carries out (Space Dots Stage 8).

export const DOT_CALL_EVENT = "space:dot-call";
export const OPEN_DOT_SETTINGS_EVENT = "space:open-dot-settings";

export interface DotCallDetail { roomId: string; dotId: string; dotName: string; slot?: number }
export type DotSettingsSection = "profile" | "proactive" | "accounts" | "channels" | "reminders" | "memory" | "tools" | "evaluation";
export interface OpenDotSettingsDetail { dotId?: string; section?: DotSettingsSection }

/** Opens a voice call with the Dot: a Live pane in the room that routes requests to this Dot. */
export function requestDotCall(detail: DotCallDetail): void {
  window.dispatchEvent(new CustomEvent<DotCallDetail>(DOT_CALL_EVENT, { detail }));
}
/** Opens SpaceApp Settings → Dots, optionally at one Dot and section. */
export function openDotSettings(detail: OpenDotSettingsDetail = {}): void {
  window.dispatchEvent(new CustomEvent<OpenDotSettingsDetail>(OPEN_DOT_SETTINGS_EVENT, { detail }));
}

/** A Dot's name, model or other setting changed in Settings → Dots; open Dot panes read the Dots again. */
export const DOTS_UPDATED_EVENT = "space:dots-updated";
export function announceDotsUpdated(): void {
  window.dispatchEvent(new CustomEvent(DOTS_UPDATED_EVENT));
}

// A Live pane opened from a Dot pane's Call button talks with that Dot (kept in this browser).
const DOT_CALL_KEY = "space_live_pane_dot_";
export interface LivePaneDot { dotId: string; name: string; slot: number | null }
export function readLivePaneDot(paneId: string): LivePaneDot | null {
  try {
    const value = JSON.parse(localStorage.getItem(`${DOT_CALL_KEY}${paneId}`) ?? "null") as { dotId?: unknown; name?: unknown; slot?: unknown } | null;
    if (!value || typeof value.dotId !== "string" || typeof value.name !== "string") return null;
    const slot = typeof value.slot === "number" && Number.isInteger(value.slot) && value.slot >= 1 && value.slot <= 6 ? value.slot : null;
    return { dotId: value.dotId, name: value.name.slice(0, 80), slot };
  } catch { return null; }
}
/** The Dot's slot (1-6) keeps the call with it even after the Dot is renamed. */
export function writeLivePaneDot(paneId: string, dot: { dotId: string; name: string; slot?: number }): void {
  try { localStorage.setItem(`${DOT_CALL_KEY}${paneId}`, JSON.stringify({ dotId: dot.dotId, name: dot.name, slot: dot.slot ?? null })); } catch { /* the call still works, without a Dot */ }
}
