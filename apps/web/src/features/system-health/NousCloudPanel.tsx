import { useEffect, useState } from "react";
import type { NousCloudInstall, NousCloudReport } from "@space/contracts";
import { api } from "../../api.js";
import { formatAppTime } from "../date-time-settings/date-time-settings.js";
import { useHistoryPeriodDays } from "../history-period/use-history-period.js";

/** Resources › Nous Cloud (ADMIN): every Nous Cloud install's telemetry from oll4.com (docs/agents/nous-cloud-telemetry.md). */
const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;
const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const usd = (value: number | null) => (value == null ? "—" : `$${value.toFixed(2)}`);
const tokens = (value: number) => (value >= 1e6 ? `${(value / 1e6).toFixed(2)}M` : value >= 1e3 ? `${(value / 1e3).toFixed(1)}k` : String(value));
const hours = (seconds: number) => `${(seconds / 3600).toFixed(1)} h`;
const when = (at: string | null) => (at ? formatAppTime(at) : "—");

function Install({ install }: { install: NousCloudInstall }) {
  const { sandbox, app, totals } = install;
  const facts: Array<[string, string]> = [
    ["Status", install.status === "revoked" ? `Revoked ${when(install.revokedAt)}` : install.status === "running" ? "Running" : "Asleep"],
    ["Last seen", when(install.lastSeen)],
    ["App", [app.version, app.build != null ? `build ${app.build}` : null, app.device].filter(Boolean).join(" · ") || "—"],
    ["Sandbox", sandbox ? `SpaceApp ${sandbox.version ?? "?"} · up ${sandbox.uptimeSeconds != null ? hours(sandbox.uptimeSeconds) : "—"} · ${usd(sandbox.usdPerHour)}/h` : "No snapshot yet"],
    ["Storage", sandbox ? [sandbox.dbBytes != null ? `DB ${mb(sandbox.dbBytes)}` : null, sandbox.disk && `disk ${gb(sandbox.disk.used)} of ${gb(sandbox.disk.size)}`, sandbox.memory && `RAM ${gb(sandbox.memory.used)} of ${gb(sandbox.memory.total)}`].filter(Boolean).join(" · ") : "—"],
    ["Sign-ins", install.logins == null ? "—" : `${install.logins}, last ${when(install.lastLogin)}`],
    ["Requests", `${totals.requests}, ${totals.errors} errors, last ${when(install.lastTurn)}`],
    ["Cost", `models ${usd(totals.modelCostUsd)} · sandbox ${usd(totals.sandboxCostUsd)} for ${hours(totals.sandboxSeconds)}`],
    ["Latest error", install.lastError ? `${when(install.lastError.at)} (${install.lastError.source}): ${install.lastError.text}` : "None"],
  ];
  return (
    <section className="health-panel">
      <header className="health-section-heading">
        <div>
          <span className="health-eyebrow">{install.email}</span>
          <h2>{install.name || `Person ${install.person}`}</h2>
        </div>
      </header>
      <dl>
        {facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>
      {install.models.length > 0 && <div className="health-table-scroll">
        <table>
          <thead><tr><th>Model that answered</th><th>From</th><th>Requests</th><th>Errors</th><th>Tokens</th><th>Cost</th></tr></thead>
          <tbody>{install.models.map((model) => <tr key={`${model.source}:${model.model}`}>
            <td>{model.model}</td><td>{model.source === "nous" ? "Nous" : "CLI"}{model.free ? " · free" : ""}</td>
            <td>{model.requests}</td><td>{model.errors}</td><td>{tokens(model.tokens)}</td><td>{usd(model.costUsd)}</td>
          </tr>)}</tbody>
        </table>
      </div>}
      {install.days.length > 0 && <div className="health-table-scroll">
        <table>
          <thead><tr><th>Day</th><th>Sandbox time</th><th>Sandbox cost</th><th>Requests</th><th>Errors</th><th>Tokens</th><th>Model cost</th><th>App events</th></tr></thead>
          <tbody>{install.days.map((day) => <tr key={day.d}>
            <td>{day.d}</td><td>{hours(day.sandboxSeconds)}</td><td>{usd(day.sandboxCostUsd)}</td><td>{day.requests}</td><td>{day.errors}</td>
            <td>{tokens(day.tokens)}</td><td>{usd(day.modelCostUsd)}</td>
            <td>{Object.entries(day.events).map(([name, count]) => `${name} ${count}`).join(", ")}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </section>
  );
}

export function NousCloudPanel() {
  const days = useHistoryPeriodDays();
  const [report, setReport] = useState<NousCloudReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    // The provisioner snapshots every 5 minutes; a minute's refresh keeps status current without asking oll4.com more than needed.
    const load = () => api.nousCloud(days).then((next) => { if (active) { setReport(next); setError(null); } },
      (cause: unknown) => { if (active) setError(cause instanceof Error ? cause.message : "Nous Cloud telemetry could not be read."); });
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [days]);
  return (
    <div className="health-stack">
      <header className="health-section-heading">
        <div>
          <span className="health-eyebrow">NOUS CLOUD</span>
          <h2>Nous Cloud installs</h2>
          <p>Per install: sandbox, app, models, requests, errors, sign-ins and cost for the last {days} days. Refreshes every minute.</p>
        </div>
      </header>
      {error && <div className="health-error" role="status">{error}</div>}
      {!report && !error && <p role="status">Loading…</p>}
      {report?.installs.length === 0 && <p>No Nous Cloud installs yet.</p>}
      {report?.installs.map((install) => <Install key={install.person} install={install} />)}
    </div>
  );
}
