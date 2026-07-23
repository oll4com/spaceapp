import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
} from "react";
import type {
  CliSessionReapResponse,
  CliSessionStats,
  CodexEnvironment,
  CodexUsageAccountList,
  HostMemoryDetails,
  MemoryReclaimResponse,
  ProviderSwitchResponse,
  ProviderSwitchTargets,
} from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { ConfirmationDialog, MetricPopover } from "./MetricLayers.js";
import "./toolbar-metrics.css";

type PanelKey = "accounts" | "cli" | "memory" | "provider";
type ConfirmationKind = "cli" | "memory";

export interface ToolbarMetricsHandle {
  openCliCleanup(trigger?: HTMLButtonElement | null): void;
  openMemoryReclaim(trigger?: HTMLButtonElement | null): void;
}

export interface ToolbarMetricsClient {
  roundTrip(): Promise<number | null>;
  usageAccounts(): Promise<CodexUsageAccountList>;
  cliSessions(): Promise<CliSessionStats>;
  reapCliSessions(): Promise<CliSessionReapResponse>;
  hostMemory(): Promise<HostMemoryDetails>;
  reclaimMemory(): Promise<MemoryReclaimResponse>;
  providerTargets(): Promise<ProviderSwitchTargets>;
  switchProvider(providerId: string): Promise<ProviderSwitchResponse>;
}

const defaultClient: ToolbarMetricsClient = {
  roundTrip: async () => {
    if (getSpaceRuntimeKind() === "demo") return null;
    const startedAt = performance.now();
    await api.readyz();
    return Math.max(0, Math.round(performance.now() - startedAt));
  },
  usageAccounts: () => api.toolbarUsageAccounts(),
  cliSessions: () => api.toolbarCliSessions(),
  reapCliSessions: () => api.reapToolbarCliSessions(),
  hostMemory: () => api.toolbarHostMemory(),
  reclaimMemory: () => api.reclaimToolbarMemory(),
  providerTargets: () => api.toolbarProviderTargets(),
  switchProvider: (providerId) => api.switchToolbarProvider(providerId),
};

function useLazyResource<T>(loader: () => Promise<T>, ttlMs: number) {
  const loaderRef = useRef(loader);
  const dataRef = useRef<T | null>(null);
  const loadedAtRef = useRef(0);
  const inFlightRef = useRef<Promise<T | null> | null>(null);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  loaderRef.current = loader;

  const load = useCallback((force = false) => {
    if (dataRef.current && !force && Date.now() - loadedAtRef.current < ttlMs) return Promise.resolve(dataRef.current);
    if (inFlightRef.current) return inFlightRef.current;
    setLoading(true);
    setError(null);
    const request = loaderRef.current()
      .then((value) => {
        dataRef.current = value;
        loadedAtRef.current = Date.now();
        setData(value);
        return value;
      })
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : "Telemetry is temporarily unavailable.");
        return null;
      })
      .finally(() => {
        setLoading(false);
        inFlightRef.current = null;
      });
    inFlightRef.current = request;
    return request;
  }, [ttlMs]);

  return { data, error, load, loading };
}

function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "--";
}

function formatBytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (value >= gib) return `${(value / gib).toFixed(1)} GiB`;
  return `${Math.round(value / mib)} MiB`;
}

function usageTone(value: number | null | undefined, warnAt: number, badAt: number): "muted" | "warn" | "bad" {
  if (typeof value !== "number" || !Number.isFinite(value)) return "muted";
  if (value >= badAt) return "bad";
  if (value >= warnAt) return "warn";
  return "muted";
}

export interface ToolbarRttPresentation {
  status: "measuring" | "good" | "warning" | "critical";
  tone: "muted" | "warn" | "bad";
  value: string;
}

export function getToolbarRttPresentation(rttMs: number | null, failed: boolean): ToolbarRttPresentation {
  if (failed) return { status: "critical", tone: "bad", value: "ERR" };
  if (rttMs === null || !Number.isFinite(rttMs)) return { status: "measuring", tone: "muted", value: "--" };
  const value = Math.max(0, Math.round(rttMs));
  if (value >= 425) return { status: "critical", tone: "bad", value: String(value) };
  if (value >= 300) return { status: "warning", tone: "warn", value: String(value) };
  return { status: "good", tone: "muted", value: String(value) };
}

