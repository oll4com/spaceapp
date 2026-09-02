import {
  type CliUpdateAllDetection,
  type CliUpdateAllRequest,
  type CliUpdateAllResult
} from "@space/contracts";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Wrench,
  Zap
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "./admin-operation-utils.js";

export interface CliUpdateAllClient {
  detectCliUpdateAll(): Promise<CliUpdateAllDetection>;
  runCliUpdateAll(input: CliUpdateAllRequest): Promise<CliUpdateAllResult>;
}

export function CliUpdateAllPanel({
  client,
  onBusyChange
}: {
  client: CliUpdateAllClient;
  onBusyChange: (busy: boolean) => void;
}) {
  const [detection, setDetection] = useState<CliUpdateAllDetection | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CliUpdateAllResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [reinstall, setReinstall] = useState(true);
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError(null);
    try {
      const detectionValue = await client.detectCliUpdateAll();
      if (mountedRef.current) setDetection(detectionValue);
    } catch (reason) {
      if (mountedRef.current) setError(errorMessage(reason, "Custom procedure detection could not be loaded."));
    } finally {
      loadingRef.current = false;
      if (mountedRef.current) setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    onBusyChange(running);
  }, [onBusyChange, running]);

  const customTypes = detection?.cliTypes.filter((entry) => entry.hasCustom) ?? [];
  const customCount = customTypes.length;
  const totalTypes = detection?.cliTypes.length ?? 0;
  const managedTypes = detection?.cliTypes.filter((entry) => entry.managed) ?? [];
  const presentCustomCount = customTypes
    .flatMap((entry) => entry.custom)
    .filter((item) => item.present).length;
  const allSelected = managedTypes.length > 0
    ? managedTypes.every((entry) => selected.has(entry.key))
    : false;

  function toggleSelectAll() {
    if (!detection) return;
    setSelected(allSelected ? new Set() : new Set(managedTypes.map((entry) => entry.key)));
  }

  function toggleKey(key: string) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runUpdateAll(keys: string[]) {
    if (running) return;
    setRunning(true);
    setRunStartedAt(new Date().toISOString());
    setResult(null);
    setError(null);
    try {
      const input: CliUpdateAllRequest = reinstall ? { reinstall: true } : {};
      if (keys.length > 0) input.keys = keys as NonNullable<CliUpdateAllRequest["keys"]>;
      const updateAllResult = await client.runCliUpdateAll(input);
      if (mountedRef.current) {
        setResult(updateAllResult);
        setRunStartedAt(null);
      }
    } catch (reason) {
      if (mountedRef.current) {
        setRunStartedAt(null);
        setError(errorMessage(reason, "The update-all procedure could not be started."));
      }
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  }

  return (
    <div className="admin-operation-panel">
      <div className="admin-operation-callout">
        <ShieldCheck aria-hidden="true" />
        <p>
          Detects all 13 Space CLI types and updates all 11 managed types, including the ones that are disabled in
          Settings, while preserving each detected custom procedure. Choose <strong>Update all</strong> to refresh every managed CLI type, or select
          individual types below and use <strong>Update selected</strong> for a one-at-a-time run. Enable
          <strong> reinstall custom</strong> to re-apply each detected patch/installer on top after the update.
        </p>
      </div>

      <section className="admin-operation-actions-grid">
        <section>
          <Terminal aria-hidden="true" />
          <div>
            <strong>Update CLI types</strong>
            <small>
              {totalTypes ? `${managedTypes.length} managed of ${totalTypes} CLI types · ${customCount} with custom procedures` : "Detecting CLI types…"}
            </small>
          </div>
          <button
            type="button"
            className="admin-operation-primary"
            disabled={loading || running || !detection}
            onClick={() => void runUpdateAll([])}
            aria-label="Update all"
          >
            {running ? <Loader2 className="spin" aria-hidden="true" /> : <Zap aria-hidden="true" />}
            {running ? "Updating…" : "Update all"}
          </button>
        </section>
        <section>
          <Wrench aria-hidden="true" />
          <div>
            <strong>Update selected</strong>
            <small>{selected.size ? `${selected.size} CLI type(s) selected` : "No CLI types selected"}</small>
          </div>
          <button
            type="button"
            className="admin-operation-primary"
            disabled={loading || running || !detection || selected.size === 0}
            onClick={() => void runUpdateAll(Array.from(selected))}
            aria-label={`Update selected (${selected.size})`}
          >
            {running ? <Loader2 className="spin" aria-hidden="true" /> : <Wrench aria-hidden="true" />}
            {running ? "Updating…" : `Update selected (${selected.size})`}
          </button>
        </section>
      </section>

      {running ? (
        <p className="admin-operation-running" role="status" aria-live="assertive">
          <Loader2 className="spin" aria-hidden="true" />
          <span>
            <strong>CLI update started</strong>
            <small>
              Updating the selected runtimes and verifying custom procedures. This can take several minutes; keep
              this window open. Started {runStartedAt ? new Date(runStartedAt).toLocaleTimeString() : "now"}.
            </small>
          </span>
        </p>
      ) : null}

      <label className="admin-operation-check">
        <input
          id="cli-update-all-reinstall"
          type="checkbox"
          checked={reinstall}
          disabled={running}
          onChange={(event) => setReinstall(event.target.checked)}
          aria-label="Reinstall custom procedures after update"
        />
        <span>
          <strong>Verify and re-apply custom procedures after update</strong>
          <small>Verify each detected patch and safely restore tracked config/MCP overlays after the update.</small>
        </span>
      </label>

      {error ? <p className="admin-operation-alert error" role="alert">{error}</p> : null}

      {detection?.cliTypes && customCount > 0 ? (
        <section className="admin-operation-history" aria-label="Custom procedures detected">
          <header>
            <span>
              <strong>Custom procedures detected</strong>
              <small>
                {customCount} of {totalTypes} CLI types carry {presentCustomCount} custom procedure artifact(s).
              </small>
            </span>
            <AlertTriangle aria-hidden="true" />
          </header>
          <div className="admin-operation-result-list">
            {customTypes.map((entry) => (
              <div key={entry.cliType}>
                <strong>{entry.displayName}</strong>
                <span>custom</span>
                <small>
                  {entry.custom.filter((item) => item.present).map((item) => item.label).join(", ")}
                </small>
              </div>
            ))}
          </div>
          <p className="admin-operation-alert" role="status">
            These custom procedures are preserved during every update. Enabling the <strong>reinstall</strong>{" "}
            toggle above re-applies them on top after each update completes.
          </p>
        </section>
      ) : null}

      {detection?.cliTypes ? (
        <section className="admin-operation-history" aria-label="All CLI types">
          <header>
            <span>
              <strong>All CLI types</strong>
              <small>Full set, including disabled ones.</small>
            </span>
            <button
              type="button"
              aria-label="Re-run custom procedure detection"
              disabled={loading || running}
              onClick={() => void load()}
            >
              {loading ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            </button>
          </header>
          <label className="admin-operation-check indented">
            <input
              id="cli-update-all-select-all"
              type="checkbox"
              checked={!!allSelected}
              disabled={running}
              onChange={toggleSelectAll}
              aria-label="Select all managed CLI types"
            />
            <span>
              <strong>{allSelected ? "Deselect all" : "Select all CLI types"}</strong>
            </span>
          </label>
          <div className="admin-operation-result-list checkable">
            {detection.cliTypes.map((entry) => (
              <label
                key={entry.cliType}
                className={entry.enabled ? "" : "is-disabled"}
              >
                <input
                  id={`cli-update-all-${entry.key}`}
                  type="checkbox"
                  checked={selected.has(entry.key)}
                  disabled={running || !entry.managed}
                  onChange={() => toggleKey(entry.key)}
                  aria-label={entry.displayName}
                />
                <div>
                  <strong>{entry.displayName}</strong>
                  <span className={entry.hasCustom ? "has-custom" : ""}>
                    {entry.hasCustom ? "custom" : entry.managed ? "managed" : "not managed"}
                  </span>
                  <small>
                    {entry.enabled ? "enabled" : "disabled"}
                    {entry.managed ? " · updates apply" : ""}
                    {!entry.enabled && entry.managed ? " · still updatable" : ""}
                    {!entry.managed ? " · no update path" : ""}
                  </small>
                </div>
              </label>
            ))}
          </div>
          {managedTypes.length > 0 ? (
            <p className="admin-operation-alert" role="status">
              Only managed CLI types can be individually updated. Non-managed types (e.g. Hermes Agent, DeepSeek
              Harness) are listed for detection but have no separate update path.
            </p>
          ) : null}
        </section>
      ) : null}

      {result ? (
        <section className="admin-operation-history" aria-label="Update-all result">
          <header>
            <span>
              <strong>Update result · {result.overallStatus}</strong>
              <small>{result.runtimes.length} CLI types · finished {result.finishedAt}</small>
            </span>
            <CheckCircle2 aria-hidden="true" />
          </header>
          <div className="admin-operation-result-list">
            {result.runtimes.map((runtime) => (
              <div key={String(runtime.runtimeId ?? "runtime")}>
                <strong>{String(runtime.displayName ?? runtime.runtimeId ?? "Runtime")}</strong>
                <span>{String(runtime.status)}</span>
                <small>
                  {String(runtime.code)}
                  {runtime.customPreserved ? " · custom preserved" : ""}
                  {runtime.customReinstalled ? " · custom reinstalled" : ""}
                  {"errorMessage" in runtime && runtime.errorMessage ? ` · ${String(runtime.errorMessage)}` : ""}
                </small>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
