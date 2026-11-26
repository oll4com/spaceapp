import { requestDoneView, requestPlanView, requestUpdatesView } from "../nous/nous-done-events.js";
import { useSyncExternalStore } from "react";
import { needsYou, needsYouMail, type InboxThreadView, type NotificationLink, type NotificationsPending, type NotificationStreamPayload, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { readHiddenDockIds } from "../docks/use-docks-visibility.js";
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
  /** The «Εισερχόμενα» badge from the server (plan clipboard:aE7U1J_gU9OV): the bell and Nous's Inbox show this one count; `byRoom` (the room
   *  dots, spec §8) counts the Threads that wait on the operator in each room; `open` is every open Thread (Conversation shows a decision's, E5). */
  inbox?: { badge: number; attention: boolean; byRoom: Record<string, number>; open: InboxThreadView[] };
  /** The mail a notification click opened in place (MailThreadDialog, operator 19/11 nous_msg:8c3a737937b14ac089e5a7e6), until its Close. */
  mailView?: { paneId: string | undefined; account: string; threadId: string; title: string } | null;
  /** The Done or Update whose report is open under its row in the Notifications dock (Nous hidden, plan clipboard:JD8EbQgQdRls step 4). */
  reportView?: string | null;
}
/** The bell's count: the server's inbox badge, or what waits until it is read (an account without the inbox route). */
export const inboxBadge = (store: NotificationStoreState) => store.inbox?.badge ?? store.pending.total;
/** The bell's count (operator 17/11, nous_msg:e1bcd1d9): what waits in its own Notifications dock, with or without Nous. */
export const notificationsBadge = (store: NotificationStoreState) => store.pending.total;
export type NotificationNavigator = (link: NotificationLink, notification: SpaceNotification) => void;

const emptyPending: NotificationsPending = { total: 0, bySource: {}, byRoom: {}, byPane: {}, latest: [] };
let state: NotificationStoreState = { userId: null, loaded: false, pending: emptyPending, items: [], toasts: [] };
const listeners = new Set<() => void>();
const seen = new Set<string>();
let navigator: NotificationNavigator | null = null;
let onNew: ((notifications: SpaceNotification[]) => void) | null = null;
let refreshTimer: number | undefined;
let refreshing: Promise<void> | null = null;
/** A refresh with a reason (the stream, the operator's own action) tells the panes even when the answer looks the same. */
let forceEmit = false;

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

/**
 * Reloads what waits and the newest records; new open records (after the first load) go to delivery. `ifChanged` (the timed poll, a tab
 * coming back): an answer equal to the last one notifies no one, so the Nous tabs that page on every store change stay still (desktop lag brief 11/11).
 */