function providerBadge(environment: CodexEnvironment | null): string {
  const modelProvider = environment?.config.modelProvider?.toLowerCase() ?? "";
  const routeMode = environment?.lbUsage?.routeMode;
  const routeTargetMode = environment?.lbUsage?.routeTargetMode;
  const upstream = environment?.lbUsage?.upstream?.toLowerCase() ?? "";
  if (modelProvider === "openai") return "OPAI";
  if (routeMode === "headroom" || upstream === "headroom") return "HD";
  if (routeTargetMode === "fallback" || upstream === "fallback") return "LB.B";
  if (routeMode === "direct" || routeTargetMode === "primary" || routeTargetMode === "auto" || upstream === "primary") return "LB.A";
  if (modelProvider === "codex-lb") return "LB.A";
  return "--";
}

function providerBadgeFromSwitch(result: ProviderSwitchResponse): string {
  if (result.routeMode === "headroom") return "HD";
  if (result.routeTargetMode === "fallback") return "LB.B";
  if (result.routeMode === "direct") return "LB.A";
  return "--";
}

export interface ToolbarMetricsSnapshot {
  all: string;
  cli: string;
  cpu: string;
  provider: string;
  ram: string;
  swap: string;
}

export function getToolbarMetricsSnapshot(environment: CodexEnvironment | null): ToolbarMetricsSnapshot {
  const host = environment?.hostStats;
  return {
    all: formatPercent(environment?.lbUsage?.allAccountsRemainingPercent),
    cli: host ? String(host.cliSessions.active) : "--",
    cpu: formatPercent(host?.cpu.usagePercent),
    provider: providerBadge(environment),
    ram: formatPercent(host?.memory.usagePercent),
    swap: formatPercent(host?.swap.usagePercent),
  };
}

export function ToolbarMetricsSummary({ environment }: { environment: CodexEnvironment | null }) {
  const snapshot = getToolbarMetricsSnapshot(environment);
  const metrics = [
    ["ALL", snapshot.all],
    ["CLI", snapshot.cli],
    ["RAM", snapshot.ram],
    ["CPU", snapshot.cpu],
    ["SWP", snapshot.swap],
    ["Provider", snapshot.provider],
  ] as const;

  return (
    <section className="mobile-system-metrics" aria-label="System metrics">
      <strong>System metrics</strong>
      <ul>
        {metrics.map(([label, value]) => (
          <li key={label}><small>{label}</small><strong>{value}</strong></li>
        ))}
      </ul>
    </section>
  );
}

function MetricRow({ label, value }: { label: string; value: string }) {
  return <div className="toolbar-metric-row"><span>{label}</span><strong>{value}</strong></div>;
}

