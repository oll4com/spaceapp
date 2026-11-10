import { useEffect, useState } from "react";
import type { MailActionLogEntry, MailCopilotEvent, MailCopilotPendingItem, MailComposeInput, MailFixRequestView, MailOperatorAction } from "@space/contracts";
import { api } from "../../api.js";
import { AlertTriangle, Archive, Bot, Check, CheckCircle2, CircleHelp, FileText, Flame, Folder, ListFilter, Mail, Pause, Pencil, Play, RefreshCw, Send, ShieldCheck, Square, Star, Trash2, X } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { mailTime } from "./MailClient.js";

const EVENT_ICON: Partial<Record<MailCopilotEvent["type"], typeof Check>> = {
  MAIL_RECEIVED: Mail, TRIAGE: Mail, USER_ACTION: Pencil, TRIAGED: Check, DRAFTED: Pencil, REPLIED: Send, SENT: Send, ARCHIVED: Archive, TRASHED: Trash2, LABELED: FileText, STARRED: Star,
  SKIPPED: Check, NEEDS_USER: CircleHelp, QUESTION: CircleHelp, ANSWERED: Check, REVIEW_REQUESTED: CircleHelp, REVIEW_DECIDED: CheckCircle2, NOTE: FileText,
  RUN_STARTED: Play, RUN_PAUSED: Pause, RUN_RESUMED: Play, RUN_STOPPED: Square, RUN_FINISHED: Flame, SYNC_RESET: AlertTriangle, RULE_PROPOSED: ShieldCheck, RULE_DECIDED: ShieldCheck, RULE_APPLIED: ShieldCheck,
  RULE_LEARNED: ShieldCheck, RULE_RETIRED: ShieldCheck, FIX_REQUESTED: Bot, FIXED: CheckCircle2
};
const EVENT_TONE: Partial<Record<MailCopilotEvent["type"], string>> = { SENT: "ok", REPLIED: "ok", REVIEW_DECIDED: "ok", RUN_FINISHED: "ok", RULE_DECIDED: "ok", QUESTION: "warn", REVIEW_REQUESTED: "warn", NEEDS_USER: "warn", RULE_PROPOSED: "warn", SYNC_RESET: "bad", TRIAGE: "muted", MAIL_RECEIVED: "muted", USER_ACTION: "muted", FIXED: "ok", RULE_LEARNED: "ok" };

/** The action log in words: who did what to which mail, where Space saw it. Whole phrases with the subject in a slot, so each language orders them its own way. */
const ACTION_TEXT: Record<MailOperatorAction, string> = {
  ARCHIVE: "archived “{subject}”", UNARCHIVE: "moved back to the inbox “{subject}”", TRASH: "trashed “{subject}”", UNTRASH: "restored from trash “{subject}”", DELETE: "deleted for good “{subject}”", MOVE: "moved “{subject}”", LABEL: "labeled “{subject}”", UNLABEL: "removed a label from “{subject}”",
  STAR: "starred “{subject}”", UNSTAR: "unstarred “{subject}”", SPAM: "reported as spam “{subject}”", NOT_SPAM: "marked not spam “{subject}”", REPLY: "replied to “{subject}”", FORWARD: "forwarded “{subject}”", FIX: "sent to the copilot to fix “{subject}”"
};
const ACTION_TEXT_WITH_LABELS = { MOVE: "moved “{subject}” to {labels}", LABEL: "labeled “{subject}” to {labels}" } as const;
const ACTION_ICON: Partial<Record<MailOperatorAction, typeof Check>> = { ARCHIVE: Archive, TRASH: Trash2, DELETE: Trash2, MOVE: Folder, LABEL: FileText, STAR: Star, REPLY: Send, FORWARD: Send, FIX: Bot };
const SOURCE_TEXT: Record<MailActionLogEntry["source"], string> = { PANE: "in the pane", GMAIL: "in Gmail", BACKFILL: "inferred from the mailbox", SPACE: "by a rule" };
const ACTOR_TEXT: Record<MailActionLogEntry["actor"], string> = { OPERATOR: "You", AGENT: "The copilot", SPACE: "Space" };
/** Where a mail sent to the copilot stands: waiting in its queue, being worked on, or done. */
const FIX_STATE: Record<"PENDING" | "TAKEN" | "DONE", string> = { PENDING: "Queued", TAKEN: "In progress", DONE: "Done" };
/** A hand-off's result in one word: fixed, waiting for the operator, or closed another way. */
function fixResult(request: MailFixRequestView): { label: string; tone: string } {
  if (request.status !== "DONE" || !request.outcome) return { label: FIX_STATE[request.status], tone: request.status === "TAKEN" ? "warn" : "muted" };
  if (request.outcome.type === "FIXED") return { label: "Fixed", tone: "ok" };
  if (request.outcome.type === "NEEDS_USER") return { label: "Needs you", tone: "warn" };
  return { label: "Done", tone: "info" };
}

