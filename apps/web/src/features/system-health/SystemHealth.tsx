import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  UPPER_RAIL_ORDER_KEY,
  UPPER_RAIL_IDS,
  useRailOrder,
} from "../ui-theme/use-rail-order.js";
import { RailVisibilityMenu } from "../ui-theme/RailVisibilityMenu.js";
import {
  DEFAULT_UPPER_RAIL_ITEMS,
  UPPER_RAIL_HIDDEN_KEY,
  UPPER_RAIL_NON_HIDEABLE,
  useRailVisibility,
  type RailVisibilityMenuState,
} from "../ui-theme/use-rail-visibility.js";
import { dispatchRailMenuChange } from "../rail-popover.js";
import type {
  AntigravityUsageAccount,
  AntigravityUsageGroup,
  CodexEnvironment,
  CodexUsageAccount,
  HostMemoryDetails,
  SystemAnalyticsCliSessionsResponse,
  SystemHealthHistory,
  SystemHealthMetric,
  SystemHealthRange,
} from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Check,
  Clock3,
  Cpu,
  Database,
  HardDrive,
  LayoutDashboard,
  Boxes as Layers,
  Maximize2,
  MemoryStick,
  Minimize2,
  Network,
  ServerCog,
  Settings2 as Settings,
  ShieldCheck,
  Terminal,
  Gauge as Wallet,
  Sparkles,
  X,
  type LucideIcon,
} from "../ui-theme/app-icons.js";
import { computeQuotaAggregates } from "../desktop-widgets/AiQuotaWidget.js";
import {
  ToolbarMetrics,
  formatBytes,
  formatPercent,
  getToolbarMetricsSnapshot,
} from "../toolbar-metrics/ToolbarMetrics.js";
import { formatAppTime } from "../date-time-settings/date-time-settings.js";
import { useAppVersion } from "../app-version/use-app-version.js";
import { getAgentsIndicatorBorder, type AgentDashboardSummary } from "../agents-dashboard/dashboard-model.js";
import { HealthChart } from "./HealthChart.js";
import { HealthAiPanel, HealthProcessTable } from "./HealthTables.js";
import {
  computeCodexCooldown,
  defaultHealthThresholds,
  formatHealthValue,
  getReactivationCountdown,
  healthRailStorageKey,
  healthThresholdStorageKey,
  openSystemHealth,
  readHealthThresholds,
  serviceTone,
  thresholdDefinitions,
  toneLabels,
  validHealthThresholds,
  type HealthSection,
  type HealthThresholds,
  type HealthTone,
} from "./health-model.js";
import {
  useHealthTelemetry,
  type HealthTelemetry,
} from "./use-health-telemetry.js";
import { RecoverableSurface } from "../SurfaceErrorBoundary.js";
const SystemTopologyMap = lazy(() => import("./SystemTopologyMap.js").then(module => ({ default: module.SystemTopologyMap })));
import "./system-health.css";

const TokenUsageWorkspace = lazy(() => import("../system-analytics/SystemAnalyticsWorkspace.js").then(module => ({ default: module.SystemAnalyticsWorkspace })));

const sections: Array<{ id: HealthSection; label: string; icon: LucideIcon }> =
  [
    { id: "overview", label: "Overview", icon: Activity },
    { id: "topology", label: "Topology", icon: Network },
    { id: "performance", label: "Performance", icon: Cpu },
    { id: "processes", label: "Processes", icon: Layers },
    { id: "services", label: "Services", icon: ServerCog },
    { id: "ai", label: "AI & Sessions", icon: Terminal },
    { id: "alerts", label: "Alerts", icon: AlertTriangle },
    { id: "usage", label: "Token usage", icon: Database },
  ];
const rangeSeconds: Record<SystemHealthRange, number> = {
  "1m": 60,
  "10m": 600,
  "1h": 3600,
  "7d": 604800,
  "30d": 2592000,
};
const rangeLabels: Record<SystemHealthRange, string> = {
  "1m": "Live · 60 sec",
  "10m": "10 min",
  "1h": "1 hour",
  "7d": "7 days",
  "30d": "30 days",
};
const groupIcons: Record<SystemHealthMetric["group"], LucideIcon> = {
  cpu: Cpu,
  memory: MemoryStick,
  swap: Database,
  disk: HardDrive,
  network: Network,
  requests: Activity,
};

