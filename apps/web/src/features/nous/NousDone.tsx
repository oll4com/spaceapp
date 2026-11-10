import { useCallback, useEffect, useRef, useState } from "react";
import { requestDonePayloadSchema, type DeployQueueTicket, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockState } from "../dock-kit/DockKit.js";
import { refreshNotifications, useNotificationStore } from "../notifications/notification-store.js";
import { consumeDoneView, NOUS_DONE_OPEN_EVENT } from "./nous-done-events.js";
import { statusLabel } from "../deploy-queue/deploy-queue-format.js";
import { CheckCheck } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import "./nous-done.css";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";

export function useDoneView(onOpen: () => void): void {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    const open = () => { if (consumeDoneView()) callback.current(); };
    window.addEventListener(NOUS_DONE_OPEN_EVENT, open);
    open();
    return () => window.removeEventListener(NOUS_DONE_OPEN_EVENT, open);
  }, []);
}
const pending = (item: SpaceNotification) => item.status === "OPEN" || item.status === "READ";
const visible = (item: SpaceNotification) => item.source === "NOUS" && item.kind === "REQUEST_DONE" && requestDonePayloadSchema.safeParse({
  request: item.payload.request, summary: item.payload.summary, where: item.payload.where,
  ...(item.payload.planId ? { planId: item.payload.planId } : {}), ...(item.payload.tickets ? { tickets: item.payload.tickets } : {})
}).success && pending(item);

/** Read and unread both wait for Got it. A notification-store update also refreshes the count while another view is open. */
export function useDoneRequests(active: boolean) {
  const { items } = useNotificationStore();
  const [requests, setRequests] = useState<SpaceNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const found: SpaceNotification[] = [];
      let before: string | undefined;
      // Page independently of the operator's other notices; old OPEN/READ completions still wait for acknowledgement.
      for (;;) {
        const { notifications } = await api.notifications({ status: "ALL", source: "NOUS", kind: "REQUEST_DONE", limit: 200, ...(before ? { before } : {}) });
        if (cancelled) return;
        found.push(...notifications.filter(visible));
        const oldest = notifications.at(-1)?.createdAt;
        if (notifications.length < 200 || !oldest || oldest === before) break;
        before = oldest;
      }
      if (!cancelled) { setRequests(found); setError(null); }
    })().catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "Completed requests could not be loaded. Try again."); });
    return () => { cancelled = true; };
  }, [active, items, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  const acknowledged = useCallback((next: SpaceNotification) => setRequests((current) => current?.filter((item) => item.id !== next.id) ?? null), []);
  return { requests, error, count: requests?.filter(pending).length ?? 0, acknowledged, retry };
}

/** Got it removes a request from this list; the server keeps its acknowledgement record. */
export function NousDone({ requests, error, onRetry, onOpenPlan, onAcknowledged }: {
  requests: SpaceNotification[] | null; error?: string | null; onRetry?(): void; onOpenPlan(id: string): void; onAcknowledged(item: SpaceNotification): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const waiting = requests?.filter(visible) ?? [];
  return <div className="nous-decisions nous-done" data-sensitive-masked="manual">
    {error ? <div><p role="alert">{error}</p>{onRetry ? <DockButton onClick={onRetry}>{t("Retry")}</DockButton> : null}</div> : null}
    {requests === null && !error ? <DockState kind="loading" title={t("Loading completed requests")} /> : null}
    {requests !== null && !waiting.length ? <DockState kind="empty" icon={CheckCheck} title={t("You’re up to date")}
      detail={t("Completed requests appear here with a short summary. Got it confirms you have been informed.")} /> : null}
    {waiting.map((item) => <DoneCard key={item.id} item={item} onOpenPlan={onOpenPlan} onAcknowledged={onAcknowledged} />)}
  </div>;
}

function DoneCard({ item, onOpenPlan, onAcknowledged }: { item: SpaceNotification; onOpenPlan(id: string): void; onAcknowledged(item: SpaceNotification): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticket, setTicket] = useState<DeployQueueTicket | null>(null);
  const [ticketBusy, setTicketBusy] = useState(false);
  const [ticketError, setTicketError] = useState<string | null>(null);
  const showTicket = async (id: string) => {
    setTicketBusy(true); setTicketError(null); setTicket(null);
    try { setTicket((await api.deployQueueTicket(id)).ticket); }
    catch (failure) { setTicketError(failure instanceof Error ? failure.message : "The ticket could not be loaded. Select its link to retry."); }
    finally { setTicketBusy(false); }
  };
  const payload = item.payload as { request: string; summary: string; where: "stable" | "dev" | "no code"; planId?: string; tickets?: string[]; verified?: string };
  const acknowledge = async () => {
    setBusy(true); setError(null);
    try {
      const { notification } = await api.ackNotification(item.id);
      onAcknowledged(notification);
      await refreshNotifications();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Your acknowledgement could not be saved. Try Got it again."); }
    finally { setBusy(false); }
  };
  const where = t({ stable: "Stable", dev: "Dev", "no code": "No code" }[payload.where]);
  return <article className="nous-done-entry" aria-label={payload.request} data-notification-id={item.id}>
    <div className="nous-done-meta"><span>{where}</span><time dateTime={item.createdAt}>{formatUserTime(item.createdAt)}</time></div>
    <blockquote>{payload.request}</blockquote>
    <p className="nous-done-summary"><FileMentionText text={payload.summary} /></p>
    {payload.verified ? <p className="nous-muted">{t("Checked: {what}", { what: payload.verified })}</p> : null}
    {payload.planId || payload.tickets?.length ? <nav className="nous-done-links" aria-label={t("Implementation links")}>
      {payload.planId ? <button type="button" onClick={() => onOpenPlan(payload.planId!)}>{t("Open plan")}</button> : null}
      {payload.tickets?.map((id) => <a key={id} href={`/api/admin/deploy-queue/tickets/${encodeURIComponent(id)}`} title={`View merge-queue ticket ${id}`}
        onClick={(event) => { event.preventDefault(); void showTicket(id); }}>{id}</a>)}
    </nav> : null}
    {ticketBusy ? <p role="status">{t("Loading ticket…")}</p> : null}
    {ticketError ? <p role="alert">{ticketError}</p> : null}
    {ticket ? <section className="nous-done-ticket" aria-label={`Ticket ${ticket.id}`}><h4>{ticket.id} · {statusLabel[ticket.status]}</h4>
      <p>{ticket.summary}</p>{ticket.note ? <p className="nous-muted">{ticket.note}</p> : null}</section> : null}
    <DockButton tone="primary" busy={busy} disabled={busy} onClick={() => void acknowledge()}>{t("Got it")}</DockButton>
    {error ? <p role="alert">{error}</p> : null}
  </article>;
}
