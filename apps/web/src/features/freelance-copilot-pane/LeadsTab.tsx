import { useState } from "react";
import { FREELANCE_CHANNEL_LABELS, type FreelanceFunnel, type FreelanceLead, type FreelanceLeadStatus, type FreelanceMessage, type FreelanceMessageKind, type FreelanceMessageStatus, type FreelancePendingItem } from "@space/contracts";
import { api } from "../../api.js";
import { Check, ExternalLink, RotateCcw, Send, Undo2, X } from "../ui-theme/app-icons.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

/** The order lead groups show in: live conversations first, closed ones only on request. */
const GROUPS: Array<{ status: FreelanceLeadStatus; label: string; closed?: boolean }> = [
  { status: "TALKING", label: "Talking with the client" }, { status: "PROPOSED", label: "Proposal sent" }, { status: "QUALIFIED", label: "Qualified" }, { status: "NEW", label: "New" },
  { status: "WON", label: "Won", closed: true }, { status: "LOST", label: "Lost", closed: true }, { status: "SKIPPED", label: "Skipped", closed: true }
];

/** The words a message's kind and status are shown with (translated where they render). */
export const MESSAGE_KIND_LABEL: Record<FreelanceMessageKind, string> = { PROPOSAL: "proposal", MESSAGE: "message", FOLLOW_UP: "follow-up", APPLICATION: "application" };
const MESSAGE_STATUS_LABEL: Record<FreelanceMessageStatus, string> = {
  DRAFT: "draft", IN_REVIEW: "in review", APPROVED: "approved", SENDING: "sending", SENT: "sent", FAILED: "failed", REJECTED: "rejected", RECEIVED: "received", SUPERSEDED: "superseded"
};
/** A message's status as one message's tag: "sent" and "failed" also label counts elsewhere, where the Greek is plural, so the tag has its own key. */
function messageStatusText(status: FreelanceMessageStatus, t: (text: string) => string): string {
  const key = `message status: ${MESSAGE_STATUS_LABEL[status]}`;
  const text = t(key);
  return text === key ? MESSAGE_STATUS_LABEL[status] : text;
}

function useRun(onDone: () => void) {
  const language = useUiLanguage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : uiText(language, "The action failed."));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function LeadTitle({ lead }: { lead: FreelanceLead }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <div className="mk-post-head">
      <span className="jc-tag accent">{FREELANCE_CHANNEL_LABELS[lead.channel]}</span>
      {lead.url ? <a href={lead.url} target="_blank" rel="noreferrer noopener"><strong>{lead.title}</strong></a> : <strong>{lead.title}</strong>}
      {lead.budget ? <span className="jc-muted">{lead.budget}</span> : null}
      {lead.score !== null ? <span className="jc-tag">{t("fit {score}", { score: lead.score })}</span> : null}
      {lead.client ? <span className="jc-muted">{lead.client}</span> : null}
    </div>
  );
}

