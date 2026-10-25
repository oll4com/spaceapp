import { useState } from "react";
import { FREELANCE_CHANNEL_LABELS, type FreelanceAccount, type FreelanceEvent, type FreelancePendingItem, type FreelanceRule } from "@space/contracts";
import { api } from "../../api.js";
import { AlertTriangle, Check, CheckCircle2, CircleHelp, ExternalLink, FileText, Mail, Pause, Pencil, Play, Rocket, Send, ShieldCheck, Square, UserCheck, X } from "../ui-theme/app-icons.js";

const EVENT_ICON: Partial<Record<FreelanceEvent["type"], typeof Check>> = {
  BRIEF: Pencil, MAIL: Mail, LEAD_ADDED: FileText, MESSAGE_DRAFTED: FileText, MESSAGE_RECEIVED: Mail, REVIEW_REQUESTED: CircleHelp, REVIEW_DECIDED: CheckCircle2, SENDING: Send, SENT: Send,
  SEND_FAILED: AlertTriangle, CLIENT_READY: UserCheck, LEAD_DECIDED: Rocket, QUESTION: CircleHelp, ANSWERED: Check, NEEDS_USER: CircleHelp, RULE_PROPOSED: ShieldCheck, RULE_DECIDED: ShieldCheck,
  RULE_APPLIED: ShieldCheck, RUN_STARTED: Play, RUN_RESUMED: Play, RUN_PAUSED: Pause, RUN_STOPPED: Square
};
const EVENT_TONE: Partial<Record<FreelanceEvent["type"], string>> = {
  SENT: "ok", REVIEW_DECIDED: "ok", LEAD_DECIDED: "ok", RULE_DECIDED: "ok", CLIENT_READY: "warn", QUESTION: "warn", REVIEW_REQUESTED: "warn", NEEDS_USER: "warn", RULE_PROPOSED: "warn",
  SEND_FAILED: "bad", BRIEF: "muted", MAIL: "muted"
};

function useAction(onDone: () => void) {
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
      setError(caught instanceof Error ? caught.message : "The action failed.");
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function QuestionCard({ item, paneId, onDone }: { item: FreelancePendingItem; paneId: string; onDone(): void }) {
  const [answer, setAnswer] = useState("");
  const { busy, error, run } = useAction(onDone);
  const options = Array.isArray(item.payload.options) ? item.payload.options.filter((option): option is string => typeof option === "string") : [];
  const submit = (value: string) => { if (value.trim()) void run(() => api.answerFreelanceQuestion(paneId, { questionId: item.id, answer: value.trim() })); };
  return (
    <section className="jc-pending" aria-label="The copilot asks">
      <header><CircleHelp aria-hidden="true" /> <strong>The copilot asks</strong></header>
      <p>{typeof item.payload.question === "string" ? item.payload.question : item.message}</p>
      {options.length ? <div className="jc-pending-options">{options.map((option) => <button key={option} type="button" className="jc-chip" disabled={busy} onClick={() => submit(option)}>{option}</button>)}</div> : null}
      <form className="jc-pending-answer" onSubmit={(event) => { event.preventDefault(); submit(answer); }}>
        <input value={answer} placeholder="Type the answer; the copilot remembers it" aria-label="Answer" disabled={busy} onChange={(event) => setAnswer(event.target.value)} />
        <button type="submit" className="jc-button primary" disabled={busy || !answer.trim()}>Answer</button>
      </form>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </section>
  );
}

function RuleCard({ item, paneId, onDone }: { item: FreelancePendingItem; paneId: string; onDone(): void }) {
  const { busy, error, run } = useAction(onDone);
  const rule = item.payload.rule as FreelanceRule;
  return (
    <section className="jc-pending" aria-label="A rule proposal">
      <header><ShieldCheck aria-hidden="true" /> <strong>Rule proposed</strong></header>
      <p><strong>{rule.name}</strong>: the copilot may send {rule.kinds.length ? rule.kinds.map((kind) => kind.toLowerCase().replace("_", "-")).join(", ") : "any message"} on {FREELANCE_CHANNEL_LABELS[rule.channel]} without asking, within the daily cap.</p>
      {rule.evidence.length ? <ul className="mk-evidence">{rule.evidence.map((line) => <li key={line}>{line}</li>)}</ul> : null}
      <div className="jc-actions">
        <button type="button" className="jc-button primary" disabled={busy} onClick={() => void run(() => api.decideFreelanceRule(paneId, rule.id, "approve"))}><Check aria-hidden="true" /> Approve</button>
        <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void run(() => api.decideFreelanceRule(paneId, rule.id, "reject"))}><X aria-hidden="true" /> Decline</button>
      </div>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </section>
  );
}

/** The Activity rail tab: questions, rule proposals and accounts that wait for the operator (clients and reviews live in Leads), then the timeline. */
export function ActivityTab({ paneId, events, pending, onChanged, onOpenLeads, onOpenSetup }: {
  paneId: string;
  events: FreelanceEvent[];
  pending: FreelancePendingItem[];
  onChanged(): void;
  onOpenLeads(): void;
  onOpenSetup(): void;
}) {
  const inLeads = pending.filter((item) => item.kind === "REVIEW" || item.kind === "CLIENT_READY").length;
  return (
    <div className="jc-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      {inLeads ? (
        <section className="jc-pending" aria-label="Clients and messages for you">
          <header><UserCheck aria-hidden="true" /> <strong>{inLeads} client{inLeads === 1 ? "" : "s"} or message{inLeads === 1 ? "" : "s"} wait for you</strong></header>
          <div className="jc-actions"><button type="button" className="jc-button primary" onClick={onOpenLeads}>Open Leads</button></div>
        </section>
      ) : null}
      {pending.map((item) => item.kind === "QUESTION" ? <QuestionCard key={item.id} item={item} paneId={paneId} onDone={onChanged} />
        : item.kind === "RULE" ? <RuleCard key={item.id} item={item} paneId={paneId} onDone={onChanged} />
        : item.kind === "ACCOUNT" ? (
          <section key={item.id} className="jc-pending" aria-label="An account needs you">
            <header><AlertTriangle aria-hidden="true" /> <strong>{FREELANCE_CHANNEL_LABELS[(item.payload.account as FreelanceAccount).channel]} account needs you</strong></header>
            <p>{(item.payload.account as FreelanceAccount).notes ?? item.message}</p>
            <div className="jc-actions"><button type="button" className="jc-button" onClick={onOpenSetup}>Open Setup</button></div>
          </section>
        ) : null)}
      {events.length === 0 ? (
        <div className="jc-empty"><strong>No activity yet</strong><span>Every lead, proposal, client message, question and handoff lands here.</span></div>
      ) : (
        <ol className="jc-timeline" aria-label="Activity">
          {events.map((event) => {
            const Icon = EVENT_ICON[event.type] ?? FileText;
            const url = typeof event.payload.url === "string" ? event.payload.url : null;
            return (
              <li key={event.id} className={`jc-event tone-${EVENT_TONE[event.type] ?? "info"}`}>
                <span className="jc-event-icon" aria-hidden="true"><Icon /></span>
                <div className="jc-event-body">
                  <p>{event.message}</p>
                  <div className="jc-event-meta">
                    {url ? <a className="jc-event-link" href={url} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" /> Open</a> : null}
                    <span className="jc-muted" title={event.createdAt}>{new Date(event.createdAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
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