/** One mail sent to the copilot: what was asked, what it asked back and was told, and what it did. */
function FixRequestCard({ request, onOpenThread }: { request: MailFixRequestView; onOpenThread(account: string, threadId: string): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const result = fixResult(request);
  return (
    <li className={`jc-event mc-fix-request tone-${result.tone}`}>
      <span className="jc-event-icon" aria-hidden="true"><Bot /></span>
      <div className="jc-event-body">
        <p><strong>{request.subject}</strong> <span className={`jc-tag${result.tone === "ok" ? " accent" : ""}`}>{t(result.label)}</span></p>
        <div className="jc-event-meta"><span className="jc-muted">{[request.account, request.from ? t("from {sender}", { sender: request.from }) : null, request.by === "rule" ? t("sent by a rule") : t("sent by you")].filter(Boolean).join(" · ")}</span>
          <span className="jc-muted" title={request.requestedAt}>{mailTime(request.requestedAt)}</span></div>
        {request.note ? <p className="mc-fix-line"><span className="jc-muted">{t("You asked:")}</span> {request.note}</p> : null}
        {request.exchanges.map((exchange) => (
          <p key={exchange.askedAt} className="mc-fix-line"><span className="jc-muted">{t("The copilot asked:")}</span> {exchange.question}{exchange.answer ? <><br /><span className="jc-muted">{t("You answered:")}</span> {exchange.answer}</> : <> <span className="jc-tag">{t("waiting for you")}</span></>}</p>
        ))}
        {request.outcome ? <p className="mc-fix-line"><span className="jc-muted">{t("Result ({time}):", { time: mailTime(request.outcome.at) })}</span> {request.outcome.summary}</p> : null}
        {request.memoryId ? <p className="mc-fix-line jc-muted">{t("Remembered for the next mail like this.")}</p> : null}
        {request.account && request.threadId ? <div className="jc-event-meta"><button type="button" className="jc-event-link" onClick={() => onOpenThread(request.account!, request.threadId!)}>{t("Open conversation")}</button></div> : null}
      </div>
    </li>
  );
}
export function actionLine(row: MailActionLogEntry, t: (text: string, vars?: Record<string, string | number>) => string): string {
  const subject = row.subject ?? t("(no subject)");
  const what = (row.action === "MOVE" || row.action === "LABEL") && row.labelNames.length
    ? t(ACTION_TEXT_WITH_LABELS[row.action], { subject, labels: row.labelNames.join(", ") })
    : t(ACTION_TEXT[row.action], { subject });
  const actor = t(ACTOR_TEXT[row.actor]);
  return row.fromAddress ? t("{actor} {what} from {address}", { actor, what, address: row.fromAddress }) : t("{actor} {what}", { actor, what });
}

function ReviewCard({ item, paneId, onDone, onShowThread, nousReviewing = false }: { item: MailCopilotPendingItem; paneId: string; onDone(): void; onShowThread(account: string, threadId: string): void; nousReviewing?: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const draft = item.payload.draft as MailComposeInput | undefined;
  const [text, setText] = useState(draft?.text ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!draft) return null;
  async function decide(decision: "approve" | "edit" | "reject") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideMailReview(paneId, { reviewId: item.id, decision, ...(decision === "edit" ? { text } : {}) });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("The decision failed."));
      setBusy(false);
    }
  }
  const edited = text !== draft.text;
  return (
    <section className="jc-pending" aria-label={t(nousReviewing ? "Nous reviewing" : "Review a reply")}>
      <header><CircleHelp aria-hidden="true" /> <strong>{t(nousReviewing ? "Nous reviewing" : "Review a reply")}</strong><span className="jc-muted">{draft.account} → {draft.to.join(", ")}</span></header>
      <p className="mc-review-subject"><strong>{draft.subject || t("(no subject)")}</strong></p>
      {typeof item.payload.reasoning === "string" && item.payload.reasoning ? <p className="jc-muted">{item.payload.reasoning}</p> : null}
      {/* A reply Nous decides under "May send" is read only here (operator 2/11 15:08 BKK). */}
      {nousReviewing ? <p className="mc-review-text">{draft.text}</p>
        : <textarea className="mc-review-text" rows={8} value={text} aria-label={t("Reply text")} disabled={busy} onChange={(event) => setText(event.target.value)} />}
      <div className="jc-actions">
        {nousReviewing ? null : <>
          <button type="button" className="jc-button primary" disabled={busy} onClick={() => void decide(edited ? "edit" : "approve")}><Check aria-hidden="true" /> {edited ? t("Send my version") : t("Approve and send")}</button>
          <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void decide("reject")}><X aria-hidden="true" /> {t("Reject")}</button>
        </>}
        {draft.threadId ? <button type="button" className="jc-button ghost" title={t("Show only this conversation in the mailbox and open it")} onClick={() => onShowThread(draft.account, draft.threadId!)}><ListFilter aria-hidden="true" /> {t("Show this mail")}</button> : null}
      </div>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </section>
  );
}

