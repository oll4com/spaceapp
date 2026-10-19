import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  GatewayAccount, GatewayApiKey, GatewayLogStatusCategory, GatewayProvider, GatewayRequestLog, GatewayRequestLogFacets, GatewayRequestLogFilter, GatewaySettings
} from "@space/contracts";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";
import { gatewayLogsCsvUrl } from "./gateway-log-query.js";
import { accountName, formatCostPrecise, formatDateTime, formatMs, formatTokens, planLabel, providerLabel } from "./space-gateway-model.js";

const ranges = [
  { id: "1h", label: "Last hour", ms: 3_600_000 }, { id: "24h", label: "Last 24 hours", ms: 86_400_000 },
  { id: "7d", label: "Last 7 days", ms: 7 * 86_400_000 }, { id: "30d", label: "Last 30 days", ms: 30 * 86_400_000 }, { id: "all", label: "All kept logs", ms: 0 }
] as const;
type RangeId = (typeof ranges)[number]["id"];

const statusLabels: Record<GatewayLogStatusCategory, string> = {
  SUCCESS: "Success", RATE_LIMITED: "Rate limited", QUOTA: "Quota", CLIENT_CLOSED: "Client closed", ERROR: "Error"
};

/** The same categories as the API (`gatewayLogStatusCategory`). */
function statusOf(log: GatewayRequestLog): GatewayLogStatusCategory {
  if (log.status === "success") return "SUCCESS";
  if (["rate_limit_exceeded", "usage_limit_reached", "rate_limit_error", "http_429"].includes(log.errorCode ?? "")) return "RATE_LIMITED";
  if (["insufficient_quota", "usage_not_included", "quota_exceeded"].includes(log.errorCode ?? "")) return "QUOTA";
  if (log.errorCode === "client_closed") return "CLIENT_CLOSED";
  return "ERROR";
}

type FilterKey = "statuses" | "providers" | "models" | "accountIds" | "apiKeyIds" | "clients";

