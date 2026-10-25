import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MaintenanceAutopilotRun,
  MaintenanceAutopilotScheduleUpdate,
  MaintenanceAutopilotStatus,
  MaintenanceAutopilotStep,
  MaintenanceAutopilotStepId
} from "@space/contracts";
import { api } from "../../api.js";
import { AlertTriangle, CheckCircle2, Clock, Loader2, Play, XCircle } from "../ui-theme/app-icons.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { errorMessage } from "./admin-operation-utils.js";
import "./maintenance-hub.css";

export interface MaintenanceHubClient {
  maintenanceAutopilotStatus(): Promise<MaintenanceAutopilotStatus>;
  startMaintenanceAutopilot(): Promise<MaintenanceAutopilotStatus>;
  updateMaintenanceAutopilotSchedule(input: MaintenanceAutopilotScheduleUpdate): Promise<MaintenanceAutopilotStatus>;
}

const stepCopy: Record<MaintenanceAutopilotStepId, { label: string; idle: string }> = {
  cleanup: { label: "Clean up storage", idle: "Empty tasks, orphaned pane homes and temporary files." },
  memory: { label: "Free memory", idle: "Stops leftover CLIs of closed panes and releases cache under memory pressure." },
  check: { label: "Check health", idle: "Space and every enabled CLI." },
  update: { label: "Update & repair", idle: "Updates every CLI that needs it and applies recommended repairs. Custom code is verified and Space settings re-applied; a failed update rolls back." }
};
const stepOrder: MaintenanceAutopilotStepId[] = ["cleanup", "memory", "check", "update"];
const pollMs = 2_000;

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function hourLabel(hour: number): string {
  return `${String(hour).padStart(2, "0")}:00`;
}

