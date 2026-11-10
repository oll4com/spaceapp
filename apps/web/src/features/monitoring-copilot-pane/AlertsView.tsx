import { useState } from "react";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import type { MonitoringAlertView, MonitoringCopilotState } from "./types.js";

type Filter = "firing" | "CRITICAL" | "WARNING" | "history";
const SEVERITY_LABEL: Record<MonitoringAlertView["severity"], string> = { CRITICAL: "Critical", WARNING: "Warning", INFO: "Info" };

function since(at: string, t: (text: string, vars?: Record<string, string | number>) => string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60_000));
  return minutes < 60 ? t("{count} min", { count: minutes }) : minutes < 2880 ? t("{count} h", { count: Math.round(minutes / 60) }) : t("{count} d", { count: Math.round(minutes / 1440) });
}

/** The collector's alerts as Space last saw them: firing first (critical, warning, info), the 30-day history on request. */
export function AlertsView({ state }: { state: MonitoringCopilotState | null }) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const [filter, setFilter] = useState<Filter>("firing");
  const [open, setOpen] = useState<string | null>(null);
  if (!state) return <p className="jc-muted jc-empty">{t("Loading alerts…")}</p>;
  const { firing, collector } = state.summary;
  const shown = state.alerts.filter((alert) => filter === "history" ? alert.state === "RESOLVED" : alert.state === "FIRING" && (filter === "firing" || alert.severity === filter));
  const counts: Array<[Filter, string, number]> = [["firing", "Firing", firing.CRITICAL + firing.WARNING + firing.INFO], ["CRITICAL", "Critical", firing.CRITICAL],
    ["WARNING", "Warnings", firing.WARNING], ["history", "Resolved (30 days)", state.alerts.filter((alert) => alert.state === "RESOLVED").length]];

  return (
    <div className="mc-alerts">
      <div className="mc-counts" role="group" aria-label={t("Alert filters")}>
        {counts.map(([id, label, count]) => (
          <button key={id} type="button" className={`mc-count severity-${id.toLowerCase()}${filter === id ? " selected" : ""}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
            <strong>{count}</strong><span>{t(label)}</span>
          </button>
        ))}
        <p className={`mc-collector${collector.reachable === false ? " down" : ""}`} role="status">
          {collector.reachable === false ? `${t("Collector not answering since {time}", { time: collector.downSince ? new Date(collector.downSince).toLocaleTimeString() : t("now") })}${collector.lastError ? `: ${collector.lastError}` : ""}`
            : collector.lastOkAt ? t("Collector read {time}", { time: new Date(collector.lastOkAt).toLocaleTimeString() }) : t("Collector not read yet")}
        </p>
      </div>
      <ul className="mc-alert-list" aria-label={filter === "history" ? t("Resolved alerts") : t("Firing alerts")}>
        {shown.map((alert) => (
          <li key={alert.id} className={`mc-alert severity-${alert.severity.toLowerCase()}`} data-state={alert.state.toLowerCase()}>
            <button type="button" className="mc-alert-head" aria-expanded={open === alert.id} onClick={() => setOpen(open === alert.id ? null : alert.id)}>
              <span className={`jc-pill mc-severity severity-${alert.severity.toLowerCase()}`}>{t(SEVERITY_LABEL[alert.severity])}</span>
              <strong className="mc-alert-name">{alert.alertname}</strong>
              <span className="mc-alert-instance">{alert.instance || alert.job}</span>
              <span className="mc-alert-age">{alert.state === "FIRING" ? t("for {age}", { age: since(alert.startsAt, t) }) : t("ended {age} ago", { age: alert.endsAt ? since(alert.endsAt, t) : "" })}</span>
            </button>
            {alert.summary ? <p className="mc-alert-line">{alert.summary}</p> : null}
            {open === alert.id ? (
              <div className="mc-alert-detail">
                {alert.description ? <p>{alert.description}</p> : null}
                <dl className="mc-labels">
                  <dt>{t("Source")}</dt><dd>{alert.source === "LOKI" ? t("Loki log rule") : t("Prometheus rule")}</dd>
                  <dt>{t("Started")}</dt><dd>{new Date(alert.startsAt).toLocaleString()}</dd>
                  {Object.entries(alert.labels).filter(([key]) => !["alertname", "severity"].includes(key)).map(([key, value]) => <div key={key} className="mc-label"><dt>{key}</dt><dd>{value}</dd></div>)}
                </dl>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {!shown.length ? <p className="jc-muted jc-empty">{filter === "history" ? t("No resolved alerts in the last 30 days.") : t("Nothing firing.")}</p> : null}
    </div>
  );
}
