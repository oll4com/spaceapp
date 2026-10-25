import { useCallback, useEffect, useState, type FormEvent } from "react";
import { JOB_APPLY_MEMORY_KINDS, type JobApplyMemory, type JobApplyMemoryKind } from "@space/contracts";
import { api } from "../../api.js";
import { Pencil, Pin, PinOff, Plus, Search, Trash2 } from "../ui-theme/app-icons.js";
import { subscribeJobApplyLiveEvents } from "./live-events.js";
import { relativeTime } from "./QueueTab.js";

const KIND_LABEL: Record<JobApplyMemoryKind, string> = { FACT: "Fact", ANSWER: "Answer", SITE: "Site", COMPANY: "Company", LESSON: "Lesson", PREFERENCE: "Preference" };
const SOURCE_LABEL: Record<JobApplyMemory["source"], string> = { PROFILE: "profile", CV: "CV", USER: "you", AGENT: "copilot" };

function MemoryRow({ memory, onChange, onDelete }: { memory: JobApplyMemory; onChange(memory: JobApplyMemory): void; onDelete(id: string): void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(memory.text);
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); } catch { /* the row keeps its last state */ } finally { setBusy(false); }
  }

  return (
    <li className={`jc-memory${memory.pinned ? " pinned" : ""}`}>
      <div className="jc-memory-head">
        <span className={`jc-tag kind-${memory.kind.toLowerCase()}`}>{KIND_LABEL[memory.kind]}</span>
        {memory.key ? <span className="jc-memory-key">{memory.key}</span> : null}
        {memory.site ? <span className="jc-muted">{memory.site}</span> : null}
        {memory.company ? <span className="jc-muted">{memory.company}</span> : null}
        <span className="jc-memory-actions">
          <button type="button" className="jc-icon-button" title={memory.pinned ? "Unpin" : "Pin (always recalled first)"} aria-label={`${memory.pinned ? "Unpin" : "Pin"} memory`} disabled={busy}
            onClick={() => void run(async () => onChange((await api.updateJobApplyMemory(memory.id, { pinned: !memory.pinned })).memory))}>{memory.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</button>
          <button type="button" className="jc-icon-button" title="Edit" aria-label="Edit memory" disabled={busy} onClick={() => setEditing((open) => !open)}><Pencil aria-hidden="true" /></button>
          <button type="button" className="jc-icon-button" title="Forget" aria-label="Forget memory" disabled={busy}
            onClick={() => void run(async () => { await api.forgetJobApplyMemory(memory.id); onDelete(memory.id); })}><Trash2 aria-hidden="true" /></button>
        </span>
      </div>
      {editing ? (
        <form className="jc-memory-edit" onSubmit={(event) => { event.preventDefault(); void run(async () => { onChange((await api.updateJobApplyMemory(memory.id, { text: text.trim() })).memory); setEditing(false); }); }}>
          <textarea rows={2} value={text} aria-label="Memory text" onChange={(event) => setText(event.target.value)} disabled={busy} />
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>Save</button><button type="button" className="jc-button ghost" onClick={() => { setEditing(false); setText(memory.text); }}>Cancel</button></div>
        </form>
      ) : <p className="jc-memory-text">{memory.text}</p>}
      <div className="jc-memory-meta jc-muted">
        <span>from {SOURCE_LABEL[memory.source]}</span>
        <span>{Math.round(memory.confidence * 100)}% sure</span>
        <span>{memory.uses === 1 ? "used once" : `used ${memory.uses} times`}</span>
        <span title={memory.updatedAt}>{relativeTime(memory.updatedAt)}</span>
      </div>
    </li>
  );
}

