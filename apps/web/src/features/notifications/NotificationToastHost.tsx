import { createElement, useEffect, useRef } from "react";
import { X } from "../ui-theme/app-icons.js";
import { dismissNotificationToast, openNotification, useNotificationStore } from "./notification-store.js";
import { notificationSourceIcons } from "./notification-source-icons.js";
import { uiSourceLabel, uiText, useAgentLanguage, useUiLanguage } from "../ui-language/ui-language.js";
import { needsYou, needsYouTranslation } from "@space/contracts";
import { NeedsYouPeek } from "../needs-you/NeedsYouPeek.js";
import "./notifications.css";

const TOAST_MS = 8_000;
/**
 * A needs-you toast without its translation waits for it as long as its desktop pop-up does (needsYouPopup, 3 x 4 s), then shows its 8 s:
 * the translator answered in 7.2 s at the median, 13 s at p90 (101 calls on 1/11), so most toasts went before their translation.
 */
const TOAST_TRANSLATION_WAIT_MS = 12_000;

/** The notification toasts of this tab (newest at the bottom), each for a few seconds, a click opening what it points at; below them the
 *  Needs you window (plan clipboard:ytwWl09xNH0Z). The container is always there, so what lands in it is announced. */
export function NotificationToastHost() {
  const { toasts, items } = useNotificationStore();
  const language = useUiLanguage();
  // A toast's text is the agents' language, its label and buttons the interface's (operator 2/11 09:51 BKK).
  const agents = useAgentLanguage();
  // When each toast's text became final: shownAt when it needed no wait, the translation's arrival (or the wait's end); null while it waits.
  const readyAt = useRef(new Map<string, number | null>());
  useEffect(() => {
    const now = Date.now();
    for (const id of readyAt.current.keys()) if (!toasts.some((toast) => toast.id === id)) readyAt.current.delete(id);
    const timers = toasts.map(({ id, notification, shownAt }) => {
      const ready = agents === "en" || !needsYou(notification) || Boolean(needsYouTranslation(items.find((item) => item.id === id) ?? notification, agents));
      const seen = readyAt.current.get(id);
      if (seen === undefined) readyAt.current.set(id, ready ? shownAt : null);
      else if (seen === null && ready) readyAt.current.set(id, Math.min(now, shownAt + TOAST_TRANSLATION_WAIT_MS));
      const until = (readyAt.current.get(id) ?? shownAt + TOAST_TRANSLATION_WAIT_MS) + TOAST_MS;
      return window.setTimeout(() => dismissNotificationToast(id), Math.max(0, until - now));
    });
    return () => { for (const timer of timers) window.clearTimeout(timer); };
  }, [toasts, items, agents]);
  return (
    <div className="notification-toasts" aria-live="polite">
      {toasts.map(({ id, notification }) => {
        // A needs-you card in the operator's language once the server translated it (notifications/translate.ts; it lands a few seconds after the card).
        const translated = needsYouTranslation(items.find((item) => item.id === id) ?? notification, agents);
        return (
        <aside key={id} className={`notification-toast severity-${notification.severity.toLowerCase()}`} role="status" data-notification-id={id}>
          <button type="button" className="notification-toast-main" onClick={() => openNotification(notification)}>
            {createElement(notificationSourceIcons[notification.source], { "aria-hidden": true })}
            <span className="notification-toast-copy">
              {/* lang: the uppercase label drops Greek accents as Greek capitals do. */}
              <span className="notification-toast-source" lang={language}>{uiSourceLabel(language, notification.source)}</span>
              <strong data-sensitive-masked="manual">{translated?.title ?? notification.title}</strong>
              {notification.body ? <small data-sensitive-masked="manual">{(translated?.body ?? notification.body).slice(0, 160)}</small> : null}
            </span>
          </button>
          <button type="button" className="notification-toast-close" aria-label={uiText(language, "Dismiss notification")} onClick={() => dismissNotificationToast(id)}><X aria-hidden="true" /></button>
        </aside>
        );
      })}
      <NeedsYouPeek />
    </div>
  );
}
