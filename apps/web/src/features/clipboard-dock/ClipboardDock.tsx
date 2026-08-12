import {
  CheckCircle2,
  Clipboard,
  Copy,
  GripVertical,
  Maximize2,
  Minimize2,
  Plus,
  Trash2,
  X
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ClipboardItem, ClipboardSource } from "@space/contracts";
import { clipboardTextMaxCharacters } from "@space/contracts";
import { api } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  SPACE_CLIPBOARD_ITEM_MIME,
  SPACE_CLIPBOARD_ITEM_TITLE_MIME,
  SPACE_CLIPBOARD_UPDATED_EVENT,
  captureClipboardText,
  clipboardCharacterCount,
  notifyClipboardUpdated
} from "./clipboard-events.js";

interface ClipboardDockProps {
  canInsert: boolean;
  activePaneLabel: string | null;
  onInsert: (item: ClipboardItem) => void;
}

type SourceFilter = "ALL" | "COPY" | "PASTE" | "NOTES" | "PLANS";

const sourceFilters: Array<{ id: SourceFilter; label: string }> = [
  { id: "ALL", label: "All" },
  { id: "COPY", label: "Copy" },
  { id: "PASTE", label: "Paste" },
  { id: "NOTES", label: "Notes" },
  { id: "PLANS", label: "Plans" }
];