/** A client who wants to go ahead: what was agreed, and the operator's outcome. */
function ReadyCard({ lead, paneId, onChanged }: { lead: FreelanceLead; paneId: string; onChanged(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [value, setValue] = useState("");
  const { busy, error, run } = useRun(onChanged);
  const summary = typeof lead.payload.clientReadySummary === "string" ? lead.payload.clientReadySummary : null;
  return (
    <li className="mk-post fl-ready" data-status="in_review">
      <LeadTitle lead={lead} />
      {summary ? <p className="mk-post-body">{summary}</p> : null}
      <p className="jc-muted">{t("The client wants to go ahead: take over on {platform} (offer, contract, call). The copilot no longer negotiates here.", { platform: FREELANCE_CHANNEL_LABELS[lead.channel] })}</p>
      <div className="jc-actions">
        <input type="number" min={0} value={value} placeholder={t("Contract value (USD)")} aria-label={t("Contract value in USD")} disabled={busy} onChange={(event) => setValue(event.target.value)} />
        <button type="button" className="jc-button primary" disabled={busy} onClick={() => void run(() => api.decideFreelanceLead(paneId, lead.id, { decision: "won", ...(value ? { contractValue: Number(value) } : {}) }))}><Check aria-hidden="true" /> {t("Won")}</button>
        <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void run(() => api.decideFreelanceLead(paneId, lead.id, { decision: "lost" }))}><X aria-hidden="true" /> {t("Lost")}</button>
        <button type="button" className="jc-button ghost" disabled={busy} title={t("Give the conversation back to the copilot")} onClick={() => void run(() => api.decideFreelanceLead(paneId, lead.id, { decision: "reopen" }))}><Undo2 aria-hidden="true" /> {t("Back to the copilot")}</button>
      </div>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </li>
  );
}

/** A message the copilot asks about: approve, approve the operator's edit (learned), send back with a note, or reject. */
function ReviewCard({ item, paneId, onChanged, nousReviewing = false }: { item: FreelancePendingItem; paneId: string; onChanged(): void; nousReviewing?: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const message = item.payload.message as FreelanceMessage;
  const lead = item.payload.lead as FreelanceLead | null;
  const issues = Array.isArray(item.payload.wordingIssues) ? item.payload.wordingIssues as string[] : [];
  const [body, setBody] = useState(message.body);
  const [note, setNote] = useState("");
  const { busy, error, run } = useRun(onChanged);
  const edited = body !== message.body;
  return (
    <li className="mk-post" data-status="in_review">
      {lead ? <LeadTitle lead={lead} /> : null}
      <div className="mk-post-head">
        <span className="jc-tag">{t(MESSAGE_KIND_LABEL[message.kind])}</span>
        {message.bid ? <span className="jc-muted">{message.bid.type === "HOURLY" ? t("${amount}/h", { amount: message.bid.amount }) : t("${amount} fixed", { amount: message.bid.amount })}</span> : null}
        {message.connects ? <span className="jc-muted">{t("{count} Connects", { count: message.connects })}</span> : null}
      </div>
      {/* A review Nous decides under "May send" is read only here (operator 2/11 15:08 BKK). */}
      {nousReviewing ? <p className="mk-post-body">{message.body}</p> : <div className="mk-post-edit">
        <textarea rows={7} value={body} aria-label={t("Message text")} disabled={busy} onChange={(event) => setBody(event.target.value)} />
        <div className="mk-post-meta">
          <span className="jc-muted">{t("{count} characters", { count: body.length })}</span>
          {issues.length ? <span className="mk-over" role="note">{t("Why it waits for you: {issues}", { issues: issues.join(", ") })}</span> : null}
        </div>
        <input value={note} placeholder={t("Note for the copilot (needed to send back)")} aria-label={t("Note for the copilot")} disabled={busy} onChange={(event) => setNote(event.target.value)} />
        <div className="jc-actions">
          <button type="button" className="jc-button primary" disabled={busy || !body.trim()}
            onClick={() => void run(() => api.decideFreelanceMessage(paneId, message.id, edited ? { decision: "edit", body: body.trim(), ...(note.trim() ? { note: note.trim() } : {}) } : { decision: "approve", ...(note.trim() ? { note: note.trim() } : {}) }))}>
            <Check aria-hidden="true" /> {edited ? t("Approve my version") : t("Approve")}
          </button>
          <button type="button" className="jc-button" disabled={busy || !note.trim()} onClick={() => void run(() => api.decideFreelanceMessage(paneId, message.id, { decision: "revise", note: note.trim() }))}><Undo2 aria-hidden="true" /> {t("Send back")}</button>
          <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void run(() => api.decideFreelanceMessage(paneId, message.id, { decision: "reject", ...(note.trim() ? { note: note.trim() } : {}) }))}><X aria-hidden="true" /> {t("Reject")}</button>
        </div>
      </div>}
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </li>
  );
}

/** One lead; opening it loads the conversation (proposals, messages both ways) with retry for failed sends. */
export function LeadRow({ lead, paneId, onChanged }: { lead: FreelanceLead; paneId: string; onChanged(): void }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [messages, setMessages] = useState<FreelanceMessage[] | null>(null);
  const { busy, error, run } = useRun(onChanged);
  const load = () => api.freelanceLead(lead.id).then((detail) => setMessages(detail.messages), () => setMessages([]));
  return (
    <li className="mk-post" data-status={lead.status.toLowerCase()}>
      <details onToggle={(event) => { if ((event.target as HTMLDetailsElement).open && messages === null) void load(); }}>
        <summary><LeadTitle lead={lead} /></summary>
        {lead.notes ? <p className="jc-muted">{lead.notes}</p> : null}
        {lead.description ? <p className="mk-post-body">{lead.description}</p> : null}
        {messages === null ? <p className="jc-muted" role="status">{t("Loading the conversation…")}</p> : messages.length === 0 ? <p className="jc-muted">{t("No messages yet.")}</p> : (
          <ol className="fl-thread" aria-label={t("Conversation")}>
            {messages.map((message) => (
              <li key={message.id} className="fl-message" data-direction={message.direction.toLowerCase()}>
                <div className="mk-post-head">
                  <span className="jc-tag">{message.direction === "IN" ? t("client") : t(MESSAGE_KIND_LABEL[message.kind])}</span>
                  <span className="jc-muted">{messageStatusText(message.status, t)}</span>
                  {message.sentAt ? <span className="jc-muted">{new Date(message.sentAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span> : null}
                  {message.sentUrl ? <a className="jc-event-link" href={message.sentUrl} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" /> {t("Open")}</a> : null}
                </div>
                <p className="mk-post-body">{message.body}</p>
                {message.status === "FAILED" ? (
                  <div className="jc-actions">
                    {typeof message.evidence.failure === "string" ? <span className="mk-over">{message.evidence.failure}</span> : null}
                    <button type="button" className="jc-button" disabled={busy} onClick={() => void run(async () => { await api.retryFreelanceMessage(paneId, message.id); await load(); })}><RotateCcw aria-hidden="true" /> {t("Retry")}</button>
                  </div>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        {error ? <p className="jc-message" role="alert">{error}</p> : null}
      </details>
    </li>
  );
}

/**
 * Leads: ask the copilot for something, the funnel, the clients ready for the operator, the messages waiting for
 * review, then every lead grouped by state.
 */
export function LeadsTab({ paneId, leads, pending, funnel, onChanged, nousReviewing = false }: { paneId: string; leads: FreelanceLead[]; pending: FreelancePendingItem[]; funnel: FreelanceFunnel | null; onChanged(): void; nousReviewing?: boolean }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [brief, setBrief] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const ready = leads.filter((lead) => lead.status === "CLIENT_READY");
  const reviews = pending.filter((item) => item.kind === "REVIEW");
  const totals = funnel ? Object.values(funnel.channels).reduce((sum, row) => ({ sent: sum.sent + row.sent, talking: sum.talking + row.talking, won: sum.won + row.won }), { sent: 0, talking: 0, won: 0 }) : null;
  const sendBrief = async () => {
    if (busy || !brief.trim()) return;
    setBusy(true);
    setMessage(null);
    try {
      await api.createFreelanceBrief(paneId, { text: brief.trim() });
      setBrief("");
      setMessage(t("Sent to the copilot; it picks it up on its next run."));
      onChanged();
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : t("The brief could not be sent."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mk-posts" role="tabpanel" id="jc-panel-leads" aria-labelledby="jc-tab-leads">
      <form className="mk-brief" onSubmit={(event) => { event.preventDefault(); void sendBrief(); }}>
        <textarea rows={2} value={brief} placeholder={t("Ask the copilot for something, e.g. find MCP and Shopify integration jobs on Upwork today")} aria-label={t("Brief for the copilot")} disabled={busy} onChange={(event) => setBrief(event.target.value)} />
        <button type="submit" className="jc-button primary" disabled={busy || !brief.trim()}><Send aria-hidden="true" /> {t("Ask")}</button>
      </form>
      {totals && funnel ? (
        <p className="fl-funnel" role="status">
          <span><strong>{totals.sent}</strong> {t("sent")}</span><span><strong>{totals.talking}</strong> {t("conversations")}</span><span><strong>{totals.won}</strong> {t("won")}</span>
          <span><strong>${funnel.revenue.toLocaleString()}</strong> {t("revenue")}</span><span><strong>{funnel.connectsMonth}</strong> {t("Connects in 30 days")}</span>
        </p>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {ready.length ? (
        <section className="mk-group" aria-label={t("Clients ready for you")}>
          <h4>{t("Clients ready for you")} <span className="jc-muted">{ready.length}</span></h4>
          <ul className="mk-post-list">{ready.map((lead) => <ReadyCard key={`${lead.id}:${lead.updatedAt}`} lead={lead} paneId={paneId} onChanged={onChanged} />)}</ul>
        </section>
      ) : null}
      {reviews.length ? (
        <section className="mk-group" aria-label={t(nousReviewing ? "Nous reviewing" : "Needs your review")}>
          <h4>{t(nousReviewing ? "Nous reviewing" : "Needs your review")} <span className="jc-muted">{reviews.length}</span></h4>
          <ul className="mk-post-list">{reviews.map((item) => <ReviewCard key={`${item.id}:${item.createdAt}`} item={item} paneId={paneId} onChanged={onChanged} nousReviewing={nousReviewing} />)}</ul>
        </section>
      ) : null}
      {leads.length === 0 ? (
        <div className="jc-empty"><strong>{t("No leads yet")}</strong><span>{t("Connect the mailbox and the platform accounts in Setup, then press Start: the copilot turns job alerts and searches into leads and proposals.")}</span></div>
      ) : GROUPS.filter((group) => showClosed || !group.closed).map((group) => {
        const entries = leads.filter((lead) => lead.status === group.status);
        if (!entries.length) return null;
        return (
          <section key={group.status} className="mk-group" aria-label={t(group.label)}>
            <h4>{t(group.label)} <span className="jc-muted">{entries.length}</span></h4>
            <ul className="mk-post-list">{entries.map((lead) => <LeadRow key={lead.id} lead={lead} paneId={paneId} onChanged={onChanged} />)}</ul>
          </section>
        );
      })}
      {leads.some((lead) => lead.status === "WON" || lead.status === "LOST" || lead.status === "SKIPPED") ? (
        <button type="button" className="jc-button ghost" onClick={() => setShowClosed((shown) => !shown)}>{showClosed ? t("Hide won, lost and skipped") : t("Show won, lost and skipped")}</button>
      ) : null}
    </div>
  );
}
