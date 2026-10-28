import {
  Bot,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Copy,
  ExternalLink,
  FileInput,
  GripVertical,
  Pin,
  Plus,
  Trash2,
  X
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipboardItem, ClipboardSource, PlanStep } from "@space/contracts";
import { clipboardTextMaxCharacters } from "@space/contracts";
import { api } from "../../api.js";
import { loadPlanCompletion, PlanCompletionBar } from "./PlanCompletionBar.js";
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
import { useIsDockActive } from "../docks/dock-active-context.js";
import { canOpenPlanPane, openPlanPane, planAssignee, useOpenPaneNames, useRoomNames } from "./plan-assignee.js";
import { isLikelyModelDescriptor, isSameModel, resolveStepModel } from "../terminal-pane/plan-model-resolver.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  DockButton,
  DockChips,
  DockFullscreenButton,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm,
  useDockFullscreen
} from "../dock-kit/DockKit.js";

let cachedClipboardItems: ClipboardItem[] | null = null;
let cachedClipboardTotal = 0;
let cachedPlanStats = { total: 0, completed: 0 };

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
  { id: "COPY", label: "Copied" },
  { id: "PASTE", label: "Pasted" },
  { id: "NOTES", label: "Notes" },
  { id: "PLANS", label: "Plans" }
];

const sourceLabels: Record<ClipboardSource, string> = {
  COPY: "Copied",
  PASTE: "Pasted",
  MANUAL_NOTE: "Note",
  AGENT_NOTE: "Agent note",
  PLAN: "Plan"
};

function planStatusLabel(status: string): string {
  const words = status.toLowerCase().split("_");
  return words.map((word, index) => index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word).join(" ");
}

// A collapsed plan card lists its first stages; Expand shows the rest.
const COLLAPSED_PLAN_STEPS = 5;

// Stages in their plan order: agents may report a later stage before an earlier one.
function orderedSteps(steps: PlanStep[]): PlanStep[] {
  return steps
    .map((step, index) => ({ step, index }))
    .sort((left, right) => left.step.order - right.step.order || left.index - right.index)
    .map(({ step }) => step);
}

// "Review [claude-opus-5-5 / high]" → "Review": the stage's model has its own tag.
function stepTitleWithoutModel(title: string): string {
  const stripped = title.replace(/\s*\[([^\]]+)\]/, (match, inner: string) => (isLikelyModelDescriptor(inner) ? "" : match)).trim();
  return stripped || title;
}

