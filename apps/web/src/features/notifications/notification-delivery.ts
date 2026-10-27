import { NOTIFICATION_SOURCE_LABELS, needsYou, notificationChannelEnabled, resolveNotificationSettings, type NotificationSettings, type SpaceNotification } from "@space/contracts";
import { playChime } from "../desktop-widgets/audio-chime.js";
import { readNousFocusEnabled, requestNousFocus } from "../nous-focus/nous-focus-events.js";
import { showDesktopNotification } from "./desktop-notifications.js";
import { notificationToastKey, openNotification, pushNotificationToast } from "./notification-store.js";

/** The user's "Show notifications" kill switch (Settings → Notifications): no toast, chime or desktop pop-up. */
export function notificationsSuppressed(): boolean {
  return typeof document !== "undefined" && document.documentElement.getAttribute("data-suppress-notifications") === "true";
}

/** Delivers new notifications in this tab: toast and chime in the foreground, a desktop notification in the background. */
export function deliverNotifications(notifications: SpaceNotification[], settings: NotificationSettings | null | undefined): void {
  if (!notifications.length || notificationsSuppressed()) return;
  const channels = resolveNotificationSettings(settings);
  let chimed = false;
  const shown = new Set<string>();
  for (const notification of notifications.slice(0, 5)) {
    if (!notificationChannelEnabled(channels, notification.source, "inApp")) continue;
    // Held for the operator's morning (quiet hours): listed in the Notification Center, no pop-up, chime or desktop alert.
    if (typeof notification.payload?.heldUntil === "string" && Date.parse(notification.payload.heldUntil) > Date.now()) continue;
    // Newest first: only the newest record of a pane in this batch is shown.
    if (shown.has(notificationToastKey(notification))) continue;
    shown.add(notificationToastKey(notification));
    const title = `${NOTIFICATION_SOURCE_LABELS[notification.source]}: ${notification.title}`;
    // Needs you (operator request 2026-10-24): a request on a pane brings the operator there (the banner, Go now / Not now) instead of a toast;
    // the same record gets no second alert here. A hidden tab gets the desktop pop-up only (its click goes at once) and the banner once it is
    // visible again (NousFocus offers the newest open record); the device setting off keeps today's toast.
    if (needsYou(notification) && readNousFocusEnabled()) {
      if (document.visibilityState === "visible") requestNousFocus({ roomId: notification.roomId!, paneId: notification.paneId!, immediate: false, notification });
      else if (notificationChannelEnabled(channels, notification.source, "desktop")) showDesktopNotification({ title, body: notification.body, tag: notification.id, onClick: () => openNotification(notification) });
      if (channels.channels.sound && !chimed && notification.severity !== "INFO") { playChime("notification"); chimed = true; }
      continue;
    }
    const shownOnDesktop = notificationChannelEnabled(channels, notification.source, "desktop")
      && showDesktopNotification({ title, body: notification.body, tag: notification.id, onClick: () => openNotification(notification) });
    if (!shownOnDesktop && channels.channels.toast) pushNotificationToast(notification);
    if (channels.channels.sound && !chimed && notification.severity !== "INFO") { playChime("notification"); chimed = true; }
  }
}
