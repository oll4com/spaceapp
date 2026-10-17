import { useSyncExternalStore } from "react";
import type { NotificationLink, NotificationsPending, NotificationStreamPayload, SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";

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

/** Reloads what waits and the newest records; new open records (after the first load) go to delivery. */
export async function refreshNotifications(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [pending, list] = await Promise.all([api.notificationsPending(), api.notifications({ status: "ALL", limit: 100 })]);
      const fresh = state.loaded ? pending.latest.filter((item) => !seen.has(item.id)) : [];
      for (const item of [...pending.latest, ...list.notifications]) seen.add(item.id);
      emit({ ...state, loaded: true, pending, items: list.notifications });
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
  if (state.toasts.some((toast) => toast.notification.id === notification.id)) return;
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
/** Opens what the notification points at and marks it read. */
export function openNotification(notification: SpaceNotification): void {
  navigator?.(notification.link, notification);
  void markNotificationRead(notification.id);
}
