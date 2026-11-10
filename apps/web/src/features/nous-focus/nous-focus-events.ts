import { useEffect, useRef } from "react";
import type { SpaceNotification } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

/**
 * A pane the operator is brought to (Needs you, operator request 2026-10-24; plan clipboard:twwygEtD4uuX before it). `notification` is
 * the needs-you record that asks for them (delivery, a click in the Center, on the desktop or on Android); absent when the operator
 * asked here themselves ("Take me there", "Go to pane").
 */
export interface NousFocusDetail { roomId: string; paneId: string; immediate: boolean; notification?: SpaceNotification }
export const NOUS_FOCUS_EVENT = "space:nous-focus";
/** Go and Back tell the Nous dock to leave its fullscreen while the operator is at the pane, and to come back after. */
export const NOUS_FOCUS_PHASE_EVENT = "space:nous-focus-phase";
export type NousFocusPhase = "go" | "back" | "stay";
/** NOUS_PANE_BOARD_UPDATED from the server stream (ids only): the Nous dock's pane board refetches. */
export const NOUS_PANE_BOARD_EVENT = "space:nous-pane-board";
/** The app's server stream (re)connected (replay-complete): the focus hook offers the newest open needs-you the tab may have missed. */
export const NOUS_FOCUS_CHECK_EVENT = "space:nous-focus-check";

const TYPING_MS = 2_000;
const LIVE_ON = new Set(["connecting", "active", "listening", "thinking", "speaking"]);
let lastKeyAt = 0;
if (typeof window !== "undefined") window.addEventListener("keydown", () => { lastKeyAt = Date.now(); }, true);

/** Why a new card's window must wait before it shows (operator 3/11 19:30 BKK: none pops while he types); null when the operator is free. */
export function nousFocusHold(): string | null {
  if (document.visibilityState !== "visible") return "the app is in the background";
  const active = document.activeElement as HTMLElement | null;
  // A terminal keeps its hidden input focused all the time: only its recent keys count as typing (2026-10-26: the banner never went).
  const field = active && !active.classList.contains("xterm-helper-textarea") && (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName));
  if (Date.now() - lastKeyAt < TYPING_MS || field) return "you are typing";
  if (document.querySelector("dialog[open], [role='dialog'][aria-modal='true'], [role='alertdialog']")) return "a dialog is open";
  if ([...document.querySelectorAll<HTMLElement>("[data-live-status]")].some((element) => LIVE_ON.has(element.dataset.liveStatus ?? ""))) return "Live is on";
  return null;
}

export function requestNousFocus(detail: NousFocusDetail): void {
  window.dispatchEvent(new CustomEvent<NousFocusDetail>(NOUS_FOCUS_EVENT, { detail }));
}

export function announceNousFocusPhase(phase: NousFocusPhase): void {
  window.dispatchEvent(new CustomEvent<NousFocusPhase>(NOUS_FOCUS_PHASE_EVENT, { detail: phase }));
}

/** The pane board's changes (plan clipboard:Y9cgKVHFaHrr) and the stream's (re)connection become window events; returns the cleanup. */
export function forwardNousPaneBoardEvents(source: Pick<EventSource, "addEventListener" | "removeEventListener">): () => void {
  // Not in streamEventTypes on purpose: the room event feed never lists it.
  const board = (message: MessageEvent<string>) => {
    let event: { type?: unknown; paneId?: unknown } | null;
    try { event = JSON.parse(message.data) as typeof event; } catch { return; }
    if (event?.type === "NOUS_PANE_BOARD_UPDATED") window.dispatchEvent(new CustomEvent(NOUS_PANE_BOARD_EVENT, { detail: { paneId: typeof event.paneId === "string" ? event.paneId : null } }));
  };
  const connected = () => window.dispatchEvent(new Event(NOUS_FOCUS_CHECK_EVENT));
  source.addEventListener("NOUS_PANE_BOARD_UPDATED", board as EventListener);
  source.addEventListener("replay-complete", connected);
  return () => { source.removeEventListener("NOUS_PANE_BOARD_UPDATED", board as EventListener); source.removeEventListener("replay-complete", connected); };
}

// Stored as "off" so the default (no value on this device) is on.
const OFF_KEY = "space.nousFocus.off";
export const readNousFocusEnabled = () => getSpaceRuntime().platform.localStorage.getItem(OFF_KEY) !== "true";
export function writeNousFocusEnabled(enabled: boolean): void {
  if (enabled) getSpaceRuntime().platform.localStorage.removeItem(OFF_KEY);
  else getSpaceRuntime().platform.localStorage.setItem(OFF_KEY, "true");
}

/** A surface that would cover the pane (the Nous dock's fullscreen) leaves on Go and comes back as it was on Back. */
export function useLeaveDuringNousFocus<T>(current: T, leave: () => void, restore: (saved: T) => void, stay?: () => void): void {
  const latest = useRef({ current, leave, restore, stay });
  latest.current = { current, leave, restore, stay };
  const saved = useRef<{ value: T } | null>(null);
  useEffect(() => {
    const onPhase = (event: Event) => {
      const phase = (event as CustomEvent<NousFocusPhase>).detail;
      if (phase === "go" && !saved.current) { saved.current = { value: latest.current.current }; latest.current.leave(); }
      if (phase === "back" && saved.current) { latest.current.restore(saved.current.value); saved.current = null; }
      if (phase === "stay") { saved.current = null; latest.current.stay?.(); }
    };
    window.addEventListener(NOUS_FOCUS_PHASE_EVENT, onPhase);
    return () => window.removeEventListener(NOUS_FOCUS_PHASE_EVENT, onPhase);
  }, []);
}
