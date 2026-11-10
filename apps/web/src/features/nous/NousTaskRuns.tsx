import { useCallback, useEffect, useState } from "react";
import type { TaskRun, TaskRunListResponse, TaskRunStatus } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockState } from "../dock-kit/DockKit.js";
import { CalendarCheck } from "../ui-theme/app-icons.js";
import { useNousUiState } from "./nous-ui-state.js";
import "./nous-requests.css";

/**
 * Task runs (operator 1/11 03:32 BKK, plan clipboard:GA__W4qBxSPR; ADMIN only): every run of the scheduled tasks of the Tasks dock, newest
 * first, with how it ended. A typed run is Running until its pane's own report says done, failed or waits (GET /api/tasks/runs).
 */
const STATUS_LABELS: Record<TaskRunStatus, string> = {
  SUCCEEDED: "Succeeded", FAILED: "Failed", WAITING: "Waiting", RUNNING: "Running", NO_REPORT: "No report", SKIPPED: "Skipped", REMINDER: "Reminder"
};
const STATUSES = Object.keys(STATUS_LABELS) as TaskRunStatus[];
type Filter = { status: TaskRunStatus | "ALL"; taskId: string };
const NO_FILTER: Filter = { status: "ALL", taskId: "" };
const isFilter = (value: unknown): value is Filter => typeof value === "object" && value !== null
  && ((value as Filter).status === "ALL" || STATUSES.includes((value as Filter).status as TaskRunStatus)) && typeof (value as Filter).taskId === "string";
const POLL_MS = 20_000;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const sameFilter = (left: Filter, right: Filter) => left.status === right.status && left.taskId === right.taskId;
const queryOf = (filter: Filter, before?: string) => ({ ...(before ? { before } : {}), ...(filter.status !== "ALL" ? { status: filter.status } : {}), ...(filter.taskId ? { taskId: filter.taskId } : {}) });
type RunList = Omit<TaskRunListResponse, "runs"> & { filter: Filter; runs: TaskRun[] };

export function NousTaskRuns({ active }: { active: boolean }) {
  // The filters stay as the operator left them (nous_msg:40a252b1); a task with no run left in the history period reads as all tasks.
  const [filter, setFilter] = useNousUiState("taskRuns.filter", NO_FILTER, isFilter);
  const [loaded, setList] = useState<RunList | null>(null);
  const list = loaded && sameFilter(loaded.filter, filter) ? loaded : null;
  const runs = list?.runs ?? null;
  const [error, setError] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // The newest page replaces what it covers; pages loaded further back stay (as in Requests).
  const loadLatest = useCallback(async () => {
    const page = await api.taskRuns(queryOf(filter));
    setList((current) => {
      const oldest = page.runs.at(-1)?.id;
      const older = current && sameFilter(current.filter, filter) && oldest ? current.runs.filter((run) => Number(run.id) < Number(oldest)) : [];
      return { ...page, filter, runs: [...page.runs, ...older], hasMore: older.length ? current!.hasMore : page.hasMore };
    });
    setError(null);
  }, [filter]);
  useEffect(() => {
    if (!active) return;
    const load = () => void loadLatest().catch((failure: unknown) => setError(messageOf(failure, "The task runs could not be loaded.")));
    load();
    const timer = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(timer);
  }, [active, loadLatest]);
  const loadEarlier = async () => {
    const oldest = runs?.at(-1);
    if (!oldest) return;
    setLoadingEarlier(true);
    try {
      const page = await api.taskRuns(queryOf(filter, oldest.id));
      setList((current) => !current || !sameFilter(current.filter, filter) ? current : { ...current, runs: [...current.runs, ...page.runs], hasMore: page.hasMore });
    } catch (failure) { setError(messageOf(failure, "Earlier runs could not be loaded.")); } finally { setLoadingEarlier(false); }
  };
  useEffect(() => {
    if (loaded && filter.taskId && !loaded.tasks.some((task) => task.taskId === filter.taskId)) setFilter((current) => ({ ...current, taskId: "" }));
  }, [loaded, filter.taskId, setFilter]);
  const counts = loaded?.counts;
  const tasks = loaded?.tasks ?? [];
  const all = counts ? STATUSES.reduce((sum, status) => sum + counts[status], 0) : null;
  return (
    <div className="nous-decisions nous-requests nous-task-runs" data-sensitive-masked="manual">
      <div className="nous-task-runs-filters">
        <select className="dock-kit-select nous-requests-filter" aria-label="Status" value={filter.status}
          onChange={(event) => { const status = event.currentTarget.value as Filter["status"]; setFilter((current) => ({ ...current, status })); }}>
          <option value="ALL">All{all !== null ? ` (${all})` : ""}</option>
          {STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABELS[status]}{counts ? ` (${counts[status]})` : ""}</option>)}
        </select>
        <select className="dock-kit-select nous-requests-filter" aria-label="Task" value={filter.taskId}
          onChange={(event) => { const taskId = event.currentTarget.value; setFilter((current) => ({ ...current, taskId })); }}>
          <option value="">All tasks{tasks.length ? ` (${tasks.length})` : ""}</option>
          {tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.title} ({task.runs})</option>)}
        </select>
      </div>
      {error ? <p className="nous-muted" role="alert">{error}</p> : null}
      {runs === null && !error ? <DockState kind="loading" title="Loading the task runs" /> : null}
      {runs?.length === 0 ? (filter.status === "ALL" && !filter.taskId
        ? <DockState kind="empty" icon={CalendarCheck} title="No task runs yet" detail="Every time a scheduled task runs from your Tasks calendar, it appears here with whether it succeeded." />
        : <DockState kind="empty" icon={CalendarCheck} title="No runs match these filters" />) : null}
      {runs?.map((run) => {
        const where = [run.roomName, run.paneName].filter(Boolean).join(" / ");
        return (
          <article key={run.id} className="nous-request nous-task-run" aria-label={`${run.taskTitle}: ${STATUS_LABELS[run.status]}`} data-run-id={run.id}>
            <div className="nous-request-meta">
              <time dateTime={run.at}>{formatUserTime(run.at, { withDate: true })}</time>
              <span className={`nous-request-status nous-task-run-status is-${run.status.toLowerCase()}`}>{STATUS_LABELS[run.status]}</span>
            </div>
            <button type="button" className="nous-task-run-task" title="Show only this task's runs"
              onClick={() => setFilter((current) => ({ ...current, taskId: run.taskId }))}>{run.taskTitle}</button>
            {where ? <p className="nous-muted nous-task-run-where">{where}</p> : null}
            <p className="nous-task-run-detail">{run.detail}</p>
            {run.report ? (
              <p className="nous-task-run-report">
                <span className="nous-muted">Pane reported{run.reportAt ? ` at ${formatUserTime(run.reportAt)}` : ""}: </span>{run.report}
              </p>
            ) : null}
          </article>
        );
      })}
      {list?.hasMore && runs?.length ? <DockButton className="nous-load-earlier" busy={loadingEarlier} disabled={loadingEarlier} onClick={() => void loadEarlier()}>Load earlier runs</DockButton> : null}
    </div>
  );
}
