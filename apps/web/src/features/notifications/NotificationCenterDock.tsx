import { useEffect, useMemo, useState } from "react";
import { NOTIFICATION_SOURCES, NOTIFICATION_SOURCE_LABELS, unreadForOperator, type NotificationSource, type SpaceNotification } from "@space/contracts";
import { AgentFileMentions } from "../terminal-pane/AgentFileLinks.js";
import { DockButton, DockChips, DockState, DockToolbar } from "../dock-kit/DockKit.js";
import { Bell, CheckCircle2 } from "../ui-theme/app-icons.js";
import { isNousPaneCard, loadEarlierNotifications, notificationsBadge, readAllNotifications, refreshNotifications, useNotificationStore } from "./notification-store.js";
import { notificationRow } from "./NotificationRow.js";
import "./notifications.css";

type Filter = "unread" | "all";

/**
 * The Notification Center: everything Space wanted the operator to see, newest first, with read / acknowledge and a click that opens the source.
 * It is the bell's own dock and works without Nous (operator 17/11, nous_msg:e1bcd1d9). Unread lists what waits on the operator: an unread
 * record or a needs-you card opened (READ) but never answered (efe70d0bf7), the same records as the bell's count; Mark all read empties it
 * (`unreadForOperator`, operator 17/11 14:04 BKK) and the cards still wait in Needs you.
 */
export function NotificationCenterDock() {
  const store = useNotificationStore();
  const [filter, setFilter] = useState<Filter>("unread");
  const [source, setSource] = useState<NotificationSource | "ALL">("ALL");
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { void refreshNotifications(); }, []);
  const all = useMemo(() => [...store.items, ...(store.earlier ?? []).filter((old) => !store.items.some((item) => item.id === old.id))], [store.items, store.earlier]);
  // The row whose report is open stays under Unread while it is read (opening it marks it read).
  const items = useMemo(() => all.filter((item) => (filter === "all" || unreadForOperator(item) || item.id === store.reportView) && (source === "ALL" || item.source === source)),
    [filter, source, all, store.reportView]);
  // A pane with Nous's card shows one row (the card) with the pane's other notifications under it (plan clipboard:8FfXWclYUfOH).
  const paneCards = useMemo(() => new Map(items.filter(isNousPaneCard).map((card) => [card.paneId!, card])), [items]);
  const rows = useMemo(() => items.filter((item) => isNousPaneCard(item) || !item.paneId || !paneCards.has(item.paneId)), [items, paneCards]);
  const under = (card: SpaceNotification) => items.filter((item) => item.paneId === card.paneId && item.id !== card.id);
  const toggle = (paneId: string) => setExpanded((current) => {
    const next = new Set(current);
    if (!next.delete(paneId)) next.add(paneId);
    return next;
  });
  // Under Unread a source with nothing unread would only lead to an empty list, so it shows only while it is the chosen one.
  const sources = useMemo(() => [{ id: "ALL" as const, label: "All sources" }, ...NOTIFICATION_SOURCES
    .filter((entry) => entry === source || (store.items.some((item) => item.source === entry) && (filter === "all" || (store.pending.bySource[entry] ?? 0) > 0)))
    .map((entry) => ({ id: entry, label: NOTIFICATION_SOURCE_LABELS[entry], count: store.pending.bySource[entry] ?? 0 }))], [filter, source, store.items, store.pending.bySource]);

  const pendingTotal = notificationsBadge(store);
  return (
    <AgentFileMentions>
    <section className="notification-center dock-kit-dock" aria-label="Notification Center">
      <DockToolbar summary={pendingTotal ? `${pendingTotal} unread` : "Nothing waiting"}>
        <DockButton icon={CheckCircle2} disabled={!pendingTotal} onClick={() => void readAllNotifications()}>Mark all read</DockButton>
      </DockToolbar>
      <div className="dock-kit-controls">
        <DockChips<Filter> label="Show" value={filter} onChange={setFilter} options={[{ id: "unread", label: "Unread", count: pendingTotal }, { id: "all", label: "All" }]} />
        {sources.length > 2 || source !== "ALL" ? <DockChips<NotificationSource | "ALL"> label="Source" className="notification-source-chips" value={source} onChange={setSource} options={sources} /> : null}
      </div>
      {!store.loaded ? <DockState kind="loading" title="Loading notifications…" /> : null}
      {store.loaded && !items.length ? <DockState kind="empty" icon={Bell} title={filter === "unread" ? "All caught up" : "No notifications yet"} detail={filter === "unread" ? "New mail, questions and alerts show up here." : "What panes and services want you to see lands here."} /> : null}
      <ul className="notification-list dock-kit-list" role="list">
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
      {store.loaded && store.hasEarlier ? <DockButton onClick={() => void loadEarlierNotifications().catch(() => undefined)}>Load earlier notifications</DockButton> : null}
    </section>
    </AgentFileMentions>
  );
}
