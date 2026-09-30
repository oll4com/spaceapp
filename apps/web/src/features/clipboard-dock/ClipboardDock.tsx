import {
  CheckCircle2,
  Clipboard,
  Copy,
  GripVertical,
  Maximize2,
  Minimize2,
  Pin,
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
import {
  formatAppDateTime,
  DATE_TIME_SETTINGS_UPDATED_EVENT
} from "../date-time-settings/date-time-settings.js";

interface ClipboardDockProps {
  canInsert: boolean;
  activePaneLabel: string | null;
  onInsert: (item: ClipboardItem) => void;
  onOpenStickyNote?: (item?: ClipboardItem | null) => void;
  onClose?: () => void;
}

type SourceFilter = "ALL" | "COPY" | "PASTE" | "NOTES" | "PLANS";

export const CLIPBOARD_SOURCE_FILTER_STORAGE_KEY = "space.clipboard.last-source-filter";

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
  return formatAppDateTime(date);
}

function isSourceFilter(value: string | null): value is SourceFilter {
  return sourceFilters.some((filter) => filter.id === value);
}

function readStoredSourceFilter(storage: Storage): SourceFilter {
  const stored = storage.getItem(CLIPBOARD_SOURCE_FILTER_STORAGE_KEY);
  return isSourceFilter(stored) ? stored : "ALL";
}

