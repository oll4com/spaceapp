import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type {
  GatewayAccount, GatewayReport, GatewayReportRow, GatewaySettings, GatewayStatus
} from "@space/contracts";
import { Network, X } from "../ui-theme/app-icons.js";
import { defaultGatewayClient, errorText, type SpaceGatewayClient } from "./gateway-client.js";
import { GatewayAccountsTab } from "./GatewayAccountsTab.js";
import { GatewayCompressionTab } from "./GatewayCompressionTab.js";
import { GatewayDashboardTab } from "./GatewayDashboardTab.js";
import { GatewayKeysTab } from "./GatewayKeysTab.js";
import { GatewayLogsTab } from "./GatewayLogsTab.js";
import { GatewayRoutingTab, GatewaySettingsTab } from "./GatewaySettingsTab.js";
import {
  formatCost, formatTokens
} from "./space-gateway-model.js";
import "./space-gateway.css";

export type { SpaceGatewayClient } from "./gateway-client.js";

/** "overview" is the former name of the dashboard tab. */
export type SpaceGatewayTab = "dashboard" | "overview" | "accounts" | "keys" | "logs" | "reports" | "routing" | "compression" | "settings";

const tabs: { id: SpaceGatewayTab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "accounts", label: "Accounts" },
  { id: "keys", label: "API keys" },
  { id: "logs", label: "Request logs" },
  { id: "reports", label: "Reports" },
  { id: "routing", label: "Routing" },
  { id: "compression", label: "Compression" },
  { id: "settings", label: "Settings" }
];

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="space-gateway-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
      {detail ? <span>{detail}</span> : null}
    </div>
  );
}

const reportRanges = [{ days: 7, label: "7 days" }, { days: 28, label: "28 days" }, { days: 90, label: "90 days" }] as const;

function isoDay(date: Date) { return date.toISOString().slice(0, 10); }

function reportCsv(report: GatewayReport): string {
  const header = ["day", "requests", "errors", "input_tokens", "cached_input_tokens", "output_tokens", "reasoning_tokens", "reasoning_reported", "cost_usd", "compression_tokens_saved"];
  const lines = report.days.map((row) => [row.key, row.requests, row.errors, row.inputTokens, row.cachedInputTokens, row.outputTokens,
    row.reasoningTokens, row.reasoningReported, row.costUsd.toFixed(6), row.compressionTokensSaved].join(","));
  return [header.join(","), ...lines].join("\n") + "\n";
}

