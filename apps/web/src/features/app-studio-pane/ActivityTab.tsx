import { useState } from "react";
import type { AppStudioEvent } from "@space/contracts";
import { api } from "../../api.js";

const TYPE_LABEL: Record<AppStudioEvent["type"], string> = {
  BRIEF: "Brief", QUESTION: "Question", ANSWERED: "Answered", PREVIEW: "Preview", NOTE: "Note", BRIEF_DONE: "Done", BRIEF_FAILED: "Failed",
  SETTINGS_CHANGED: "Settings", RUN_STARTED: "Run started", RUN_PAUSED: "Run paused", RUN_STOPPED: "Run stopped"
};
/** The brief the "Build APK" button sends (Nous Warm approval 2026-10-23): the agent builds the APK in its own CLI. */
export const BUILD_APK_BRIEF = "Build a debug APK of the app with space_appstudio_build_apk (or /opt/spaceapp/scripts/space-app-studio-build.mjs) and close this brief with its version and size.";
const STATUS_LABEL: Record<string, string> = { PENDING: "Waiting", TAKEN: "In progress", DONE: "Done", FAILED: "Failed", OPEN: "Needs you", ANSWERED: "Answered" };

/** Activity: give the agent a brief, answer its questions, and follow what it did. */
export function ActivityTab({ paneId, events, onChanged }: { paneId: string; events: AppStudioEvent[]; onChanged(): void }) {
  const [brief, setBrief] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const questions = events.filter((event) => event.type === "QUESTION" && event.status === "OPEN");

  async function act(id: string, action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(id);
    setMessage(null);
    try { await action(); setMessage(done); onChanged(); return true; }
    catch (error) { setMessage(error instanceof Error ? error.message : "That did not work."); return false; }
    finally { setBusy(null); }
  }
  const answer = (question: AppStudioEvent, text: string) => void act(question.id, () => api.answerAppStudioQuestion(paneId, question.id, text), "Answer sent to the app builder.");

  return (
    <div className="as-activity" role="tabpanel" id="jc-panel-activity" aria-labelledby="jc-tab-activity">
      <form className="jc-card as-brief" onSubmit={(event) => {
        event.preventDefault();
        const text = brief.trim();
        if (text) void act("brief", () => api.createAppStudioBrief(paneId, text), "Brief sent. The app builder starts on it at its next free moment.").then((sent) => { if (sent) setBrief(""); });
      }}>
        <label className="jc-field"><span>Ask App Studio to build or change something</span>
          <textarea value={brief} rows={3} maxLength={2000} placeholder="e.g. A habit tracker with a home list, an add screen and dark mode" onChange={(event) => setBrief(event.target.value)} /></label>
        <div className="jc-actions">
          <button type="submit" className="jc-button primary" disabled={busy === "brief" || !brief.trim()}>Send brief</button>
          <button type="button" className="jc-button" disabled={busy === "apk"}
            onClick={() => void act("apk", () => api.createAppStudioBrief(paneId, BUILD_APK_BRIEF), "APK build asked for. The app builder starts on it at its next free moment.")}>Build APK</button>
        </div>
      </form>
      {questions.map((question) => {
        const options = Array.isArray(question.payload.options) ? question.payload.options.filter((option): option is string => typeof option === "string") : [];
        return (
          <form key={question.id} className="jc-card as-question" onSubmit={(event) => {
            event.preventDefault();
            const text = answers[question.id]?.trim();
            if (text) answer(question, text);
          }}>
            <strong>The app builder asks</strong>
            <p>{question.message}</p>
            {options.length ? (
              <div className="jc-actions">{options.map((option) => (
                <button key={option} type="button" className="jc-button" disabled={busy === question.id} onClick={() => answer(question, option)}>{option}</button>
              ))}</div>
            ) : null}
            <label className="jc-field"><span>Your answer</span>
              <input value={answers[question.id] ?? ""} maxLength={2000} onChange={(event) => setAnswers({ ...answers, [question.id]: event.target.value })} /></label>
            <button type="submit" className="jc-button" disabled={busy === question.id || !answers[question.id]?.trim()}>Answer</button>
          </form>
        );
      })}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <ul className="jc-list as-feed" aria-label="App Studio activity">
        {events.map((event) => (
          <li key={event.id} className="as-feed-item" data-type={event.type.toLowerCase()}>
            <div className="jc-row">
              <strong>{TYPE_LABEL[event.type]}</strong>
              {event.status ? <span className={`jc-pill status-${event.status.toLowerCase()}`}>{STATUS_LABEL[event.status] ?? event.status}</span> : null}
              <span className="jc-row-meta">{new Date(event.createdAt).toLocaleString()}</span>
            </div>
            <p className="as-feed-text">{event.message}</p>
            {event.type === "QUESTION" && typeof event.payload.answer === "string" ? <p className="jc-muted">Answer{event.payload.answeredBy === "NOUS" ? " (Nous)" : ""}: {event.payload.answer}</p> : null}
            {event.type === "BRIEF" && typeof event.payload.result === "string" ? <p className="jc-muted">{event.payload.result}</p> : null}
            {event.type === "NOTE" && typeof event.payload.downloadPath === "string" && event.payload.downloadPath.startsWith("/api/artifacts/")
              ? <a className="jc-button" href={event.payload.downloadPath} download>Download APK</a> : null}
          </li>
        ))}
      </ul>
      {!events.length ? <p className="jc-muted jc-empty">Nothing yet. Send a brief to start your app.</p> : null}
    </div>
  );
}
