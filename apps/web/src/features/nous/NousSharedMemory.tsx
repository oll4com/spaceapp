import { useEffect, useRef, useState } from "react";
import { screenSharedMemory, type SharedMemoryContent, type SharedMemoryEntry, type SharedMemoryPolicy } from "@space/contracts";
import { api } from "../../api.js";
import { DockButton } from "../dock-kit/DockKit.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import "./nous-shared-memory.css";

const empty = (): SharedMemoryContent => ({ title: "", body: "", tags: [] });
export function NousSharedMemory() {
  const [entries, setEntries] = useState<SharedMemoryEntry[] | null>(null);
  const [policy, setPolicy] = useState<SharedMemoryPolicy | null>(null);
  const [editing, setEditing] = useState<SharedMemoryEntry | "new" | null>(null);
  const [draft, setDraft] = useState(empty);
  const [tagText, setTagText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [validation, setValidation] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const title = useRef<HTMLInputElement>(null);
  useEffect(() => {
    let live = true;
    void api.nousSharedMemory().then((result) => { if (live) { setEntries(result.entries); setPolicy(result.policy); } })
      .catch((caught: unknown) => { if (live) setError(caught instanceof Error ? caught.message : "Shared memory could not be loaded."); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  useEffect(() => { if (editing) title.current?.focus(); }, [editing]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Shared memory could not be saved."); }
    finally { setBusy(false); }
  };
  const replace = (entry: SharedMemoryEntry) => setEntries((old) => [...(old ?? []).filter((row) => row.id !== entry.id), entry]);
  const startEdit = (entry: SharedMemoryEntry | "new") => { setEditing(entry); setValidation(null); setError(null); setDraft(entry === "new" ? empty() : { title: entry.title, body: entry.body, tags: entry.tags }); setTagText(entry === "new" ? "" : entry.tags.join(", ")); };
  const check = () => { const result = screenSharedMemory(draft); setValidation(result.ok ? null : result.reason); return result.ok; };
  const changeStatus = (entry: SharedMemoryEntry, status: SharedMemoryEntry["status"]) => void run(async () => replace((await api.updateNousSharedMemory(entry.id, { revision: entry.revision, status })).entry));
  return <section className="nous-shared-memory" aria-label="Shared Nous memory" aria-busy={busy || (!entries && !error)}>
    <div className="nous-shared-memory-heading"><div><h3>Shared memory</h3><p>Generic working knowledge for your team. You review what Nous learns.</p></div>
      <DockButton disabled={busy || !entries || editing !== null} onClick={() => startEdit("new")}>Add entry</DockButton></div>
    {error ? <div><p ref={alert} role="alert" tabIndex={-1}>{error}</p><DockButton disabled={busy} onClick={() => void run(async () => { const result = await api.nousSharedMemory(); setEntries(result.entries); setPolicy(result.policy); setEditing(null); setDeleting(null); setValidation(null); })}>{editing ? "Discard edits and reload" : "Reload entries"}</DockButton></div> : null}
    {!entries && !error ? <p role="status">Loading shared memory…</p> : null}
    {policy ? <>
      <SpaceToggle className="settings-flat-row" label="Daily upgrade" ariaLabel="Daily shared memory upgrade" detail="Once a day, Nous proposes reusable lessons for your team. Private memory stays personal."
        checked={policy.dailyUpgrade} disabled={busy} onChange={(dailyUpgrade) => void run(async () => setPolicy((await api.updateNousSharedMemoryPolicy({ dailyUpgrade })).policy))} />
      <SpaceToggle className="settings-flat-row" label="Auto-approve proposals" ariaLabel="Auto-approve shared memory proposals" detail="Activate screened proposals immediately. Off: you review each proposal first. Privacy checks always apply."
        checked={policy.autoApprove} disabled={busy} onChange={(autoApprove) => void run(async () => setPolicy((await api.updateNousSharedMemoryPolicy({ autoApprove })).policy))} />
    </> : null}
    {editing ? <form className="nous-shared-memory-editor" onSubmit={(event) => { event.preventDefault(); if (!check()) return; void run(async () => {
      const result = editing === "new" ? await api.createNousSharedMemory(draft) : await api.updateNousSharedMemory(editing.id, { ...draft, revision: editing.revision });
      replace(result.entry); setEditing(null);
    }); }}>
      <label>Title<input ref={title} value={draft.title} maxLength={160} required disabled={busy} onChange={(event) => { setValidation(null); setDraft({ ...draft, title: event.target.value }); }} onBlur={check} /></label>
      <label>Memory text<textarea value={draft.body} maxLength={2_000} rows={5} required disabled={busy} aria-invalid={Boolean(validation)} aria-describedby="shared-memory-privacy" onChange={(event) => { setValidation(null); setDraft({ ...draft, body: event.target.value }); }} onBlur={check} /></label>
      <label>Tags, separated by commas<input value={tagText} maxLength={490} disabled={busy} onChange={(event) => { setTagText(event.target.value); setValidation(null); setDraft({ ...draft, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }); }} onBlur={check} /></label>
      <p id="shared-memory-privacy">Use generic wording. Leave out names, contacts, addresses, secrets, money, mail and private business facts.</p>
      {validation ? <p role="alert">{validation}</p> : null}
      <div className="nous-shared-memory-actions"><DockButton type="submit" tone="primary" disabled={busy || Boolean(validation)}>Save entry</DockButton><DockButton disabled={busy} onClick={() => setEditing(null)}>Cancel</DockButton></div>
    </form> : null}
    {entries?.length === 0 ? <p>No entries yet. Add generic working knowledge, or review a proposal after the next daily upgrade.</p> : null}
    <div className="nous-shared-memory-entries">{entries?.map((entry) => <article key={entry.id} aria-label={entry.title}>
      <div className="nous-shared-memory-heading"><h4>{entry.title}</h4><span className="nous-shared-memory-state">{entry.status}</span></div>
      <p className="nous-shared-memory-body">{entry.body}</p><small>{entry.source === "SEED" ? "Included with SpaceApp" : entry.source === "NOUS" ? "Proposed by Nous" : "Added by an administrator"}{entry.tags.length ? ` · ${entry.tags.join(", ")}` : ""}</small>
      <div className="nous-shared-memory-actions">
        {entry.status === "PROPOSED" ? <DockButton tone="primary" disabled={busy} aria-label={`Approve ${entry.title}`} onClick={() => changeStatus(entry, "ACTIVE")}>Approve</DockButton> : null}
        <DockButton disabled={busy || editing !== null} aria-label={`Edit ${entry.title}`} onClick={() => startEdit(entry)}>Edit</DockButton>
        <DockButton disabled={busy} aria-label={`${entry.status === "RETIRED" ? "Restore" : "Retire"} ${entry.title}`} onClick={() => changeStatus(entry, entry.status === "RETIRED" ? "ACTIVE" : "RETIRED")}>{entry.status === "RETIRED" ? "Restore" : "Retire"}</DockButton>
        <DockButton tone="danger" disabled={busy} aria-label={`Delete ${entry.title}`} onClick={() => setDeleting(entry.id)}>Delete</DockButton>
      </div>
      {deleting === entry.id ? <div className="nous-shared-memory-delete"><p>Delete this entry for the whole team? Future upgrades will keep it deleted.</p><div className="nous-shared-memory-actions"><DockButton tone="danger" disabled={busy} onClick={() => void run(async () => { await api.deleteNousSharedMemory(entry.id, entry.revision); setEntries((old) => old!.filter((row) => row.id !== entry.id)); setDeleting(null); })}>Delete entry</DockButton><DockButton disabled={busy} onClick={() => setDeleting(null)}>Keep entry</DockButton></div></div> : null}
    </article>)}</div>
  </section>;
}
