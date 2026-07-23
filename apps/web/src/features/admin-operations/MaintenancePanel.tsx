import type { AdminOperationRun, CliMaintenanceRequest } from "@space/contracts";
import { CheckCircle2, Loader2, RefreshCw, ShieldCheck, Wrench } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { activeOperationStatuses, errorMessage } from "./admin-operation-utils.js";

export interface MaintenanceClient {
  listCliMaintenanceRuns(): Promise<{ data: AdminOperationRun[] }>;
  startCliMaintenance(input: CliMaintenanceRequest): Promise<AdminOperationRun>;
}

function runtimeResults(run: AdminOperationRun | undefined): Array<Record<string, unknown>> {
  const value = run?.result.runtimes;
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object")
    : [];
}

export function MaintenancePanel({
  client,
  onBusyChange
}: {
  client: MaintenanceClient;
  onBusyChange: (busy: boolean) => void;
}) {
  const [runs, setRuns] = useState<AdminOperationRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [starting, setStarting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const latest = runs[0];
  const hasActiveRun = runs.some((run) => activeOperationStatuses.has(run.status));
  const results = useMemo(() => runtimeResults(latest), [latest]);

  const load = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      setRuns((await client.listCliMaintenanceRuns()).data);
    } catch (reason) {
      setError(errorMessage(reason, "Maintenance history could not be loaded."));
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onBusyChange(starting);
  }, [onBusyChange, starting]);

  useEffect(() => {
    if (!hasActiveRun) return;
    const timer = window.setTimeout(() => void load(false), 2_000);
    return () => window.clearTimeout(timer);
  }, [hasActiveRun, latest?.updatedAt, load]);

  async function start(input: CliMaintenanceRequest) {
    if (starting || hasActiveRun) return;
    setStarting(true);
    setError(null);
    try {
      const run = await client.startCliMaintenance(input);
      setRuns((current) => [run, ...current.filter((candidate) => candidate.id !== run.id)]);
      setConfirmation("");
    } catch (reason) {
      setError(errorMessage(reason, "The maintenance operation could not be started."));
    } finally {
      setStarting(false);
    }
  }

  return (
    <div className="admin-operation-panel">
      <div className="admin-operation-callout">
        <ShieldCheck aria-hidden="true" />
        <p>
          Health checks inspect Space plus doctor, authentication, installed version and current stable version for every managed CLI.
          Updates run sequentially with pre-switch verification and automatic rollback.
        </p>
      </div>

      <div className="admin-operation-actions-grid">
        <section>
          <CheckCircle2 aria-hidden="true" />
          <div>
            <strong>Health and doctor</strong>
            <small>Read-only check for Space, Codex, Claude, Gemini, OpenCode, Qwen, Kimi, Grok and DeepSeek.</small>
          </div>
          <button
            type="button"
            disabled={starting || hasActiveRun}
            onClick={() => void start({ mode: "CHECK" })}
            aria-label="Run Space and CLI health check"
          >
            {starting ? <Loader2 className="spin" aria-hidden="true" /> : null}
            Run health check
          </button>
        </section>

        <section>
          <Wrench aria-hidden="true" />
          <div>
            <strong>Update all CLI apps</strong>
            <small>Discover and install each current stable release without interrupting existing sessions.</small>
          </div>
          <label>
            <span>Type <code>UPDATE ALL CLI APPS</code> to confirm</span>
            <input
              aria-label="Type UPDATE ALL CLI APPS to confirm"
              autoComplete="off"
              spellCheck={false}
              value={confirmation}
              disabled={starting || hasActiveRun}
              onChange={(event) => setConfirmation(event.currentTarget.value)}
            />
          </label>
          <button
            type="button"
            className="warning"
            disabled={starting || hasActiveRun || confirmation !== "UPDATE ALL CLI APPS"}
            onClick={() => void start({ mode: "UPDATE", confirmation: "UPDATE ALL CLI APPS" })}
            aria-label="Update all CLI apps"
          >
            {starting ? <Loader2 className="spin" aria-hidden="true" /> : null}
            Update all CLI apps
          </button>
        </section>
      </div>

      <section className="admin-operation-history" aria-label="CLI maintenance history">
        <header>
          <span>
            <strong>Latest maintenance run</strong>
            <small>{latest ? latest.updatedAt : "No maintenance run recorded yet."}</small>
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
        {latest ? (
          <>
            <div className="admin-operation-run-summary">
              <span className={`admin-operation-status ${latest.status.toLowerCase()}`}>{latest.status}</span>
              <p>{latest.summary}</p>
            </div>
            {results.length ? (
              <div className="admin-operation-result-list">
                {results.map((result, index) => (
                  <div key={`${String(result.runtimeId ?? "runtime")}-${index}`}>
                    <strong>{String(result.displayName ?? result.runtimeId ?? "Runtime")}</strong>
                    <span>{String(result.status ?? "UNKNOWN")}</span>
                    <small>{String(result.summary ?? result.code ?? "")}</small>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        ) : <p className="admin-operation-empty">Run a health check to create the first durable result.</p>}
      </section>

      {error ? <p className="admin-operation-alert error" role="alert">{error}</p> : null}
    </div>
  );
}
