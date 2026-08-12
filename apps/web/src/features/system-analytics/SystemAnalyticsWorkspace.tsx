import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  SystemAnalyticsCliSessionsResponse,
  SystemAnalyticsModelsResponse,
  SystemAnalyticsOverviewResponse,
  SystemAnalyticsProcessesResponse,
  SystemAnalyticsRange,
  SystemAnalyticsResourcesResponse,
  SystemAnalyticsSeries
} from "@space/contracts";
import { api } from "../../api.js";
import {
  Activity,
  Cpu,
  Database,
  MemoryStick,
  RefreshCw,
  Search,
  Terminal,
  X
} from "../ui-theme/app-icons.js";
import "./system-analytics.css";

export type SystemAnalyticsTab = "overview" | "models" | "resources" | "sessions";

const ranges: Array<{ value: SystemAnalyticsRange; label: string }> = [
  { value: "10m", label: "10 min" },
  { value: "1h", label: "1 hour" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }
];

const tabs: Array<{ value: SystemAnalyticsTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "models", label: "Models" },
  { value: "resources", label: "CPU & RAM" },
  { value: "sessions", label: "CLI Sessions" }
];

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let amount = Math.max(value, 0);
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "System analytics could not be loaded.";
}

function StatCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <article className="system-analytics-stat"><span>{label}</span><strong>{value}</strong>{detail ? <small>{detail}</small> : null}</article>;
}

function CoverageBadge({ value }: { value: "NATIVE" | "SESSION_ONLY" | "UNAVAILABLE" }) {
  return <span className={`system-analytics-coverage is-${value.toLocaleLowerCase().replace("_", "-")}`}>{value.replace("_", " ")}</span>;
}

function SeriesChart({ series, formatValue }: { series: SystemAnalyticsSeries[]; formatValue: (value: number) => string }) {
  const nonEmpty = series.filter((entry) => entry.points.length > 0);
  const max = Math.max(...nonEmpty.flatMap((entry) => entry.points.map((point) => point.max)), 1);
  const colors = ["#62c7b4", "#e7a85d", "#6ea9e7", "#d97ca8"];
  if (nonEmpty.length === 0) return <div className="system-analytics-chart-empty">History starts with the first retained sample.</div>;
  return <div className="system-analytics-chart">
    <svg viewBox="0 0 720 220" role="img" aria-label={nonEmpty.map((entry) => entry.label).join(" and ")}>
      {[0, 1, 2, 3, 4].map((line) => <line key={line} x1="0" x2="720" y1={line * 55} y2={line * 55} />)}
      {nonEmpty.map((entry, seriesIndex) => {
        const coordinates = entry.points.map((point, index) => {
          const x = entry.points.length === 1 ? 360 : (index / (entry.points.length - 1)) * 720;
          const y = 212 - (point.avg / max) * 204;
          return { x, y: Math.max(8, Math.min(212, y)) };
        });
        const color = colors[seriesIndex % colors.length];
        const onlyPoint = coordinates.length === 1 ? coordinates[0] : null;
        return <g key={entry.id}>
          <polyline points={coordinates.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} style={{ stroke: color }} />
          {onlyPoint ? <circle cx={onlyPoint.x} cy={onlyPoint.y} r="4" style={{ fill: color }} /> : null}
        </g>;
      })}
    </svg>
    <div className="system-analytics-chart-legend">
      {nonEmpty.map((entry, index) => <span key={entry.id}><i style={{ background: colors[index % colors.length] }} />{entry.label}<strong>{formatValue(entry.points.at(-1)?.avg ?? 0)}</strong></span>)}
    </div>
  </div>;
}

function BackfillNote({ data }: { data: SystemAnalyticsModelsResponse["backfill"] | null }) {
  if (!data) return null;
  return <p className="system-analytics-coverage-note">
    30-day model/session backfill: <strong>{data.status.toLocaleLowerCase()}</strong>
    {data.earliestAt ? ` · coverage from ${formatDate(data.earliestAt)}` : ""}.
    Resource history is retained from the first sampler deployment.
  </p>;
}

