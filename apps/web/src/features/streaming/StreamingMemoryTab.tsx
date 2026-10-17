import type { StreamingBotReviewedMemory } from "@space/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Brain, Check, Pencil, Plus, RefreshCw, Save, Trash2, Undo2 } from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import {
  DockButton,
  DockChips,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  useDockConfirm
} from "../dock-kit/DockKit.js";
import { memorySourceLabel, memoryStatusLabel } from "./streaming-labels.js";

type MemoryStatus = "APPROVED" | "PENDING";

const statusOptions: ReadonlyArray<{ id: MemoryStatus; label: string }> = [
  { id: "APPROVED", label: "Approved" },
  { id: "PENDING", label: "Pending review" }
];

export function StreamingMemoryTab() {
  const { confirm, confirmDialog } = useDockConfirm();
  const [status, setStatus] = useState<MemoryStatus>("APPROVED");
  const [query, setQuery] = useState("");
  const [lists, setLists] = useState<Record<MemoryStatus, StreamingBotReviewedMemory[]>>({ APPROVED: [], PENDING: [] });
  const [hasLoaded, setHasLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const formRef = useRef<HTMLElement | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editing, setEditing] = useState<StreamingBotReviewedMemory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Both lists load together so each chip shows its count and switching chips needs no request.
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [approved, pending] = await Promise.all([
        api.streamingBotMemory("APPROVED", query.trim()),
        api.streamingBotMemory("PENDING", query.trim())
      ]);
      setLists({ APPROVED: approved.entries, PENDING: pending.entries });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Memory could not be loaded.");
    } finally {
      setHasLoaded(true);
      setRefreshing(false);
    }
  }, [query]);

  // Load at once, then wait for typing to pause before searching again.
  const firstLoadRef = useRef(true);
  useEffect(() => {
    if (firstLoadRef.current) {
      firstLoadRef.current = false;
      void refresh();
      return;
    }
    const timer = window.setTimeout(() => void refresh(), 150);
    return () => window.clearTimeout(timer);
  }, [refresh]);

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
    formRef.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }

  function cancelEdit() {
    setEditing(null);
    setTitle("");
    setBody("");
  }

  async function deleteEntry(entry: StreamingBotReviewedMemory) {
    const accepted = await confirm({
      title: "Delete this memory?",
      message: `"${entry.title}" is removed and the bot can no longer use it in replies.`,
      confirmLabel: "Delete"
    });
    if (!accepted) return;
    await act(() => api.deleteStreamingBotMemory(entry.id), "Memory deleted.");
  }

  const isFiltered = Boolean(query.trim());
  const entries = lists[status];
  const chipOptions = statusOptions.map((option) => ({ ...option, count: lists[option.id].length }));

  return (
    <div className="streaming-bot-tab streaming-memory-tab">
      <section className="streaming-section" aria-labelledby="streaming-memory-heading" ref={formRef}>
        <div className="streaming-section-heading"><h3 id="streaming-memory-heading" className="dock-kit-section-title">{editing ? "Edit memory" : "Add memory"}</h3></div>
        <p className="streaming-hint">Only approved entries can inform public replies. Viewer suggestions stay pending until you approve them.</p>
        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {notice ? <DockNotice tone="success" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
        <div className="streaming-bot-field-row">
          <label className="streaming-bot-field"><span>Title</span><input className="dock-kit-field" maxLength={160} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label className="streaming-bot-field"><span>Detail</span><textarea className="dock-kit-field" rows={3} maxLength={10000} value={body} onChange={event => setBody(event.target.value)} /></label>
        </div>
        <div className="dock-kit-editor-footer">
          {editing ? <DockButton tone="ghost" disabled={busy} onClick={cancelEdit}>Cancel edit</DockButton> : null}
          <DockButton tone="primary" icon={editing ? Save : Plus} busy={busy} disabled={busy || !title.trim() || !body.trim()} onClick={() => void act(
            () => editing
              ? api.updateStreamingBotMemory(editing.id, { expectedVersion: editing.version, title: title.trim(), body: body.trim() })
              : api.createStreamingBotMemory({ title: title.trim(), body: body.trim() }),
            editing ? "Memory updated." : "Memory added and approved."
          )}>{editing ? "Save edit" : "Add memory"}</DockButton>
        </div>
      </section>
      <section className="streaming-section" aria-label="Memory entries">
        <div className="streaming-memory-controls">
          <DockChips label="Memory status" options={chipOptions} value={status} onChange={setStatus} />
          <div className="streaming-memory-search">
            <DockSearch label="Search streaming memory" placeholder="Search memory…" value={query} onChange={setQuery} />
            <DockIconButton label="Refresh memory" icon={RefreshCw} busy={refreshing} disabled={busy || refreshing} onClick={() => void refresh()} />
          </div>
        </div>
        {!hasLoaded ? <DockState kind="loading" title="Loading memory…" /> : error && entries.length === 0 ? null : entries.length === 0 ? (
          <DockState
            kind="empty"
            icon={Brain}
            title={isFiltered ? "No memory matches this search." : status === "PENDING" ? "Nothing waits for review" : "No approved memory yet"}
            detail={isFiltered ? "Change the search or the status filter." : status === "PENDING" ? "Facts the bot learns from viewers appear here for review." : "Add a memory above so the bot can use it in replies."}
          />
        ) : (
          <ul className="streaming-bot-memory-results">
            {entries.map(entry => (
              <li key={entry.id} className="dock-kit-card">
                <div className="dock-kit-meta">
                  <span className="dock-kit-card-title">{entry.title}</span>
                  <span className={`dock-kit-badge ${entry.status === "APPROVED" ? "is-success" : "is-warning"}`}>{memoryStatusLabel(entry.status)}</span>
                </div>
                <p>{entry.body}</p>
                <span className="dock-kit-meta-text">{memorySourceLabel(entry.source)} · Updated {new Date(entry.updatedAt).toLocaleString()} · Version {entry.version}</span>
                <div className="dock-kit-card-actions">
                  <DockButton icon={Pencil} disabled={busy} onClick={() => beginEdit(entry)}>Edit</DockButton>
                  {entry.status === "PENDING" ? <DockButton icon={Check} tone="primary" disabled={busy} onClick={() => void act(
                    () => api.updateStreamingBotMemory(entry.id, { expectedVersion: entry.version, status: "APPROVED" }), "Suggestion approved."
                  )}>Approve</DockButton> : (
                    <DockButton icon={Undo2} disabled={busy} title="The bot stops using it until you approve it again" onClick={() => void act(
                      () => api.updateStreamingBotMemory(entry.id, { expectedVersion: entry.version, status: "PENDING" }), "Moved back to review."
                    )}>Move to review</DockButton>
                  )}
                  <DockIconButton label={`Delete ${entry.title}`} icon={Trash2} tone="danger" disabled={busy} onClick={() => void deleteEntry(entry)} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
      {confirmDialog}
    </div>
  );
}
