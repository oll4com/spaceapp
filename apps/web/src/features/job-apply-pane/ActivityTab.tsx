import { useState } from "react";
import type { JobApplication, JobApplyEvent, JobApplyPendingItem, JobApplyStats } from "@space/contracts";
import { api } from "../../api.js";
import { AlertTriangle, Archive, Camera, Check, CheckCircle2, CircleHelp, FileText, Flame, Pause, Play, Send, Square, Upload, UserCheck, X } from "../ui-theme/app-icons.js";
import { shortDay } from "./CommandBar.js";
import { relativeTime } from "./QueueTab.js";

const EVENT_ICON: Record<JobApplyEvent["type"], typeof Check> = {
  STARTED: Play, STEP: FileText, FIELD_FILLED: FileText, UPLOAD: Upload, SUBMITTED: Send, VERIFIED: CheckCircle2, FAILED: AlertTriangle,
  HANDOFF_REQUESTED: UserCheck, HANDOFF_RESOLVED: UserCheck, QUESTION: CircleHelp, ANSWERED: Check, REVIEW_REQUESTED: CircleHelp, REVIEW_DECIDED: Check,
  NOTE: FileText, SCREENSHOT: Camera, RUN_STARTED: Play, RUN_PAUSED: Pause, RUN_RESUMED: Play, RUN_STOPPED: Square, RUN_FINISHED: Flame, MAIL: Archive
};
const EVENT_TONE: Partial<Record<JobApplyEvent["type"], string>> = {
  VERIFIED: "ok", SUBMITTED: "info", FAILED: "bad", QUESTION: "warn", REVIEW_REQUESTED: "warn", HANDOFF_REQUESTED: "warn", RUN_FINISHED: "ok"
};

/** Mail triage: an email that asks for something stands out like a question; filed mail stays quiet. */
function eventTone(event: JobApplyEvent): string {
  if (event.type === "MAIL") return event.payload.category === "ACTION_NEEDED" ? "warn" : event.payload.category === "REJECTION" ? "bad" : "muted";
  return EVENT_TONE[event.type] ?? "muted";
}

function PendingCard({ item, application, onDone }: { item: JobApplyPendingItem; application: JobApplication | null; onDone(): void }) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const options = Array.isArray(item.payload.options) ? item.payload.options.filter((option): option is string => typeof option === "string") : [];
  const fields = Array.isArray(item.payload.fields) ? item.payload.fields as Array<{ label: string; value: string | null }> : [];
  const applicationId = item.applicationId;

  async function submit(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed.");
      setBusy(false);
    }
  }

  if (!applicationId) return null;
  if (item.kind === "QUESTION") {
    const question = typeof item.payload.question === "string" ? item.payload.question : item.message;
    return (
      <section className="jc-pending" aria-label="The copilot asks">
        <header><CircleHelp aria-hidden="true" /> <strong>The copilot asks</strong>{application ? <span className="jc-muted">{application.company} · {application.role}</span> : null}</header>
        <p>{question}</p>
        {options.length > 0 ? (
          <div className="jc-pending-options">
            {options.map((option) => <button key={option} type="button" className="jc-chip" disabled={busy} onClick={() => void submit(() => api.answerJobApplyQuestion(applicationId, { questionId: item.id, answer: option }))}>{option}</button>)}
          </div>
        ) : null}
        <form className="jc-pending-answer" onSubmit={(event) => { event.preventDefault(); if (answer.trim()) void submit(() => api.answerJobApplyQuestion(applicationId, { questionId: item.id, answer: answer.trim() })); }}>
          <input value={answer} placeholder="Type the answer; the copilot remembers it" aria-label="Answer" onChange={(event) => setAnswer(event.target.value)} disabled={busy} />
          <button type="submit" className="jc-button primary" disabled={busy || !answer.trim()}>Answer</button>
        </form>
        {error ? <p className="jc-message" role="alert">{error}</p> : null}
      </section>
    );
  }
  return (
    <section className="jc-pending" aria-label="Review before submit">
      <header><CircleHelp aria-hidden="true" /> <strong>Review before submit</strong>{application ? <span className="jc-muted">{application.company} · {application.role}</span> : null}</header>
      {typeof item.payload.note === "string" && item.payload.note ? <p className="jc-muted">{item.payload.note}</p> : null}
      <div className="jc-review-fields">
        {fields.map((field) => (
          <label key={field.label} className="jc-field">
            <span>{field.label}</span>
            <input value={edits[field.label] ?? field.value ?? ""} aria-label={field.label} disabled={busy} onChange={(event) => setEdits({ ...edits, [field.label]: event.target.value })} />
          </label>
        ))}
      </div>
      <div className="jc-actions">
        <button type="button" className="jc-button primary" disabled={busy} onClick={() => {
          const changed = Object.entries(edits).filter(([label, value]) => value !== (fields.find((field) => field.label === label)?.value ?? "")).map(([label, value]) => ({ label, value }));
          void submit(() => api.decideJobApplyReview(applicationId, changed.length > 0 ? { reviewId: item.id, decision: "edit", edits: changed } : { reviewId: item.id, decision: "approve" }));
        }}><Check aria-hidden="true" /> {Object.keys(edits).length > 0 ? "Apply edits and submit" : "Approve and submit"}</button>
        <button type="button" className="jc-button ghost danger" disabled={busy} onClick={() => void submit(() => api.decideJobApplyReview(applicationId, { reviewId: item.id, decision: "reject" }))}><X aria-hidden="true" /> Reject</button>
      </div>
      {error ? <p className="jc-message" role="alert">{error}</p> : null}
    </section>
  );
}

