import type { DeployQueueBatch, DeployQueueReport, DeployQueueTicket } from "@space/contracts";
import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { api } from "../../api.js";
import { Check, ChevronRight, Rocket } from "../ui-theme/app-icons.js";
import { elapsed, relative, statusLabel, statusTone, submitterView, type DeployQueueClient, type SubmitterView } from "./deploy-queue-format.js";
import "./deploy-activity.css";

const POLL_MS = 5_000;
const RECENT_LIMIT = 5;
const STEPS = [
  { phase: "INTEGRATING", label: "Merge" },
  { phase: "VERIFYING", label: "Build" },
  { phase: "DEPLOYING", label: "Deploy" }
] as const;
const PHASE_TEXT: Record<string, string> = { INTEGRATING: "Merging", VERIFYING: "Building", DEPLOYING: "Deploying", READY: "Built, deploys next" };

function headline(report: DeployQueueReport): { tone: string; label: string } {
  if (!report.available) return { tone: "idle", label: "Not installed" };
  if (report.paused) return { tone: "warn", label: "Paused" };
  if (!report.daemonRunning) return { tone: "bad", label: "Queue stopped" };
  if (report.current) return { tone: "busy", label: "Running" };
  if (report.active.length) return { tone: "idle", label: "Waiting" };
  return { tone: "ok", label: "Idle" };
}

function CliMark({ view, size = "md" }: { view: SubmitterView; size?: "sm" | "md" }) {
  return (
    <span className={`deploy-activity-cli-mark is-${size}`} aria-hidden="true">
      {view.iconSrc ? <img src={view.iconSrc} alt="" /> : <span>{(view.cli ?? "?").slice(0, 1).toUpperCase()}</span>}
    </span>
  );
}

/** Who submitted the change: the pane name first, then the CLI that ran in it and its room. */
function Submitter({ ticket }: { ticket: DeployQueueTicket }) {
  const view = submitterView(ticket.submitter);
  const name = view.pane ?? view.cli ?? "Outside Space";
  const detail = [view.pane ? view.cli : view.cli ? "Pane closed" : "Submitted from a shell", view.room].filter(Boolean).join(" · ");
  return (
    <div className="deploy-activity-ticket">
      <CliMark view={view} />
      <div className="deploy-activity-ticket-body">
        <div className="deploy-activity-ticket-who">
          <strong title={name}>{name}</strong>
          {detail ? <span>{detail}</span> : null}
        </div>
        <p className="deploy-activity-ticket-summary" title={ticket.summary || ticket.branch}>{ticket.summary || ticket.branch}</p>
        <code className="deploy-activity-ticket-branch" title={ticket.branch}>{ticket.branch}</code>
      </div>
    </div>
  );
}

function RunningBatch({ batch, tickets, now }: { batch: DeployQueueBatch; tickets: DeployQueueTicket[]; now: number }) {
  const step = STEPS.findIndex(item => item.phase === batch.phase);
  const total = elapsed(batch.batchStartedAt, now);
  const phase = elapsed(batch.phaseStartedAt, now);
  const phaseText = PHASE_TEXT[batch.phase] ?? batch.phase.toLowerCase();
  return (
    <div className="deploy-activity-run" role="group" aria-label="Running deploy">
      <span className="deploy-activity-run-bar" aria-hidden="true" />
      <div className="deploy-activity-run-head">
        <span className="deploy-activity-run-phase">
          {phaseText}
          {phase ? <span className="deploy-activity-run-phase-time" title="Time in this step" aria-label={`${phaseText} for ${phase}`}>{phase}</span> : null}
        </span>
        {total ? <span className="deploy-activity-run-clock" title="Time since this deploy started" aria-label={`Running for ${total}`}>{total}</span> : null}
      </div>
      <ol className="deploy-activity-steps" aria-label="Deploy steps">
        {STEPS.map((item, index) => {
          const state = step < 0 ? "todo" : index < step ? "done" : index === step ? "current" : "todo";
          return (
            <li key={item.phase} className={`is-${state}`} aria-current={state === "current" ? "step" : undefined}>
              <span className="deploy-activity-step-mark" aria-hidden="true">{state === "done" ? <Check size={11} /> : index + 1}</span>
              <span className="deploy-activity-step-label">{item.label}</span>
            </li>
          );
        })}
      </ol>
      {tickets.length ? tickets.map(ticket => <Submitter key={ticket.id} ticket={ticket} />)
        : <p className="deploy-activity-muted">{batch.ticketIds.length} change{batch.ticketIds.length === 1 ? "" : "s"} in this batch.</p>}
      <div className="deploy-activity-run-foot">
        <span>Batch <code>{batch.batchId}</code></span>
        {batch.candidate ? <span>Commit <code>{batch.candidate.slice(0, 10)}</code></span> : null}
      </div>
    </div>
  );
}

