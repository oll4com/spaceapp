import { useCallback, useEffect, useState, type FormEvent } from "react";
import { MAIL_COPILOT_MEMORY_KINDS, type MailCopilotMemory, type MailCopilotMemoryKind, type MailHabitSender } from "@space/contracts";
import { api } from "../../api.js";
import { Pencil, Pin, PinOff, Plus, Search, Trash2 } from "../ui-theme/app-icons.js";
import { mailTime } from "./MailClient.js";
import { subscribeMailCopilotLiveEvents } from "./live-events.js";

const KIND_LABEL: Record<MailCopilotMemoryKind, string> = { CONTACT: "Contact", STYLE: "Style", TEMPLATE: "Template", FACT: "Fact", LESSON: "Lesson", PREFERENCE: "Preference" };
const SOURCE_LABEL: Record<MailCopilotMemory["source"], string> = { USER: "you", AGENT: "copilot", LEARNED: "learned from you" };

function MemoryRow({ memory, onChange, onDelete }: { memory: MailCopilotMemory; onChange(memory: MailCopilotMemory): void; onDelete(id: string): void }) {
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
        {memory.contactEmail ? <span className="jc-muted">{memory.contactEmail}</span> : memory.domain ? <span className="jc-muted">{memory.domain}</span> : null}
        <span className="jc-memory-actions">
          <button type="button" className="jc-icon-button" title={memory.pinned ? "Unpin" : "Pin (always recalled first)"} aria-label={`${memory.pinned ? "Unpin" : "Pin"} memory`} disabled={busy}
            onClick={() => void run(async () => onChange((await api.updateMailMemory(memory.id, { pinned: !memory.pinned })).memory))}>{memory.pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}</button>
          <button type="button" className="jc-icon-button" title="Edit" aria-label="Edit memory" disabled={busy} onClick={() => setEditing((open) => !open)}><Pencil aria-hidden="true" /></button>
          <button type="button" className="jc-icon-button" title="Forget" aria-label="Forget memory" disabled={busy} onClick={() => void run(async () => { await api.forgetMailMemory(memory.id); onDelete(memory.id); })}><Trash2 aria-hidden="true" /></button>
        </span>
      </div>
      {editing ? (
        <form className="jc-memory-edit" onSubmit={(event) => { event.preventDefault(); void run(async () => { onChange((await api.updateMailMemory(memory.id, { text: text.trim() })).memory); setEditing(false); }); }}>
          <textarea rows={2} value={text} aria-label="Memory text" onChange={(event) => setText(event.target.value)} disabled={busy} />
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy || !text.trim()}>Save</button><button type="button" className="jc-button ghost" onClick={() => { setEditing(false); setText(memory.text); }}>Cancel</button></div>
        </form>
      ) : <p className="jc-memory-text">{memory.text}</p>}
      <div className="jc-memory-meta jc-muted">
        <span>from {SOURCE_LABEL[memory.source]}</span>
        <span>{Math.round(memory.confidence * 100)}% sure</span>
        <span>{memory.uses === 1 ? "used once" : `used ${memory.uses} times`}</span>
        <span title={memory.updatedAt}>{mailTime(memory.updatedAt)}</span>
      </div>
    </li>
  );
}