export function ClipboardDock({ canInsert, activePaneLabel, onInsert, onOpenStickyNote, onClose }: ClipboardDockProps) {
  const runtime = getSpaceRuntime();
  const [items, setItems] = useState<ClipboardItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(() => {
    try {
      return readStoredSourceFilter(runtime.platform.localStorage);
    } catch {
      return "ALL";
    }
  });
  const [showCompleted, setShowCompleted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [manualText, setManualText] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const noteCharacters = clipboardCharacterCount(manualText);

  const handleOpenStickyNote = useCallback((item?: ClipboardItem | null) => {
    if (onOpenStickyNote) {
      onOpenStickyNote(item);
    } else {
      window.dispatchEvent(new CustomEvent("space:sticky-note:open", { detail: item }));
    }
  }, [onOpenStickyNote]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleClose = useCallback(() => {
    setIsFullscreen(false);
    onClose?.();
  }, [onClose]);

  useEffect(() => {
    try {
      runtime.platform.localStorage.setItem(CLIPBOARD_SOURCE_FILTER_STORAGE_KEY, sourceFilter);
    } catch {
      // The current selection remains usable when storage is unavailable.
    }
  }, [runtime.platform.localStorage, sourceFilter]);

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

  const [, setDateTimeTick] = useState(0);
  useEffect(() => {
    const handleSettingsUpdate = () => setDateTimeTick((c) => c + 1);
    window.addEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
    return () => window.removeEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
  }, []);

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
        source: item.source === "AGENT_NOTE" ? "COPY" : item.source,
        title: item.source === "PLAN" ? (item.title ?? undefined) : undefined,
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
      data-space-clipboard-capture="off"
    >
      <div className="clipboard-dock">
        <header className="clipboard-dock-head">
          <h2><Clipboard aria-hidden="true" /> Clipboard</h2>
          <div className="clipboard-dock-actions">
            <button className="icon-action" onClick={() => setIsAdding(true)} aria-label="Add clipboard note" aria-expanded={isAdding}>
              <Plus aria-hidden="true" />
            </button>
            <button className="icon-action" onClick={() => void clearAll()}
              aria-label="Clear all clipboard items"><Trash2 aria-hidden="true" /></button>
            <button
              className={`icon-action dock-fullscreen-toggle${isFullscreen ? " is-active" : ""}`}
              onClick={() => setIsFullscreen((value) => !value)}
              aria-label={isFullscreen ? "Close clipboard fullscreen" : "Open clipboard fullscreen"}
              title={isFullscreen ? "Close clipboard fullscreen" : "Open clipboard fullscreen"}
              aria-pressed={isFullscreen}
            >
              {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            {isFullscreen ? (
              <button
                className="icon-action clipboard-dock-close"
                onClick={handleClose}
                aria-label="Close clipboard"
                title="Close clipboard"
              >
                <X aria-hidden="true" />
              </button>
            ) : null}
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
              <article
                className={`clipboard-card${item.source === "PLAN" ? " is-plan" : ""}${item.isCompleted ? " is-completed" : ""}`}
                role="listitem"
                key={item.id}
                onDoubleClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest(".clipboard-card-actions") || target.closest(".clipboard-expand")) return;
                  toggleExpanded(item.id);
                }}
              >
                <div className="clipboard-card-meta">
                  <strong className={item.source === "PLAN" ? "clipboard-source-plan" : undefined}>{sourceLabel(item.source)}</strong>
                  {item.isCompleted ? <small className="clipboard-status-completed">Completed</small> : null}
                  <span>{item.paneTitle ?? "Space"} · {timeLabel(item.lastUsedAt)}</span>
                  {item.occurrenceCount > 1 ? <small>Used {item.occurrenceCount} times</small> : null}
                </div>
                {item.title ? <div className="clipboard-card-title">{item.title}</div> : null}
                {item.source === "PLAN" ? (
                  <div className="clipboard-plan-progress-container">
                    <div className="clipboard-plan-progress-header">
                      <span className={`clipboard-plan-status-badge is-${(item.executionStatus ?? (item.isCompleted ? "COMPLETED" : "PLANNED")).toLowerCase()}`}>
                        {(item.executionStatus ?? (item.isCompleted ? "COMPLETED" : "PLANNED")).replace("_", " ")}
                      </span>
                      <span className="clipboard-plan-pct">
                        {item.progressPercentage ?? (item.isCompleted ? 100 : 0)}%
                      </span>
                      {item.activeAgent ? (
                        <span className="clipboard-plan-agent" title={`Current Agent: ${item.activeAgent}`}>
                          🤖 {item.activeAgent}
                        </span>
                      ) : null}
                    </div>
                    <div className="clipboard-plan-progress-bar">
                      <div
                        className={`clipboard-plan-progress-fill${item.isCompleted || (item.progressPercentage ?? 0) === 100 ? " is-completed" : ""}`}
                        style={{ width: `${item.progressPercentage ?? (item.isCompleted ? 100 : 0)}%` }}
                      />
                    </div>
                    {item.steps && item.steps.length > 0 ? (
                      <div className="clipboard-plan-steps-list">
                        {item.steps.map((step) => (
                          <div className={`clipboard-plan-step-item is-${step.status.toLowerCase()}`} key={step.id}>
                            <span className={`clipboard-plan-step-bullet is-${step.status.toLowerCase()}`} />
                            <span className="clipboard-plan-step-title">{step.title}</span>
                            {step.progress > 0 && step.status !== "COMPLETED" ? (
                              <span className="clipboard-plan-step-pct">{step.progress}%</span>
                            ) : null}
                            {step.agent ? <small className="clipboard-plan-step-agent">({step.agent})</small> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button
                  className={`clipboard-card-text${expanded ? " expanded" : ""}`}
                  onClick={() => void copyItem(item)}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(item.id);
                  }}
                  aria-label="Copy clip text"
                  title="Click to copy, double-click to expand or collapse"
                >
                  {item.text}
                </button>
                {copiedId === item.id ? (
                  <span className="clipboard-copied" role="status">{runtime.kind === "demo" ? DEMO_LOCAL_REPLY : "Copied"}</span>
                ) : null}
                {isLong || expanded ? (
                  <button className="clipboard-expand" onClick={() => toggleExpanded(item.id)}>
                    {expanded ? "Collapse" : "Expand"}
                  </button>
                ) : null}
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
                  {(item.source === "MANUAL_NOTE" || item.source === "AGENT_NOTE") ? (
                    <button
                      className="clipboard-pin-btn"
                      onClick={() => handleOpenStickyNote(item)}
                      aria-label="Open note in floating sticky note"
                      title="Open note in floating sticky note"
                    >
                      <Pin aria-hidden="true" />
                    </button>
                  ) : null}
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
