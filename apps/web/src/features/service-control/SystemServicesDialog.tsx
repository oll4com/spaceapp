import type { SystemServicesResponse, SystemServiceUnit } from "@space/contracts";
import { Boxes, RefreshCw, X } from "../ui-theme/app-icons.js";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent
} from "react";
import { api } from "../../api.js";
import "./service-control.css";

export interface SystemServicesClient {
  listSystemServices(): Promise<SystemServicesResponse>;
}

function stateLabel(unit: SystemServiceUnit): string {
  if (unit.type === "timer") return unit.activeState === "active" ? "scheduled" : unit.activeState;
  return unit.subState === "running" ? "running" : unit.subState;
}

function stateTone(unit: SystemServiceUnit): string {
  if (unit.type === "timer") return unit.activeState === "active" ? "tone-ok" : "tone-inactive";
  if (unit.activeState === "active") return unit.subState === "running" ? "tone-ok" : "tone-idle";
  if (unit.activeState === "failed") return "tone-bad";
  return "tone-inactive";
}

function enabledLabel(unit: SystemServiceUnit): string {
  return unit.unitFileState ?? "—";
}

function formatNextRun(unit: SystemServiceUnit): string {
  if (unit.type !== "timer") return "—";
  return unit.timerNextElapse
    ? new Date(unit.timerNextElapse).toLocaleString()
    : "—";
}

export function SystemServicesDialog({
  client = api,
  onClose
}: {
  client?: SystemServicesClient;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const [snapshot, setSnapshot] = useState<SystemServicesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const next = await client.listSystemServices();
      setSnapshot(next);
    } catch (reason) {
      setError(reason instanceof Error && reason.message.trim() ? reason.message : "System services are temporarily unavailable.");
    } finally {
      setRefreshing(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const close = useCallback(() => {
    if (!refreshing) onClose();
  }, [refreshing, onClose]);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") {
      if (!refreshing) {
        event.preventDefault();
        close();
      }
      return;
    }
    if (event.key !== "Tab") return;
    const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)"
    ) ?? []);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const units = snapshot?.units ?? [];
  const active = units.filter((unit) => unit.activeState === "active");
  const inactive = units.filter((unit) => unit.activeState !== "active");

  return (
    <div className="service-control-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section
        ref={dialogRef}
        className="service-control-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="System services"
        aria-busy={refreshing}
        onKeyDown={handleKeyDown}
      >
        <header className="service-control-header">
          <span className="service-control-icon"><Boxes aria-hidden="true" /></span>
          <div>
            <h2>System services</h2>
            <p>Space and memory systemd services on public-host: status, schedule and enabled state.</p>
          </div>
          <button
            ref={closeRef}
            type="button"
            aria-label="Refresh services"
            disabled={refreshing}
            onClick={() => void load()}
            title="Refresh"
          >
            <RefreshCw aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="Close system services"
            disabled={refreshing}
            onClick={close}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        {snapshot ? (
          <>
            <div className="service-control-summary">
              <span><strong>{snapshot.summary.total}</strong> units</span>
              <span><strong>{snapshot.summary.active}</strong> active</span>
              <span><strong>{snapshot.summary.inactive}</strong> inactive</span>
              {snapshot.summary.failed > 0 ? <span className="tone-bad"><strong>{snapshot.summary.failed}</strong> failed</span> : null}
              <span><strong>{snapshot.summary.services}</strong> services</span>
              <span><strong>{snapshot.summary.timers}</strong> timers</span>
              <span><strong>{snapshot.summary.enabled}</strong> enabled</span>
              <span><strong>{snapshot.summary.disabled}</strong> disabled</span>
              <span className="service-control-sampled">sampled {new Date(snapshot.sampledAt).toLocaleTimeString()}</span>
            </div>
            {error ? <div className="service-control-error" role="alert">{error}</div> : null}
            <div className="service-control-panel">
              <section className="service-control-group">
                <h3>Active</h3>
                <div className="service-control-table" role="table" aria-label="Active services">
                  <div className="service-control-row service-control-row-head" role="row">
                    <span role="columnheader">Unit</span>
                    <span role="columnheader">State</span>
                    <span role="columnheader">Enabled</span>
                    <span role="columnheader">Next run</span>
                  </div>
                  {active.map((unit) => (
                    <div className="service-control-row" role="row" key={unit.unit}>
                      <span className="service-control-unit" role="cell">
                        <span className="service-control-unit-name">{unit.unit}</span>
                        <span className="service-control-unit-desc">{unit.description ?? ""}</span>
                      </span>
                      <span role="cell">
                        <span className={`service-control-state ${stateTone(unit)}`}>{stateLabel(unit)}</span>
                      </span>
                      <span role="cell">{enabledLabel(unit)}</span>
                      <span role="cell">{formatNextRun(unit)}</span>
                    </div>
                  ))}
                </div>
              </section>
              {inactive.length > 0 ? (
                <section className="service-control-group">
                  <h3>Inactive</h3>
                  <div className="service-control-table" role="table" aria-label="Inactive services">
                    <div className="service-control-row service-control-row-head" role="row">
                      <span role="columnheader">Unit</span>
                      <span role="columnheader">State</span>
                      <span role="columnheader">Enabled</span>
                      <span role="columnheader">Next run</span>
                    </div>
                    {inactive.map((unit) => (
                      <div className="service-control-row" role="row" key={unit.unit}>
                        <span className="service-control-unit" role="cell">
                          <span className="service-control-unit-name">{unit.unit}</span>
                          <span className="service-control-unit-desc">{unit.description ?? ""}</span>
                        </span>
                        <span role="cell">
                          <span className={`service-control-state ${stateTone(unit)}`}>{stateLabel(unit)}</span>
                        </span>
                        <span role="cell">{enabledLabel(unit)}</span>
                        <span role="cell">{formatNextRun(unit)}</span>
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
            </div>
          </>
        ) : (
          <div className="service-control-empty" role="status">
            {error ? error : `Loading system services…`}
          </div>
        )}
      </section>
    </div>
  );
}