function sourceLabel(source: ClipboardSource): string {
  if (source === "MANUAL_NOTE") return "NOTE";
  if (source === "PLAN") return "PLAN";
  return source.replace("_", " ");
}

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function ClipboardDock({ canInsert, activePaneLabel, onInsert }: ClipboardDockProps) {
  const runtime = getSpaceRuntime();
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>("ALL");
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [manualText, setManualText] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const noteCharacters = clipboardCharacterCount(manualText);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.clipboardItems({
        ...(search.trim() ? { q: search.trim() } : {}),
        ...(sourceFilter === "COPY" || sourceFilter === "PASTE" || sourceFilter === "PLANS"
          ? { source: sourceFilter === "PLANS" ? "PLAN" : sourceFilter }
          : {}),
        includeCompleted: showCompleted,
        page: 1,
        pageSize: 100
      });
      const visible = sourceFilter === "NOTES"
        ? payload.data.filter((item) => item.source === "MANUAL_NOTE" || item.source === "AGENT_NOTE")
        : payload.data;
      setItems(visible);
      setTotalItems(sourceFilter === "NOTES" ? visible.length : payload.pagination.totalItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clipboard history could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [search, sourceFilter, showCompleted]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 150);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  useEffect(() => {
    const refresh = () => void loadItems();
    const poll = window.setInterval(refresh, 5_000);
    window.addEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, refresh);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, refresh);
    };
  }, [loadItems]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFullscreen]);

  const summary = useMemo(
    () => `${totalItems} text clip${totalItems === 1 ? "" : "s"} and plan${totalItems === 1 ? "" : "s"} · Private · Space-wide · 100 max`,
    [totalItems]
  );

  async function copyItem(item: ClipboardItem) {
    try {
      if (!runtime.platform.clipboard) throw new DOMException("Clipboard access is unavailable.", "NotSupportedError");
      await runtime.platform.clipboard.writeText(item.text);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((current) => (current === item.id ? null : current)), 1_500);
      await captureClipboardText({
        text: item.text,
        source: "COPY",
        roomId: item.roomId,
        paneId: item.paneId,
        paneTitle: item.paneTitle
      });
    } catch {
      setError("Clipboard access was unavailable. Select the text and copy it manually.");
    }
  }

  async function saveManualNote() {
    if (!manualText.trim() || noteCharacters > clipboardTextMaxCharacters) return;
    try {
      await api.createClipboardItem({ text: manualText, source: "MANUAL_NOTE" });
      setManualText("");
      setIsAdding(false);
      notifyClipboardUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The note could not be saved.");
    }
  }

  async function deleteItem(item: ClipboardItem) {
    try {
      await api.deleteClipboardItem(item.id);
      notifyClipboardUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The clip could not be deleted.");
    }
  }

  async function toggleCompleted(item: ClipboardItem) {
    try {
      await api.setClipboardItemCompleted(item.id, !item.isCompleted);
      notifyClipboardUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The plan could not be updated.");
    }
  }

  async function clearAll() {
    if (!window.confirm("Clear all clipboard history for your account?")) return;
    try {
      await api.clearClipboardItems();
      notifyClipboardUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clipboard history could not be cleared.");
    }
  }

  return (
    <section
      className={`clipboard-dock-shell${isFullscreen ? " is-fullscreen" : ""}`}
      aria-label="Clipboard history"
    >
      <div className="clipboard-dock">
        <header className="clipboard-dock-head">
          <h2><Clipboard aria-hidden="true" /> Clipboard</h2>
          <div className="clipboard-dock-actions">
            <button className="icon-action" onClick={() => setIsFullscreen((value) => !value)}
              aria-label={isFullscreen ? "Close clipboard fullscreen" : "Open clipboard fullscreen"}
              aria-pressed={isFullscreen}>
              {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button className="icon-action" onClick={() => setIsAdding(true)} aria-label="Add clipboard note" aria-expanded={isAdding}>
              <Plus aria-hidden="true" />
            </button>
            <button className="icon-action" onClick={() => void clearAll()}
              aria-label="Clear all clipboard items"><Trash2 aria-hidden="true" /></button>
          </div>
        </header>

        <p className="clipboard-summary">{summary}</p>
        <div className="clipboard-controls">
          <input type="search" name="clipboard-search" aria-label="Search clips" placeholder="Search clips…" value={search}
            onChange={(event) => setSearch(event.currentTarget.value)} />
          <div className="clipboard-filters" aria-label="Clipboard sources">
            {sourceFilters.map((filter) => (
              <button key={filter.id} className={sourceFilter === filter.id ? "active" : ""}
                aria-pressed={sourceFilter === filter.id} onClick={() => setSourceFilter(filter.id)}>
                {filter.label}
              </button>
            ))}
            <button className={showCompleted ? "active" : ""} aria-pressed={showCompleted}
              onClick={() => setShowCompleted((value) => !value)} aria-label="Show completed plans">
              Completed
            </button>
          </div>
        </div>

        {isAdding ? (
          <div className="clipboard-note-editor">
            <textarea autoFocus aria-label="Manual clipboard note" value={manualText}
              onChange={(event) => setManualText(event.currentTarget.value)} maxLength={clipboardTextMaxCharacters + 1} />
            <div>
              <span className={noteCharacters > clipboardTextMaxCharacters ? "bad" : ""}>
                {noteCharacters.toLocaleString()} / {clipboardTextMaxCharacters.toLocaleString()}
              </span>
              <button onClick={() => { setManualText(""); setIsAdding(false); }} aria-label="Cancel note"><X aria-hidden="true" /> Cancel</button>
              <button onClick={() => void saveManualNote()} disabled={!manualText.trim() || noteCharacters > clipboardTextMaxCharacters}
                aria-label="Save note">Save</button>
            </div>
          </div>
        ) : null}

        {error ? <div className="banner bad">{error}</div> : null}
        <div className="clipboard-list" role="list" aria-label="Clipboard items">
          {items.map((item) => {
            const expanded = expandedIds.has(item.id);
            const isLong = item.characterCount > 360;
            return (
              <article className={`clipboard-card${item.source === "PLAN" ? " is-plan" : ""}${item.isCompleted ? " is-completed" : ""}`} role="listitem" key={item.id}>
                <div className="clipboard-card-meta">
                  <strong className={item.source === "PLAN" ? "clipboard-source-plan" : undefined}>{sourceLabel(item.source)}</strong>
                  {item.isCompleted ? <small className="clipboard-status-completed">Completed</small> : null}
                  <span>{item.paneTitle ?? "Space"} · {timeLabel(item.lastUsedAt)}</span>
                  {item.occurrenceCount > 1 ? <small>Used {item.occurrenceCount} times</small> : null}
                </div>
                {item.title ? <div className="clipboard-card-title">{item.title}</div> : null}
                <button className={`clipboard-card-text${expanded ? " expanded" : ""}`} onClick={() => void copyItem(item)}
                  aria-label="Copy clip text">{item.text}</button>
                {copiedId === item.id ? (
                  <span className="clipboard-copied" role="status">{runtime.kind === "demo" ? DEMO_LOCAL_REPLY : "Copied"}</span>
                ) : null}
                {isLong ? <button className="clipboard-expand" onClick={() => setExpandedIds((current) => {
                  const next = new Set(current);
                  if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
                  return next;
                })}>{expanded ? "Collapse" : "Expand"}</button> : null}
                <div className="clipboard-card-actions">
                  <button draggable onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("text/plain", item.text);
                    event.dataTransfer.setData(SPACE_CLIPBOARD_ITEM_MIME, item.id);
                    if (item.title) event.dataTransfer.setData(SPACE_CLIPBOARD_ITEM_TITLE_MIME, item.title);
                  }} aria-label="Drag clip"><GripVertical aria-hidden="true" /> Drag</button>
                  {item.source === "PLAN" ? (
                    <button className={item.isCompleted ? "is-completed" : ""} onClick={() => void toggleCompleted(item)}
                      aria-label={item.isCompleted ? "Mark plan not completed" : "Mark plan completed"}>
                      <CheckCircle2 aria-hidden="true" /> {item.isCompleted ? "Completed" : "Complete"}
                    </button>
                  ) : null}
                  <button disabled={!canInsert} onClick={() => onInsert(item)}
                    aria-label={`Insert into ${activePaneLabel ?? "active pane"}`}><Copy aria-hidden="true" /> Insert</button>
                  <button onClick={() => void copyItem(item)} aria-label="Copy clip"><Copy aria-hidden="true" /></button>
                  <button onClick={() => void deleteItem(item)} aria-label="Delete clip"><Trash2 aria-hidden="true" /></button>
                </div>
              </article>
            );
          })}
          {!loading && !items.length ? <div className="empty-state" role="status">No clipboard items match this view.</div> : null}
        </div>
      </div>
    </section>
  );
}
