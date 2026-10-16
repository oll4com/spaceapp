import { useEffect } from "react";
import { NOTIFICATION_SOURCE_LABELS } from "@space/contracts";
import { Bell, X } from "../ui-theme/app-icons.js";
import { dismissNotificationToast, openNotification, useNotificationStore } from "./notification-store.js";
import "./notifications.css";

const TOAST_MS = 8_000;

/** The notification toasts of this tab (newest at the bottom), each for a few seconds; a click opens what it points at. */
export function NotificationToastHost() {
  const { toasts } = useNotificationStore();
  useEffect(() => {
    if (!toasts.length) return;
    const timers = toasts.map((toast) => window.setTimeout(() => dismissNotificationToast(toast.id), Math.max(0, TOAST_MS - (Date.now() - toast.shownAt))));
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [toasts]);
  if (!toasts.length) return null;
  return (
    <div className="notification-toasts" aria-live="polite">
      {toasts.map(({ id, notification }) => (
        <aside key={id} className={`notification-toast severity-${notification.severity.toLowerCase()}`} role="status" data-notification-id={id}>
          <button type="button" className="notification-toast-main" onClick={() => openNotification(notification)}>
            <Bell aria-hidden="true" />
            <span className="notification-toast-copy">
              <span className="notification-toast-source">{NOTIFICATION_SOURCE_LABELS[notification.source]}</span>
              <strong>{notification.title}</strong>
              {notification.body ? <small>{notification.body.slice(0, 160)}</small> : null}
            </span>
          </button>
          <button type="button" className="notification-toast-close" aria-label="Dismiss notification" onClick={() => dismissNotificationToast(id)}><X aria-hidden="true" /></button>
        </aside>
      ))}
    </div>
  );
}
