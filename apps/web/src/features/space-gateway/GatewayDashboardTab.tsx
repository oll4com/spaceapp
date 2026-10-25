import { useCallback, useEffect, useState, type ReactNode } from "react";
import type {
  GatewayAccount, GatewayDashboard, GatewayDashboardRange, GatewayHealth, GatewayLatencyRow, GatewayPool, GatewayPoolWindow, GatewaySettings, GatewayStatus
} from "@space/contracts";
import { AnimatedNumber } from "../ui-controls/AnimatedNumber.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";
import { Donut, RemainingBar, Sparkline, StatusChip, TrendChart } from "./gateway-charts.js";
import {
  accountName, accountStatusLabel, accountStatusTone, formatAgo, formatCost, formatCostPrecise, formatCountdown, formatCredits, formatDateTime, formatMs,
  formatPercent, formatTokens, planLabel, providerLabel, serviceStateLabel, statusTone
} from "./space-gateway-model.js";

const ranges: { id: GatewayDashboardRange; label: string }[] = [
  { id: "24h", label: "24 hours" }, { id: "7d", label: "7 days" }, { id: "28d", label: "28 days" }
];

/** A key figure; small counts roll to their new value. */
function Kpi({ label, value, detail, numeric, children }: { label: string; value: string; detail?: string; numeric?: number; children?: ReactNode }) {
  return (
    <div className="space-gateway-stat gw-kpi">
      <dt>{label}</dt>
      <dd>{numeric !== undefined && numeric < 10_000 ? <AnimatedNumber className="gw-kpi-number" value={numeric} /> : value}</dd>
      {detail ? <span>{detail}</span> : null}
      {children}
    </div>
  );
}

const remaining = (window: GatewayAccount["primaryWindow"]) => (window.usedPercent === null ? null : Math.max(0, 100 - window.usedPercent));

function PoolDonuts({ pool, showBurn }: { pool: GatewayPool; showBurn: boolean }) {
  const donut = (window: GatewayPoolWindow, title: string) => (
    <div className="gw-pool-window">
      <h4>{title}</h4>
      <Donut label={`${providerLabel(pool.provider)} ${title} remaining by account`} formatValue={formatCredits}
        slices={window.accounts.filter((account) => account.capacityCredits > 0).map((account) => ({
          key: account.accountId, label: account.label, value: account.remainingCredits,
          detail: `${planLabel(account.planType)} · ${account.remainingPercent === null ? "—" : formatPercent(account.remainingPercent)}`
        }))}
        centerValue={formatCredits(window.remainingCredits)} centerDetail={`of ${formatCredits(window.capacityCredits)} left`} />
      <p className="space-gateway-note">
        {window.remainingPercent === null ? "No capacity" : `${formatPercent(window.remainingPercent)} left`} · {formatCountdown(window.resetAt)}
        {showBurn && window.burnAccounts !== null ? ` · on pace for ${window.burnAccounts.toFixed(1)} accounts` : ""}
      </p>
    </div>
  );
  return (
    <section className="gw-card" aria-label={`${providerLabel(pool.provider)} capacity`}>
      <header><h3>{providerLabel(pool.provider)} capacity</h3><span className="space-gateway-note">{pool.accounts} account{pool.accounts === 1 ? "" : "s"} · Plus-equivalent credits</span></header>
      <div className="gw-pool-grid">
        {donut(pool.primary, "5h")}
        {donut(pool.secondary, "Weekly")}
      </div>
    </section>
  );
}

