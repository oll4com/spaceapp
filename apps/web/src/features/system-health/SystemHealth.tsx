import { useWorkspaceSurface } from "../ui-theme/WorkspaceSurface.js";
import { syncRailScale } from "../ui-theme/rail-dynamic-scaling.js";
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
  CodexEnvironment,
  SystemHealthHistory,
  SystemHealthMetric,
  SystemHealthRange,
} from "@space/contracts";
import { api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import {
  Activity,
  AlertTriangle,
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
  Settings,
  ShieldCheck,
  Terminal,
  Gauge as Wallet,
  X,
  type LucideIcon,
} from "../ui-theme/app-icons.js";
import { computeQuotaAggregates, type QuotaBreakdownItem } from "../desktop-widgets/quota-aggregates.js";
import { lowQuotaText } from "../desktop-widgets/quota-low.js";
import {
  ToolbarMetrics,
  getToolbarMetricsSnapshot,
} from "../toolbar-metrics/ToolbarMetrics.js";
import { formatAppTime } from "../date-time-settings/date-time-settings.js";
import { useAppVersion } from "../app-version/use-app-version.js";
import { getAgentsIndicatorBorder, type AgentDashboardSummary } from "../agents-dashboard/dashboard-model.js";
import { HealthChart } from "./HealthChart.js";
const LazyHealthProcessTable = lazy(() => import("./HealthTables.js").then(module => ({ default: module.HealthProcessTable })));
import {
  computeCodexCooldown,
  defaultHealthThresholds,
  formatHealthValue,
  healthRailStorageKey,
  healthThresholdStorageKey,
  readHealthThresholds,
  resourceView,
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
import { rangeFits, useHistoryPeriodDays } from "../history-period/use-history-period.js";
import "./system-health.css";

const TokenUsageWorkspace = lazy(() => import("../system-analytics/SystemAnalyticsWorkspace.js").then(module => ({ default: module.SystemAnalyticsWorkspace })));

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
// One AI quota tile: the subscription pool with the least room left, every pool in its tooltip, per provider and never an account count (operator 6/11); API budgets stay in the AI
// section, never on the rail (operator 3/11 nous_msg:7c5ae4e4).
function quotaTileOf(telemetry: HealthTelemetry) {
  const aggregates = computeQuotaAggregates(telemetry.accounts, telemetry.antigravityAccounts, null, telemetry.claudeAccounts);
  const lb = telemetry.environment?.lbUsage;
  const at = (iso: number) => formatAppTime(iso, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  const nextReset = (items: QuotaBreakdownItem[], key: "fiveHourResetAt" | "weeklyResetAt") => {
    const next = Math.min(...items.map((item) => Date.parse(item[key] ?? "")).filter((t) => t > telemetry.clock));
    return Number.isFinite(next) ? ` (resets ${at(next)})` : "";
  };
  const pools = [
    { tag: "CLAUDE", label: "Claude Max", metric: aggregates.claudeMax, list: telemetry.claudeAccounts, off: false, fallback: null },
    { tag: "CODEX", label: "Codex", metric: aggregates.codex, list: telemetry.accounts, off: telemetry.environment?.isCodexEnabled === false,
      fallback: lb?.activeAccountsRemainingPercent ?? lb?.allAccountsRemainingPercent ?? null },
    { tag: "AGY", label: "Antigravity", metric: aggregates.antigravityCombined, list: telemetry.antigravityAccounts, off: false, fallback: null },
  // Only pools this installation has: a provider with no account, or switched off, is left out (plan clipboard:sJpyQIBFGszW).
  ].filter(({ list, off }) => !off && Boolean(list?.data?.length)).map(({ metric, list, fallback, ...pool }) => {
    const percent = metric.percent5h ?? metric.percentWeekly ?? fallback;
    const window = metric.percent5h != null ? "5h" : "weekly";
    const accounts = metric.accounts;
    const reason = list?.error ? `source failed: ${list.error}` : list?.isStale ? "source is stale"
      : !list ? "not loaded yet" : !accounts.length ? "no accounts" : "no account reports a quota";
    const share = (value: number | null, items: QuotaBreakdownItem[], key: "fiveHourResetAt" | "weeklyResetAt") =>
      value == null ? "—" : `${Math.round(value)}%${nextReset(items, key)}`;
    const line = percent == null
      ? `${pool.label}: No data (${reason})`
      : metric.percent5h == null && metric.percentWeekly == null
        ? `${pool.label}: ${Math.round(percent)}% weekly (Space Gateway pool)`
        : `${pool.label}: 5h ${share(metric.percent5h, accounts.filter((a) => a.fiveHourPercent != null), "fiveHourResetAt")} · week ${share(metric.percentWeekly, accounts.filter((a) => a.weeklyPercent != null), "weeklyResetAt")}`;
    return { ...pool, percent, window, line };
  });
  const known = pools.filter((pool) => pool.percent != null);
  const pick = known.reduce<(typeof pools)[number] | null>((low, pool) => !low || pool.percent! < low.percent! ? pool : low, null);
  const percent = pick?.percent == null ? null : Math.round(pick.percent);
  return {
    pick,
    pools,
    value: percent == null ? "No data" : `${percent}%`,
    tone: (percent == null ? "unavailable" : percent <= 5 ? "critical" : percent <= 20 ? "warning" : "healthy") as HealthTone,
    summary: pick ? `${pick.label} ${percent}% (${pick.window}), the least of ${known.length} provider${known.length === 1 ? "" : "s"}` : "No data",
    lines: pools.map((pool) => pool.line),
  };
}
function useDialogFocus(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const embedded = useWorkspaceSurface();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (embedded) return;
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
  }, [ref, embedded]);
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
  const embedded = useWorkspaceSurface();
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
  const [maximized, setMaximized] = useState(false);
  const [range, setRange] = useState<SystemHealthRange>("1m");
  const historyDays = useHistoryPeriodDays();
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
  const quota = useMemo(() => quotaTileOf(telemetry), [telemetry]);
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
    // A floating window, not a modal (operator nous_msg:2727df80): the workspace behind stays sharp and usable; X or Escape closes it.
    <div className={`health-modal-backdrop${embedded ? " is-workspace-embedded" : ""}`}>
      <section
        ref={ref}
        tabIndex={-1}
        className={`health-window resources-unified${maximized ? " is-maximized" : ""}${embedded ? " is-workspace-embedded" : ""}`}
        role="dialog"
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
            {!embedded ? <button
              type="button"
              className={`health-maximize-toggle dock-fullscreen-toggle${maximized ? " is-active" : ""}`}
              title={maximized ? "Collapse Resources" : "Expand Resources"}
              aria-label={maximized ? "Collapse Resources" : "Expand Resources"}
              aria-pressed={maximized}
              onClick={() => setMaximized((v) => !v)}
            >
              {maximized ? <Minimize2 /> : <Maximize2 />}
            </button> : null}
            <button type="button" className="health-window-close-btn" aria-label="Close Resources" onClick={onClose}>
              <X />
            </button>
          </div>
        </header>
        <div className="health-window-layout">
          {section !== "overview" && <nav className="resources-detail-navigation" aria-label="Resource details">
            <button type="button" onClick={() => onSection("overview")}>← Back</button>
            <select className="resources-detail-select" aria-label="Resource view" value={section} onChange={e => onSection(e.target.value as HealthSection)}>
              <optgroup label="AI usage"><option value="ai">Accounts & quotas</option><option value="analytics">Token usage & analytics</option><option value="sessions">CLI sessions</option></optgroup>
              <optgroup label="System"><option value="performance">Performance & latency</option><option value="processes">Processes</option><option value="services">Service readiness</option><option value="topology">Topology</option><option value="alerts">Alerts & thresholds</option></optgroup>
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
                // Only when this installation has an AI account (plan clipboard:sJpyQIBFGszW).
                ...(quota.pools.length ? [{ label: "Accounts & quotas", section: "ai", icon: Wallet, value: quota.pick ? `${quota.pick.tag} ${quota.value}` : quota.value, detail: quota.summary }] : []),
                { label: "CLI sessions", section: "sessions", icon: Terminal, value: summary.find(m => m.id === "cli")?.value ?? "—", detail: "Running CLI sessions" },
                { label: "System", section: "performance", icon: Cpu, value: `CPU ${summary.find(m => m.id === "cpu")?.value ?? "—"} · RAM ${summary.find(m => m.id === "memory")?.value ?? "—"}`, detail: `Latency ${summary.find(m => m.id === "rtt")?.value ?? "—"} · processes & services` },
              ].map(item => <button type="button" className="resources-summary-row" key={item.section} onClick={() => onSection(item.section as HealthSection)}>
                <span className="resources-summary-icon"><item.icon aria-hidden="true" /></span>
                <span className="resources-summary-info"><strong>{item.label}</strong><small>{item.detail}</small></span>
                <b className="resources-summary-value">{item.value}</b>
              </button>)}
              <button type="button" className="resources-alert-summary" onClick={() => onSection("alerts")}>
                {issues.length ? `${issues.length} alerts need attention` : unavailable.length ? "Some measurements are unavailable" : "Alerts & thresholds"}
              </button>
            </div>}
            {(section === "ai" || section === "sessions") && <ToolbarMetrics
              presentation="embedded" allowChanges={allowChanges} sharedTelemetry={telemetry} initialPanel={section === "ai" ? "accounts" : "cli"}
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
                        {(Object.keys(rangeLabels) as SystemHealthRange[]).filter((r) => rangeFits(r, historyDays)).map(
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
              <RecoverableSurface fallback={<p className="health-empty" role="status">Loading processes…</p>}>
                <LazyHealthProcessTable thresholds={thresholds} />
              </RecoverableSurface>
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
                            <dt title={v.label}>{v.label}</dt>
                            <dd title={v.value}>{v.value}</dd>
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
  indicatorsVisible = true,
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
  initialSection = "overview",
  onClose,
}: {
  initialSection?: HealthSection;
  onClose?: () => void;
  userId: string;
  railVisible: boolean;
  indicatorsVisible?: boolean;
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
  const embedded = useWorkspaceSurface();
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
  const [open, setOpen] = useState<"health" | "resources" | null>(embedded ? "health" : null);
  const [section, setSection] = useState<HealthSection>(resourceView(initialSection));
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
    Boolean(railVisible && !open && indicatorsVisible),
    {
      storageKey: UPPER_RAIL_ORDER_KEY,
      allowedIds: UPPER_RAIL_IDS,
      group: "upper",
    },
  );
  useEffect(() => {
    if (!railVisible || open || !indicatorsVisible) setVisibilityMenu(null);
  }, [open, railVisible, indicatorsVisible]);
  useEffect(() => {
    dispatchRailMenuChange();
  }, [open]);
  useLayoutEffect(() => {
    if (embedded) return;
    const shell =
      source.current?.closest<HTMLElement>(".space-shell") ??
      (typeof document !== "undefined"
        ? document.querySelector<HTMLElement>(".space-shell")
        : null);
    const element = rail.current;
    if (!shell) return;
    if (expanded && indicatorsVisible) {
      shell.dataset.resourceRailExpanded = "true";
    } else {
      delete shell.dataset.resourceRailExpanded;
    }
    syncRailScale(shell);
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      shell.style.setProperty(
        "--resource-rail-height",
        `${rect.height}px`
      );
      if (rect.bottom > 0) {
        shell.style.setProperty(
          "--resource-rail-bottom",
          `${Math.round(rect.bottom)}px`
        );
      }
      syncRailScale(shell);
    };
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : null;
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      shell.style.removeProperty("--resource-rail-height");
      shell.style.removeProperty("--resource-rail-bottom");
      delete shell.dataset.resourceRailExpanded;
      syncRailScale(shell);
    };
  }, [railVisible, indicatorsVisible, open, expanded, embedded]);
  const telemetry = useHealthTelemetry(
    Boolean((railVisible && indicatorsVisible) || open !== null),
    open === "health",
    environment,
    thresholds,
    readOnly,
  );
  useEffect(() => {
    if (embedded) return;
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
      setSection(detail?.resources && detail.metric ? (detail.metric === "cli" ? "sessions" : ["accounts", "codex-reset"].includes(detail.metric) ? "ai" : "performance") : resourceView(detail?.section ?? "overview"));
      setSelected(detail?.metric ?? (detail?.section === "connection" ? "rtt" : detail?.section === "models" || detail?.section === "usage" ? "models" : "cpu"));
      setExpanded(false);
    };
    window.addEventListener("space:system-health", listener);
    return () => window.removeEventListener("space:system-health", listener);
  }, [readOnly, embedded]);
  useEffect(() => {
    if (embedded || typeof window === "undefined") return;
    const viewport = window.visualViewport;
    let wasKeyboardOpen = false;

    const checkState = () => {
      const isMobile = window.innerWidth <= 767 || document.querySelector(".space-shell")?.getAttribute("data-shell-mode") === "mobile";
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
      const isMobile = window.innerWidth <= 767 || document.querySelector(".space-shell")?.getAttribute("data-shell-mode") === "mobile";
      if (!isMobile) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.classList.contains("xterm-helper-textarea"))) {
        setExpanded(false);
        wasKeyboardOpen = true;
        document.documentElement.setAttribute("data-virtual-keyboard-open", "true");
      }
    };

    // Cleared on unmount: a pending check after teardown threw "window is not defined" in CI.
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const handleBlur = () => {
      clearTimeout(blurTimer);
      blurTimer = setTimeout(checkState, 150);
    };

    viewport?.addEventListener("resize", checkState);
    viewport?.addEventListener("scroll", checkState);
    window.addEventListener("resize", checkState);
    window.addEventListener("focusin", handleFocus);
    window.addEventListener("focusout", handleBlur);

    return () => {
      clearTimeout(blurTimer);
      viewport?.removeEventListener("resize", checkState);
      viewport?.removeEventListener("scroll", checkState);
      window.removeEventListener("resize", checkState);
      window.removeEventListener("focusin", handleFocus);
      window.removeEventListener("focusout", handleBlur);
      document.documentElement.removeAttribute("data-virtual-keyboard-open");
    };
  }, [embedded]);

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
  const close = () => { if (embedded) onClose?.(); else setOpen(null); };
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

  const quotaTile = useMemo(() => quotaTileOf(telemetry), [telemetry]);
  const showAgentsTile = Boolean(!readOnly && onOpenAgentsDashboard && upperRailVisibility.isVisible("agents-dashboard"));
  // The quota tile only when this installation has an AI account: a fresh install showed "No data" there for nothing.
  const railMetrics = summary.filter((m) => m.id !== "accounts" || quotaTile.pools.length > 0);

  // Any subscription window under 5% turns the quota icon red, whichever provider the rail shows (operator 2026-10-31); API budgets never do (2/11).
  const quotaLow = lowQuotaText({
    codex: telemetry.accounts,
    agy: telemetry.antigravityAccounts,
    claude: telemetry.claudeAccounts,
  }, telemetry.clock);

    const resourceWindow = <div className="health-theme-root" {...theme}>
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
          </div>;

  return (
    <>
      <span ref={source} hidden />
      {railVisible && !open && (indicatorsVisible || (minimizedBarToggle && upperRailVisibility.isVisible("minimized-bar"))) && (
        <nav
          ref={rail}
          className={`health-indicator-rail${expanded && indicatorsVisible ? " is-expanded" : ""}`}
          data-expanded={expanded && indicatorsVisible ? "true" : undefined}
          aria-label="Resource indicators"
          onContextMenu={(event) => {
            if (!indicatorsVisible) return;
            event.preventDefault();
            event.stopPropagation();
            setVisibilityMenu((current) => current ? null : { x: event.clientX, y: event.clientY });
          }}
        >
          {minimizedBarToggle && upperRailVisibility.isVisible("minimized-bar")
            ? minimizedBarToggle
            : null}
          {indicatorsVisible && (railMetrics.length || showAgentsTile) ? (
            <>
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
            {showAgentsTile ? (() => {
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
            {railMetrics.map((m) => {
              const quota = m.id === "accounts" ? quotaTile : null;
              const Icon = m.icon;
              const value = quota ? quota.value : m.tone === "unavailable" ? "—" : m.value;
              const low = quota ? quotaLow : null;
              const tone: HealthTone = low ? "critical" : quota ? quota.tone : m.tone;
              const toneText = toneLabels[tone] ?? tone;
              const lowLine = low ? `Quota low: ${low}\n` : "";
              const title = quota
                ? `${lowLine}AI quota left: ${quota.summary}\n${quota.lines.join("\n")}\nClick for the AI section`
                : `${m.label}: ${m.value} · ${toneLabels[m.tone]}\n${m.detail}${m.at ? `\nUpdated ${formatAppTime(m.at)}` : ""}`;
              const ariaLabel = (quota
                ? `AI quota left: ${quota.summary}, ${toneText}`
                : `${m.label}: ${m.value}, ${toneLabels[m.tone]}`) + (low ? `. Quota low: ${low}` : "");
              const level = value.endsWith("%") ? Math.min(100, Math.max(0, Number.parseFloat(value))) : Number.NaN;

              return (
                <button
                  type="button"
                  key={m.id}
                  data-rail-id={m.id}
                  className={`health-indicator is-${tone}${low ? " is-quota-low" : ""}${readOnly ? " is-read-only" : ""}`}
                  aria-label={ariaLabel}
                  title={title}
                  onClick={readOnly ? undefined : () => {
                    setSelected(m.id);
                    setSection(m.id === "cli" ? "sessions" : ["accounts", "codex-reset"].includes(m.id) ? "ai" : "performance");
                    setOpen("health");
                  }}
                >
                  <Icon aria-hidden="true" />
                  {quota ? (
                    <span className="health-indicator-provider-tag">{quota.pick?.tag ?? "AI"}</span>
                  ) : null}
                  <strong className={quota && !quota.pick ? "is-text" : undefined}>{m.tone === "unavailable" && !quota ? "—" : value}</strong>
                  {Number.isFinite(level) ? (
                    <span className="health-indicator-gauge" aria-hidden="true">
                      <span style={{ width: `${level}%` }} />
                    </span>
                  ) : null}
                  <i className="health-dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>
            </>
          ) : null}
          {indicatorsVisible && visibilityMenu ? (
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
      {open && (embedded ? resourceWindow : createPortal(resourceWindow, document.body))}
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