/** What the copilot learned from the operator's own actions, per account: each sender's habit, with Forget. */
function LearnedHabits({ paneId }: { paneId: string }) {
  const [habits, setHabits] = useState<MailHabitSender[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setHabits((await api.mailHabits(paneId)).habits); } catch { setHabits([]); }
  }, [paneId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => subscribeMailCopilotLiveEvents(paneId, (detail) => {
    const type = detail.payload.type as string | undefined;
    if (type === "RULE_LEARNED" || type === "RULE_RETIRED" || type === "MAIL_RECEIVED") void load();
  }), [load, paneId]);
  async function forget(habit: MailHabitSender) {
    const key = `${habit.account}|${habit.sender}`;
    if (busy) return;
    setBusy(key);
    try {
      await api.forgetMailHabits(paneId, habit.account, habit.sender);
      setHabits((current) => (current ?? []).filter((entry) => `${entry.account}|${entry.sender}` !== key));
    } catch { /* the row stays */ } finally { setBusy(null); }
  }
  if (!habits?.length) return null;
  const accounts = [...new Set(habits.map((habit) => habit.account))];
  return (
    <section className="mc-habits" aria-label="Learned habits">
      <h3>Learned habits</h3>
      <p className="jc-muted">What you do to mail, in this pane and in Gmail itself, per account. The copilot follows these; three consistent times make a rule.</p>
      {accounts.map((account) => (
        <div key={account} className="mc-habits-account">
          <strong>{account}</strong>
          <ul className="jc-memory-list">
            {habits.filter((habit) => habit.account === account).map((habit) => (
              <li key={habit.sender} className="jc-memory">
                <div className="jc-memory-head">
                  <span className="jc-memory-key">{habit.sender}</span>
                  <span className="jc-memory-actions">
                    <button type="button" className="jc-icon-button" title="Forget this sender's habit" aria-label={`Forget the habit for ${habit.sender} on ${account}`} disabled={busy !== null}
                      onClick={() => void forget(habit)}><Trash2 aria-hidden="true" /></button>
                  </span>
                </div>
                <p className="jc-memory-text">{habit.summary}</p>
                <div className="jc-memory-meta jc-muted"><span title={habit.lastAt}>last {mailTime(habit.lastAt)}</span></div>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** The Memory rail tab: what the copilot knows about how the operator handles mail; search, filter, teach, pin, edit, forget. */
export function MemoryTab({ paneId }: { paneId: string }) {
  const [memories, setMemories] = useState<MailCopilotMemory[]>([]);
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<MailCopilotMemoryKind[]>([]);
  const [loading, setLoading] = useState(true);
  const [teachOpen, setTeachOpen] = useState(false);
  const [teach, setTeach] = useState<{ kind: MailCopilotMemoryKind; key: string; text: string }>({ kind: "PREFERENCE", key: "", text: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMemories((await api.mailMemory({ query: query.trim() || undefined, kinds: kinds.length ? kinds : undefined, limit: 100 })).memories);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [kinds, query]);
  useEffect(() => { const timer = window.setTimeout(() => void load(), query ? 250 : 0); return () => window.clearTimeout(timer); }, [load, query]);
  useEffect(() => subscribeMailCopilotLiveEvents(paneId, (detail) => {
    const type = detail.payload.type as string | undefined;
    if (type === "ANSWERED" || type === "REVIEW_DECIDED" || type === "TRIAGED" || type === "REPLIED") void load();
  }), [load, paneId]);
  const submitTeach = (event: FormEvent) => {
    event.preventDefault();
    if (busy || !teach.text.trim()) return;
    setBusy(true);
    setMessage(null);
    api.rememberMailMemory({ kind: teach.kind, text: teach.text.trim(), ...(teach.key.trim() ? { key: teach.key.trim() } : {}), source: "USER", pinned: false, confidence: 0.9, tags: [] })
      .then(() => { setTeach({ kind: teach.kind, key: "", text: "" }); setTeachOpen(false); setMessage("The copilot will remember that."); void load(); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Could not save."))
      .finally(() => setBusy(false));
  };
  return (
    <div className="jc-memory-tab" role="tabpanel" id="jc-panel-memory" aria-labelledby="jc-tab-memory">
      <div className="jc-memory-toolbar">
        <label className="jc-search"><Search aria-hidden="true" /><input type="search" value={query} placeholder="Search memory" aria-label="Search memory" onChange={(event) => setQuery(event.target.value)} /></label>
        <button type="button" className="jc-button primary" aria-expanded={teachOpen} onClick={() => setTeachOpen((open) => !open)}><Plus aria-hidden="true" /> Teach</button>
      </div>
      <div className="jc-chips" role="group" aria-label="Memory kinds">
        {MAIL_COPILOT_MEMORY_KINDS.map((kind) => (
          <button key={kind} type="button" className={`jc-chip${kinds.includes(kind) ? " selected" : ""}`} aria-pressed={kinds.includes(kind)}
            onClick={() => setKinds((current) => current.includes(kind) ? current.filter((entry) => entry !== kind) : [...current, kind])}>{KIND_LABEL[kind]}</button>
        ))}
      </div>
      {teachOpen ? (
        <form className="jc-teach" onSubmit={submitTeach}>
          <div className="jc-form-grid">
            <label className="jc-field"><span>Kind</span>
              <select value={teach.kind} onChange={(event) => setTeach({ ...teach, kind: event.target.value as MailCopilotMemoryKind })}>{MAIL_COPILOT_MEMORY_KINDS.map((kind) => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}</select>
            </label>
            <label className="jc-field"><span>Key (optional: a sender, a domain, a template name)</span><input value={teach.key} onChange={(event) => setTeach({ ...teach, key: event.target.value })} /></label>
          </div>
          <label className="jc-field"><span>What should the copilot remember?</span><textarea rows={2} value={teach.text} onChange={(event) => setTeach({ ...teach, text: event.target.value })} required /></label>
          <div className="jc-actions"><button type="submit" className="jc-button primary" disabled={busy || !teach.text.trim()}>Remember</button><button type="button" className="jc-button ghost" onClick={() => setTeachOpen(false)}>Cancel</button></div>
        </form>
      ) : null}
      {message ? <p className="jc-message" role="status">{message}</p> : null}
      <LearnedHabits paneId={paneId} />
      {loading && memories.length === 0 ? <p className="jc-muted jc-panel-loading" role="status">Loading memory…</p> : null}
      {!loading && memories.length === 0 ? <div className="jc-empty"><strong>Nothing remembered yet</strong><span>How you write, who people are and the replies you keep sending land here as the copilot learns. Teach it something to start.</span></div> : null}
      <ul className="jc-memory-list">
        {memories.map((memory) => (
          <MemoryRow key={memory.id} memory={memory} onChange={(updated) => setMemories((current) => current.map((entry) => entry.id === updated.id ? updated : entry))}
            onDelete={(id) => setMemories((current) => current.filter((entry) => entry.id !== id))} />
        ))}
      </ul>
    </div>
  );
}
