import { useState } from "react";
import { findFileMentions, needsYou, needsYouCompletedAnswer, NOTIFICATION_SOURCE_LABELS, operatorUpdatePayloadSchema, unreadForOperator, waitsOnOperator, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import { DockIconButton } from "../dock-kit/DockKit.js";
import { Check, ClipboardCheck, ExternalLink } from "../ui-theme/app-icons.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { ackNotification, notificationJoinUrl, openNotification, readAllNotifications, refreshNotifications, useNotificationStore } from "./notification-store.js";
import { DoneCard, isDoneRequest } from "../nous/NousDone.js";
import { notificationSourceIcons } from "./notification-source-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import "./notifications.css";

function when(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return formatUserTime(iso, { withDate: true });
}

/** Plan clipboard:aE7U1J_gU9OV step 5: a needs-you card closes from the Notifications dock too (Nous hidden), the same one tap as its card. */
function CompletedButton({ item }: { item: SpaceNotification }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const language = useUiLanguage();
  const input = needsYouCompletedAnswer(item);
  if (!input) return null;
  const complete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.answerNotification(item.id, input);
      await refreshNotifications();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return <DockIconButton label={uiText(language, "Completed")} icon={ClipboardCheck} busy={busy} disabled={busy}
    title={error ? uiText(language, "Not sent: {error}", { error }) : uiText(language, "Completed: sends \"Done, all good\" and closes it everywhere")}
    onClick={() => void complete()} />;
}

/** Plan clipboard:JD8EbQgQdRls step 4: with Nous hidden a Done (request, summary, Checked, «Seen it») or an Update (full report, links) opens under its row. */
function ReportInPlace({ item }: { item: SpaceNotification }) {
  const { reportView } = useNotificationStore();
  if (reportView !== item.id) return null;
  if (isDoneRequest(item)) return <div className="notification-item-report"><DoneCard item={item} /></div>;
  const update = operatorUpdatePayloadSchema.safeParse(item.payload);
  if (!update.success) return null;
  return (
    <div className="notification-item-report">
      <p><FileMentionText text={update.data.report} /></p>
      {update.data.links.length ? <p className="notification-item-files">{update.data.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer noopener">{link.label}</a>)}</p> : null}
    </div>
  );
}

/** One alert's row, in the Notifications dock and in Nous › Inbox. */
export function notificationRow(item: SpaceNotification) {
  const Icon = notificationSourceIcons[item.source];
  const join = notificationJoinUrl(item);
  return (
    <>
      <button type="button" className="notification-item-main" onClick={() => openNotification(item)} aria-label={`${item.status === "OPEN" ? "Unread: " : ""}${NOTIFICATION_SOURCE_LABELS[item.source]}: ${item.title}`}>
        <span className="notification-item-icon"><Icon aria-hidden="true" /></span>
        <span className="notification-item-copy">
          <strong className="notification-item-title">{item.title}</strong>
          {item.body ? <span className="notification-item-body">{item.body}</span> : null}
          <span className="notification-item-meta">
            <span className="notification-item-source">{NOTIFICATION_SOURCE_LABELS[item.source]}</span>
            <time className="notification-item-time" dateTime={item.createdAt} title={formatUserTime(item.createdAt, { withDate: true })}>{when(item.createdAt)}</time>
          </span>
        </span>
      </button>
      {/* Operator 17/11 14:04 BKK: on a needs-you card the check only marks it read (it still waits in Needs you); acknowledging it went unanswered. */}
      {needsYou(item) && waitsOnOperator(item) ? <CompletedButton item={item} /> : null}
      {needsYou(item) ? (unreadForOperator(item) ? (
        <DockIconButton label="Mark read" icon={Check} title="Mark read (it still waits in Needs you)" onClick={() => void readAllNotifications(item.id)} />
      ) : null) : item.status === "OPEN" || item.status === "READ" ? (
        <DockIconButton label="Acknowledge" icon={Check} title="Acknowledge" onClick={() => void ackNotification(item.id)} />
      ) : null}
      {/* nous_msg:8e7e6c25: the files a reminder or card names open from here (the row itself is a button, so they sit under it). */}
      {join ? <p className="notification-item-files"><a className="notification-join" href={join} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" />Join {new URL(join).hostname}</a></p> : null}
      {findFileMentions(item.body).length ? <p className="notification-item-files"><FileMentionText text={findFileMentions(item.body).map((mention) => mention.text).join("  ")} /></p> : null}
      <ReportInPlace item={item} />
    </>
  );
}
