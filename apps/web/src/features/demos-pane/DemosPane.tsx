import { usePanePolling } from "../../use-pane-polling.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DemoConnection,
  DemoLogEntry,
  DemoOperation,
  DemoRun,
  DemoSelection,
  DemoSheetsTarget,
  DemoStateResponse,
  DemoTestRun
} from "@space/contracts";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { CodeTab } from "./CodeTab.js";
import { ConnectionsTab } from "./ConnectionsTab.js";
import { GuideTab } from "./GuideTab.js";
import "./demos-pane.css";

export interface DemosPaneProps {
  isVisible?: boolean;
  pane: Pane;
  uiTheme?: string;
}

type TabKey = "overview" | "preview" | "code" | "guide" | "connections" | "logs" | "tests";

interface Notice {
  tone: "ok" | "error" | "warn";
  message: string;
}

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "overview", label: "Overview" },
  { key: "preview", label: "Preview" },
  { key: "code", label: "Code" },
  { key: "guide", label: "Guide & LOC" },
  { key: "connections", label: "Connections" },
  { key: "logs", label: "Logs" },
  { key: "tests", label: "Tests" }
];

const emptySheets: DemoSheetsTarget = {
  spreadsheetId: null,
  spreadsheetUrl: null,
  title: null,
  tab: null,
  verified: false,
  headerPresent: false,
  verifiedAt: null
};

function statusClass(status: string): string {
  return `demos-pill demos-${status.toLowerCase()}`;
}

function statusLabel(run: DemoRun | null, missingConnections: boolean): string {
  if (missingConnections && run?.mode === "LIVE" && (!run || run.status !== "RUNNING")) return "CONNECTION_REQUIRED";
  return run?.status ?? "STOPPED";
}

