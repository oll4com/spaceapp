import { requestDoneView, requestUpdatesView } from "../nous/nous-done-events.js";
import { useSyncExternalStore } from "react";
import { needsYou, type NotificationLink, type NotificationsPending, type NotificationStreamPayload, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { requestNousFocus } from "../nous-focus/nous-focus-events.js";
import { requestNeedsYouView } from "../needs-you/needs-you-view.js";

/**
 * The signed-in user's notifications in this tab: what waits (badge counts per room and pane), the newest
 * records, and the toasts on screen. Fed by the Notification Center, the stream (ids only, filtered by owner)
 * and the API; every pane kind reads it through `useNotificationStore`.
 */
export interface NotificationToast { id: string; notification: SpaceNotification; shownAt: number }
export interface NotificationStoreState {
  userId: string | null;
  loaded: boolean;
  pending: NotificationsPending;
  /** Newest records (open and read), for the Center. */
  items: SpaceNotification[];
  /** Older records the operator loaded with "Load earlier" (31/10: until then the Center held only the newest 100), and whether more exist. */
  earlier?: SpaceNotification[];
  hasEarlier?: boolean;
  toasts: NotificationToast[];
}
export type NotificationNavigator = (link: NotificationLink, notification: SpaceNotification) => void;

const emptyPending: NotificationsPending = { total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] };
let state: NotificationStoreState = { userId: null, loaded: false, pending: emptyPending, items: [], toasts: [] };
const listeners = new Set<() => void>();
const seen = new Set<string>();
let navigator: NotificationNavigator | null = null;
let onNew: ((notifications: SpaceNotification[]) => void) | null = null;
let refreshTimer: number | undefined;
let refreshing: Promise<void> | null = null;

function emit(next: NotificationStoreState) {
  state = next;
  for (const listener of listeners) listener();
}
export function subscribeNotificationStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function peekNotificationStore(): NotificationStoreState { return state; }
export function useNotificationStore(): NotificationStoreState {
  return useSyncExternalStore(subscribeNotificationStore, peekNotificationStore, peekNotificationStore);
}

/** The app registers how a click opens the room, pane or surface a notification points at. */
export function setNotificationNavigator(next: NotificationNavigator | null): void { navigator = next; }
/** Delivery (toast, chime, desktop) runs for records the store had not seen; the first load only learns what waits. */
export function setNotificationDeliveryHandler(next: ((notifications: SpaceNotification[]) => void) | null): void { onNew = next; }

export function resetNotificationStore(userId: string | null): void {
  seen.clear();
  window.clearTimeout(refreshTimer);
  emit({ userId, loaded: false, pending: emptyPending, items: [], toasts: [] });
}

/** The next 100 records older than every one the Center holds, kept until the store is reset. */
export async function loadEarlierNotifications(): Promise<void> {
  const held = [...state.items, ...state.earlier ?? []];
  const oldest = held.reduce<string | null>((min, item) => !min || item.createdAt < min ? item.createdAt : min, null);
  if (!oldest) return;
  const page = await api.notifications({ status: "ALL", limit: 100, before: oldest });
  emit({ ...state, earlier: [...state.earlier ?? [], ...page.notifications.filter((item) => !held.some((known) => known.id === item.id))], hasEarlier: page.notifications.length >= 100 });
}

/** Nous's card for one pane (plan clipboard:8FfXWclYUfOH): what only the operator's hands can do there. */
export function isNousPaneCard(notification: SpaceNotification): boolean {
  return notification.source === "NOUS" && Boolean(notification.paneId && notification.roomId && notification.dedupeKey?.startsWith("nous:pane:"));
}
/** A card that alerts again (a new list) carries its alert time, so it is delivered once more under the same id. */
function deliveryKey(notification: SpaceNotification): string {
  const alertAt = notification.payload?.alertAt;
  return typeof alertAt === "string" ? `${notification.id}@${alertAt}` : notification.id;
}

