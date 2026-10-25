import { useEffect, useState, type FormEvent } from "react";
import type { DotMemory, DotMemoryScope, DotProfile } from "@space/contracts";
import { api } from "../../api.js";

const scopeLabels: Record<DotMemoryScope, string> = { DOT: "This Dot", PROJECT: "Project", SHARED: "Shared with all Dots" };
const filters: Array<{ value: DotMemoryScope | "ALL"; label: string }> = [
  { value: "ALL", label: "All" }, { value: "DOT", label: "This Dot" }, { value: "PROJECT", label: "Projects" }, { value: "SHARED", label: "Shared" }
];
function when(iso: string): string {
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

/** The Dot's own memory: what it remembers, where it came from, and real edits and deletion. */
export function DotMemoryPanel({ dot, roomId, read = api.dotMemories, create = api.createDotMemory, update = api.updateDotMemory, remove = api.deleteDotMemory }: {
  dot: DotProfile; roomId: string | null;
  read?: typeof api.dotMemories; create?: typeof api.createDotMemory; update?: typeof api.updateDotMemory; remove?: typeof api.deleteDotMemory;
}) {
  const [items, setItems] = useState<DotMemory[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const [filter, setFilter] = useState<DotMemoryScope | "ALL">("ALL");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState("");
  const [scope, setScope] = useState<DotMemoryScope>("DOT");
  const [editing, setEditing] = useState<{ memoryId: string; text: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    const timer = window.setTimeout(() => {
      void Promise.resolve().then(() => read(dot.dotId, { scope: filter === "ALL" ? undefined : filter, q: query })).then((result) => {
        if (!current) return;
        if (result.dotId !== dot.dotId) throw Error("Dot memory identity mismatch");
        setItems(result.items.filter((item) => item.dotId === dot.dotId || item.scope === "SHARED")); setFailed(false);
      }).catch(() => { if (current) setFailed(true); });
    }, query ? 250 : 0);
    return () => { current = false; window.clearTimeout(timer); };
  }, [dot.dotId, filter, query, revision, read]);
  async function run(work: () => Promise<unknown>, fallback: string) {
    setBusy(true); setError(null);
    try { await work(); setRevision((value) => value + 1); return true; }
    catch (err) { setError(err instanceof Error ? err.message : fallback); return false; }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    if (await run(() => create(dot.dotId, { text: text.trim(), scope, ...(roomId ? { roomId } : {}) }), "The memory could not be saved.")) {
      setText(""); setAdding(false);
    }
  }
  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing?.text.trim() || busy) return;
    if (await run(() => update(dot.dotId, editing.memoryId, editing.text.trim()), "The memory could not be updated.")) setEditing(null);
  }
  return <section className="dots-memory" aria-label={`${dot.name}'s memory`}>
    <div className="dots-memory-head">
      <h4>{dot.name}'s memory</h4>
      <button type="button" aria-expanded={adding} onClick={() => setAdding((value) => !value)}>{adding ? "Close" : "Add memory"}</button>
    </div>
    <p className="dots-panel-hint">{dot.name} remembers facts and preferences here and sees the most recent ones at the start of each task. Forgetting deletes a memory permanently.</p>
    {adding ? <form className="dots-memory-form" onSubmit={(event) => void submit(event)}>
      <label><span>What should {dot.name} remember?</span>
        <textarea aria-label="Memory text" rows={3} maxLength={4000} value={text} onChange={(event) => setText(event.currentTarget.value)} /></label>
      <div className="dots-memory-scopes" role="group" aria-label="Memory scope">
        {(["DOT", "PROJECT", "SHARED"] as const).map((value) => <button key={value} type="button" aria-pressed={scope === value}
          onClick={() => setScope(value)}>{value === "PROJECT" ? "This room's project" : scopeLabels[value]}</button>)}
      </div>
      <button type="submit" disabled={busy || !text.trim()}>{busy ? "Saving…" : "Save memory"}</button>
    </form> : null}
    <div className="dots-memory-controls">
      <input type="search" aria-label="Search memories" placeholder="Search memories" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
      <div className="dots-memory-filters" role="group" aria-label="Memory filter">
        {filters.map((option) => <button key={option.value} type="button" aria-pressed={filter === option.value}
          onClick={() => setFilter(option.value)}>{option.label}</button>)}
      </div>
    </div>
    {error ? <p role="alert">{error}</p> : null}
    {failed && items === null ? <div role="status"><p>Memory unavailable.</p><button type="button" onClick={() => setRevision((value) => value + 1)}>Retry</button></div>
      : items === null ? <p role="status">Loading memory…</p>
      : !items.length ? <p>{query || filter !== "ALL" ? "No memories match." : "No memories yet."}</p>
      : <ul className="dots-records dots-memory-list">{items.map((memory) => <li key={memory.memoryId}>
        {editing?.memoryId === memory.memoryId ? <form className="dots-memory-form" onSubmit={(event) => void saveEdit(event)}>
          <textarea aria-label="Edit memory" rows={3} maxLength={4000} value={editing.text} onChange={(event) => setEditing({ ...editing, text: event.currentTarget.value })} />
          <div className="dots-memory-actions">
            <button type="submit" disabled={busy || !editing.text.trim()}>Save</button>
            <button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form> : <p className="dots-memory-text">{memory.text}</p>}
        <span>{scopeLabels[memory.scope]}{memory.scope === "PROJECT" && memory.projectKey ? ` · ${memory.projectKey}` : ""} · {memory.source === "USER" ? "Added by you" : `Saved by ${dot.name}`} · {when(memory.updatedAt)}</span>
        {confirming === memory.memoryId ? <div className="dots-memory-actions" role="group" aria-label="Confirm forgetting">
          <span>Forget this memory permanently?</span>
          <button type="button" className="dots-memory-forget" disabled={busy} onClick={() => void run(() => remove(dot.dotId, memory.memoryId), "The memory could not be deleted.").then(() => setConfirming(null))}>Forget</button>
          <button type="button" disabled={busy} onClick={() => setConfirming(null)}>Keep</button>
        </div> : editing?.memoryId === memory.memoryId ? null : <div className="dots-memory-actions">
          <button type="button" disabled={busy} onClick={() => { setConfirming(null); setEditing({ memoryId: memory.memoryId, text: memory.text }); }}>Edit</button>
          <button type="button" disabled={busy} onClick={() => { setEditing(null); setConfirming(memory.memoryId); }}>Forget</button>
        </div>}
      </li>)}</ul>}
  </section>;
}