export function MemoryTab({ paneId }: { paneId: string }) {
  const [memories, setMemories] = useState<JobApplyMemory[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<JobApplyMemoryKind[]>([]);
  const [loading, setLoading] = useState(true);
  const [teachOpen, setTeachOpen] = useState(false);
  const [teach, setTeach] = useState<{ kind: JobApplyMemoryKind; key: string; text: string }>({ kind: "FACT", key: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.jobApplyMemory({ query: query.trim() || undefined, kinds: kinds.length > 0 ? kinds : undefined, limit: 100 });
      setMemories(response.memories);
      setTotal(response.total);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [kinds, query]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), query ? 250 : 0); return () => window.clearTimeout(timer); }, [load, query]);
  useEffect(() => subscribeJobApplyLiveEvents(paneId, (detail) => {
    const event = detail.payload.event as { type?: string } | undefined;
    if (event?.type === "ANSWERED" || event?.type === "FIELD_FILLED" || event?.type === "REVIEW_DECIDED") void load();
  }), [load, paneId]);

  const submitTeach = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !teach.text.trim()) return;
    setBusy(true);
    setMessage(null);
    api.rememberJobApplyMemory({ kind: teach.kind, text: teach.text.trim(), ...(teach.key.trim() ? { key: teach.key.trim() } : {}), source: "USER", pinned: false })
      .then(() => { setTeach({ kind: teach.kind, key: "", text: "" }); setTeachOpen(false); setMessage("The copilot will remember that."); void load(); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not save."))
      .finally(() => setBusy(false));
  };

  return (
    <div className="jc-memory-tab" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <div className="jc-memory-toolbar">
        <label className="jc-search">
          <Search aria-hidden="true" />
          <input type="search" value={query} placeholder="Search memory" aria-label="Search memory" onChange={(event) => setQuery(event.target.value)} />
        </label>
        <button type="button" className="jc-button primary" aria-expanded={teachOpen} onClick={() => setTeachOpen((open) => !open)}><Plus aria-hidden="true" /> Teach</button>
      </div>
      <div className="jc-chips" role="group" aria-label="Memory kinds">
        {JOB_APPLY_MEMORY_KINDS.map((kind) => (
          <button key={kind} type="button" className={`jc-chip${kinds.includes(kind) ? " selected" : ""}`} aria-pressed={kinds.includes(kind)}
            onClick={() => setKinds((current) => current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind])}>{KIND_LABEL[kind]}</button>
        ))}
        <span className="jc-muted jc-chips-total">{total} total</span>
      </div>
      {teachOpen ? (
        <form className="jc-teach" onSubmit={submitTeach}>
          <div className="jc-form-grid">
            <label className="jc-field"><span>Kind</span>
              <select value={teach.kind} onChange={(event) => setTeach({ ...teach, kind: event.target.value as JobApplyMemoryKind })}>
                {JOB_APPLY_MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}
              </select>
            </label>
            <label className="jc-field"><span>{teach.kind === "ANSWER" ? "Question (required)" : "Key (optional)"}</span><input value={teach.key} onChange={(event) => setTeach({ ...teach, key: event.target.value })} required={teach.kind === "ANSWER"} /></label>
          </div>
          <label className="jc-field"><span>{teach.kind === "ANSWER" ? "Answer" : "What should the copilot remember?"}</span><textarea rows={2} value={teach.text} onChange={(event) => setTeach({ ...teach, text: event.target.value })} required /></label>
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy || !teach.text.trim()}>Remember</button><button type="button" className="jc-button ghost" onClick={() => setTeachOpen(false)}>Cancel</button></div>
        </form>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {loading && memories.length === 0 ? <p className="jc-muted jc-panel-loading" role="status">Loading memory…</p> : null}
      {!loading && memories.length === 0 ? (
        <div className="jc-empty">
          <strong>{total === 0 ? "Nothing remembered yet" : "No memories match"}</strong>
          <span>{total === 0 ? "Answers you give, fields the copilot fills and lessons it learns land here. Teach it something to start." : "Try another search or kind."}</span>
        </div>
      ) : null}
      <ul className="jc-memory-list">
        {memories.map((memory) => (
          <MemoryRow key={memory.id} memory={memory}
            onChange={(updated) => setMemories((current) => current.map((entry) => entry.id === updated.id ? updated : entry))}
            onDelete={(id) => { setMemories((current) => current.filter((entry) => entry.id !== id)); setTotal((count) => Math.max(0, count - 1)); }} />
        ))}
      </ul>
    </div>
  );
}