function QuestionCard({ item, paneId, onDone }: { item: MailCopilotPendingItem; paneId: string; onDone(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const options = Array.isArray(item.payload.options) ? item.payload.options.filter((option): option is string => typeof option === "string") : [];
  const question = typeof item.payload.question === "string" ? item.payload.question : item.message;
  async function submit(value: string) {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await api.answerMailQuestion(paneId, { questionId: item.id, answer: value.trim() });
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("The answer failed."));
      setBusy(false);
    }
  }
  return (
    <section className="jc-pending" aria-label={t("The copilot asks")}>
      <header><CircleHelp aria-hidden="true" /> <strong>{t("The copilot asks")}</strong>{item.accountEmail ? <span className="jc-muted">{item.accountEmail}</span> : null}</header>
      <p>{question}</p>
      {options.length ? <div className="jc-pending-options">{options.map((option) => <button key={option} type="button" className="jc-chip" disabled={busy} onClick={() => void submit(option)}>{option}</button>)}</div> : null}
      <form className="jc-pending-answer" onSubmit={(event) => { event.preventDefault(); void submit(answer); }}>
        <input value={answer} placeholder={t("Type the answer; the copilot remembers it")} aria-label={t("Answer")} disabled={busy} onChange={(event) => setAnswer(event.target.value)} />
        <button type="submit" className="jc-button primary" disabled={busy || !answer.trim()}>{t("Answer")}</button>
      </form>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </section>
  );
}