export async function refreshNotifications({ ifChanged = false }: { ifChanged?: boolean } = {}): Promise<void> {
  if (!ifChanged) forceEmit = true;
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const [pending, list, inbox] = await Promise.all([api.notificationsPending(), api.notifications({ status: "ALL", limit: 100 }),
        api.inbox({ limit: 1 }).then(({ badge, attention, threads }) => {
          const open = threads.filter((thread) => !thread.closedAt);
          const byRoom: Record<string, number> = {};
          for (const thread of open) if (thread.waitingFor === "OPERATOR" && thread.refs.roomId) byRoom[thread.refs.roomId] = (byRoom[thread.refs.roomId] ?? 0) + 1;
          return { badge, attention, byRoom, open };
        // .catch, not .then's second argument: an inbox answer without threads must not drop the notifications refresh too.
        }).catch(() => state.inbox)]);
      // pending lists a needs-you card the operator opened (READ) too: only an unread one is delivered.
      const fresh = state.loaded ? pending.latest.filter((item) => item.status === "OPEN" && !seen.has(deliveryKey(item))) : [];
      for (const item of [...pending.latest, ...list.notifications]) seen.add(deliveryKey(item));
      // Spec v2 §7 (step 4): a card answered or closed on another client (phone, Telegram, another tab) leaves the toasts too.
      const closed = new Set(list.notifications.filter((item) => item.status === "ACKED" || item.status === "RESOLVED").map((item) => item.id));
      const toasts = state.toasts.filter((toast) => !closed.has(toast.id));
      const next = { ...state, loaded: true, pending, items: list.notifications, inbox, toasts, hasEarlier: state.earlier?.length ? state.hasEarlier : list.notifications.length >= 100 };
      const same = state.loaded && JSON.stringify([state.pending, state.items, state.hasEarlier, state.inbox]) === JSON.stringify([next.pending, next.items, next.hasEarlier, next.inbox])
        && toasts.length === state.toasts.length;
      const force = forceEmit;
      forceEmit = false;
      if (force || !same) emit(next);
      if (fresh.length) onNew?.(fresh);
    } catch {
      // Offline or signed out: the last known state stays.
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** A stream payload for this user (a notification, or INBOX_UPDATED's `{threadId, ownerUserId}`) schedules one refresh; other users' are ignored. */
export function ingestNotificationStreamPayload(payload: Pick<NotificationStreamPayload, "ownerUserId"> & Partial<NotificationStreamPayload>): void {
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
  // Technical (screen space): toasts stay until their X, so at most 3 stand; an older one leaves the stack but stays in the Notification Center (the bell).
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
/** `id`: that one card only (the row's Mark read). */
export async function readAllNotifications(id?: string): Promise<void> {
  await api.readAllNotifications(id).catch(() => undefined);
  emit({ ...state, toasts: id ? state.toasts.filter((toast) => toast.id !== id) : [] });
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
  // A card about a mail opens that mail's review or thread (operator 12/11 23:19 BKK), also one raised without a target; a page target stays.
  const mail = !notification.link.target || /^(?:thread|review):/.test(notification.link.target) ? needsYouMail(notification)?.target : undefined;
  const opened = mail ? { ...notification, link: { ...notification.link, target: mail } } : notification;
  if (notification.roomId && notification.paneId) requestNousFocus({ roomId: notification.roomId, paneId: notification.paneId, immediate: true, notification: opened });
  // Operator 13/11 15:37 BKK («παταω go to pane και δεν κανει τιποτα»): a plan's card has no pane of its own: Go takes them to its plan's pane (the
  // link the server stamped; "activity", its default, so a CLI pane counts as a place), else opens the plan. Never a dead click.
  else if (notification.link.roomId && notification.link.paneId) requestNousFocus({ roomId: notification.link.roomId, paneId: notification.link.paneId, immediate: true,
    notification: { ...opened, roomId: notification.link.roomId, paneId: notification.link.paneId, link: { ...opened.link, target: opened.link.target ?? "activity" } } });
  else if (typeof notification.payload.planId === "string") { requestPlanView(notification.payload.planId); navigator?.({ surface: "nous" }, notification); }
  else openNeedsYouCard(notification);
}
/** A click on a needs-you toast, pop-up, Center row or native notification opens the card in Nous's Needs you tab (or its own pane when Nous is hidden): no room or pane changes with Nous shown. */
export function openNeedsYouCard(notification: SpaceNotification): void {
  if (readHiddenDockIds().includes("nous")) {
    const { surface, ...rest } = notification.link;
    const roomId = rest.roomId ?? notification.roomId ?? undefined;
    const paneId = rest.paneId ?? notification.paneId ?? undefined;
    navigator?.({ ...rest, ...(roomId ? { roomId } : {}), ...(paneId ? { paneId } : {}), ...(surface && surface !== "nous" ? { surface } : {}) }, notification);
    if (notification.status === "OPEN") void markNotificationRead(notification.id);
    return;
  }
  requestNeedsYouView(notification.id);
  navigator?.({ surface: "nous" }, notification);
  if (notification.status === "OPEN") void markNotificationRead(notification.id);
}
/** Opens what the notification points at and marks it read; a needs-you request opens its card (operator 3/11 19:25 BKK: never the pane by itself). */
/** An appointment reminder's join link (payload.joinUrl, operator 13/11 16:00 BKK): a button that opens it, beside the click that opens the pane. */
export function notificationJoinUrl(notification: SpaceNotification): string | null {
  const url = notification.payload.joinUrl;
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

export function closeMailView(): void { emit({ ...state, mailView: null }); }

export function openNotification(notification: SpaceNotification): void {
  // A Mail Copilot mail (new mail, a fix) shows that mail where the operator is, never the Mail pane (operator 19/11 nous_msg:8c3a737937b14ac089e5a7e6).
  const thread = !needsYou(notification) && notification.source === "MAIL_COPILOT" ? /^thread:([^:]+):(.+)$/.exec(notification.link.target ?? "") : null;
  if (thread) {
    emit({ ...state, mailView: { paneId: notification.link.paneId ?? notification.paneId ?? undefined, account: thread[1]!, threadId: thread[2]!, title: notification.body || notification.title } });
    void markNotificationRead(notification.id);
  } else if (needsYou(notification)) openNeedsYouCard(notification);
  else {
    const nousHidden = readHiddenDockIds().includes("nous");
    if (!nousHidden && notification.source === "NOUS" && notification.kind === "REQUEST_DONE" && notification.link.target === "done") requestDoneView();
    if (!nousHidden && notification.source === "NOUS" && notification.link.target === "updates") requestUpdatesView();
    // Without Nous its Inbox card cannot open, so a Done or an Update opens under its row in the Notifications dock; a second click folds it.
    const inPlace = nousHidden && notification.source === "NOUS" && (notification.link.target === "done" || notification.link.target === "updates");
    if (inPlace) emit({ ...state, reportView: state.reportView === notification.id ? null : notification.id });
    const link = nousHidden && notification.link.surface === "nous" ? { ...notification.link, surface: inPlace ? "notifications" : undefined } : notification.link;
    navigator?.(link, notification);
    void markNotificationRead(notification.id);
  }
}
