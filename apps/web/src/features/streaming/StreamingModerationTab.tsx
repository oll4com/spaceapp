import type { StreamingModerationAction } from "@space/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";

export function StreamingModerationTab() {
  const [actions, setActions] = useState<StreamingModerationAction[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setActions((await api.streamingModerationActions()).actions); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Moderation history could not be loaded."); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  async function undo(id: string) {
    setBusy(id);
    try { await api.undoStreamingModerationAction(id); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The timeout could not be undone."); }
    finally { setBusy(null); }
  }
  return <div className="streaming-bot-tab">
    <section className="streaming-section" aria-labelledby="streaming-moderation-heading">
      <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Chat safety</span><h3 id="streaming-moderation-heading">Moderation</h3></div>
        <button type="button" onClick={() => void refresh()} disabled={busy !== null}>Refresh</button></div>
      <p className="streaming-empty">Warnings and 5 or 30 minute timeouts are separate from bot replies. Pending Discord channels and missing platform permissions stay unavailable.</p>
      {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
      {actions.length === 0 ? <p className="streaming-empty">No moderation actions yet.</p> : <ul className="streaming-bot-activity">
        {actions.map(action => <li key={action.id}>
          <div className="streaming-bot-activity-heading"><strong>{action.platform} · {action.decision}</strong>
            <span className={`streaming-bot-badge ${action.result === "SUCCEEDED" ? "ok" : ""}`}>{action.result}</span>
            <time>{new Date(action.createdAt).toLocaleString()}</time></div>
          <p>Account {action.userId} · {action.reason}{action.durationSeconds ? ` · ${action.durationSeconds / 60} minutes` : ""}</p>
          {action.safeErrorCode ? <small>Platform result: {action.safeErrorCode}</small> : null}
          {action.result === "SUCCEEDED" && action.durationSeconds ? <button type="button" disabled={busy !== null} onClick={() => void undo(action.id)}>Undo timeout</button> : null}
        </li>)}
      </ul>}
    </section>
  </div>;
}
