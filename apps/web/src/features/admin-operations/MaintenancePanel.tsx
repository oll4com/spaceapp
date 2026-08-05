import {
  adminOperationRunSchema,
  cliMaintenanceEventSchema,
  type AdminOperationRun,
  type CliMaintenanceAuthHandoff,
  type CliMaintenanceEvent,
  type CliMaintenanceRequest
} from "@space/contracts";
import {
  Download,
  ExternalLink,
  History,
  Loader2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wrench
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dispatchCliRecoveryOpened } from "../../cli-recovery-events.js";
import type {
  CliMaintenanceRecoveryPayload,
  CliMaintenanceReplayPayload
} from "../../live-api.js";
import { activeOperationStatuses, errorMessage } from "./admin-operation-utils.js";

export interface MaintenanceClient {
  listCliMaintenanceRuns(): Promise<{ data: AdminOperationRun[] }>;
  getCliMaintenanceReplay(runId: string, afterSequence?: number): Promise<CliMaintenanceReplayPayload>;
  openCliMaintenanceStream(runId: string, afterSequence?: number): EventSource | null;
  cliMaintenanceExportUrl(runId: string): string;
  openCliMaintenanceRecovery(): Promise<CliMaintenanceRecoveryPayload>;
  startCliMaintenance(input: CliMaintenanceRequest): Promise<AdminOperationRun>;
}