function relativeTime(iso: string | null, now: number): string {
  if (!iso) return "";
  const elapsed = now - Date.parse(iso);
  if (!Number.isFinite(elapsed)) return "";
  const minutes = Math.round(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function nextRunLabel(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function StepIcon({ status }: { status: MaintenanceAutopilotStep["status"] }) {
  if (status === "RUNNING") return <Loader2 className="maintenance-hub-spin" aria-hidden="true" />;
  if (status === "DONE") return <CheckCircle2 aria-hidden="true" />;
  if (status === "WARNING") return <AlertTriangle aria-hidden="true" />;
  if (status === "FAILED") return <XCircle aria-hidden="true" />;
  return <Clock aria-hidden="true" />;
}

const statusWord: Record<MaintenanceAutopilotStep["status"], string> = {
  PENDING: "Waiting",
  RUNNING: "Running",
  DONE: "Done",
  SKIPPED: "Skipped",
  WARNING: "Needs attention",
  FAILED: "Failed"
};

/** One tap runs every safe maintenance step on the server; a toggle repeats it nightly. */
export function MaintenanceHub({ client = api, onOpenTool }: {
  client?: MaintenanceHubClient;
  onOpenTool?: (id: string) => void;
}) {
  const [status, setStatus] = useState<MaintenanceAutopilotStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const mounted = useRef(true);
  const running = Boolean(status?.currentRun);

  const load = useCallback(async () => {
    try {
      const next = await client.maintenanceAutopilotStatus();
      if (!mounted.current) return;
      setStatus(next);
      setNow(Date.now());
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, "Maintenance status could not be loaded."));
    }
  }, [client]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => { mounted.current = false; };
  }, [load]);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, pollMs);
    const visibility = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [load, running]);

  async function start() {
    if (starting || running) return;
    setStarting(true);
    setError(null);
    try {
      const next = await client.startMaintenanceAutopilot();
      if (mounted.current) { setStatus(next); setNow(Date.now()); }
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, "Maintenance could not start."));
      void load();
    } finally {
      if (mounted.current) setStarting(false);
    }
  }

  async function saveSchedule(enabled: boolean, hour = status?.schedule.hour ?? 4) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const next = await client.updateMaintenanceAutopilotSchedule({ enabled, hour, timeZone: browserTimeZone() });
      if (mounted.current) setStatus(next);
    } catch (reason) {
      if (mounted.current) setError(errorMessage(reason, "The nightly schedule could not be saved."));
    } finally {
      if (mounted.current) setSaving(false);
    }
  }

  const run: MaintenanceAutopilotRun | null = status?.currentRun ?? status?.lastRun ?? null;
  const steps = stepOrder.map((id) => run?.steps.find((step) => step.id === id) ?? null);
  const activeIndex = status?.currentRun ? status.currentRun.steps.findIndex((step) => step.status === "RUNNING") : -1;
  const schedule = status?.schedule ?? null;
  const summary = !status
    ? "Loading maintenance status…"
    : status.currentRun
      ? `Running step ${Math.max(activeIndex, 0) + 1} of ${stepOrder.length}. You can close this window; maintenance keeps running.`
      : status.lastRun
        ? `${status.lastRun.trigger === "SCHEDULED" ? "Nightly run" : "Last run"} ${relativeTime(status.lastRun.finishedAt ?? status.lastRun.startedAt, now)} · ${status.lastRun.summary}`
        : "Not run yet. One tap runs every step below.";
  const needsReview = !status?.currentRun && status?.lastRun && status.lastRun.status !== "SUCCEEDED";
  const otherZone = schedule && schedule.timeZone !== browserTimeZone() ? ` (${schedule.timeZone})` : "";

  return (
    <section className="maintenance-hub" aria-label="One-tap maintenance" aria-busy={starting || saving}>
      <div className="maintenance-hub-head">
        <div>
          <h3>Run maintenance</h3>
          <p>One tap cleans storage, frees memory, checks every enabled CLI and applies safe updates and repairs with automatic rollback. CLIs of open panes and task history are never touched.</p>
        </div>
        <button type="button" className="maintenance-hub-run" disabled={!status || starting || running} onClick={() => void start()}>
          {running || starting ? <Loader2 className="maintenance-hub-spin" aria-hidden="true" /> : <Play aria-hidden="true" />}
          {running ? "Running…" : starting ? "Starting…" : "Run maintenance"}
        </button>
      </div>
      <p className="maintenance-hub-summary" role="status" aria-live="polite" data-status={run?.status ?? "IDLE"}>{summary}</p>
      {error ? <p className="maintenance-hub-error" role="alert">{error}</p> : null}
      <ol className="maintenance-hub-steps" aria-label="Maintenance steps">
        {stepOrder.map((id, index) => {
          const step = steps[index];
          const stepStatus = step?.status ?? "PENDING";
          const detail = !step || (!status?.currentRun && !status?.lastRun) ? stepCopy[id].idle : step.summary;
          return (
            <li key={id} data-status={step ? stepStatus : "IDLE"}>
              {step ? <StepIcon status={stepStatus} /> : <span className="maintenance-hub-dot" aria-hidden="true">{index + 1}</span>}
              <span>
                <strong>{stepCopy[id].label}{step ? <em> · {statusWord[stepStatus]}</em> : null}</strong>
                <small>{detail}</small>
              </span>
            </li>
          );
        })}
      </ol>
      {needsReview && onOpenTool ? (
        <button type="button" className="maintenance-hub-link" onClick={() => onOpenTool("space-cli-maintenance")}>
          Open check & repair details
        </button>
      ) : null}
      <div className="maintenance-hub-schedule">
        <SpaceToggle
          name="maintenance-autopilot-nightly"
          label="Run automatically every night"
          detail={schedule?.enabled
            ? `Next run ${nextRunLabel(schedule.nextRunAt)}${otherZone}. The same safe steps; history is never purged automatically.`
            : "The same safe steps, while you sleep. History is never purged automatically."}
          checked={Boolean(schedule?.enabled)}
          disabled={!schedule || saving}
          onChange={(checked) => void saveSchedule(checked)}
        />
        {schedule?.enabled ? (
          <label className="maintenance-hub-hour">
            Time
            <select
              aria-label="Nightly maintenance time"
              value={schedule.hour}
              disabled={saving}
              onChange={(event) => void saveSchedule(true, Number(event.currentTarget.value))}
            >
              {Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{hourLabel(hour)}</option>)}
            </select>
          </label>
        ) : null}
      </div>
    </section>
  );
}