export const ToolbarMetrics = forwardRef<ToolbarMetricsHandle, {
  canManage?: boolean;
  client?: ToolbarMetricsClient;
  environment: CodexEnvironment | null;
  onChanged?: () => void | Promise<void>;
  roomName?: string;
}>(function ToolbarMetrics({
  canManage = true,
  client = defaultClient,
  environment,
  onChanged,
  roomName,
}, ref) {
  const accounts = useLazyResource(() => client.usageAccounts(), 60_000);
  const cli = useLazyResource(() => client.cliSessions(), 5_000);
  const memory = useLazyResource(() => client.hostMemory(), 10_000);
  const providers = useLazyResource(() => client.providerTargets(), 10_000);
  const anchorsRef = useRef<Record<PanelKey, HTMLButtonElement | null>>({ accounts: null, cli: null, memory: null, provider: null });
  const closeTimerRef = useRef<number | null>(null);
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const [activePanel, setActivePanel] = useState<PanelKey | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationKind | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [providerPickerOpen, setProviderPickerOpen] = useState(false);
  const [providerSwitchingId, setProviderSwitchingId] = useState<string | null>(null);
  const [switchedProviderCode, setSwitchedProviderCode] = useState<string | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [rttFailed, setRttFailed] = useState(false);
  const snapshot = getToolbarMetricsSnapshot(environment);
  const providerCode = switchedProviderCode ?? snapshot.provider;
  const rtt = getToolbarRttPresentation(rttMs, rttFailed);

  useEffect(() => setSwitchedProviderCode(null), [environment]);
  useEffect(() => {
    let disposed = false;
    let inFlight = false;

    const sample = async () => {
      if (disposed || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const measuredRttMs = await client.roundTrip();
        if (measuredRttMs === null) {
          if (!disposed) {
            setRttMs(null);
            setRttFailed(false);
          }
          return;
        }
        if (!Number.isFinite(measuredRttMs)) throw new Error("Invalid RTT sample");
        if (!disposed) {
          setRttMs(Math.max(0, Math.round(measuredRttMs)));
          setRttFailed(false);
        }
      } catch {
        if (!disposed) {
          setRttMs(null);
          setRttFailed(true);
        }
      } finally {
        inFlight = false;
      }
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void sample();
    };

    void sample();
    const timer = window.setInterval(() => void sample(), 10_000);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [client]);
  useEffect(() => {
    if (!providerPickerOpen || !providers.data) return;
    providerMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [providerPickerOpen, providers.data]);
  useEffect(() => () => {
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const closePanel = useCallback(() => {
    cancelClose();
    setActivePanel(null);
    setProviderPickerOpen(false);
  }, [cancelClose]);

  const requestClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(closePanel, 140);
  }, [cancelClose, closePanel]);

  function loadPanel(panel: PanelKey) {
    switch (panel) {
      case "accounts": return accounts.load();
      case "cli": return cli.load();
      case "memory": return memory.load();
      case "provider": return providers.load();
    }
  }

  function openPanel(panel: PanelKey) {
    cancelClose();
    setActivePanel(panel);
    if (canManage) void loadPanel(panel);
  }

  const openConfirmation = useCallback((kind: ConfirmationKind, trigger?: HTMLButtonElement | null) => {
    if (!canManage) return;
    actionTriggerRef.current = trigger ?? anchorsRef.current[kind === "cli" ? "cli" : "memory"];
    setActionMessage(null);
    setConfirmation(kind);
  }, [canManage]);

  useImperativeHandle(ref, () => ({
    openCliCleanup: (trigger) => openConfirmation("cli", trigger),
    openMemoryReclaim: (trigger) => openConfirmation("memory", trigger),
  }), [openConfirmation]);

  function closeConfirmation() {
    setConfirmation(null);
    window.setTimeout(() => actionTriggerRef.current?.focus(), 0);
  }

  async function confirmAction() {
    if (!confirmation || actionBusy) return;
    setActionBusy(true);
    setActionMessage(null);
    try {
      if (confirmation === "cli") {
        const result = await client.reapCliSessions();
        const count = result.killedSessionIds.length;
        setActionMessage(result.status === "NOOP"
          ? "CLI cleanup made no changes; no session was stopped."
          : `${count} detached CLI session${count === 1 ? "" : "s"} cleaned; approximately ${formatBytes(result.estimatedReclaimedBytes)} released.`);
        await cli.load(true);
      } else {
        const result = await client.reclaimMemory();
        const cliCount = result.cli.killedSessionIds.length;
        setActionMessage(result.status === "NOOP"
          ? "Memory reclaim made no changes; no session or process was stopped."
          : `Memory reclaim ${result.status.toLowerCase()}: ${cliCount} CLI session${cliCount === 1 ? "" : "s"} cleaned and ${formatBytes(result.kernelCache.reclaimedBytes)} page cache released.`);
        await Promise.all([memory.load(true), cli.load(true)]);
      }
      await onChanged?.();
      closeConfirmation();
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : "The safe toolbar action failed.");
    } finally {
      setActionBusy(false);
    }
  }

  async function switchProvider(providerId: string) {
    if (providerSwitchingId) return;
    const target = providers.data?.data.find((item) => item.providerId === providerId);
    setProviderSwitchingId(providerId);
    setActionMessage(null);
    try {
      const result = await client.switchProvider(providerId);
      setSwitchedProviderCode(providerBadgeFromSwitch(result));
      setActionMessage(result.status === "SWITCHED"
        ? `Provider switched to ${target?.displayName ?? providerId}.`
        : "Provider route unchanged; no external route was modified.");
      setProviderPickerOpen(false);
      closePanel();
      await providers.load(true);
      await onChanged?.();
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : "Provider switch failed; the previous route remains active.");
    } finally {
      setProviderSwitchingId(null);
    }
  }

  const host = environment?.hostStats;
  const ramValue = snapshot.ram;
  const cpuValue = snapshot.cpu;
  const swapValue = snapshot.swap;

  function anchorEvents(panel: PanelKey) {
    return {
      onMouseEnter: () => openPanel(panel),
      onMouseLeave: requestClose,
      onFocus: () => openPanel(panel),
      onBlur: requestClose,
    };
  }

  function panelContent() {
    if (!canManage) return <p className="toolbar-metric-note">ADMIN access is required for detailed system telemetry and actions.</p>;
    if (activePanel === "accounts") return (
      <>
        <header><strong>Codex usage</strong><small>{accounts.data?.isStale ? "Stale sample" : "On demand"}</small></header>
        <div className="toolbar-metric-grid">
          <MetricRow label="All accounts" value={formatPercent(environment?.lbUsage?.allAccountsRemainingPercent)} />
          <MetricRow label="Active accounts" value={formatPercent(environment?.lbUsage?.activeAccountsRemainingPercent)} />
        </div>
        {accounts.loading ? <p className="toolbar-metric-note">Loading account details…</p> : null}
        {accounts.error ? <p className="toolbar-metric-error" role="alert">{accounts.error}</p> : null}
        {accounts.data?.error ? <p className="toolbar-metric-error">{accounts.data.error}</p> : null}
        {accounts.data ? <ul className="toolbar-metric-list">
          {accounts.data.data.map((account) => <li key={account.id}>
            <strong>{account.label}</strong>
            <span>5h {formatPercent(account.fiveHourRemainingPercent)} · week {formatPercent(account.weeklyRemainingPercent)}</span>
          </li>)}
          {!accounts.data.data.length ? <li><span>No enabled account samples.</span></li> : null}
        </ul> : null}
      </>
    );
    if (activePanel === "cli") return (
      <>
        <header><strong>Space CLI sessions</strong><small>On demand</small></header>
        {cli.loading ? <p className="toolbar-metric-note">Loading CLI details…</p> : null}
        {cli.error ? <p className="toolbar-metric-error" role="alert">{cli.error}</p> : null}
        {cli.data ? <>
          <div className="toolbar-metric-grid">
            <MetricRow label="Running" value={String(cli.data.summary.running)} />
            <MetricRow label="Attached" value={String(cli.data.summary.attached)} />
            <MetricRow label="Detached" value={String(cli.data.summary.detached)} />
            <MetricRow label="Cleanup eligible" value={String(cli.data.summary.cleanupEligible)} />
          </div>
          <ul className="toolbar-metric-list">
            {cli.data.sessions.map((session) => <li key={`${session.hostId}:${session.sessionId}`}>
              <strong>{session.hostId.toUpperCase()} · {formatBytes(session.rssBytes)}</strong>
              <span>{session.attachmentCount} attachments · {session.cleanupEligible ? "eligible" : "protected"}</span>
            </li>)}
          </ul>
        </> : null}
      </>
    );
    if (activePanel === "memory") return (
      <>
        <header><strong>Host memory</strong><small>On demand</small></header>
        {memory.loading ? <p className="toolbar-metric-note">Loading memory details…</p> : null}
        {memory.error ? <p className="toolbar-metric-error" role="alert">{memory.error}</p> : null}
        {memory.data ? <>
          <div className="toolbar-metric-grid">
            <MetricRow label="Used" value={`${formatPercent(memory.data.memory.usagePercent)} · ${formatBytes(memory.data.memory.usedBytes)}`} />
            <MetricRow label="Available" value={formatBytes(memory.data.memory.availableBytes)} />
            <MetricRow label="Page cache" value={formatBytes(memory.data.memory.pageCacheBytes)} />
            <MetricRow label="Pressure" value={memory.data.pressure.isUnderPressure ? "Yes" : "No"} />
          </div>
          <strong className="toolbar-metric-subtitle">Top processes</strong>
          <ul className="toolbar-metric-list">
            {memory.data.topProcesses.map((process) => <li key={process.pid}>
              <strong>{process.name}</strong>
              <span>{formatBytes(process.rssBytes)} · CPU {formatPercent(process.cpuPercent)} · {process.state}</span>
            </li>)}
            {!memory.data.topProcesses.length ? <li><span>No process sample available.</span></li> : null}
          </ul>
        </> : null}
      </>
    );
    return (
      <>
        <header><strong>Codex provider</strong><small>{providerCode}</small></header>
        {providers.loading ? <p className="toolbar-metric-note">Checking provider routes…</p> : null}
        {providers.error ? <p className="toolbar-metric-error" role="alert">{providers.error}</p> : null}
        {providers.data && !providerPickerOpen ? <ul className="toolbar-metric-list">
          {providers.data.data.map((provider) => <li key={provider.providerId}>
            <strong>{provider.displayName}{provider.isCurrent ? " · current" : ""}</strong>
            <span>{provider.health.toLowerCase()}{provider.reason ? ` · ${provider.reason}` : ""}</span>
          </li>)}
        </ul> : null}
        {providers.data && providerPickerOpen ? <div ref={providerMenuRef} className="toolbar-provider-menu" role="menu" aria-label="Provider quick switch">
          {providers.data.data.map((provider) => (
            <button
              key={provider.providerId}
              type="button"
              role="menuitemradio"
              aria-checked={provider.isCurrent}
              disabled={provider.isCurrent || !provider.canSwitch || Boolean(providerSwitchingId)}
              title={provider.reason ?? undefined}
              onClick={() => void switchProvider(provider.providerId)}
            >
              <span>{provider.displayName}</span>
              <small>{provider.isCurrent ? "Current" : provider.canSwitch ? provider.health : provider.reason ?? provider.health}</small>
            </button>
          ))}
        </div> : null}
      </>
    );
  }

  const panelLabels: Record<PanelKey, string> = {
    accounts: "Account usage details",
    cli: "CLI session details",
    memory: "Memory details",
    provider: "Provider details",
  };

  return <>
    <section className="toolbar-lb-strip toolbar-metrics-strip" aria-label={roomName ? `Room Codex LB ${roomName}` : "Toolbar system metrics"}>
      <button
        ref={(node) => { anchorsRef.current.accounts = node; }}
        type="button"
        className="toolbar-lb-badge toolbar-metric-trigger"
        aria-label={`ALL ${snapshot.all}`}
        aria-expanded={activePanel === "accounts"}
        aria-controls="toolbar-metric-panel-accounts"
        {...anchorEvents("accounts")}
      ><small>ALL</small><strong>{snapshot.all}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.cli = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger${host?.cliSessions.status === "PARTIAL" ? " tone-warn" : ""}`}
        aria-label={host ? `CLI ${host.cliSessions.active} running, ${host.cliSessions.attached} attached, ${host.cliSessions.detached} detached` : "CLI unavailable"}
        aria-expanded={activePanel === "cli"}
        aria-controls="toolbar-metric-panel-cli"
        onClick={(event: MouseEvent<HTMLButtonElement>) => openConfirmation("cli", event.currentTarget)}
        {...anchorEvents("cli")}
      ><small>CLI</small><strong>{snapshot.cli}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.memory = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger tone-${usageTone(host?.memory.usagePercent, 80, 90)}`}
        aria-label={host ? `RAM ${ramValue}, ${formatBytes(host.memory.usedBytes)} of ${formatBytes(host.memory.totalBytes)}` : "RAM unavailable"}
        aria-expanded={activePanel === "memory"}
        aria-controls="toolbar-metric-panel-memory"
        onClick={(event: MouseEvent<HTMLButtonElement>) => openConfirmation("memory", event.currentTarget)}
        {...anchorEvents("memory")}
      ><small>RAM</small><strong>{ramValue}</strong></button>
      <article
        className={`toolbar-lb-badge tone-${usageTone(host?.cpu.usagePercent, 85, 95)}`}
        aria-label={host ? `CPU ${cpuValue}, ${host.cpu.coreCount ?? "--"} cores` : "CPU unavailable"}
        title={host ? `CPU: ${cpuValue}, ${host.cpu.coreCount ?? "--"} cores` : "CPU metrics unavailable"}
      ><small>CPU</small><strong>{cpuValue}</strong></article>
      <article
        className={`toolbar-lb-badge tone-${usageTone(host?.swap.usagePercent, 50, 80)}`}
        aria-label={host ? `SWP ${swapValue}, ${formatBytes(host.swap.usedBytes)} of ${formatBytes(host.swap.totalBytes)}` : "SWP unavailable"}
        title={host ? `SWP: ${swapValue}, ${formatBytes(host.swap.usedBytes)} of ${formatBytes(host.swap.totalBytes)}` : "Swap metrics unavailable"}
      ><small>SWP</small><strong>{swapValue}</strong></article>
      <article
        className={`toolbar-lb-badge tone-${rtt.tone}`}
        aria-label={rttFailed
          ? "RTT unavailable, critical"
          : rttMs === null
            ? "RTT measuring"
            : `RTT ${rtt.value} milliseconds, ${rtt.status}`}
        title={rttFailed
          ? "RTT: unavailable · Critical"
          : rttMs === null
            ? "RTT: measuring"
            : `RTT: ${rtt.value} ms · ${rtt.status[0]?.toUpperCase()}${rtt.status.slice(1)}`}
      ><small>RTT</small><strong>{rtt.value}</strong></article>
      <button
        ref={(node) => { anchorsRef.current.provider = node; }}
        type="button"
        className="toolbar-lb-badge provider toolbar-metric-trigger"
        aria-label={`Provider ${providerCode}`}
        aria-expanded={activePanel === "provider"}
        aria-controls="toolbar-metric-panel-provider"
        onClick={() => {
          openPanel("provider");
          if (canManage) setProviderPickerOpen(true);
        }}
        {...anchorEvents("provider")}
      ><small>{providerCode}</small></button>
    </section>
    {activePanel ? <MetricPopover
      anchor={anchorsRef.current[activePanel]}
      id={`toolbar-metric-panel-${activePanel}`}
      label={panelLabels[activePanel]}
      onCancelClose={cancelClose}
      onRequestClose={requestClose}
    >{panelContent()}</MetricPopover> : null}
    {confirmation === "cli" ? <ConfirmationDialog
      busy={actionBusy}
      label="Clean detached CLI sessions"
      confirmLabel="Confirm CLI cleanup"
      onCancel={closeConfirmation}
      onConfirm={() => void confirmAction()}
    ><p>Only Space-managed CLI sessions that are still detached and have been detached for at least 5 minutes are eligible. Attached and recent sessions stay protected.</p></ConfirmationDialog> : null}
    {confirmation === "memory" ? <ConfirmationDialog
      busy={actionBusy}
      label="Reclaim safe memory"
      confirmLabel="Confirm memory reclaim"
      onCancel={closeConfirmation}
      onConfirm={() => void confirmAction()}
    ><p>This rechecks live pressure, cleans eligible detached Space CLIs, and drops page cache only when safe. It never kills arbitrary processes.</p></ConfirmationDialog> : null}
    {actionMessage ? <div className="toolbar-metric-action-status" role="status" aria-live="polite">{actionMessage}</div> : null}
  </>;
});
