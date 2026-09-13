import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
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
  ArrowUp,
  Check,
  Clock3,
  Cpu,
  Database,
  HardDrive,
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
  X,
  type LucideIcon,
} from "../ui-theme/app-icons.js";
import { getToolbarMetricsSnapshot } from "../toolbar-metrics/ToolbarMetrics.js";
import { useAppVersion } from "../app-version/use-app-version.js";
import { HealthChart } from "./HealthChart.js";
import { HealthAiPanel, HealthProcessTable } from "./HealthTables.js";
import {
  computeCodexCooldown,
  defaultHealthThresholds,
  formatHealthValue,
  healthRailStorageKey,
  healthThresholdStorageKey,
  openSystemHealth,
  overallHealth,
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
import "./system-health.css";

const TokenUsageWorkspace = lazy(() => import("../system-analytics/SystemAnalyticsWorkspace.js").then(module => ({ default: module.SystemAnalyticsWorkspace })));

const sections: Array<{ id: HealthSection; label: string; icon: LucideIcon }> =
  [
    { id: "overview", label: "Overview", icon: Activity },
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
      detail: `Next Codex account available: ${cooldown.accountLabel ?? "account"} in ${cooldown.formatted}${cooldown.resetAt ? ` (${new Date(cooldown.resetAt).toLocaleTimeString()})` : ""}`,
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
function HealthResources({
  telemetry,
  selected,
  onSelect,
  onClose,
  onOpen,
}: {
  telemetry: HealthTelemetry;
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  onOpen: (id?: string) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  useDialogFocus(ref, onClose);
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
        <div>
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
            <small>
              {item.at
                ? `Updated ${new Date(item.at).toLocaleTimeString()}`
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
}: {
  telemetry: HealthTelemetry;
  section: HealthSection;
  onSection: (section: HealthSection) => void;
  selected: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  thresholds: HealthThresholds;
  onThresholds: (thresholds: HealthThresholds) => boolean;
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
  const summary = summaryMetrics(telemetry);
  const services = telemetry.snapshot?.services ?? [];
  const signals = telemetry.metrics.filter(
    (m) => !(m.id === "swap" && m.detail === "No swap configured"),
  );
  const overall = overallHealth([
    ...signals.map((m) => telemetry.toneFor(m.id)),
    ...services.map((s) => serviceTone(s, telemetry.clock)),
  ]);
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
          !(m.id === "swap" && m.detail === "No swap configured"),
      )
      .map((m) => m.label),
    ...services
      .filter((s) =>
        ["stale", "unavailable"].includes(serviceTone(s, telemetry.clock)),
      )
      .map((s) => s.label),
  ];
  const performanceMetrics = telemetry.metrics.filter(
    (m) => m.id !== "accounts",
  );
  const metric =
    performanceMetrics.find((m) => m.id === selected) ??
    performanceMetrics.find((m) => m.id === "cpu");
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
              <small>Since {new Date(i.since).toLocaleTimeString()}</small>
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
        className={`health-window${maximized ? " is-maximized" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Space Health"
      >
        <header className="health-window-header">
          <span className="health-brand-icon">
            <Activity aria-hidden="true" />
          </span>
          <div>
            <h1>Space Health</h1>
            <p>Server & connection monitoring</p>
          </div>
          <StatusBadge tone={overall} />
          <button
            type="button"
            aria-label={maximized ? "Restore Health size" : "Maximize Health"}
            onClick={() => setMaximized((v) => !v)}
          >
            {maximized ? <Minimize2 /> : <Maximize2 />}
          </button>
          <button type="button" aria-label="Close Health" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="health-window-layout">
          <nav className="health-navigation" aria-label="Health sections">
            {sections.map((s) => {
              const Icon = s.icon;
              return (
                <button
                  type="button"
                  key={s.id}
                  aria-current={section === s.id ? "page" : undefined}
                  onClick={() => onSection(s.id)}
                >
                  <Icon aria-hidden="true" />
                  <span>{s.label}</span>
                  {s.id === "alerts" && issues.length > 0 && (
                    <b>{issues.length}</b>
                  )}
                </button>
              );
            })}
            <div className="health-navigation-footer">
              <span className="health-live-dot" />
              Live monitoring
              <small>
                {telemetry.snapshot
                  ? `${telemetry.snapshot.coreCount} cores · ${Math.floor(telemetry.snapshot.uptimeSeconds / 3600)}h uptime`
                  : "Connecting…"}
              </small>
            </div>
          </nav>
          <main className="health-main">
            {telemetry.error && (
              <div className="health-error" role="status">
                Live telemetry could not be refreshed. Last known values are
                shown with their update time.
              </div>
            )}
            {section === "overview" && (
              <div className="health-stack">
                <header className="health-section-heading">
                  <div>
                    <span className="health-eyebrow">SYSTEM OVERVIEW</span>
                    <h2>Your Space, in real time</h2>
                    <p>
                      Resources, connections and service readiness in one view.
                    </p>
                  </div>
                  <button type="button" onClick={() => onSection("alerts")}>
                    {issues.length} active alerts
                  </button>
                </header>
                <div className="health-overview-grid">
                  {summary.map((m) => (
                    <MetricCard
                      key={m.id}
                      item={m}
                      telemetry={telemetry}
                      onClick={() => {
                        const destination = summaryDestination(m.id);
                        onSection(destination.section);
                        onSelect(destination.metric ?? m.id);
                      }}
                    />
                  ))}
                </div>
                <div className="health-overview-charts">
                  {["cpu", "memory"].map((id) => (
                    <section className="health-panel" key={id}>
                      <header className="health-section-heading">
                        <h3>
                          {id === "cpu" ? "CPU activity" : "Memory pressure"}
                        </h3>
                        <StatusBadge tone={telemetry.toneFor(id)} />
                      </header>
                      <HealthChart
                        series={telemetry.history.filter((s) => s.id === id)}
                        percent
                        rangeSeconds={60}
                        endAt={new Date(telemetry.clock).toISOString()}
                      />
                    </section>
                  ))}
                </div>
                <section className="health-panel">
                  <header className="health-section-heading">
                    <div>
                      <h3>API traffic</h3>
                      <p>Last 5 minutes · HTTP 5xx errors</p>
                    </div>
                  </header>
                  <div className="health-detail-facts">
                    <div>
                      <small>Requests</small>
                      <strong>
                        {telemetry.snapshot?.requests.requestCount ?? "—"}
                      </strong>
                    </div>
                    <div>
                      <small>Errors</small>
                      <strong>
                        {telemetry.snapshot?.requests.errorCount ?? "—"}
                      </strong>
                    </div>
                    <div>
                      <small>p95 response</small>
                      <strong>
                        {formatHealthValue(
                          telemetry.snapshot?.requests.p95Ms,
                          "MILLISECONDS",
                        )}
                      </strong>
                    </div>
                  </div>
                  {telemetry.snapshot &&
                    telemetry.snapshot.requests.requestCount < 20 && (
                      <p className="health-coverage">
                        At least 20 requests are needed to evaluate the recent
                        error rate and p95.
                      </p>
                    )}
                </section>
                <section className="health-panel">
                  <header className="health-section-heading">
                    <h3>Attention needed</h3>
                    <button type="button" onClick={() => onSection("alerts")}>
                      Alert settings
                    </button>
                  </header>
                  {issueList}
                </section>
              </div>
            )}
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
                          (r) => (
                            <button
                              type="button"
                              key={r}
                              aria-pressed={range === r}
                              onClick={() => setRange(r)}
                            >
                              {rangeLabels[r]}
                            </button>
                          ),
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
                        {new Date(metric.sampledAt).toLocaleTimeString()} · Live
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
                        Checked {new Date(s.checkedAt).toLocaleTimeString()}
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
            {section === "ai" && (
              <HealthAiPanel
                thresholds={thresholds}
                now={telemetry.clock}
                onOpenUsage={() => onSection("usage")}
                models={telemetry.models}
                accounts={telemetry.accounts}
                onManage={onManage}
              />
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
              ? `Updated ${new Date(telemetry.snapshot.sampledAt).toLocaleTimeString()}`
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
  minimizedBarToggle,
}: {
  userId: string;
  railVisible: boolean;
  environment: CodexEnvironment | null;
  onManage?: (id: "accounts" | "provider" | "cli") => void;
  minimizedBarToggle?: ReactNode;
}) {
  const storage = getSpaceRuntime().platform.localStorage;
  const [thresholds, setThresholds] = useState(() =>
    readHealthThresholds(storage, userId),
  );
  const [open, setOpen] = useState<"health" | "resources" | null>(null);
  const [section, setSection] = useState<HealthSection>("overview");
  const [selected, setSelected] = useState("cpu");
  const [expanded, setExpanded] = useState(false);
  const rail = useRef<HTMLElement>(null);
  const healthRailItemsRef = useRef<HTMLDivElement | null>(null);
  const source = useRef<HTMLSpanElement>(null);
  useRailOrder(
    healthRailItemsRef,
    Boolean(railVisible && !open),
    {
      storageKey: UPPER_RAIL_ORDER_KEY,
      allowedIds: UPPER_RAIL_IDS,
      group: "upper",
    },
  );
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
  );
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          section?: HealthSection;
          metric?: string;
          resources?: boolean;
        }>
      ).detail;
      setOpen(detail?.resources ? "resources" : "health");
      setSection(detail?.section ?? "overview");
      setSelected(detail?.metric ?? "cpu");
      setExpanded(false);
    };
    window.addEventListener("space:system-health", listener);
    return () => window.removeEventListener("space:system-health", listener);
  }, []);
  const shell = source.current?.closest<HTMLElement>("[data-shell-mode]");
  const theme = {
    "data-ui-theme": shell?.dataset.uiTheme,
    "data-color-mode": shell?.dataset.colorMode,
    "data-room-theme": shell?.dataset.roomTheme,
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
  const summary = summaryMetrics(telemetry).filter(
    (m) => m.id !== "provider" && m.id !== "models",
  );
  return (
    <>
      <span ref={source} hidden />
      {railVisible && !open && (
        <nav
          ref={rail}
          className={`health-indicator-rail${expanded ? " is-expanded" : ""}`}
          aria-label="Resource indicators"
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
            {minimizedBarToggle}
            {summary.map((m) => {
              const Icon = m.icon;
              const title = `${m.label}: ${m.value} · ${toneLabels[m.tone]}\n${m.detail}${m.at ? `\nUpdated ${new Date(m.at).toLocaleTimeString()}` : ""}`;
              return (
                <button
                  type="button"
                  key={m.id}
                  data-rail-id={m.id}
                  className={`health-indicator is-${m.tone}`}
                  aria-label={`${m.label}: ${m.value}, ${toneLabels[m.tone]}`}
                  title={title}
                  onClick={() => {
                    setSelected(m.id);
                    setOpen("resources");
                  }}
                >
                  <Icon aria-hidden="true" />
                  <strong>{m.tone === "unavailable" ? "—" : m.value}</strong>
                  <i className="health-dot" aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </nav>
      )}
      {open &&
        createPortal(
          <div className="health-theme-root" {...theme}>
            {open === "resources" ? (
              <HealthResources
                telemetry={telemetry}
                selected={selected}
                onSelect={setSelected}
                onClose={close}
                onOpen={(id) => {
                  const destination = id
                    ? summaryDestination(id)
                    : { section: "overview" as const };
                  setSection(destination.section);
                  setSelected(destination.metric ?? id ?? "cpu");
                  setOpen("health");
                }}
              />
            ) : (
              <HealthWindow
                telemetry={telemetry}
                section={section}
                onSection={setSection}
                selected={selected}
                onSelect={setSelected}
                onClose={close}
                thresholds={thresholds}
                onThresholds={save}
                onManage={
                  onManage
                    ? (id) => {
                        close();
                        onManage(id);
                      }
                    : undefined
                }
              />
            )}
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
