import { useEffect, useState } from "react";
import { NOTIFICATION_SOURCE_LABELS, needsYouAnswerKind, needsYouAsk, type NotificationAnswerInput, type NousPaneBoard, type NousPaneBoardPane, type SpaceNotification } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockIconButton, DockState } from "../dock-kit/DockKit.js";
import { ackNotification, openNotification, refreshNotifications, useNotificationStore } from "../notifications/notification-store.js";
import { Nous, Send, X } from "../ui-theme/app-icons.js";

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

type BoardPane = NousPaneBoardPane & { roomName: string };

/**
 * Needs you as questions (operator request 2026-10-27, plan clipboard:5AQvaoSR-IZa): each card asks its ONE question, with its options
 * (the recommended one first in tone) and a text answer, like a decision; the answer reaches whoever asked without visiting the pane.
 * The pane board's newest report says whether the pane moved on since it asked.
 */
export function NousNeedsYou({ requests }: { requests: SpaceNotification[] | null }) {
  const [panes, setPanes] = useState<Map<string, BoardPane>>(new Map());
  useEffect(() => {
    if (!requests?.length) return;
    let cancelled = false;
    void api.nousPaneBoard().then(({ board }: { board: NousPaneBoard }) => {
      if (!cancelled) setPanes(new Map(board.rooms.flatMap((room) => room.panes.map((pane) => [pane.paneId, { ...pane, roomName: room.name }] as const))));
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [requests]);
  return (
    <div className="nous-decisions" data-sensitive-masked="manual">
      {requests === null ? <DockState kind="loading" title="Loading what waits for you" /> : null}
      {requests?.length === 0 ? <DockState kind="empty" icon={Nous} title="Nothing waits for you"
        detail="When a pane asks you something and you do not go, its question waits here until you answer it or it no longer needs you." /> : null}
      {requests?.map((item) => <NeedsYouCard key={item.id} item={item} pane={item.paneId ? panes.get(item.paneId) : undefined} />)}
    </div>
  );
}

function NeedsYouCard({ item, pane }: { item: SpaceNotification; pane: BoardPane | undefined }) {
  const ask = needsYouAsk(item);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A review or rule takes Approve or Decline; words go with them as a note.
  const decision = ask.answer.kind === "COPILOT_DECISION";
  const answer = async (input: NotificationAnswerInput) => {
    setBusy(true);
    setError(null);
    try {
      setSent((await api.answerNotification(item.id, input)).display);
      setText("");
      await refreshNotifications();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  const note = text.trim() ? { text: text.trim() } : {};
  const where = [pane?.roomName, pane?.name].filter(Boolean).join(" · ");
  const movedOn = pane?.report && pane.report.at > item.createdAt ? pane.report : null;
  return (
    <article className="nous-decision is-open" aria-label={item.title} data-notification-id={item.id}>
      <header>
        <span className="nous-category">{NOTIFICATION_SOURCE_LABELS[item.source]}</span>
        {where ? <span className="nous-muted">{where}</span> : null}
        <h3>{ask.question}</h3>
      </header>
      {item.body && item.body.trim() !== ask.question ? <details className="nous-needs-details"><summary>Details</summary><p>{item.body}</p></details> : null}
      {movedOn ? <p className="nous-muted">Since then ({formatUserTime(movedOn.at)}): {movedOn.summary}</p> : null}
      <p className="nous-muted">{item.title} · {formatUserTime(item.createdAt)}</p>
      {sent ? <p className="nous-recommendation" role="status">{sent}</p> : (
        <div className="nous-decision-actions">
          {(ask.options ?? []).map((option) => (
            <DockButton key={option} tone={option === ask.recommended ? "primary" : "default"} disabled={busy} onClick={() => void answer({ option, ...note })}>
              {option}{option === ask.recommended ? " (Recommended)" : ""}
            </DockButton>
          ))}
          {ask.recommended && needsYouAnswerKind(item) ? (
            <DockButton disabled={busy || Boolean(text.trim())} title={`From now on, Space answers "${ask.recommended}" to cards like this one without asking you (Settings → Assistants & AI → Nous: Ask me again)`}
              onClick={() => void answer({ option: ask.recommended!, always: true })}>Always answer like this</DockButton>
          ) : null}
          <form className="nous-decision-answer" onSubmit={(event) => { event.preventDefault(); if (text.trim() && !decision) void answer({ text: text.trim() }); }}>
            <input value={text} onChange={(event) => setText(event.target.value)} maxLength={2_000} aria-label="Your answer"
              placeholder={decision ? "Add a note, then Approve or Decline" : ask.options?.length ? "Or answer in your words" : "Your answer"} />
            {decision ? null : <DockIconButton label="Send answer" icon={Send} type="submit" disabled={busy || !text.trim()} />}
          </form>
          <DockButton onClick={() => openNotification(item)}>Go to pane</DockButton>
          <DockButton icon={X} title="It no longer needs you: remove it" onClick={() => void ackNotification(item.id)}>Dismiss</DockButton>
        </div>
      )}
      {error ? <p className="nous-muted" role="alert">{error}</p> : null}
    </article>
  );
}
