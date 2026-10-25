import { useCallback, useEffect, useState, type FormEvent } from "react";
import { FREELANCE_CHANNEL_LABELS, FREELANCE_CHANNELS, FREELANCE_MEMORY_KINDS, type FreelanceChannel, type FreelanceMemory, type FreelanceMemoryKind } from "@space/contracts";
import { api } from "../../api.js";
import { Pencil, Pin, PinOff, Plus, Search, Trash2 } from "../ui-theme/app-icons.js";
import { subscribeFreelanceCopilotLiveEvents } from "./live-events.js";

const KIND_LABEL: Record<FreelanceMemoryKind, string> = { PROFILE: "Profile", FACT: "Fact", CASE_STUDY: "Case study", PRICING: "Pricing", CHANNEL_RULE: "Platform rule", TEMPLATE: "Template", LESSON: "Lesson", PREFERENCE: "Preference", CLIENT: "Client" };
const SOURCE_LABEL: Record<FreelanceMemory["source"], string> = { USER: "you", AGENT: "copilot", LEARNED: "learned from you" };

function MemoryRow({ memory, onChange, onDelete }: { memory: FreelanceMemory; onChange(memory: FreelanceMemory): void; onDelete(id: string): void }) {
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
        <span className="jc-tag">{KIND_LABEL[memory.kind]}</span>
        {memory.channel ? <span className="jc-tag accent">{FREELANCE_CHANNEL_LABELS[memory.channel]}</span> : null}
        {memory.key ? <span className="jc-memory-key">{memory.key}</span> : null}
        <span className="jc-memory-actions">
          <button type="button" className="jc-icon-button" title={memory.pinned ? "Unpin" : "Pin (always recalled first)"} aria-label={`${memory.pinned ? "Unpin" : "Pin"} memory`} disabled={busy}
            onClick={() => void run(async () => onChange((await api.updateFreelanceMemory(memory.id, { pinned: !memory.pinned })).memory))}>{memory.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</button>
          <button type="button" className="jc-icon-button" title="Edit" aria-label="Edit memory" disabled={busy} onClick={() => setEditing((open) => !open)}><Pencil aria-hidden="true" /></button>
          <button type="button" className="jc-icon-button" title="Forget" aria-label="Forget memory" disabled={busy} onClick={() => void run(async () => { await api.forgetFreelanceMemory(memory.id); onDelete(memory.id); })}><Trash2 aria-hidden="true" /></button>
        </span>
      </div>
      {editing ? (
        <form className="jc-memory-edit" onSubmit={(event) => { event.preventDefault(); void run(async () => { onChange((await api.updateFreelanceMemory(memory.id, { text: text.trim() })).memory); setEditing(false); }); }}>
          <textarea rows={2} value={text} aria-label="Memory text" onChange={(event) => setText(event.target.value)} disabled={busy} />
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>Save</button><button type="button" className="jc-button ghost" onClick={() => { setEditing(false); setText(memory.text); }}>Cancel</button></div>
        </form>
      ) : <p className="jc-memory-text">{memory.text}</p>}
      <div className="jc-memory-meta jc-muted">
        <span>from {SOURCE_LABEL[memory.source]}</span>
        <span>{memory.uses === 1 ? "used once" : `used ${memory.uses} times`}</span>
      </div>
    </li>
  );
}

/** The Memory rail tab: the developer's profile, case studies, facts, pricing, each platform's rules, templates, lessons and clients; search, teach, pin, edit, forget. */
export function MemoryTab({ paneId }: { paneId: string }) {
  const [memories, setMemories] = useState<FreelanceMemory[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [teachOpen, setTeachOpen] = useState(false);
  const [teach, setTeach] = useState<{ kind: FreelanceMemoryKind; channel: FreelanceChannel | ""; key: string; text: string }>({ kind: "PROFILE", channel: "", key: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMemories((await api.freelanceMemory({ query: query.trim() || undefined, limit: 100 })).memories);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [query]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), query ? 250 : 0); return () => window.clearTimeout(timer); }, [load, query]);
  useEffect(() => subscribeFreelanceCopilotLiveEvents(paneId, (detail) => {
    const type = detail.payload.type as string | undefined;
    if (type === "ANSWERED" || type === "REVIEW_DECIDED" || type === "NOTE") void load();
  }), [load, paneId]);
  const submitTeach = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !teach.text.trim()) return;
    setBusy(true);
    setMessage(null);
    api.rememberFreelanceMemory({ kind: teach.kind, text: teach.text.trim(), ...(teach.key.trim() ? { key: teach.key.trim() } : {}), ...(teach.channel ? { channel: teach.channel } : {}) })
      .then(() => { setTeach({ ...teach, key: "", text: "" }); setTeachOpen(false); setMessage("The copilot will remember that."); void load(); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not save."))
      .finally(() => setBusy(false));
  };
  return (
    <div className="jc-memory-tab" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <div className="jc-memory-toolbar">
        <label className="jc-search"><Search aria-hidden="true" /><input type="search" value={query} placeholder="Search memory" aria-label="Search memory" onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" className="jc-button primary" aria-expanded={teachOpen} onClick={() => setTeachOpen((open) => !open)}><Plus aria-hidden="true" /> Teach</button>
      </div>
      {teachOpen ? (
        <form className="jc-teach" onSubmit={submitTeach}>
          <div className="jc-form-grid">
            <label className="jc-field"><span>Kind</span>
              <select value={teach.kind} onChange={(event) => setTeach({ ...teach, kind: event.target.value as FreelanceMemoryKind })}>{FREELANCE_MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}</select>
            </label>
            <label className="jc-field"><span>Platform (optional)</span>
              <select value={teach.channel} onChange={(event) => setTeach({ ...teach, channel: event.target.value as FreelanceChannel | "" })}>
                <option value="">Every platform</option>
                {FREELANCE_CHANNELS.map((id) => <option key={id} value={id}>{FREELANCE_CHANNEL_LABELS[id]}</option>)}
              </select>
            </label>
          </div>
          <label className="jc-field"><span>Key (optional: a package, a client, a template name)</span><input value={teach.key} onChange={(event) => setTeach({ ...teach, key: event.target.value })} /></label>
          <label className="jc-field"><span>What should the copilot remember?</span><textarea rows={2} value={teach.text} onChange={(event) => setTeach({ ...teach, text: event.target.value })} required /></label>
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy || !teach.text.trim()}>Remember</button><button type="button" className="jc-button ghost" onClick={() => setTeachOpen(false)}>Cancel</button></div>
        </form>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      {loading && memories.length === 0 ? <p className="jc-muted jc-panel-loading" role="status">Loading memory…</p> : null}
      {!loading && memories.length === 0 ? <div className="jc-empty"><strong>Nothing remembered yet</strong><span>The developer's profile, case studies, prices, each platform's rules and the lessons from your reviews land here. Teach it the profile and the prices to start.</span></div> : null}
      <ul className="jc-memory-list">
        {memories.map((memory) => (
          <MemoryRow key={memory.id} memory={memory} onChange={(updated) => setMemories((current) => current.map((entry) => entry.id === updated.id ? updated : entry))}
            onDelete={(id) => setMemories((current) => current.filter((entry) => entry.id !== id))} />
        ))}
      </ul>
    </div>
  );
}
