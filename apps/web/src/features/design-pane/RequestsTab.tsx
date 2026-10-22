import { useState } from "react";
import { resolveDesignFormat, type DesignRequest } from "@space/contracts";
import { api } from "../../api.js";

const STATUS_LABEL: Record<DesignRequest["status"], string> = {
  QUEUED: "Queued", TAKEN: "Taken", IN_PROGRESS: "In progress", NEEDS_APPROVAL: "Needs your approval", DELIVERED: "Delivered", FAILED: "Failed", CANCELLED: "Cancelled"
};
const OPEN: readonly DesignRequest["status"][] = ["QUEUED", "TAKEN", "IN_PROGRESS", "NEEDS_APPROVAL"];

/** Requests from other agents and panes: who asked, for what, their state; approve, answer, cancel, or open one in the Studio. */
export function RequestsTab({ paneId, requests, onOpen, onChanged }: { paneId: string; requests: DesignRequest[]; onOpen(request: DesignRequest): void; onChanged(): void }) {
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
  if (!requests.length) return <p className="jc-muted jc-empty" role="tabpanel" id="jc-panel-requests">No design requests yet. Any agent or pane can ask this pane for a graphic with space_design_request.</p>;
  return (
    <div className="dz-requests" role="tabpanel" id="jc-panel-requests" aria-labelledby="jc-tab-requests">
      <ul className="jc-list" aria-label="Design requests">
        {requests.map((request) => {
          const open = OPEN.includes(request.status);
          return (
            <li key={request.id} className="jc-card dz-request" data-status={request.status.toLowerCase()}>
              <div className="jc-row">
                <strong>{request.requester.label}</strong>
                <span className={`jc-pill status-${request.status.toLowerCase()}`}>{STATUS_LABEL[request.status]}</span>
              </div>
              <p className="dz-brief">{request.brief}</p>
              <p className="jc-row-meta">{request.formatIds.map((id) => resolveDesignFormat(id)?.label ?? id).join(", ")} · {new Date(request.createdAt).toLocaleString()}</p>
              {request.message ? <p className="jc-muted">{request.message}</p> : null}
              {request.question && !request.answer ? (
                <form className="jc-pending-answer" onSubmit={(event) => {
                  event.preventDefault();
                  const answer = answers[request.id]?.trim();
                  if (answer) void act(request.id, () => api.answerDesignRequest(paneId, request.id, answer), "Answer sent to the designer.");
                }}>
                  <label className="jc-field"><span>The designer asks: {request.question}</span>
                    <input value={answers[request.id] ?? ""} maxLength={2000} onChange={(event) => setAnswers({ ...answers, [request.id]: event.target.value })} /></label>
                  <button type="submit" className="jc-button" disabled={busy === request.id || !answers[request.id]?.trim()}>Answer</button>
                </form>
              ) : null}
              {open ? (
                <div className="jc-actions">
                  <button type="button" className="jc-button" onClick={() => onOpen(request)}>Open in Studio</button>
                  {request.status === "NEEDS_APPROVAL" ? (
                    <button type="button" className="jc-button primary" disabled={busy === request.id} onClick={() => void act(request.id, () => api.deliverDesignRequest(paneId, request.id), `Delivered to ${request.requester.label}.`)}>Approve and deliver</button>
                  ) : null}
                  <button type="button" className="jc-button ghost danger" disabled={busy === request.id} onClick={() => void act(request.id, () => api.cancelDesignRequest(paneId, request.id), "Request cancelled.")}>Cancel</button>
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