function runtimeResults(run: AdminOperationRun | undefined): Array<Record<string, unknown>> {
  const value = run?.result.runtimes;
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

function mergeEvent(current: CliMaintenanceEvent[], event: CliMaintenanceEvent): CliMaintenanceEvent[] {
  if (current.some((candidate) => candidate.id === event.id || candidate.sequence === event.sequence)) return current;
  return [...current, event].sort((left, right) => left.sequence - right.sequence);
}

function isUnresolvedHandoff(handoff: CliMaintenanceAuthHandoff): boolean {
  return handoff.status === "PENDING" ||
    handoff.status === "OPENED" ||
    (handoff.status === "FAILED" && handoff.attemptCount < 10);
}

function parseStreamData(event: Event): unknown {
  if (!(event instanceof MessageEvent) || typeof event.data !== "string") return null;
  try {
    return JSON.parse(event.data);
  } catch {
    return null;
  }
}

function isMaintenanceEvent(value: unknown): value is CliMaintenanceEvent {
  return cliMaintenanceEventSchema.safeParse(value).success;
}

function isAdminOperationRun(value: unknown): value is AdminOperationRun {
  return adminOperationRunSchema.safeParse(value).success;
}

export function MaintenancePanel({
  client,
  onBusyChange
}: {
  client: MaintenanceClient;
  onBusyChange: (busy: boolean) => void;
}) {
  const [runs, setRuns] = useState<AdminOperationRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [events, setEvents] = useState<CliMaintenanceEvent[]>([]);
  const [handoffs, setHandoffs] = useState<CliMaintenanceAuthHandoff[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
  const latestSequenceRef = useRef(0);
  const latest = runs[0];
  const selected = runs.find((run) => run.id === selectedRunId) ?? latest;
  const hasActiveRun = runs.some((run) => activeOperationStatuses.has(run.status));
  const hasUnresolvedHandoff = handoffs.some(isUnresolvedHandoff);
  const shouldStreamSelected = Boolean(
    selected &&
    (activeOperationStatuses.has(selected.status) ||
      (selected.status === "PARTIAL" && hasUnresolvedHandoff))
  );
  const results = useMemo(() => runtimeResults(selected), [selected]);

  const loadReplay = useCallback(async (runId: string) => {
    const replay = await client.getCliMaintenanceReplay(runId, 0);
    latestSequenceRef.current = replay.events.at(-1)?.sequence ?? 0;
    setEvents(replay.events);
    setHandoffs(replay.authHandoffs);
    setRuns((current) => current.map((run) => run.id === replay.run.id ? replay.run : run));
    return replay;
  }, [client]);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const nextRuns = (await client.listCliMaintenanceRuns()).data;
      setRuns(nextRuns);
      const nextRunId = nextRuns.some((run) => run.id === selectedRunId)
        ? selectedRunId
        : nextRuns[0]?.id ?? null;
      setSelectedRunId(nextRunId);
      if (nextRunId) await loadReplay(nextRunId);
      else {
        setEvents([]);
        setHandoffs([]);
        latestSequenceRef.current = 0;
      }
    } catch (reason) {
      setError(errorMessage(reason, "Maintenance history could not be loaded."));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [client, loadReplay, selectedRunId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onBusyChange(starting || recovering);
  }, [onBusyChange, recovering, starting]);

  useEffect(() => {
    if (!selected?.id || !shouldStreamSelected) return;
    const source = client.openCliMaintenanceStream(selected.id, latestSequenceRef.current);
    if (!source) {
      setStreamError("Live stream is unavailable in this browser; durable replay refresh remains active.");
      return;
    }
    setStreamError(null);
    const handleProgress = (event: Event) => {
      const parsed = parseStreamData(event);
      if (!isMaintenanceEvent(parsed)) return;
      latestSequenceRef.current = Math.max(latestSequenceRef.current, parsed.sequence);
      setEvents((current) => mergeEvent(current, parsed));
    };
    const handleRun = (event: Event) => {
      const parsed = parseStreamData(event);
      if (!isAdminOperationRun(parsed)) return;
      setRuns((current) =>
        [parsed, ...current.filter((run) => run.id !== parsed.id)]
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      );
      if (parsed.status === "PARTIAL") {
        void loadReplay(parsed.id)
          .then((replay) => {
            if (!replay.authHandoffs.some(isUnresolvedHandoff)) source.close();
          })
          .catch(() => {
            setStreamError("Live progress could not refresh the provider-login handoff; durable replay remains available.");
          });
      } else if (!activeOperationStatuses.has(parsed.status)) {
        source.close();
      }
    };
    const handleReady = () => {
      setStreamError(null);
    };
    const handleStreamError = () => {
      setStreamError("Live progress is reconnecting; all events remain available through durable replay.");
    };
    source.addEventListener("ready", handleReady);
    source.addEventListener("progress", handleProgress);
    source.addEventListener("run", handleRun);
    source.addEventListener("stream-error", handleStreamError);
    source.addEventListener("error", handleStreamError);
    return () => source.close();
  }, [client, loadReplay, selected?.id, shouldStreamSelected]);

  useEffect(() => {
    if (!hasActiveRun && !hasUnresolvedHandoff) return;
    const timer = window.setInterval(() => void load(false), 2_000);
    return () => window.clearInterval(timer);
  }, [hasActiveRun, hasUnresolvedHandoff, load]);

  async function start(input: CliMaintenanceRequest) {
    if (starting || hasActiveRun) return;
    setStarting(true);
    setError(null);
    setRecoveryNotice(null);
    try {
      const run = await client.startCliMaintenance(input);
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
      setSelectedRunId(run.id);
      setEvents([]);
      setHandoffs([]);
      latestSequenceRef.current = 0;
    } catch (reason) {
      setError(errorMessage(reason, "The health and repair run could not be started."));
    } finally {
      setStarting(false);
    }
  }

  async function selectRun(runId: string) {
    setSelectedRunId(runId);
    setError(null);
    try {
      await loadReplay(runId);
    } catch (reason) {
      setError(errorMessage(reason, "The selected maintenance run could not be replayed."));
    }
  }

  async function openRecovery() {
    if (recovering) return;
    setRecovering(true);
    setError(null);
    try {
      const recovery = await client.openCliMaintenanceRecovery();
      if (!recovery.room) {
        setRecoveryNotice("No provider login handoff is pending.");
        return;
      }
      const firstPaneId = recovery.loginPanes.find((pane) => pane.paneId)?.paneId ?? null;
      dispatchCliRecoveryOpened({ roomId: recovery.room.id, paneId: firstPaneId });
      setRecoveryNotice(
        recovery.status === "OPENED"
          ? "CLI Recovery is open with the pending provider login flows."
          : "CLI Recovery is available, but one or more login flows need a retry."
      );
      if (selected?.id) await loadReplay(selected.id);
    } catch (reason) {
      setError(errorMessage(reason, "CLI Recovery could not be opened."));
    } finally {
      setRecovering(false);
    }
  }

  return (
    <div className="admin-operation-panel">
      <div className="admin-operation-callout">
        <ShieldCheck aria-hidden="true" />
        <p>
          One guarded run checks Space and every managed CLI, repairs tracked configuration and MCP settings,
          installs stable releases atomically, verifies activation, rolls back failures and hands provider login to CLI Recovery.
        </p>
      </div>

      <div className="admin-operation-actions-grid single">
        <section>
          <Wrench aria-hidden="true" />
          <div>
            <strong>Health & repair</strong>
            <small>Codex, Claude, Gemini, OpenCode, Autohand, Qwen, Kimi, Grok, DeepSeek, Cursor and Copilot run sequentially without interrupting existing sessions.</small>
          </div>
          <button
            type="button"
            className="admin-operation-primary"
            disabled={starting || hasActiveRun}
            onClick={() => void start({ mode: "REPAIR" })}
            aria-label="Run Space and CLI health and repair"
          >
            {starting ? <Loader2 className="spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
            Run health & repair
          </button>
        </section>
      </div>

      <section className="admin-operation-history" aria-label="CLI maintenance history">
        <header>
          <span>
            <strong>Durable run history</strong>
            <small>{runs.length ? `${runs.length} retained runs` : "No maintenance run recorded yet."}</small>
          </span>
          <button
            type="button"
            aria-label="Refresh CLI maintenance history"
            disabled={loading || starting}
            onClick={() => void load()}
          >
            {loading ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
          </button>
        </header>
        {runs.length ? (
          <div className="admin-operation-run-list" role="list">
            {runs.slice(0, 20).map((run) => (
              <button
                type="button"
                role="listitem"
                className={run.id === selected?.id ? "selected" : ""}
                key={run.id}
                onClick={() => void selectRun(run.id)}
              >
                <span className={`admin-operation-status ${run.status.toLowerCase()}`}>{run.status}</span>
                <strong>{run.operationType === "CLI_MAINTENANCE_REPAIR" ? "Health & repair" : run.operationType}</strong>
                <small>{run.updatedAt}</small>
              </button>
            ))}
          </div>
        ) : <p className="admin-operation-empty">Run health & repair to create the first durable result.</p>}
      </section>

      {selected ? (
        <>
          <section className="admin-operation-history" aria-label="Selected maintenance run">
            <header>
              <span>
                <strong>{selected.summary}</strong>
                <small>{selected.id} · {selected.updatedAt}</small>
              </span>
              <span className="admin-operation-inline-actions">
                {shouldStreamSelected ? (
                  <span className="admin-operation-live"><Radio aria-hidden="true" /> Live</span>
                ) : null}
                <a
                  href={client.cliMaintenanceExportUrl(selected.id)}
                  download
                  aria-label="Export redacted maintenance JSON"
                >
                  <Download aria-hidden="true" />
                  Export JSON
                </a>
              </span>
            </header>
            {results.length ? (
              <div className="admin-operation-result-list">
                {results.map((result, index) => (
                  <div key={`${String(result.runtimeId ?? "runtime")}-${index}`}>
                    <strong>{String(result.displayName ?? result.runtimeId ?? "Runtime")}</strong>
                    <span>{String(result.outcome ?? result.status ?? "UNKNOWN")}</span>
                    <small>{String(result.summary ?? result.code ?? "")}</small>
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          <section className="admin-operation-history admin-operation-timeline" aria-label="Live repair timeline">
            <header>
              <span>
                <strong>Live repair timeline</strong>
                <small>{events.length ? `${events.length} ordered events · last #${events.at(-1)?.sequence}` : "Waiting for the first stage."}</small>
              </span>
              <History aria-hidden="true" />
            </header>
            {events.length ? (
              <ol>
                {events.map((event) => (
                  <li key={event.id} className={event.severity.toLowerCase()}>
                    <span>#{event.sequence}</span>
                    <div>
                      <strong>{event.runtimeId ?? "Space"} · {event.phase}</strong>
                      <small>{event.code} · {event.state}{event.durationMs === null ? "" : ` · ${event.durationMs} ms`}</small>
                      <p>{event.message}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : <p className="admin-operation-empty">No durable events are available for this run yet.</p>}
          </section>

          {handoffs.length ? (
            <section className="admin-operation-history admin-operation-recovery" aria-label="CLI Recovery handoffs">
              <header>
                <span>
                  <strong>Provider login handoff</strong>
                  <small>{handoffs.length} login flow{handoffs.length === 1 ? "" : "s"} preserved for CLI Recovery.</small>
                </span>
                <button type="button" disabled={recovering} onClick={() => void openRecovery()}>
                  {recovering ? <Loader2 className="spin" aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}
                  Open CLI Recovery
                </button>
              </header>
              <div className="admin-operation-result-list">
                {handoffs.map((handoff) => (
                  <div key={handoff.id}>
                    <strong>{handoff.runtimeId}</strong>
                    <span>{handoff.status}</span>
                    <small>Attempts: {handoff.attemptCount}{handoff.safeErrorCode ? ` · ${handoff.safeErrorCode}` : ""}</small>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}

      {streamError ? <p className="admin-operation-alert" role="status">{streamError}</p> : null}
      {recoveryNotice ? <p className="admin-operation-alert success" role="status">{recoveryNotice}</p> : null}
      {error ? <p className="admin-operation-alert error" role="alert">{error}</p> : null}
    </div>
  );
}
