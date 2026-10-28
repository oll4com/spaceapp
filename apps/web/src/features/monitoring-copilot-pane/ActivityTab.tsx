import { useState } from "react";
import type { MonitoringAction, MonitoringEvent } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";

const TYPE_LABEL: Record<MonitoringEvent["type"], string> = {
  BRIEF: "Brief", QUESTION: "Question", REVIEW: "Needs your approval", ANSWERED: "Answered", REVIEWED: "Decided", BRIEF_DONE: "Done", BRIEF_FAILED: "Failed",
  ALERT: "Alert", GUARDIAN: "Guardian", NOTE: "Note", DIGEST: "Daily digest", SETTINGS_CHANGED: "Settings", RUN_STARTED: "Run started", RUN_PAUSED: "Run paused", RUN_STOPPED: "Run stopped", ACTION: "Change"
};
const STATUS_LABEL: Record<string, string> = { PENDING: "Waiting", TAKEN: "In progress", DONE: "Done", FAILED: "Failed", OPEN: "Needs you", ANSWERED: "Answered", APPROVED: "Approved", DECLINED: "Declined" };
const ACTION_STATUS: Record<MonitoringAction["status"], string> = { RUNNING: "Running", ASKED: "Waiting for you", APPROVED: "Approved", DECLINED: "Declined", VERIFIED: "Verified", FAILED: "Failed", ROLLED_BACK: "Rolled back" };
const ACTION_KIND: Record<MonitoringAction["kind"], string> = { SERVICE_RESTART: "Service restart", GUEST_START: "Guest start", CONFIG_CHANGE: "Config change", CACHE_CLEAR: "Cache clear",
  HOST_REBOOT: "Host reboot", DATA_DELETE: "Data delete", OTHER: "Other change" };
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Activity: decide held changes, brief the copilot, answer its questions, and follow the alert and guardian timeline and what it did. */
export function ActivityTab({ paneId, events, actions, onChanged }: { paneId: string; events: MonitoringEvent[]; actions: MonitoringAction[]; onChanged(): void }) {
  const [brief, setBrief] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [showGuardian, setShowGuardian] = useState(true);
  const reviews = events.filter((event) => event.type === "REVIEW" && event.status === "OPEN");
  const questions = events.filter((event) => event.type === "QUESTION" && event.status === "OPEN");
  const feed = showGuardian ? events : events.filter((event) => event.type !== "GUARDIAN");

  async function act(id: string, action: () => Promise<unknown>, done: string) {
    if (busy) return false;
    setBusy(id);
    setMessage(null);
    try { await action(); setMessage(done); onChanged(); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); return false; }
    finally { setBusy(null); }
  }
  const answer = (question: MonitoringEvent, value: string) => void act(question.id, () => api.answerMonitoringCopilotQuestion(paneId, question.id, value), "Answer sent to the watch officer.");
  const decide = (review: MonitoringEvent, approve: boolean) => void act(review.id, () => api.decideMonitoringCopilotReview(paneId, review.id, approve, answers[review.id]?.trim() || undefined),
    approve ? "Approved: the watch officer makes the change and checks it after." : "Declined: the change will not be made.");

  return (
    <div className="mc-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      {reviews.map((review) => (
        <section key={review.id} className="jc-card mc-review" aria-label="A change waiting for your approval">
          <strong>{review.message}</strong>
          {text(review.payload.reason) ? <p className="jc-muted">{text(review.payload.reason)}</p> : null}
          <dl className="mc-review-detail">
            <dt>Where</dt><dd>{text(review.payload.target)}</dd>
            <dt>Commands</dt><dd><pre>{text(review.payload.commands)}</pre></dd>
            {text(review.payload.backup) ? <><dt>Backup</dt><dd>{text(review.payload.backup)}</dd></> : null}
            {text(review.payload.rollback) ? <><dt>Rollback</dt><dd>{text(review.payload.rollback)}</dd></> : null}
          </dl>
          <label className="jc-field"><span>Note (optional)</span>
            <input value={answers[review.id] ?? ""} maxLength={1000} placeholder="e.g. Only after 23:00" onChange={(event) => setAnswers({ ...answers, [review.id]: event.target.value })} /></label>
          <div className="jc-actions">
            <button type="button" className="jc-button primary" disabled={busy === review.id} onClick={() => decide(review, true)}>Approve</button>
            <button type="button" className="jc-button" disabled={busy === review.id} onClick={() => decide(review, false)}>Decline</button>
          </div>
        </section>
      ))}
      {questions.map((question) => {
        const options = Array.isArray(question.payload.options) ? question.payload.options.filter((option): option is string => typeof option === "string") : [];
        return (
          <form key={question.id} className="jc-card mc-question" onSubmit={(event) => {
            event.preventDefault();
            const value = answers[question.id]?.trim();
            if (value) answer(question, value);
          }}>
            <strong>The watch officer asks</strong>
            <p>{question.message}</p>
            {options.length ? <div className="jc-actions">{options.map((option) => (
              <button key={option} type="button" className="jc-button" disabled={busy === question.id} onClick={() => answer(question, option)}>{option}</button>
            ))}</div> : null}
            <label className="jc-field"><span>Your answer</span>
              <input value={answers[question.id] ?? ""} maxLength={2000} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} /></label>
            <button type="submit" className="jc-button" disabled={busy === question.id || !answers[question.id]?.trim()}>Answer</button>
          </form>
        );
      })}
      <form className="jc-card mc-brief" onSubmit={(event) => {
        event.preventDefault();
        const value = brief.trim();
        if (value) void act("brief", () => api.createMonitoringCopilotBrief(paneId, value), "Brief sent. The watch officer starts on it at its next free moment.").then((sent) => { if (sent) setBrief(""); });
      }}>
        <label className="jc-field"><span>Ask the Monitoring Copilot to look into something</span>
          <textarea value={brief} rows={3} maxLength={2000} placeholder="e.g. Why is the Thailand path slow since 13:00?" onChange={(event) => setBrief(event.target.value)} /></label>
        <div className="jc-actions">
          <button type="submit" className="jc-button primary" disabled={busy === "brief" || !brief.trim()}>Send brief</button>
          <button type="button" className="jc-button" disabled={busy === "watch"}
            onClick={() => void act("watch", () => api.checkMonitoringCopilotNow(paneId), "Read the collector now; new alerts show in the list.")}>Check now</button>
          <SpaceToggle compact className="jc-toggle" label="Guardian messages" checked={showGuardian} onChange={setShowGuardian} />
        </div>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {actions.length ? (
        <section className="jc-card mc-actions" aria-label="Changes the watch officer made">
          <strong>Changes</strong>
          <ul className="jc-list">
            {actions.slice(0, 10).map((action) => (
              <li key={action.id} className="mc-action" data-status={action.status.toLowerCase()}>
                <div className="jc-row">
                  <span>{ACTION_KIND[action.kind]} on {action.target}</span>
                  <span className={`jc-pill status-${action.status.toLowerCase()}`}>{ACTION_STATUS[action.status]}</span>
                  <span className="jc-row-meta">{new Date(action.startedAt).toLocaleString()}</span>
                </div>
                <p className="mc-feed-text">{action.summary}</p>
                {action.verification ? <p className="jc-muted">{action.verification}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <ul className="jc-list mc-feed" aria-label="Monitoring Copilot activity">
        {feed.map((event) => (
          <li key={event.id} className="mc-feed-item" data-type={event.type.toLowerCase()} data-level={text(event.payload.level).toLowerCase() || undefined}>
            <div className="jc-row">
              <strong>{TYPE_LABEL[event.type]}</strong>
              {event.status ? <span className={`jc-pill status-${event.status.toLowerCase()}`}>{STATUS_LABEL[event.status] ?? event.status}</span> : null}
              <span className="jc-row-meta">{new Date(event.createdAt).toLocaleString()}</span>
            </div>
            <p className="mc-feed-text">{event.message}</p>
            {event.type === "QUESTION" && text(event.payload.answer) ? <p className="jc-muted">Answer{event.payload.answeredBy === "NOUS" ? " (Nous)" : ""}: {text(event.payload.answer)}</p> : null}
            {event.type === "BRIEF" && text(event.payload.result) ? <p className="jc-muted">{text(event.payload.result)}</p> : null}
          </li>
        ))}
      </ul>
      {!feed.length ? <p className="jc-muted jc-empty">Nothing yet. Space reads the collector every minute; send a brief or press Check now.</p> : null}
    </div>
  );
}
