import { useState } from "react";
import type { SecurityEvent } from "@space/contracts";
import { api } from "../../api.js";

const TYPE_LABEL: Record<SecurityEvent["type"], string> = {
  BRIEF: "Brief", QUESTION: "Question", REVIEW: "Needs your approval", ANSWERED: "Answered", REVIEWED: "Decided", BRIEF_DONE: "Done", BRIEF_FAILED: "Failed",
  FINDINGS: "Findings", ACTION: "Change", NOTE: "Note", DIGEST: "Daily digest", SETTINGS_CHANGED: "Settings", RUN_STARTED: "Run started", RUN_PAUSED: "Run paused", RUN_STOPPED: "Run stopped"
};
const STATUS_LABEL: Record<string, string> = { PENDING: "Waiting", TAKEN: "In progress", DONE: "Done", FAILED: "Failed", OPEN: "Needs you", ANSWERED: "Answered", APPROVED: "Approved", DECLINED: "Declined" };
const text = (value: unknown) => typeof value === "string" ? value : "";

/** Activity: brief the copilot, approve or decline the changes it holds for you, answer its questions, and follow what it did. */
export function ActivityTab({ paneId, events, onChanged }: { paneId: string; events: SecurityEvent[]; onChanged(): void }) {
  const [brief, setBrief] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const reviews = events.filter((event) => event.type === "REVIEW" && event.status === "OPEN");
  const questions = events.filter((event) => event.type === "QUESTION" && event.status === "OPEN");

  async function act(id: string, action: () => Promise<unknown>, done: string) {
    if (busy) return false;
    setBusy(id);
    setMessage(null);
    try { await action(); setMessage(done); onChanged(); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); return false; }
    finally { setBusy(null); }
  }
  const answer = (question: SecurityEvent, value: string) => void act(question.id, () => api.answerSecurityCopilotQuestion(paneId, question.id, value), "Answer sent to the security engineer.");
  const decide = (review: SecurityEvent, approve: boolean) => void act(review.id, () => api.decideSecurityCopilotReview(paneId, review.id, approve, answers[review.id]?.trim() || undefined),
    approve ? "Approved: the security engineer makes the change now." : "Declined: the change will not be made.");

  return (
    <div className="sc-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      {reviews.map((review) => (
        <section key={review.id} className="jc-card sc-review" aria-label="A change waiting for your approval">
          <strong>{review.message}</strong>
          {text(review.payload.reason) ? <p className="jc-muted">{text(review.payload.reason)}</p> : null}
          <dl className="sc-review-detail">
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
          <form key={question.id} className="jc-card sc-question" onSubmit={(event) => {
            event.preventDefault();
            const value = answers[question.id]?.trim();
            if (value) answer(question, value);
          }}>
            <strong>The security engineer asks</strong>
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
      <form className="jc-card sc-brief" onSubmit={(event) => {
        event.preventDefault();
        const value = brief.trim();
        if (value) void act("brief", () => api.createSecurityCopilotBrief(paneId, value), "Brief sent. The security engineer starts on it at its next free moment.").then((sent) => { if (sent) setBrief(""); });
      }}>
        <label className="jc-field"><span>Ask the Security Copilot to check or fix something</span>
          <textarea value={brief} rows={3} maxLength={2000} placeholder="e.g. Check every PHP build for the new OpenSSL advisory" onChange={(event) => setBrief(event.target.value)} /></label>
        <div className="jc-actions">
          <button type="submit" className="jc-button primary" disabled={busy === "brief" || !brief.trim()}>Send brief</button>
          <button type="button" className="jc-button" disabled={busy === "watch"}
            onClick={() => void act("watch", () => api.checkSecurityCopilotNow(paneId), "Checked the feeds now; new findings show in the list.")}>Check now</button>
        </div>
      </form>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list sc-feed" aria-label="Security Copilot activity">
        {events.map((event) => (
          <li key={event.id} className="sc-feed-item" data-type={event.type.toLowerCase()}>
            <div className="jc-row">
              <strong>{TYPE_LABEL[event.type]}</strong>
              {event.status ? <span className={`jc-pill status-${event.status.toLowerCase()}`}>{STATUS_LABEL[event.status] ?? event.status}</span> : null}
              <span className="jc-row-meta">{new Date(event.createdAt).toLocaleString()}</span>
            </div>
            <p className="sc-feed-text">{event.message}</p>
            {event.type === "QUESTION" && text(event.payload.answer) ? <p className="jc-muted">Answer{event.payload.answeredBy === "NOUS" ? " (Nous)" : ""}: {text(event.payload.answer)}</p> : null}
            {event.type === "BRIEF" && text(event.payload.result) ? <p className="jc-muted">{text(event.payload.result)}</p> : null}
          </li>
        ))}
      </ul>
      {!events.length ? <p className="jc-muted jc-empty">Nothing yet. The copilot starts when its agent runs; send a brief or press Check now.</p> : null}
    </div>
  );
}
