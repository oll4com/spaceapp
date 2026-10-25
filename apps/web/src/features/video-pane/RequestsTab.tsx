import { useState } from "react";
import { resolveVideoFormat, type VideoRequest } from "@space/contracts";
import { api } from "../../api.js";

export const VIDEO_STATUS_LABEL: Record<VideoRequest["status"], string> = {
  QUEUED: "Queued", TAKEN: "Taken", IN_PROGRESS: "In progress", NEEDS_APPROVAL: "Needs your approval", DELIVERED: "Delivered", FAILED: "Failed", CANCELLED: "Cancelled"
};
export const VIDEO_OPEN_STATUSES: readonly VideoRequest["status"][] = ["QUEUED", "TAKEN", "IN_PROGRESS", "NEEDS_APPROVAL"];
export const formatLabels = (formatIds: string[]) => formatIds.map((id) => resolveVideoFormat(id)?.label ?? id).join(", ");

/** Requests from you, other agents and panes: who asked, for what, their state; approve, answer, cancel, or open one in the Studio. */
export function RequestsTab({ paneId, requests, onOpen, onChanged }: { paneId: string; requests: VideoRequest[]; onOpen(request: VideoRequest): void; onChanged(): void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function act(id: string, action: () => Promise<unknown>, done: string) {
    if (busy) return;
    setBusy(id);
    setMessage(null);
    try { await action(); setMessage(done); onChanged(); }
    catch (error) { setMessage(error instanceof Error ? error.message : "The request could not be changed."); }
    finally { setBusy(null); }
  }
  if (!requests.length) return <p className="jc-muted jc-empty" role="tabpanel" id="jc-panel-requests">No video requests yet. Make one in the Studio, or any agent or pane can ask this pane for a video with space_video_request.</p>;
  return (
    <div className="vd-requests" role="tabpanel" id="jc-panel-requests" aria-labelledby="jc-tab-requests">
      <ul className="jc-list" aria-label="Video requests">
        {requests.map((request) => {
          const open = VIDEO_OPEN_STATUSES.includes(request.status);
          return (
            <li key={request.id} className="jc-card vd-request" data-status={request.status.toLowerCase()}>
              <div className="vd-request-head">
                <strong>{request.requester.label}</strong>
                <span className={`jc-pill status-${request.status.toLowerCase()}`}>{VIDEO_STATUS_LABEL[request.status]}</span>
              </div>
              <p className="vd-brief">{request.brief}</p>
              <p className="jc-row-meta">{formatLabels(request.formatIds)} · {request.sources.length} source{request.sources.length === 1 ? "" : "s"} · {new Date(request.createdAt).toLocaleString()}</p>
              {request.message ? <p className="jc-muted">{request.message}</p> : null}
              {request.question && !request.answer ? (
                <form className="jc-pending-answer" onSubmit={(event) => {
                  event.preventDefault();
                  const answer = answers[request.id]?.trim();
                  if (answer) void act(request.id, () => api.answerVideoRequest(paneId, request.id, answer), "Answer sent to the editor.");
                }}>
                  <label className="jc-field"><span>The editor asks: {request.question}</span>
                    <input value={answers[request.id] ?? ""} maxLength={2000} onChange={(event) => setAnswers({ ...answers, [request.id]: event.target.value })} /></label>
                  <button type="submit" className="jc-button" disabled={busy === request.id || !answers[request.id]?.trim()}>Answer</button>
                </form>
              ) : null}
              {open ? (
                <div className="jc-actions">
                  <button type="button" className="jc-button" onClick={() => onOpen(request)}>Open in Studio</button>
                  {request.status === "NEEDS_APPROVAL" ? (
                    <button type="button" className="jc-button primary" disabled={busy === request.id} onClick={() => void act(request.id, () => api.approveVideoRequest(paneId, request.id), `Delivered to ${request.requester.label}.`)}>Approve and deliver</button>
                  ) : null}
                  <button type="button" className="jc-button ghost danger" disabled={busy === request.id} onClick={() => void act(request.id, () => api.cancelVideoRequest(paneId, request.id), "Request cancelled.")}>Cancel</button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {message ? <p className="jc-message" role="status">{message}</p> : null}
    </div>
  );
}