function TicketRow({ ticket, now, position, prepared }: { ticket: DeployQueueTicket; now: number; position?: number; prepared?: boolean }) {
  const view = submitterView(ticket.submitter);
  const waiting = ticket.status === "QUEUED";
  const name = view.pane ?? view.cli ?? "Outside Space";
  const time = waiting ? elapsed(ticket.submittedAt, now) : relative(ticket.statusSince ?? ticket.updatedAt, now);
  return (
    <li className="deploy-activity-row" data-status={ticket.status}>
      {position ? <span className="deploy-activity-row-position" aria-label={`Position ${position}`}>{position}</span> : null}
      <CliMark view={view} size="sm" />
      <div className="deploy-activity-row-body">
        <span className="deploy-activity-row-who">
          <strong title={name}>{name}</strong>
          {view.pane && view.cli ? <span>{view.cli}</span> : null}
        </span>
        <span className="deploy-activity-row-summary" title={ticket.summary || ticket.branch}>{ticket.summary || ticket.branch}</span>
      </div>
      <span className="deploy-activity-row-side">
        {!waiting ? <span className={`deploy-activity-chip tone-${statusTone[ticket.status]}`}>{prepared && ticket.status === "VERIFYING" ? "Next" : statusLabel[ticket.status]}</span> : null}
        {time ? <span className="deploy-activity-row-time" title={waiting ? "Waiting time" : "Updated"}>{waiting ? `waiting ${time}` : time}</span> : null}
      </span>
    </li>
  );
}

export interface DeployActivityPanelProps {
  client?: DeployQueueClient;
  /** False while the hosting dock is hidden: nothing polls then. */
  active?: boolean;
  /** Changing it reloads at once (the dock's Refresh). */
  refreshKey?: number;
}

/** Live view of the merge-queue deploy: what runs now, who submitted it, for how long, and what waits. */
export function DeployActivityPanel({ client = api, active = true, refreshKey = 0 }: DeployActivityPanelProps) {
  const [report, setReport] = useState<DeployQueueReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [open, setOpen] = useState(true);
  const loading = useRef(false);
  const bodyId = useId();

  const load = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      setReport(await client.deployQueue());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Deploy status could not load.");
    } finally {
      loading.current = false;
      setNow(Date.now());
    }
  }, [client]);

  useEffect(() => {
    if (!active) return;
    const run = () => { if (document.visibilityState !== "hidden") void load(); };
    run();
    const timer = window.setInterval(run, POLL_MS);
    document.addEventListener("visibilitychange", run);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", run); };
  }, [active, load]);

  useEffect(() => { if (refreshKey && active) void load(); }, [refreshKey, active, load]);

  // The clocks tick every second only while something runs or waits and the dock is shown.
  const ticking = active && !!report && (report.current !== null || report.active.length > 0);
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [ticking]);

  const state = report ? headline(report) : error ? { tone: "bad", label: "Unavailable" } : { tone: "idle", label: "Loading…" };
  const current = report?.current ?? null;
  const inCurrent = new Set(current?.ticketIds ?? []);
  const inNext = new Set(report?.next?.ticketIds ?? []);
  const byId = new Map((report?.active ?? []).map(ticket => [ticket.id, ticket]));
  const running = current ? current.ticketIds.map(id => byId.get(id)).filter((ticket): ticket is DeployQueueTicket => Boolean(ticket)) : [];
  const waiting = (report?.active ?? []).filter(ticket => !inCurrent.has(ticket.id));
  const recent = (report?.recent ?? []).filter(ticket => ticket.status !== "CANCELLED").slice(0, RECENT_LIMIT);
  // While open, the running batch shows its own clock; the header repeats it only when folded.
  const headerMeta = current ? (open ? null : elapsed(current.batchStartedAt, now)) : waiting.length ? `${waiting.length} waiting` : recent[0] ? `last ${relative(recent[0].updatedAt, now)}` : null;

  return (
    <section className={`deploy-activity tone-${state.tone}${open ? " is-open" : ""}`} aria-label="Deploys">
      <button type="button" className="deploy-activity-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(value => !value)}>
        <ChevronRight className="deploy-activity-chevron" size={14} aria-hidden="true" />
        <Rocket className="deploy-activity-icon" size={14} aria-hidden="true" />
        <span className="deploy-activity-title">Deploys</span>
        <span className={`deploy-activity-pill tone-${state.tone}`}>
          {state.tone === "busy" ? <span className="deploy-activity-dot" aria-hidden="true" /> : null}{state.label}
        </span>
        {headerMeta ? <span className="deploy-activity-toggle-meta">{headerMeta}</span> : null}
      </button>
      {open ? (
        <div className="deploy-activity-body" id={bodyId}>
          {error ? <p className="deploy-activity-error" role="alert">{error}</p> : null}
          {report?.paused ? <p className="deploy-activity-warning">Paused: {report.paused.reason}</p> : null}
          {report && report.available && !report.daemonRunning && !report.paused
            ? <p className="deploy-activity-warning">The merge queue service has not reported a heartbeat recently.</p> : null}
          {report && !report.available ? <p className="deploy-activity-muted">The merge queue has no state on this server.</p> : null}

          {current ? <RunningBatch batch={current} tickets={running} now={now} />
            : report?.available ? <p className="deploy-activity-muted">No deploy is running.</p> : null}

          {waiting.length ? (
            <div className="deploy-activity-group">
              <h4>Up next <span>{waiting.length}</span></h4>
              <ol className="deploy-activity-list">
                {waiting.map((ticket, index) => (
                  <TicketRow key={ticket.id} ticket={ticket} now={now} position={index + 1} prepared={inNext.has(ticket.id)} />
                ))}
              </ol>
            </div>
          ) : null}

          {recent.length ? (
            <details className="deploy-activity-group deploy-activity-recent">
              <summary><h4>Recent <span>{recent.length}</span></h4></summary>
              <ul className="deploy-activity-list">
                {recent.map(ticket => <TicketRow key={ticket.id} ticket={ticket} now={now} />)}
              </ul>
            </details>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
