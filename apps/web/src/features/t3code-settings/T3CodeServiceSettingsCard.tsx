import { useCallback, useEffect, useRef, useState } from "react";
import type { T3CodeAdminStatus } from "@space/contracts";
import { api } from "../../api.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { CodeXml, Recycle, RefreshCw } from "../ui-theme/app-icons.js";
import { DockButton, DockIconButton, DockNotice } from "../dock-kit/DockKit.js";
import "./t3code-settings.css";

type Pending = null | "status" | "enable" | "disable" | "restart";
type Confirm = null | { action: "disable" | "restart"; activeRuns: number | null };

function stateLabel(status: T3CodeAdminStatus | null) {
  if (!status) return { text: "Checking", tone: "pending" };
  if (!status.featureEnabled) return { text: "Feature off", tone: "down" };
  if (status.ready) return { text: "Ready", tone: "ok" };
  if (!status.serviceEnabled && !status.socketActive) return { text: "Stopped", tone: "down" };
  return { text: "Not responding", tone: "down" };
}

function errorCode(error: unknown) {
  return (error as { code?: string } | null)?.code ?? null;
}

function errorDetails(error: unknown) {
  return (error as { details?: { activeRuns?: number | null } } | null)?.details;
}

export function T3CodeServiceSettingsCard() {
  const [status, setStatus] = useState<T3CodeAdminStatus | null>(null);
  const [pending, setPending] = useState<Pending>("status");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  // After a failed operation the status is re-read but its error stays visible.
  const refresh = useCallback(async (keepMessages = false) => {
    setPending("status");
    if (!keepMessages) setError(null);
    try {
      const result = await api.t3CodeAdminStatus();
      if (mounted.current) setStatus(result.status);
    } catch {
      if (mounted.current) setError("T3 Code service status could not be read.");
    } finally {
      if (mounted.current) setPending(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function run(action: "enable" | "disable" | "restart", confirmed = false) {
    if (pending) return;
    setPending(action);
    setError(null);
    setFeedback(null);
    try {
      const result = action === "restart"
        ? await api.restartT3Code(confirmed ? { confirmActiveRuns: true } : {})
        : await api.updateT3CodeEnabled({ enabled: action === "enable", ...(confirmed ? { confirmActiveRuns: true } : {}) });
      if (!mounted.current) return;
      setStatus(result.status);
      setConfirm(null);
      setFeedback(action === "restart" ? "T3 Code restarted." : `T3 Code is now ${action === "enable" ? "on" : "off"}.`);
    } catch (cause) {
      if (!mounted.current) return;
      if (errorCode(cause) === "T3_ACTIVE_RUNS" && action !== "enable") {
        setConfirm({ action, activeRuns: errorDetails(cause)?.activeRuns ?? null });
      } else if (errorCode(cause) === "T3_SERVICE_OPERATION_PENDING") {
        setError("Another T3 Code service operation is still running.");
      } else {
        setError(action === "restart" ? "T3 Code did not become ready after the restart." : "T3 Code service state could not be changed.");
      }
      void refresh(true);
    } finally {
      if (mounted.current) setPending((current) => (current === action ? null : current));
    }
  }

  const label = stateLabel(status);
  const serviceOn = Boolean(status?.serviceEnabled || status?.socketActive);
  const busy = pending !== null;
  const runtime = status?.runtime;
  return (
    <section className="agent-settings-card settings-flat-card t3code-service-settings-card" aria-label="T3 Code service settings" aria-busy={busy}>
      <div className="agent-settings-section-title settings-flat-heading">
        <CodeXml aria-hidden="true" />
        <span>
          <strong>T3 Code</strong>
          <small>The T3 Code service on this server that powers T3 Code panes.</small>
        </span>
      </div>
      <div className="settings-flat-row t3code-service-status-row">
        <span className="settings-flat-row-copy">
          <strong>Status <span className={`pill ${label.tone}`} data-t3code-service-state={label.text}>{label.text}</span></strong>
          <small>
            {runtime ? `T3 Code ${status?.serverVersion ?? runtime.packageVersion} · ${runtime.tag} · integration ${runtime.integrationRevision}` : "Runtime version unavailable."}
            {status?.activeRuns != null ? ` · ${status.activeRuns} active ${status.activeRuns === 1 ? "run" : "runs"}` : ""}
          </small>
        </span>
        <DockIconButton label="Refresh T3 Code status" title="Refresh status" icon={RefreshCw} busy={pending === "status"}
          disabled={busy} onClick={() => void refresh()} />
      </div>
      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row t3code-service-toggle"
        name="t3code-service-enabled"
        ariaLabel="Enable T3 Code service"
        label="T3 Code service"
        detail={status && !status.featureEnabled ? "Turned off by SPACE_T3CODE_ENABLED on this installation." : "Starts the service and keeps it enabled across reboots."}
        checked={serviceOn}
        disabled={!status || !status.featureEnabled || busy}
        onChange={(checked) => void run(checked ? "enable" : "disable")}
      />
      <div className="settings-flat-row">
        <span className="settings-flat-row-copy">
          <strong>Restart</strong>
          <small>Restarts only the T3 Code service. Space, terminals and the DeepSeek Harness keep running.</small>
        </span>
        <DockButton icon={Recycle} busy={pending === "restart"} disabled={!status || !serviceOn || busy} onClick={() => void run("restart")}>
          Restart
        </DockButton>
      </div>
      {confirm ? (
        <div className="t3code-service-confirm dock-kit-card is-warning" role="alertdialog" aria-label="Confirm T3 Code interruption">
          <p>{confirm.activeRuns === null
            ? "Active T3 Code runs could not be counted; any running work will be interrupted."
            : `${confirm.activeRuns} active T3 Code ${confirm.activeRuns === 1 ? "run" : "runs"} will be interrupted.`}</p>
          <div className="dock-kit-card-actions">
            <DockButton tone="ghost" onClick={() => setConfirm(null)} disabled={busy}>Cancel</DockButton>
            <DockButton tone="danger" disabled={busy}
              onClick={() => void run(confirm.action, true)}>{confirm.action === "restart" ? "Restart anyway" : "Turn off anyway"}</DockButton>
          </div>
        </div>
      ) : null}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {feedback ? <DockNotice tone="success" onDismiss={() => setFeedback(null)}>{feedback}</DockNotice> : null}
    </section>
  );
}
