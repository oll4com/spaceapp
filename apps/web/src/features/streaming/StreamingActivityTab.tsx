import { useCallback, useEffect, useState } from "react";
import type { StreamingBotActivity } from "@space/contracts";
import { api } from "../../api.js";

export function StreamingActivityTab() {
  const [activity, setActivity] = useState<StreamingBotActivity[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setActivity((await api.streamingBotActivity(100)).data); setError(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Streaming activity could not be loaded."); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return <section className="streaming-section" aria-labelledby="streaming-activity-heading">
    <div className="streaming-section-heading">
      <div><span className="streaming-eyebrow">Recent events</span><h3 id="streaming-activity-heading">Activity</h3></div>
      <button type="button" disabled={loading} onClick={() => void refresh()}>Refresh</button>
    </div>
    {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
    {activity.length === 0 ? <p className="streaming-empty">No activity yet. Replies and skipped chat messages appear here.</p> :
      <ul className="streaming-bot-activity">{activity.map(record => <li key={record.id} data-direction={record.direction} data-status={record.status}>
        <span className="streaming-bot-activity-heading">
          <strong>{record.direction === "IN" ? "Viewer" : "Bot"} · {record.platform}</strong>
          <time>{new Date(record.createdAt).toLocaleTimeString()}</time>
          <span className={`streaming-bot-badge ${record.status === "REPLIED" ? "ok" : ""}`}>{record.status}</span>
        </span>
        <p>{record.message}</p>
        {record.reply ? <p className="streaming-bot-activity-reply">→ {record.reply}</p> : null}
      </li>)}</ul>}
  </section>;
}
