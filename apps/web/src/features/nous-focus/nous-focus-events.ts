import { useEffect, useRef } from "react";
import { nousFocusRequestPayloadSchema } from "@space/contracts";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

/** A pane Nous brings the operator to (plan clipboard:twwygEtD4uuX). `ownerUserId` null: the operator asked here ("Take me there"). */
export interface NousFocusDetail { roomId: string; paneId: string; ownerUserId: string | null; immediate: boolean }
export const NOUS_FOCUS_EVENT = "space:nous-focus";
/** Go and Back tell the Nous dock to leave its fullscreen while the operator is at the pane, and to come back after. */
export const NOUS_FOCUS_PHASE_EVENT = "space:nous-focus-phase";
export type NousFocusPhase = "go" | "back";

export function requestNousFocus(detail: NousFocusDetail): void {
  window.dispatchEvent(new CustomEvent<NousFocusDetail>(NOUS_FOCUS_EVENT, { detail }));
}

export function announceNousFocusPhase(phase: NousFocusPhase): void {
  window.dispatchEvent(new CustomEvent<NousFocusPhase>(NOUS_FOCUS_PHASE_EVENT, { detail: phase }));
}

/** NOUS_FOCUS_REQUESTED on the app's server stream (ids only, never replayed) becomes a window event; returns the cleanup. */
export function forwardNousFocusEvents(source: Pick<EventSource, "addEventListener" | "removeEventListener">): () => void {
  // Not in streamEventTypes on purpose: the room event feed never lists it.
  const listener = (message: MessageEvent<string>) => {
    let event: { type?: unknown; payload?: unknown } | null;
    try { event = JSON.parse(message.data) as typeof event; } catch { return; }
    const payload = event?.type === "NOUS_FOCUS_REQUESTED" ? nousFocusRequestPayloadSchema.safeParse(event.payload) : null;
    if (payload?.success) requestNousFocus({ roomId: payload.data.roomId, paneId: payload.data.paneId, ownerUserId: payload.data.ownerUserId, immediate: false });
  };
  source.addEventListener("NOUS_FOCUS_REQUESTED", listener as EventListener);
  return () => source.removeEventListener("NOUS_FOCUS_REQUESTED", listener as EventListener);
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
