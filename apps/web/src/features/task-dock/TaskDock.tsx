import {
  GripVertical,
  ListTodo,
  Loader2,
  Maximize2,
  Minimize2,
  Play,
  Plus,
  Trash2,
  X
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { TaskItem, TaskStatus } from "@space/contracts";
import { taskObjectiveMaxCharacters, taskTitleMaxCharacters } from "@space/contracts";
import { api } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  SPACE_TASK_ITEM_MIME,
  SPACE_TASK_UPDATED_EVENT,
  notifyTasksUpdated
} from "./task-events.js";

interface TaskDockProps {
  canInsert: boolean;
  activePaneLabel: string | null;
  onInsert: (item: TaskItem) => void;
}

type StatusFilter = "ALL" | TaskStatus;

const statusFilters: Array<{ id: StatusFilter; label: string }> = [
  { id: "ALL", label: "All" },
  { id: "OPEN", label: "Open" },
  { id: "RUNNING", label: "Running" },
  { id: "DONE", label: "Done" },
  { id: "ARCHIVED", label: "Archived" }
];

function timeLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const acceptedStatuses: TaskStatus[] = ["OPEN", "RUNNING", "DONE", "ARCHIVED"];

export function TaskDock({ canInsert, activePaneLabel, onInsert }: TaskDockProps) {
  const runtime = getSpaceRuntime();
  const [items, setItems] = useState<TaskItem[]>([]);
  const [totalItems, setTotalItems] = useState(0);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("ALL");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [manualTitle, setManualTitle] = useState("");
  const [manualObjective, setManualObjective] = useState("");
  const [saving, setSaving] = useState(false);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await api.taskItems({
        ...(search.trim() ? { q: search.trim() } : {}),
        ...(statusFilter === "ALL" ? {} : { status: statusFilter }),
        page: 1,
        pageSize: 100
      });
      setItems(payload.data);
      setTotalItems(payload.pagination.totalItems);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tasks could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [search, statusFilter]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadItems(), 150);
    return () => window.clearTimeout(timer);
  }, [loadItems]);

  useEffect(() => {
    const refresh = () => void loadItems();
    const poll = window.setInterval(refresh, 5_000);
    window.addEventListener(SPACE_TASK_UPDATED_EVENT, refresh);
    return () => {
      window.clearInterval(poll);
      window.removeEventListener(SPACE_TASK_UPDATED_EVENT, refresh);
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
    () => `${totalItems} task${totalItems === 1 ? "" : "s"} · Private · Space-wide · 100 max`,
    [totalItems]
  );

  async function copyItem(item: TaskItem) {
    try {
      if (runtime.platform.clipboard?.writeText) {
        await runtime.platform.clipboard.writeText(item.objective);
        setCopiedId(item.id);
        window.setTimeout(() => setCopiedId((current) => (current === item.id ? null : current)), 1_500);
      }
    } catch {
      setError("Clipboard access was unavailable. Select the objective and copy it manually.");
    }
  }

  async function saveTask() {
    if (!manualTitle.trim() || !manualObjective.trim()) return;
    try {
      setSaving(true);
      await api.createTaskItem({
        title: manualTitle.trim(),
        objective: manualObjective.trim(),
        status: "OPEN"
      });
      setManualTitle("");
      setManualObjective("");
      setIsAdding(false);
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  async function setTaskStatus(item: TaskItem, status: TaskStatus) {
    try {
      setUpdatingId(item.id);
      await api.updateTaskItem(item.id, { status });
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task status could not be updated.");
    } finally {
      setUpdatingId(null);
    }
  }

  async function deleteItem(item: TaskItem) {
    try {
      await api.deleteTaskItem(item.id);
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The task could not be deleted.");
    }
  }

  async function clearAll() {
    if (!window.confirm("Clear all task history for your account?")) return;
    try {
      await api.clearTaskItems();
      notifyTasksUpdated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Tasks could not be cleared.");
    }
  }

  return (
    <section
      className={`task-dock-shell${isFullscreen ? " is-fullscreen" : ""}`}
      aria-label="Task list"
    >
      <div className="task-dock">
        <header className="task-dock-head">
          <h2><ListTodo aria-hidden="true" /> Tasks</h2>
          <div className="task-dock-actions">
            <button className="icon-action" onClick={() => setIsFullscreen((value) => !value)}
              aria-label={isFullscreen ? "Close tasks fullscreen" : "Open tasks fullscreen"}
              aria-pressed={isFullscreen}>
              {isFullscreen ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}
            </button>
            <button className="icon-action" onClick={() => setIsAdding(true)} aria-label="Add task" aria-expanded={isAdding}>
              <Plus aria-hidden="true" />
            </button>
            <button className="icon-action" onClick={() => void clearAll()}
              aria-label="Clear all task items"><Trash2 aria-hidden="true" /></button>
          </div>
        </header>

        <p className="task-summary">{summary}</p>
        <div className="task-controls">
          <input type="search" name="task-search" aria-label="Search tasks" placeholder="Search tasks…" value={search}
            onChange={(event) => setSearch(event.currentTarget.value)} />
          <div className="task-filters" aria-label="Task statuses">
            {statusFilters.map((filter) => (
              <button key={filter.id} className={statusFilter === filter.id ? "active" : ""}
                aria-pressed={statusFilter === filter.id} onClick={() => setStatusFilter(filter.id)}>
                {filter.label}
              </button>
            ))}
          </div>
        </div>

        {isAdding ? (
          <div className="task-note-editor">
            <input type="text" autoFocus aria-label="Task title" placeholder="Task title" value={manualTitle}
              maxLength={taskTitleMaxCharacters + 1}
              onChange={(event) => setManualTitle(event.currentTarget.value)} />
            <textarea aria-label="Task objective" placeholder="Task objective — this is sent to the CLI on drop"
              value={manualObjective} maxLength={taskObjectiveMaxCharacters + 1}
              onChange={(event) => setManualObjective(event.currentTarget.value)} />
            <div>
              <span>{Array.from(manualObjective).length.toLocaleString()} / {taskObjectiveMaxCharacters.toLocaleString()}</span>
              <button onClick={() => { setManualTitle(""); setManualObjective(""); setIsAdding(false); }} aria-label="Cancel task"><X aria-hidden="true" /> Cancel</button>
              <button onClick={() => void saveTask()} disabled={!manualTitle.trim() || !manualObjective.trim() || saving}
                aria-label="Save task">{saving ? <Loader2 aria-hidden="true" /> : "Save"}</button>
            </div>
          </div>
        ) : null}

        {error ? <div className="banner bad">{error}</div> : null}
        <div className="task-list" role="list" aria-label="Task items">
          {items.map((item) => (
            <article className={`task-card is-${item.status.toLocaleLowerCase()}`} role="listitem" key={item.id}>
              <div className="task-card-meta">
                <strong>{item.status}</strong>
                <span>{item.source === "AGENT" ? "Agent" : "Manual"} · {item.paneTitle ?? "Space"} · {timeLabel(item.lastUsedAt)}</span>
                {item.occurrenceCount > 1 ? <small>Used {item.occurrenceCount} times</small> : null}
              </div>
              <div className="task-card-title">{item.title}</div>
              <button className="task-card-objective" onClick={() => void copyItem(item)}
                aria-label="Copy task objective">{item.objective}</button>
              {copiedId === item.id ? (
                <span className="task-copied" role="status">{runtime.kind === "demo" ? DEMO_LOCAL_REPLY : "Copied"}</span>
              ) : null}
              <div className="task-card-statuses" aria-label="Task status actions">
                {acceptedStatuses.map((status) => (
                  <button key={status} className={item.status === status ? "active" : ""}
                    disabled={updatingId === item.id}
                    aria-pressed={item.status === status}
                    onClick={() => void setTaskStatus(item, status)}>{status}</button>
                ))}
              </div>
              <div className="task-card-actions">
                <button draggable onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = "copy";
                  event.dataTransfer.setData("text/plain", item.objective);
                  event.dataTransfer.setData(SPACE_TASK_ITEM_MIME, item.id);
                }} aria-label="Drag task to a CLI"><GripVertical aria-hidden="true" /> Drag</button>
                <button disabled={!canInsert} onClick={() => onInsert(item)}
                  aria-label={`Start in ${activePaneLabel ?? "active pane"}`}><Play aria-hidden="true" /> Start</button>
                <button onClick={() => void deleteItem(item)} aria-label="Delete task"><Trash2 aria-hidden="true" /></button>
              </div>
            </article>
          ))}
          {!loading && !items.length ? <div className="empty-state" role="status">No tasks match this view.</div> : null}
        </div>
      </div>
    </section>
  );
}