export function DemosPane({ pane, isVisible = true }: DemosPaneProps) {
  const [state, setState] = useState<DemoStateResponse | null>(null);
  const [selection, setSelection] = useState<DemoSelection | null>(null);
  const [tab, setTab] = useState<TabKey>("overview");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [logs, setLogs] = useState<DemoLogEntry[]>([]);
  const [tests, setTests] = useState<DemoTestRun | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [operations, setOperations] = useState<DemoOperation[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const logSeq = useRef(0);

  const applyState = useCallback((payload: DemoStateResponse) => {
    setState(payload);
    setSelection(payload.selection);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const payload = await api.demoState();
      applyState(payload);
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not read the Demo Projects state." });
    }
  }, [applyState]);

  usePanePolling(refresh, 5_000, isVisible && !pane.isMinimized);

  useEffect(() => {
    if (!selection) return undefined;
    let cancelled = false;
    void api
      .demoOperations(selection.projectId)
      .then((payload) => {
        if (!cancelled) setOperations(payload.data);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [refresh, selection?.projectId, state?.run?.id, state?.run?.startedAt]);

  usePanePolling(async (signal) => {
    const run = state?.run;
    if (!run) return;
    const payload = await api.demoRunLogs(run.id, logSeq.current);
    if (signal.aborted) return;
    logSeq.current = payload.nextSeq;
    if (payload.entries.length > 0) setLogs((current) => [...current, ...payload.entries].slice(-500));
  }, 2_000, isVisible && !pane.isMinimized && tab === "logs" && state?.run?.status === "RUNNING",
  true, `${state?.run?.id}:${state?.run?.status}:${previewNonce}`);

  const project = useMemo(
    () => state?.catalog.projects.find((candidate) => candidate.id === (selection?.projectId ?? state.selection.projectId)) ?? null,
    [selection?.projectId, state]
  );
  const variants = useMemo(
    () => state?.catalog.variants.filter((candidate) => candidate.projectId === project?.id) ?? [],
    [project?.id, state]
  );
  const variant = useMemo(() => variants.find((candidate) => candidate.id === selection?.variantId) ?? null, [selection?.variantId, variants]);
  const missingConnections = useMemo(() => {
    if (!project || !state) return false;
    return project.requiresConnections.some((provider) => {
      const connection = state.connections.find((candidate: DemoConnection) => candidate.provider === provider);
      return connection?.status !== "CONNECTED";
    });
  }, [project, state]);

  const updateSelection = useCallback(
    async (next: Partial<DemoSelection>) => {
      if (!selection) return;
      const candidate: DemoSelection = { ...selection, ...next };
      setSelection(candidate);
      setSelectedFile(null);
      setNotice(null);
      logSeq.current = 0;
      setLogs([]);
      try {
        await api.demoSaveSelection(candidate);
        await refresh();
      } catch (error) {
        setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not save the selection." });
      }
    },
    [refresh, selection]
  );

  const run = state?.run ?? null;
  const appliedStatus = statusLabel(run, missingConnections);
  const isRunning = run?.status === "RUNNING";

  async function start(): Promise<void> {
    if (!selection) return;
    setBusy("start");
    setNotice(null);
    logSeq.current = 0;
    setLogs([]);
    try {
      const payload = await api.demoStartRun(selection);
      applyState({ ...(state as DemoStateResponse), run: payload.run });
      setTab("preview");
      setNotice({ tone: "ok", message: "Start requested. The demo reports Running once the child service passes health checks." });
      await refresh();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start the demo.";
      setNotice({ tone: "warn", message });
      if (/connection/i.test(message)) setTab("connections");
    } finally {
      setBusy(null);
    }
  }

  async function stop(): Promise<void> {
    if (!run) return;
    setBusy("stop");
    try {
      const payload = await api.demoStopRun(run.id);
      applyState({ ...(state as DemoStateResponse), run: payload.run });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not stop the run." });
    } finally {
      setBusy(null);
    }
  }

  async function restart(): Promise<void> {
    if (!run) return;
    setBusy("restart");
    logSeq.current = 0;
    setLogs([]);
    try {
      const payload = await api.demoRestartRun(run.id);
      applyState({ ...(state as DemoStateResponse), run: payload.run });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not restart the run." });
    } finally {
      setBusy(null);
    }
  }

  async function runTests(): Promise<void> {
    if (!selection) return;
    setBusy("tests");
    setTab("tests");
    setNotice(null);
    try {
      const payload = await api.demoRunTests({ projectId: selection.projectId, variantId: selection.variantId });
      setTests(payload.testRun);
      setNotice({
        tone: payload.testRun.status === "PASSED" ? "ok" : "error",
        message: payload.testRun.status === "PASSED" ? "All checks passed against the running demo." : "Some checks failed; review the steps below."
      });
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not run the checks." });
    } finally {
      setBusy(null);
    }
  }

  async function retryOperation(operation: DemoOperation): Promise<void> {
    setBusy(operation.id);
    try {
      await api.demoRetryOperation(operation.id);
      setNotice({ tone: "ok", message: "Retry queued; only the missing external step is repeated." });
      await refresh();
    } catch (error) {
      setNotice({ tone: "error", message: error instanceof Error ? error.message : "Could not retry the operation." });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="demos-pane-container" data-space-pane-id={pane.id} data-demos-pane="true">
      {/* V2 Command Deck Header */}
      <div className="demos-v2-header">
        <div className="demos-header-top-row">
          <div className="demos-selector-group">
            <div className="demos-select-field">
              <span className="demos-field-label">PROJECT</span>
              <select
                className="demos-select"
                value={selection?.projectId ?? ""}
                disabled={!state}
                onChange={(event) => void updateSelection({ projectId: event.target.value, variantId: variants[0]?.id ?? selection?.variantId })}
              >
                {state?.catalog.projects.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="demos-select-field">
              <span className="demos-field-label">STACK VARIANT</span>
              <select
                className="demos-select"
                value={selection?.variantId ?? ""}
                disabled={!state}
                onChange={(event) => void updateSelection({ variantId: event.target.value })}
              >
                {variants.map((candidate) => (
                  <option key={`${candidate.projectId}:${candidate.id}`} value={candidate.id} disabled={!candidate.available}>
                    {candidate.label}
                    {candidate.available ? "" : " (unavailable)"}
                  </option>
                ))}
              </select>
            </div>

            <div className="demos-select-field">
              <span className="demos-field-label">MODE</span>
              <select
                className="demos-select"
                value={selection?.mode ?? "SAMPLE"}
                disabled={!state}
                onChange={(event) => void updateSelection({ mode: event.target.value as "SAMPLE" | "LIVE" })}
              >
                <option value="SAMPLE">Sample</option>
                <option value="LIVE">Live</option>
              </select>
            </div>
          </div>

          {/* Action Button Cluster */}
          <div className="demos-action-cluster">
            <button
              type="button"
              className="demos-btn-start"
              disabled={busy !== null || isRunning}
              onClick={() => void start()}
            >
              {busy === "start" ? "Starting…" : "Start"}
            </button>
            <button
              type="button"
              className="demos-ghost demos-danger"
              disabled={busy !== null || !isRunning}
              onClick={() => void stop()}
            >
              Stop
            </button>
            <button
              type="button"
              className="demos-ghost"
              disabled={busy !== null || !run}
              onClick={() => void restart()}
            >
              {busy === "restart" ? "Restarting…" : "Restart"}
            </button>
            <button
              type="button"
              className="demos-ghost"
              disabled={busy !== null || !isRunning}
              onClick={() => void runTests()}
            >
              {busy === "tests" ? "Checking…" : "Run checks"}
            </button>
          </div>

          {/* Status Badge */}
          <div className="demos-status-box">
            <div className={statusClass(appliedStatus)}>
              <span className="demos-status-dot" />
              <span>{appliedStatus.replace("_", " ")}</span>
            </div>
            {run?.health?.ok ? <span className="demos-latency-text">{run.health.latencyMs ?? 0} ms</span> : null}
          </div>
        </div>
      </div>

      {/* V2 Tab Navigation */}
      <div className="demos-tabs-v2" role="tablist">
        {tabs.map((candidate) => (
          <button
            key={candidate.key}
            type="button"
            role="tab"
            className={`demos-tab-v2 ${tab === candidate.key ? "active" : ""}`}
            aria-selected={tab === candidate.key}
            onClick={() => {
              if (notice?.message.includes("DEMO_FILE_NOT_FOUND")) {
                setNotice(null);
              }
              setTab(candidate.key);
            }}
          >
            <span>{candidate.label}</span>
            {candidate.key === "connections" && missingConnections ? (
              <span className="demos-tab-badge-warn" title="Connections required for Live mode">
                !
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {/* Main Body */}
      <div className="demos-body">
        {notice ? (
          <div className={`demos-notice ${notice.tone}`} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>{notice.message}</span>
            <button
              type="button"
              className="demos-notice-dismiss"
              onClick={() => setNotice(null)}
              aria-label="Dismiss notice"
            >
              ✕
            </button>
          </div>
        ) : null}
        {!state ? <p className="demos-muted">Loading demo catalog and workspace state…</p> : null}

        {state && tab === "overview" ? (
          <>
            <div className="demos-card">
              <div className="demos-row spread">
                <div>
                  <h3 style={{ fontSize: 14, fontWeight: 600 }}>{project?.name}</h3>
                  <span className="demos-muted">{project?.summary}</span>
                </div>
                <div className="demos-tech-pill">{variant ? variant.label : "Select a variant"}</div>
              </div>
              <p className="demos-muted" style={{ marginTop: 4 }}>
                {project?.description}
              </p>

              <div className="demos-grid" style={{ marginTop: 8 }}>
                <div className="demos-metric-cell">
                  <span className="demos-metric-label">RUN IDENTIFIER</span>
                  <span className="demos-mono">{run?.id ?? "not started"}</span>
                </div>
                <div className="demos-metric-cell">
                  <span className="demos-metric-label">ACTIVE MODE</span>
                  <span className="demos-metric-value">{run?.mode ?? selection?.mode ?? "SAMPLE"}</span>
                </div>
                <div className="demos-metric-cell">
                  <span className="demos-metric-label">BOUND PORT</span>
                  <span className="demos-mono">{run?.port ? `127.0.0.1:${run.port}` : "—"}</span>
                </div>
                <div className="demos-metric-cell">
                  <span className="demos-metric-label">STARTED TIME</span>
                  <span className="demos-metric-value">{run?.startedAt ? new Date(run.startedAt).toLocaleTimeString() : "—"}</span>
                </div>
                <div className="demos-metric-cell">
                  <span className="demos-metric-label">UPSTREAM HEALTH</span>
                  <span className="demos-metric-value">
                    {run?.health ? (run.health.ok ? `Healthy (${run.health.latencyMs ?? 0} ms)` : "Failing") : "—"}
                  </span>
                </div>
                <div className="demos-metric-cell">
                  <span className="demos-metric-label">GOOGLE SHEETS TARGET</span>
                  <span className="demos-metric-value">
                    {state.sheets.verified ? `${state.sheets.title ?? state.sheets.spreadsheetId}` : "Not selected"}
                  </span>
                </div>
              </div>

              {run?.lastError ? (
                <div className="demos-notice error" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
                  <span>{run.lastError}</span>
                  <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                    <button
                      type="button"
                      className="demos-primary"
                      style={{ fontSize: "11px", padding: "3px 10px" }}
                      disabled={busy !== null}
                      onClick={() => void restart()}
                    >
                      {busy === "restart" ? "Restarting..." : "Restart run"}
                    </button>
                    <button
                      type="button"
                      className="demos-ghost"
                      style={{ fontSize: "11px", padding: "2px 8px", background: "rgba(255, 255, 255, 0.08)", borderColor: "rgba(248, 81, 73, 0.4)" }}
                      disabled={busy !== null}
                      onClick={() => void refresh()}
                    >
                      Refresh status
                    </button>
                  </div>
                </div>
              ) : null}
              {missingConnections ? (
                <p className="demos-notice warn">
                  Live mode requires both Salesforce and Google Sheets to be connected. In Sample mode, the demo operates
                  locally with isolated in-memory data.
                </p>
              ) : null}
            </div>

            <div className="demos-card">
              <div className="demos-row spread">
                <h3>Live Operations Ledger ({operations.length})</h3>
                <button type="button" className="demos-ghost" onClick={() => void refresh()}>
                  Refresh
                </button>
              </div>
              <table className="demos-table">
                <thead>
                  <tr>
                    <th>Operation Key</th>
                    <th>Account ID</th>
                    <th>Contact ID</th>
                    <th>Sheet Row</th>
                    <th>Status</th>
                    <th>Execution Steps</th>
                    <th style={{ textAlign: "right" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.map((operation) => (
                    <tr key={operation.id}>
                      <td className="demos-mono">{operation.operationKey}</td>
                      <td className="demos-mono">{operation.salesforceAccountId ?? "—"}</td>
                      <td className="demos-mono">{operation.salesforceContactId ?? "—"}</td>
                      <td className="demos-mono">{operation.sheetsRow ?? "—"}</td>
                      <td>
                        <span className={statusClass(operation.status)}>{operation.status}</span>
                        {operation.lastErrorMessage ? <div className="demos-muted">{operation.lastErrorMessage}</div> : null}
                      </td>
                      <td className="demos-mono">
                        {operation.steps.map((step) => `${step.key.split("-").pop()}:${step.status}`).join(" · ")}
                      </td>
                      <td style={{ textAlign: "right" }}>
                        {operation.status === "FAILED" || operation.status === "PARTIAL" ? (
                          <button type="button" className="demos-ghost" disabled={busy !== null} onClick={() => void retryOperation(operation)}>
                            Retry
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                  {operations.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="demos-muted" style={{ textAlign: "center", padding: "16px 0" }}>
                        No operations registered yet. Create records via the Live Preview tab to observe synchronized steps.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        ) : null}

        {state && tab === "preview" ? (
          <div className="demos-preview-card" style={{ flex: 1, minHeight: 0 }}>
            <div className="demos-preview-header">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="demos-live-dot-glow" />
                <strong>Preview Frame</strong>
                <span className="demos-subtle-badge">
                  {isRunning && run.previewPath
                    ? `Sandboxed · ${run.mode === "LIVE" ? "Live Integration" : "Sample Data"}`
                    : "Stopped"}
                </span>
              </div>
              <div className="demos-row">
                <button
                  type="button"
                  className="demos-ghost"
                  onClick={() => setPreviewNonce((value) => value + 1)}
                  disabled={!run?.previewPath}
                >
                  ↻ Reload
                </button>
                <button
                  type="button"
                  className="demos-ghost"
                  disabled={!run?.previewPath}
                  onClick={() => run?.previewPath && window.open(run.previewPath, "_blank", "noopener,noreferrer")}
                >
                  Open preview ↗
                </button>
              </div>
            </div>
            <div className="demos-preview-viewport">
              {isRunning && run?.previewPath ? (
                <iframe
                  key={`${run.id}:${previewNonce}`}
                  title="Demo preview"
                  src={run.previewPath}
                  sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="demos-preview-placeholder">
                  <div style={{ textAlign: "center", maxWidth: 360 }}>
                    <div style={{ fontSize: 32, marginBottom: 8 }}>⏹</div>
                    <h4 style={{ margin: "0 0 8px" }}>The demo preview is not currently running</h4>
                    <p className="demos-muted" style={{ margin: "0 0 16px" }}>
                      Select your desired project and runtime mode, then click Start to launch the child process and load the live UI.
                    </p>
                    <button
                      type="button"
                      className="demos-btn-start"
                      disabled={busy !== null || isRunning}
                      onClick={() => void start()}
                    >
                      ▶ Start Demo
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}

        {state && tab === "code" && selection ? (
          <CodeTab
            projectId={selection.projectId}
            variantId={selection.variantId}
            initialFile={selectedFile}
            onNotice={setNotice}
          />
        ) : null}

        {state && tab === "guide" && selection ? (
          <GuideTab
            projectId={selection.projectId}
            variantId={selection.variantId}
            onSelectFile={(filePath) => {
              setSelectedFile(filePath);
              setTab("code");
            }}
            onNotice={setNotice}
          />
        ) : null}

        {state && tab === "connections" ? (
          <ConnectionsTab connections={state.connections} sheets={state.sheets ?? emptySheets} onRefresh={refresh} onNotice={setNotice} />
        ) : null}

        {state && tab === "logs" ? (
          <div className="demos-card" style={{ flex: 1, minHeight: 0 }}>
            <div className="demos-row spread">
              <h3>Runtime Logs</h3>
              <span className="demos-muted">
                {run ? `${run.id} · ${run.mode}` : "No active run"} · Tokens and secrets are masked before storage
              </span>
            </div>
            <div className="demos-logs">
              {logs.length === 0 ? <p className="demos-muted">No log output received for this run yet.</p> : null}
              {logs.map((entry) => (
                <div key={entry.seq} className={`demos-log-line ${entry.stream}`}>
                  <span className="demos-mono">{new Date(entry.at).toLocaleTimeString()}</span>
                  <span>{entry.line}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {state && tab === "tests" ? (
          <div className="demos-card">
            <div className="demos-row spread">
              <div>
                <h3>Automated Integrity Checks</h3>
                <p className="demos-muted" style={{ margin: "4px 0 0" }}>
                  Verifies runtime health, isolation, idempotency, and live external APIs against the running instance.
                </p>
              </div>
              <button
                type="button"
                className="demos-ghost"
                disabled={busy !== null || !isRunning}
                onClick={() => void runTests()}
              >
                {busy === "tests" ? "Running checks…" : "✓ Run checks"}
              </button>
            </div>

            {tests ? (
              <div style={{ marginTop: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                  <span className={`demos-pill ${tests.status === "PASSED" ? "demos-running" : "demos-failed"}`}>
                    {tests.status}
                  </span>
                  <span className="demos-muted">
                    Completed at {new Date(tests.finishedAt).toLocaleTimeString()} · Mode: {tests.mode}
                  </span>
                </div>
                {tests.steps.map((step) => (
                  <div key={step.key} className="demos-step">
                    <span className={`demos-step-status ${step.status.toLowerCase()}`}>{step.status}</span>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 500 }}>{step.label}</div>
                      <div className="demos-muted">
                        {step.detail} · {step.durationMs} ms
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="demos-muted" style={{ marginTop: 12 }}>
                No check run recorded in this session. Start the demo and click Run checks to execute end-to-end assertions.
              </p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default DemosPane;