export function SystemAnalyticsWorkspace({
  shellMode,
  initialTab,
  onClose
}: {
  shellMode: "desktop" | "tablet" | "mobile";
  initialTab: SystemAnalyticsTab;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SystemAnalyticsTab>(initialTab);
  const [range, setRange] = useState<SystemAnalyticsRange>("10m");
  const [overview, setOverview] = useState<SystemAnalyticsOverviewResponse | null>(null);
  const [models, setModels] = useState<SystemAnalyticsModelsResponse | null>(null);
  const [resources, setResources] = useState<SystemAnalyticsResourcesResponse | null>(null);
  const [sessions, setSessions] = useState<SystemAnalyticsCliSessionsResponse | null>(null);
  const [processes, setProcesses] = useState<SystemAnalyticsProcessesResponse | null>(null);
  const [processQuery, setProcessQuery] = useState("");
  const [processSort, setProcessSort] = useState<"rss" | "cpu" | "pid" | "uptime" | "name">("rss");
  const [processPage, setProcessPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => setTab(initialTab), [initialTab]);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    const request = tab === "overview"
      ? Promise.all([api.systemAnalyticsOverview(range), api.systemAnalyticsResources(range)])
          .then(([overviewPayload, resourcesPayload]) => {
            if (!active) return;
            setOverview(overviewPayload);
            setResources(resourcesPayload);
          })
      : tab === "models"
        ? api.systemAnalyticsModels(range).then((payload) => { if (active) setModels(payload); })
        : tab === "resources"
          ? Promise.all([
              api.systemAnalyticsResources(range),
              api.systemAnalyticsProcesses({
                page: processPage,
                pageSize: 100,
                sort: processSort,
                direction: "desc",
                query: processQuery || undefined
              })
            ]).then(([resourcePayload, processPayload]) => {
              if (!active) return;
              setResources(resourcePayload);
              setProcesses(processPayload);
            })
          : api.systemAnalyticsCliSessions(range).then((payload) => { if (active) setSessions(payload); });
    void request.catch((caught: unknown) => {
      if (active) setError(errorMessage(caught));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [processPage, processQuery, processSort, range, refreshToken, tab]);

  useEffect(() => {
    const refreshVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    const timer = window.setInterval(refreshVisible, 10_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);

  const cpuSeries = useMemo(() => resources?.series.filter((entry) => entry.id === "host-cpu") ?? [], [resources]);
  const ramSeries = useMemo(
    () => resources?.series.filter((entry) => entry.id === "host-memory-used" || entry.id === "host-memory-available") ?? [],
    [resources]
  );

  return <section className="system-analytics-workspace" aria-label="System analytics workspace" data-shell-mode={shellMode}>
    <header className="system-analytics-header">
      <div className="system-analytics-heading">
        <span><Activity aria-hidden="true" /> Live system telemetry</span>
        <div><h2>System analytics</h2><p>Global public-host view · room and pane identity preserved</p></div>
      </div>
      <div className="system-analytics-header-actions">
        <button type="button" onClick={refresh} title="Refresh analytics"><RefreshCw aria-hidden="true" /> Refresh</button>
        <button type="button" className="icon-button" aria-label="Close system analytics" title="Close system analytics" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
    </header>

    <div className="system-analytics-controls">
      <div className="system-analytics-tabs" role="tablist" aria-label="Analytics sections">
        {tabs.map((item) => <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} onClick={() => setTab(item.value)}>{item.label}</button>)}
      </div>
      <div className="system-analytics-ranges" role="group" aria-label="Analytics range">
        {ranges.map((item) => <button key={item.value} type="button" aria-pressed={range === item.value} onClick={() => { setRange(item.value); setProcessPage(1); }}>{item.label}</button>)}
      </div>
    </div>

    {error ? <div className="system-analytics-error" role="alert"><span>{error}</span><button type="button" onClick={refresh}>Retry</button></div> : null}
    {loading ? <div className="system-analytics-loading" role="status">Refreshing {tabs.find((item) => item.value === tab)?.label.toLocaleLowerCase()}…</div> : null}

    <div className="system-analytics-body">
      {tab === "overview" && overview && resources ? <>
        <div className="system-analytics-stats">
          <StatCard label="CPU" value={`${Math.round(overview.cpuUsagePercent)}%`} detail={`${resources.current.coreCount} cores`} />
          <StatCard label="RAM" value={`${Math.round(overview.memoryUsagePercent)}%`} detail={`${formatBytes(resources.current.memoryUsedBytes)} / ${formatBytes(resources.current.memoryTotalBytes)}`} />
          <StatCard label="Swap" value={`${Math.round(overview.swapUsagePercent)}%`} detail={formatBytes(resources.current.swapUsedBytes)} />
          <StatCard label="CLI sessions" value={String(overview.runningCliSessions)} detail="running globally" />
          <StatCard label="Models" value={String(overview.modelCount)} detail={`${overview.providerCount} providers`} />
        </div>
        <div className="system-analytics-overview-grid">
          <article className="system-analytics-panel"><header><Cpu aria-hidden="true" /><div><strong>CPU change</strong><small>min / average / max retained samples</small></div></header><SeriesChart series={cpuSeries} formatValue={(value) => `${Math.round(value)}%`} /></article>
          <article className="system-analytics-panel"><header><MemoryStick aria-hidden="true" /><div><strong>RAM change</strong><small>used and available memory</small></div></header><SeriesChart series={ramSeries} formatValue={formatBytes} /></article>
        </div>
        <article className="system-analytics-panel system-analytics-table-panel">
          <header><Database aria-hidden="true" /><div><strong>Highest resource entities</strong><small>actual CLI panes and shared runtimes</small></div></header>
          <div className="system-analytics-table-scroll"><table><thead><tr><th>Room / pane</th><th>Runtime</th><th>CPU now</th><th>CPU avg / max</th><th>RAM now</th><th>RAM avg / max</th><th>Processes</th></tr></thead><tbody>
            {overview.topEntities.map((entity) => <tr key={`${entity.entityType}:${entity.entityId}`}><td><strong>{entity.paneTitle ?? entity.runtimeName ?? entity.entityId}</strong><small>{entity.roomName ?? (entity.entityType === "SHARED_RUNTIME" ? "Shared service" : "Unknown room")}</small></td><td>{entity.runtimeName ?? entity.runtimeId ?? "—"}</td><td>{entity.cpuOneCorePercent.toFixed(1)}%</td><td>{entity.avgCpuOneCorePercent.toFixed(1)}% / {entity.maxCpuOneCorePercent.toFixed(1)}%</td><td>{formatBytes(entity.rssBytes)}</td><td>{formatBytes(entity.avgRssBytes)} / {formatBytes(entity.maxRssBytes)}</td><td>{entity.processCount}</td></tr>)}
          </tbody></table></div>
        </article>
        <BackfillNote data={overview.backfill} />
      </> : null}

      {tab === "models" && models ? <>
        <div className="system-analytics-provider-grid">
          {models.providers.map((provider) => <article key={provider.providerId} className="system-analytics-provider-card"><span>{provider.providerId}</span><strong>{provider.activeSessions} active</strong><small>{provider.modelCount} models · {provider.completedTurns} completed turns</small><small>{formatNumber(provider.tokensIn)} in / {formatNumber(provider.tokensOut)} out</small></article>)}
        </div>
        <article className="system-analytics-panel system-analytics-table-panel"><header><Database aria-hidden="true" /><div><strong>Provider and model detail</strong><small>native metrics where the CLI exposes them</small></div></header><div className="system-analytics-table-scroll"><table><thead><tr><th>Provider / model</th><th>Coverage</th><th>Sessions / active</th><th>Completed / aborted</th><th>Tokens in / out / reasoning</th><th>TTFT</th><th>Duration</th><th>Tok/s</th><th>Last activity</th></tr></thead><tbody>
          {models.models.map((model) => <tr key={`${model.providerId}:${model.modelId}`}><td><strong>{model.modelId}</strong><small>{model.providerId} · {model.runtimeIds.join(", ") || "runtime unknown"}</small></td><td><CoverageBadge value={model.coverage} /></td><td>{model.activeSessions} / {model.activeTurns}</td><td>{model.completedTurns} / {model.abortedTurns}</td><td>{formatNumber(model.tokensIn)} / {formatNumber(model.tokensOut)} / {formatNumber(model.tokensReasoning)}</td><td>{model.avgTtftMs === null ? "—" : `${Math.round(model.avgTtftMs)} ms`}</td><td>{model.avgDurationMs === null ? "—" : formatDuration(Math.round(model.avgDurationMs / 1000))}</td><td>{model.avgTokPerSec === null ? "—" : model.avgTokPerSec.toFixed(1)}</td><td>{formatDate(model.lastActivityAt)}</td></tr>)}
        </tbody></table></div></article>
        <BackfillNote data={models.backfill} />
      </> : null}

      {tab === "resources" && resources ? <>
        <div className="system-analytics-stats">
          <StatCard label="CPU" value={`${resources.current.cpuUsagePercent.toFixed(1)}%`} detail={`${resources.current.coreCount} cores`} />
          <StatCard label="RAM used" value={formatBytes(resources.current.memoryUsedBytes)} detail={`${resources.current.memoryUsagePercent.toFixed(1)}%`} />
          <StatCard label="RAM available" value={formatBytes(resources.current.memoryAvailableBytes)} detail={resources.current.pressure ? "pressure detected" : "no pressure"} />
          <StatCard label="Page cache" value={formatBytes(resources.current.pageCacheBytes)} />
          <StatCard label="Swap" value={formatBytes(resources.current.swapUsedBytes)} detail={`${resources.current.swapUsagePercent.toFixed(1)}%`} />
        </div>
        <div className="system-analytics-overview-grid"><article className="system-analytics-panel"><header><Cpu aria-hidden="true" /><div><strong>CPU change</strong><small>host utilization across the selected range</small></div></header><SeriesChart series={cpuSeries} formatValue={(value) => `${Math.round(value)}%`} /></article><article className="system-analytics-panel"><header><MemoryStick aria-hidden="true" /><div><strong>RAM change</strong><small>used and available memory across the selected range</small></div></header><SeriesChart series={ramSeries} formatValue={formatBytes} /></article></div>
        <article className="system-analytics-panel system-analytics-table-panel"><header><Terminal aria-hidden="true" /><div><strong>CLI panes and shared runtimes</strong><small>complete descendant process groups, never double-counted</small></div></header><div className="system-analytics-table-scroll"><table><thead><tr><th>Room / pane</th><th>Runtime / model</th><th>CPU host / one-core</th><th>CPU avg / max</th><th>RAM now</th><th>RAM avg / max</th><th>Processes</th></tr></thead><tbody>
          {resources.entities.map((entity) => <tr key={`${entity.entityType}:${entity.entityId}`}><td><strong>{entity.paneTitle ?? entity.runtimeName ?? entity.entityId}</strong><small>{entity.roomName ?? (entity.entityType === "SHARED_RUNTIME" ? "Shared service" : "Unknown room")}</small></td><td><strong>{entity.runtimeName ?? entity.runtimeId ?? "—"}</strong><small>{entity.providerId ?? "—"} · {entity.modelId ?? "model unavailable"}</small></td><td>{entity.cpuHostPercent.toFixed(1)}% / {entity.cpuOneCorePercent.toFixed(1)}%</td><td>{entity.avgCpuOneCorePercent.toFixed(1)}% / {entity.maxCpuOneCorePercent.toFixed(1)}%</td><td>{formatBytes(entity.rssBytes)}</td><td>{formatBytes(entity.avgRssBytes)} / {formatBytes(entity.maxRssBytes)}</td><td>{entity.processCount}</td></tr>)}
        </tbody></table></div></article>
        <article className="system-analytics-panel system-analytics-table-panel"><header className="system-analytics-process-header"><div><Database aria-hidden="true" /><div><strong>All live OS processes</strong><small>command lines are intentionally never exposed</small></div></div><label><Search aria-hidden="true" /><input type="search" value={processQuery} placeholder="Process, room, pane, runtime…" onChange={(event) => { setProcessPage(1); setProcessQuery(event.currentTarget.value); }} /></label><select aria-label="Sort processes" value={processSort} onChange={(event) => { setProcessPage(1); setProcessSort(event.currentTarget.value as typeof processSort); }}><option value="rss">RAM</option><option value="cpu">CPU</option><option value="pid">PID</option><option value="uptime">Uptime</option><option value="name">Name</option></select></header>{processes ? <><div className="system-analytics-table-scroll"><table><thead><tr><th>PID / process</th><th>Owner</th><th>CPU host / one-core</th><th>RSS / virtual / swap</th><th>Threads</th><th>Uptime</th><th>State</th></tr></thead><tbody>
          {processes.data.map((process) => <tr key={process.pid}><td><strong>{process.name}</strong><small>PID {process.pid} · PPID {process.parentPid}</small></td><td><strong>{process.paneTitle ?? process.runtimeId ?? process.ownership.replace("_", " ")}</strong><small>{process.roomName ?? process.sessionId ?? "System process"}</small></td><td>{process.cpuHostPercent.toFixed(1)}% / {process.cpuOneCorePercent.toFixed(1)}%</td><td>{formatBytes(process.rssBytes)} / {formatBytes(process.virtualBytes)} / {formatBytes(process.swapBytes)}</td><td>{process.threadCount}</td><td>{formatDuration(process.uptimeSeconds)}</td><td>{process.state}</td></tr>)}
          {!processes.data.length ? <tr><td colSpan={7}>No processes match the current filter.</td></tr> : null}
        </tbody></table></div><footer className="system-analytics-pagination"><span>{processes.pagination.totalItems} processes · page {processes.pagination.page} of {Math.max(processes.pagination.totalPages, 1)}</span><div><button type="button" disabled={processPage <= 1} onClick={() => setProcessPage((value) => Math.max(value - 1, 1))}>Previous</button><button type="button" disabled={processes.pagination.totalPages === 0 || processPage >= processes.pagination.totalPages} onClick={() => setProcessPage((value) => value + 1)}>Next</button></div></footer></> : null}</article>
      </> : null}

      {tab === "sessions" && sessions ? <>
        <div className="system-analytics-stats"><StatCard label="Running" value={String(sessions.summary.running)} /><StatCard label="Attached" value={String(sessions.summary.attached)} /><StatCard label="Detached" value={String(sessions.summary.detached)} /><StatCard label="Cleanup eligible" value={String(sessions.summary.cleanupEligible)} /></div>
        <article className="system-analytics-panel system-analytics-table-panel"><header><Terminal aria-hidden="true" /><div><strong>Space CLI sessions</strong><small>room, pane, runtime, provider, model and retained CPU/RAM detail</small></div></header><div className="system-analytics-table-scroll"><table><thead><tr><th>Room / pane</th><th>Runtime</th><th>Provider / model</th><th>Status</th><th>PID / processes</th><th>CPU now · avg / max</th><th>RAM now · avg / max</th><th>Duration</th></tr></thead><tbody>
          {sessions.sessions.map((session) => <tr key={session.sessionId}><td><strong>{session.paneTitle}</strong><small>{session.roomName}</small></td><td><strong>{session.runtimeName}</strong><small>{session.runtimeId} · {session.reasoningEffort}</small></td><td><strong>{session.modelId ?? "model unavailable"}</strong><small>{session.providerId}</small></td><td><span className={`system-analytics-status is-${session.status.toLocaleLowerCase()}`}>{session.status}</span><small>{session.attachmentCount} attachments{session.cleanupEligible ? " · cleanup eligible" : ""}</small></td><td>{session.pid ?? "—"} / {session.processCount}</td><td>{session.cpuOneCorePercent.toFixed(1)}% · {session.avgCpuOneCorePercent.toFixed(1)}% / {session.maxCpuOneCorePercent.toFixed(1)}%</td><td>{formatBytes(session.rssBytes)} · {formatBytes(session.avgRssBytes)} / {formatBytes(session.maxRssBytes)}</td><td>{formatDuration(session.durationSeconds)}<small>{formatDate(session.startedAt)}</small></td></tr>)}
        </tbody></table></div></article>
        <BackfillNote data={sessions.backfill} />
      </> : null}
    </div>
  </section>;
}
