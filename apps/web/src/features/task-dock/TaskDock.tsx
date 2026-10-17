import {
  ChevronDown,
  ChevronRight,
  Clock,
  GripVertical,
  ListTodo,
  Play,
  Plus,
  Trash2
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import { AnimatedNumber } from "../ui-controls/AnimatedNumber.js";
import type { CreateTaskItemRequest, TaskItem, TaskScheduleInput } from "@space/contracts";
import { taskObjectiveMaxCharacters, taskTitleMaxCharacters, zonedWallTimeToUtc } from "@space/contracts";
import { api } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  SPACE_TASK_ITEM_MIME,
  SPACE_TASK_UPDATED_EVENT,
  notifyTasksUpdated
} from "./task-events.js";
import {
  formatAppDate,
  formatAppTime,
  readDateTimeSettings,
  DATE_TIME_SETTINGS_UPDATED_EVENT
} from "../date-time-settings/date-time-settings.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import {
  DockButton,
  DockFullscreenButton,
  DockIconButton,
  DockNotice,
  DockSearch,
  DockState,
  DockToolbar,
  useDockConfirm,
  useDockFullscreen
} from "../dock-kit/DockKit.js";

let cachedTaskItems: TaskItem[] | null = null;
let cachedTaskTotal = 0;

interface TaskDockProps {
  canInsert: boolean;
  activePaneLabel: string | null;
  /** The active pane when it is a CLI: a scheduled task can run there. */
  activeCliPaneId?: string | null;
  onInsert: (item: TaskItem) => void;
}

type Repeat = "NONE" | "ONCE" | "DAILY" | "WEEKLY" | "60" | "120" | "360" | "720";
const repeatOptions: Array<{ id: Repeat; label: string }> = [
  { id: "NONE", label: "No time" },
  { id: "ONCE", label: "Does not repeat" },
  { id: "DAILY", label: "Daily" },
  { id: "WEEKLY", label: "Weekly" },
  { id: "60", label: "Every hour" },
  { id: "120", label: "Every 2 hours" },
  { id: "360", label: "Every 6 hours" },
  { id: "720", label: "Every 12 hours" }
];
const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
type Group = "OVERDUE" | "TODAY" | "TOMORROW" | "LATER" | "NO_DATE";
const groupLabels: Record<Group, string> = { OVERDUE: "Overdue", TODAY: "Today", TOMORROW: "Tomorrow", LATER: "Later", NO_DATE: "No date" };

