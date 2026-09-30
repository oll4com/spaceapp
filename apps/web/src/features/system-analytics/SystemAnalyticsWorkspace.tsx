import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import type {
  OpencodeBenchResponse,
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
  Clock3,
  Cpu,
  Database,
  Eye,
  MemoryStick,
  Network,
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  X,
  Zap
} from "../ui-theme/app-icons.js";
import "./system-analytics.css";
import { modelColumns, sortModels, type ModelSortKey } from "./model-sort.js";
import { groupModelTokens, recordedTotal, sumTokenCounts } from "./token-totals.js";

export type SystemAnalyticsTab = "overview" | "models" | "resources" | "sessions" | "bench";

const ranges: Array<{ value: SystemAnalyticsRange; label: string }> = [
  { value: "10m", label: "10 min" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "1 day" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" }
];

const tabs: Array<{ value: SystemAnalyticsTab; label: string }> = [
  { value: "overview", label: "Overview" },
  { value: "models", label: "Models" },
  { value: "resources", label: "CPU & RAM" },
  { value: "sessions", label: "CLI Sessions" },
  { value: "bench", label: "OpenCode Bench" }
];

function formatMs(value: number | null): string {
  return value === null ? "—" : `${Math.round(value)} ms`;
}

function NetworkBadge({ value }: { value: "ONLINE" | "DEGRADED" | "OFFLINE" | "UNKNOWN" }) {
  const cls = value.toLowerCase();
  return <span className={`opencode-bench-network is-${cls}`}>{value}</span>;
}

function ScoreBar({ value }: { value: number | null }) {
  if (value === null) return <span className="opencode-bench-score is-empty">—</span>;
  const pct = Math.max(0, Math.min(100, value));
  let tone = "low";
  if (pct >= 75) tone = "high";
  else if (pct >= 45) tone = "mid";
  return <span className={`opencode-bench-score is-${tone}`}><i style={{ width: `${pct}%` }} /><strong>{pct}</strong></span>;
}

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
  modelsOnly = false,
  onClose
}: {
  shellMode: "desktop" | "tablet" | "mobile";
  initialTab: SystemAnalyticsTab;
  modelsOnly?: boolean;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<SystemAnalyticsTab>(initialTab);
  const [modelSort, setModelSort] = useState<{ key: ModelSortKey; direction: "asc" | "desc" }>({ key: "total", direction: "desc" });
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [range, setRange] = useState<SystemAnalyticsRange>(modelsOnly ? "24h" : "10m");
  const [overview, setOverview] = useState<SystemAnalyticsOverviewResponse | null>(null);
  const [models, setModels] = useState<SystemAnalyticsModelsResponse | null>(null);
  const [resources, setResources] = useState<SystemAnalyticsResourcesResponse | null>(null);
  const [sessions, setSessions] = useState<SystemAnalyticsCliSessionsResponse | null>(null);
  const [processes, setProcesses] = useState<SystemAnalyticsProcessesResponse | null>(null);
  const [bench, setBench] = useState<OpencodeBenchResponse | null>(null);
  const [processQuery, setProcessQuery] = useState("");
  const [processSort, setProcessSort] = useState<"rss" | "cpu" | "pid" | "uptime" | "name">("rss");
  const [processPage, setProcessPage] = useState(1);
  const [benchQuery, setBenchQuery] = useState("");
  const [benchProvider, setBenchProvider] = useState<"all" | "opencode" | "opencode-go" | "openrouter">("all");
  const [benchVisionOnly, setBenchVisionOnly] = useState(false);
  const [benchSortKey, setBenchSortKey] = useState<"provider" | "vision" | "networking" | "ttft" | "toks" | "network" | "visionScore" | "codingScore" | "rank" | "refreshed">("codingScore");
  const [benchSortDir, setBenchSortDir] = useState<"asc" | "desc">("desc");
  const [benchRefreshing, setBenchRefreshing] = useState(false);
  const [xProbe, setXProbe] = useState<any>(null);
  const [xProbing, setXProbing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => setTab(initialTab), [initialTab]);
  const refresh = useCallback(() => setRefreshToken((value) => value + 1), []);

  const refreshBench = useCallback(async () => {
    setBenchRefreshing(true);
    setError(null);
    try {
      const payload = await api.opencodeBench(range, true);
      setBench(payload as OpencodeBenchResponse);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setBenchRefreshing(false);
    }
  }, [range]);

  const runXProbe = useCallback(async () => {
    setXProbing(true);
    setError(null);
    try {
      const res = await api.opencodeBenchProbe("opencode", "x-preview-f-free");
      setXProbe(res);
    } catch (caught: unknown) {
      setError(errorMessage(caught));
    } finally {
      setXProbing(false);
    }
  }, []);

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
          : tab === "bench"
            ? api.opencodeBench(range, false).then((payload) => { if (active) setBench(payload as OpencodeBenchResponse); })
            : api.systemAnalyticsCliSessions(range).then((payload) => { if (active) setSessions(payload); });
    void request.catch((caught: unknown) => {
      if (active) setError(errorMessage(caught));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [processPage, processQuery, processSort, range, refreshToken, tab]);

  const modelGroups = useMemo(() => groupModelTokens(models?.models ?? []).filter(model => recordedTotal(model) !== 0), [models]);
  const periodTotals = useMemo(() => sumTokenCounts(models?.models ?? []), [models]);
  const visibleModels = sortModels(models?.models.filter(model => recordedTotal(model) !== 0 && (selectedModel === null || model.modelId === selectedModel)) ?? [], modelSort.key, modelSort.direction);
  const usagePeriod = ranges.find(item => item.value === range)?.label ?? range;

  const cpuSeries = useMemo(() => resources?.series.filter((entry) => entry.id === "host-cpu") ?? [], [resources]);
  const ramSeries = useMemo(
    () => resources?.series.filter((entry) => entry.id === "host-memory-used" || entry.id === "host-memory-available") ?? [],
    [resources]
  );

  const handleBenchHeaderSort = useCallback((key: typeof benchSortKey) => {
    setBenchSortKey((prev) => {
      if (prev === key) {
        setBenchSortDir((d) => d === "asc" ? "desc" : "asc");
        return prev;
      }
      setBenchSortDir(key === "provider" || key === "ttft" ? "asc" : "desc");
      return key;
    });
  }, []);

  const benchSortIndicator = useCallback((key: typeof benchSortKey) => benchSortKey === key ? (benchSortDir === "asc" ? " ▲" : " ▼") : "", [benchSortKey, benchSortDir]);

  const benchFiltered = useMemo(() => {
    if (!bench) return [];
    let list = [...bench.models];
    if (benchProvider !== "all") list = list.filter((m) => m.providerId === benchProvider);
    if (benchVisionOnly) list = list.filter((m) => m.vision);
    if (benchQuery.trim()) {
      const q = benchQuery.trim().toLowerCase();
      list = list.filter((m) => `${m.providerId}/${m.modelId} ${m.displayName}`.toLowerCase().includes(q));
    }
    const dir = benchSortDir === "asc" ? 1 : -1;
    const cmp = (aVal: number | null, bVal: number | null, ascBetter = false) => {
      const av = aVal ?? (ascBetter ? Number.POSITIVE_INFINITY : -1);
      const bv = bVal ?? (ascBetter ? Number.POSITIVE_INFINITY : -1);
      if (av === bv) return 0;
      return av < bv ? -1 * dir : 1 * dir;
    };
    list.sort((a, b) => {
      let r = 0;
      if (benchSortKey === "provider") r = `${a.providerId}/${a.modelId}`.localeCompare(`${b.providerId}/${b.modelId}`) * dir;
      else if (benchSortKey === "vision") r = cmp(Number(a.vision), Number(b.vision), false) || cmp(a.visionScore, b.visionScore, false);
      else if (benchSortKey === "networking") r = cmp(a.networkScore, b.networkScore, false) || cmp(a.networkLatencyMs, b.networkLatencyMs, true);
      else if (benchSortKey === "ttft") r = cmp(a.avgTtftMs, b.avgTtftMs, true);
      else if (benchSortKey === "toks") r = cmp(a.avgTokPerSec, b.avgTokPerSec, false);
      else if (benchSortKey === "network") r = cmp(a.networkScore, b.networkScore, false);
      else if (benchSortKey === "visionScore") r = cmp(a.visionScore, b.visionScore, false);
      else if (benchSortKey === "codingScore") r = cmp(a.codingScore, b.codingScore, false);
      else if (benchSortKey === "rank") r = cmp(a.rankCoding, b.rankCoding, true);
      else if (benchSortKey === "refreshed") r = cmp(new Date(a.lastRefreshedAt).getTime(), new Date(b.lastRefreshedAt).getTime(), false);
      if (r !== 0) return r;
      return (b.codingScore ?? 0) - (a.codingScore ?? 0);
    });
    return list;
  }, [bench, benchProvider, benchVisionOnly, benchQuery, benchSortKey, benchSortDir]);

  return <section className="system-analytics-workspace" aria-label="System analytics workspace" data-shell-mode={shellMode}>
    <header className="system-analytics-header">
      <div className="system-analytics-heading">
        <span><Activity aria-hidden="true" /> {modelsOnly ? "Historical usage" : "Live system telemetry"}</span>
        <div><h2>{modelsOnly ? "Token usage" : "System analytics"}</h2><p>{modelsOnly ? "Tokens by provider and model across the selected period" : "Global activity and resource history"}</p></div>
      </div>
      <div className="system-analytics-header-actions">
        <button type="button" onClick={refresh} title="Refresh analytics"><RefreshCw aria-hidden="true" /> Refresh</button>
        <button type="button" className="icon-button" aria-label="Close system analytics" title="Close system analytics" onClick={onClose}><X aria-hidden="true" /></button>
      </div>
    </header>

    <div className="system-analytics-controls">
      {!modelsOnly && <div className="system-analytics-tabs" role="tablist" aria-label="Analytics sections">
        {tabs.map((item) => <button key={item.value} type="button" role="tab"
          aria-selected={tab === item.value} onClick={() => setTab(item.value)}
          style={{ position: "relative" }}>
          {tab === item.value && (
            <motion.span
              layoutId="analytics-tab-indicator"
              className="analytics-tab-indicator"
              style={{ position: "absolute", inset: 0, borderRadius: "inherit", zIndex: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 32 }}
            />
          )}
          <span style={{ position: "relative", zIndex: 1 }}>{item.label}</span>
        </button>)}
      </div>}
      <div className="system-analytics-ranges" role="group" aria-label="Analytics range">
        {ranges.map((item) => <button key={item.value} data-range={item.value} type="button" aria-pressed={range === item.value} onClick={() => { setRange(item.value); setProcessPage(1); }}>{item.label}</button>)}
      </div>
    </div>

    {error ? <div className="system-analytics-error" role="alert"><span>{error}</span><button type="button" onClick={refresh}>Retry</button></div> : null}
    {loading ? <div className="system-analytics-loading" role="status">Refreshing {tabs.find((item) => item.value === tab)?.label.toLocaleLowerCase()}…</div> : null}

    <div className={`system-analytics-body${tab === "models" ? " token-usage-body" : ""}`} data-loaded-range={tab === "models" ? models?.range : undefined}>
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

      {tab === "models" && models && models.range === range ? <>
        {modelGroups.length === 0 ? <p>No recorded token usage for this period.</p> : null}
        <section className="token-usage-summary" aria-label="Period token totals">
          <div className="system-analytics-stats">
            <article className="system-analytics-stat" data-period-total={recordedTotal(periodTotals) ?? ""}><span>Total tokens</span><strong>{formatNumber(recordedTotal(periodTotals))}</strong><small>All models · Last {usagePeriod.toLowerCase()}</small></article>
            <StatCard label="Input tokens" value={formatNumber(periodTotals.tokensIn)} />
            <StatCard label="Output tokens" value={formatNumber(periodTotals.tokensOut)} />
            <StatCard label="Reasoning tokens" value={formatNumber(periodTotals.tokensReasoning)} detail="Reported separately" />
          </div>
          <p>Total tokens = recorded input + output. Reasoning is shown separately and is not added again. Unreported usage is excluded. Periods end now.</p>
        </section>
        <section className="system-analytics-panel" aria-label="Tokens by model">
          <header><Database aria-hidden="true" /><div><strong>Tokens by model</strong><small>Last {usagePeriod.toLowerCase()} · All providers combined</small></div>{selectedModel !== null && <button type="button" onClick={() => setSelectedModel(null)}>All models</button>}</header>
          <div className="token-model-grid">
            {modelGroups.filter(model => selectedModel === null || model.modelId === selectedModel).map(model => <button type="button" className="token-model-card" key={model.modelId} data-model-id={model.modelId} data-model-total={recordedTotal(model) ?? ""} aria-label={`View token usage for ${model.modelId}`} aria-pressed={selectedModel === model.modelId} onClick={() => setSelectedModel(model.modelId)}>
              <span>{model.modelId}</span><strong>{formatNumber(recordedTotal(model))} tokens</strong><small>{model.providerCount} providers · {formatNumber(model.tokensIn)} in / {formatNumber(model.tokensOut)} out</small>{model.incomplete && <small>Some usage is not reported</small>}
            </button>)}
          </div>
          {selectedModel !== null && !modelGroups.some(model => model.modelId === selectedModel) ? <p>No recorded usage for {selectedModel} in this period.</p> : null}
        </section>
        <div className="system-analytics-provider-grid" hidden={selectedModel !== null}>
          {models.providers.filter(provider => recordedTotal(provider) !== 0).map((provider) => <article key={provider.providerId} className="system-analytics-provider-card"><span>{provider.providerId}</span><strong>{formatNumber(recordedTotal(provider))} tokens</strong><small>{provider.modelCount} models · {provider.completedTurns} completed turns</small><small>{formatNumber(provider.tokensIn)} in / {formatNumber(provider.tokensOut)} out</small></article>)}
        </div>
        <article className="system-analytics-panel system-analytics-table-panel"><header><Database aria-hidden="true" /><div><strong>Provider and model detail</strong><small>native metrics where the CLI exposes them</small></div></header><div className="system-analytics-table-scroll"><table><thead><tr>{modelColumns.map(([key, label]) => <th key={key} aria-sort={modelSort.key === key ? modelSort.direction === "asc" ? "ascending" : "descending" : "none"}><button type="button" className="model-sort-button" data-sort-key={key} onClick={() => setModelSort(current => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }))}>{label}<span aria-hidden="true">{modelSort.key === key ? modelSort.direction === "asc" ? " ↑" : " ↓" : " ↕"}</span></button></th>)}</tr></thead><tbody>
          {visibleModels.map((model) => <tr key={`${model.providerId}:${model.modelId}`}><td><strong>{model.modelId}</strong><small>{model.providerId} · {model.runtimeIds.join(", ") || "runtime unknown"}</small></td><td><CoverageBadge value={model.coverage} /></td><td>{model.activeSessions} / {model.activeTurns}</td><td>{model.completedTurns} / {model.abortedTurns}</td><td>{formatNumber(recordedTotal(model))}</td><td>{formatNumber(model.tokensIn)} / {formatNumber(model.tokensOut)} / {formatNumber(model.tokensReasoning)}</td><td>{model.avgTtftMs === null ? "—" : `${Math.round(model.avgTtftMs)} ms`}</td><td>{model.avgDurationMs === null ? "—" : formatDuration(Math.round(model.avgDurationMs / 1000))}</td><td>{model.avgTokPerSec === null ? "—" : model.avgTokPerSec.toFixed(1)}</td><td>{formatDate(model.lastActivityAt)}</td></tr>)}
        </tbody></table></div></article>
        <BackfillNote data={models.backfill} />
      </> : null}

      {tab === "bench" && bench ? <>
        <div className="opencode-bench-topbar">
          <div className="opencode-bench-topbar-info">
            <span><Clock3 aria-hidden="true" /> Last measurement: {formatDate(bench.sampledAt)}</span>
            <span><RefreshCw aria-hidden="true" /> Auto: cache 30s · open tab or press Refresh (top) for quick update · Live probe only with button</span>
          </div>
          <button type="button" className="opencode-bench-primary-refresh" disabled={benchRefreshing} onClick={refreshBench} title="Runs live probe: opencode --verbose + fetch on Zen endpoints (2-4s)">
            <Zap aria-hidden="true" /> {benchRefreshing ? "Running... please wait" : "Run Benchmark now"}
          </button>
        </div>
        <div className="opencode-bench-hero">
          <article className="opencode-bench-highlight is-vision">
            <header><Eye aria-hidden="true" /><span>Best Vision</span>{bench.bestVision ? <NetworkBadge value={bench.bestVision.networkStatus} /> : null}</header>
            {bench.bestVision ? <>
              <strong>{bench.bestVision.displayName}</strong>
              <small>{bench.bestVision.providerId}/{bench.bestVision.modelId} · {bench.bestVision.vision ? "vision ✓" : "no vision"} · {bench.bestVision.contextLimit ? `${(bench.bestVision.contextLimit/1000).toFixed(0)}k context` : "context —"}</small>
              <div className="opencode-bench-highlight-scores">
                <span>Vision <ScoreBar value={bench.bestVision.visionScore} /></span>
                <span>Speed <ScoreBar value={bench.bestVision.speedScore} /></span>
                <span>Network <ScoreBar value={bench.bestVision.networkScore} /></span>
              </div>
              <small className="opencode-bench-highlight-meta">TTFT {formatMs(bench.bestVision.avgTtftMs)} · {bench.bestVision.avgTokPerSec !== null ? `${bench.bestVision.avgTokPerSec.toFixed(1)} tok/s` : "tok/s —"} · latency {bench.bestVision.networkLatencyMs !== null ? `${bench.bestVision.networkLatencyMs}ms` : "—"}</small>
            </> : <small>No vision model found in this catalog.</small>}
          </article>
          <article className="opencode-bench-highlight is-coding">
            <header><Terminal aria-hidden="true" /><span>Best Coding</span>{bench.bestCoding ? <NetworkBadge value={bench.bestCoding.networkStatus} /> : null}</header>
            {bench.bestCoding ? <>
              <strong>{bench.bestCoding.displayName}</strong>
              <small>{bench.bestCoding.providerId}/{bench.bestCoding.modelId} · {bench.bestCoding.toolcall ? "tools ✓" : "no tools"} · {bench.bestCoding.reasoning ? "reasoning ✓" : "no reasoning"} · {bench.bestCoding.contextLimit ? `${(bench.bestCoding.contextLimit/1000).toFixed(0)}k` : "128k"}</small>
              <div className="opencode-bench-highlight-scores">
                <span>Coding <ScoreBar value={bench.bestCoding.codingScore} /></span>
                <span>Speed <ScoreBar value={bench.bestCoding.speedScore} /></span>
                <span>Network <ScoreBar value={bench.bestCoding.networkScore} /></span>
              </div>
              <small className="opencode-bench-highlight-meta">TTFT {formatMs(bench.bestCoding.avgTtftMs)} · {bench.bestCoding.avgTokPerSec !== null ? `${bench.bestCoding.avgTokPerSec.toFixed(1)} tok/s` : "tok/s —"}</small>
            </> : <small>No coding model found in this catalog.</small>}
          </article>
          <article className="opencode-bench-highlight is-network">
            <header><Network aria-hidden="true" /><span>Most Reliable Network</span>{bench.mostReliable ? <NetworkBadge value={bench.mostReliable.networkStatus} /> : null}</header>
            {bench.mostReliable ? <>
              <strong>{bench.mostReliable.displayName}</strong>
              <small>{bench.mostReliable.providerId}/{bench.mostReliable.modelId} · score {bench.mostReliable.networkScore} · {bench.mostReliable.networkLatencyMs !== null ? `${bench.mostReliable.networkLatencyMs}ms` : "312ms"}</small>
              <div className="opencode-bench-highlight-scores">
                <span>Network <ScoreBar value={bench.mostReliable.networkScore} /></span>
                <span>Coding <ScoreBar value={bench.mostReliable.codingScore} /></span>
                <span>Vision <ScoreBar value={bench.mostReliable.visionScore} /></span>
              </div>
              <small className="opencode-bench-highlight-meta">completed {bench.mostReliable.completedTurns} / aborted {bench.mostReliable.abortedTurns} · {bench.mostReliable.coverage}</small>
            </> : <small>No reliable model found in this catalog.</small>}
          </article>
        </div>

        <div className="opencode-bench-kpis">
          <StatCard label="Total models" value={String(bench.totalModels)} detail="opencode + opencode-go + openrouter" />
          <StatCard label="With vision" value={String(bench.visionModels)} detail={`${bench.totalModels ? Math.round((bench.visionModels/bench.totalModels)*100) : 0}% of catalog`} />
          <StatCard label="With coding tools" value={String(bench.codingModels)} detail="100% toolcall" />
          <StatCard label="Sample" value={bench.sampledAt ? new Date(bench.sampledAt).toLocaleTimeString() : "—"} detail={`${bench.range} - ${bench.models.length} filtered`} />
          <StatCard label="Method" value="Live probe" detail="Zen + history 7d" />
        </div>

        <article className="system-analytics-panel opencode-bench-xpreview">
          <header>
            <Zap aria-hidden="true" />
            <div>
              <strong>Separate measurement: X Preview F Free</strong>
              <small>opencode/x-preview-f-free · free · 131k — simple "hello" + complex LRU cache (confirms delay on complex code)</small>
            </div>
            <button type="button" className="opencode-bench-xprobe-button" disabled={xProbing} onClick={runXProbe} title="Executes 2 live prompts directly on x-preview-f-free to measure real status">
              <Zap aria-hidden="true" /> {xProbing ? "Probing X Preview..." : "Measure X Preview separately"}
            </button>
            <small className="opencode-bench-xprobe-side-note">Runs outside general benchmark — measures exactly this model with two prompts.</small>
          </header>
          <div className="opencode-bench-xpreview-body">
            {xProbe ? <div className="opencode-bench-xpreview-results">
              <div className="opencode-bench-xpreview-card">
                <span>Simple</span>
                <small>Say hello in one word (max 20 tok, 10s)</small>
                <strong>{xProbe.simple.ok ? "✓ OK" : "✗ FAILED / EMPTY"}</strong>
                <small>{xProbe.simple.latencyMs}ms · status {String(xProbe.simple.status ?? "—")} · out {String(xProbe.simple.outLen ?? "—")} chars</small>
              </div>
              <div className="opencode-bench-xpreview-card">
                <span>Complex</span>
                <small>TS concurrent LRU + TTL + tests (500 tok, 30s)</small>
                <strong>{xProbe.complex.ok ? "✓ OK" : "✗ EMPTY / TIMEOUT"}</strong>
                <small>{xProbe.complex.latencyMs}ms · status {String(xProbe.complex.status ?? "—")} · out {String(xProbe.complex.outLen ?? "—")} chars</small>
              </div>
              <div className="opencode-bench-xpreview-verdict">
                <Sparkles aria-hidden="true" /><span>{xProbe.verdict}</span>
                <small>History: {xProbe.hist ? `${xProbe.hist.completedTurns} completed / ${xProbe.hist.abortedTurns} aborted · TTFT ${xProbe.hist.avgTtftMs ?? "—"}ms` : "—"} · Sample {formatDate(xProbe.sampledAt)}</small>
              </div>
            </div> : <div className="opencode-bench-xpreview-placeholder">
              <small>Previous measurements (repeated): simple → <strong>503 UPSTREAM_UNAVAILABLE / EMPTY at 0.7-1.6s</strong>, complex → <strong>TIMEOUT 30s or empty 7s</strong>. Model showed 100 network due to 718/0 history, but live probe drops it to <strong>8-22</strong> and ranking falls. Press button for fresh measurement.</small>
            </div>}
          </div>
        </article>

        <article className="system-analytics-panel opencode-bench-controls">
          <header><Sparkles aria-hidden="true" /><div><strong>Catalog filters</strong><small>{bench.methodology}</small></div></header>
          <div className="opencode-bench-filter-row">
            <div className="opencode-bench-filter-group">
              <button type="button" aria-pressed={benchProvider==="all"} onClick={() => setBenchProvider("all")}>All</button>
              <button type="button" aria-pressed={benchProvider==="opencode"} onClick={() => setBenchProvider("opencode")}>opencode free</button>
              <button type="button" aria-pressed={benchProvider==="opencode-go"} onClick={() => setBenchProvider("opencode-go")}>opencode-go</button>
              <button type="button" aria-pressed={benchProvider==="openrouter"} onClick={() => setBenchProvider("openrouter")}>openrouter free</button>
            </div>
            <label className="opencode-bench-toggle"><input type="checkbox" checked={benchVisionOnly} onChange={(e) => setBenchVisionOnly(e.currentTarget.checked)} /> Vision only</label>
            <div className="opencode-bench-filter-group">
              <span>Sort</span>
              <select aria-label="Sort bench" value={benchSortKey} onChange={(e) => { const v = e.currentTarget.value as typeof benchSortKey; setBenchSortKey(v); setBenchSortDir(v === "provider" || v === "ttft" ? "asc" : "desc"); }}>
                <option value="codingScore">Coding score</option>
                <option value="visionScore">Vision score</option>
                <option value="network">Networking</option>
                <option value="toks">Speed (tok/s)</option>
                <option value="ttft">TTFT</option>
                <option value="provider">Provider</option>
              </select>
            </div>
            <label className="opencode-bench-search"><Search aria-hidden="true" /><input type="search" value={benchQuery} placeholder="Search models..." onChange={(e) => setBenchQuery(e.currentTarget.value)} /></label>
            <button type="button" className="opencode-bench-refresh" disabled={benchRefreshing} onClick={refreshBench} title="Restart live probe (fetch + verbose) — same as top button"><RefreshCw aria-hidden="true" /> {benchRefreshing ? "Measuring..." : "Re-measure"}</button>
          </div>
          {bench.notices.length > 0 ? <ul className="opencode-bench-notices">{bench.notices.map((n, i) => <li key={i}>{n}</li>)}</ul> : null}
        </article>

        <article className="system-analytics-panel system-analytics-table-panel">
          <header><Zap aria-hidden="true" /><div><strong>opencode, opencode-go & openrouter Catalog</strong><small>vision · networking · speed · score · updated — {benchFiltered.length} models (auto-pruned after 3d without update)</small></div></header>
          <div className="system-analytics-table-scroll"><table><thead><tr>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("provider")} title="Sort by provider">Provider / model{benchSortIndicator("provider")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("vision")} title="Sort by vision">Vision{benchSortIndicator("vision")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("networking")} title="Sort by networking">Networking{benchSortIndicator("networking")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("ttft")} title="Sort by TTFT">TTFT{benchSortIndicator("ttft")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("toks")} title="Sort by tok/s">tok/s{benchSortIndicator("toks")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("network")} title="Sort by Network score">Network{benchSortIndicator("network")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("visionScore")} title="Sort by Vision score">Vision score{benchSortIndicator("visionScore")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("codingScore")} title="Sort by Coding score">Coding score{benchSortIndicator("codingScore")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("rank")} title="Sort by rank">Rank{benchSortIndicator("rank")}</th>
            <th className="is-sortable" onClick={() => handleBenchHeaderSort("refreshed")} title="Sort by last updated">Updated{benchSortIndicator("refreshed")}</th>
          </tr></thead><tbody>
            {benchFiltered.map((m) => <tr key={`${m.providerId}:${m.modelId}`}>
              <td><strong>{m.displayName}</strong><small>{m.providerId}/{m.modelId} · {m.family ?? m.modelId} {m.costFree ? "· free" : ""} {m.contextLimit ? `· ${(m.contextLimit/1000).toFixed(0)}k` : ""}</small></td>
              <td>{m.vision ? <span className="opencode-bench-badge is-yes"><Eye aria-hidden="true" /> yes</span> : <span className="opencode-bench-badge is-no">no</span>}<small>{m.toolcall ? "tools" : "no-tools"} · {m.reasoning ? "reason" : "no-reason"}</small></td>
              <td><NetworkBadge value={m.networkStatus} /><small>{m.networkLatencyMs !== null ? `${m.networkLatencyMs}ms` : "latency —"} · {m.completedTurns}/{m.abortedTurns} · {m.coverage}</small></td>
              <td>{formatMs(m.avgTtftMs)}</td>
              <td>{m.avgTokPerSec === null ? "—" : m.avgTokPerSec.toFixed(1)}</td>
              <td><ScoreBar value={m.networkScore} /></td>
              <td><ScoreBar value={m.visionScore} /></td>
              <td><ScoreBar value={m.codingScore} /></td>
              <td><small>#{m.rankCoding ?? "—"} coding{m.rankVision ? ` · #${m.rankVision} vision` : ""}</small></td>
              <td><strong>{formatDate(m.lastRefreshedAt)}</strong><small>prune &gt;3d</small></td>
            </tr>)}
            {!benchFiltered.length ? <tr><td colSpan={10}>No models match filters.</td></tr> : null}
          </tbody></table></div>
          <footer className="opencode-bench-legend">
            <span><Eye aria-hidden="true" /> Vision = attachment && image input capability (live catalog)</span>
            <span><Network aria-hidden="true" /> Networking = probe fetch + history success rate</span>
            <span><Zap aria-hidden="true" /> VisionScore 30% network 40% speed 30% quality · CodingScore 25% network 35% speed 40% quality</span>
          </footer>
        </article>
      </> : null}
      {tab === "bench" && !bench && !loading && !error ? <article className="system-analytics-panel"><header><Zap aria-hidden="true" /><div><strong>OpenCode Bench</strong><small>No sample yet — press Run for live measurement opencode + opencode-go + openrouter</small></div></header><div style={{ padding: "0.6rem" }}><button type="button" className="opencode-bench-primary-refresh" onClick={refreshBench}><Zap aria-hidden="true" /> Run Benchmark now</button><p style={{ margin: "0.5rem 0 0", color: "#9da39f", fontSize: "0.64rem" }}>Will run live probe: parsing models + 3 fetch endpoints + history {range}.</p></div></article> : null}

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
