import type { McpDiscoverySmokeCheck, Model, ObservabilitySnapshot, Provider, StorageReadiness, WorkerReadiness } from "@space/contracts";
import type { McpPayload, ReadyzPayload } from "../../api.js";
import { useState } from "react";
import { Activity, GitCompare, HardDrive, RefreshCw, ServerCog, ShieldCheck, UserCheck, type LucideIcon } from "../ui-theme/app-icons.js";
import { useAppVersion } from "../app-version/use-app-version.js";
import { statusTone } from "../status-tone.js";
import { DockIconButton, DockNotice, DockToolbar } from "../dock-kit/DockKit.js";

interface RuntimeStatusProps {
  readiness: ReadyzPayload | null;
  mcp: McpPayload | null;
  latestSmoke: McpDiscoverySmokeCheck | null;
  observability: ObservabilitySnapshot | null;
  workerReadiness: WorkerReadiness | null;
  storageReadiness: StorageReadiness | null;
}

interface HealthDockProps extends RuntimeStatusProps {
  providers: Provider[];
  models: Model[];
  /** Reloads every health snapshot; the dock also reloads each time it opens. */
  onRefresh?: () => Promise<void>;
  /** Set when one or more snapshots could not be loaded. */
  loadError?: string | null;
}

export function HealthDock({
  readiness,
  mcp,
  latestSmoke,
  providers,
  models,
  observability,
  workerReadiness,
  storageReadiness,
  onRefresh,
  loadError = null
}: HealthDockProps) {
  const [refreshing, setRefreshing] = useState(false);
  // Without an error a missing snapshot is still loading; with one it is unavailable.
  const pending = loadError ? "Unavailable" : "Loading";
  const dependencies = readiness?.dependencies;
  const provider = providers[0] ?? null;
  const verifiedModelCount = models.filter((model) => model.status === "VERIFIED").length;
  const requestValue = observability
    ? `${observability.totals.requestCount} req / p95 ${formatDurationMs(observability.totals.p95Ms)}`
    : pending;
  const storageDetail = storageReadiness
    ? storageReadiness.statusReason
    : "Storage snapshot loading";
  const storageMeta = storageReadiness
    ? `${formatBytes(storageReadiness.app.availableBytes)} free / root ${storageReadiness.root.usedPercent}% / dedicated ${storageReadiness.dedicatedAppVolume ? "yes" : "no"}`
    : "Checking storage";
  const appVersion = useAppVersion();
  const versionDetail = appVersion?.athensTag
    ? `${appVersion.athensTag}`
    : appVersion?.shortCommit
      ? `commit ${appVersion.shortCommit}${appVersion.dirty ? " · dirty" : ""}`
      : "Version unavailable";
  const versionValue = appVersion?.appRelease ?? pending;
  const checks = [readiness, workerReadiness, providers.length > 0, storageReadiness, mcp, observability];
  const loadedChecks = checks.filter(Boolean).length;

  async function refresh() {
    if (!onRefresh || refreshing) return;
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="dock-panel health-dock">
      <DockToolbar summary={<><strong>{loadedChecks}</strong> of {checks.length} checks reporting</>}>
        {onRefresh ? <DockIconButton label="Refresh health" icon={RefreshCw} busy={refreshing} onClick={() => void refresh()} /> : null}
      </DockToolbar>
      {loadError ? <DockNotice tone="warning">{loadError}</DockNotice> : null}
      <section className="health-grid" aria-label="Space health status">
        <HealthTile
          icon={ServerCog}
          label="Runtime"
          value={dependencies ? `${dependencies.runtimeStore} / Temporal ${dependencies.temporal}` : pending}
          detail={dependencies ? `Worker ${dependencies.worker}` : "Runtime snapshot loading"}
          tone={readiness?.ok ? "ok" : "muted"}
        />
        <HealthTile
          icon={UserCheck}
          label="Worker"
          value={workerReadiness?.status ?? dependencies?.worker ?? pending}
          detail={workerReadiness ? `${workerReadiness.pollerCount} pollers / ${workerReadiness.taskQueue}` : "Worker snapshot loading"}
          tone={statusTone(workerReadiness?.status ?? dependencies?.worker ?? "")}
        />
        <HealthTile
          icon={ServerCog}
          label="Provider"
          value={provider?.displayName ?? "No provider"}
          detail={provider ? `${provider.status} / ${verifiedModelCount}/${models.length} verified models` : "Provider catalog loading"}
          tone={statusTone(provider?.status ?? "")}
        />
        <HealthTile
          icon={HardDrive}
          label="Storage"
          value={storageReadiness?.status ?? pending}
          detail={storageDetail}
          meta={storageMeta}
          tone={statusTone(storageReadiness?.status ?? "")}
        />
        <HealthTile
          icon={ShieldCheck}
          label="MCP"
          value={mcp?.gateway.status ?? pending}
          detail={mcp ? `Chat gateway ${mcp.gateway.serverCount} servers / ${mcp.gateway.toolCount} tools${mcp.dispatcher
            ? ` · CLI dispatcher ${mcp.dispatcher.backendCount} backends${mcp.dispatcher.staleIds.length ? `, ${mcp.dispatcher.staleIds.length} stale (${mcp.dispatcher.staleIds.join(", ")})` : ""}`
            : ""}` : "MCP snapshot loading"}
          meta={latestSmoke?.code ? readableCode(latestSmoke.code) : "Smoke not run"}
          tone={statusTone(mcp?.gateway.status ?? latestSmoke?.status ?? "")}
        />
        <HealthTile
          icon={Activity}
          label="Requests"
          value={requestValue}
          detail={observability ? `${observability.totals.errorCount} errors` : "Observability snapshot loading"}
          tone={(observability?.totals.errorCount ?? 0) > 0 ? "bad" : observability ? "ok" : "muted"}
        />
        <HealthTile
          icon={GitCompare}
          label="Version"
          value={versionValue}
          detail={versionDetail}
          meta={
            appVersion?.updateAvailable && appVersion.githubLatest
              ? `Update available: ${appVersion.githubLatest}`
              : appVersion?.checkedAt
                ? "Up to date"
                : undefined
          }
          tone={appVersion?.updateAvailable ? "warn" : appVersion ? "ok" : "muted"}
        />
      </section>
    </div>
  );
}

function HealthTile({
  icon: Icon,
  label,
  value,
  detail,
  meta,
  tone
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  meta?: string;
  tone: string;
}) {
  return (
    <article className="health-tile" aria-label={`${label} health`}>
      <div className="health-tile-top">
        <Icon aria-hidden="true" />
        <span className={`status ${tone}`}>{value}</span>
      </div>
      <strong>{label}</strong>
      <small>{detail}</small>
      {meta ? <small className="health-tile-meta">{meta}</small> : null}
    </article>
  );
}

function formatDurationMs(value: number | null) {
  if (value === null) return "n/a";
  if (value < 10) return `${value.toFixed(1)}ms`;
  return `${Math.round(value)}ms`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024 * 1024) return `${(value / (1024 * 1024 * 1024)).toFixed(1)}GB`;
  if (value >= 1024 * 1024) return `${Math.round(value / (1024 * 1024))}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function readableCode(code: string) {
  return code
    .split("_")
    .filter(Boolean)
    .map((part) => part[0] + part.slice(1).toLowerCase())
    .join(" ");
}