/** The whole picture: totals since the first day (or the last reset), per day, and the earlier history apart. */
function OverviewCard({ stats }: { stats: JobApplyStats }) {
  const activeDays = stats.days.filter((day) => day.applied > 0).length;
  const { imported, archived } = stats.earlier;
  return (
    <section className="jc-card jc-overview" aria-label="Overview">
      <header className="jc-overview-head">
        <strong>Overview</strong>
        <span className="jc-muted">{stats.firstDay ? `Since ${shortDay(stats.firstDay)} · ${activeDays} active day${activeDays === 1 ? "" : "s"}` : "No applications yet"}</span>
      </header>
      <div className="jc-overview-totals">
        <span className="jc-counter"><strong>{stats.totals.applied}</strong> applied</span>
        <span className="jc-counter ok"><strong>{stats.totals.verified}</strong> verified</span>
        {stats.totals.failed ? <span className="jc-counter bad"><strong>{stats.totals.failed}</strong> failed</span> : null}
        <span className="jc-counter">Today <strong>{stats.today.applied}</strong></span>
      </div>
      {stats.days.length > 0 ? (
        <details className="jc-overview-days" open>
          <summary>Per day</summary>
          <table>
            <thead><tr><th scope="col">Day</th><th scope="col">Applied</th><th scope="col">Verified</th><th scope="col">Failed</th></tr></thead>
            <tbody>
              {stats.days.map((day) => (
                <tr key={day.day}><th scope="row">{shortDay(day.day)}</th><td>{day.applied}</td><td>{day.verified}</td><td>{day.failed}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      {archived.sent || archived.failed ? <p className="jc-muted">Archived (before the last reset): {archived.sent} sent · {archived.failed} failed</p> : null}
      {imported.sent || imported.failed ? <p className="jc-muted">Earlier campaign (imported): {imported.sent} sent · {imported.failed} failed</p> : null}
    </section>
  );
}

export function ActivityTab({ events, pending, applications, stats = null, selectedId, onSelect, onChanged }: {
  events: JobApplyEvent[];
  pending: JobApplyPendingItem[];
  applications: JobApplication[];
  stats?: JobApplyStats | null;
  selectedId: string | null;
  onSelect(id: string | null): void;
  onChanged(): void;
}) {
  const byId = new Map(applications.map((application) => [application.id, application]));
  const visible = selectedId ? events.filter((event) => event.applicationId === selectedId) : events;
  return (
    <div className="jc-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      {stats && !selectedId ? <OverviewCard stats={stats} /> : null}
      {pending.map((item) => <PendingCard key={item.id} item={item} application={item.applicationId ? byId.get(item.applicationId) ?? null : null} onDone={onChanged} />)}
      {selectedId ? (
        <div className="jc-activity-filter">
          <span>Showing {byId.get(selectedId)?.company ?? "one application"}</span>
          <button type="button" className="jc-chip" onClick={() => onSelect(null)}>Show all</button>
        </div>
      ) : null}
      {visible.length === 0 ? (
        <div className="jc-empty">
          <strong>No activity yet</strong>
          <span>Queue postings and press Start. Every step, field, upload, screenshot and question lands here as the copilot works.</span>
        </div>
      ) : (
        <ol className="jc-timeline" aria-label="Activity">
          {visible.map((event) => {
            const Icon = EVENT_ICON[event.type];
            const application = event.applicationId ? byId.get(event.applicationId) : null;
            return (
              <li key={event.id} className={`jc-event tone-${eventTone(event)}`}>
                <span className="jc-event-icon" aria-hidden="true"><Icon /></span>
                <div className="jc-event-body">
                  <p>{event.message}</p>
                  <div className="jc-event-meta">
                    {application ? <button type="button" className="jc-event-link" onClick={() => onSelect(application.id)}>{application.company}</button> : null}
                    <span className="jc-muted" title={event.createdAt}>{relativeTime(event.createdAt)}</span>
                  </div>
                  {event.artifactId ? (
                    <a className="jc-event-shot" href={api.agentFileDownloadUrl(event.artifactId)} target="_blank" rel="noopener noreferrer">
                      <img src={api.agentFilePreviewUrl(event.artifactId)} alt={`Screenshot: ${event.message}`} loading="lazy" />
                    </a>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