function ReportTable({ rows, label, keyLabel }: { rows: GatewayReportRow[]; label: string; keyLabel: (key: string) => string }) {
  return (
    <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label={label}>
      <thead><tr><th>{label}</th><th>Requests</th><th>Errors</th><th>Input</th><th>Cached</th><th>Output</th><th>Reasoning</th><th>Cost</th></tr></thead>
      <tbody>{rows.map((row) => (
        <tr key={row.key}>
          <td>{keyLabel(row.key)}</td><td>{formatTokens(row.requests)}</td><td>{row.errors}</td><td>{formatTokens(row.inputTokens)}</td>
          <td>{formatTokens(row.cachedInputTokens)}</td><td>{formatTokens(row.outputTokens)}</td>
          <td title={`${row.reasoningReported} of ${row.requests} requests reported reasoning`}>{row.reasoningReported ? formatTokens(row.reasoningTokens) : "—"}</td>
          <td>{formatCost(row.costUsd)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function ReportsTab({ client }: { client: SpaceGatewayClient }) {
  const [days, setDays] = useState<number>(7);
  const [report, setReport] = useState<GatewayReport | null>(null);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    setReport(null);
    void Promise.all([client.report(isoDay(from), isoDay(to)), client.accounts().catch(() => ({ data: [] as GatewayAccount[] }))])
      .then(([result, accounts]) => {
        if (cancelled) return;
        setReport(result);
        setLabels(Object.fromEntries(accounts.data.map((account) => [account.id, account.label])));
        setError(null);
      })
      .catch((reason) => { if (!cancelled) setError(errorText(reason, "Could not load the report.")); });
    return () => { cancelled = true; };
  }, [client, days]);

  function exportCsv() {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([reportCsv(report)], { type: "text/csv" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `space-gateway-${report.from}-to-${report.to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  const peak = Math.max(1, ...(report?.days.map((row) => row.requests) ?? [1]));
  return (
    <div className="space-gateway-panel">
      <div className="space-gateway-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="Report range">
          {reportRanges.map((range) => (
            <button key={range.days} type="button" role="tab" aria-selected={days === range.days} className={`filter-tab${days === range.days ? " active" : ""}`}
              onClick={() => setDays(range.days)}>{range.label}</button>
          ))}
        </div>
        <button type="button" className="space-gateway-button" disabled={!report || report.days.length === 0} onClick={exportCsv}>Export CSV</button>
      </div>
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {!report ? (error ? null : <p className="space-gateway-empty">Loading report…</p>) : report.days.length === 0
        ? <p className="space-gateway-empty">No requests in this period.</p>
        : <>
          <dl className="space-gateway-stats" aria-label="Report totals">
            <Stat label="Requests" value={formatTokens(report.totals.requests)} detail={`${report.totals.errors} errors`} />
            <Stat label="Input tokens" value={formatTokens(report.totals.inputTokens)} detail={`${formatTokens(report.totals.cachedInputTokens)} cached`} />
            <Stat label="Output tokens" value={formatTokens(report.totals.outputTokens)} />
            <Stat label="Cost (API equivalent)" value={formatCost(report.totals.costUsd)} />
          </dl>
          <div className="space-gateway-bars" role="img" aria-label="Requests per day">
            {report.days.map((row) => (
              <span key={row.key} title={`${row.key}: ${row.requests} requests`} style={{ height: `${Math.max(4, (row.requests / peak) * 100)}%` }} />
            ))}
          </div>
          <ReportTable rows={[...report.days].reverse()} label="Day" keyLabel={(key) => key} />
          <ReportTable rows={report.models} label="Model" keyLabel={(key) => key} />
          <ReportTable rows={report.accounts} label="Account" keyLabel={(key) => labels[key] ?? (key ? "Removed account" : "No account")} />
        </>}
    </div>
  );
}

export function SpaceGatewayDialog({ client = defaultGatewayClient, embedded = false, fullscreen = false, initialTab = "dashboard", onClose }: {
  client?: SpaceGatewayClient;
  /** Inside a Workspace menu page: no backdrop, no close button. */
  embedded?: boolean;
  /** A full-screen page over the workspace, like the memory workspace; Escape and the close button leave it. */
  fullscreen?: boolean;
  initialTab?: SpaceGatewayTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SpaceGatewayTab>(initialTab === "overview" ? "dashboard" : initialTab);
  const [focusAccountId, setFocusAccountId] = useState<string | null>(null);
  /** Routing's "Add Claude API key" shortcut: Accounts opens with that form. */
  const [addClaudeApiKey, setAddClaudeApiKey] = useState(false);
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await client.status()); setError(null); }
    catch (reason) { setError(errorText(reason, "Could not load Space Gateway status.")); }
  }, [client]);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const onSettingsSaved = useCallback((settings: GatewaySettings) => {
    setStatus((current) => (current ? { ...current, settings } : current));
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && !embedded) { event.stopPropagation(); onClose(); }
  }

  const settings = status?.settings ?? null;
  const content = useMemo(() => {
    if (tab === "accounts") {
      return <GatewayAccountsTab key={focusAccountId ?? (addClaudeApiKey ? "add-claude-api-key" : "accounts")} client={client} settings={settings} initialAccountId={focusAccountId}
        initialAdd={addClaudeApiKey ? "claude-api-key" : null} onChanged={() => void refresh()} />;
    }
    if (tab === "keys") return <GatewayKeysTab client={client} settings={settings} onChanged={() => void refresh()} />;
    if (tab === "logs") return <GatewayLogsTab client={client} settings={settings} />;
    if (tab === "reports") return <ReportsTab client={client} />;
    if (tab === "dashboard" || tab === "overview") {
      return <GatewayDashboardTab client={client} status={status} onOpenLogs={() => setTab("logs")}
        onOpenAccount={(accountId) => { setFocusAccountId(accountId); setTab("accounts"); }} />;
    }
    if (!status) return error ? null : <p className="space-gateway-empty">Loading Space Gateway…</p>;
    if (tab === "routing") {
      return <GatewayRoutingTab key={status.settings.updatedAt} settings={status.settings} client={client} onSaved={onSettingsSaved}
        onAddClaudeApiKey={() => { setFocusAccountId(null); setAddClaudeApiKey(true); setTab("accounts"); }} />;
    }
    if (tab === "compression") return <GatewayCompressionTab key={status.settings.updatedAt} settings={status.settings} client={client} onSaved={onSettingsSaved} />;
    return <GatewaySettingsTab key={status.settings.updatedAt} settings={status.settings} status={status} client={client} onSaved={onSettingsSaved} />;
  }, [tab, status, settings, error, client, refresh, onSettingsSaved, focusAccountId, addClaudeApiKey]);

  const page = embedded || fullscreen;
  return (
    <div className={`space-gateway-backdrop${embedded ? " manage-embedded" : ""}${fullscreen ? " fullscreen" : ""}`} onMouseDown={(event) => {
      if (!page && event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialogRef} className="space-gateway-dialog" role={page ? "region" : "dialog"} aria-modal={page ? undefined : true}
        aria-label="Space Gateway" onKeyDown={handleKeyDown}>
        <header className="space-gateway-header">
          <span className="space-gateway-icon"><Network aria-hidden="true" /></span>
          <div>
            <h2>Space Gateway</h2>
            <p>Account load balancing and context compression for every AI provider in Space.</p>
          </div>
          <button type="button" aria-label="Close Space Gateway" onClick={onClose}><X aria-hidden="true" /></button>
        </header>
        <div className="filter-tabs space-gateway-tabs" role="tablist" aria-label="Space Gateway sections">
          {tabs.map((item) => (
            <button key={item.id} type="button" role="tab" aria-selected={tab === item.id} className={`filter-tab${tab === item.id ? " active" : ""}`}
              onClick={() => { setFocusAccountId(null); setAddClaudeApiKey(false); setTab(item.id); }}>{item.label}</button>
          ))}
        </div>
        {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
        {content}
      </section>
    </div>
  );
}
