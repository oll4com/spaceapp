import { useState } from "react";
import { MARKETING_CHANNEL_LABELS, type MarketingCampaign, type MarketingEvent, type MarketingPendingItem, type MarketingRule } from "@space/contracts";
import { api } from "../../api.js";
import { AlertTriangle, Check, CheckCircle2, CircleHelp, ExternalLink, FileText, Pause, Pencil, Play, Rocket, Send, ShieldCheck, Square, X } from "../ui-theme/app-icons.js";

const EVENT_ICON: Partial<Record<MarketingEvent["type"], typeof Check>> = {
  BRIEF: Pencil, POST_DRAFTED: FileText, REVIEW_REQUESTED: CircleHelp, REVIEW_DECIDED: CheckCircle2, PUBLISHING: Send, PUBLISHED: Rocket, PUBLISH_FAILED: AlertTriangle,
  QUESTION: CircleHelp, ANSWERED: Check, NEEDS_USER: CircleHelp, CAMPAIGN_PROPOSED: Rocket, CAMPAIGN_DECIDED: Rocket, RULE_PROPOSED: ShieldCheck, RULE_DECIDED: ShieldCheck, RULE_APPLIED: ShieldCheck,
  RUN_STARTED: Play, RUN_RESUMED: Play, RUN_PAUSED: Pause, RUN_STOPPED: Square
};
const EVENT_TONE: Partial<Record<MarketingEvent["type"], string>> = {
  PUBLISHED: "ok", REVIEW_DECIDED: "ok", CAMPAIGN_DECIDED: "ok", RULE_DECIDED: "ok", QUESTION: "warn", REVIEW_REQUESTED: "warn", NEEDS_USER: "warn", CAMPAIGN_PROPOSED: "warn",
  RULE_PROPOSED: "warn", PUBLISH_FAILED: "bad", BRIEF: "muted"
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

function QuestionCard({ item, paneId, onDone }: { item: MarketingPendingItem; paneId: string; onDone(): void }) {
  const [answer, setAnswer] = useState("");
  const { busy, error, run } = useAction(onDone);
  const options = Array.isArray(item.payload.options) ? item.payload.options.filter((option): option is string => typeof option === "string") : [];
  const submit = (value: string) => { if (value.trim()) void run(() => api.answerMarketingQuestion(paneId, { questionId: item.id, answer: value.trim() })); };
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

function ProposalCard({ item, paneId, onDone }: { item: MarketingPendingItem; paneId: string; onDone(): void }) {
  const { busy, error, run } = useAction(onDone);
  const campaign = item.kind === "CAMPAIGN" ? item.payload.campaign as MarketingCampaign : null;
  const rule = item.kind === "RULE" ? item.payload.rule as MarketingRule : null;
  return (
    <section className="jc-pending" aria-label={campaign ? "A campaign proposal" : "A rule proposal"}>
      <header>{campaign ? <Rocket aria-hidden="true" /> : <ShieldCheck aria-hidden="true" />} <strong>{campaign ? "Campaign proposed" : "Rule proposed"}</strong></header>
      {campaign ? (
        <p><strong>{campaign.name}</strong>{campaign.goal ? ` · ${campaign.goal}` : ""}{campaign.channels.length ? <span className="jc-muted"> · {campaign.channels.map((id) => MARKETING_CHANNEL_LABELS[id]).join(", ")}</span> : null}</p>
      ) : rule ? (
        <>
          <p><strong>{rule.name}</strong>: the copilot may publish {rule.kinds.length ? rule.kinds.map((kind) => kind.toLowerCase().replace("_", " ")).join(", ") : "any post"} on {MARKETING_CHANNEL_LABELS[rule.channel]} without asking, within the channel's limit.</p>
          {rule.evidence.length ? <ul className="mk-evidence">{rule.evidence.map((line) => <li key={line}>{line}</li>)}</ul> : null}
        </>
      ) : null}
      <div className="jc-actions">
        <button type="button" className="jc-button primary" disabled={busy}
          onClick={() => void run(() => campaign ? api.decideMarketingCampaign(paneId, campaign.id, "approve") : api.decideMarketingRule(rule!.id, "approve"))}><Check aria-hidden="true" /> Approve</button>
        <button type="button" className="jc-button ghost danger" disabled={busy}
          onClick={() => void run(() => campaign ? api.decideMarketingCampaign(paneId, campaign.id, "cancel") : api.decideMarketingRule(rule!.id, "reject"))}><X aria-hidden="true" /> Decline</button>
      </div>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </section>
  );
}

/** The Activity rail tab: what waits for the operator (questions, proposals; reviews live in Posts), then the timeline. */
export function ActivityTab({ paneId, events, pending, onChanged, onOpenPosts }: {
  paneId: string;
  events: MarketingEvent[];
  pending: MarketingPendingItem[];
  onChanged(): void;
  onOpenPosts(): void;
}) {
  const reviews = pending.filter((item) => item.kind === "REVIEW").length;
  return (
    <div className="jc-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      {reviews ? (
        <section className="jc-pending" aria-label="Posts to review">
          <header><CircleHelp aria-hidden="true" /> <strong>{reviews} post{reviews === 1 ? "" : "s"} wait for your review</strong></header>
          <div className="jc-actions"><button type="button" className="jc-button primary" onClick={onOpenPosts}>Open Posts</button></div>
        </section>
      ) : null}
      {pending.map((item) => item.kind === "QUESTION" ? <QuestionCard key={item.id} item={item} paneId={paneId} onDone={onChanged} />
        : item.kind === "CAMPAIGN" || item.kind === "RULE" ? <ProposalCard key={item.id} item={item} paneId={paneId} onDone={onChanged} /> : null)}
      {events.length === 0 ? (
        <div className="jc-empty"><strong>No activity yet</strong><span>Ask for something in Posts and press Start. Every draft, question, review and publication lands here.</span></div>
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
                    {url ? <a className="jc-event-link" href={url} target="_blank" rel="noreferrer noopener"><ExternalLink aria-hidden="true" /> Open post</a> : null}
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
