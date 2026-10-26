import { useEffect, useState } from "react";
import { NOTIFICATION_SOURCE_LABELS, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockState } from "../dock-kit/DockKit.js";
import { ackNotification, openNotification, useNotificationStore } from "../notifications/notification-store.js";
import { Nous, X } from "../ui-theme/app-icons.js";

/**
 * Needs you requests the operator did not go to (operator request 2026-10-24): every needs-you record still waiting (open, or read
 * by "Not now") on a pane that is still open, newest first. The server resolves the ones that no longer need them, and each change
 * reaches this tab through the notification store, so the list re-reads with it.
 */
export function useNeedsYouRequests(active: boolean): SpaceNotification[] | null {
  const { items } = useNotificationStore();
  const [requests, setRequests] = useState<SpaceNotification[] | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void api.notifications({ status: "NEEDS_YOU", limit: 200 }).then((result) => { if (!cancelled) setRequests(result.notifications); }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [active, items]);
  return requests;
}

export function NousNeedsYou({ requests }: { requests: SpaceNotification[] | null }) {
  return (
    <div className="nous-decisions" data-sensitive-masked="manual">
      {requests === null ? <DockState kind="loading" title="Loading what waits for you" /> : null}
      {requests?.length === 0 ? <DockState kind="empty" icon={Nous} title="Nothing waits for you"
        detail="When a pane calls you and you do not go, its request waits here until you go or it no longer needs you." /> : null}
      {requests?.map((item) => (
        <article key={item.id} className="nous-decision is-open" aria-label={item.title}>
          <header>
            <span className="nous-category">{NOTIFICATION_SOURCE_LABELS[item.source]}</span>
            <h3>{item.title}</h3>
          </header>
          {item.body ? <p>{item.body}</p> : null}
          <p className="nous-muted">{formatUserTime(item.createdAt)}</p>
          <div className="nous-decision-actions">
            <DockButton tone="primary" onClick={() => openNotification(item)}>Go now</DockButton>
            <DockButton icon={X} title="It no longer needs you: remove it" onClick={() => void ackNotification(item.id)}>Dismiss</DockButton>
          </div>
        </article>
      ))}
    </div>
  );
}
