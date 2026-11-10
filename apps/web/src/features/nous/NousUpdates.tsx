import { useCallback, useEffect, useRef, useState } from "react";
import { OPERATOR_UPDATE_KIND, operatorUpdatePayloadSchema, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockState } from "../dock-kit/DockKit.js";
import { markNotificationRead, useNotificationStore } from "../notifications/notification-store.js";
import { consumeUpdatesView, NOUS_DONE_OPEN_EVENT } from "./nous-done-events.js";
import { Megaphone } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { FileMentionText } from "../terminal-pane/AgentFileLinks.js";
import "./nous-done.css";

/**
 * Nous › Updates (operator 4/11 15:04 BKK, R73): what he must know, newest first: program approvals and rejections with their full report,
 * and what Nous carried out. A small card each; its report opens only when he selects it (operator rule 3/11); Mark read per entry.
 */
export function useUpdatesView(onOpen: () => void): void {
  const callback = useRef(onOpen);
  callback.current = onOpen;
  useEffect(() => {
    const open = () => { if (consumeUpdatesView()) callback.current(); };
    window.addEventListener(NOUS_DONE_OPEN_EVENT, open);
    open();
    return () => window.removeEventListener(NOUS_DONE_OPEN_EVENT, open);
  }, []);
}
const isUpdate = (item: SpaceNotification) => item.source === "NOUS" && item.kind === OPERATOR_UPDATE_KIND && operatorUpdatePayloadSchema.safeParse(item.payload).success;

/** Every update (read ones stay in the feed); the count is the unread ones. A notification-store change pages them again. */
export function useOperatorUpdates(active: boolean) {
  const { items } = useNotificationStore();
  const [updates, setUpdates] = useState<SpaceNotification[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void (async () => {
      const found: SpaceNotification[] = [];
      let before: string | undefined;
      for (;;) {
        const { notifications } = await api.notifications({ status: "ALL", source: "NOUS", kind: OPERATOR_UPDATE_KIND, limit: 200, ...(before ? { before } : {}) });
        if (cancelled) return;
        found.push(...notifications.filter(isUpdate));
        const oldest = notifications.at(-1)?.createdAt;
        if (notifications.length < 200 || !oldest || oldest === before) break;
        before = oldest;
      }
      if (!cancelled) { setUpdates(found); setError(null); }
    })().catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "Updates could not be loaded. Try again."); });
    return () => { cancelled = true; };
  }, [active, items, revision]);
  const retry = useCallback(() => setRevision((value) => value + 1), []);
  return { updates, error, count: updates?.filter((item) => item.status === "OPEN").length ?? 0, retry };
}

export function NousUpdates({ updates, error, onRetry }: { updates: SpaceNotification[] | null; error?: string | null; onRetry?(): void }) {
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  return <div className="nous-decisions nous-done" data-sensitive-masked="manual">
    {error ? <div><p role="alert">{t(error)}</p>{onRetry ? <DockButton onClick={onRetry}>{t("Retry")}</DockButton> : null}</div> : null}
    {updates === null && !error ? <DockState kind="loading" title={t("Loading updates")} /> : null}
    {updates?.length === 0 ? <DockState kind="empty" icon={Megaphone} title={t("No updates yet")}
      detail={t("Program approvals and rejections and what Nous carried out for you appear here. Select one to read its full report.")} /> : null}
    {updates?.map((item) => <UpdateCard key={item.id} item={item} />)}
  </div>;
}

function UpdateCard({ item }: { item: SpaceNotification }) {
  const language = useUiLanguage();
  const t = (text: string) => uiText(language, text);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const payload = operatorUpdatePayloadSchema.parse(item.payload);
  const unread = item.status === "OPEN";
  const markRead = async () => { setBusy(true); try { await markNotificationRead(item.id); } finally { setBusy(false); } };
  return <article className="nous-done-entry nous-update" aria-label={item.title} data-notification-id={item.id} data-unread={unread || undefined}>
    <div className="nous-done-meta"><span>{t(unread ? "New" : "Seen")}</span><time dateTime={item.createdAt}>{formatUserTime(item.createdAt)}</time></div>
    <h4 className="nous-update-title">{item.title}</h4>
    <p className="nous-done-summary"><FileMentionText text={item.body} /></p>
    <DockButton aria-expanded={open} onClick={() => setOpen((shown) => !shown)}>{t(open ? "Hide the report" : "Full report")}</DockButton>
    {open ? <section aria-label={t("Full report")}>
      <p className="nous-done-summary"><FileMentionText text={payload.report} /></p>
      {payload.links.length ? <nav className="nous-done-links" aria-label={t("Links")}>
        {payload.links.map((link) => <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>)}
      </nav> : null}
    </section> : null}
    {unread ? <DockButton tone="primary" busy={busy} disabled={busy} onClick={() => void markRead()}>{t("Mark read")}</DockButton> : null}
  </article>;
}