// A collapsed plan shows its prose: the title already names it, so headings and markdown marks are left out.
function planSnippet(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^(?:[-*>]|\d+\.)\s+/, "").replace(/\*\*|`/g, ""))
    .filter((line) => line && !line.startsWith("#") && !/^-{3,}$/.test(line))
    .join(" ")
    .slice(0, 400);
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
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const [items, setItems] = useState<ClipboardItem[]>(() => cachedClipboardItems ?? []);
  const [totalItems, setTotalItems] = useState(() => cachedClipboardTotal);
  const [planStats, setPlanStats] = useState(() => cachedPlanStats);
  const [hasLoaded, setHasLoaded] = useState(() => cachedClipboardItems !== null);
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>(() => {
    try {
      return readStoredSourceFilter(runtime.platform.localStorage);
    } catch {
      return "ALL";
    }
  });
  const [showCompleted, setShowCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [isAdding, setIsAdding] = useState(false);
  const [manualText, setManualText] = useState("");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const noteCharacters = clipboardCharacterCount(manualText);
  const noteTooLong = noteCharacters > clipboardTextMaxCharacters;
  const isFiltered = Boolean(search.trim()) || sourceFilter !== "ALL";
  const insertTarget = activePaneLabel ?? "active pane";
  const roomNames = useRoomNames(isDockActive);
  const openPanes = useOpenPaneNames(roomNames);

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
  }, [onClose, setIsFullscreen]);

  useEffect(() => {
    try {
      runtime.platform.localStorage.setItem(CLIPBOARD_SOURCE_FILTER_STORAGE_KEY, sourceFilter);
    } catch {
      // The current selection remains usable when storage is unavailable.
    }
  }, [runtime.platform.localStorage, sourceFilter]);

  const loadItems = useCallback(async () => {
    const base = {
      ...(search.trim() ? { q: search.trim() } : {}),
      includeCompleted: showCompleted,
      page: 1,
      pageSize: 100
    };
    try {
      const planCounts = loadPlanCompletion();
      let visible: ClipboardItem[];
      let total: number;
      if (sourceFilter === "NOTES") {
        // Notes are manual and agent notes; ask the server for each so the count covers every note.
        const [manual, agent] = await Promise.all([
          api.clipboardItems({ ...base, source: "MANUAL_NOTE" }),
          api.clipboardItems({ ...base, source: "AGENT_NOTE" })
        ]);
        visible = [...manual.data, ...agent.data]
          .sort((left, right) => right.lastUsedAt.localeCompare(left.lastUsedAt))
          .slice(0, 100);
        total = manual.pagination.totalItems + agent.pagination.totalItems;
      } else {
        const payload = await api.clipboardItems({
          ...base,
          ...(sourceFilter === "COPY" || sourceFilter === "PASTE" || sourceFilter === "PLANS"
            ? { source: sourceFilter === "PLANS" ? "PLAN" : sourceFilter }
            : {})
        });
        visible = payload.data;
        total = payload.pagination.totalItems;
      }
      const plans = await planCounts;
      setItems(visible);
      setTotalItems(total);
      setPlanStats(plans);
      cachedPlanStats = plans;
      setLoadError(null);
      if (!search.trim() && sourceFilter === "ALL" && !showCompleted) {
        cachedClipboardItems = visible;
        cachedClipboardTotal = total;
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Clipboard history could not be loaded.");
    } finally {
      setHasLoaded(true);
    }
  }, [search, sourceFilter, showCompleted]);

  const initialLoadRef = useRef(true);
  useEffect(() => {
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      void loadItems();
      return;
    }
    const timer = window.setTimeout(() => void loadItems(), 150);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  useEffect(() => {
    const refresh = () => void loadItems();
    window.addEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener(SPACE_CLIPBOARD_UPDATED_EVENT, refresh);
    };
  }, [loadItems]);

  useEffect(() => {
    if (!isDockActive) return;
    const refresh = () => void loadItems();
    const poll = window.setInterval(refresh, 5_000);
    return () => window.clearInterval(poll);
  }, [isDockActive, loadItems]);

  const [, setDateTimeTick] = useState(0);
  useEffect(() => {
    const handleSettingsUpdate = () => setDateTimeTick((c) => c + 1);
    window.addEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
    return () => window.removeEventListener(DATE_TIME_SETTINGS_UPDATED_EVENT, handleSettingsUpdate);
  }, []);

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
        minimumModel: item.source === "PLAN" ? (item.minimumModel ?? undefined) : undefined,
        minimumReasoning: item.source === "PLAN" ? (item.minimumReasoning ?? undefined) : undefined,
        roomId: item.roomId,
        paneId: item.paneId,
        paneTitle: item.paneTitle
      });
    } catch {
      setError("Clipboard access was unavailable. Select the text and copy it manually.");
    }
  }

  function closeEditor() {
    setManualText("");
    setIsAdding(false);
  }

  async function saveManualNote() {
    if (!manualText.trim() || noteTooLong) return;
    try {
      await api.createClipboardItem({ text: manualText, source: "MANUAL_NOTE" });
      closeEditor();
      notifyClipboardUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The note could not be saved.");
    }
  }

  async function deleteItem(item: ClipboardItem) {
    const kind = item.source === "PLAN" ? "plan" : item.source === "MANUAL_NOTE" || item.source === "AGENT_NOTE" ? "note" : "clip";
    if (!await confirm({ title: `Delete this ${kind}?`, message: "It will be removed from your clipboard history.", confirmLabel: "Delete" })) return;
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
    if (!await confirm({ title: "Clear all clipboard history?", message: "Every clip, note and plan will be removed. This cannot be undone.", confirmLabel: "Clear all" })) return;
    try {
      await api.clearClipboardItems();
      notifyClipboardUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clipboard history could not be cleared.");
    }
  }

  return (
    <section
      className={`clipboard-dock-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}
      aria-label="Clipboard history"
      data-space-clipboard-capture="off"
    >
      <div className="clipboard-dock dock-kit-dock">
        <DockToolbar
          title={isFullscreen ? "Clipboard" : undefined}
          summary={<><strong>{totalItems.toLocaleString()}</strong> item{totalItems === 1 ? "" : "s"} · private to you</>}
        >
          <DockIconButton label="Add clipboard note" icon={Plus} tone="primary" aria-expanded={isAdding} onClick={() => setIsAdding(true)} />
          <DockIconButton label="Clear all clipboard items" icon={Trash2} tone="danger" disabled={!totalItems} onClick={() => void clearAll()} />
          <DockFullscreenButton name="clipboard" active={isFullscreen} onToggle={() => setIsFullscreen((value) => !value)} />
          {isFullscreen ? <DockIconButton label="Close clipboard" icon={X} className="clipboard-dock-close" onClick={handleClose} /> : null}
        </DockToolbar>

        <div className="dock-kit-controls">
          <DockSearch name="clipboard-search" label="Search clips" value={search} onChange={setSearch} />
          <DockChips label="Clipboard sources" options={sourceFilters} value={sourceFilter} onChange={setSourceFilter} />
          {sourceFilter === "ALL" || sourceFilter === "PLANS" ? (
            <SpaceToggle compact className="clipboard-completed-toggle" label="Show completed plans" checked={showCompleted} onChange={setShowCompleted} />
          ) : null}
        </div>

        {isAdding ? (
          <div className="dock-kit-editor">
            <textarea className="dock-kit-field" autoFocus aria-label="Manual clipboard note" placeholder="Write a note…" value={manualText}
              onChange={(event) => setManualText(event.currentTarget.value)} maxLength={clipboardTextMaxCharacters + 1} />
            <div className="dock-kit-editor-footer">
              <span className={`dock-kit-counter${noteTooLong ? " is-over" : ""}`}>
                {noteCharacters.toLocaleString()} / {clipboardTextMaxCharacters.toLocaleString()}
              </span>
              <DockButton tone="ghost" onClick={closeEditor} aria-label="Cancel note">Cancel</DockButton>
              <DockButton tone="primary" onClick={() => void saveManualNote()} disabled={!manualText.trim() || noteTooLong}
                aria-label="Save note">Save</DockButton>
            </div>
          </div>
        ) : null}

        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {loadError && items.length ? <DockNotice onDismiss={() => setLoadError(null)}>{loadError}</DockNotice> : null}

        {!items.length ? (
          !hasLoaded ? (
            <DockState kind="loading" title="Loading clipboard…" />
          ) : loadError ? (
            <DockState kind="error" title="Clipboard history could not be loaded" detail={loadError} action={{ label: "Try again", onClick: () => void loadItems() }} />
          ) : isFiltered || showCompleted ? (
            <DockState kind="empty" icon={Clipboard} title="No clipboard items match this view." detail="Change the search or the filter." />
          ) : (
            <DockState kind="empty" icon={Clipboard} title="Your clipboard is empty"
              detail="Text you copy or paste in Space, notes and agent plans appear here."
              action={{ label: "Write a note", icon: Plus, onClick: () => setIsAdding(true) }} />
          )
        ) : null}

        <PlanCompletionBar {...planStats} />

        <div className="clipboard-list dock-kit-list" role="list" aria-label="Clipboard items" hidden={!items.length}>
          {items.map((item) => {
            const expanded = expandedIds.has(item.id);
            const isLong = item.characterCount > 360;
            const isPlan = item.source === "PLAN";
            const isNote = item.source === "MANUAL_NOTE" || item.source === "AGENT_NOTE";
            const planStatus = item.executionStatus ?? (item.isCompleted ? "COMPLETED" : "PLANNED");
            const planProgress = item.progressPercentage ?? (item.isCompleted ? 100 : 0);
            const assignee = isPlan ? planAssignee(item, undefined, roomNames, openPanes) : null;
            const planModel = item.minimumModel ? `${item.minimumModel}${item.minimumReasoning ? ` · ${item.minimumReasoning}` : ""}` : null;
            const steps = isPlan && item.steps ? orderedSteps(item.steps) : [];
            const visibleSteps = expanded ? steps : steps.slice(0, COLLAPSED_PLAN_STEPS);
            const hiddenSteps = steps.length - visibleSteps.length;
            const prose = isPlan ? planSnippet(item.text) : "";
            const snippet = expanded ? "" : prose;
            const canExpand = isPlan ? hiddenSteps > 0 || prose !== item.text.trim() : isLong;
            return (
              <article
                className={`clipboard-card dock-kit-card${isPlan ? " is-plan is-accent" : ""}${item.isCompleted ? " is-completed is-muted" : ""}`}
                role="listitem"
                key={item.id}
                onDoubleClick={(event) => {
                  const target = event.target as HTMLElement;
                  if (target.closest(".dock-kit-card-actions") || target.closest(".clipboard-plan-steps-more") || target.closest(".clipboard-plan-open-pane")) return;
                  toggleExpanded(item.id);
                }}
              >
                <div className="dock-kit-meta">
                  <span className={`dock-kit-badge${isPlan ? " is-accent clipboard-source-plan" : ""}`}>{sourceLabels[item.source]}</span>
                  {item.isCompleted ? <span className="dock-kit-badge is-success clipboard-status-completed">Completed</span> : null}
                  <span className="dock-kit-meta-text clipboard-meta-text">
                    {assignee ? null : <span className="clipboard-meta-origin">{item.paneTitle ?? "Space"}</span>}
                    <span className="clipboard-meta-time">{assignee ? "" : " · "}{timeLabel(item.lastUsedAt)}</span>
                  </span>
                  {item.occurrenceCount > 1 ? <span className="dock-kit-badge">Used {item.occurrenceCount}×</span> : null}
                </div>
                {item.title ? <div className="dock-kit-card-title" data-sensitive-masked="manual">{item.title}</div> : null}
                {isPlan ? (
                  <div className="clipboard-plan-progress-container">
                    <div className="clipboard-plan-progress-header">
                      <span className={`clipboard-plan-status-badge is-${planStatus.toLowerCase()}`}>
                        {planStatusLabel(planStatus)}
                      </span>
                      <span className="clipboard-plan-pct">{planProgress}%</span>
                      {item.minimumModel ? (
                        <span className="clipboard-plan-min-model" title={`Minimum capable model: ${item.minimumModel}${item.minimumReasoning ? `; Recommended reasoning: ${item.minimumReasoning}` : ""}`}>
                          <BrainCircuit aria-hidden="true" /> {item.minimumModel}{item.minimumReasoning ? ` · ${item.minimumReasoning}` : ""}
                        </span>
                      ) : null}
                    </div>
                    <div className="clipboard-plan-progress-bar" role="progressbar" aria-label="Plan progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={planProgress}>
                      <div
                        className={`clipboard-plan-progress-fill${item.isCompleted || planProgress === 100 ? " is-completed" : ""}`}
                        style={{ width: `${planProgress}%` }}
                      />
                    </div>
                    {assignee || item.activeAgent ? (
                      <div className="clipboard-plan-assignee"
                        title={[item.activeAgent ? `Current agent: ${item.activeAgent}` : null, assignee ? `Linked to ${assignee}` : null].filter(Boolean).join("; ")}>
                        <Bot aria-hidden="true" />
                        <span>
                          {item.activeAgent ? <strong className="clipboard-plan-agent">{item.activeAgent}</strong> : null}
                          {item.activeAgent && assignee ? " · " : null}
                          {assignee ? `Linked to ${assignee}` : null}
                        </span>
                        {canOpenPlanPane(item) ? (
                          <DockIconButton icon={ExternalLink} className="clipboard-plan-open-pane" onClick={() => openPlanPane(item)}
                            label={`Open ${item.paneTitle || "the plan's pane"}${item.roomId && roomNames.get(item.roomId) ? ` in ${roomNames.get(item.roomId)}` : ""}`} />
                        ) : null}
                      </div>
                    ) : null}
                    {steps.length > 0 ? (
                      <div className="clipboard-plan-steps-list">
                        {visibleSteps.map((step) => {
                          const stepModel = resolveStepModel(step, item);
                          const isAgentSameAsModel = isSameModel(step.agent, stepModel);
                          // The plan's model is on the card once; a stage shows only a model of its own.
                          const showModelTag = Boolean(
                            stepModel &&
                              !isSameModel(stepModel, planModel) &&
                              (!step.agent ||
                                step.agent.toLowerCase().includes("unavailable") ||
                                !isAgentSameAsModel)
                          );

                          return (
                            <div className={`clipboard-plan-step-item is-${step.status.toLowerCase()}`} key={step.id}>
                              <span className={`clipboard-plan-step-bullet is-${step.status.toLowerCase()}`} />
                              <span className="clipboard-plan-step-title" data-sensitive-masked="manual" title={step.title}>{stepTitleWithoutModel(step.title)}</span>
                              {step.progress > 0 && step.status !== "COMPLETED" ? (
                                <span className="clipboard-plan-step-pct">{step.progress}%</span>
                              ) : null}
                              {showModelTag && stepModel ? (
                                <span className="clipboard-plan-step-model" title={`Designated model: ${stepModel}`}>
                                  <BrainCircuit aria-hidden="true" /> {stepModel}
                                </span>
                              ) : null}
                              {step.agent ? (
                                <small className="clipboard-plan-step-agent" title={`Assigned agent: ${step.agent}`}>
                                  ({step.agent})
                                </small>
                              ) : null}
                            </div>
                          );
                        })}
                        {hiddenSteps > 0 ? (
                          <button type="button" className="dock-kit-link clipboard-plan-steps-more" onClick={() => toggleExpanded(item.id)}>
                            +{hiddenSteps} more {hiddenSteps === 1 ? "stage" : "stages"}
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <button
                  type="button"
                  className={`clipboard-card-text${expanded ? " expanded" : ""}${snippet ? " is-snippet" : ""}${!isPlan && isLong && !expanded ? " is-clipped" : ""}`}
                  onClick={() => void copyItem(item)}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded(item.id);
                  }}
                  aria-label="Copy clip text"
                  data-sensitive-masked="manual"
                  title="Click to copy, double-click to expand or collapse"
                >
                  {snippet ? <span className="clipboard-card-snippet">{snippet}</span> : item.text}
                </button>
                {copiedId === item.id ? (
                  <span className="clipboard-copied" role="status">{runtime.kind === "demo" ? DEMO_LOCAL_REPLY : "Copied"}</span>
                ) : null}
                <div className="dock-kit-card-actions clipboard-card-actions">
                  {canExpand || expanded ? (
                    <DockButton tone="ghost" icon={expanded ? ChevronUp : ChevronDown} className="clipboard-expand" onClick={() => toggleExpanded(item.id)}
                      aria-label={expanded ? "Collapse" : "Expand"} title={expanded ? "Collapse" : "Expand"}>
                      <span className="clipboard-action-label">{expanded ? "Collapse" : "Expand"}</span>
                    </DockButton>
                  ) : null}
                  <DockIconButton label="Drag clip" icon={GripVertical} className="clipboard-drag-handle" draggable onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = "copy";
                    event.dataTransfer.setData("text/plain", item.text);
                    event.dataTransfer.setData(SPACE_CLIPBOARD_ITEM_MIME, item.id);
                    if (item.title) event.dataTransfer.setData(SPACE_CLIPBOARD_ITEM_TITLE_MIME, item.title);
                  }} />
                  {isPlan ? (
                    <DockButton icon={CheckCircle2} className={`clipboard-complete${item.isCompleted ? " is-completed" : ""}`} onClick={() => void toggleCompleted(item)}
                      aria-label={item.isCompleted ? "Mark plan not completed" : "Mark plan completed"}
                      title={item.isCompleted ? "Mark plan not completed" : "Mark plan completed"}>
                      <span className="clipboard-action-label">{item.isCompleted ? "Completed" : "Complete"}</span>
                    </DockButton>
                  ) : null}
                  <DockButton icon={FileInput} disabled={!canInsert} onClick={() => onInsert(item)}
                    aria-label={`Insert into ${insertTarget}`}
                    title={canInsert ? `Insert into ${insertTarget}` : "Select a CLI or chat pane to insert"}>Insert</DockButton>
                  <DockIconButton label="Copy clip" icon={Copy} onClick={() => void copyItem(item)} />
                  {isNote ? (
                    <DockIconButton label="Open note in floating sticky note" icon={Pin} className="clipboard-pin-btn" onClick={() => handleOpenStickyNote(item)} />
                  ) : null}
                  <DockIconButton label="Delete clip" icon={Trash2} tone="danger" onClick={() => void deleteItem(item)} />
                </div>
              </article>
            );
          })}
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}