/** Reloads what waits and the newest records; new open records (after the first load) go to delivery. */
export async function refreshNotifications(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [pending, list] = await Promise.all([api.notificationsPending(), api.notifications({ status: "ALL", limit: 100 })]);
      const fresh = state.loaded ? pending.latest.filter((item) => !seen.has(deliveryKey(item))) : [];
      for (const item of [...pending.latest, ...list.notifications]) seen.add(deliveryKey(item));
      emit({ ...state, loaded: true, pending, items: list.notifications, hasEarlier: state.earlier?.length ? state.hasEarlier : list.notifications.length >= 100 });
      if (fresh.length) onNew?.(fresh);
    } catch {
      // Offline or signed out: the last known state stays.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** A stream payload for this user schedules one refresh; other users' notifications are ignored. */
export function ingestNotificationStreamPayload(payload: NotificationStreamPayload): void {
  if (!state.userId || payload.ownerUserId !== state.userId) return;
  window.clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshNotifications(), 250);
}

/** A pane's notifications share one toast: one moment can raise several records (question, browser handoff, Room Agent). */
export function notificationToastKey(notification: SpaceNotification): string { return notification.paneId ?? notification.id; }
/** Shows the toast; a newer notification of the same pane replaces the one on screen instead of stacking. */
export function pushNotificationToast(notification: SpaceNotification): void {
  if (state.toasts.some((toast) => deliveryKey(toast.notification) === deliveryKey(notification))) return;
  const key = notificationToastKey(notification);
  const others = state.toasts.filter((toast) => notificationToastKey(toast.notification) !== key);
  emit({ ...state, toasts: [...others, { id: notification.id, notification, shownAt: Date.now() }].slice(-3) });
}
export function dismissNotificationToast(id: string): void {
  emit({ ...state, toasts: state.toasts.filter((toast) => toast.id !== id) });
}

export async function markNotificationRead(id: string): Promise<void> {
  await api.markNotificationRead(id).catch(() => undefined);
  dismissNotificationToast(id);
  await refreshNotifications();
}
export async function ackNotification(id: string): Promise<void> {
  await api.ackNotification(id).catch(() => undefined);
  dismissNotificationToast(id);
  await refreshNotifications();
}
export async function readAllNotifications(): Promise<void> {
  await api.readAllNotifications().catch(() => undefined);
  emit({ ...state, toasts: [] });
  await refreshNotifications();
}
/**
 * A needs-you card's Go (plan clipboard:ytwWl09xNH0Z): the operator clicked it, so Space takes them to its pane (maximized, focused). Only a card
 * whose work is in a pane offers it (needsYouPlace PANE), and the card's "Open the mail/page" link in its Details.
 */
let surfaceTarget: string | null = null;
/** What a card that opens a dock asked it to show (`sign:<id>`: that signature request); the dock takes it once it is mounted. */
export function takeSurfaceTarget(prefix: string): string | null {
  if (!surfaceTarget?.startsWith(prefix)) return null;
  const target = surfaceTarget;
  surfaceTarget = null;
  return target.slice(prefix.length);
}
export function goToNeedsYouPane(notification: SpaceNotification): void {
  // A card about a dock (a signature request: Agent Files' Sign view) opens that dock, not the asking pane.
  if (notification.link.surface && notification.link.target) {
    surfaceTarget = notification.link.target;
    navigator?.({ surface: notification.link.surface, target: notification.link.target }, notification);
    window.dispatchEvent(new CustomEvent("space:surface-target", { detail: { target: notification.link.target } }));
    return;
  }
  if (notification.roomId && notification.paneId) requestNousFocus({ roomId: notification.roomId, paneId: notification.paneId, immediate: true, notification });
}
/** A click on a needs-you toast, pop-up, Center row or native notification opens the card in Nous's Needs you tab: no room or pane changes. */
export function openNeedsYouCard(notification: SpaceNotification): void {
  requestNeedsYouView(notification.id);
  navigator?.({ surface: "nous" }, notification);
  if (notification.status === "OPEN") void markNotificationRead(notification.id);
}
/** Opens what the notification points at and marks it read; a needs-you request opens its card (operator 3/11 19:25 BKK: never the pane by itself). */
export function openNotification(notification: SpaceNotification): void {
  if (needsYou(notification)) openNeedsYouCard(notification);
  else {
    if (notification.source === "NOUS" && notification.kind === "REQUEST_DONE" && notification.link.target === "done") requestDoneView();
    if (notification.source === "NOUS" && notification.link.target === "updates") requestUpdatesView();
    navigator?.(notification.link, notification);
    void markNotificationRead(notification.id);
  }
}
