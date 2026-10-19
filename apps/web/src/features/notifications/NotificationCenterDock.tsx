import { useEffect, useMemo, useState } from "react";
import { NOTIFICATION_SOURCES, NOTIFICATION_SOURCE_LABELS, type NotificationSource, type SpaceNotification } from "@space/contracts";
import { DockButton, DockChips, DockIconButton, DockState, DockToolbar } from "../dock-kit/DockKit.js";
import { Bell, Check, CheckCircle2 } from "../ui-theme/app-icons.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { ackNotification, isNousPaneCard, openNotification, readAllNotifications, refreshNotifications, useNotificationStore } from "./notification-store.js";
import "./notifications.css";

type Filter = "unread" | "all";

function when(iso: string, now = Date.now()): string {
  const minutes = Math.round((now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return formatUserTime(iso, { withDate: true });
}

function notificationRow(item: SpaceNotification) {
  return (
    <>
      <button type="button" className="notification-item-main" onClick={() => openNotification(item)} aria-label={`${item.status === "OPEN" ? "Unread: " : ""}${NOTIFICATION_SOURCE_LABELS[item.source]}: ${item.title}`}>
        <span className="notification-item-source">{NOTIFICATION_SOURCE_LABELS[item.source]}</span>
        <strong className="notification-item-title">{item.title}</strong>
        {item.body ? <span className="notification-item-body">{item.body}</span> : null}
        <time className="notification-item-time" dateTime={item.createdAt} title={formatUserTime(item.createdAt, { withDate: true })}>{when(item.createdAt)}</time>
      </button>
      {item.status === "OPEN" || item.status === "READ" ? (
        <DockIconButton label="Acknowledge" icon={Check} title="Acknowledge" onClick={() => void ackNotification(item.id)} />
      ) : null}
    </>
  );
}

/** The Notification Center: everything Space wanted the operator to see, newest first, with read / acknowledge and a click that opens the source. */
export function NotificationCenterDock() {
  const store = useNotificationStore();
  const [filter, setFilter] = useState<Filter>("unread");
  const [source, setSource] = useState<NotificationSource | "ALL">("ALL");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { void refreshNotifications(); }, []);
  const items = useMemo(() => store.items.filter((item) => (filter === "all" || item.status === "OPEN") && (source === "ALL" || item.source === source)), [filter, source, store.items]);
  // A pane with Nous's card shows one row (the card) with the pane's other notifications under it (plan clipboard:8FfXWclYUfOH).
  const paneCards = useMemo(() => new Map(items.filter(isNousPaneCard).map((card) => [card.paneId!, card])), [items]);
  const rows = useMemo(() => items.filter((item) => isNousPaneCard(item) || !item.paneId || !paneCards.has(item.paneId)), [items, paneCards]);
  const under = (card: SpaceNotification) => items.filter((item) => item.paneId === card.paneId && item.id !== card.id);
  const toggle = (paneId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(paneId)) next.add(paneId);
    return next;
  });
  const sources = useMemo(() => [{ id: "ALL" as const, label: "All" }, ...NOTIFICATION_SOURCES.filter((entry) => store.items.some((item) => item.source === entry))
    .map((entry) => ({ id: entry, label: NOTIFICATION_SOURCE_LABELS[entry], count: store.pending.bySource[entry] ?? 0 }))], [store.items, store.pending.bySource]);

  return (
    <section className="notification-center" aria-label="Notification Center">
      <DockToolbar title="Notifications" summary={store.pending.total ? `${store.pending.total} unread` : "Nothing waiting"}>
        <DockButton icon={CheckCircle2} disabled={!store.pending.total} onClick={() => void readAllNotifications()}>Mark all read</DockButton>
      </DockToolbar>
      <div className="notification-center-filters">
        <DockChips<Filter> label="Show" value={filter} onChange={setFilter} options={[{ id: "unread", label: "Unread", count: store.pending.total }, { id: "all", label: "All" }]} />
        {sources.length > 2 ? <DockChips<NotificationSource | "ALL"> label="Source" value={source} onChange={setSource} options={sources} /> : null}
      </div>
      {!store.loaded ? <DockState kind="loading" title="Loading notifications…" /> : null}
      {store.loaded && !items.length ? <DockState kind="empty" icon={Bell} title={filter === "unread" ? "All caught up" : "No notifications yet"} detail={filter === "unread" ? "New mail, questions and alerts show up here." : "What panes and services want you to see lands here."} /> : null}
      <ul className="notification-list" role="list">
        {rows.map((item) => {
          const others = isNousPaneCard(item) ? under(item) : [];
          const open = others.length > 0 && expanded.has(item.paneId!);
          return (
            <li key={item.id} className={`notification-item status-${item.status.toLowerCase()} severity-${item.severity.toLowerCase()}${others.length ? " notification-pane-group" : ""}`} data-notification-id={item.id}>
              {notificationRow(item)}
              {others.length ? (
                <button type="button" className="notification-pane-more" aria-expanded={open} onClick={() => toggle(item.paneId!)}>
                  {open ? "Hide" : "Show"} {others.length} more from this pane
                </button>
              ) : null}
              {open ? (
                <ul className="notification-pane-children" role="list" aria-label="More from this pane">
                  {others.map((other) => (
                    <li key={other.id} className={`notification-item status-${other.status.toLowerCase()} severity-${other.severity.toLowerCase()}`} data-notification-id={other.id}>
                      {notificationRow(other)}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
