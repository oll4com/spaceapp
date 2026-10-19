import { useEffect } from "react";
import { api } from "../../api.js";
import { subscribeNativeNotificationOpen, subscribePushTokenRegistration } from "./desktop-notifications.js";
import { deliverNotifications } from "./notification-delivery.js";
import { ingestNotificationStreamPayload, openNotification, refreshNotifications, resetNotificationStore, setNotificationDeliveryHandler, setNotificationNavigator, type NotificationNavigator } from "./notification-store.js";
import { notificationStreamPayloadSchema } from "@space/contracts";

export const NOTIFICATION_STREAM_EVENT = "space:notification";
/** The stream handler in the app shell re-dispatches NOTIFICATION_CREATED/UPDATED payloads as this window event. */
export function dispatchNotificationStreamEvent(payload: unknown): void {
  window.dispatchEvent(new CustomEvent(NOTIFICATION_STREAM_EVENT, { detail: payload }));
}

const POLL_VISIBLE_MS = 60_000;
const POLL_HIDDEN_MS = 180_000;

/**
 * Keeps the notification store alive for the signed-in user: initial load, stream events, a slow poll as a
 * fallback, delivery of new records through the user's channels, and the navigator a click uses.
 */
export function useNotificationBootstrap(userId: string | null, navigate: NotificationNavigator): void {
  useEffect(() => { setNotificationNavigator(navigate); return () => setNotificationNavigator(null); }, [navigate]);
  useEffect(() => {
    resetNotificationStore(userId);
    if (!userId) return;
    let cancelled = false;
    let timer: number | undefined;
    setNotificationDeliveryHandler((fresh) => {
      void api.userSettings().then((settings) => { if (!cancelled) deliverNotifications(fresh, settings.notifications); }).catch(() => deliverNotifications(fresh, null));
    });
    const schedule = () => { if (!cancelled) timer = window.setTimeout(() => void refreshNotifications().finally(schedule), document.hidden ? POLL_HIDDEN_MS : POLL_VISIBLE_MS); };
    void refreshNotifications().finally(schedule);
    const onStream = (event: Event) => {
      const parsed = notificationStreamPayloadSchema.safeParse((event as CustomEvent).detail);
      if (parsed.success) ingestNotificationStreamPayload(parsed.data);
    };
    const onVisible = () => { if (!document.hidden) void refreshNotifications(); };
    window.addEventListener(NOTIFICATION_STREAM_EVENT, onStream);
    document.addEventListener("visibilitychange", onVisible);
    // A tap on a native (Android / desktop app) notification arrives as its id; the record decides where to go.
    const unsubscribeNative = subscribeNativeNotificationOpen((id) => {
      void api.notification(id).then(({ notification }) => { if (!cancelled) openNotification(notification); }).catch(() => undefined);
    });
    const unsubscribePush = subscribePushTokenRegistration(api);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      unsubscribeNative();
      unsubscribePush();
      setNotificationDeliveryHandler(null);
      window.removeEventListener(NOTIFICATION_STREAM_EVENT, onStream);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId]);
}
