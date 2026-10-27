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
export type NousFocusPhase = "go" | "back";
/** NOUS_PANE_BOARD_UPDATED from the server stream (ids only): the Nous dock's pane board refetches. */
export const NOUS_PANE_BOARD_EVENT = "space:nous-pane-board";
/** The app's server stream (re)connected (replay-complete): the focus hook offers the newest open needs-you the tab may have missed. */
export const NOUS_FOCUS_CHECK_EVENT = "space:nous-focus-check";

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
export function useLeaveDuringNousFocus<T>(current: T, leave: () => void, restore: (saved: T) => void): void {
  const latest = useRef({ current, leave, restore });
  latest.current = { current, leave, restore };
  const saved = useRef<{ value: T } | null>(null);
  useEffect(() => {
    const onPhase = (event: Event) => {
      const phase = (event as CustomEvent<NousFocusPhase>).detail;
      if (phase === "go" && !saved.current) { saved.current = { value: latest.current.current }; latest.current.leave(); }
      if (phase === "back" && saved.current) { latest.current.restore(saved.current.value); saved.current = null; }
    };
    window.addEventListener(NOUS_FOCUS_PHASE_EVENT, onPhase);
    return () => window.removeEventListener(NOUS_FOCUS_PHASE_EVENT, onPhase);
  }, []);
}
