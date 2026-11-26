import { useEffect, useRef, useState } from "react";
import { screenSharedMemory, type SharedMemoryContent, type SharedMemoryEntry, type SharedMemoryPolicy } from "@space/contracts";
import { api } from "../../api.js";
import { DockButton, DockChips, DockSearch } from "../dock-kit/DockKit.js";
import { SettingsLabel } from "../settings/SettingsLabel.js";
import { InfoTip } from "../ui-controls/InfoTip.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiText } from "../ui-language/ui-language.js";
import "./nous-shared-memory.css";

const LABELS: Record<Filter, string> = { ALL: "All", ACTIVE: "Active", PROPOSED: "Proposed", RETIRED: "Retired" };
const empty = (): SharedMemoryContent => ({ title: "", body: "", tags: [] });
type Filter = "ALL" | SharedMemoryEntry["status"];
// Operator 14/11 (nous_msg:dcbab9cf): the entries made Settings a long scroll; Settings shows one row and the entries open in a window.
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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const dialog = useRef<HTMLDialogElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const title = useRef<HTMLInputElement>(null);
  const t = useUiText();
  useEffect(() => {
    let live = true;
    void api.nousSharedMemory().then((result) => { if (live) { setEntries(result.entries); setPolicy(result.policy); } })
      .catch((caught: unknown) => { if (live) setError(caught instanceof Error ? caught.message : "Shared memory could not be loaded."); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (error) alert.current?.focus(); }, [error]);
  useEffect(() => {
    const node = dialog.current;
    if (!open || !node || node.open) return;
    const previous = document.activeElement;
    try { if (typeof node.showModal === "function") node.showModal(); else node.setAttribute("open", ""); } catch { node.setAttribute("open", ""); }
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [open]);
  useEffect(() => { if (editing) title.current?.focus(); }, [editing, open]);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await work(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Shared memory could not be saved."); }
    finally { setBusy(false); }
  };
  const replace = (entry: SharedMemoryEntry) => setEntries((old) => [...(old ?? []).filter((row) => row.id !== entry.id), entry]);
  const startEdit = (entry: SharedMemoryEntry | "new") => { setEditing(entry); setValidation(null); setError(null); setDraft(entry === "new" ? empty() : { title: entry.title, body: entry.body, tags: entry.tags }); setTagText(entry === "new" ? "" : entry.tags.join(", ")); };
  const check = () => { const result = screenSharedMemory(draft); setValidation(result.ok ? null : result.reason); return result.ok; };
  const count = (status: SharedMemoryEntry["status"]) => entries?.filter((entry) => entry.status === status).length ?? 0;
  const words = query.trim().toLocaleLowerCase();
  const shown = (entries ?? []).filter((entry) => (filter === "ALL" || entry.status === filter)
    && (!words || [entry.title, entry.body, ...entry.tags].join(" ").toLocaleLowerCase().includes(words)));
  const errorBlock = error ? <div><p ref={alert} role="alert" tabIndex={-1}>{error}</p><DockButton disabled={busy} onClick={() => void run(async () => { const result = await api.nousSharedMemory(); setEntries(result.entries); setPolicy(result.policy); setEditing(null); setDeleting(null); setValidation(null); })}>{t(editing ? "Discard edits and reload" : "Reload entries")}</DockButton></div> : null;
  const changeStatus = (entry: SharedMemoryEntry, status: SharedMemoryEntry["status"]) => void run(async () => replace((await api.updateNousSharedMemory(entry.id, { revision: entry.revision, status })).entry));
  return <section className="nous-shared-memory" aria-label="Shared Nous memory" aria-busy={busy || (!entries && !error)}>
    <div className="nous-shared-memory-heading"><div><h3>{t("Shared memory")}<InfoTip text={t("Generic working knowledge for your team. You review what Nous learns.")} label={t("About {label}", { label: t("Shared memory") })} /></h3></div></div>
    {open ? null : errorBlock}
    {!entries && !error ? <p role="status">{t("Loading shared memory…")}</p> : null}
    {policy ? <>
      <SpaceToggle className="settings-flat-row" label="Daily upgrade" ariaLabel="Daily shared memory upgrade" help="Once a day, Nous proposes reusable lessons for your team. Private memory stays personal."
        checked={policy.dailyUpgrade} disabled={busy} onChange={(dailyUpgrade) => void run(async () => setPolicy((await api.updateNousSharedMemoryPolicy({ dailyUpgrade })).policy))} />
      <SpaceToggle className="settings-flat-row" label="Auto-approve proposals" ariaLabel="Auto-approve shared memory proposals" help="Activates screened proposals immediately. Off: you review each proposal first. Privacy checks always apply."
        checked={policy.autoApprove} disabled={busy} onChange={(autoApprove) => void run(async () => setPolicy((await api.updateNousSharedMemoryPolicy({ autoApprove })).policy))} />
    </> : null}
    {entries ? <div className="settings-flat-row nous-shared-memory-row" onClick={() => setOpen(true)}>
      <SettingsLabel label="Shared working knowledge" help="The entries every Nous of your team reads. Open the window to review, edit, approve or retire them.">
        {[t("{count} active", { count: count("ACTIVE") }), count("PROPOSED") ? t("{count} to approve", { count: count("PROPOSED") }) : "", count("RETIRED") ? t("{count} retired", { count: count("RETIRED") }) : ""].filter(Boolean).join(" · ")}
      </SettingsLabel>
      <DockButton aria-haspopup="dialog" onClick={(event) => { event.stopPropagation(); setOpen(true); }}>{t("Manage entries…")}</DockButton>
    </div> : null}
    {open ? <dialog ref={dialog} className="nous-shared-memory-dialog" aria-labelledby="nous-shared-memory-title"
      onCancel={(event) => { event.preventDefault(); setOpen(false); }}
      onClick={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="nous-shared-memory-heading"><h3 id="nous-shared-memory-title">{t("Shared working knowledge")}</h3>
        <div className="nous-shared-memory-actions"><DockButton disabled={busy || !entries || editing !== null} onClick={() => startEdit("new")}>{t("Add entry")}</DockButton><DockButton onClick={() => setOpen(false)}>{t("Close")}</DockButton></div></div>
      {errorBlock}
      <div className="nous-shared-memory-filters"><DockSearch value={query} onChange={setQuery} label={t("Search entries")} />
        <DockChips label={t("Show")} value={filter} onChange={setFilter} options={(["ALL", "ACTIVE", "PROPOSED", "RETIRED"] as const).map((id) => ({ id, label: t(LABELS[id]), count: id === "ALL" ? entries?.length ?? 0 : count(id), ...(id === "PROPOSED" && count(id) ? { tone: "attention" as const } : {}) }))} /></div>
      {editing ? <form className="nous-shared-memory-editor" onSubmit={(event) => { event.preventDefault(); if (!check()) return; void run(async () => {
        const result = editing === "new" ? await api.createNousSharedMemory(draft) : await api.updateNousSharedMemory(editing.id, { ...draft, revision: editing.revision });
        replace(result.entry); setEditing(null);
      }); }}>
        <label>{t("Title")}<input ref={title} value={draft.title} maxLength={160} required disabled={busy} onChange={(event) => { setValidation(null); setDraft({ ...draft, title: event.target.value }); }} onBlur={check} /></label>
        <label>{t("Memory text")}<textarea value={draft.body} maxLength={2_000} rows={5} required disabled={busy} aria-invalid={Boolean(validation)} aria-describedby="shared-memory-privacy" onChange={(event) => { setValidation(null); setDraft({ ...draft, body: event.target.value }); }} onBlur={check} /></label>
        <label>{t("Tags, separated by commas")}<input value={tagText} maxLength={490} disabled={busy} onChange={(event) => { setTagText(event.target.value); setValidation(null); setDraft({ ...draft, tags: event.target.value.split(",").map((tag) => tag.trim()).filter(Boolean) }); }} onBlur={check} /></label>
        <p id="shared-memory-privacy">{t("Use generic wording. Leave out names, contacts, addresses, secrets, money, mail and private business facts.")}</p>
        {validation ? <p role="alert">{validation}</p> : null}
        <div className="nous-shared-memory-actions"><DockButton type="submit" tone="primary" disabled={busy || Boolean(validation)}>{t("Save entry")}</DockButton><DockButton disabled={busy} onClick={() => setEditing(null)}>{t("Cancel")}</DockButton></div>
      </form> : null}
      {entries?.length === 0 ? <p>{t("No entries yet. Add generic working knowledge, or review a proposal after the next daily upgrade.")}</p> : entries && !shown.length ? <p>{t("No entries match.")}</p> : null}
      <div className="nous-shared-memory-entries">{shown.map((entry) => <article key={entry.id} aria-label={entry.title}>
        <div className="nous-shared-memory-heading"><h4>{entry.title}</h4><span className="nous-shared-memory-state">{t(LABELS[entry.status])}</span></div>
        <p className="nous-shared-memory-body">{entry.body}</p><small>{t(entry.source === "SEED" ? "Included with SpaceApp" : entry.source === "NOUS" ? "Proposed by Nous" : "Added by an administrator")}{entry.tags.length ? ` · ${entry.tags.join(", ")}` : ""}</small>
        <div className="nous-shared-memory-actions">
          {entry.status === "PROPOSED" ? <DockButton tone="primary" disabled={busy} aria-label={`${t("Approve")} ${entry.title}`} onClick={() => changeStatus(entry, "ACTIVE")}>{t("Approve")}</DockButton> : null}
          <DockButton disabled={busy || editing !== null} aria-label={`${t("Edit")} ${entry.title}`} onClick={() => startEdit(entry)}>{t("Edit")}</DockButton>
          <DockButton disabled={busy} aria-label={`${t(entry.status === "RETIRED" ? "Restore" : "Retire")} ${entry.title}`} onClick={() => changeStatus(entry, entry.status === "RETIRED" ? "ACTIVE" : "RETIRED")}>{t(entry.status === "RETIRED" ? "Restore" : "Retire")}</DockButton>
          <DockButton tone="danger" disabled={busy} aria-label={`${t("Delete")} ${entry.title}`} onClick={() => setDeleting(entry.id)}>{t("Delete")}</DockButton>
        </div>
        {deleting === entry.id ? <div className="nous-shared-memory-delete"><p>{t("Delete this entry for the whole team? Future upgrades will keep it deleted.")}</p><div className="nous-shared-memory-actions"><DockButton tone="danger" disabled={busy} onClick={() => void run(async () => { await api.deleteNousSharedMemory(entry.id, entry.revision); setEntries((old) => old!.filter((row) => row.id !== entry.id)); setDeleting(null); })}>{t("Delete entry")}</DockButton><DockButton disabled={busy} onClick={() => setDeleting(null)}>{t("Keep entry")}</DockButton></div></div> : null}
      </article>)}</div>
    </dialog> : null}
  </section>;
}
