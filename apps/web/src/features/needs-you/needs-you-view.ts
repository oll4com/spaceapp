import { useEffect, useRef, useSyncExternalStore } from "react";
import type { SpaceNotification } from "@space/contracts";

/**
 * A click on a needs-you toast, peek, pop-up or native notification opens that card in the Nous dock's Needs you tab (plan clipboard:ytwWl09xNH0Z:
 * the card, never the pane). The dock is lazy, so the request waits until its mount takes it, like the Done view (nous-done-events.ts).
 */
export const NEEDS_YOU_OPEN_EVENT = "space:needs-you-open";
let pending: { id: string | null } | null = null;
export function requestNeedsYouView(cardId: string | null): void {
  pending = { id: cardId };
  window.dispatchEvent(new Event(NEEDS_YOU_OPEN_EVENT));
}
export function consumeNeedsYouView(): { id: string | null } | null {
  const requested = pending;
  pending = null;
  return requested;
}
export function useNeedsYouView(onOpen: (cardId: string | null) => void): void {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    const open = () => { const requested = consumeNeedsYouView(); if (requested) callback.current(requested.id); };
    window.addEventListener(NEEDS_YOU_OPEN_EVENT, open);
    open();
    return () => window.removeEventListener(NEEDS_YOU_OPEN_EVENT, open);
  }, []);
}

/**
 * The cards waiting in the small window (NeedsYouPeek), newest first. Fed by delivery and by the records a hidden tab missed (NousFocus): the
 * window is the only thing a new card shows on screen (plan clipboard:ytwWl09xNH0Z: no banner, no move).
 */
let peeked: readonly SpaceNotification[] = [];
const peekListeners = new Set<() => void>();
const peekEmit = () => { for (const listener of peekListeners) listener(); };
// Put off with Later: that alert never comes back into the window (delivery's copy can land after he pressed it, behind a settings read);
// the card alerting again (a new alertAt) does.
const putOff = new Set<string>();
const alertKey = (notification: SpaceNotification) => typeof notification.payload?.alertAt === "string" ? `${notification.id}@${notification.payload.alertAt}` : notification.id;
export function pushNeedsYouPeek(notification: SpaceNotification): void {
  if (putOff.has(alertKey(notification))) return;
  peeked = [notification, ...peeked.filter((item) => item.id !== notification.id)];
  peekEmit();
}
/** Later on a card that waited for him: it leaves the window for this alert. */
export function putOffNeedsYouPeek(notification: SpaceNotification): void {
  putOff.add(alertKey(notification));
  dropNeedsYouPeek(notification.id);
}
/** One card leaves the window, or all of them (they fold into the counter; the cards stay in Needs you). */
export function dropNeedsYouPeek(id?: string): void {
  peeked = id ? peeked.filter((item) => item.id !== id) : [];
  peekEmit();
}
export function useNeedsYouPeekQueue(): readonly SpaceNotification[] {
  return useSyncExternalStore((listener) => { peekListeners.add(listener); return () => { peekListeners.delete(listener); }; }, () => peeked, () => peeked);
}
