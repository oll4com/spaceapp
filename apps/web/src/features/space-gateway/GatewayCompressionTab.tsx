import { Fragment, useEffect, useState } from "react";
import type {
  GatewayCompressionMode, GatewayCompressionProfile, GatewayCompressionProviderId, GatewayCompressionProviders, GatewayCompressionProviderSettings,
  GatewayCompressionStats, GatewayHeadroomHistory, GatewayHeadroomLifetime, GatewayHeadroomSession, GatewayHistorySeries, GatewayOutputPolicy, GatewaySettings
} from "@space/contracts";
import { RemainingBar, TrendChart } from "./gateway-charts.js";
import { errorText, type SpaceGatewayClient } from "./gateway-client.js";
import { SaveMessage, useSettingsSaver } from "./GatewaySettingsTab.js";
import {
  compressionModeOptions, compressionProviderIds, formatCostPrecise, formatCountdown, formatDateTime, formatMs, formatPercent, formatTokens, outputPolicyOptions,
  planLabel, providerLabel
} from "./space-gateway-model.js";

/**
 * The compression workspace: the settings, then Headroom's Session, Lifetime and Historical views and the savings by
 * strategy. Counts are tokens; dollars use each model's list input price (unpriced models count tokens only).
 */
type View = "session" | "lifetime" | "history" | "strategies";
const views: { id: View; label: string }[] = [
  { id: "session", label: "Session" }, { id: "lifetime", label: "Lifetime" }, { id: "history", label: "Historical" }, { id: "strategies", label: "By strategy" }
];

const wasteLabels: Record<string, string> = {
  json_bloat: "JSON bloat", html_noise: "HTML noise", base64: "Base64 blobs", whitespace: "Whitespace", reread: "Re-reads"
};
const stageLabels: Record<string, string> = {
  content_router: "Content router", waste_signals: "Waste detection", token_count: "Token count", pipeline_total: "Pipeline total",
  "compressor:smart_crusher": "JSON (SmartCrusher)", "compressor:log_compressor": "Logs", "compressor:search_compressor": "Search results",
  "compressor:diff_compressor": "Diffs", "compressor:lossless_fold": "Lossless folds", "compressor:code_aware": "Source code (CodeAware)",
  "compressor:text_crusher": "Prose (TextCrusher)", "compressor:mixed": "Mixed content", "compressor:json_fields": "JSON fields",
  json_check: "JSON check", compressor: "Compressor (unchanged)"
};
const strategyLabels: Record<string, string> = {
  smart_crusher: "JSON (SmartCrusher)", log_compressor: "Logs", search_compressor: "Search results", diff_compressor: "Diffs",
  lossless_fold: "Lossless folds", code_aware: "Source code (CodeAware)", text_crusher: "Prose (TextCrusher)", mixed: "Mixed content",
  html_extractor: "Web pages (HTML)", json_fields: "JSON fields"
};
const codeTextOptions: { value: GatewayCompressionMode; label: string; description: string }[] = [
  { value: "OFF", label: "Off", description: "Source code and prose pass through unchanged." },
  { value: "ON", label: "On", description: "Compress code and prose too when compression is on. File reads keep their exact text." }
];
const outputPolicyLabel = (policy: GatewayOutputPolicy | undefined) => outputPolicyOptions.find((option) => option.value === policy)?.label ?? "None";
const tps = (value: number | null) => (value === null ? "—" : `${Math.round(value).toLocaleString("en-US")} tok/s`);

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <div className="space-gateway-stat"><dt>{label}</dt><dd>{value}</dd>{detail ? <span>{detail}</span> : null}</div>;
}