/** The Activity rail tab: what waits for the operator (reviews, questions), then the timeline. */
export function ActivityTab({ paneId, events, pending, onChanged, onOpenThread, onShowThread, nousReviewing = false }: {
  paneId: string;
  nousReviewing?: boolean;
  events: MailCopilotEvent[];
  pending: MailCopilotPendingItem[];
  onChanged(): void;
  onOpenThread(account: string, threadId: string): void;
  onShowThread(account: string, threadId: string): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState<string | null>(null);
  // "Your actions": the action log itself, so the operator can see that everything they did was recorded.
  const [view, setView] = useState<"activity" | "fixes" | "actions">("activity");
  const [actions, setActions] = useState<MailActionLogEntry[] | null>(null);
  // "Sent to AI": every hand-off with its questions, answers and result, so the operator sees what was done.
  const [fixes, setFixes] = useState<MailFixRequestView[] | null>(null);
  useEffect(() => {
    if (view !== "fixes") return undefined;
    let cancelled = false;
    api.mailFixRequests(paneId).then((result) => { if (!cancelled) setFixes(result.requests); }, () => { if (!cancelled) setFixes([]); });
    return () => { cancelled = true; };
  }, [events, paneId, view]);
  useEffect(() => {
    if (view !== "actions") return undefined;
    let cancelled = false;
    api.mailActions(paneId, { limit: 200 }).then((result) => { if (!cancelled) setActions(result.actions); }, () => { if (!cancelled) setActions([]); });
    return () => { cancelled = true; };
  }, [events, paneId, view]);
  const checkNow = async () => {
    if (checking) return;
    setChecking(true);
    try {
      const result = await api.syncMailCopilot(paneId);
      setChecked(result.created === 0 ? t("No new mail.") : result.created === 1 ? t("1 new message.") : t("{count} new messages.", { count: result.created }));
      onChanged();
    } catch (error) {
      setChecked(error instanceof Error ? error.message : t("The check failed."));
    } finally {
      setChecking(false);
    }
  };
  return (
    <div className="jc-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      <div className="jc-memory-toolbar mc-activity-toolbar">
        <div className="jc-chips" role="radiogroup" aria-label={t("Show")}>
          <button type="button" role="radio" aria-checked={view === "activity"} className={`jc-chip${view === "activity" ? " selected" : ""}`} onClick={() => setView("activity")}>{t("Activity")}</button>
          <button type="button" role="radio" aria-checked={view === "fixes"} className={`jc-chip${view === "fixes" ? " selected" : ""}`} onClick={() => setView("fixes")}>{t("Sent to AI")}</button>
          <button type="button" role="radio" aria-checked={view === "actions"} className={`jc-chip${view === "actions" ? " selected" : ""}`} onClick={() => setView("actions")}>{t("Your actions")}</button>
        </div>
        <button type="button" className="jc-button" disabled={checking} onClick={() => void checkNow()} title={t("Read what arrived since the last check")}><RefreshCw aria-hidden="true" className={checking ? "mc-spin" : undefined} /> {checking ? t("Checking…") : t("Check for new mail")}</button>
        {checked ? <span className="jc-muted mc-activity-status" role="status">{checked}</span> : null}
      </div>
      {view === "fixes" ? (
        fixes === null ? <p className="jc-muted jc-panel-loading" role="status">{t("Loading requests…")}</p>
          : fixes.length === 0 ? <div className="jc-empty"><strong>{t("Nothing sent to AI yet")}</strong><span>{t("Press the robot on a mail and the copilot checks and fixes what it needs; each request and its result land here.")}</span></div>
          : <ol className="jc-timeline" aria-label={t("Sent to AI")}>{fixes.map((request) => <FixRequestCard key={request.id} request={request} onOpenThread={onOpenThread} />)}</ol>
      ) : null}
      {view === "actions" ? (
        actions === null ? <p className="jc-muted jc-panel-loading" role="status">{t("Loading recorded actions…")}</p>
          : actions.length === 0 ? <div className="jc-empty"><strong>{t("Nothing recorded yet")}</strong><span>{t("What you do to mail, here or in Gmail itself, is listed here per account.")}</span></div>
          : (
            <ol className="jc-timeline" aria-label={t("Recorded actions")}>
              {actions.map((row) => {
                const Icon = ACTION_ICON[row.action] ?? FileText;
                return (
                  <li key={row.id} className={`jc-event tone-${row.source === "BACKFILL" ? "muted" : "info"}`}>
                    <span className="jc-event-icon" aria-hidden="true"><Icon /></span>
                    <div className="jc-event-body">
                      <p>{actionLine(row, t)}</p>
                      <div className="jc-event-meta">
                        <span className="jc-muted">{row.accountEmail} · {t(SOURCE_TEXT[row.source])}</span>
                        {row.action !== "DELETE" ? <button type="button" className="jc-event-link" onClick={() => onOpenThread(row.accountEmail, row.threadId)}>{t("Open conversation")}</button> : null}
                        <span className="jc-muted" title={row.occurredAt}>{mailTime(row.occurredAt)}</span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ol>
          )
      ) : null}
      {view === "activity" ? pending.map((item) => item.kind === "REVIEW" ? <ReviewCard key={item.id} item={item} paneId={paneId} onDone={onChanged} onShowThread={onShowThread} nousReviewing={nousReviewing} /> : <QuestionCard key={item.id} item={item} paneId={paneId} onDone={onChanged} />) : null}
      {view !== "activity" ? null : events.length === 0 ? (
        <div className="jc-empty"><strong>{t("No activity yet")}</strong><span>{t("Press Start. Every triage, draft, reply, question and lesson lands here as the copilot works.")}</span></div>
      ) : (
        <ol className="jc-timeline" aria-label={t("Activity")}>
          {events.map((event) => {
            const Icon = EVENT_ICON[event.type] ?? FileText;
            return (
              <li key={event.id} className={`jc-event tone-${EVENT_TONE[event.type] ?? "info"}`}>
                <span className="jc-event-icon" aria-hidden="true"><Icon /></span>
                <div className="jc-event-body">
                  <p>{event.message}{event.type === "FIX_REQUESTED" && event.status ? <> <span className={`jc-tag${event.status === "DONE" ? " accent" : ""}`}>{t(FIX_STATE[event.status])}</span></> : null}</p>
                  <div className="jc-event-meta">
                    {event.accountEmail && event.threadId ? <button type="button" className="jc-event-link" onClick={() => onOpenThread(event.accountEmail!, event.threadId!)}>{t("Open conversation")}</button> : null}
                    <span className="jc-muted" title={event.createdAt}>{mailTime(event.createdAt)}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
