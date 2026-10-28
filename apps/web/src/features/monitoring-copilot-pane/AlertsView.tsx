import { useState } from "react";
import type { MonitoringAlertView, MonitoringCopilotState } from "./types.js";

type Filter = "firing" | "CRITICAL" | "WARNING" | "history";
const SEVERITY_LABEL: Record<MonitoringAlertView["severity"], string> = { CRITICAL: "Critical", WARNING: "Warning", INFO: "Info" };

function since(at: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return minutes < 60 ? `${minutes} min` : minutes < 2880 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / 1440)} d`;
}

/** The collector's alerts as Space last saw them: firing first (critical, warning, info), the 30-day history on request. */
export function AlertsView({ state }: { state: MonitoringCopilotState | null }) {
  const [filter, setFilter] = useState<Filter>("firing");
  const [open, setOpen] = useState<string | null>(null);
  if (!state) return <p className="jc-muted jc-empty">Loading alerts…</p>;
  const { firing, collector } = state.summary;
  const shown = state.alerts.filter((alert) => filter === "history" ? alert.state === "RESOLVED" : alert.state === "FIRING" && (filter === "firing" || alert.severity === filter));
  const counts: Array<[Filter, string, number]> = [["firing", "Firing", firing.CRITICAL + firing.WARNING + firing.INFO], ["CRITICAL", "Critical", firing.CRITICAL],
    ["WARNING", "Warnings", firing.WARNING], ["history", "Resolved (30 days)", state.alerts.filter((alert) => alert.state === "RESOLVED").length]];

  return (
    <div className="mc-alerts">
      <div className="mc-counts" role="group" aria-label="Alert filters">
        {counts.map(([id, label, count]) => (
          <button key={id} type="button" className={`mc-count severity-${id.toLowerCase()}${filter === id ? " selected" : ""}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
            <strong>{count}</strong><span>{label}</span>
          </button>
        ))}
        <p className={`mc-collector${collector.reachable === false ? " down" : ""}`} role="status">
          {collector.reachable === false ? `Collector not answering since ${collector.downSince ? new Date(collector.downSince).toLocaleTimeString() : "now"}${collector.lastError ? `: ${collector.lastError}` : ""}`
            : collector.lastOkAt ? `Collector read ${new Date(collector.lastOkAt).toLocaleTimeString()}` : "Collector not read yet"}
        </p>
      </div>
      <ul className="mc-alert-list" aria-label={filter === "history" ? "Resolved alerts" : "Firing alerts"}>
        {shown.map((alert) => (
          <li key={alert.id} className={`mc-alert severity-${alert.severity.toLowerCase()}`} data-state={alert.state.toLowerCase()}>
            <button type="button" className="mc-alert-head" aria-expanded={open === alert.id} onClick={() => setOpen(open === alert.id ? null : alert.id)}>
              <span className={`jc-pill mc-severity severity-${alert.severity.toLowerCase()}`}>{SEVERITY_LABEL[alert.severity]}</span>
              <strong className="mc-alert-name">{alert.alertname}</strong>
              <span className="mc-alert-instance">{alert.instance || alert.job}</span>
              <span className="mc-alert-age">{alert.state === "FIRING" ? `for ${since(alert.startsAt)}` : `ended ${alert.endsAt ? since(alert.endsAt) : ""} ago`}</span>
            </button>
            {alert.summary ? <p className="mc-alert-line">{alert.summary}</p> : null}
            {open === alert.id ? (
              <div className="mc-alert-detail">
                {alert.description ? <p>{alert.description}</p> : null}
                <dl className="mc-labels">
                  <dt>Source</dt><dd>{alert.source === "LOKI" ? "Loki log rule" : "Prometheus rule"}</dd>
                  <dt>Started</dt><dd>{new Date(alert.startsAt).toLocaleString()}</dd>
                  {Object.entries(alert.labels).filter(([key]) => !["alertname", "severity"].includes(key)).map(([key, value]) => <div key={key} className="mc-label"><dt>{key}</dt><dd>{value}</dd></div>)}
                </dl>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!shown.length ? <p className="jc-muted jc-empty">{filter === "history" ? "No resolved alerts in the last 30 days." : "Nothing firing."}</p> : null}
    </div>
  );
}