/** Magnitudes of one kind: one hue, bar length relative to the largest, value as text. */
function MagnitudeBars({ rows, label, format }: { rows: { key: string; label: string; value: number }[]; label: string; format: (value: number) => string }) {
  if (rows.length === 0) return <p className="space-gateway-empty">Nothing recorded yet.</p>;
  const max = Math.max(1, ...rows.map((row) => row.value));
  return (
    <ul className="gw-magnitudes" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key}>
          <span className="gw-magnitude-label">{row.label}</span>
          <span className="gw-magnitude-track"><span style={{ width: `${Math.max(1, (row.value / max) * 100)}%` }} /></span>
          <span className="gw-magnitude-value">{format(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function ClientTable({ rows, label }: { rows: GatewayHeadroomSession["agents"]; label: string }) {
  if (rows.length === 0) return <p className="space-gateway-empty">No requests yet.</p>;
  return (
    <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label={label}>
      <thead><tr><th>Client</th><th>Requests</th><th>Before</th><th>After</th><th>Saved</th><th>Output</th><th>Share of saved</th><th>Share of requests</th></tr></thead>
      <tbody>{rows.map((row) => (
        <tr key={row.key}><td>{row.key}</td><td>{formatTokens(row.requests)}</td><td>{formatTokens(row.beforeTokens)}</td><td>{formatTokens(row.afterTokens)}</td>
          <td>{formatTokens(row.savedTokens)} <small>({formatPercent(row.savingsPercent)})</small></td><td>{formatTokens(row.outputTokens)}</td>
          <td>{formatPercent(row.shareOfSavedPercent)}</td><td>{formatPercent(row.shareOfRequestsPercent)}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

function SessionView({ session, timeFormat }: { session: GatewayHeadroomSession; timeFormat: GatewaySettings["displayTimeFormat"] }) {
  const [open, setOpen] = useState<string | null>(null);
  const cache = session.prefixCache;
  const cacheTotal = cache.readTokens + cache.writeTokens;
  return (
    <>
      <p className="space-gateway-note">Since the gateway worker started {session.since ? formatDateTime(session.since, timeFormat) : "(unknown)"}
        {session.sampled ? " · the newest 20,000 requests" : ""} · mode {session.compressionMode.toLowerCase()}</p>
      <div className="gw-two">
        <section className="gw-card" aria-label="Request health">
          <header><h3>Request health</h3></header>
          <dl className="space-gateway-stats gw-compact-stats">
            <Stat label="Completed" value={formatTokens(session.requests.completed)} />
            <Stat label="Failed" value={formatTokens(session.requests.failed)} />
            <Stat label="Rate limited" value={formatTokens(session.requests.rateLimited)} />
            <Stat label="Cached" value={formatTokens(session.requests.cached)} detail="Read from the prompt cache" />
          </dl>
        </section>
        <section className="gw-card" aria-label="Live activity">
          <header><h3>Live activity</h3></header>
          {session.live ? (
            <dl className="space-gateway-stats gw-compact-stats">
              <Stat label="Active requests" value={String(session.live.activeRequests)} />
              <Stat label="Active WebSockets" value={String(session.live.activeWebSockets)} />
              <Stat label="Relay tasks" value={String(session.live.relayTasks)} />
              <Stat label="Compression queue" value={String(session.live.compressionQueue)} />
            </dl>
          ) : <p className="space-gateway-empty">The gateway did not report its live state.</p>}
        </section>
      </div>
      <section className="gw-card" aria-label="Tokens saved">
        <header><h3>Tokens saved</h3></header>
        <dl className="space-gateway-stats gw-compact-stats">
          <Stat label="Saved" value={formatTokens(session.tokens.saved)} detail={`${formatPercent(session.tokens.savingsPercent)} of all input · ${formatPercent(session.tokens.activeSavingsPercent)} of compressed tool output`} />
          <Stat label="Before" value={formatTokens(session.tokens.input + session.tokens.saved)} />
          <Stat label="Removed" value={formatTokens(session.tokens.saved)} />
          <Stat label="After" value={formatTokens(session.tokens.input)} />
          <Stat label="Output" value={formatTokens(session.tokens.output)} />
        </dl>
        <TrendChart label="Tokens saved per hour" timeFormat={timeFormat} legendValue="sum" formatValue={(value) => formatTokens(Math.round(value))}
          series={[{ id: "saved", label: "Saved", points: session.savingsOverTime.map((row) => ({ t: row.t, value: row.saved })) }]} />
      </section>
      <section className="gw-card" aria-label="Performance">
        <header><h3>Performance</h3></header>
        <dl className="space-gateway-stats gw-compact-stats">
          <Stat label="Compression overhead" value={formatMs(session.performance.overhead.averageMs)} detail={`max ${formatMs(session.performance.overhead.maxMs)} · ${session.performance.overhead.samples} requests`} />
          <Stat label="Time to first byte" value={formatMs(session.performance.ttfb.averageMs)} detail={`p50 ${formatMs(session.performance.ttfb.p50Ms)} · p95 ${formatMs(session.performance.ttfb.p95Ms)} · max ${formatMs(session.performance.ttfb.maxMs)}`} />
          <Stat label="Forward throughput" value={tps(session.performance.throughput.forwardP50)} detail={`p95 ${tps(session.performance.throughput.forwardP95)} · input per request second`} />
          <Stat label="Output throughput" value={tps(session.performance.throughput.generationP50)} detail={`p95 ${tps(session.performance.throughput.generationP95)} · after the first token`} />
        </dl>
        <h4>Pipeline breakdown</h4>
        {session.performance.stages.length === 0 ? <p className="space-gateway-empty">No compression ran in this session.</p> : (
          <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Pipeline breakdown">
            <thead><tr><th>Stage</th><th>Runs</th><th>Average</th><th>Max</th></tr></thead>
            <tbody>{session.performance.stages.map((stage) => (
              <tr key={stage.name}><td>{stageLabels[stage.name] ?? stage.name}</td><td>{formatTokens(stage.runs)}</td><td>{formatMs(stage.averageMs)}</td><td>{formatMs(stage.maxMs)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="gw-card" aria-label="What was removed">
        <header><h3>What was removed</h3><span className="space-gateway-note">Waste found in tool output (tokens)</span></header>
        <MagnitudeBars label="Waste signals" format={formatTokens} rows={session.waste.map((row) => ({ key: row.name, label: wasteLabels[row.name] ?? row.name, value: row.tokens }))} />
      </section>
      <section className="gw-card" aria-label="Prefix cache impact">
        <header><h3>Prefix cache impact</h3></header>
        <dl className="space-gateway-stats gw-compact-stats">
          <Stat label="Cache writes" value={formatTokens(cache.writeTokens)} detail={`${formatCostPrecise(cache.writePremiumUsd)} write premium`} />
          <Stat label="Hit rate" value={formatPercent(cache.hitRatePercent)} detail={`${formatTokens(cache.hitRequests)} of ${formatTokens(session.requests.completed)} requests read the cache`} />
          <Stat label="Cache busts" value={formatTokens(cache.busts)} detail={`${formatTokens(cache.bustTokens)} tokens written again`} />
          <Stat label="Cache savings" value={formatCostPrecise(cache.netUsd)} detail={`${formatCostPrecise(cache.savedUsd)} saved by reads`} />
        </dl>
        {cacheTotal > 0 ? (
          <div className="gw-split-bar" role="img" aria-label={`Cache reads ${formatPercent((cache.readTokens / cacheTotal) * 100)}, writes ${formatPercent((cache.writeTokens / cacheTotal) * 100)}`}>
            <span className="is-read" style={{ width: `${(cache.readTokens / cacheTotal) * 100}%` }}>Reads {formatPercent((cache.readTokens / cacheTotal) * 100)}</span>
            <span className="is-write" style={{ width: `${(cache.writeTokens / cacheTotal) * 100}%` }}>Writes {formatPercent((cache.writeTokens / cacheTotal) * 100)}</span>
          </div>
        ) : null}
        <h4>Compression and the cache</h4>
        <dl className="gw-facts">
          <dt>Saved by compression</dt><dd>{formatTokens(session.compressionVsCache.savedTokens)} tokens</dd>
          <dt>Lost to cache busts</dt><dd>{formatTokens(session.compressionVsCache.lostToBustTokens)} tokens</dd>
          <dt>Net</dt><dd>{formatTokens(session.compressionVsCache.netTokens)} tokens</dd>
          <dt>Prefix freeze</dt><dd>Not needed: only the newest part of a request is compressed, so the cached prefix never changes.</dd>
          <dt>Misses</dt><dd>{cache.misses.ttlExpiry} after the cache expired · {cache.misses.accountSwitch} after an account switch · {cache.misses.prefixChange} after a prefix change</dd>
        </dl>
        {cache.byProvider.length > 0 ? (
          <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Prefix cache by provider">
            <thead><tr><th>Provider</th><th>Requests</th><th>Reads</th><th>Read discount</th><th>Writes</th><th>Write premium</th><th>Busts</th><th>Net</th></tr></thead>
            <tbody>{cache.byProvider.map((row) => (
              <tr key={row.provider}><td>{providerLabel(row.provider)}</td><td>{formatTokens(row.requests)}</td><td>{formatTokens(row.readTokens)}</td>
                <td>{formatPercent(row.readDiscountPercent)}</td><td>{formatTokens(row.writeTokens)}</td><td>{row.writePremiumPercent > 0 ? formatPercent(row.writePremiumPercent) : "None"}</td>
                <td>{row.busts}</td><td>{formatCostPrecise(row.netUsd)}</td></tr>
            ))}</tbody>
          </table></div>
        ) : null}
      </section>
      <section className="gw-card" aria-label="Agent usage">
        <header><h3>Agent usage</h3><span className="space-gateway-note">By client program</span></header>
        <ClientTable rows={session.agents} label="Agent usage" />
      </section>
      <div className="gw-two">
        <section className="gw-card" aria-label="Providers">
          <header><h3>Providers</h3></header>
          <MagnitudeBars label="Requests by provider" format={(value) => formatTokens(value)} rows={session.providers.map((row) => ({ key: row.provider, label: providerLabel(row.provider), value: row.requests }))} />
        </section>
        <section className="gw-card" aria-label="Savings by model">
          <header><h3>Savings by model</h3></header>
          {session.models.length === 0 ? <p className="space-gateway-empty">No requests yet.</p> : (
            <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Savings by model">
              <thead><tr><th>Model</th><th>Requests</th><th>Saved</th><th>Sent</th><th>Reduction</th></tr></thead>
              <tbody>{session.models.slice(0, 12).map((row) => (
                <tr key={row.model}><td>{row.model}</td><td>{formatTokens(row.requests)}</td><td>{formatTokens(row.savedTokens)}</td><td>{formatTokens(row.sentTokens)}</td><td>{formatPercent(row.reductionPercent)}</td></tr>
              ))}</tbody>
            </table></div>
          )}
        </section>
      </div>
      <section className="gw-card" aria-label="Recent requests">
        <header><h3>Recent requests</h3><span className="space-gateway-note">The last 25; select one for detail</span></header>
        {session.recent.length === 0 ? <p className="space-gateway-empty">No requests yet.</p> : (
          <div className="space-gateway-table-wrap"><table className="space-gateway-table gw-log-table" aria-label="Recent compression requests">
            <thead><tr><th>Time</th><th>Model</th><th>Client</th><th>Before → after</th><th>Saved</th><th>Latency</th></tr></thead>
            <tbody>{session.recent.map((row) => (
              <Fragment key={row.id}>
                <tr tabIndex={0} aria-expanded={open === row.id} onClick={() => setOpen(open === row.id ? null : row.id)}
                  onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setOpen(open === row.id ? null : row.id); } }}>
                  <td>{formatDateTime(row.requestedAt, timeFormat, { seconds: true })}</td><td>{row.model}</td><td>{row.clientName ?? "Unknown"}</td>
                  <td>{row.compressionTokensBefore === null ? "Not run" : `${formatTokens(row.compressionTokensBefore)} → ${formatTokens(row.compressionTokensAfter ?? 0)}`}</td>
                  <td>{row.compressionTokensSaved === null ? "—" : formatTokens(row.compressionTokensSaved)}</td><td>{formatMs(row.latencyMs)}</td>
                </tr>
                {open === row.id ? (
                  <tr className="gw-expanded"><td colSpan={6}>
                    <dl className="gw-facts">
                      <dt>Compressors</dt><dd>{row.compressionDetail?.strategies.length ? row.compressionDetail.strategies.map((name) => strategyLabels[name] ?? name).join(", ") : "None changed it"}</dd>
                      <dt>Waste found</dt><dd>{row.compressionDetail && Object.keys(row.compressionDetail.waste).length
                        ? Object.entries(row.compressionDetail.waste).map(([name, tokens]) => `${wasteLabels[name] ?? name} ${formatTokens(tokens)}`).join(" · ") : "None"}</dd>
                      <dt>Output policy</dt><dd>{row.compressionDetail?.outputPolicy ? outputPolicyLabel(row.compressionDetail.outputPolicy) : "None"}</dd>
                      <dt>Input · cached · output</dt><dd>{formatTokens(row.inputTokens ?? 0)} · {formatTokens(row.cachedInputTokens ?? 0)} · {formatTokens(row.outputTokens ?? 0)}</dd>
                      <dt>Status</dt><dd>{row.errorCode ?? row.status}</dd>
                    </dl>
                  </td></tr>
                ) : null}
              </Fragment>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <section className="gw-card" aria-label="Codex rate limits">
        <header><h3>Codex rate-limit windows</h3>
          {session.poolWeekly ? <span className="space-gateway-note">Pool weekly remaining {session.poolWeekly.remainingPercent === null ? "—" : formatPercent(session.poolWeekly.remainingPercent)} · {session.poolWeekly.remainingCredits} of {session.poolWeekly.capacityCredits} Plus-equivalents · {formatCountdown(session.poolWeekly.resetAt)}</span> : null}</header>
        {session.rateLimits.length === 0 ? <p className="space-gateway-empty">No ChatGPT (Codex) accounts.</p> : (
          <ul className="gw-rate-limits">
            {session.rateLimits.map((row) => (
              <li key={row.accountId}>
                <span className="gw-list-title"><strong>{row.label}</strong><span className="space-gateway-note">{planLabel(row.planType)}{row.resetCredits ? ` · ${row.resetCredits} reset credit${row.resetCredits === 1 ? "" : "s"}` : ""}</span></span>
                <RemainingBar label="5h" remaining={row.primary.usedPercent === null ? null : 100 - row.primary.usedPercent} resetAt={row.primary.resetAt} />
                <RemainingBar label="Weekly" remaining={row.secondary.usedPercent === null ? null : 100 - row.secondary.usedPercent} resetAt={row.secondary.resetAt} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function LifetimeView({ lifetime }: { lifetime: GatewayHeadroomLifetime }) {
  return (
    <>
      <p className="space-gateway-note">Everything recorded since {lifetime.since ?? "the first request"}. Rollups outlive request-log retention.</p>
      <dl className="space-gateway-stats gw-compact-stats" aria-label="Lifetime requests">
        <Stat label="Requests" value={formatTokens(lifetime.requests.total)} detail={`${formatTokens(lifetime.requests.failed)} failed · ${formatTokens(lifetime.requests.rateLimited)} rate limited`} />
        <Stat label="Cached requests" value={formatTokens(lifetime.requests.cached)} />
        <Stat label="Input tokens" value={formatTokens(lifetime.tokens.input)} detail={`${formatTokens(lifetime.tokens.attemptedInput)} before compression`} />
        <Stat label="Output tokens" value={formatTokens(lifetime.tokens.output)} />
        <Stat label="Tokens saved" value={formatTokens(lifetime.tokens.saved)} detail={lifetime.tokens.savingsPercent === null ? undefined : `${formatPercent(lifetime.tokens.savingsPercent)} of input`} />
      </dl>
      <dl className="space-gateway-stats gw-compact-stats" aria-label="Lifetime cost">
        <Stat label="API cost" value={formatCostPrecise(lifetime.cost.apiCostUsd)} detail="What the same requests cost on the API" />
        <Stat label="Saved by compression" value={formatCostPrecise(lifetime.cost.compressionSavedUsd)} />
        <Stat label="Saved by the prompt cache" value={formatCostPrecise(lifetime.cost.cacheSavedUsd)} detail={lifetime.cost.unpricedRequests ? `${formatTokens(lifetime.cost.unpricedRequests)} requests on unpriced models` : undefined} />
      </dl>
      <div className="gw-two">
        <section className="gw-card" aria-label="Lifetime prefix cache">
          <header><h3>Prefix cache</h3></header>
          <dl className="gw-facts">
            <dt>Hits</dt><dd>{formatTokens(lifetime.prefixCache.cachedRequests)} of {formatTokens(lifetime.prefixCache.requests)} requests{lifetime.prefixCache.hitRatePercent === null ? "" : ` (${formatPercent(lifetime.prefixCache.hitRatePercent)})`}</dd>
            <dt>Read · written</dt><dd>{formatTokens(lifetime.prefixCache.readTokens)} · {formatTokens(lifetime.prefixCache.writeTokens)} tokens</dd>
            <dt>Busts</dt><dd>{formatTokens(lifetime.prefixCache.busts)} ({formatTokens(lifetime.prefixCache.bustTokens)} tokens written again)</dd>
            <dt>Cache lifetime</dt><dd>{lifetime.prefixCache.ttlMinutes} minutes idle</dd>
            <dt>Misses (7 days)</dt><dd>{lifetime.misses.ttlExpiry} expired · {lifetime.misses.accountSwitch} account switch · {lifetime.misses.prefixChange} prefix change</dd>
          </dl>
        </section>
        <section className="gw-card" aria-label="Lifetime waste signals">
          <header><h3>Waste signals</h3></header>
          <MagnitudeBars label="Lifetime waste signals" format={formatTokens} rows={lifetime.waste.map((row) => ({ key: row.name, label: wasteLabels[row.name] ?? row.name, value: row.tokens }))} />
        </section>
      </div>
      <section className="gw-card" aria-label="Lifetime providers">
        <header><h3>Providers</h3></header>
        <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Providers">
          <thead><tr><th>Provider</th><th>Requests</th><th>Input</th><th>Output</th><th>Saved</th></tr></thead>
          <tbody>{lifetime.providers.map((row) => (
            <tr key={row.provider}><td>{providerLabel(row.provider)}</td><td>{formatTokens(row.requests)}</td><td>{formatTokens(row.inputTokens)}</td><td>{formatTokens(row.outputTokens)}</td><td>{formatTokens(row.savedTokens)}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
      <section className="gw-card" aria-label="Lifetime clients"><header><h3>Clients</h3></header><ClientTable rows={lifetime.clients} label="Clients" /></section>
      <section className="gw-card" aria-label="Top models">
        <header><h3>Top models</h3></header>
        <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Top models">
          <thead><tr><th>Model</th><th>Requests</th><th>Input + output</th><th>Saved</th></tr></thead>
          <tbody>{lifetime.models.slice(0, 15).map((row) => (
            <tr key={row.model}><td>{row.model === "other" ? "Other models" : row.model}</td><td>{formatTokens(row.requests)}</td><td>{formatTokens(row.inputTokens + row.outputTokens)}</td><td>{formatTokens(row.savedTokens)}</td></tr>
          ))}</tbody>
        </table></div>
      </section>
      <section className="gw-card" aria-label="Projects">
        <header><h3>Projects</h3><span className="space-gateway-note">From the x-space-project request header</span></header>
        {lifetime.projects.length === 0 ? <p className="space-gateway-empty">No request named a project.</p> : (
          <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Projects">
            <thead><tr><th>Project</th><th>Requests</th><th>Saved</th><th>Saved $</th><th>Input</th><th>API cost</th><th>Last day</th></tr></thead>
            <tbody>{lifetime.projects.map((row) => (
              <tr key={row.project}><td>{row.project}</td><td>{formatTokens(row.requests)}</td><td>{formatTokens(row.savedTokens)} <small>({formatPercent(row.savingsPercent)})</small></td>
                <td>{formatCostPrecise(row.savedUsd)}</td><td>{formatTokens(row.inputTokens)}</td><td>{formatCostPrecise(row.inputCostUsd)}</td><td>{row.lastDay}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
    </>
  );
}

function HistoryView({ history }: { history: GatewayHeadroomHistory }) {
  const [series, setSeries] = useState<GatewayHistorySeries>("daily");
  const [measure, setMeasure] = useState<"tokens" | "cost">("tokens");
  const buckets = history.series[series];
  const point = (key: string) => `${key.length === 7 ? `${key}-01` : key}T00:00:00.000Z`;
  const recent = (list: GatewayHeadroomHistory["series"]["daily"], count: number) => [...list].reverse().slice(0, count);
  return (
    <>
      <dl className="space-gateway-stats gw-compact-stats" aria-label="Savings history">
        <Stat label="Saved by compression" value={formatCostPrecise(history.lifetime.savedUsd)} />
        <Stat label="Tokens saved" value={formatTokens(history.lifetime.savedTokens)} />
        <Stat label="Active days" value={String(history.lifetime.activeDays)} />
        <Stat label="Average saved" value={`${formatTokens(Math.round(history.lifetime.averagePerDay))} / day`}
          detail={`${formatTokens(Math.round(history.lifetime.averagePerWeek))} / week · ${formatTokens(Math.round(history.lifetime.averagePerMonth))} / month`} />
      </dl>
      <section className="gw-card" aria-label="Savings trend">
        <div className="space-gateway-toolbar">
          <div className="filter-tabs" role="tablist" aria-label="Series">
            {(["daily", "weekly", "monthly"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={series === item}
              className={`filter-tab${series === item ? " active" : ""}`} onClick={() => setSeries(item)}>{item === "daily" ? "Daily" : item === "weekly" ? "Weekly" : "Monthly"}</button>)}
          </div>
          <div className="filter-tabs" role="tablist" aria-label="Measure">
            {(["tokens", "cost"] as const).map((item) => <button key={item} type="button" role="tab" aria-selected={measure === item}
              className={`filter-tab${measure === item ? " active" : ""}`} onClick={() => setMeasure(item)}>{item === "tokens" ? "Tokens" : "Cost"}</button>)}
          </div>
          <a className="space-gateway-button" href="/api/admin/gateway/compression/export?format=json" download>Export JSON</a>
          <a className="space-gateway-button" href={`/api/admin/gateway/compression/export?format=csv&series=${series}`} download>Export CSV</a>
        </div>
        <TrendChart dateOnly label={measure === "tokens" ? "Tokens saved over time (cumulative)" : "API cost with and without compression (cumulative)"}
          formatValue={(value) => (measure === "tokens" ? formatTokens(Math.round(value)) : formatCostPrecise(value))}
          series={measure === "tokens"
            ? [{ id: "saved", label: "Tokens saved", points: buckets.map((bucket) => ({ t: point(bucket.key), value: bucket.cumulativeSavedTokens })) }]
            : [{ id: "actual", label: "API cost", points: buckets.map((bucket) => ({ t: point(bucket.key), value: bucket.cumulativeApiCostUsd })) },
              { id: "expected", label: "Without compression", points: buckets.map((bucket) => ({ t: point(bucket.key), value: bucket.cumulativeApiCostUsd + bucket.cumulativeSavedUsd })) }]} />
      </section>
      <div className="gw-three">
        {([["Daily", recent(history.series.daily, 7)], ["Weekly", recent(history.series.weekly, 6)], ["Monthly", recent(history.series.monthly, 6)]] as const).map(([title, rows]) => (
          <section key={title} className="gw-card" aria-label={`${title} savings`}>
            <header><h3>{title}</h3></header>
            {rows.length === 0 ? <p className="space-gateway-empty">Nothing yet.</p> : (
              <table className="space-gateway-table"><thead><tr><th>{title === "Weekly" ? "Week of" : title === "Monthly" ? "Month" : "Day"}</th><th>Saved</th><th>$</th></tr></thead>
                <tbody>{rows.map((row) => <tr key={row.key}><td>{row.key}</td><td>{formatTokens(row.savedTokens)}</td><td>{formatCostPrecise(row.savedUsd)}</td></tr>)}</tbody></table>
            )}
          </section>
        ))}
      </div>
      <section className="gw-card" aria-label="Savings by model">
        <header><h3>By model</h3></header>
        {history.models.length === 0 ? <p className="space-gateway-empty">Nothing yet.</p> : (
          <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="History by model">
            <thead><tr><th>Model</th><th>Tokens saved</th><th>API cost</th><th>Saved</th><th>Without compression</th></tr></thead>
            <tbody>{history.models.slice(0, 20).map((row) => (
              <tr key={row.model}><td>{row.model}</td><td>{formatTokens(row.savedTokens)}</td><td>{formatCostPrecise(row.apiCostUsd)}</td><td>{formatCostPrecise(row.savedUsd)}</td><td>{formatCostPrecise(row.costWithoutUsd)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </section>
      <p className="space-gateway-note">Retention: request logs and daily savings are kept for good.</p>
    </>
  );
}

function StrategiesView({ client }: { client: SpaceGatewayClient }) {
  const [hours, setHours] = useState(24);
  const [stats, setStats] = useState<GatewayCompressionStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setStats(null);
    client.compressionStats(hours).then((result) => { if (!cancelled) { setStats(result); setError(null); } })
      .catch((reason) => { if (!cancelled) setError(errorText(reason, "Could not load compression statistics.")); });
    return () => { cancelled = true; };
  }, [client, hours]);
  // Shadow rows are history from before Shadow was removed; only what was applied is shown.
  const appliedStrategies = stats?.byStrategy.filter((row) => row.mode === "ON") ?? [];
  return (
    <section className="space-gateway-panel" aria-label="Compression statistics">
      <div className="space-gateway-toolbar">
        <div className="filter-tabs" role="tablist" aria-label="Statistics range">
          {[24, 24 * 7, 24 * 28].map((value) => (
            <button key={value} type="button" role="tab" aria-selected={hours === value} className={`filter-tab${hours === value ? " active" : ""}`}
              onClick={() => setHours(value)}>{value === 24 ? "24 hours" : `${value / 24} days`}</button>
          ))}
        </div>
      </div>
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {!stats ? (error ? null : <p className="space-gateway-empty">Loading statistics…</p>) : stats.applied.requests === 0
        ? <p className="space-gateway-empty">No requests were compressed in this period.</p>
        : <>
          <dl className="space-gateway-stats">
            <Stat label="Tokens saved" value={formatTokens(stats.applied.tokensSaved)} detail={`${formatPercent(stats.applied.savingsPercent)} of compressed tool output`} />
            <Stat label="Requests compressed" value={`${formatTokens(stats.applied.modifiedRequests)} / ${formatTokens(stats.applied.requests)}`} />
            <Stat label="Overhead per request" value={`${stats.applied.averageOverheadMs.toFixed(1)} ms`}
              detail={`max ${stats.applied.maxOverheadMs.toFixed(1)} ms · ${stats.applied.timedOut} over budget`} />
          </dl>
          {stats.byProvider.length ? <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Savings by provider">
            <thead><tr><th>Provider</th><th>Requests compressed</th><th>Before</th><th>After</th><th>Tokens saved</th><th>Savings</th></tr></thead>
            <tbody>{stats.byProvider.map((row) => (
              <tr key={row.provider}><td>{providerLabel(row.provider)}</td><td>{formatTokens(row.modifiedRequests)} / {formatTokens(row.requests)}</td>
                <td>{formatTokens(row.originalTokens)}</td><td>{formatTokens(row.compressedTokens)}</td><td>{formatTokens(row.tokensSaved)}</td>
                <td>{formatPercent(row.savingsPercent)}</td></tr>
            ))}</tbody>
          </table></div> : null}
          {appliedStrategies.length ? <div className="space-gateway-table-wrap"><table className="space-gateway-table" aria-label="Savings by strategy">
            <thead><tr><th>Strategy</th><th>Blocks</th><th>Tokens saved</th><th>Savings</th><th>Not smaller</th><th>Errors</th></tr></thead>
            <tbody>{appliedStrategies.map((row) => (
              <tr key={row.strategy}><td>{strategyLabels[row.strategy] ?? row.strategy}</td>
                <td>{formatTokens(row.blocks)}</td><td>{formatTokens(row.tokensSaved)}</td><td>{formatPercent(row.savingsPercent)}</td>
                <td>{row.rejectedBlocks}</td><td>{row.errorBlocks}</td></tr>
            ))}</tbody>
          </table></div> : null}
        </>}
    </section>
  );
}

type ProviderField = keyof GatewayCompressionProviderSettings;

/**
 * Compression by provider: each provider follows the global settings unless it has its own value; the output policy
 * (rules added to the agent's system prompt) exists per provider only. Saving replaces the whole per-provider object.
 */
function ProviderCompressionForm({ settings, client, onSaved }: { settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void }) {
  const [draft, setDraft] = useState<GatewayCompressionProviders>(settings.compressionProviders ?? {});
  const { saving, message, save } = useSettingsSaver(client, onSaved);
  const set = <F extends ProviderField>(provider: GatewayCompressionProviderId, field: F, value: GatewayCompressionProviderSettings[F] | undefined) =>
    setDraft((current) => {
      const entry: GatewayCompressionProviderSettings = { ...(current[provider] ?? {}) };
      if (value === undefined) delete entry[field]; else entry[field] = value;
      const next: GatewayCompressionProviders = { ...current };
      if (Object.keys(entry).length > 0) next[provider] = entry; else delete next[provider];
      return next;
    });
  const choice = <F extends ProviderField>(provider: GatewayCompressionProviderId, field: F) => (value: string) =>
    set(provider, field, (value === "" ? undefined : value) as GatewayCompressionProviderSettings[F]);
  const onOff = (value: GatewayCompressionMode) => (value === "ON" ? "On" : "Off");
  const cell = (provider: GatewayCompressionProviderId, label: string, field: "mode" | "codeText", global: GatewayCompressionMode) => (
    <td key={provider}><select aria-label={`${providerLabel(provider)}: ${label}`} value={draft[provider]?.[field] ?? ""} onChange={(event) => choice(provider, field)(event.target.value)}>
      <option value="">Global ({onOff(global)})</option><option value="OFF">Off</option><option value="ON">On</option>
    </select></td>
  );
  return (
    <form className="gw-card" aria-label="Compression by provider" onSubmit={(event) => { event.preventDefault(); void save({ compressionProviders: draft }); }}>
      <header><h3>By provider</h3><span className="space-gateway-note">A provider follows the settings above unless it has its own value.</span></header>
      <div className="space-gateway-table-wrap"><table className="space-gateway-table gw-provider-settings" aria-label="Compression settings by provider">
        <thead><tr><th>Setting</th>{compressionProviderIds.map((provider) => <th key={provider} scope="col">{providerLabel(provider)}</th>)}</tr></thead>
        <tbody>
          <tr><th scope="row">Context compression</th>{compressionProviderIds.map((provider) => cell(provider, "Context compression", "mode", settings.compressionMode))}</tr>
          <tr><th scope="row">Profile</th>{compressionProviderIds.map((provider) => (
            <td key={provider}><select aria-label={`${providerLabel(provider)}: Profile`} value={draft[provider]?.profile ?? ""} onChange={(event) => choice(provider, "profile")(event.target.value)}>
              <option value="">Global ({settings.compressionProfile === "CACHE" ? "Cache-safe" : "Token"})</option><option value="CACHE">Cache-safe</option><option value="TOKEN">Token</option>
            </select></td>
          ))}</tr>
          <tr><th scope="row">Code and prose</th>{compressionProviderIds.map((provider) => cell(provider, "Code and prose", "codeText", settings.compressionCodeText))}</tr>
          <tr><th scope="row">Time budget (ms)</th>{compressionProviderIds.map((provider) => (
            <td key={provider}><input type="number" min={10} max={5000} aria-label={`${providerLabel(provider)}: Time budget`} placeholder={`Global (${settings.compressionTimeBudgetMs})`}
              value={draft[provider]?.timeBudgetMs ?? ""} onChange={(event) => set(provider, "timeBudgetMs", event.target.value === "" ? undefined : Number(event.target.value))} /></td>
          ))}</tr>
          <tr><th scope="row">Output policy</th>{compressionProviderIds.map((provider) => (
            <td key={provider}><select aria-label={`${providerLabel(provider)}: Output policy`} value={draft[provider]?.outputPolicy ?? "OFF"}
              onChange={(event) => set(provider, "outputPolicy", event.target.value === "OFF" ? undefined : event.target.value as GatewayOutputPolicy)}>
              {outputPolicyOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select></td>
          ))}</tr>
        </tbody>
      </table></div>
      <dl className="gw-facts">
        {outputPolicyOptions.filter((option) => option.value !== "OFF").map((option) => <Fragment key={option.value}><dt>{option.label}</dt><dd>{option.description}</dd></Fragment>)}
      </dl>
      <p className="space-gateway-note">The output policy is added only for Claude Code, Codex CLI and Antigravity. Space&apos;s own jobs, a key set to Off and requests
        with <code>x-space-gateway-output-policy: off</code> keep their prompt as sent.</p>
      <SaveMessage message={message} />
      <button type="submit" className="space-gateway-button primary" disabled={saving}>Save provider settings</button>
    </form>
  );
}

export function GatewayCompressionTab({ settings, client, onSaved }: { settings: GatewaySettings; client: SpaceGatewayClient; onSaved: (settings: GatewaySettings) => void }) {
  const [mode, setMode] = useState<GatewayCompressionMode>(settings.compressionMode);
  const [profile, setProfile] = useState<GatewayCompressionProfile>(settings.compressionProfile);
  const [codeText, setCodeText] = useState<GatewayCompressionMode>(settings.compressionCodeText);
  const [budget, setBudget] = useState(String(settings.compressionTimeBudgetMs));
  const { saving, message, save } = useSettingsSaver(client, onSaved);
  const [view, setView] = useState<View>("session");
  const [session, setSession] = useState<GatewayHeadroomSession | null>(null);
  const [lifetime, setLifetime] = useState<GatewayHeadroomLifetime | null>(null);
  const [history, setHistory] = useState<GatewayHeadroomHistory | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const load = view === "session" ? client.compressionSession().then((value) => { if (!cancelled) setSession(value); })
      : view === "lifetime" ? client.compressionLifetime().then((value) => { if (!cancelled) setLifetime(value); })
        : view === "history" ? client.compressionHistory().then((value) => { if (!cancelled) setHistory(value); }) : Promise.resolve();
    load.catch((reason) => { if (!cancelled) setError(errorText(reason, "Could not load compression statistics.")); });
    return () => { cancelled = true; };
  }, [client, view]);

  const timeFormat = settings.displayTimeFormat;
  return (
    <div className="space-gateway-panel">
      <form className="gw-card" aria-label="Compression settings" onSubmit={(event) => {
        event.preventDefault();
        void save({ compressionMode: mode, compressionProfile: profile, compressionCodeText: codeText, compressionTimeBudgetMs: Number(budget) });
      }}>
        <fieldset className="space-gateway-segmented">
          <legend>Context compression</legend>
          {compressionModeOptions.map((option) => (
            <label key={option.value} className={mode === option.value ? "active" : undefined} title={option.description}>
              <input type="radio" name="compression-mode" value={option.value} checked={mode === option.value} onChange={() => setMode(option.value)} />
              {option.label}
            </label>
          ))}
        </fieldset>
        <p className="space-gateway-note">{compressionModeOptions.find((option) => option.value === mode)?.description}</p>
        <div className="space-gateway-field-row">
          <label className="space-gateway-field">Profile
            <select value={profile} onChange={(event) => setProfile(event.target.value as GatewayCompressionProfile)}>
              <option value="CACHE">Cache-safe</option>
              <option value="TOKEN">Token</option>
            </select>
            <span>{profile === "CACHE" ? "Keeps the provider prompt cache intact; code and prose get lossless folds only."
              : "Compresses more aggressively, code and prose included."}</span>
          </label>
          <label className="space-gateway-field">Code and prose
            <select value={codeText} onChange={(event) => setCodeText(event.target.value as GatewayCompressionMode)}>
              {codeTextOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <span>{codeTextOptions.find((option) => option.value === codeText)?.description}</span>
          </label>
          <label className="space-gateway-field">Time budget per request (ms)
            <input type="number" min={10} max={5000} value={budget} onChange={(event) => setBudget(event.target.value)} />
            <span>When compression takes longer, the original request is sent unchanged.</span>
          </label>
        </div>
        <SaveMessage message={message} />
        <button type="submit" className="space-gateway-button primary" disabled={saving}>Save compression</button>
      </form>
      <ProviderCompressionForm settings={settings} client={client} onSaved={onSaved} />
      <div className="filter-tabs" role="tablist" aria-label="Compression view">
        {views.map((item) => <button key={item.id} type="button" role="tab" aria-selected={view === item.id} className={`filter-tab${view === item.id ? " active" : ""}`}
          onClick={() => setView(item.id)}>{item.label}</button>)}
      </div>
      {error ? <p className="space-gateway-alert" role="alert">{error}</p> : null}
      {view === "session" ? (session ? <SessionView session={session} timeFormat={timeFormat} /> : error ? null : <p className="space-gateway-empty">Loading the session…</p>) : null}
      {view === "lifetime" ? (lifetime ? <LifetimeView lifetime={lifetime} /> : error ? null : <p className="space-gateway-empty">Loading lifetime totals…</p>) : null}
      {view === "history" ? (history ? <HistoryView history={history} /> : error ? null : <p className="space-gateway-empty">Loading history…</p>) : null}
      {view === "strategies" ? <StrategiesView client={client} /> : null}
    </div>
  );
}