function LatencyTable({ rows, label, routes = false }: { rows: GatewayLatencyRow[]; label: string; routes?: boolean }) {
  if (rows.length === 0) return <p className="space-gateway-empty">No requests in this period.</p>;
  return (
    <div className="space-gateway-table-wrap">
      <table className="space-gateway-table" aria-label={label}>
        <thead><tr><th>{routes ? "Route" : "Model"}</th>{routes ? <><th>TTFT p95</th><th>Done p95</th></> : <><th>Avg / p50</th><th>p95</th><th>TTFT p95</th></>}
          <th>Samples</th><th>Errors</th><th>Status</th></tr></thead>
        <tbody>{rows.map((row) => (
          <tr key={row.key}>
            <td title={row.label}>{row.label}</td>
            {routes ? <><td>{formatMs(row.ttftP95Ms)}</td><td>{formatMs(row.p95Ms)}</td></>
              : <><td>{formatMs(row.averageMs)} / {formatMs(row.p50Ms)}</td><td>{formatMs(row.p95Ms)}</td><td>{formatMs(row.ttftP95Ms)}</td></>}
            <td>{row.samples.toLocaleString("en-US")}</td>
            <td>{row.errors > 0 ? `${row.errors} (${(row.errorRate * 100).toFixed(1)}%)` : "0"}</td>
            <td title={row.detail}><StatusChip status={row.status} /></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function HealthSignals({ health, timeFormat }: { health: GatewayHealth | null; timeFormat: GatewaySettings["displayTimeFormat"] }) {
  if (!health) return <p className="space-gateway-empty">Checking signals…</p>;
  return (
    <ul className="gw-signals" aria-label="Health signals">
      {health.signals.map((signal) => (
        <li key={signal.key} className={`gw-signal gw-signal-${signal.status.toLowerCase()}`}>
          <div className="gw-signal-head"><strong>{signal.label}</strong><StatusChip status={signal.status} /></div>
          <div className="gw-signal-now">{formatMs(signal.nowMs)}<Sparkline values={signal.sparkline} max={signal.criticalMs ?? undefined} /></div>
          <span className="space-gateway-note">p50 {formatMs(signal.p50Ms)} · p95 {formatMs(signal.p95Ms)} · {signal.samples} sample{signal.samples === 1 ? "" : "s"}</span>
          <span className="space-gateway-note" title={signal.detail}>{signal.detail}</span>
          <span className="space-gateway-note">Updated {signal.updatedAt ? formatDateTime(signal.updatedAt, timeFormat, { date: false, seconds: true }) : "never"}</span>
        </li>
      ))}
    </ul>
  );
}

export function GatewayDashboardTab({ client, status, onOpenAccount, onOpenLogs }: {
  client: SpaceGatewayClient;
  status: GatewayStatus | null;
  onOpenAccount: (accountId: string) => void;
  onOpenLogs: () => void;
}) {
  const [range, setRange] = useState<GatewayDashboardRange>("24h");
  const [dashboard, setDashboard] = useState<GatewayDashboard | null>(null);
  const [health, setHealth] = useState<GatewayHealth | null>(null);
  const [accounts, setAccounts] = useState<GatewayAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const settings = status?.settings;
  const timeFormat = settings?.displayTimeFormat ?? "24H";
  const windows = settings?.displayAccountWindows ?? "BOTH";
  const showBurn = settings?.displayBurnProjection ?? true;

  const load = useCallback(async (selected: GatewayDashboardRange) => {
    setLoading(true);
    try {
      const [next, nextAccounts] = await Promise.all([client.dashboard(selected), client.accounts()]);
      setDashboard(next);
      setAccounts(nextAccounts.data);
      setError(null);
    } catch (reason) {
      setError(errorText(reason, "Could not load the dashboard."));
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
    client.health().then(setHealth, () => undefined);
  }, [client]);

  useEffect(() => {
    void load(range);
    const timer = window.setInterval(() => void load(range), 30_000);
    return () => window.clearInterval(timer);
  }, [load, range]);

  const service = status?.service;
  const totals = dashboard?.totals;
  const tokens = totals ? totals.inputTokens + totals.outputTokens : 0;
  const cachedPercent = totals && totals.inputTokens > 0 ? (totals.cachedInputTokens / totals.inputTokens) * 100 : 0;
  const per = dashboard?.perPeriod.unit === "hour" ? "hour" : "day";
  const codexPool = dashboard?.pools.find((pool) => pool.provider === "CODEX") ?? dashboard?.pools[0];

  return (
    <div className="space-gateway-panel gw-dashboard">
      <div className="space-gateway-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="Dashboard range">
          {ranges.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={range === item.id} className={`filter-tab${range === item.id ? " active" : ""}`}
              onClick={() => setRange(item.id)}>{item.label}</button>
          ))}
        </div>
        <button type="button" className="space-gateway-button" disabled={loading} onClick={() => void load(range)}>{loading ? "Refreshing…" : "Refresh"}</button>
        {dashboard ? <span className="space-gateway-note">Updated {formatDateTime(dashboard.generatedAt, timeFormat, { date: false, seconds: true })}</span> : null}
      </div>

      {service ? (
        <div className={`space-gateway-service tone-${statusTone(service.state)}`} role="status">
          <strong>{serviceStateLabel(service.state)}</strong>
          <span>
            {service.state === "RUNNING" || service.state === "DRAINING"
              ? `Version ${service.version ?? "unknown"} · ${service.listen ?? "unknown address"} · ${service.inFlightRequests ?? 0} in flight`
              : service.error ?? "The gateway service did not report its state."}
          </span>
        </div>
      ) : null}

      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {!dashboard || !totals ? (error ? null : <p className="space-gateway-empty">Loading the dashboard…</p>) : (
        <>
          <dl className="space-gateway-stats gw-kpis" aria-label="Key figures">
            <Kpi label="Requests" value={formatTokens(totals.requests)} numeric={totals.requests}
              detail={`${dashboard.perPeriod.requests.toLocaleString("en-US", { maximumFractionDigits: 1 })} per ${per}`} />
            <Kpi label="Tokens" value={formatTokens(tokens)} detail={`${formatPercent(cachedPercent)} of input cached`} />
            <Kpi label="Estimated API cost" value={formatCost(totals.costUsd)} detail={`${formatCostPrecise(dashboard.perPeriod.costUsd)} per ${per}`} />
            {showBurn && codexPool ? (
              <Kpi label="Account burn" value={`${codexPool.primary.burnAccounts?.toFixed(1) ?? "—"} / ${codexPool.secondary.burnAccounts?.toFixed(1) ?? "—"}`}
                detail="Projected accounts used per 5h / 7d" />
            ) : null}
            <Kpi label="Error rate" value={dashboard.errorRate.errorRate === null ? "—" : `${(dashboard.errorRate.errorRate * 100).toFixed(1)}%`}
              detail={`7d ${dashboard.errorRate7d.errorRate === null ? "—" : `${(dashboard.errorRate7d.errorRate * 100).toFixed(1)}%`} · 5m ${dashboard.errorRate5m.errorRate === null ? "—" : `${(dashboard.errorRate5m.errorRate * 100).toFixed(1)}%`}${dashboard.errorRate.topError ? ` · Top: ${dashboard.errorRate.topError.code}` : ""}`} />
          </dl>

          <section className="gw-card" aria-label="Requests over time">
            <header><h3>Requests</h3><span className="space-gateway-note">{formatTokens(totals.errors)} errors · {formatTokens(totals.rateLimited)} rate limited</span></header>
            <TrendChart label="Requests and errors over time" timeFormat={timeFormat} showDate={range !== "24h"} legendValue="sum"
              formatValue={(value) => Math.round(value).toLocaleString("en-US")}
              series={[{ id: "requests", label: "Requests", points: dashboard.trend.map((point) => ({ t: point.t, value: point.requests })) },
                { id: "errors", label: "Errors", points: dashboard.trend.map((point) => ({ t: point.t, value: point.errors })) }]} />
          </section>

          <div className="gw-two">
            <section className="gw-card" aria-label="Top API keys by cost">
              <header><h3>Top API keys by cost</h3></header>
              <Donut label="Cost by API key" formatValue={formatCostPrecise} centerValue={formatCost(totals.costUsd)} centerDetail="total"
                slices={dashboard.topKeys.map((key) => ({ key: key.apiKeyId, label: key.name, value: key.costUsd, detail: `${key.requests.toLocaleString("en-US")} requests`, other: key.apiKeyId === "other" }))} />
            </section>
            <section className="gw-card" aria-label="Top models by cost">
              <header><h3>Top models by cost</h3></header>
              <Donut label="Cost by model" formatValue={formatCostPrecise} centerValue={formatCost(totals.costUsd)} centerDetail="total"
                slices={dashboard.topModels.map((model) => ({ key: model.model, label: model.model, value: model.costUsd, detail: `${model.requests.toLocaleString("en-US")} requests`, other: model.model === "Other models" }))} />
            </section>
          </div>

          {dashboard.pools.map((pool) => <PoolDonuts key={pool.provider} pool={pool} showBurn={showBurn} />)}

          <section className="gw-card" aria-label="Live account usage">
            <header><h3>Live account usage</h3><span className="space-gateway-note">In flight now and used in the last minute</span></header>
            {dashboard.live.length === 0 ? <p className="space-gateway-empty">No account served a request in the last minute.</p> : (
              <ul className="gw-live">
                {dashboard.live.map((row) => (
                  <li key={row.accountId}>
                    <span className={`gw-status gw-status-${row.state === "LIVE" ? "ok" : "unavailable"}`}><span aria-hidden="true">{row.state === "LIVE" ? "●" : "○"}</span>{row.state === "LIVE" ? "Live" : "Recent"}</span>
                    <strong>{row.label}</strong>
                    <span className="space-gateway-chip">{planLabel(row.planType)}</span>
                    <span className="space-gateway-note">{row.activeRequests ?? 0} in flight · {row.requests} request{row.requests === 1 ? "" : "s"} · {formatTokens(row.tokens)} tokens
                      {row.model ? ` · ${row.model}` : ""}{row.lastAt ? ` · ${formatAgo(row.lastAt, now, timeFormat)}` : ""}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="gw-card" aria-label="Latency">
            <header><h3>Latency</h3><span className="space-gateway-note">Signals keep their last 30 samples; model and route figures cover the selected range</span></header>
            <HealthSignals health={health} timeFormat={timeFormat} />
            <h4>Latency by model</h4>
            <LatencyTable rows={dashboard.latencyByModel} label="Latency by model" />
            <h4>Upstream routes</h4>
            <LatencyTable rows={dashboard.routes} label="Upstream routes" routes />
          </section>

          {accounts && accounts.length > 0 ? (
            <section className="gw-card" aria-label="Accounts">
              <header><h3>Accounts</h3></header>
              <ul className="gw-account-cards">
                {accounts.map((account) => (
                  <li key={account.id} className={`gw-account-card status-${account.status.toLowerCase()}`}>
                    <div className="gw-account-card-head">
                      <strong title={account.label}>{accountName(account)}</strong>
                      <span className={`space-gateway-chip tone-${accountStatusTone(account.status)}`}>{accountStatusLabel(account.status)}</span>
                    </div>
                    <span className="space-gateway-note">{providerLabel(account.provider)} · {planLabel(account.planType)}
                      {account.resetCreditsAvailable ? ` · ${account.resetCreditsAvailable} reset credit${account.resetCreditsAvailable === 1 ? "" : "s"}` : ""}
                      {account.warmupEnabled ? " · Warm-up on" : ""}</span>
                    {windows !== "SECONDARY" ? <RemainingBar label="5h" remaining={remaining(account.primaryWindow)} resetAt={account.primaryWindow.resetAt} now={now} /> : null}
                    {windows !== "PRIMARY" ? <RemainingBar label="Weekly" remaining={remaining(account.secondaryWindow)} resetAt={account.secondaryWindow.resetAt} now={now} /> : null}
                    <button type="button" className="space-gateway-button" onClick={() => onOpenAccount(account.id)}>Details</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="gw-card" aria-label="Recent requests">
            <header><h3>Recent requests</h3><button type="button" className="space-gateway-button" onClick={onOpenLogs}>All request logs</button></header>
            {dashboard.recent.length === 0 ? <p className="space-gateway-empty">No requests yet.</p> : (
              <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Recent requests">
                <thead><tr><th>Time</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens in / out</th><th>Cost</th></tr></thead>
                <tbody>{dashboard.recent.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.requestedAt, timeFormat, { seconds: true })}</td>
                    <td>{row.model}{row.source === "limit_warmup" ? " · warm-up" : ""}</td>
                    <td className={row.status === "success" ? "tone-ok" : "tone-warn"}>{row.errorCode ?? row.status}</td>
                    <td>{formatMs(row.latencyMs)}</td>
                    <td>{row.inputTokens === null ? "—" : formatTokens(row.inputTokens)} / {row.outputTokens === null ? "—" : formatTokens(row.outputTokens)}</td>
                    <td>{row.costUsd === null ? "—" : formatCostPrecise(row.costUsd)}</td>
                  </tr>
                ))}</tbody>
              </table></div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