/** The zone the dock shows and takes times in: the app's date-time setting, or the browser's. */
function dockTimeZone(): string {
  const zone = readDateTimeSettings().timeZone;
  return zone && zone !== "system" ? zone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
function dayKey(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}
/** When the task is next due; a one-time task that already ran keeps its time. */
function dueAt(item: TaskItem): number | null {
  const schedule = item.schedule;
  const at = schedule?.nextRunAt ?? (schedule?.recurrence.kind === "ONCE" ? schedule.recurrence.at : null);
  return at ? Date.parse(at) : null;
}
function groupOf(item: TaskItem, now: number, timeZone: string): Group {
  const due = dueAt(item);
  if (due === null) return "NO_DATE";
  if (due < now) return "OVERDUE";
  const day = dayKey(due, timeZone);
  if (day === dayKey(now, timeZone)) return "TODAY";
  return day === dayKey(now + 86_400_000, timeZone) ? "TOMORROW" : "LATER";
}
function repeatLabel(item: TaskItem): string | null {
  const recurrence = item.schedule?.recurrence;
  if (!recurrence || recurrence.kind === "ONCE") return null;
  if (recurrence.kind === "DAILY") return "daily";
  if (recurrence.kind === "WEEKLY") return `weekly · ${recurrence.days.map((day) => weekdays[day]).join(", ")}`;
  return recurrence.minutes % 60 === 0 ? `every ${recurrence.minutes / 60} h` : `every ${recurrence.minutes} min`;
}
function whoLabel(item: TaskItem): string {
  if (item.source === "AGENT") return item.paneTitle ?? "Agent";
  return item.paneTitle ? `You → ${item.paneTitle}` : "You";
}
function todayInput(timeZone: string): string {
  return dayKey(Date.now(), timeZone);
}

/** The schedule the editor describes, or null for a task without a time. */
export function editorSchedule(repeat: Repeat, date: string, time: string, timeZone: string): TaskScheduleInput | null {
  if (repeat === "NONE") return null;
  if (/^\d+$/.test(repeat)) return { recurrence: { kind: "INTERVAL", minutes: Number(repeat) }, timeZone };
  const at = time || "09:00";
  if (repeat === "DAILY") return { recurrence: { kind: "DAILY", time: at }, timeZone };
  const [year, month, day] = (date || todayInput(timeZone)).split("-").map(Number) as [number, number, number];
  if (repeat === "WEEKLY") return { recurrence: { kind: "WEEKLY", days: [new Date(Date.UTC(year, month - 1, day)).getUTCDay()], time: at }, timeZone };
  const [hour, minute] = at.split(":").map(Number) as [number, number];
  return { recurrence: { kind: "ONCE", at: new Date(zonedWallTimeToUtc(year, month - 1, day, hour, minute, timeZone)).toISOString() }, timeZone };
}

export function TaskDock({ canInsert, activePaneLabel, activeCliPaneId = null, onInsert }: TaskDockProps) {
  const runtime = getSpaceRuntime();
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const [items, setItems] = useState<TaskItem[]>(() => cachedTaskItems ?? []);
  const [totalItems, setTotalItems] = useState(() => cachedTaskTotal);
  const [hasLoaded, setHasLoaded] = useState(() => cachedTaskItems !== null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useDockFullscreen();
  const [isAdding, setIsAdding] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualObjective, setManualObjective] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("NONE");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [runIn, setRunIn] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [showCompleted, setShowCompleted] = useState(false);
  const [taskListRef] = useAutoAnimate();
  const titleCharacters = Array.from(manualTitle).length;
  const objectiveCharacters = Array.from(manualObjective).length;
  const titleTooLong = titleCharacters > taskTitleMaxCharacters;
  const objectiveTooLong = objectiveCharacters > taskObjectiveMaxCharacters;
  const isFiltered = Boolean(search.trim());

  const loadItems = useCallback(async () => {
    try {
      const payload = await api.taskItems({ ...(search.trim() ? { q: search.trim() } : {}), page: 1, pageSize: 100 });
      setItems(payload.data);
      setTotalItems(payload.pagination.totalItems);
      setLoadError(null);
      if (!search.trim()) {
        cachedTaskItems = payload.data;
        cachedTaskTotal = payload.pagination.totalItems;
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Tasks could not be loaded.");
    } finally {
      setHasLoaded(true);
    }
  }, [search]);

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
    window.addEventListener(SPACE_TASK_UPDATED_EVENT, refresh);
    return () => {
      window.removeEventListener(SPACE_TASK_UPDATED_EVENT, refresh);
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

  async function copyItem(item: TaskItem) {
    try {
      if (!runtime.platform.clipboard?.writeText) throw new DOMException("Clipboard access is unavailable.", "NotSupportedError");
      await runtime.platform.clipboard.writeText(item.objective);
      setCopiedId(item.id);
      window.setTimeout(() => setCopiedId((current) => (current === item.id ? null : current)), 1_500);
    } catch {
      setError("Clipboard access was unavailable. Select the objective and copy it manually.");
    }
  }

  function openEditor() {
    setRunIn(activeCliPaneId ?? "");
    setIsAdding(true);
  }

  function closeEditor() {
    setManualTitle("");
    setManualObjective("");
    setRepeat("NONE");
    setDate("");
    setTime("09:00");
    setIsAdding(false);
  }

  async function saveTask() {
    if (!manualTitle.trim() || !manualObjective.trim() || titleTooLong || objectiveTooLong) return;
    const schedule = editorSchedule(repeat, date, time, dockTimeZone());
    const request: CreateTaskItemRequest = { title: manualTitle.trim(), objective: manualObjective.trim(), status: "OPEN" };
    if (schedule) request.schedule = schedule;
    if (schedule && runIn) {
      request.paneId = runIn;
      if (activePaneLabel) request.paneTitle = activePaneLabel.slice(0, 160);
    }
    try {
      setSaving(true);
      await api.createTaskItem(request);
      closeEditor();
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleDone(item: TaskItem) {
    const done = item.status === "DONE" || item.status === "ARCHIVED";
    try {
      setUpdatingId(item.id);
      await api.updateTaskItem(item.id, { status: done ? "OPEN" : "DONE" });
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task could not be updated.");
    } finally {
      setUpdatingId(null);
    }
  }

  async function deleteItem(item: TaskItem) {
    if (!await confirm({ title: "Delete this task?", message: `"${item.title}" will be removed.`, confirmLabel: "Delete" })) return;
    try {
      await api.deleteTaskItem(item.id);
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task could not be deleted.");
    }
  }

  async function clearAll() {
    if (!await confirm({ title: "Clear all tasks?", message: "Every task in your list will be removed. This cannot be undone.", confirmLabel: "Clear all" })) return;
    try {
      await api.clearTaskItems();
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tasks could not be cleared.");
    }
  }

  const timeZone = dockTimeZone();
  const now = Date.now();
  const open = items.filter((item) => item.status !== "DONE" && item.status !== "ARCHIVED");
  const completed = items.filter((item) => item.status === "DONE" || item.status === "ARCHIVED");
  const groups = (Object.keys(groupLabels) as Group[]).map((group) => ({
    group,
    items: open.filter((item) => groupOf(item, now, timeZone) === group)
      .sort((left, right) => (dueAt(left) ?? 0) - (dueAt(right) ?? 0))
  })).filter((entry) => entry.items.length);

  function renderRow(item: TaskItem) {
    const done = item.status === "DONE" || item.status === "ARCHIVED";
    const due = dueAt(item);
    const group = done ? null : groupOf(item, now, timeZone);
    const when = due === null ? null : group === "TODAY" || group === "TOMORROW"
      ? formatAppTime(due, { hour: "2-digit", minute: "2-digit" })
      : `${formatAppDate(due, { day: "numeric", month: "short" })} ${formatAppTime(due, { hour: "2-digit", minute: "2-digit" })}`;
    const repeatText = repeatLabel(item);
    const expanded = expandedIds.has(item.id);
    const isLong = item.characterCount > 160;
    return (
      <article className={`task-row${done ? " is-done" : ""}${group === "OVERDUE" ? " is-overdue" : ""}`} role="listitem" key={item.id}>
        <button type="button" className="dock-kit-task-check" aria-pressed={done} disabled={updatingId === item.id}
          aria-label={done ? `Mark "${item.title}" as not done` : `Mark "${item.title}" as done`} onClick={() => void toggleDone(item)} />
        <div className="task-row-body">
          <div className="task-row-title">{item.title}{item.status === "RUNNING" ? <span className="dock-kit-badge is-warning">Running</span> : null}</div>
          <button className={`dock-kit-task-details${expanded ? " expanded" : ""}`} onClick={() => void copyItem(item)}
            aria-label="Copy task objective" title="Click to copy">{item.objective}</button>
          {isLong ? <button type="button" className="dock-kit-task-more" onClick={() => setExpandedIds((current) => {
            const next = new Set(current);
            if (next.has(item.id)) next.delete(item.id); else next.add(item.id);
            return next;
          })}>{expanded ? "Less" : "More"}</button> : null}
          <div className="task-row-chips">
            {when ? (
              <span className={`task-chip${group === "OVERDUE" ? " is-overdue" : ""}`} title={item.schedule?.lastOutcome ?? undefined}>
                <Clock aria-hidden="true" />{when}{repeatText ? ` · ${repeatText}` : ""}
              </span>
            ) : null}
            <span className="task-chip is-plain">{whoLabel(item)}</span>
          </div>
          {copiedId === item.id ? (
            <span className="task-copied" role="status">{runtime.kind === "demo" ? DEMO_LOCAL_REPLY : "Copied"}</span>
          ) : null}
        </div>
        <div className="task-row-actions">
          <DockIconButton label="Drag task to a CLI" icon={GripVertical} className="task-drag-handle" draggable onDragStart={(event) => {
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("text/plain", item.objective);
            event.dataTransfer.setData(SPACE_TASK_ITEM_MIME, item.id);
          }} />
          <DockIconButton label={`Start in ${activePaneLabel ?? "active pane"}`} icon={Play} disabled={!canInsert} onClick={() => onInsert(item)}
            title={canInsert ? `Start in ${activePaneLabel ?? "active pane"}` : "Select a CLI or chat pane to start this task"} />
          <DockIconButton label="Delete task" icon={Trash2} tone="danger" onClick={() => void deleteItem(item)} />
        </div>
      </article>
    );
  }

  return (
    <section
      className={`task-dock-shell dock-kit-shell${isFullscreen ? " is-fullscreen" : ""}`}
      aria-label="Task list"
    >
      <div className="task-dock dock-kit-dock">
        <DockToolbar
          title={isFullscreen ? "Tasks" : undefined}
          summary={<><strong><AnimatedNumber value={totalItems} /></strong> task{totalItems === 1 ? "" : "s"} · private to you</>}
        >
          <DockIconButton label="Add task" icon={Plus} tone="primary" aria-expanded={isAdding} onClick={openEditor} />
          <DockIconButton label="Clear all tasks" icon={Trash2} tone="danger" disabled={!totalItems} onClick={() => void clearAll()} />
          <DockFullscreenButton name="tasks" active={isFullscreen} onToggle={() => setIsFullscreen((value) => !value)} />
        </DockToolbar>

        <div className="dock-kit-controls">
          <DockSearch name="task-search" label="Search tasks" value={search} onChange={setSearch} />
        </div>

        {isAdding ? (
          <div className="dock-kit-editor task-editor">
            <input className="dock-kit-field" type="text" autoFocus aria-label="Task title" placeholder="Title" value={manualTitle}
              maxLength={taskTitleMaxCharacters + 1}
              onChange={(event) => setManualTitle(event.currentTarget.value)} />
            <textarea className="dock-kit-field" aria-label="Task objective"
              placeholder="Details: what should the agent do?"
              value={manualObjective} maxLength={taskObjectiveMaxCharacters + 1}
              onChange={(event) => setManualObjective(event.currentTarget.value)} />
            <div className="task-editor-when">
              <select className="dock-kit-select" aria-label="Repeat" value={repeat} onChange={(event) => setRepeat(event.currentTarget.value as Repeat)}>
                {repeatOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
              {repeat === "ONCE" || repeat === "WEEKLY" ? (
                <input className="dock-kit-field" type="date" aria-label="Date" value={date} min={todayInput(timeZone)}
                  onChange={(event) => setDate(event.currentTarget.value)} />
              ) : null}
              {repeat === "ONCE" || repeat === "DAILY" || repeat === "WEEKLY" ? (
                <input className="dock-kit-field" type="time" aria-label="Time" value={time} onChange={(event) => setTime(event.currentTarget.value)} />
              ) : null}
              {repeat !== "NONE" ? (
                <select className="dock-kit-select" aria-label="Run in" value={runIn} onChange={(event) => setRunIn(event.currentTarget.value)}>
                  <option value="">Just remind me</option>
                  {activeCliPaneId ? <option value={activeCliPaneId}>Run in {activePaneLabel ?? "the active CLI"}</option> : null}
                </select>
              ) : null}
            </div>
            {repeat !== "NONE" ? (
              <span className="task-editor-hint">
                {/^\d+$/.test(repeat) ? "Starts now. " : ""}Times in {timeZone}.{runIn ? " Space types the task into that CLI when it is due, only at an empty prompt." : ""}
              </span>
            ) : null}
            <div className="dock-kit-editor-footer">
              <span className={`dock-kit-counter${titleTooLong || objectiveTooLong ? " is-over" : ""}`}>
                {titleTooLong ? `Title is over ${taskTitleMaxCharacters} characters` : `${objectiveCharacters.toLocaleString()} / ${taskObjectiveMaxCharacters.toLocaleString()}`}
              </span>
              <DockButton tone="ghost" onClick={closeEditor} aria-label="Cancel task">Cancel</DockButton>
              <DockButton tone="primary" busy={saving} onClick={() => void saveTask()}
                disabled={!manualTitle.trim() || !manualObjective.trim() || titleTooLong || objectiveTooLong || saving}
                aria-label="Save task">Save</DockButton>
            </div>
          </div>
        ) : (
          <button type="button" className="dock-kit-task-add" onClick={openEditor}><Plus aria-hidden="true" />Add a task</button>
        )}

        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {loadError && items.length ? <DockNotice onDismiss={() => setLoadError(null)}>{loadError}</DockNotice> : null}

        {!items.length ? (
          !hasLoaded ? (
            <DockState kind="loading" title="Loading tasks…" />
          ) : loadError ? (
            <DockState kind="error" title="Tasks could not be loaded" detail={loadError} action={{ label: "Try again", onClick: () => void loadItems() }} />
          ) : isFiltered ? (
            <DockState kind="empty" icon={ListTodo} title="No tasks match this view." detail="Change the search." />
          ) : (
            <DockState kind="empty" icon={ListTodo} title="No tasks yet" detail="Add a task with a time, and Space runs it in your CLI when it is due."
              action={{ label: "Add your first task", icon: Plus, onClick: openEditor }} />
          )
        ) : null}

        <div ref={taskListRef} className="task-list dock-kit-list" hidden={!items.length}>
          {groups.map(({ group, items: groupItems }) => (
            <div key={group} className={`task-group${group === "OVERDUE" ? " is-overdue" : ""}`}>
              <h3 className="task-group-title">{groupLabels[group]}</h3>
              <div role="list" aria-label={groupLabels[group]}>{groupItems.map(renderRow)}</div>
            </div>
          ))}
          {completed.length ? (
            <div className="task-group is-completed">
              <button type="button" className="dock-kit-task-group-toggle" aria-expanded={showCompleted} onClick={() => setShowCompleted((value) => !value)}>
                {showCompleted ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}Completed ({completed.length})
              </button>
              {showCompleted ? <div role="list" aria-label="Completed">{completed.map(renderRow)}</div> : null}
            </div>
          ) : null}
        </div>
      </div>
      {confirmDialog}
    </section>
  );
}
