import { createElement, lazy, Suspense } from "react";
import { ExternalLink, X } from "../ui-theme/app-icons.js";
import { closeMailView, dismissNotificationToast, notificationJoinUrl, openNotification, useNotificationStore } from "./notification-store.js";
import { notificationSourceIcons } from "./notification-source-icons.js";
import { uiSourceLabel, uiText, useAgentLanguage, useUiLanguage } from "../ui-language/ui-language.js";
import { needsYouTranslation } from "@space/contracts";
import { NeedsYouPeek } from "../needs-you/NeedsYouPeek.js";
import "./notifications.css";

// The Mail pane's renderer loads with the first mail opened from a notification, not with every page.
const MailThreadDialog = lazy(() => import("../mail-copilot-pane/MailThreadDialog.js").then((module) => ({ default: module.MailThreadDialog })));

/** The notification toasts of this tab (newest at the bottom), each until its X (operator 19/11 nous_msg:8c3a737937b14ac089e5a7e6: «να μην κλεινει
 *  μονο του»), a click opening what it points at (a mail in place); below them the Needs you window (plan clipboard:ytwWl09xNH0Z). The container is
 *  always there, so what lands in it is announced. */
export function NotificationToastHost() {
  const { toasts, items, mailView } = useNotificationStore();
  const language = useUiLanguage();
  // A toast's text is the agents' language, its label and buttons the interface's (operator 2/11 09:51 BKK).
  const agents = useAgentLanguage();
  return (
    <>
    <div className="notification-toasts" aria-live="polite">
      {toasts.map(({ id, notification }) => {
        // A needs-you card in the operator's language once the server translated it (notifications/translate.ts; it lands a few seconds after the card).
        const translated = needsYouTranslation(items.find((item) => item.id === id) ?? notification, agents);
        const join = notificationJoinUrl(notification);
        return (
        <aside key={id} className={`notification-toast severity-${notification.severity.toLowerCase()}`} role="status" data-notification-id={id}>
          <button type="button" className="notification-toast-main" onClick={() => openNotification(notification)}>
            {createElement(notificationSourceIcons[notification.source], { "aria-hidden": true })}
            <span className="notification-toast-copy">
              {/* lang: the uppercase label drops Greek accents as Greek capitals do. */}
              <span className="notification-toast-source" lang={language}>{uiSourceLabel(language, notification.source)}</span>
              <strong>{translated?.title ?? notification.title}</strong>
              {notification.body ? <small>{(translated?.body ?? notification.body).slice(0, 160)}</small> : null}
            </span>
          </button>
          <button type="button" className="notification-toast-close" aria-label={uiText(language, "Dismiss notification")} onClick={() => dismissNotificationToast(id)}><X aria-hidden="true" /></button>
          {join ? <a className="notification-join" href={join} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" />{uiText(language, "Join {host}", { host: new URL(join).hostname })}</a> : null}
        </aside>
        );
      })}
      <NeedsYouPeek />
    </div>
    {mailView ? <Suspense fallback={null}><MailThreadDialog key={`${mailView.account} ${mailView.threadId}`} mail={mailView} onClose={closeMailView} /></Suspense> : null}
    </>
  );
}