function StatusBadge({ tone }: { tone: HealthTone }) {
  return (
    <span className={`health-status is-${tone}`}>
      <i aria-hidden="true" />
      {toneLabels[tone]}
    </span>
  );
}
interface SummaryMetric {
  id: string;
  label: string;
  icon: LucideIcon;
  value: string;
  tone: HealthTone;
  detail: string;
  at?: string;
}
function summaryMetrics(t: HealthTelemetry): SummaryMetric[] {
  const snapshot = getToolbarMetricsSnapshot(t.environment);
  const metric = (id: string) => t.metrics.find((m) => m.id === id);
  const age = (at: string | undefined, ttl: number) =>
    !at || t.clock - Date.parse(at) > ttl;
  const provider = t.snapshot?.services.find((s) => s.id === "provider");
  const basic = (
    id: string,
    label: string,
    icon: LucideIcon,
  ): SummaryMetric => ({
    id,
    label,
    icon,
    value: formatHealthValue(metric(id)?.value, metric(id)?.unit ?? "PERCENT"),
    tone: t.toneFor(id),
    detail: metric(id)?.detail ?? "Waiting for telemetry",
    at: metric(id)?.sampledAt,
  });
  const cooldown = computeCodexCooldown(t.accounts, t.environment, t.clock);
  const items: SummaryMetric[] = [
    {
      ...basic("accounts", "Account remaining", Wallet),
      value:
        t.environment?.isCodexEnabled === false
          ? "OFF"
          : formatHealthValue(metric("accounts")?.value, "PERCENT"),
      tone:
        t.environment?.isCodexEnabled === false
          ? "disabled"
          : t.toneFor("accounts"),
    },
  ];
  if (cooldown) {
    items.push({
      id: "codex-reset",
      label: "Next token reset",
      icon: Clock3,
      value: cooldown.formatted,
      tone: "warning",
      detail: `Next Codex account available: ${cooldown.accountLabel ?? "account"} in ${cooldown.formatted}${cooldown.resetAt ? ` (${formatAppTime(cooldown.resetAt, { hour: "2-digit", minute: "2-digit" })})` : ""}`,
      at: cooldown.resetAt ?? undefined,
    });
  }
  items.push(
    {
      id: "cli",
      label: "CLI sessions",
      icon: Terminal,
      value: t.sessions ? String(t.sessions.summary.running) : "—",
      tone: age(t.sessions?.sampledAt, 30_000) ? "unavailable" : "healthy",
      detail: t.sessions
        ? `${t.sessions.summary.attached} attached · ${t.sessions.summary.detached} detached`
        : "Global running CLI sessions",
      at: t.sessions?.sampledAt,
    },
    basic("memory", "Memory", MemoryStick),
    basic("cpu", "CPU", Cpu),
    {
      ...basic("rtt", "Connection latency", Network),
      value: t.rtt?.failed
        ? "ERR"
        : formatHealthValue(t.rtt?.value, "MILLISECONDS"),
    },
    {
      id: "models",
      label: "Active models",
      icon: Layers,
      value: t.models ? String(t.models.models.length) : "—",
      tone: age(t.models?.sampledAt, 90_000) ? "unavailable" : "healthy",
      detail: "Global model activity in the last 10 minutes",
      at: t.models?.sampledAt,
    },
    {
      id: "provider",
      label: "Provider",
      icon: ShieldCheck,
      value: snapshot.provider,
      tone:
        t.environment?.isCodexEnabled === false
          ? "disabled"
          : provider
            ? serviceTone(provider, t.clock)
            : "unavailable",
      detail: provider?.detail ?? "Current provider route",
      at: provider?.checkedAt,
    },
  );
  return items;
}
function summaryDestination(id: string): {
  section: HealthSection;
  metric?: string;
} {
  return ["accounts", "codex-reset", "models", "cli", "provider"].includes(id)
    ? { section: "ai" }
    : { section: "performance", metric: id };
}
function MetricCard({
  item,
  telemetry,
  onClick,
  selected = false,
}: {
  item: SummaryMetric;
  telemetry: HealthTelemetry;
  onClick: () => void;
  selected?: boolean;
}) {
  const Icon = item.icon;
  const metric = telemetry.metrics.find((m) => m.id === item.id);
  return (
    <button
      type="button"
      className={`health-metric-card is-${item.tone}`}
      onClick={onClick}
      aria-pressed={selected}
    >
      <span className="health-metric-card-top">
        <Icon aria-hidden="true" />
        <span>{item.label}</span>
        <i className="health-dot" aria-hidden="true" />
      </span>
      <strong>{item.value}</strong>
      <span className="health-card-state">{toneLabels[item.tone]}</span>
      <HealthChart
        compact
        series={telemetry.history.filter((s) => s.id === item.id)}
        rangeSeconds={600}
        endAt={new Date(telemetry.clock).toISOString()}
        percent={metric?.unit === "PERCENT"}
      />
      {metric?.unit === "PERCENT" && metric.value !== null && (
        <span className="health-meter" aria-hidden="true">
          <i style={{ width: `${Math.min(100, metric.value)}%` }} />
        </span>
      )}
    </button>
  );
}
function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    ref.current?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input, select, [tabindex="0"]',
        ) ?? []),
      ].filter((e) => e.getClientRects().length);
      const first = focusable[0],
        last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        return;
      }
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === ref.current)
      ) {
        event.preventDefault();
        last.focus();
      }
      if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === ref.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    const node = ref.current;
    node?.addEventListener("keydown", handle);
    const shell =
      node?.getAttribute("aria-modal") === "true"
        ? document.querySelector<HTMLElement>(".space-shell")
        : null;
    const wasInert = shell?.inert ?? false;
    if (shell) shell.inert = true;
    return () => {
      if (shell) shell.inert = wasInert;
      node?.removeEventListener("keydown", handle);
      if (previous?.isConnected) previous.focus();
    };
  }, [ref]);
}
function ThresholdEditor({
  thresholds,
  onSave,
}: {
  thresholds: HealthThresholds;
  onSave: (next: HealthThresholds) => boolean;
}) {
  const [draft, setDraft] = useState(() => structuredClone(thresholds));
  const [message, setMessage] = useState("");
  const valid = validHealthThresholds(draft);
  return (
    <form
      className="health-panel health-thresholds"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) {
          setMessage(
            onSave(draft)
              ? "Thresholds saved for this account in this browser."
              : "Thresholds applied for this session. Browser storage is unavailable.",
          );
        }
      }}
    >
      <header className="health-section-heading">
        <div>
          <h2>Alert thresholds</h2>
          <p>
            Personal settings for this browser. Service readiness checks remain
            active.
          </p>
        </div>
        <Settings aria-hidden="true" />
      </header>
      <div className="health-table-scroll">
        <table>
          <thead>
            <tr>
              <th>Metric</th>
              <th>Warning</th>
              <th>Critical</th>
            </tr>
          </thead>
          <tbody>
            {thresholdDefinitions.map((d) => (
              <tr key={d.key}>
                <td>
                  <strong>{d.label}</strong>
                  <small>
                    {d.low
                      ? "Alert when at or below"
                      : "Alert when at or above"}{" "}
                    · {d.unit}
                  </small>
                </td>
                {(["warning", "critical"] as const).map((level) => (
                  <td key={level}>
                    <input
                      name={`health-${d.key}-${level}`}
                      aria-label={`${d.label} ${level}`}
                      type="number"
                      min={0}
                      max={d.max}
                      step="any"
                      required
                      value={
                        Number.isFinite(draft[d.key][level])
                          ? draft[d.key][level]
                          : ""
                      }
                      onChange={(e) => {
                        setMessage("");
                        setDraft((prev) => ({
                          ...prev,
                          [d.key]: {
                            ...prev[d.key],
                            [level]:
                              e.target.value === ""
                                ? Number.NaN
                                : Number(e.target.value),
                          },
                        }));
                      }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!valid && (
        <p className="health-error" role="status">
          Use non-negative values. Critical must be above warning, or below it
          for remaining account capacity.
        </p>
      )}
      <footer>
        <button
          type="button"
          onClick={() => {
            const defaults = structuredClone(defaultHealthThresholds);
            setDraft(defaults);
            setMessage(
              onSave(defaults)
                ? "Default thresholds restored."
                : "Defaults applied for this session. Browser storage is unavailable.",
            );
          }}
        >
          Restore defaults
        </button>
        <button type="submit" className="health-primary" disabled={!valid}>
          Save thresholds
        </button>
      </footer>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
const ACCOUNT_PROVIDER_FILTER_STORAGE_KEY = "space:health-accounts:provider-filter";
const ACCOUNT_QUOTA_FILTER_STORAGE_KEY = "space:health-accounts:quota-filter";
const ACCOUNT_PRO_FILTER_STORAGE_KEY = "space:health-accounts:pro-filter";
const ACCOUNT_GEMINI_FILTER_STORAGE_KEY = "space:health-accounts:gemini-filter";

function readStoredAccountProviderFilter(): "all" | "antigravity" | "codex" | "api" {
  try {
    const v = getSpaceRuntime().platform.localStorage.getItem(ACCOUNT_PROVIDER_FILTER_STORAGE_KEY);
    if (v === "all" || v === "antigravity" || v === "codex" || v === "api") return v;
  } catch {}
  return "all";
}

function readStoredAccountQuotaFilter(): boolean {
  try {
    return getSpaceRuntime().platform.localStorage.getItem(ACCOUNT_QUOTA_FILTER_STORAGE_KEY) === "true";
  } catch {}
  return false;
}

function readStoredAccountProFilter(): boolean {
  try {
    return getSpaceRuntime().platform.localStorage.getItem(ACCOUNT_PRO_FILTER_STORAGE_KEY) === "true";
  } catch {}
  return false;
}

function readStoredAccountGeminiFilter(): boolean {
  try {
    return getSpaceRuntime().platform.localStorage.getItem(ACCOUNT_GEMINI_FILTER_STORAGE_KEY) === "true";
  } catch {}
  return false;
}

function HealthDetailAnalysis({
  selected,
  telemetry,
  analyticsSessions,
  hostMemory,
  onReopenPane,
  onReopenAllDetached,
  onCloseSession,
  reopeningSessionId,
  reopeningAll,
  closingSessionId,
}: {
  selected: string;
  telemetry: HealthTelemetry;
  analyticsSessions: SystemAnalyticsCliSessionsResponse | null;
  hostMemory: HostMemoryDetails | null;
  onReopenPane: (roomId: string, paneId: string, sessionId: string) => void;
  onReopenAllDetached: () => void;
  onCloseSession?: (paneId: string, sessionId: string) => void;
  reopeningSessionId: string | null;
  reopeningAll: boolean;
  closingSessionId?: string | null;
}) {
  const [providerFilter, setProviderFilterState] = useState<"all" | "antigravity" | "codex" | "api">(readStoredAccountProviderFilter);
  const [quotaFilter, setQuotaFilterState] = useState<boolean>(readStoredAccountQuotaFilter);
  const [proFilter, setProFilterState] = useState<boolean>(readStoredAccountProFilter);
  const [geminiFilter, setGeminiFilterState] = useState<boolean>(readStoredAccountGeminiFilter);

  const setProviderFilter = useCallback((val: "all" | "antigravity" | "codex" | "api") => {
    setProviderFilterState(val);
    try {
      getSpaceRuntime().platform.localStorage.setItem(ACCOUNT_PROVIDER_FILTER_STORAGE_KEY, val);
    } catch {}
  }, []);

  const setQuotaFilter = useCallback((val: boolean) => {
    setQuotaFilterState(val);
    try {
      getSpaceRuntime().platform.localStorage.setItem(ACCOUNT_QUOTA_FILTER_STORAGE_KEY, String(val));
    } catch {}
  }, []);

  const setProFilter = useCallback((val: boolean) => {
    setProFilterState(val);
    try {
      getSpaceRuntime().platform.localStorage.setItem(ACCOUNT_PRO_FILTER_STORAGE_KEY, String(val));
    } catch {}
  }, []);

  const setGeminiFilter = useCallback((val: boolean) => {
    setGeminiFilterState(val);
    try {
      getSpaceRuntime().platform.localStorage.setItem(ACCOUNT_GEMINI_FILTER_STORAGE_KEY, String(val));
    } catch {}
  }, []);

  if (selected === "cli") {
    const detachedCount = telemetry.sessions?.summary.detached ?? 0;
    const detachedSessions = (analyticsSessions?.sessions ?? []).filter((s) => s.status === "RUNNING" && s.attachmentCount === 0);
    const hasDetached = detachedCount > 0 || detachedSessions.length > 0;
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Running</small><strong>{telemetry.sessions ? String(telemetry.sessions.summary.running) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Attached</small><strong>{telemetry.sessions ? String(telemetry.sessions.summary.attached) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Detached</small><strong>{telemetry.sessions ? String(telemetry.sessions.summary.detached) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Cleanup eligible</small><strong>{telemetry.sessions ? String(telemetry.sessions.summary.cleanupEligible) : "—"}</strong></div>
        </div>
        {hasDetached && (
          <div className="health-analysis-banner">
            <span>{detachedCount || detachedSessions.length} detached window{(detachedCount || detachedSessions.length) === 1 ? "" : "s"}</span>
            <button
              type="button"
              className="health-reopen-btn"
              disabled={reopeningAll}
              onClick={onReopenAllDetached}
            >
              {reopeningAll ? "Reopening…" : "Reopen detached"}
            </button>
          </div>
        )}
        {analyticsSessions && analyticsSessions.sessions.length > 0 && (
          <ul className="health-analysis-list">
            {analyticsSessions.sessions.slice(0, 8).map((session) => {
              const isDetached = session.status === "RUNNING" && session.attachmentCount === 0;
              const isBusy = reopeningSessionId === session.sessionId || closingSessionId === session.sessionId;
              return (
                <li key={session.sessionId}>
                  <div className="health-analysis-list-item-header">
                    <strong>{session.paneTitle} · {formatBytes(session.rssBytes)}</strong>
                    {isDetached && (
                      <div className="health-session-actions">
                        <button
                          type="button"
                          className="health-reopen-btn"
                          disabled={isBusy}
                          onClick={() => onReopenPane(session.roomId, session.paneId, session.sessionId)}
                          title={`Reopen window for ${session.paneTitle}`}
                        >
                          {reopeningSessionId === session.sessionId ? "Reopening…" : "Reopen"}
                        </button>
                        {onCloseSession && (
                          <button
                            type="button"
                            className="health-close-btn"
                            disabled={isBusy}
                            onClick={() => onCloseSession(session.paneId, session.sessionId)}
                            title={`Close and terminate ${session.paneTitle}`}
                          >
                            {closingSessionId === session.sessionId ? "Closing…" : "Close"}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                  <span>{session.roomName} · {session.runtimeName} · {session.attachmentCount} attachment{session.attachmentCount === 1 ? "" : "s"}{isDetached ? " · detached" : ""}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }

  if (selected === "memory") {
    const memData = hostMemory?.memory ?? telemetry.environment?.hostStats?.memory;
    const swapData = hostMemory?.swap ?? telemetry.environment?.hostStats?.swap;
    const topProcs = hostMemory?.topProcesses ?? [];
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Used RAM</small><strong>{memData && memData.usedBytes != null ? `${memData.usagePercent != null ? formatPercent(memData.usagePercent) + " · " : ""}${formatBytes(memData.usedBytes)}` : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Available RAM</small><strong>{hostMemory?.memory ? formatBytes(hostMemory.memory.availableBytes) : memData && memData.totalBytes != null && memData.usedBytes != null ? formatBytes(memData.totalBytes - memData.usedBytes) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Swap</small><strong>{swapData && swapData.usedBytes != null ? `${swapData.usagePercent != null ? formatPercent(swapData.usagePercent) + " · " : ""}${formatBytes(swapData.usedBytes)}` : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Pressure</small><strong>{hostMemory?.pressure.isUnderPressure ? "Under pressure" : "Normal"}</strong></div>
        </div>
        {topProcs.length > 0 && (
          <>
            <strong className="health-analysis-subtitle">Top memory processes</strong>
            <ul className="health-analysis-list">
              {topProcs.slice(0, 5).map((proc) => (
                <li key={proc.pid}>
                  <div className="health-analysis-list-item-header">
                    <strong>{proc.name}{proc.taskTitle ? ` · ${proc.taskTitle}` : ""}</strong>
                    <span>{formatBytes(proc.rssBytes)}</span>
                  </div>
                  <span>PID {proc.pid} · {proc.state}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  if (selected === "cpu") {
    const hostCpu = telemetry.environment?.hostStats?.cpu;
    const topCpuProcs = hostMemory?.topCpuProcesses ?? hostMemory?.topProcesses ?? [];
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Usage</small><strong>{formatPercent(hostCpu?.usagePercent)}</strong></div>
          <div className="health-analysis-stat"><small>Cores</small><strong>{hostCpu?.coreCount != null ? `${hostCpu.coreCount} cores` : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Load status</small><strong>{telemetry.toneFor("cpu") === "healthy" ? "Healthy" : "Elevated"}</strong></div>
          <div className="health-analysis-stat"><small>Host RAM</small><strong>{formatPercent(telemetry.environment?.hostStats?.memory?.usagePercent)}</strong></div>
        </div>
        {topCpuProcs.length > 0 && (
          <>
            <strong className="health-analysis-subtitle">Top CPU processes</strong>
            <ul className="health-analysis-list">
              {topCpuProcs.slice(0, 5).map((proc) => (
                <li key={`cpu:${proc.pid}`}>
                  <div className="health-analysis-list-item-header">
                    <strong>{proc.name}{proc.taskTitle ? ` · ${proc.taskTitle}` : ""}</strong>
                    <span>CPU {formatPercent(proc.cpuPercent)}</span>
                  </div>
                  <span>PID {proc.pid} · {formatBytes(proc.rssBytes)} · {proc.state}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    );
  }

  if (selected === "accounts") {
    const allRemaining = telemetry.environment?.lbUsage?.allAccountsRemainingPercent;
    const activeRemaining = telemetry.environment?.lbUsage?.activeAccountsRemainingPercent;
    const antiAccounts = telemetry.antigravityAccounts?.data ?? [];
    const codexAccounts = telemetry.accounts?.data ?? [];

    const isGroupActive = (group: AntigravityUsageGroup | undefined) => {
      if (!group) return false;
      const week = group.weeklyRemainingPercent;
      const fiveH = group.fiveHourRemainingPercent;
      const weekOk = week != null && week >= 1;
      const fiveHOk = fiveH == null || fiveH >= 1;
      return weekOk && fiveHOk;
    };

    const isAntiAccountActive = (acc: AntigravityUsageAccount) =>
      isGroupActive(acc.gemini) || isGroupActive(acc.claude);

    const isCodexAccountActive = (acc: CodexUsageAccount) => {
      const week = acc.weeklyRemainingPercent;
      const fiveH = acc.fiveHourRemainingPercent;
      const weekOk = week != null && week >= 1;
      const fiveHOk = fiveH == null || fiveH >= 1;
      return weekOk && fiveHOk;
    };

    const isProAntiAccount = (acc: AntigravityUsageAccount) =>
      Boolean(acc.tier && acc.tier.toLowerCase().includes("pro"));

    const isProCodexAccount = (acc: CodexUsageAccount) =>
      Boolean(acc.planType && acc.planType.toLowerCase().includes("pro"));

    const hasGeminiGroup = (acc: AntigravityUsageAccount) =>
      quotaFilter ? isGroupActive(acc.gemini) : Boolean(acc.gemini && (acc.gemini.weeklyRemainingPercent != null || acc.gemini.fiveHourRemainingPercent != null));

    const antiVisible = antiAccounts
      .filter((acc) => !quotaFilter || (geminiFilter ? isGroupActive(acc.gemini) : isAntiAccountActive(acc)))
      .filter((acc) => !proFilter || isProAntiAccount(acc))
      .filter((acc) => !geminiFilter || hasGeminiGroup(acc));

    const codexVisible = codexAccounts
      .filter((acc) => !quotaFilter || isCodexAccountActive(acc));

    const showAntigravity = providerFilter === "all" || providerFilter === "antigravity";
    const showCodex = providerFilter === "all" || providerFilter === "codex";
    const showApi = providerFilter === "all" || providerFilter === "api";

    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>All accounts</small><strong>{formatPercent(allRemaining)}</strong></div>
          <div className="health-analysis-stat"><small>Active accounts</small><strong>{formatPercent(activeRemaining)}</strong></div>
        </div>

        <div className="health-accounts-filter-bar">
          <div className="health-provider-filters" role="tablist" aria-label="Provider filter">
            <button
              type="button"
              role="tab"
              aria-selected={providerFilter === "all"}
              className={`health-filter-btn ${providerFilter === "all" ? "is-active" : ""}`}
              onClick={() => setProviderFilter("all")}
            >
              All
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={providerFilter === "antigravity"}
              className={`health-filter-btn ${providerFilter === "antigravity" ? "is-active" : ""}`}
              onClick={() => setProviderFilter("antigravity")}
            >
              Antigravity
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={providerFilter === "codex"}
              className={`health-filter-btn ${providerFilter === "codex" ? "is-active" : ""}`}
              onClick={() => setProviderFilter("codex")}
            >
              Codex
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={providerFilter === "api"}
              className={`health-filter-btn ${providerFilter === "api" ? "is-active" : ""}`}
              onClick={() => setProviderFilter("api")}
            >
              API Providers
            </button>
          </div>
          <button
            type="button"
            className={`health-quota-filter-btn ${quotaFilter ? "is-active" : ""}`}
            onClick={() => setQuotaFilter(!quotaFilter)}
            title="Filter accounts with 5h > 1% and week > 1%"
          >
            <span className="health-quota-filter-indicator" />
            5h &amp; week &gt; 1%
          </button>
          {providerFilter === "antigravity" && (
            <>
              <button
                type="button"
                className={`health-quota-filter-btn ${proFilter ? "is-active" : ""}`}
                onClick={() => setProFilter(!proFilter)}
                title="Filter pro accounts only"
              >
                <span className="health-quota-filter-indicator" />
                Pro accounts
              </button>
              <button
                type="button"
                className={`health-quota-filter-btn ${geminiFilter ? "is-active" : ""}`}
                onClick={() => setGeminiFilter(!geminiFilter)}
                title="Filter accounts with Gemini and hide Claude"
              >
                <span className="health-quota-filter-indicator" />
                Gemini only
              </button>
            </>
          )}
        </div>

        {showAntigravity && (
          <>
            <strong className="health-analysis-subtitle">Antigravity (Google)</strong>
            {antiVisible.length > 0 ? (
              <ul className="health-analysis-list is-grid-2">
                {antiVisible.map((acc) => {
                  const geminiActive = isGroupActive(acc.gemini);
                  const claudeActive = isGroupActive(acc.claude);
                  const showGemini = geminiFilter ? Boolean(acc.gemini) : (geminiActive || (!quotaFilter && !claudeActive));
                  const showClaude = !geminiFilter && (claudeActive || (!quotaFilter && !geminiActive));
                  const geminiCountdown = getReactivationCountdown(acc.gemini, telemetry.clock);
                  const claudeCountdown = getReactivationCountdown(acc.claude, telemetry.clock);

                  return (
                    <li key={acc.id}>
                      <div className="health-analysis-list-item-header">
                        <strong title={acc.label || acc.email || ""}>{acc.label || acc.email}</strong>
                        <span>{acc.status?.toLowerCase() === "critical" ? "Unavailable" : acc.status}</span>
                      </div>
                      {showGemini && (
                        <>
                          <span>Gemini: 5h {formatPercent(acc.gemini?.fiveHourRemainingPercent)} · week {formatPercent(acc.gemini?.weeklyRemainingPercent)}</span>
                          {geminiCountdown && (
                            <small className="health-account-countdown">{geminiCountdown}</small>
                          )}
                        </>
                      )}
                      {showClaude && (
                        <>
                          <span>Claude: 5h {formatPercent(acc.claude?.fiveHourRemainingPercent)} · week {formatPercent(acc.claude?.weeklyRemainingPercent)}</span>
                          {claudeCountdown && (
                            <small className="health-account-countdown">{claudeCountdown}</small>
                          )}
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="health-analysis-empty">No Antigravity accounts match filter.</p>
            )}
          </>
        )}

        {showCodex && (
          <>
            <strong className="health-analysis-subtitle">Codex usage</strong>
            {codexVisible.length > 0 ? (
              <ul className="health-analysis-list is-grid-2">
                {codexVisible.map((acc) => {
                  const codexCountdown = getReactivationCountdown(acc, telemetry.clock);
                  return (
                    <li key={acc.id}>
                      <div className="health-analysis-list-item-header">
                        <strong title={acc.label}>{acc.label}</strong>
                        <span>CONNECTED</span>
                      </div>
                      <span>
                        Codex: 5h {formatPercent(acc.fiveHourRemainingPercent)} · week {formatPercent(acc.weeklyRemainingPercent)}
                      </span>
                      {codexCountdown && (
                        <small className="health-account-countdown">{codexCountdown}</small>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="health-analysis-empty">No Codex accounts match filter.</p>
            )}
          </>
        )}

        {showApi && (
          <>
            <strong className="health-analysis-subtitle">API Providers (DeepSeek, OpenRouter, Vercel, Google, etc.)</strong>
            {(telemetry.apiProviderAccounts?.data?.length ?? 0) > 0 ? (
              <ul className="health-analysis-list is-grid-2">
                {telemetry.apiProviderAccounts?.data.map((acc) => (
                  <li key={acc.id}>
                    <div className="health-analysis-list-item-header">
                      <strong title={acc.label}>{acc.label}</strong>
                      <span
                        className={`health-badge ${
                          acc.status === "CONNECTED"
                            ? "is-tier"
                            : acc.status === "EXHAUSTED"
                              ? "is-warning"
                              : "is-critical"
                        }`}
                      >
                        {acc.balance ?? (acc.status?.toLowerCase() === "critical" ? "Unavailable" : acc.status)}
                      </span>
                    </div>
                    <span>{acc.detail ?? acc.providerId}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="health-analysis-empty">No API providers found.</p>
            )}
          </>
        )}
      </div>
    );
  }

  if (selected === "codex-reset") {
    const cooldown = computeCodexCooldown(telemetry.accounts, telemetry.environment, telemetry.clock);
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Time to reset</small><strong>{cooldown?.formatted ?? "—"}</strong></div>
          <div className="health-analysis-stat"><small>Account</small><strong>{cooldown?.accountLabel ?? "Earliest"}</strong></div>
        </div>
        {cooldown?.resetAt && (
          <div className="health-analysis-banner">
            <span>Resets at {formatAppTime(cooldown.resetAt, { hour: "2-digit", minute: "2-digit" })}</span>
          </div>
        )}
      </div>
    );
  }

  if (selected === "rtt") {
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Latency</small><strong>{telemetry.rtt?.value != null ? `${telemetry.rtt.value} ms` : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Status</small><strong>{telemetry.rtt?.failed ? "Unavailable" : (telemetry.rtt?.value ?? 0) >= 425 ? "Alert" : (telemetry.rtt?.value ?? 0) >= 300 ? "Warning" : "Good"}</strong></div>
          <div className="health-analysis-stat"><small>Target</small><strong>Browser → API</strong></div>
          <div className="health-analysis-stat"><small>Refresh</small><strong>Every 2–10 sec</strong></div>
        </div>
      </div>
    );
  }

  if (selected === "models") {
    const modelList = telemetry.models?.models ?? [];
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Models</small><strong>{String(modelList.length)}</strong></div>
          <div className="health-analysis-stat"><small>Providers</small><strong>{telemetry.models ? String(telemetry.models.providers.length) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Active sessions</small><strong>{telemetry.models ? String(modelList.reduce((sum, m) => sum + m.activeSessions, 0)) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Window</small><strong>Last 10 min</strong></div>
        </div>
        {modelList.length > 0 && (
          <ul className="health-analysis-list">
            {modelList.slice(0, 6).map((m) => (
              <li key={`${m.providerId}:${m.modelId}`}>
                <div className="health-analysis-list-item-header">
                  <strong>{m.modelId}</strong>
                  <span>{m.providerId}</span>
                </div>
                <span>{m.activeSessions} session{m.activeSessions === 1 ? "" : "s"} · {m.completedTurns} completed / {m.activeTurns} active</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  if (selected === "provider") {
    const prov = telemetry.snapshot?.services.find((s) => s.id === "provider");
    const lb = telemetry.environment?.lbUsage;
    const snapshot = getToolbarMetricsSnapshot(telemetry.environment);
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Active route</small><strong>{prov?.label ?? snapshot.provider}</strong></div>
          <div className="health-analysis-stat"><small>Status</small><strong>{prov?.status ? prov.status.toUpperCase() : "OK"}</strong></div>
          <div className="health-analysis-stat"><small>Upstream</small><strong>{lb?.upstream ?? "Direct"}</strong></div>
          <div className="health-analysis-stat"><small>Mode</small><strong>{lb?.routeMode ?? "Default"}</strong></div>
        </div>
      </div>
    );
  }

  if (selected === "swap") {
    const swap = telemetry.environment?.hostStats?.swap;
    const swapMetric = telemetry.metrics.find((m) => m.id === "swap");
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Usage</small><strong>{formatHealthValue(swapMetric?.value, "PERCENT")}</strong></div>
          <div className="health-analysis-stat"><small>Used</small><strong>{swap && swap.usedBytes != null ? formatBytes(swap.usedBytes) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Total</small><strong>{swap && swap.totalBytes != null ? formatBytes(swap.totalBytes) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Free</small><strong>{swap && swap.totalBytes != null && swap.usedBytes != null ? formatBytes(Math.max(0, swap.totalBytes - swap.usedBytes)) : "—"}</strong></div>
        </div>
      </div>
    );
  }

  if (selected === "disk-app") {
    const diskAppMetric = telemetry.metrics.find((m) => m.id === "disk-app");
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Space disk</small><strong>{formatHealthValue(diskAppMetric?.value, "PERCENT")}</strong></div>
          <div className="health-analysis-stat"><small>Mount</small><strong>/opt/spaceapp</strong></div>
          <div className="health-analysis-stat"><small>Total</small><strong>{diskAppMetric?.total ? formatBytes(diskAppMetric.total) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Used</small><strong>{diskAppMetric?.value != null && diskAppMetric.total ? formatBytes(diskAppMetric.total * (diskAppMetric.value / 100)) : "—"}</strong></div>
        </div>
      </div>
    );
  }

  if (selected === "disk-root") {
    const diskRootMetric = telemetry.metrics.find((m) => m.id === "disk-root");
    return (
      <div className="health-analysis-section">
        <div className="health-analysis-grid">
          <div className="health-analysis-stat"><small>Root disk</small><strong>{formatHealthValue(diskRootMetric?.value, "PERCENT")}</strong></div>
          <div className="health-analysis-stat"><small>Mount</small><strong>/</strong></div>
          <div className="health-analysis-stat"><small>Total</small><strong>{diskRootMetric?.total ? formatBytes(diskRootMetric.total) : "—"}</strong></div>
          <div className="health-analysis-stat"><small>Used</small><strong>{diskRootMetric?.value != null && diskRootMetric.total ? formatBytes(diskRootMetric.total * (diskRootMetric.value / 100)) : "—"}</strong></div>
        </div>
      </div>
    );
  }

  return null;
}

function HealthResources({
  telemetry,
  selected,
  onSelect,
  onClose,
  onOpen,
  onReopenPane,
  onReopenAllDetached,
  onCloseSession,
}: {
  telemetry: HealthTelemetry;
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpen: (id?: string) => void;
  onReopenPane?: (roomId: string, paneId: string) => Promise<void> | void;
  onReopenAllDetached?: () => Promise<void> | void;
  onCloseSession?: (paneId: string) => Promise<void> | void;
}) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  useLayoutEffect(() => {
    dispatchRailMenuChange();
    return () => {
      dispatchRailMenuChange();
    };
  }, []);
  const [analyticsSessions, setAnalyticsSessions] = useState<SystemAnalyticsCliSessionsResponse | null>(null);
  const [hostMemory, setHostMemory] = useState<HostMemoryDetails | null>(null);
  const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null);
  const [reopeningAll, setReopeningAll] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);

  const refreshSessions = () => {
    api.systemAnalyticsCliSessions?.("10m")?.then(setAnalyticsSessions).catch(() => null);
  };

  useEffect(() => {
    if (selected === "cli") {
      refreshSessions();
    }
    if (selected === "memory" || selected === "cpu") {
      api.toolbarHostMemory?.()?.then(setHostMemory).catch(() => null);
    }
  }, [selected]);

  const handleReopen = async (roomId: string, paneId: string, sessionId: string) => {
    setReopeningSessionId(sessionId);
    try {
      if (onReopenPane) {
        await onReopenPane(roomId, paneId);
      } else {
        await api.updatePane?.(paneId, { isClosed: false, isMinimized: false, status: "IDLE" });
      }
      onClose();
    } catch {
      // ignore
    } finally {
      setReopeningSessionId(null);
    }
  };

  const handleReopenAll = async () => {
    setReopeningAll(true);
    try {
      if (onReopenAllDetached) {
        await onReopenAllDetached();
      } else {
        const detached = analyticsSessions?.sessions.filter((s) => s.status === "RUNNING" && s.attachmentCount === 0) ?? [];
        for (const s of detached) {
          await api.updatePane?.(s.paneId, { isClosed: false, isMinimized: false, status: "IDLE" }).catch(() => null);
        }
      }
      onClose();
    } catch {
      // ignore
    } finally {
      setReopeningAll(false);
    }
  };

  const handleCloseSession = async (paneId: string, sessionId: string) => {
    setClosingSessionId(sessionId);
    try {
      if (onCloseSession) {
        await onCloseSession(paneId);
      } else {
        await api.closePane?.(paneId);
      }
      // Refresh sessions list after closing
      refreshSessions();
    } catch {
      // ignore
    } finally {
      setClosingSessionId(null);
    }
  };

  const metrics = summaryMetrics(telemetry);
  for (const id of ["swap", "disk-app", "disk-root"]) {
    const m = telemetry.metrics.find((m) => m.id === id);
    metrics.push({
      id,
      label:
        m?.label ??
        (id === "swap"
          ? "Swap"
          : id === "disk-app"
            ? "Space disk"
            : "Root disk"),
      icon: id === "swap" ? Database : HardDrive,
      value: formatHealthValue(m?.value, "PERCENT"),
      tone: telemetry.toneFor(id),
      detail: m?.detail ?? "Waiting for telemetry",
      at: m?.sampledAt,
    });
  }
  const item = metrics.find((m) => m.id === selected);
  return (
    <aside
      ref={ref}
      tabIndex={-1}
      className="health-resources"
      role="dialog"
      aria-label="Resources"
    >
      <header className="health-window-header">
        <Activity aria-hidden="true" />
        <div className="health-window-heading">
          <h2>Resources</h2>
          <p>Your system at a glance</p>
        </div>
        <button type="button" aria-label="Close Resources" onClick={onClose}>
          <X />
        </button>
      </header>
      <div className="health-resources-body">
        <div className="health-resource-grid">
          {metrics.map((m) => (
            <MetricCard
              key={m.id}
              item={m}
              telemetry={telemetry}
              onClick={() => onSelect(m.id)}
              selected={m.id === selected}
            />
          ))}
        </div>
        {item && (
          <section className="health-resource-detail">
            <div>
              <strong>{item.label}</strong>
              <StatusBadge tone={item.tone} />
            </div>
            <p>{item.detail}</p>
            <HealthDetailAnalysis
              selected={selected}
              telemetry={telemetry}
              analyticsSessions={analyticsSessions}
              hostMemory={hostMemory}
              onReopenPane={handleReopen}
              onReopenAllDetached={handleReopenAll}
              onCloseSession={handleCloseSession}
              reopeningSessionId={reopeningSessionId}
              reopeningAll={reopeningAll}
              closingSessionId={closingSessionId}
            />
            <small>
              {item.at
                ? `Updated ${formatAppTime(item.at)}`
                : "Waiting for first sample"}
            </small>
            <button
              type="button"
              className="health-primary"
              onClick={() => onOpen(item.id)}
            >
              Open details <ArrowUp aria-hidden="true" />
            </button>
          </section>
        )}
        {telemetry.error && (
          <p className="health-error" role="status">
            Telemetry could not be refreshed.
          </p>
        )}
      </div>
      <footer>
        <button
          type="button"
          className="health-primary"
          onClick={() => onOpen()}
        >
          Open Health <Activity aria-hidden="true" />
        </button>
        <span>Updates every 10 seconds</span>
      </footer>
    </aside>
  );
}
function HealthVersionCard() {
  const version = useAppVersion();
  return (
    <article className="health-service-card">
      <header>
        <Activity aria-hidden="true" />
        <StatusBadge
          tone={
            version?.updateAvailable
              ? "warning"
              : version
                ? "healthy"
                : "unavailable"
          }
        />
      </header>
      <h3>Version</h3>
      <p>{version?.appRelease ?? "Loading version…"}</p>
      <dl>
        <div>
          <dt>Build</dt>
          <dd>{version?.athensTag ?? version?.shortCommit ?? "—"}</dd>
        </div>
      </dl>
      <small>
        {version?.updateAvailable
          ? `Update available: ${version.githubLatest}`
          : version?.checkedAt
            ? "Up to date"
            : "Version check pending"}
      </small>
    </article>
  );
}
function HealthWindow({
  telemetry,
  section,
  onSection,
  selected,
  onSelect,
  onClose,
  thresholds,
  onThresholds,
  onManage,
  allowChanges = true,
  onReopenPane, onReopenAllDetached, onCloseSession,
}: {
  onReopenPane?: (roomId: string, paneId: string) => Promise<void> | void;
  onReopenAllDetached?: () => Promise<void> | void;
  onCloseSession?: (paneId: string) => Promise<void> | void;
  telemetry: HealthTelemetry;
  section: HealthSection;
  onSection: (section: HealthSection) => void;
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  thresholds: HealthThresholds;
  onThresholds: (thresholds: HealthThresholds) => boolean;
  allowChanges?: boolean;
  onManage?: (id: "accounts" | "provider" | "cli") => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  const [maximized, setMaximized] = useState(false);
  const [range, setRange] = useState<SystemHealthRange>("1m");
  const [retained, setRetained] = useState<SystemHealthHistory | null>(null);
  const [historyError, setHistoryError] = useState(false);
  useEffect(() => {
    if (range === "1m" || (section !== "performance" && section !== "overview"))
      return;
    let disposed = false,
      inFlight = false;
    setRetained(null);
    const load = async () => {
      if (inFlight || disposed || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const result = await api.systemHealthHistory(range);
        if (!disposed) {
          setRetained(result);
          setHistoryError(false);
        }
      } catch {
        if (!disposed) setHistoryError(true);
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    document.addEventListener("visibilitychange", load);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", load);
    };
  }, [range, section]);
  // Extended per-device (disk I/O, device busy) and per-interface (rx/tx/utilization) metrics.
  // Disabled per user preference to keep only basic metrics (CPU, Memory, Swap, Root disk, Space disk) in the Performance view,
  // while preserving the underlying logic and code structure.
  const ENABLE_EXTENDED_DEVICE_METRICS = false;
  const isExtendedDeviceMetric = (id: string) =>
    id.startsWith("disk:") ||
    id.startsWith("network:") ||
    id === "disk-telemetry" ||
    id === "network-telemetry";

  const summary = summaryMetrics(telemetry);
  const services = telemetry.snapshot?.services ?? [];
  const signals = telemetry.metrics.filter(
    (m) =>
      !(m.id === "swap" && m.detail === "No swap configured") &&
      (ENABLE_EXTENDED_DEVICE_METRICS || !isExtendedDeviceMetric(m.id)),
  );
  const issues = [
    ...signals
      .filter((m) => ["warning", "critical"].includes(telemetry.toneFor(m.id)))
      .map((m) => ({
        id: m.id,
        label: m.label,
        detail: `${formatHealthValue(m.value, m.unit)} · ${m.detail}`,
        tone: telemetry.toneFor(m.id),
        since: telemetry.states.get(m.id)?.since ?? m.sampledAt,
      })),
    ...services
      .filter((s) =>
        ["warning", "critical"].includes(serviceTone(s, telemetry.clock)),
      )
      .map((s) => ({
        id: s.id,
        label: s.label,
        detail: s.detail,
        tone: serviceTone(s, telemetry.clock),
        since: s.checkedAt,
      })),
  ];
  const unavailable = [
    ...telemetry.metrics
      .filter(
        (m) =>
          ["stale", "unavailable"].includes(telemetry.toneFor(m.id)) &&
          !(m.id === "swap" && m.detail === "No swap configured") &&
          (ENABLE_EXTENDED_DEVICE_METRICS || !isExtendedDeviceMetric(m.id)),
      )
      .map((m) => m.label),
    ...services
      .filter((s) =>
        ["stale", "unavailable"].includes(serviceTone(s, telemetry.clock)),
      )
      .map((s) => s.label),
  ];
  const performanceMetrics = telemetry.metrics.filter((m) => {
    if (m.id === "accounts") return false;
    if (!ENABLE_EXTENDED_DEVICE_METRICS && isExtendedDeviceMetric(m.id)) {
      return false;
    }
    return true;
  });
  const metric =
    performanceMetrics.find((m) => m.id === selected) ??
    performanceMetrics.find((m) => m.id === "cpu");

  useEffect(() => {
    if (metric?.id === "rtt" && !["1m", "10m"].includes(range)) {
      setRange("10m");
    }
  }, [metric?.id, range]);

  const chartIds =
    metric?.id.endsWith(":rx") || metric?.id.endsWith(":tx")
      ? [`${metric.id.slice(0, -3)}:rx`, `${metric.id.slice(0, -3)}:tx`]
      : metric?.id.endsWith(":read") || metric?.id.endsWith(":write")
        ? [
            `${metric.id.replace(/:(read|write)$/, "")}:read`,
            `${metric.id.replace(/:(read|write)$/, "")}:write`,
          ]
        : [metric?.id];
  const series =
    range === "1m"
      ? telemetry.history
      : retained?.range === range
        ? retained.series
        : [];
  const issueList = (
    <div className="health-issue-list">
      {issues.length ? (
        issues.map((i) => (
          <button
            type="button"
            key={i.id}
            className={`health-issue is-${i.tone}`}
            onClick={() => {
              onSection(
                services.some((s) => s.id === i.id)
                  ? "services"
                  : "performance",
              );
              onSelect(i.id);
            }}
          >
            <AlertTriangle aria-hidden="true" />
            <span>
              <strong>{i.label}</strong>
              <small>{i.detail}</small>
              <small>Since {formatAppTime(i.since)}</small>
            </span>
            <StatusBadge tone={i.tone} />
          </button>
        ))
      ) : (
        <div className="health-empty">
          <Check aria-hidden="true" />
          No active threshold or service alerts.
        </div>
      )}
      {!!unavailable.length && (
        <p className="health-coverage">
          Incomplete coverage: {unavailable.join(", ")}. Unavailable
          measurements do not indicate a healthy system.
        </p>
      )}
    </div>
  );
  return (
    <div
      className="health-modal-backdrop"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        className={`health-window resources-unified${maximized ? " is-maximized" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Resources"
      >
        <header className="health-window-header">
          <span className="health-brand-icon">
            <Activity aria-hidden="true" />
          </span>
          <div className="health-window-heading">
            <h1>Resources</h1>
            <p>{section === "overview" ? "Your Space at a glance" : "Details & history"}</p>
          </div>
          <div className="health-window-actions">
            <button
              type="button"
              className={`health-maximize-toggle dock-fullscreen-toggle${maximized ? " is-active" : ""}`}
              title={maximized ? "Collapse Resources" : "Expand Resources"}
              aria-label={maximized ? "Collapse Resources" : "Expand Resources"}
              aria-pressed={maximized}
              onClick={() => setMaximized((v) => !v)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </button>
            <button type="button" className="health-window-close-btn" aria-label="Close Resources" onClick={onClose}>
              <X />
            </button>
          </div>
        </header>
        <div className="health-window-layout">
          {section !== "overview" && <nav className="resources-detail-navigation" aria-label="Resource details">
            <button type="button" onClick={() => onSection("overview")}>← Back</button>
            <select className="resources-detail-select" aria-label="Resource view" value={section} onChange={e => onSection(e.target.value as HealthSection)}>
              <optgroup label="AI usage"><option value="ai">Accounts & quotas</option><option value="usage">Token usage</option><option value="models">Models</option><option value="provider">Provider routing</option></optgroup>
              <optgroup label="Sessions"><option value="sessions">CLI sessions</option></optgroup>
              <optgroup label="System"><option value="performance">Performance</option><option value="processes">Processes</option><option value="topology">Topology</option><option value="services">Service readiness</option><option value="analytics">Analytics & benchmarks</option></optgroup>
              <optgroup label="Connection"><option value="connection">Connection & API</option><option value="alerts">Alerts & thresholds</option></optgroup>
            </select>
          </nav>}
          <main className="health-main">
            {telemetry.error && (
              <div className="health-error" role="status">
                Live telemetry could not be refreshed. Last known values are
                shown with their update time.
              </div>
            )}
            {section === "overview" && <div className="resources-summary">
              {[
                { label: "AI usage", section: "ai", icon: Wallet, value: summary.find(m => m.id === "accounts")?.value ?? "—", detail: "Routing capacity · accounts, quotas & tokens" },
                { label: "Sessions", section: "sessions", icon: Terminal, value: summary.find(m => m.id === "cli")?.value ?? "—", detail: "Running CLI sessions" },
                { label: "System", section: "performance", icon: Cpu, value: `CPU ${summary.find(m => m.id === "cpu")?.value ?? "—"} · RAM ${summary.find(m => m.id === "memory")?.value ?? "—"}`, detail: "Performance, storage & services" },
                { label: "Connection", section: "connection", icon: Network, value: summary.find(m => m.id === "rtt")?.value ?? "—", detail: "Latency & API traffic" }
              ].map(item => <button type="button" className="resources-summary-row" key={item.section} onClick={() => onSection(item.section as HealthSection)}>
                <span className="resources-summary-icon"><item.icon aria-hidden="true" /></span>
                <span className="resources-summary-info"><strong>{item.label}</strong><small>{item.detail}</small></span>
                <b className="resources-summary-value">{item.value}</b>
              </button>)}
              <button type="button" className="resources-alert-summary" onClick={() => onSection("alerts")}>
                {issues.length ? `${issues.length} alerts need attention` : unavailable.length ? "Some measurements are unavailable" : "Alerts & thresholds"}
              </button>
            </div>}
            {section === "connection" && <section className="health-panel">
              <h2>Connection & API</h2>
              <div className="health-detail-facts">
                <div><small>Round-trip latency</small><strong>{summary.find(m => m.id === "rtt")?.value ?? "—"}</strong></div>
                <div><small>Requests · 5 minutes</small><strong>{telemetry.snapshot?.requests.requestCount ?? "—"}</strong></div>
                <div><small>HTTP 5xx errors</small><strong>{telemetry.snapshot?.requests.errorCount ?? "—"}</strong></div>
                <div><small>API p95</small><strong>{formatHealthValue(telemetry.snapshot?.requests.p95Ms, "MILLISECONDS")}</strong></div>
              </div>
              <div className="health-detail-actions">
                <button type="button" onClick={() => { onSelect("rtt"); onSection("performance"); }}>Latency history</button>
                <button type="button" onClick={() => onSection("services")}>Connection status</button>
              </div>
            </section>}
            {["ai", "sessions", "provider", "models"].includes(section) && <ToolbarMetrics
              presentation="embedded" allowChanges={allowChanges} sharedTelemetry={telemetry} initialPanel={section === "ai" ? "accounts" : section === "sessions" ? "cli" : section === "provider" ? "provider" : "models"}
              environment={telemetry.environment} onReopenPane={onReopenPane} onReopenAllDetached={onReopenAllDetached} onCloseSession={onCloseSession}
              onOpenAnalytics={tab => { onSelect(tab); onSection("analytics"); }}
            />}
            {section === "analytics" && <Suspense fallback={<p role="status">Loading analytics…</p>}>
              <TokenUsageWorkspace shellMode="desktop" initialTab={["overview", "models", "resources", "sessions", "bench"].includes(selected) ? selected as "overview" | "models" | "resources" | "sessions" | "bench" : "overview"} onClose={() => onSection("overview")} />
            </Suspense>}
            {section === "performance" && (
              <div className="health-performance-layout">
                <nav
                  className="health-performance-list"
                  aria-label="Performance metrics"
                >
                  {performanceMetrics
                    .filter(
                      (m) =>
                        ![
                          "memory-used",
                          "memory-available",
                          "swap-used",
                        ].includes(m.id) && !m.id.endsWith("-free"),
                    )
                    .map((m) => {
                      const Icon = groupIcons[m.group];
                      return (
                        <button
                          type="button"
                          key={m.id}
                          aria-pressed={metric?.id === m.id}
                          onClick={() => onSelect(m.id)}
                        >
                          <Icon aria-hidden="true" />
                          <span>
                            <strong>{m.label}</strong>
                            <small>{formatHealthValue(m.value, m.unit)}</small>
                          </span>
                          <i
                            className={`health-dot is-${telemetry.toneFor(m.id)}`}
                          />
                          <HealthChart
                            compact
                            series={telemetry.history.filter(
                              (s) => s.id === m.id,
                            )}
                            percent={m.unit === "PERCENT"}
                            rangeSeconds={60}
                            endAt={new Date(telemetry.clock).toISOString()}
                          />
                        </button>
                      );
                    })}
                </nav>
                <section className="health-performance-detail">
                  {metric ? (
                    <>
                      <header className="health-section-heading">
                        <div>
                          <span className="health-eyebrow">PERFORMANCE</span>
                          <h2>{metric.label}</h2>
                          <p>{metric.detail}</p>
                        </div>
                        <div className="health-large-value">
                          <strong>
                            {formatHealthValue(metric.value, metric.unit)}
                          </strong>
                          <StatusBadge tone={telemetry.toneFor(metric.id)} />
                        </div>
                      </header>
                      <div
                        className="health-range-controls"
                        aria-label="History range"
                      >
                        {(Object.keys(rangeLabels) as SystemHealthRange[]).map(
                          (r) => {
                            const isUnsupported =
                              metric.id === "rtt" &&
                              !["1m", "10m"].includes(r);
                            return (
                              <button
                                type="button"
                                key={r}
                                disabled={isUnsupported}
                                aria-pressed={range === r && !isUnsupported}
                                title={
                                  isUnsupported
                                    ? "Connection latency is measured in this browser session and retains up to 10 minutes."
                                    : undefined
                                }
                                onClick={() => setRange(r)}
                              >
                                {rangeLabels[r]}
                              </button>
                            );
                          },
                        )}
                      </div>
                      {historyError && range !== "1m" && (
                        <p className="health-error">
                          Retained history is temporarily unavailable.
                        </p>
                      )}
                      {metric.id === "rtt" && range !== "1m" && (
                        <p className="health-coverage">
                          Connection history is local to this browser session
                          and retains up to 10 minutes.
                        </p>
                      )}
                      <HealthChart
                        series={(metric.id === "rtt"
                          ? telemetry.history
                          : series
                        ).filter((s) => chartIds.includes(s.id))}
                        percent={metric.unit === "PERCENT"}
                        rangeSeconds={
                          metric.id === "rtt"
                            ? Math.min(600, rangeSeconds[range])
                            : rangeSeconds[range]
                        }
                        endAt={new Date(telemetry.clock).toISOString()}
                      />
                      <div className="health-detail-facts">
                        {performanceMetrics
                          .filter((m) => m.group === metric.group)
                          .map((m) => (
                            <div key={m.id}>
                              <small>{m.label}</small>
                              <strong>
                                {formatHealthValue(m.value, m.unit)}
                              </strong>
                              {m.total != null && m.unit === "BYTES" && (
                                <span>
                                  of {formatHealthValue(m.total, m.unit)}
                                </span>
                              )}
                              <StatusBadge tone={telemetry.toneFor(m.id)} />
                            </div>
                          ))}
                      </div>
                      <p className="health-updated">
                        Updated{" "}
                        {formatAppTime(metric.sampledAt)} · Live
                        samples every 2 seconds
                      </p>
                    </>
                  ) : (
                    <p className="health-empty">
                      Waiting for performance telemetry…
                    </p>
                  )}
                </section>
              </div>
            )}
            {section === "topology" && (
              <RecoverableSurface fallback={<p className="health-empty" role="status">Loading topology…</p>}>
                <SystemTopologyMap />
              </RecoverableSurface>
            )}
            {section === "processes" && (
              <HealthProcessTable thresholds={thresholds} />
            )}
            {section === "services" && (
              <div className="health-stack">
                <header className="health-section-heading">
                  <div>
                    <span className="health-eyebrow">SERVICE READINESS</span>
                    <h2>Services & infrastructure</h2>
                    <p>Independent checks refresh every 10 seconds.</p>
                  </div>
                </header>
                <div className="health-services-grid">
                  {services.map((s) => (
                    <article
                      className={`health-service-card is-${serviceTone(s, telemetry.clock)}`}
                      key={s.id}
                    >
                      <header>
                        <ServerCog aria-hidden="true" />
                        <StatusBadge tone={serviceTone(s, telemetry.clock)} />
                      </header>
                      <h3>{s.label}</h3>
                      <p>{s.detail}</p>
                      <dl>
                        {s.values.map((v) => (
                          <div key={v.label}>
                            <dt>{v.label}</dt>
                            <dd>{v.value}</dd>
                          </div>
                        ))}
                      </dl>
                      <small>
                        Checked {formatAppTime(s.checkedAt)}
                      </small>
                    </article>
                  ))}
                  <HealthVersionCard />
                </div>
              </div>
            )}
            {section === "usage" && (
              <Suspense fallback={<p role="status">Loading token usage…</p>}>
                <TokenUsageWorkspace shellMode="desktop" initialTab="models" modelsOnly onClose={onClose} />
              </Suspense>
            )}
            {section === "alerts" && (
              <div className="health-stack">
                <section className="health-panel">
                  <header className="health-section-heading">
                    <div>
                      <h2>Active alerts</h2>
                      <p>
                        Threshold changes require two consecutive samples.
                        Service failures appear immediately.
                      </p>
                    </div>
                  </header>
                  {issueList}
                </section>
                <ThresholdEditor
                  thresholds={thresholds}
                  onSave={onThresholds}
                />
              </div>
            )}
          </main>
        </div>
        <footer className="health-window-footer">
          <span>
            <i className="health-live-dot" />
            {telemetry.error ? "Reconnecting" : "Live"}
          </span>
          <span>Resources 2s · Services 10s · Models 30s · Accounts 60s</span>
          <small>
            {telemetry.snapshot
              ? `Updated ${formatAppTime(telemetry.snapshot.sampledAt)}`
              : "Waiting for telemetry"}
          </small>
        </footer>
      </section>
    </div>
  );
}

export function SystemHealth({
  userId,
  railVisible,
  environment,
  onManage,
  allowChanges = true,
  minimizedBarToggle,
  onOpenAgentsDashboard,
  agentsSummary,
  onReopenPane,
  onReopenAllDetached,
  onCloseSession,
  readOnly = false,
}: {
  userId: string;
  railVisible: boolean;
  environment: CodexEnvironment | null;
  allowChanges?: boolean;
  onManage?: (id: "accounts" | "provider" | "cli") => void;
  minimizedBarToggle?: ReactNode;
  onOpenAgentsDashboard?: () => void;
  agentsSummary?: AgentDashboardSummary | null;
  onReopenPane?: (roomId: string, paneId: string) => Promise<void> | void;
  onReopenAllDetached?: () => Promise<void> | void;
  onCloseSession?: (paneId: string) => Promise<void> | void;
  /** When true, indicator buttons are display-only: no panel opens on click. */
  readOnly?: boolean;
}) {
  const [agentsLiveSummary, setAgentsLiveSummary] = useState<AgentDashboardSummary | null>(agentsSummary ?? null);
  useEffect(() => {
    if (agentsSummary) setAgentsLiveSummary(agentsSummary);
  }, [agentsSummary]);
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AgentDashboardSummary>).detail;
      if (detail) setAgentsLiveSummary(detail);
    };
    window.addEventListener("space:agents-dashboard-summary", handler);
    return () => window.removeEventListener("space:agents-dashboard-summary", handler);
  }, []);
  const storage = getSpaceRuntime().platform.localStorage;
  const [thresholds, setThresholds] = useState(() =>
    readHealthThresholds(storage, userId),
  );
  const [open, setOpen] = useState<"health" | "resources" | null>(null);
  const [section, setSection] = useState<HealthSection>("overview");
  const [selected, setSelected] = useState("cpu");
  const [expanded, setExpanded] = useState(false);
  const [visibilityMenu, setVisibilityMenu] = useState<RailVisibilityMenuState>(null);
  const rail = useRef<HTMLElement>(null);
  const healthRailItemsRef = useRef<HTMLDivElement | null>(null);
  const source = useRef<HTMLSpanElement>(null);
  const upperRailVisibility = useRailVisibility(
    UPPER_RAIL_HIDDEN_KEY,
    UPPER_RAIL_IDS,
    UPPER_RAIL_NON_HIDEABLE,
  );
  useRailOrder(
    healthRailItemsRef,
    Boolean(railVisible && !open),
    {
      storageKey: UPPER_RAIL_ORDER_KEY,
      allowedIds: UPPER_RAIL_IDS,
      group: "upper",
    },
  );
  useEffect(() => {
    if (!railVisible || open) setVisibilityMenu(null);
  }, [open, railVisible]);
  useEffect(() => {
    dispatchRailMenuChange();
  }, [open]);
  useLayoutEffect(() => {
    const shell = source.current?.closest<HTMLElement>(".space-shell");
    const element = rail.current;
    if (!shell || !element) return;
    const measure = () => shell.style.setProperty("--resource-rail-height", `${element.getBoundingClientRect().height}px`);
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    return () => { observer?.disconnect(); shell.style.removeProperty("--resource-rail-height"); };
  }, [railVisible, open, expanded]);
  const telemetry = useHealthTelemetry(
    railVisible || open !== null,
    open === "health",
    environment,
    thresholds,
    readOnly,
  );
  useEffect(() => {
    const listener = (event: Event) => {
      if (readOnly) return;
      const detail = (
        event as CustomEvent<{
          section?: HealthSection;
          metric?: string;
          resources?: boolean;
        }>
      ).detail;
      setOpen("health");
      setSection(detail?.resources && detail.metric ? (detail.metric === "cli" ? "sessions" : ["accounts", "codex-reset"].includes(detail.metric) ? "ai" : detail.metric === "rtt" ? "connection" : "performance") : detail?.section ?? "overview");
      setSelected(detail?.metric ?? "cpu");
      setExpanded(false);
    };
    window.addEventListener("space:system-health", listener);
    return () => window.removeEventListener("space:system-health", listener);
  }, [readOnly]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const viewport = window.visualViewport;
    let wasKeyboardOpen = false;

    const checkState = () => {
      const isMobile = window.innerWidth <= 768 || document.querySelector(".space-shell")?.getAttribute("data-shell-mode") === "mobile";
      if (!isMobile) {
        wasKeyboardOpen = false;
        document.documentElement.removeAttribute("data-virtual-keyboard-open");
        return;
      }
      const keyboardOpen = Boolean(viewport && viewport.height < window.innerHeight * 0.78);
      if (keyboardOpen) {
        if (!wasKeyboardOpen) {
          setExpanded(false);
          wasKeyboardOpen = true;
        }
        document.documentElement.setAttribute("data-virtual-keyboard-open", "true");
      } else {
        wasKeyboardOpen = false;
        document.documentElement.removeAttribute("data-virtual-keyboard-open");
      }
    };

    const handleFocus = (e: FocusEvent) => {
      const isMobile = window.innerWidth <= 768 || document.querySelector(".space-shell")?.getAttribute("data-shell-mode") === "mobile";
      if (!isMobile) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.classList.contains("xterm-helper-textarea"))) {
        setExpanded(false);
        wasKeyboardOpen = true;
        document.documentElement.setAttribute("data-virtual-keyboard-open", "true");
      }
    };

    const handleBlur = () => {
      setTimeout(checkState, 150);
    };

    viewport?.addEventListener("resize", checkState);
    viewport?.addEventListener("scroll", checkState);
    window.addEventListener("resize", checkState);
    window.addEventListener("focusin", handleFocus);
    window.addEventListener("focusout", handleBlur);

    return () => {
      viewport?.removeEventListener("resize", checkState);
      viewport?.removeEventListener("scroll", checkState);
      window.removeEventListener("resize", checkState);
      window.removeEventListener("focusin", handleFocus);
      window.removeEventListener("focusout", handleBlur);
      document.documentElement.removeAttribute("data-virtual-keyboard-open");
    };
  }, []);

  const shell = source.current?.closest<HTMLElement>("[data-shell-mode]") ?? (typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-shell-mode]") : null);
  const theme = {
    "data-ui-theme": shell?.dataset.uiTheme,
    "data-color-mode": shell?.dataset.colorMode,
    "data-room-theme": shell?.dataset.roomTheme,
    "data-shell-mode": shell?.dataset.shellMode,
  };
  useEffect(() => {
    const dismiss = () => setOpen(null);
    window.addEventListener("space:navigation-open", dismiss);
    return () => window.removeEventListener("space:navigation-open", dismiss);
  }, []);
  const close = () => setOpen(null);
  const save = (next: HealthThresholds) => {
    setThresholds(next);
    try {
      storage.setItem(healthThresholdStorageKey(userId), JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  };
  const availableSummary = summaryMetrics(telemetry).filter((m) => {
    if (readOnly) {
      return m.id === "memory" || m.id === "cpu" || m.id === "rtt";
    }
    return m.id !== "provider" && m.id !== "models";
  });
  const summary = availableSummary.filter((m) => upperRailVisibility.isVisible(m.id));
  const upperMenuItems = DEFAULT_UPPER_RAIL_ITEMS.filter((item) => {
    if (readOnly) {
      return item.id === "memory" || item.id === "cpu" || item.id === "rtt";
    }
    if (item.id === "minimized-bar") return Boolean(minimizedBarToggle);
    if (item.id === "codex-reset") return availableSummary.some((metric) => metric.id === "codex-reset");
    return true;
  });

  const accountProviders = useMemo<Array<{
    id: string;
    tag: string;
    label: string;
    value: string;
    tone: HealthTone;
    detail: string;
    icon: LucideIcon;
  }>>(() => {
    const list: Array<{
      id: string;
      tag: string;
      label: string;
      value: string;
      tone: HealthTone;
      detail: string;
      icon: LucideIcon;
    }> = [];

    const aggregates = computeQuotaAggregates(
      telemetry.accounts,
      telemetry.antigravityAccounts,
      telemetry.apiProviderAccounts
    );

    // 1. Codex
    const isCodexEnabled = telemetry.environment?.isCodexEnabled !== false;
    if (!isCodexEnabled) {
      list.push({
        id: "codex",
        tag: "CODEX",
        label: "Codex",
        value: "OFF",
        tone: "disabled",
        detail: "Codex is disabled in Settings",
        icon: Wallet,
      });
    } else {
      const activeLbPct = telemetry.environment?.lbUsage?.activeAccountsRemainingPercent;
      const allLbPct = telemetry.environment?.lbUsage?.allAccountsRemainingPercent;
      const computedPct = aggregates.codex.percent5h || aggregates.codex.percentWeekly;
      const rawVal = activeLbPct != null ? activeLbPct : (computedPct || allLbPct || 0);
      const codexVal = Math.round(rawVal);
      const codexTone: HealthTone =
        codexVal <= 5 ? "critical" : codexVal <= 20 ? "warning" : "healthy";
      const activeCount = aggregates.codex.activeAccounts || (activeLbPct != null ? 3 : 0);
      const totalCount = aggregates.codex.totalAccounts || (telemetry.environment?.lbUsage ? 4 : 0);
      list.push({
        id: "codex",
        tag: "CODEX",
        label: "Codex",
        value: `${codexVal}%`,
        tone: codexTone,
        detail: `Codex active capacity: ${codexVal}% · ${activeCount}/${totalCount} accounts active`,
        icon: Wallet,
      });
    }

    // 2. Antigravity (AGY)
    const hasAgyAccounts =
      aggregates.antigravityCombined.totalAccounts > 0 ||
      Boolean(telemetry.antigravityAccounts?.data && telemetry.antigravityAccounts.data.length > 0);
    if (hasAgyAccounts) {
      const agy5h = Math.round(aggregates.antigravityCombined.percent5h);
      const agyWk = Math.round(aggregates.antigravityCombined.percentWeekly);
      const agyVal = agy5h;
      const agyTone: HealthTone =
        agyVal <= 5 ? "critical" : agyVal <= 20 ? "warning" : "healthy";
      list.push({
        id: "antigravity",
        tag: "AGY",
        label: "Antigravity",
        value: `${agyVal}%`,
        tone: agyTone,
        detail: `Antigravity capacity: ${agy5h}% (5h) · ${agyWk}% (weekly) · ${aggregates.antigravityCombined.activeAccounts}/${aggregates.antigravityCombined.totalAccounts} accounts active`,
        icon: Sparkles,
      });
    }

    // 3. API Providers
    if (aggregates.apiProviders.totalProviders > 0) {
      const { connectedProviders, totalBalanceUsd, totalProviders } = aggregates.apiProviders;
      const balanceStr = totalBalanceUsd > 0 ? `$${totalBalanceUsd.toFixed(totalBalanceUsd >= 10 ? 0 : 2)}` : `${connectedProviders}/${totalProviders}`;
      const apiTone: HealthTone =
        connectedProviders === 0 ? "critical" : aggregates.apiProviders.exhaustedProviders > 0 ? "warning" : "healthy";
      list.push({
        id: "api",
        tag: "API",
        label: "API Providers",
        value: balanceStr,
        tone: apiTone,
        detail: `API Providers: ${connectedProviders}/${totalProviders} connected · Balance: $${totalBalanceUsd.toFixed(2)}`,
        icon: Layers,
      });
    }

    return list;
  }, [telemetry.accounts, telemetry.antigravityAccounts, telemetry.apiProviderAccounts, telemetry.environment]);

  const [accountRotationIndex, setAccountRotationIndex] = useState(0);

  useEffect(() => {
    if (accountProviders.length <= 1) return;
    const interval = setInterval(() => {
      setAccountRotationIndex((prev) => (prev + 1) % accountProviders.length);
    }, 20_000);
    return () => clearInterval(interval);
  }, [accountProviders.length]);

  return (
    <>
      <span ref={source} hidden />
      {railVisible && !open && (
        <nav
          ref={rail}
          className={`health-indicator-rail${expanded ? " is-expanded" : ""}`}
          aria-label="Resource indicators"
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setVisibilityMenu((current) => current ? null : { x: event.clientX, y: event.clientY });
          }}
        >
          <button
            className="health-rail-expander"
            type="button"
            aria-label={
              expanded
                ? "Collapse resource indicators"
                : "Expand resource indicators"
            }
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Activity aria-hidden="true" />
          </button>
          <div className="health-rail-items" ref={healthRailItemsRef}>
            {!readOnly && onOpenAgentsDashboard && upperRailVisibility.isVisible("agents-dashboard") ? (() => {
              const border = getAgentsIndicatorBorder(agentsLiveSummary);
              const borderClass = border === "run" ? "has-run" : border === "waiting-only" ? "has-waiting-only" : border === "done-only" ? "has-done-only" : "is-idle";
              const total = agentsLiveSummary?.loaded ? agentsLiveSummary.total : null;
              const working = agentsLiveSummary?.working ?? 0;
              const waiting = agentsLiveSummary?.waiting ?? 0;
              const done = agentsLiveSummary?.done ?? 0;
              const idle = agentsLiveSummary?.idle ?? 0;
              const hasLiveBadges = working > 0 || waiting > 0 || done > 0;
              const title = total !== null
                ? `Agents Dashboard · ${total} agents\n• ${working} working\n• ${waiting} waiting for you\n• ${done} done\n• ${idle} idle`
                : "Agents Dashboard";
              return (
                <button
                  type="button"
                  data-rail-id="agents-dashboard"
                  data-agents-state={border}
                  className={`health-indicator is-healthy agents-dashboard-rail-btn ${borderClass}`}
                  title={title}
                  aria-label="Open agents dashboard"
                  aria-haspopup="dialog"
                  onClick={onOpenAgentsDashboard}
                >
                  <div className="agents-rail-header">
                    {!hasLiveBadges ? (
                      <LayoutDashboard className="agents-rail-icon" aria-hidden="true" />
                    ) : null}
                    {working > 0 && waiting > 0 ? (
                      <span className="agents-live-badge-group">
                        <span className="agents-live-badge is-working" title={`${working} working`}>
                          <i className="agents-badge-dot" />
                          <span>{working}</span>
                        </span>
                        <span className="agents-live-badge is-waiting" title={`${waiting} waiting for you`}>
                          <i className="agents-badge-dot" />
                          <span>{waiting}</span>
                        </span>
                      </span>
                    ) : working > 0 ? (
                      <span className="agents-live-badge is-working" title={`${working} working`}>
                        <i className="agents-badge-dot" />
                        <span>{working}</span>
                      </span>
                    ) : waiting > 0 ? (
                      <span className="agents-live-badge is-waiting" title={`${waiting} waiting for you`}>
                        <i className="agents-badge-dot" />
                        <span>{waiting}</span>
                      </span>
                    ) : done > 0 ? (
                      <span className="agents-live-badge is-done" title={`${done} done`}>
                        <i className="agents-badge-dot" />
                        <span>{done}</span>
                      </span>
                    ) : null}
                  </div>
                  <strong>{total !== null ? total : "—"}</strong>
                  {total !== null && total > 0 ? (
                    <div className="agents-rail-bar" aria-hidden="true">
                      {waiting > 0 && <span className="agents-bar-segment is-waiting" style={{ flexGrow: waiting }} />}
                      {working > 0 && <span className="agents-bar-segment is-working" style={{ flexGrow: working }} />}
                      {done > 0 && <span className="agents-bar-segment is-done" style={{ flexGrow: done }} />}
                      {idle > 0 && <span className="agents-bar-segment is-idle" style={{ flexGrow: idle }} />}
                    </div>
                  ) : (
                    <i className="health-dot" aria-hidden="true" />
                  )}
                </button>
              );
            })() : null}
            {minimizedBarToggle && upperRailVisibility.isVisible("minimized-bar")
              ? minimizedBarToggle
              : null}
            {summary.map((m) => {
              const isAccounts = m.id === "accounts";
              const currentProvider =
                isAccounts && accountProviders.length > 0
                  ? accountProviders[accountRotationIndex % accountProviders.length]
                  : null;
              const Icon = currentProvider ? currentProvider.icon : m.icon;
              const value = currentProvider
                ? currentProvider.value
                : m.tone === "unavailable"
                  ? "—"
                  : m.value;
              const tone: HealthTone = currentProvider ? currentProvider.tone : m.tone;
              const toneText = toneLabels[tone] ?? tone;
              const title = currentProvider
                ? `Account remaining (${currentProvider.label}): ${currentProvider.value} · ${toneText}\n${currentProvider.detail}\nRotates every 20s across all providers (${(accountRotationIndex % accountProviders.length) + 1}/${accountProviders.length})`
                : `${m.label}: ${m.value} · ${toneLabels[m.tone]}\n${m.detail}${m.at ? `\nUpdated ${formatAppTime(m.at)}` : ""}`;
              const ariaLabel = currentProvider
                ? `Account remaining: ${currentProvider.label} ${currentProvider.value}, ${toneText}`
                : `${m.label}: ${m.value}, ${toneLabels[m.tone]}`;

              return (
                <button
                  type="button"
                  key={m.id}
                  data-rail-id={m.id}
                  className={`health-indicator is-${tone}${readOnly ? " is-read-only" : ""}`}
                  aria-label={ariaLabel}
                  title={title}
                  onClick={readOnly ? undefined : () => {
                    setSelected(m.id);
                    setSection(m.id === "cli" ? "sessions" : ["accounts", "codex-reset"].includes(m.id) ? "ai" : m.id === "rtt" ? "connection" : "performance");
                    setOpen("health");
                  }}
                >
                  <Icon aria-hidden="true" />
                  {currentProvider ? (
                    <span className="health-indicator-provider-tag">{currentProvider.tag}</span>
                  ) : null}
                  <strong>{m.tone === "unavailable" && !currentProvider ? "—" : value}</strong>
                  <i className="health-dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>
          {visibilityMenu ? (
            <RailVisibilityMenu
              anchorRef={rail}
              items={upperMenuItems}
              hiddenIds={upperRailVisibility.hiddenIds}
              label="Resource icons"
              x={visibilityMenu.x}
              y={visibilityMenu.y}
              onClose={() => setVisibilityMenu(null)}
              onHide={upperRailVisibility.hide}
              onShow={upperRailVisibility.show}
              onShowAll={upperRailVisibility.showAll}
            />
          ) : null}
        </nav>
      )}
      {open &&
        createPortal(
          <div className="health-theme-root" {...theme}>
              <HealthWindow
                onReopenPane={onReopenPane} onReopenAllDetached={onReopenAllDetached} onCloseSession={onCloseSession}
                telemetry={telemetry}
                section={section}
                onSection={setSection}
                selected={selected}
                onSelect={setSelected}
                onClose={close}
                thresholds={thresholds}
                onThresholds={save}
                allowChanges={allowChanges}
                onManage={
                  onManage
                    ? (id) => {
                        close();
                        onManage(id);
                      }
                    : undefined
                }
              />
          </div>,
          document.body,
        )}
    </>
  );
}

export function useResourceIndicators(userId: string | undefined) {
  const storage = getSpaceRuntime().platform.localStorage;
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    try {
      setVisible(
        Boolean(
          userId && storage.getItem(healthRailStorageKey(userId)) === "true",
        ),
      );
    } catch {
      setVisible(false);
    }
  }, [userId, storage]);
  const toggle = useCallback(() => {
    if (!userId) return;
    setVisible((current) => {
      const next = !current;
      try {
        storage.setItem(healthRailStorageKey(userId), String(next));
      } catch {
        /* Session-only preference when storage is blocked. */
      }
      return next;
    });
  }, [userId, storage]);
  return [visible, toggle] as const;
}
