import type { StreamingBotReviewedMemory } from "@space/contracts";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api.js";

type MemoryStatus = "APPROVED" | "PENDING";

export function StreamingMemoryTab() {
  const [status, setStatus] = useState<MemoryStatus>("APPROVED");
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<StreamingBotReviewedMemory[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<StreamingBotReviewedMemory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await api.streamingBotMemory(status, query.trim());
      setEntries(result.entries);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory could not be loaded.");
    }
  }, [status, query]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function act(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      setEditing(null);
      setTitle("");
      setBody("");
      await refresh();
      setNotice(success);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory could not be changed. Reload and try again.");
    } finally {
      setBusy(false);
    }
  }

  function beginEdit(entry: StreamingBotReviewedMemory) {
    setEditing(entry);
    setTitle(entry.title);
    setBody(entry.body);
    setError(null);
  }

  return (
    <div className="streaming-bot-tab streaming-memory-tab">
      <section className="streaming-section" aria-labelledby="streaming-memory-heading">
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Streaming bot</span><h3 id="streaming-memory-heading">Memory</h3></div></div>
        <p className="streaming-empty">Only approved entries can inform public replies. Viewer suggestions stay pending until you approve them.</p>
        {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
        {notice ? <div className="streaming-message notice" role="status">{notice}</div> : null}
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field"><span>Title</span><input maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label className="streaming-bot-field"><span>Detail</span><textarea rows={3} maxLength={10000} value={body} onChange={event => setBody(event.target.value)} /></label>
        </div>
        <div className="streaming-inline-actions">
          <button type="button" disabled={busy || !title.trim() || !body.trim()} onClick={() => void act(
            () => editing
              ? api.updateStreamingBotMemory(editing.id, { expectedVersion: editing.version, title: title.trim(), body: body.trim() })
              : api.createStreamingBotMemory({ title: title.trim(), body: body.trim() }),
            editing ? "Memory updated." : "Memory added and approved."
          )}>{editing ? "Save edit" : "Add memory"}</button>
          {editing ? <button type="button" disabled={busy} onClick={() => { setEditing(null); setTitle(""); setBody(""); }}>Cancel edit</button> : null}
        </div>
      </section>
      <section className="streaming-section" aria-label="Memory entries">
        <div className="streaming-bot-test-row">
          <select aria-label="Memory status" value={status} onChange={event => setStatus(event.target.value as MemoryStatus)}>
            <option value="APPROVED">Approved</option><option value="PENDING">Pending review</option>
          </select>
          <input aria-label="Search streaming memory" maxLength={200} value={query} onChange={event => setQuery(event.target.value)} placeholder="Search memory…" />
          <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh</button>
        </div>
        {entries.length === 0 ? <p className="streaming-empty">No entries found.</p> : <ul className="streaming-bot-memory-results">
          {entries.map(entry => <li key={entry.id}>
            <div className="streaming-section-heading"><strong>{entry.title}</strong><span className="streaming-bot-badge">{entry.status}</span></div>
            <p>{entry.body}</p>
            <small>{entry.source} · Updated {new Date(entry.updatedAt).toLocaleString()} · Version {entry.version}</small>
            <div className="streaming-inline-actions">
              <button type="button" disabled={busy} onClick={() => beginEdit(entry)}>Edit</button>
              {entry.status === "PENDING" ? <button type="button" disabled={busy} onClick={() => void act(
                () => api.updateStreamingBotMemory(entry.id, { expectedVersion: entry.version, status: "APPROVED" }), "Suggestion approved."
              )}>Approve</button> : null}
              <button type="button" className="danger" disabled={busy} onClick={() => void act(
                () => api.deleteStreamingBotMemory(entry.id), "Memory deleted."
              )}>Delete</button>
            </div>
          </li>)}
        </ul>}
      </section>
    </div>
  );
}