function FilterMenu({ label, options, selected, onChange }: {
  label: string; options: { value: string; label: string; count: number }[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  return (
    <details className="gw-filter">
      <summary>{label}{selected.length ? ` (${selected.length})` : ""}</summary>
      <div className="gw-filter-menu" role="group" aria-label={label}>
        {options.length === 0 ? <span className="space-gateway-note">Nothing in this period.</span> : options.map((option) => (
          <SpaceToggle key={option.value} compact label={option.label} detail={option.count.toLocaleString("en-US")} checked={selected.includes(option.value)}
            onChange={(checked) => onChange(checked ? [...selected, option.value] : selected.filter((value) => value !== option.value))} />
        ))}
      </div>
    </details>
  );
}

function LogDetail({ log, names, timeFormat, onClose }: {
  log: GatewayRequestLog; names: { account: (id: string | null) => string; key: (id: string | null) => string };
  timeFormat: GatewaySettings["displayTimeFormat"]; onClose: () => void;
}) {
  const saved = log.compressionTokensBefore !== null && log.compressionTokensAfter !== null ? log.compressionTokensBefore - log.compressionTokensAfter : null;
  const rows: [string, string][] = [
    ["Time", formatDateTime(log.requestedAt, timeFormat, { seconds: true })],
    ["Request id", log.requestId],
    ["Status", `${statusLabels[statusOf(log)]}${log.errorCode ? ` · ${log.errorCode}` : ""}`],
    ["Error message", log.errorMessage ?? "—"],
    ["Provider", providerLabel(log.provider)],
    ["Account", `${names.account(log.accountId)}${log.planType ? ` · ${planLabel(log.planType)}` : ""}`],
    ["API key", names.key(log.apiKeyId)],
    ["Client", log.clientName ?? "Unknown"],
    ["Project", log.project ?? "—"],
    ["Model", log.model],
    ["Reasoning effort", log.reasoningEffort ?? "—"],
    ["Service tier", `${log.serviceTier ?? "default"}${log.requestedServiceTier && log.requestedServiceTier !== log.serviceTier ? ` (asked for ${log.requestedServiceTier})` : ""}`],
    ["Transport", `${log.transport ?? "—"} from the client · ${log.upstreamTransport ?? "—"} upstream`],
    ["Time to first token", formatMs(log.firstTokenMs)],
    ["Latency", formatMs(log.latencyMs)],
    ["Input tokens", log.inputTokens === null ? "—" : log.inputTokens.toLocaleString("en-US")],
    ["Cached input", log.cachedInputTokens === null ? "—" : log.cachedInputTokens.toLocaleString("en-US")],
    ["Cache writes", log.cacheCreationTokens === null ? "—" : log.cacheCreationTokens.toLocaleString("en-US")],
    ["Output tokens", log.outputTokens === null ? "—" : log.outputTokens.toLocaleString("en-US")],
    ["Reasoning tokens", log.reasoningTokens === null ? "Not reported" : log.reasoningTokens.toLocaleString("en-US")],
    ["Cost", log.costUsd === null ? "—" : formatCostPrecise(log.costUsd)],
    ["Compression", log.compressionTokensBefore === null ? "Not run" : `${log.compressionTokensBefore.toLocaleString("en-US")} → ${(log.compressionTokensAfter ?? 0).toLocaleString("en-US")} tokens of tool output${log.compressionTokensSaved !== null ? ` · ${log.compressionTokensSaved.toLocaleString("en-US")} saved` : saved !== null && saved > 0 ? ` · would save ${saved.toLocaleString("en-US")} (Shadow)` : ""}`],
    ["Sticky routing", log.stickyKind ? `${log.stickyKind.toLowerCase().replace(/_/g, " ")}${log.stickyKeySource ? ` from ${log.stickyKeySource}` : ""}${log.stickyKeyHash ? ` · ${log.stickyKeyHash}` : ""}` : "None"],
    ["Source", log.source === "limit_warmup" ? "Limit warm-up (left out of statistics)" : "Client request"]
  ];
  return (
    <aside className="gw-drawer" aria-label="Request details">
      <header><h3>Request details</h3><button type="button" className="space-gateway-button" onClick={onClose}>Close</button></header>
      <dl className="gw-facts">{rows.map(([label, value]) => <div key={label} className="gw-fact"><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
    </aside>
  );
}

export function GatewayLogsTab({ client, settings }: { client: SpaceGatewayClient; settings: GatewaySettings | null }) {
  const [range, setRange] = useState<RangeId>("24h");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Record<FilterKey, string[]>>({ statuses: [], providers: [], models: [], accountIds: [], apiKeyIds: [], clients: [] });
  const [rows, setRows] = useState<GatewayRequestLog[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [facets, setFacets] = useState<GatewayRequestLogFacets | null>(null);
  const [accounts, setAccounts] = useState<GatewayAccount[]>([]);
  const [keys, setKeys] = useState<GatewayApiKey[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<GatewayRequestLog | null>(null);
  const [rangeStart, setRangeStart] = useState(() => Date.now());
  const timeFormat = settings?.displayTimeFormat ?? "24H";

  const filter = useMemo<GatewayRequestLogFilter>(() => {
    const span = ranges.find((item) => item.id === range)!.ms;
    return {
      ...(query ? { q: query } : {}),
      ...(span ? { from: new Date(rangeStart - span).toISOString() } : {}),
      ...(selected.statuses.length ? { statuses: selected.statuses as GatewayLogStatusCategory[] } : {}),
      ...(selected.providers.length ? { providers: selected.providers as GatewayProvider[] } : {}),
      ...(selected.models.length ? { models: selected.models } : {}),
      ...(selected.accountIds.length ? { accountIds: selected.accountIds } : {}),
      ...(selected.apiKeyIds.length ? { apiKeyIds: selected.apiKeyIds } : {}),
      ...(selected.clients.length ? { clients: selected.clients } : {})
    };
  }, [query, range, rangeStart, selected]);

  const load = useCallback(async (next: string | null) => {
    setLoading(true);
    try {
      const page = await client.logs({ limit: 50, cursor: next, filter });
      setRows((current) => (next && current ? [...current, ...page.data] : page.data));
      setCursor(page.nextCursor);
      setError(null);
    } catch (reason) {
      setError(errorText(reason, "Could not load request logs."));
    } finally {
      setLoading(false);
    }
  }, [client, filter]);
  useEffect(() => { void load(null); }, [load]);
  useEffect(() => {
    client.logFacets(filter.from ? { from: filter.from } : {}).then(setFacets, () => setFacets(null));
  }, [client, filter.from]);
  useEffect(() => {
    void Promise.all([client.accounts().catch(() => ({ data: [] as GatewayAccount[] })), client.keys().catch(() => ({ data: [] as GatewayApiKey[] }))])
      .then(([nextAccounts, nextKeys]) => { setAccounts(nextAccounts.data); setKeys(nextKeys.data); });
  }, [client]);

  const accountNames = useMemo(() => new Map(accounts.map((account) => [account.id, accountName(account)])), [accounts]);
  const keyNames = useMemo(() => new Map(keys.map((key) => [key.id, key.name])), [keys]);
  const names = useMemo(() => ({
    account: (id: string | null) => (id ? accountNames.get(id) ?? "Removed account" : "No account"),
    key: (id: string | null) => (id ? keyNames.get(id) ?? "Removed key" : "No key")
  }), [accountNames, keyNames]);
  const option = (facet: keyof GatewayRequestLogFacets, label: (value: string) => string) =>
    (facets?.[facet] ?? []).map((item) => ({ value: item.value, label: label(item.value), count: item.count }));
  const setFilter = (key: FilterKey) => (next: string[]) => setSelected((current) => ({ ...current, [key]: next }));
  const active = Object.values(selected).some((values) => values.length > 0) || Boolean(query);

  return (
    <div className="space-gateway-panel gw-logs">
      <form className="space-gateway-toolbar" role="search" onSubmit={(event) => { event.preventDefault(); setQuery(search.trim()); setRangeStart(Date.now()); }}>
        <input className="gw-search" type="search" value={search} aria-label="Search request logs" placeholder="Request id, account, key, model, client or error"
          onChange={(event) => setSearch(event.target.value)} />
        <button type="submit" className="space-gateway-button">Search</button>
        <select className="gw-select" aria-label="Time range" value={range} onChange={(event) => { setRange(event.target.value as RangeId); setRangeStart(Date.now()); }}>
          {ranges.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
        <button type="button" className="space-gateway-button" disabled={loading} onClick={() => setRangeStart(Date.now())}>Refresh</button>
        <a className="space-gateway-button" href={gatewayLogsCsvUrl(filter)} download>Export CSV</a>
      </form>
      <div className="space-gateway-toolbar gw-filters">
        <FilterMenu label="Status" selected={selected.statuses} onChange={setFilter("statuses")}
          options={option("statuses", (value) => statusLabels[value as GatewayLogStatusCategory] ?? value)} />
        <FilterMenu label="Provider" selected={selected.providers} onChange={setFilter("providers")} options={option("providers", providerLabel)} />
        <FilterMenu label="Model" selected={selected.models} onChange={setFilter("models")} options={option("models", (value) => value)} />
        <FilterMenu label="Account" selected={selected.accountIds} onChange={setFilter("accountIds")} options={option("accounts", (value) => names.account(value))} />
        <FilterMenu label="API key" selected={selected.apiKeyIds} onChange={setFilter("apiKeyIds")} options={option("apiKeys", (value) => names.key(value))} />
        <FilterMenu label="Client" selected={selected.clients} onChange={setFilter("clients")} options={option("clients", (value) => value)} />
        {active ? <button type="button" className="space-gateway-button" onClick={() => {
          setSelected({ statuses: [], providers: [], models: [], accountIds: [], apiKeyIds: [], clients: [] }); setSearch(""); setQuery("");
        }}>Clear filters</button> : null}
      </div>
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {!rows ? <p className="space-gateway-empty">Loading request logs…</p> : rows.length === 0
        ? <p className="space-gateway-empty">{active ? "No request matches these filters." : "No requests yet. Requests appear here as soon as clients use Space Gateway."}</p>
        : <div className="space-gateway-table-wrap"><table className="space-gateway-table gw-log-table" aria-label="Request logs">
          <thead><tr><th>Time</th><th>Account</th><th>API key</th><th>Model</th><th>Status</th><th>Latency</th><th>Tokens in</th><th>Cost</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const category = statusOf(row);
              return (
                <tr key={row.id} className={open?.id === row.id ? "is-selected" : undefined} tabIndex={0} aria-label={`Request ${row.requestId}`}
                  onClick={() => setOpen(row)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(row); } }}>
                  <td>{formatDateTime(row.requestedAt, timeFormat, { seconds: true })}</td>
                  <td>{names.account(row.accountId)}{row.planType ? <small>{planLabel(row.planType)}</small> : null}</td>
                  <td>{names.key(row.apiKeyId)}{row.clientName ? <small>{row.clientName}</small> : null}</td>
                  <td>{row.model}<small>{[row.reasoningEffort, row.serviceTier, row.source === "limit_warmup" ? "warm-up" : null].filter(Boolean).join(" · ") || "\u00a0"}</small></td>
                  <td className={category === "SUCCESS" ? "tone-ok" : "tone-warn"} title={row.errorMessage ?? undefined}>{statusLabels[category]}{row.errorCode ? <small>{row.errorCode}</small> : null}</td>
                  <td>{formatMs(row.latencyMs)}<small>{row.firstTokenMs === null ? "\u00a0" : `TTFT ${formatMs(row.firstTokenMs)}`}</small></td>
                  <td>{row.inputTokens === null ? "—" : formatTokens(row.inputTokens)}
                    <small>{row.inputTokens === null ? "\u00a0" : `${row.cachedInputTokens === null ? "—" : formatTokens(row.cachedInputTokens)} cached · ${row.outputTokens === null ? "—" : formatTokens(row.outputTokens)} out`}</small></td>
                  <td>{row.costUsd === null ? "—" : formatCostPrecise(row.costUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table></div>}
      {cursor ? <button type="button" className="space-gateway-button" disabled={loading} onClick={() => void load(cursor)}>Load more</button> : null}
      {open ? <LogDetail log={open} names={names} timeFormat={timeFormat} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}
