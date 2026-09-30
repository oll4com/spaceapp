import type { HealthTelemetry } from "../system-health/use-health-telemetry.js";
import { DEFAULT_AI_QUOTA_CONFIG } from "../desktop-widgets/widget-storage.js";
import {
  formatAppDateTime,
  useDateTimeSettings,
  type DateTimeSettings,
} from "../date-time-settings/date-time-settings.js";
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
  AntigravityUsageAccountList,
  ApiProviderAccountList,
  CliSessionReapResponse,
  CliSessionStats,
  CodexEnvironment,
  CodexResetCreditAvailability,
  CodexResetCreditRedemptionResponse,
  CodexUsageAccountList,
  HostMemoryDetails,
  MemoryReclaimResponse,
  ProviderSwitchResponse,
  ProviderSwitchTargets,
  SystemAnalyticsCliSessionsResponse,
  SystemAnalyticsModelsResponse,
  SystemAnalyticsResourcesResponse,
  ToolbarModelStats,
  ToolbarModelStatsModel,
} from "@space/contracts";
import type { SystemAnalyticsTab } from "../system-analytics/SystemAnalyticsWorkspace.js";
import { api, SpaceApiError } from "../../api.js";
import { DEMO_LOCAL_REPLY, getSpaceRuntime, getSpaceRuntimeKind } from "../../runtime/SpaceRuntime.js";
import { useAutoDismiss } from "../../use-auto-dismiss.js";
import { Activity, X } from "../ui-theme/app-icons.js";
import { ResourcesDrawer } from "./ResourcesDrawer.js";
import { ConfirmationDialog, MetricPopover } from "./MetricLayers.js";
import {
  CODEX_EXHAUSTION_THRESHOLD_PERCENT,
  QUOTA_EXHAUSTION_THRESHOLD_PERCENT,
  QUOTA_WARNING_THRESHOLD_PERCENT,
  QuotaTone,
  computeCodexCooldown,
  isCodexAccountActive,
  quotaTone,
} from "../system-health/health-model.js";
import { AiQuotaGaugeCard, toggleDesktopWidget } from "../desktop-widgets/index.js";
import "./toolbar-metrics.css";

type PanelKey = "accounts" | "cli" | "memory" | "cpu" | "rtt" | "provider" | "models";
type ConfirmationKind = "cli" | "memory";

export const TOOLBAR_MODEL_WINDOW_MINUTES = 10;

export function modelShortCode(modelId: string): string {
  const prefix = modelId.split("/").pop() ?? modelId;
  const lower = prefix.toLowerCase();
  const known: Array<[string, string]> = [
    ["deepseek-v4-flash-free", "DS4F"],
    ["deepseek-v4-flash", "DS4F"],
    ["deepseek", "DS"],
    ["gpt-5", "G5"],
    ["gpt-4", "G4"],
    ["kimi", "K"],
    ["gemini", "GM"],
    ["claude", "CL"],
    ["qwen", "QW"],
    ["grok", "GR"],
    ["glm", "GLM"],
    ["laguna", "LG"],
    ["ling", "LG"],
    ["mimo", "MM"],
    ["nemotron", "NM"],
    ["north", "NR"],
    ["big-pickle", "BP"]
  ];
  for (const [needle, code] of known) {
    if (lower.includes(needle)) return code;
  }
  return prefix.slice(0, 6).toUpperCase();
}

export interface ToolbarMetricsHandle {
  openResources(trigger?: HTMLButtonElement): void;
  openMetricDetails(panel: "accounts" | "provider" | "cli"): void;
  openCliCleanup(trigger?: HTMLButtonElement | null): void;
  openMemoryReclaim(trigger?: HTMLButtonElement | null): void;
}

export interface ToolbarMetricsClient {
  roundTrip(): Promise<number | null>;
  usageAccounts(): Promise<CodexUsageAccountList>;
  resetCredits(): Promise<CodexResetCreditAvailability>;
  redeemResetCredit(accountId: string, idempotencyKey: string): Promise<CodexResetCreditRedemptionResponse>;
  cliSessions(): Promise<CliSessionStats>;
  modelStats(roomId: string, windowMinutes: number): Promise<ToolbarModelStats>;
  reapCliSessions(): Promise<CliSessionReapResponse>;
  hostMemory(): Promise<HostMemoryDetails>;
  reclaimMemory(): Promise<MemoryReclaimResponse>;
  providerTargets(): Promise<ProviderSwitchTargets>;
  switchProvider(providerId: string): Promise<ProviderSwitchResponse>;
  analyticsResources?(): Promise<SystemAnalyticsResourcesResponse>;
  analyticsCliSessions?(): Promise<SystemAnalyticsCliSessionsResponse>;
  analyticsModels?(): Promise<SystemAnalyticsModelsResponse>;
  antigravityAccounts?(): Promise<AntigravityUsageAccountList>;
  apiProviderAccounts?(): Promise<ApiProviderAccountList>;
  reopenPane?(roomId: string, paneId: string): Promise<void>;
  reopenAllDetached?(): Promise<void>;
}

const defaultClient: ToolbarMetricsClient = {
  roundTrip: async () => {
    if (getSpaceRuntimeKind() === "demo") return null;
    const startedAt = performance.now();
    await api.healthPing();
    return Math.max(0, Math.round(performance.now() - startedAt));
  },
  usageAccounts: () => api.toolbarUsageAccounts(),
  antigravityAccounts: () => api.toolbarAntigravityUsageAccounts(),
  apiProviderAccounts: () => api.toolbarApiProviderAccounts(),
  resetCredits: () => api.toolbarResetCredits(),
  redeemResetCredit: (accountId, idempotencyKey) => api.redeemToolbarResetCredit(accountId, idempotencyKey),
  cliSessions: () => api.toolbarCliSessions(),
  modelStats: (roomId, windowMinutes) => api.toolbarModelStats(roomId, windowMinutes),
  reapCliSessions: () => api.reapToolbarCliSessions(),
  hostMemory: () => api.toolbarHostMemory(),
  reclaimMemory: () => api.reclaimToolbarMemory(),
  providerTargets: () => api.toolbarProviderTargets(),
  switchProvider: (providerId) => api.switchToolbarProvider(providerId),
  analyticsResources: () => api.systemAnalyticsResources("10m"),
  analyticsCliSessions: () => api.systemAnalyticsCliSessions("10m"),
  analyticsModels: () => api.systemAnalyticsModels("10m"),
  reopenPane: async (_roomId: string, paneId: string) => {
    await api.updatePane(paneId, { isClosed: false, isMinimized: false, status: "IDLE" });
  },
  reopenAllDetached: async () => {
    const res = await api.systemAnalyticsCliSessions("10m");
    const detached = res.sessions.filter((s) => s.status === "RUNNING" && s.attachmentCount === 0);
    for (const session of detached) {
      await api.updatePane(session.paneId, { isClosed: false, isMinimized: false, status: "IDLE" }).catch(() => null);
    }
  },
};

function useLazyResource<T>(loader: () => Promise<T>, ttlMs: number, shared?: T | null) {
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const loaderRef = useRef(loader);
  const dataRef = useRef<T | null>(null);
  const loadedAtRef = useRef(0);
  const inFlightRef = useRef<Promise<T | null> | null>(null);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  loaderRef.current = loader;

  useEffect(() => { if (shared !== undefined) { setData(shared); dataRef.current = shared; } }, [shared]);
  const load = useCallback((force = false) => {
    if (!force && sharedRef.current !== undefined) return Promise.resolve(sharedRef.current);
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

export function formatPercent(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? `${Math.round(value)}%` : "--";
}

export function formatWeeklyReset(value: string | null | undefined, settings?: DateTimeSettings): string {
  if (!value) return "week reset unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "week reset unavailable";
  const formatted = formatAppDateTime(date, {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }, settings);
  return `week resets ${formatted}`;
}

export function formatAccountReset(
  value: string | null | undefined,
  clock: number,
  prefix: string = "5h resets",
  settings?: DateTimeSettings,
): string {
  if (!value) return `${prefix} unavailable`;
  const targetMs = Date.parse(value);
  if (!Number.isFinite(targetMs)) return `${prefix} unavailable`;
  const diffMs = targetMs - clock;
  if (diffMs <= 0) return `${prefix}: ready`;
  const totalSeconds = Math.max(0, Math.round(diffMs / 1000));
  if (totalSeconds < 3 * 3600) {
    const mins = Math.max(1, Math.round(totalSeconds / 60));
    return `${prefix}: in ${mins}m`;
  }
  const formatted = formatWeeklyReset(value, settings).replace("week resets ", "");
  return `${prefix}: ${formatted}`;
}

export function formatBytes(value: number | null | undefined): string {
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
  const isCodexEnabled = environment?.isCodexEnabled ?? true;
  return {
    all: isCodexEnabled ? formatPercent(environment?.lbUsage?.allAccountsRemainingPercent) : "OFF",
    cli: host ? String(host.cliSessions.active) : "--",
    cpu: formatPercent(host?.cpu.usagePercent),
    provider: isCodexEnabled ? providerBadge(environment) : "OFF",
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

export function QuotaIndicator({
  value,
  label,
  alwaysWrap = true,
}: {
  value: number | null | undefined;
  label?: string;
  alwaysWrap?: boolean;
}) {
  const tone = quotaTone(value);
  const formatted = formatPercent(value);
  const title = tone === "critical"
    ? `${label ? `${label}: ` : ""}Exhausted (${formatted})`
    : tone === "warning"
      ? `${label ? `${label}: ` : ""}Near exhaustion (${formatted})`
      : tone === "healthy"
        ? `${label ? `${label}: ` : ""}Healthy (${formatted})`
        : undefined;

  if (!tone) {
    return alwaysWrap ? <strong>{formatted}</strong> : <>{formatted}</>;
  }

  return (
    <strong
      className={`toolbar-metric-quota-val is-${tone}`}
      title={title}
      aria-label={title}
    >
      <i className="toolbar-metric-quota-dot" aria-hidden="true" />
      {formatted}
    </strong>
  );
}

function MetricRow({ label, value, tone }: { label: string; value: string; tone?: QuotaTone }) {
  return (
    <div className="toolbar-metric-row">
      <span>{label}</span>
      {tone ? (
        <strong className={`toolbar-metric-quota-val is-${tone}`}>
          <i className="toolbar-metric-quota-dot" aria-hidden="true" />
          {value}
        </strong>
      ) : (
        <strong>{value}</strong>
      )}
    </div>
  );
}

export const ToolbarMetrics = forwardRef<ToolbarMetricsHandle, {
  presentation?: "strip" | "drawer" | "embedded";
  initialPanel?: PanelKey;
  sharedTelemetry?: HealthTelemetry;
  onOpenResources?: () => void;
  hideTrigger?: boolean;
  canManage?: boolean;
  allowChanges?: boolean;
  client?: ToolbarMetricsClient;
  environment: CodexEnvironment | null;
  onChanged?: () => void | Promise<void>;
  roomName?: string;
  roomId?: string | null;
  onOpenAnalytics?: (tab: SystemAnalyticsTab) => void;
  onReopenPane?: (roomId: string, paneId: string) => Promise<void> | void;
  onReopenAllDetached?: () => Promise<void> | void;
  onCloseSession?: (paneId: string) => Promise<void> | void;
}>(function ToolbarMetrics({
  presentation = "strip",
  initialPanel = "accounts",
  sharedTelemetry,
  onOpenResources,
  hideTrigger = false,
  canManage = true,
  allowChanges = canManage,
  client = defaultClient,
  environment,
  onChanged,
  roomName,
  roomId,
  onOpenAnalytics,
  onReopenPane,
  onReopenAllDetached,
  onCloseSession,
}, ref) {
  const isCodexEnabled = environment?.isCodexEnabled ?? true;
  const { settings: dateTimeSettings } = useDateTimeSettings();
  const accounts = useLazyResource(() => client.usageAccounts(), 60_000, sharedTelemetry?.accounts);
  const antigravityAccounts = useLazyResource(
    () => {
      if (client.antigravityAccounts) return client.antigravityAccounts();
      try {
        return api.toolbarAntigravityUsageAccounts();
      } catch {
        return Promise.resolve({
          data: [],
          pagination: { page: 1, pageSize: 0, totalItems: 0, totalPages: 0 },
          source: "space-gemini-profiles",
          isStale: false,
          error: null,
          checkedAt: new Date().toISOString(),
        });
      }
    },
    30_000, sharedTelemetry?.antigravityAccounts
  );
  const apiProviderAccounts = useLazyResource(
    () => {
      if (client.apiProviderAccounts) return client.apiProviderAccounts();
      try {
        return api.toolbarApiProviderAccounts();
      } catch {
        return Promise.resolve({
          data: [],
          pagination: { page: 1, pageSize: 0, totalItems: 0, totalPages: 0 },
          isStale: false,
          error: null,
          source: "mock",
          checkedAt: new Date().toISOString(),
        });
      }
    },
    30_000, sharedTelemetry?.apiProviderAccounts
  );
  const [chartsVisible, setChartsVisible] = useState(false);
  const [chartConfig, setChartConfig] = useState(DEFAULT_AI_QUOTA_CONFIG);
  const [quotaWindow, setQuotaWindow] = useState<"5h" | "weekly">("weekly");
  const [accountProviderFilter, setAccountProviderFilter] = useState<"all" | "antigravity" | "codex" | "api">(() => {
    try { const value = getSpaceRuntime().platform.localStorage.getItem("space:health-accounts:provider-filter");
      if (value === "all" || value === "antigravity" || value === "codex" || value === "api") return value;
    } catch { /* Storage can be unavailable. */ }
    return "all";
  });
  const [quotaFilter, setQuotaFilter] = useState(() => {
    try { return getSpaceRuntime().platform.localStorage.getItem("space:health-accounts:quota-filter") === "true"; } catch { return false; }
  });
  const [proFilter, setProFilter] = useState(() => {
    try { return getSpaceRuntime().platform.localStorage.getItem("space:health-accounts:pro-filter") === "true"; } catch { return false; }
  });
  const [geminiFilter, setGeminiFilter] = useState(() => {
    try { return getSpaceRuntime().platform.localStorage.getItem("space:health-accounts:gemini-filter") === "true"; } catch { return false; }
  });
  useEffect(() => {
    try {
      getSpaceRuntime().platform.localStorage.setItem("space:health-accounts:provider-filter", accountProviderFilter);
      getSpaceRuntime().platform.localStorage.setItem("space:health-accounts:quota-filter", String(quotaFilter));
      getSpaceRuntime().platform.localStorage.setItem("space:health-accounts:pro-filter", String(proFilter));
      getSpaceRuntime().platform.localStorage.setItem("space:health-accounts:gemini-filter", String(geminiFilter));
    } catch { /* Best effort persistence. */ }
  }, [accountProviderFilter, quotaFilter, proFilter, geminiFilter]);
  const hasQuota = (quota: { weeklyRemainingPercent?: number | null; fiveHourRemainingPercent?: number | null } | null | undefined) =>
    quota?.weeklyRemainingPercent != null && quota.weeklyRemainingPercent >= 1 && (quota.fiveHourRemainingPercent == null || quota.fiveHourRemainingPercent >= 1);
  const hasGemini = (account: { gemini?: { weeklyRemainingPercent?: number | null; fiveHourRemainingPercent?: number | null } | null }) =>
    quotaFilter ? hasQuota(account.gemini) : Boolean(account.gemini && (account.gemini.weeklyRemainingPercent != null || account.gemini.fiveHourRemainingPercent != null));
  const isProAccount = (account: { tier?: string | null }) =>
    Boolean(account.tier && account.tier.toLowerCase().includes("pro"));
  const isProCodexAccount = (account: { planType?: string | null }) =>
    Boolean(account.planType && account.planType.toLowerCase().includes("pro"));
  const resetCredits = useLazyResource(() => client.resetCredits(), 60_000);
  const cli = useLazyResource(() => client.cliSessions(), 5_000, sharedTelemetry?.sessions);
  const memory = useLazyResource(() => client.hostMemory(), 10_000);
  const providers = useLazyResource(() => client.providerTargets(), 10_000);
  const modelStats = useLazyResource(
    () => client.modelStats(roomId ?? "global", TOOLBAR_MODEL_WINDOW_MINUTES),
    30_000
  );
  const analyticsResources = useLazyResource(
    () => client.analyticsResources ? client.analyticsResources() : Promise.reject(new Error("Detailed resource analytics are unavailable.")),
    10_000
  );
  const analyticsSessions = useLazyResource(
    () => client.analyticsCliSessions ? client.analyticsCliSessions() : Promise.reject(new Error("Detailed CLI analytics are unavailable.")),
    10_000
  );
  const analyticsModels = useLazyResource(
    () => client.analyticsModels ? client.analyticsModels() : Promise.reject(new Error("Detailed model analytics are unavailable.")),
    30_000
  );
  const anchorsRef = useRef<Record<PanelKey, HTMLButtonElement | null>>({ accounts: null, cli: null, memory: null, cpu: null, rtt: null, provider: null, models: null });
  const closeTimerRef = useRef<number | null>(null);
  const resetInFlightRef = useRef(new Set<string>());
  const actionTriggerRef = useRef<HTMLButtonElement | null>(null);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const [activePanel, setActivePanel] = useState<PanelKey | null>(presentation === "embedded" ? initialPanel : null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);
  const telemetryVisible = presentation === "strip" || presentation === "embedded" || drawerOpen;
  const [confirmation, setConfirmation] = useState<ConfirmationKind | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const isExhausted = Boolean(
    accounts.data?.data.length &&
    !accounts.data.data.some((a) => isCodexAccountActive(a)),
  );
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    if (!telemetryVisible || (!isExhausted && activePanel !== "accounts")) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [telemetryVisible, isExhausted, activePanel]);
  const cooldown = computeCodexCooldown(accounts.data, environment, clock);
  useAutoDismiss(actionMessage, setActionMessage);
  const [providerMenuFocusRequested, setProviderMenuFocusRequested] = useState(false);
  const [providerSwitchingId, setProviderSwitchingId] = useState<string | null>(null);
  const [switchedProviderCode, setSwitchedProviderCode] = useState<string | null>(null);
  const [resetAttempts, setResetAttempts] = useState<Record<string, {
    idempotencyKey: string;
    status: "resetting" | "retry";
  }>>({});
  const [resetFeedback, setResetFeedback] = useState<{ accountId: string; message: string } | null>(null);
  const [rttMs, setRttMs] = useState<number | null>(null);
  const [rttFailed, setRttFailed] = useState(false);
  const [reopeningSessionId, setReopeningSessionId] = useState<string | null>(null);
  const [reopeningAll, setReopeningAll] = useState(false);
  const [closingSessionId, setClosingSessionId] = useState<string | null>(null);
  const snapshot = getToolbarMetricsSnapshot(environment);
  const providerCode = isCodexEnabled ? switchedProviderCode ?? snapshot.provider : "OFF";
  const visibleProviderTargets = providers.data?.data.filter((provider) => provider.isCurrent || provider.canSwitch) ?? [];
  const rtt = getToolbarRttPresentation(rttMs, rttFailed);
  const detailedModels = analyticsModels.data?.models ?? null;
  const badgeModels = detailedModels ?? modelStats.data?.models ?? null;
  const modelBadge = modelStats.error && analyticsModels.error
    ? "--"
    : badgeModels
      ? badgeModels.length === 0
        ? "0"
        : badgeModels.length === 1
          ? modelShortCode(badgeModels[0]!.modelId)
          : String(badgeModels.length)
      : modelStats.loading || analyticsModels.loading ? "…" : "--";

  const loadModels = useCallback(async (force = false) => {
    // Detailed analytics already supplies the badge and popover. Fetch the
    // legacy transcript collector only when that source is unavailable; on
    // HTTP/1.1 both requests otherwise occupy scarce browser connections.
    if (client.analyticsModels && await analyticsModels.load(force)) return;
    await modelStats.load(force);
  }, [analyticsModels.load, client, modelStats.load]);

  useEffect(() => setSwitchedProviderCode(null), [environment]);
  useEffect(() => {
    if (!canManage || !telemetryVisible || (presentation === "embedded" && activePanel !== "models")) return;
    let disposed = false;
    const load = () => {
      if (disposed || document.visibilityState !== "visible") return;
      void loadModels(true);
    };
    load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [canManage, loadModels, telemetryVisible, presentation, activePanel]);
  useEffect(() => {
    if (isCodexEnabled) return;
    setActivePanel((current) => current === "accounts" || current === "provider" ? null : current);
    setProviderMenuFocusRequested(false);
  }, [isCodexEnabled]);
  useEffect(() => {
    if (!telemetryVisible || presentation === "embedded") return;
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
  }, [client, telemetryVisible, presentation]);
  useEffect(() => {
    if (!providerMenuFocusRequested || !providers.data) return;
    providerMenuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [providerMenuFocusRequested, providers.data]);
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
    setProviderMenuFocusRequested(false);
  }, [cancelClose]);

  const requestClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = window.setTimeout(closePanel, 140);
  }, [cancelClose, closePanel]);

  function loadPanel(panel: PanelKey) {
    switch (panel) {
      case "accounts":
        void resetCredits.load();
        void antigravityAccounts.load();
        void apiProviderAccounts.load();
        return accounts.load();
      case "cli": return Promise.all([cli.load(), analyticsSessions.load()]);
      case "memory": return Promise.all([memory.load(), analyticsResources.load()]);
      case "cpu": return Promise.all([memory.load(), analyticsResources.load()]);
      case "rtt": return Promise.resolve();
      case "models": return loadModels();
      case "provider": return providers.load();
    }
  }

  function openPanel(panel: PanelKey) {
    if (!isCodexEnabled && panel === "provider") return;
    cancelClose();
    setActivePanel(panel);
    if (canManage) void loadPanel(panel);
  }

  const openConfirmation = useCallback((kind: ConfirmationKind, trigger?: HTMLButtonElement | null) => {
    if (!canManage || !allowChanges) return;
    actionTriggerRef.current = trigger ?? anchorsRef.current[kind === "cli" ? "cli" : "memory"];
    setActionMessage(null);
    setConfirmation(kind);
  }, [canManage, allowChanges]);

  useEffect(() => {
    const dismiss = () => { setDrawerOpen(false); setActivePanel(null); };
    window.addEventListener("space:navigation-open", dismiss);
    return () => window.removeEventListener("space:navigation-open", dismiss);
  }, []);
  useEffect(() => {
    if (presentation === "embedded") openPanel(initialPanel);
  }, [presentation, initialPanel]);
  useImperativeHandle(ref, () => ({
    openResources: (trigger) => {
      if (trigger) drawerTriggerRef.current = trigger;
      setDrawerOpen(true);
      if (!activePanel) openPanel("accounts");
    },
    openMetricDetails: (panel) => { setDrawerOpen(true); openPanel(panel); },
    openCliCleanup: (trigger) => openConfirmation("cli", trigger),
    openMemoryReclaim: (trigger) => openConfirmation("memory", trigger),
  }), [openConfirmation, activePanel]);

  function closeConfirmation() {
    setConfirmation(null);
    window.setTimeout(() => actionTriggerRef.current?.focus(), 0);
  }

  async function confirmAction() {
    if (!confirmation || actionBusy || !allowChanges || !canManage) return;
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
    if (!isCodexEnabled || providerSwitchingId || !allowChanges || !canManage) return;
    const target = providers.data?.data.find((item) => item.providerId === providerId);
    setProviderSwitchingId(providerId);
    setActionMessage(null);
    try {
      const result = await client.switchProvider(providerId);
      setSwitchedProviderCode(providerBadgeFromSwitch(result));
      setActionMessage(result.status === "SWITCHED"
        ? `Provider switched to ${target?.displayName ?? providerId}.`
        : "Provider route unchanged; no external route was modified.");
      closePanel();
      await providers.load(true);
      await onChanged?.();
    } catch (reason) {
      setActionMessage(reason instanceof Error ? reason.message : "Provider switch failed; the previous route remains active.");
    } finally {
      setProviderSwitchingId(null);
    }
  }

  async function handleReopenSession(targetRoomId: string, targetPaneId: string, sessionId: string) {
    setReopeningSessionId(sessionId);
    try {
      if (onReopenPane) {
        await onReopenPane(targetRoomId, targetPaneId);
      } else if (client.reopenPane) {
        await client.reopenPane(targetRoomId, targetPaneId);
      } else {
        await api.updatePane(targetPaneId, { isClosed: false, isMinimized: false, status: "IDLE" });
        await onChanged?.();
      }
      if (presentation === "drawer") {
        setDrawerOpen(false);
        closePanel();
      }
      void cli.load(true);
      void analyticsSessions.load(true);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to reopen window");
    } finally {
      setReopeningSessionId(null);
    }
  }

  async function handleReopenAllDetached() {
    setReopeningAll(true);
    try {
      if (onReopenAllDetached) {
        await onReopenAllDetached();
      } else if (client.reopenAllDetached) {
        await client.reopenAllDetached();
      } else {
        const detached = (analyticsSessions.data?.sessions ?? []).filter((s) => s.status === "RUNNING" && s.attachmentCount === 0);
        for (const s of detached) {
          await api.updatePane(s.paneId, { isClosed: false, isMinimized: false, status: "IDLE" }).catch(() => null);
        }
        await onChanged?.();
      }
      if (presentation === "drawer") {
        setDrawerOpen(false);
        closePanel();
      }
      void cli.load(true);
      void analyticsSessions.load(true);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to reopen detached windows");
    } finally {
      setReopeningAll(false);
    }
  }

  async function handleCloseSession(paneId: string, sessionId: string) {
    setClosingSessionId(sessionId);
    try {
      if (onCloseSession) {
        await onCloseSession(paneId);
      } else {
        await api.closePane(paneId);
      }
      void cli.load(true);
      void analyticsSessions.load(true);
    } catch (err) {
      setActionMessage(err instanceof Error ? err.message : "Failed to close session");
    } finally {
      setClosingSessionId(null);
    }
  }

  function resetLabel(accountId: string): { disabled: boolean; label: string } {
    const attempt = resetAttempts[accountId];
    if (attempt?.status === "resetting") return { disabled: true, label: "Resetting…" };
    if (attempt?.status === "retry") return { disabled: false, label: "Retry reset" };
    if (resetCredits.loading || (!resetCredits.data && !resetCredits.error)) {
      return { disabled: true, label: "Resets …" };
    }
    const availability = resetCredits.data?.data.find((item) => item.accountId === accountId);
    if (resetCredits.error || resetCredits.data?.error || availability?.availableCreditCount == null) {
      return { disabled: true, label: "Resets —" };
    }
    return {
      disabled: availability.availableCreditCount === 0,
      label: `Resets ${availability.availableCreditCount}`,
    };
  }

  function redemptionMessage(result: CodexResetCreditRedemptionResponse): string {
    if (client === defaultClient && getSpaceRuntimeKind() === "demo") return DEMO_LOCAL_REPLY;
    switch (result.outcome) {
      case "RESET": return "Reset credit applied. Usage and credits were refreshed.";
      case "ALREADY_REDEEMED": return "Reset was already applied. Usage and credits were refreshed.";
      case "NOTHING_TO_RESET": return "The account no longer needs a reset. Usage and credits were refreshed.";
      case "NO_CREDIT": return "No reset credit is currently available. Usage and credits were refreshed.";
    }
  }

  async function redeemReset(accountId: string) {
    if (!isCodexEnabled || resetInFlightRef.current.has(accountId) || !allowChanges || !canManage) return;
    const retainedAttempt = resetAttempts[accountId];
    const idempotencyKey = retainedAttempt?.status === "retry"
      ? retainedAttempt.idempotencyKey
      : globalThis.crypto.randomUUID();
    resetInFlightRef.current.add(accountId);
    setResetAttempts((current) => ({
      ...current,
      [accountId]: { idempotencyKey, status: "resetting" },
    }));
    setResetFeedback(null);
    try {
      const result = await client.redeemResetCredit(accountId, idempotencyKey);
      const successMessage = redemptionMessage(result);
      setResetFeedback({ accountId, message: successMessage });
      try {
        await Promise.all([resetCredits.load(true), accounts.load(true)]);
        await onChanged?.();
      } catch (refreshError) {
        const refreshMessage = refreshError instanceof Error
          ? refreshError.message
          : "Latest usage samples could not be refreshed.";
        setResetFeedback({
          accountId,
          message: `${successMessage} Refresh warning: ${refreshMessage}`,
        });
      }
      setResetAttempts((current) => {
        const next = { ...current };
        delete next[accountId];
        return next;
      });
    } catch (reason) {
      if (reason instanceof SpaceApiError && reason.code === "CODEX_RESET_OUTCOME_UNKNOWN") {
        setResetAttempts((current) => ({
          ...current,
          [accountId]: { idempotencyKey, status: "retry" },
        }));
        setResetFeedback({
          accountId,
          message: "The reset result is unknown. Retry reset to safely check the same request.",
        });
      } else {
        setResetAttempts((current) => {
          const next = { ...current };
          delete next[accountId];
          return next;
        });
        setResetFeedback({
          accountId,
          message: reason instanceof Error ? reason.message : "Reset credit redemption failed.",
        });
      }
    } finally {
      resetInFlightRef.current.delete(accountId);
    }
  }

  const host = environment?.hostStats;
  const ramValue = snapshot.ram;
  const cpuValue = snapshot.cpu;

  function anchorEvents(panel: PanelKey) {
    if (presentation === "drawer") return {};
    const hoverOpen = panel !== "cpu";
    return {
      onMouseEnter: hoverOpen ? () => openPanel(panel) : undefined,
      onMouseLeave: requestClose,
      onFocus: hoverOpen ? () => openPanel(panel) : undefined,
      onBlur: requestClose,
    };
  }

  function panelContent() {
    const analysisButton = (target: SystemAnalyticsTab, label: string) => onOpenAnalytics ? (
      <button
        type="button"
        className="toolbar-metric-open-analysis"
        onClick={() => {
          setDrawerOpen(false);
          closePanel();
          onOpenAnalytics(target);
        }}
      >{label}</button>
    ) : null;
    if (activePanel === "rtt") return (
      <>
        <header><strong>Round-trip latency</strong><small>Live</small></header>
        <div className="toolbar-metric-grid">
          <MetricRow
            label="Current"
            value={rttFailed ? "Unavailable" : rttMs === null ? "Measuring…" : `${rtt.value} ms`}
          />
          <MetricRow label="Status" value={rtt.status === "critical" ? "Alert" : `${rtt.status[0]?.toUpperCase()}${rtt.status.slice(1)}`} />
          <MetricRow label="Warning at" value="300 ms" />
          <MetricRow label="Alert at" value="425 ms" />
          <MetricRow label="Probe" value="Browser → API" />
          <MetricRow label="Refresh" value="Every 10 sec" />
        </div>
        <p className="toolbar-metric-note">Measured while this browser tab is visible.</p>
      </>
    );
    if (!canManage) return <p className="toolbar-metric-note">ADMIN access is required for detailed system telemetry and actions.</p>;
    if (activePanel === "accounts") return (
      <>
        {cooldown && <p role="status">Next Codex account available: {cooldown.accountLabel} in {cooldown.formatted}</p>}
        <div className="toolbar-metric-provider-tabs" role="tablist" aria-label="Account providers">
          <button
            type="button"
            role="tab"
            aria-selected={accountProviderFilter === "all"}
            className={`toolbar-metric-tab-btn ${accountProviderFilter === "all" ? "is-active" : ""}`}
            onClick={() => setAccountProviderFilter("all")}
          >All Providers</button>
          <button
            type="button"
            role="tab"
            aria-selected={accountProviderFilter === "antigravity"}
            className={`toolbar-metric-tab-btn ${accountProviderFilter === "antigravity" ? "is-active" : ""}`}
            onClick={() => setAccountProviderFilter("antigravity")}
          >Antigravity (Google)</button>
          <button
            type="button"
            role="tab"
            aria-selected={accountProviderFilter === "codex"}
            className={`toolbar-metric-tab-btn ${accountProviderFilter === "codex" ? "is-active" : ""}`}
            onClick={() => setAccountProviderFilter("codex")}
          >Codex</button>
          <button
            type="button"
            role="tab"
            aria-selected={accountProviderFilter === "api"}
            className={`toolbar-metric-tab-btn ${accountProviderFilter === "api" ? "is-active" : ""}`}
            onClick={() => setAccountProviderFilter("api")}
          >API Providers</button>
        </div>

        <div className="resources-quota-window" role="group" aria-label="Quota period">
          <button type="button" className={quotaWindow === "5h" ? "is-active" : ""} aria-pressed={quotaWindow === "5h"} onClick={() => setQuotaWindow("5h")}>5h</button>
          <button type="button" className={quotaWindow === "weekly" ? "is-active" : ""} aria-pressed={quotaWindow === "weekly"} onClick={() => setQuotaWindow("weekly")}>Week</button>
        </div>
        <div className="resources-quota-filters" role="group" aria-label="Account filters">
          <button type="button" className={quotaFilter ? "is-active" : ""} aria-pressed={quotaFilter} onClick={() => setQuotaFilter(value => !value)}>5h &amp; week &gt; 1%</button>
          {accountProviderFilter === "antigravity" && (
            <>
              <button type="button" className={proFilter ? "is-active" : ""} aria-pressed={proFilter} onClick={() => setProFilter(value => !value)}>Pro accounts</button>
              <button type="button" className={geminiFilter ? "is-active" : ""} aria-pressed={geminiFilter} onClick={() => setGeminiFilter(value => !value)}>Gemini only</button>
            </>
          )}
        </div>
        <details className="resources-charts" onToggle={e => setChartsVisible(e.currentTarget.open)}><summary>Charts & floating monitor</summary>
          {chartsVisible && <AiQuotaGaugeCard embedded={true} hideScopeControls externalConfig={{ ...chartConfig, activeTab: accountProviderFilter, windowMode: quotaWindow }} onUpdateConfig={patch => { setChartConfig(config => ({ ...config, ...patch })); if (patch.activeTab) setAccountProviderFilter(patch.activeTab); if (patch.windowMode) setQuotaWindow(patch.windowMode); }} onOpenDesktopWidget={() => toggleDesktopWidget("ai-quota")} />}
        </details>

        {(accountProviderFilter === "all" || accountProviderFilter === "antigravity") && (
          <div className="toolbar-metric-provider-section">
            <header>
              <strong>Antigravity (Google)</strong>
              <small>{antigravityAccounts.data?.isStale ? "Stale sample" : "Source: space-gemini-profiles"}</small>
            </header>
            {antigravityAccounts.loading ? <p className="toolbar-metric-note">Loading Antigravity accounts…</p> : null}
            {antigravityAccounts.error ? <p className="toolbar-metric-error" role="alert">{antigravityAccounts.error}</p> : null}
            {antigravityAccounts.data?.error ? <p className="toolbar-metric-error">{antigravityAccounts.data.error}</p> : null}
            {antigravityAccounts.data ? (
              <ul className="toolbar-metric-list">
                {antigravityAccounts.data.data
                  .filter(account => !quotaFilter || (geminiFilter ? hasQuota(account.gemini) : (hasQuota(account.gemini) || hasQuota(account.claude))))
                  .filter(account => !proFilter || isProAccount(account))
                  .filter(account => !geminiFilter || hasGemini(account))
                  .map((account) => (
                  <li key={account.id} className="toolbar-metric-account-card">
                    <div className="toolbar-metric-account-heading">
                      <strong>{account.label || account.email}</strong>
                      <span className={`toolbar-metric-badge ${account.status === "CONNECTED" ? "is-active" : account.status === "UNLICENSED" ? "is-warning" : "is-critical"}`}>
                        {account.tier ? `${account.tier} · ` : ""}{account.status === "CONNECTED" ? "Connected" : account.status === "UNLICENSED" ? "Unlicensed" : account.status.toLowerCase() === "critical" ? "Unavailable" : account.status}
                      </span>
                    </div>
                    {account.email && account.label !== account.email ? (
                      <small className="toolbar-metric-subtext">{account.email}</small>
                    ) : null}
                    {account.status === "UNLICENSED" ? (
                      <span className="toolbar-metric-dim">No quota allocation for unlicensed profile</span>
                    ) : (
                      <div className="toolbar-metric-quotas">
                        {(!quotaFilter || hasQuota(account.gemini)) && <div className="toolbar-metric-quota-item is-gemini">
                          <span>Gemini {quotaWindow === "5h" ? "5h" : "weekly"} remaining <QuotaIndicator value={quotaWindow === "5h" ? account.gemini?.fiveHourRemainingPercent : account.gemini?.weeklyRemainingPercent} label="Gemini remaining" /></span>
                          {account.gemini?.fiveHourResetAt ? (
                            <small className={`toolbar-metric-subtext${(account.gemini.fiveHourRemainingPercent ?? 100) <= QUOTA_EXHAUSTION_THRESHOLD_PERCENT ? " is-critical" : (account.gemini.fiveHourRemainingPercent ?? 100) <= QUOTA_WARNING_THRESHOLD_PERCENT ? " is-warning" : ""}`}>{formatAccountReset(account.gemini.fiveHourResetAt, clock, "5h resets", dateTimeSettings)}</small>
                          ) : null}
                          {account.gemini?.weeklyResetAt ? (
                            <small className="toolbar-metric-subtext">{formatWeeklyReset(account.gemini.weeklyResetAt, dateTimeSettings)}</small>
                          ) : null}
                        </div>}
                        {!geminiFilter && (!quotaFilter || hasQuota(account.claude)) && <div className="toolbar-metric-quota-item is-claude">
                          <span>Claude {quotaWindow === "5h" ? "5h" : "weekly"} remaining <QuotaIndicator value={quotaWindow === "5h" ? account.claude?.fiveHourRemainingPercent : account.claude?.weeklyRemainingPercent} label="Claude remaining" /></span>
                          {account.claude?.fiveHourResetAt ? (
                            <small className={`toolbar-metric-subtext${(account.claude.fiveHourRemainingPercent ?? 100) <= QUOTA_EXHAUSTION_THRESHOLD_PERCENT ? " is-critical" : (account.claude.fiveHourRemainingPercent ?? 100) <= QUOTA_WARNING_THRESHOLD_PERCENT ? " is-warning" : ""}`}>{formatAccountReset(account.claude.fiveHourResetAt, clock, "5h resets", dateTimeSettings)}</small>
                          ) : null}
                          {account.claude?.weeklyResetAt ? (
                            <small className="toolbar-metric-subtext">{formatWeeklyReset(account.claude.weeklyResetAt, dateTimeSettings)}</small>
                          ) : null}
                        </div>}
                      </div>
                    )}
                  </li>
                ))}
                {!antigravityAccounts.data.data.filter(account => (!quotaFilter || (geminiFilter ? hasQuota(account.gemini) : (hasQuota(account.gemini) || hasQuota(account.claude)))) && (!proFilter || isProAccount(account)) && (!geminiFilter || hasGemini(account))).length ? (
                  <li><span>{antigravityAccounts.data.data.length ? "No accounts match the active filters." : "No Antigravity accounts configured."}</span></li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}

        {(accountProviderFilter === "all" || accountProviderFilter === "codex") && (
          <div className="toolbar-metric-provider-section">
            <header>
              <strong>Codex usage</strong>
              <small>{accounts.data?.isStale ? "Stale sample" : "On demand"}</small>
            </header>
            <div className="toolbar-metric-grid">
              <MetricRow
                label="Routing capacity · all accounts"
                value={formatPercent(environment?.lbUsage?.allAccountsRemainingPercent)}
                tone={quotaTone(environment?.lbUsage?.allAccountsRemainingPercent)}
              />
              <MetricRow
                label="Routing capacity · active accounts"
                value={formatPercent(environment?.lbUsage?.activeAccountsRemainingPercent)}
                tone={quotaTone(environment?.lbUsage?.activeAccountsRemainingPercent)}
              />
            </div>
            {accounts.loading ? <p className="toolbar-metric-note">Loading account details…</p> : null}
            {accounts.error ? <p className="toolbar-metric-error" role="alert">{accounts.error}</p> : null}
            {accounts.data?.error ? <p className="toolbar-metric-error">{accounts.data.error}</p> : null}
            {accounts.data ? (
              <ul className="toolbar-metric-list">
                {accounts.data.data
                  .filter(account => !quotaFilter || hasQuota(account))
                  .map((account) => (
                  <li key={account.id} className="toolbar-metric-account-card">
                    <div className="toolbar-metric-account-heading">
                      <strong>{account.label}</strong>
                      <button
                        type="button"
                        disabled={!allowChanges || resetLabel(account.id).disabled}
                        title={resetLabel(account.id).disabled ? undefined : `Use the earliest-expiring reset credit for ${account.label}`}
                        onClick={() => void redeemReset(account.id)}
                      >{resetLabel(account.id).label}</button>
                    </div>
                    <span>{quotaWindow === "5h" ? "5h remaining " : "Weekly remaining "}<QuotaIndicator value={quotaWindow === "5h" ? account.fiveHourRemainingPercent : account.weeklyRemainingPercent} label={quotaWindow} alwaysWrap={false} /></span>
                    <span>{formatWeeklyReset(account.weeklyResetAt, dateTimeSettings)}</span>
                    {account.fiveHourResetAt && (account.fiveHourRemainingPercent ?? 0) < CODEX_EXHAUSTION_THRESHOLD_PERCENT ? (
                      <span>{formatAccountReset(account.fiveHourResetAt, clock, "5h resets", dateTimeSettings)}</span>
                    ) : null}
                  </li>
                ))}
                {!accounts.data.data.filter(account => !quotaFilter || hasQuota(account)).length ? <li><span>{accounts.data.data.length ? "No accounts match the active filters." : "No enabled account samples."}</span></li> : null}
              </ul>
            ) : null}
            {resetFeedback ? (
              <p className="toolbar-metric-reset-status" role="status" aria-live="polite">
                {resetFeedback.message}
              </p>
            ) : null}
          </div>
        )}

        {(accountProviderFilter === "all" || accountProviderFilter === "api") && (
          <div className="toolbar-metric-provider-section">
            <header>
              <strong>API Providers &amp; Balances</strong>
              <small>{apiProviderAccounts.data?.isStale ? "Stale sample" : "DeepSeek, OpenRouter, Vercel, Google & API keys"}</small>
            </header>
            {apiProviderAccounts.loading ? <p className="toolbar-metric-note">Loading API provider details…</p> : null}
            {apiProviderAccounts.error ? <p className="toolbar-metric-error" role="alert">{apiProviderAccounts.error}</p> : null}
            {apiProviderAccounts.data?.error ? <p className="toolbar-metric-error">{apiProviderAccounts.data.error}</p> : null}
            {apiProviderAccounts.data ? (
              <ul className="toolbar-metric-list">
                {apiProviderAccounts.data.data.map((account) => (
                  <li key={account.id} className="toolbar-metric-account-card">
                    <div className="toolbar-metric-account-heading">
                      <strong>{account.label}</strong>
                      <span className={`toolbar-metric-badge ${account.status === "CONNECTED" ? "is-active" : account.status === "EXHAUSTED" ? "is-warning" : "is-critical"}`}>
                        {account.balance ? `BAL ${account.balance}` : account.status.toLowerCase() === "critical" ? "Unavailable" : account.status}
                      </span>
                    </div>
                    {account.detail ? (
                      <small className="toolbar-metric-subtext">{account.detail}</small>
                    ) : null}
                  </li>
                ))}
                {!apiProviderAccounts.data.data.length ? (
                  <li><span>No API providers configured.</span></li>
                ) : null}
              </ul>
            ) : null}
          </div>
        )}
      </>
    );
    if (activePanel === "cli") {
      const detachedCount = cli.data?.summary.detached ?? 0;
      const detachedSessions = (analyticsSessions.data?.sessions ?? []).filter((s) => s.status === "RUNNING" && s.attachmentCount === 0);
      const hasDetached = detachedCount > 0 || detachedSessions.length > 0;
      return (
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
            {hasDetached ? (
              <div className="toolbar-metric-detached-banner">
                <span>{detachedCount || detachedSessions.length} detached window{(detachedCount || detachedSessions.length) === 1 ? "" : "s"}</span>
                <button
                  type="button"
                  className="toolbar-metric-reopen-all-btn"
                  disabled={reopeningAll}
                  onClick={() => void handleReopenAllDetached()}
                >
                  {reopeningAll ? "Reopening…" : "Reopen detached"}
                </button>
              </div>
            ) : null}
            <ul className="toolbar-metric-list">
              {(analyticsSessions.data?.sessions ?? []).slice(0, 8).map((session) => {
                const isDetached = session.status === "RUNNING" && session.attachmentCount === 0;
                const isBusy = reopeningSessionId === session.sessionId || closingSessionId === session.sessionId;
                return (
                  <li key={session.sessionId}>
                    <div className="toolbar-metric-session-header">
                      <strong>{session.paneTitle} · {formatBytes(session.rssBytes)}</strong>
                      {isDetached ? (
                        <div className="health-session-actions">
                          <button
                            type="button"
                            className="toolbar-metric-reopen-btn"
                            disabled={isBusy}
                            onClick={() => void handleReopenSession(session.roomId, session.paneId, session.sessionId)}
                            title={`Reopen window for ${session.paneTitle}`}
                          >
                            {reopeningSessionId === session.sessionId ? "Reopening…" : "Reopen"}
                          </button>
                          <button
                            type="button"
                            className="toolbar-metric-close-btn"
                            disabled={isBusy}
                            onClick={() => void handleCloseSession(session.paneId, session.sessionId)}
                            title={`Close and terminate ${session.paneTitle}`}
                          >
                            {closingSessionId === session.sessionId ? "Closing…" : "Close"}
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <span>{session.roomName} · {session.runtimeName} · {session.attachmentCount} attachment{session.attachmentCount === 1 ? "" : "s"}{isDetached ? " · detached" : ""}</span>
                  </li>
                );
              })}
              {!analyticsSessions.data && cli.data.sessions.map((session) => <li key={`${session.hostId}:${session.sessionId}`}>
                <strong>{session.hostId.toUpperCase()} · {formatBytes(session.rssBytes)}</strong>
                <span>{session.attachmentCount} attachments · {session.cleanupEligible ? "eligible" : "protected"}</span>
              </li>)}
            </ul>
            {analysisButton("sessions", "Open full CLI session analysis")}
          </> : null}
        </>
      );
    }
    if (activePanel === "memory") return (
      <>
        <header><strong>Host memory</strong><small>On demand</small></header>
        {memory.loading ? <p className="toolbar-metric-note">Loading memory details…</p> : null}
        {memory.error ? <p className="toolbar-metric-error" role="alert">{memory.error}</p> : null}
        {memory.data ? <>
          <div className="toolbar-metric-grid">
            <MetricRow label="Used" value={`${formatPercent(memory.data.memory.usagePercent)} · ${formatBytes(memory.data.memory.usedBytes)}`} />
            <MetricRow label="Available" value={formatBytes(memory.data.memory.availableBytes)} />
            <MetricRow label="Swap" value={`${formatPercent(memory.data.swap.usagePercent)} · ${formatBytes(memory.data.swap.usedBytes)} of ${formatBytes(memory.data.swap.totalBytes)}`} />
            <MetricRow label="Page cache" value={formatBytes(memory.data.memory.pageCacheBytes)} />
            <MetricRow label="Pressure" value={memory.data.pressure.isUnderPressure ? "Yes" : "No"} />
          </div>
          <strong className="toolbar-metric-subtitle">Top processes</strong>
          <ul className="toolbar-metric-list">
            {analyticsResources.data?.entities.slice(0, 8).map((entity) => <li key={`${entity.entityType}:${entity.entityId}`}>
              <strong>{entity.paneTitle ?? entity.runtimeName ?? entity.entityId} · {formatBytes(entity.rssBytes)}</strong>
              <span>{entity.roomName ?? "Shared runtime"} · {entity.runtimeName ?? entity.runtimeId ?? "unknown"} · {entity.processCount} processes</span>
            </li>)}
            {!analyticsResources.data ? (() => {
              const memoryData = memory.data;
              if (!memoryData) return null;
              return memoryData.topProcesses.map((process) => {
                const sharePercent = memoryData.memory.usedBytes > 0
                  ? Math.round((process.rssBytes / memoryData.memory.usedBytes) * 100)
                  : 0;
                return <li key={process.pid}>
                  <strong>{process.name}{process.taskTitle ? ` · ${process.taskTitle}` : ""}</strong>
                  <span>{formatBytes(process.rssBytes)} · {sharePercent}% of used · {process.state}</span>
                </li>;
              });
            })() : null}
            {!analyticsResources.data?.entities.length && !memory.data?.topProcesses.length ? <li><span>No process sample available.</span></li> : null}
          </ul>
          <p className="toolbar-metric-note">Top processes are the largest contributors to the used total above.</p>
          {analysisButton("resources", "Open full RAM analysis")}
        </> : null}
      </>
    );
    if (activePanel === "cpu") return (
      <>
        <header><strong>Host CPU</strong><small>On demand</small></header>
        {memory.loading ? <p className="toolbar-metric-note">Loading CPU details…</p> : null}
        {memory.error ? <p className="toolbar-metric-error" role="alert">{memory.error}</p> : null}
        {memory.data ? <>
          <div className="toolbar-metric-grid">
            <MetricRow label="Usage" value={formatPercent(host?.cpu.usagePercent)} />
            <MetricRow label="Cores" value={host?.cpu.coreCount != null ? String(host.cpu.coreCount) : "--"} />
            <MetricRow label="RAM" value={`${formatPercent(memory.data.memory.usagePercent)} · ${formatBytes(memory.data.memory.usedBytes)} of ${formatBytes(memory.data.memory.totalBytes)}`} />
          </div>
          <strong className="toolbar-metric-subtitle">Top processes by CPU</strong>
          <ul className="toolbar-metric-list">
            {analyticsResources.data?.entities.slice().sort((left, right) => right.cpuOneCorePercent - left.cpuOneCorePercent).slice(0, 8).map((entity) => <li key={`cpu:${entity.entityType}:${entity.entityId}`}>
              <strong>{entity.paneTitle ?? entity.runtimeName ?? entity.entityId}</strong>
              <span>{entity.roomName ?? "Shared runtime"} · CPU {entity.cpuOneCorePercent.toFixed(1)}% · {formatBytes(entity.rssBytes)}</span>
            </li>)}
            {!analyticsResources.data ? (() => {
              const memoryData = memory.data;
              if (!memoryData) return null;
              return memoryData.topCpuProcesses.map((process) => (
                <li key={`cpu:${process.pid}`}>
                  <strong>{process.name}{process.taskTitle ? ` · ${process.taskTitle}` : ""}</strong>
                  <span>CPU {formatPercent(process.cpuPercent)} · {formatBytes(process.rssBytes)} · {process.state}</span>
                </li>
              ));
            })() : null}
            {!analyticsResources.data?.entities.length && !memory.data?.topCpuProcesses.length ? <li><span>No process sample available.</span></li> : null}
          </ul>
          <p className="toolbar-metric-note">Top processes are the highest CPU consumers at sample time.</p>
          {analysisButton("resources", "Open full CPU analysis")}
        </> : null}
      </>
    );
    if (activePanel === "models") return (
      <>
        <header><strong>Active models</strong><small>Last {TOOLBAR_MODEL_WINDOW_MINUTES} min</small></header>
        {modelStats.loading || analyticsModels.loading ? <p className="toolbar-metric-note">Loading model activity…</p> : null}
        {analyticsModels.data ? <>
          <div className="toolbar-metric-grid">
            <MetricRow label="Models" value={String(analyticsModels.data.models.length)} />
            <MetricRow label="Providers" value={String(analyticsModels.data.providers.length)} />
            <MetricRow label="Active sessions" value={String(analyticsModels.data.models.reduce((sum, model) => sum + model.activeSessions, 0))} />
          </div>
          {analyticsModels.data.models.length ? <ul className="toolbar-metric-list">
            {analyticsModels.data.models.slice(0, 10).map((model) => (
              <li key={`${model.providerId}:${model.modelId}`}>
                <strong>{model.modelId}</strong>
                <span>
                  {model.providerId} · {model.coverage.replace("_", " ")} · {model.activeSessions} session{model.activeSessions === 1 ? "" : "s"}
                  {" "}· {model.completedTurns} completed / {model.activeTurns} active
                  {" "}· TTFT {model.avgTtftMs === null ? "—" : `${Math.round(model.avgTtftMs)} ms`}
                  {" "}· {model.avgTokPerSec === null ? "—" : `${Math.round(model.avgTokPerSec * 10) / 10} tok/s`}
                </span>
              </li>
            ))}
          </ul> : <p className="toolbar-metric-note">No model activity in the last {TOOLBAR_MODEL_WINDOW_MINUTES} minutes.</p>}
          {analyticsModels.data.backfill.errors.length ? <p className="toolbar-metric-error">
            {analyticsModels.data.backfill.errors.join(" · ")}
          </p> : null}
          <p className="toolbar-metric-note">All running CLI models are included. Native tokens and timing are shown only where the CLI exposes them.</p>
          {analysisButton("models", "Open full model analysis")}
        </> : modelStats.data ? <>
          <div className="toolbar-metric-grid">
            <MetricRow label="Models" value={String(modelStats.data.models.length)} />
            <MetricRow label="Sources" value={modelStats.data.sources.length > 0 ? modelStats.data.sources.join(", ") : "—"} />
            <MetricRow label="Window" value={`${modelStats.data.windowMinutes} min`} />
          </div>
          {modelStats.data.models.length ? <ul className="toolbar-metric-list">
            {modelStats.data.models.map((model: ToolbarModelStatsModel) => (
              <li key={`${model.source}:${model.modelId}`}>
                <strong>{model.modelId}</strong>
                <span>
                  {model.turns} turn{model.turns === 1 ? "" : "s"} · TTFT {model.avgTtftMs === null ? "—" : `${Math.round(model.avgTtftMs)} ms`}
                  {" "}· {model.avgTokPerSec === null ? "—" : `${Math.round(model.avgTokPerSec * 10) / 10} tok/s`}
                  {" "}· {model.tokensIn.toLocaleString()} in / {model.tokensOut.toLocaleString()} out
                </span>
              </li>
            ))}
          </ul> : <p className="toolbar-metric-note">No model activity in the last {TOOLBAR_MODEL_WINDOW_MINUTES} minutes.</p>}
          {modelStats.data.errors.length ? <p className="toolbar-metric-error">
            {modelStats.data.errors.join(" · ")}
          </p> : null}
          <p className="toolbar-metric-note">Average per model from recorded CLI data. OpenCode sessions do not record TTFT.</p>
          {analysisButton("models", "Open full model analysis")}
        </> : null}
        {!analyticsModels.data && modelStats.error ? <p className="toolbar-metric-error" role="alert">{modelStats.error}</p> : null}
      </>
    );
    return (
      <>
        <header><strong>Codex provider</strong><small>{providerCode}</small></header>
        {providers.loading ? <p className="toolbar-metric-note">Checking provider routes…</p> : null}
        {providers.error ? <p className="toolbar-metric-error" role="alert">{providers.error}</p> : null}
        {providers.data && visibleProviderTargets.length ? <div ref={providerMenuRef} className="toolbar-provider-menu" role="menu" aria-label="Provider quick switch">
          {visibleProviderTargets.map((provider) => (
            <button
              key={provider.providerId}
              type="button"
              role="menuitemradio"
              aria-checked={provider.isCurrent}
              disabled={!allowChanges || provider.isCurrent || Boolean(providerSwitchingId)}
              title={provider.reason ?? undefined}
              onClick={() => void switchProvider(provider.providerId)}
            >
              <span>{provider.displayName}</span>
              <small>{providerSwitchingId === provider.providerId ? "Switching…" : provider.isCurrent ? "Current" : provider.health}</small>
            </button>
          ))}
        </div> : providers.data ? <p className="toolbar-metric-note">No active provider routes are available.</p> : null}
      </>
    );
  }

  const panelLabels: Record<PanelKey, string> = {
    accounts: "Account usage details",
    cli: "CLI session details",
    memory: "Memory details",
    cpu: "CPU details",
    rtt: "RTT details",
    provider: "Provider details",
    models: "Active model details",
  };

  const allAccountsRemaining = environment?.lbUsage?.allAccountsRemainingPercent;
  const accountsTone = isCodexEnabled && allAccountsRemaining !== undefined && allAccountsRemaining !== null
    ? allAccountsRemaining <= QUOTA_EXHAUSTION_THRESHOLD_PERCENT
      ? "bad"
      : allAccountsRemaining <= QUOTA_WARNING_THRESHOLD_PERCENT
        ? "warn"
        : null
    : null;

  const metricStrip = <section className="toolbar-lb-strip toolbar-metrics-strip" aria-label={roomName ? `Room Codex LB ${roomName}` : "Toolbar system metrics"}>
      <button
        ref={(node) => { anchorsRef.current.accounts = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger${accountsTone ? ` tone-${accountsTone}` : ""}`}
        aria-label={`ALL ${snapshot.all}`}
        aria-expanded={activePanel === "accounts"}
        aria-controls="toolbar-metric-panel-accounts"
        disabled={!isCodexEnabled}
        title={!isCodexEnabled ? "Enable Codex in Settings" : undefined}
        onClick={() => openPanel("accounts")}
        {...anchorEvents("accounts")}
      ><small>{presentation === "drawer" ? "Account usage" : "ALL"}</small><strong>{snapshot.all}</strong></button>
      {cooldown ? (
        <button
          type="button"
          className="toolbar-lb-badge toolbar-metric-trigger tone-warn"
          aria-label={`Reset in ${cooldown.formatted}`}
          aria-expanded={activePanel === "accounts"}
          aria-controls="toolbar-metric-panel-accounts"
          title={`Next Codex token reset: ${cooldown.formatted}${cooldown.accountLabel ? ` (${cooldown.accountLabel})` : ""}`}
          onClick={() => openPanel("accounts")}
          {...anchorEvents("accounts")}
        ><small>{presentation === "drawer" ? "Token reset" : "RST"}</small><strong>{cooldown.formatted}</strong></button>
      ) : null}
      <button
        ref={(node) => { anchorsRef.current.cli = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger${host?.cliSessions.status === "PARTIAL" ? " tone-warn" : ""}`}
        aria-label={host ? `CLI ${host.cliSessions.active} running, ${host.cliSessions.attached} attached, ${host.cliSessions.detached} detached` : "CLI unavailable"}
        aria-expanded={activePanel === "cli"}
        aria-controls="toolbar-metric-panel-cli"
        onClick={(event: MouseEvent<HTMLButtonElement>) => presentation === "drawer" ? openPanel("cli") : openConfirmation("cli", event.currentTarget)}
        {...anchorEvents("cli")}
      ><small>{presentation === "drawer" ? "CLI sessions" : "CLI"}</small><strong>{snapshot.cli}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.memory = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger tone-${usageTone(host?.memory.usagePercent, 80, 90)}`}
        aria-label={host ? `RAM ${ramValue}, ${formatBytes(host.memory.usedBytes)} of ${formatBytes(host.memory.totalBytes)}` : "RAM unavailable"}
        aria-expanded={activePanel === "memory"}
        aria-controls="toolbar-metric-panel-memory"
        onClick={(event: MouseEvent<HTMLButtonElement>) => presentation === "drawer" ? openPanel("memory") : openConfirmation("memory", event.currentTarget)}
        {...anchorEvents("memory")}
      ><small>{presentation === "drawer" ? "Memory & storage" : "RAM"}</small><strong>{ramValue}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.cpu = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger tone-${usageTone(host?.cpu.usagePercent, 85, 95)}`}
        aria-label={host ? `CPU ${cpuValue}, ${host.cpu.coreCount ?? "--"} cores` : "CPU unavailable"}
        title={host ? `CPU: ${cpuValue}, ${host.cpu.coreCount ?? "--"} cores` : "CPU metrics unavailable"}
        aria-expanded={activePanel === "cpu"}
        aria-controls="toolbar-metric-panel-cpu"
        onClick={() => openPanel("cpu")}
        {...anchorEvents("cpu")}
      ><small>CPU</small><strong>{cpuValue}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.rtt = node; }}
        type="button"
        className={`toolbar-lb-badge toolbar-metric-trigger tone-${rtt.tone}`}
        aria-label={rttFailed
          ? "RTT unavailable, alert"
          : rttMs === null
            ? "RTT measuring"
            : `RTT ${rtt.value} milliseconds, ${rtt.status === "critical" ? "alert" : rtt.status}`}
        aria-expanded={activePanel === "rtt"}
        aria-controls="toolbar-metric-panel-rtt"
        title={rttFailed
          ? "RTT: unavailable · Alert"
          : rttMs === null
            ? "RTT: measuring"
            : `RTT: ${rtt.value} ms · ${rtt.status === "critical" ? "Alert" : `${rtt.status[0]?.toUpperCase()}${rtt.status.slice(1)}`}`}
        onClick={() => openPanel("rtt")}
        {...anchorEvents("rtt")}
      ><small>{presentation === "drawer" ? "Network latency" : "RTT"}</small><strong data-sensitive-ignore>{rtt.value}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.models = node; }}
        type="button"
        className="toolbar-lb-badge toolbar-metric-trigger"
        aria-label={`Global active models ${badgeModels?.length ?? 0}`}
        aria-expanded={activePanel === "models"}
        aria-controls="toolbar-metric-panel-models"
        title="Global active models (last 10 min)"
        onClick={() => openPanel("models")}
        {...anchorEvents("models")}
      ><small>{presentation === "drawer" ? "Active models" : "MDL"}</small><strong data-sensitive-ignore>{modelBadge}</strong></button>
      <button
        ref={(node) => { anchorsRef.current.provider = node; }}
        type="button"
        className="toolbar-lb-badge provider toolbar-metric-trigger"
        aria-label={`Provider ${providerCode}`}
        aria-expanded={activePanel === "provider"}
        aria-controls="toolbar-metric-panel-provider"
        disabled={!isCodexEnabled}
        title={!isCodexEnabled ? "Enable Codex in Settings" : undefined}
        onClick={() => {
          openPanel("provider");
          if (canManage) setProviderMenuFocusRequested(true);
        }}
        {...anchorEvents("provider")}
      ><small>{presentation === "drawer" ? "Provider" : providerCode}</small>{presentation === "drawer" ? <strong>{providerCode}</strong> : null}</button>
    </section>;
  return <>
    {presentation === "embedded" ? <section className="resources-embedded-metric">{panelContent()}</section> : presentation === "drawer" ? <>
      <button hidden={hideTrigger} style={hideTrigger ? { display: "none" } : undefined} ref={drawerTriggerRef} className="resources-trigger" type="button"
        aria-expanded={drawerOpen} aria-controls="resources-drawer"
        onClick={() => {
          setDrawerOpen(!drawerOpen);
          if (!drawerOpen) {
            if (!activePanel) openPanel("accounts");
          } else {
            closePanel();
          }
        }}><Activity aria-hidden="true" />Resources</button>
      {drawerOpen ? <ResourcesDrawer triggerRef={drawerTriggerRef} onClose={() => { setDrawerOpen(false); closePanel(); }}>
        {metricStrip}
        {activePanel ? <section className="resources-drawer-details" aria-label={panelLabels[activePanel]}>{panelContent()}</section> : null}
      </ResourcesDrawer> : null}
    </> : metricStrip}
    {activePanel && presentation === "strip" ? <MetricPopover
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
    {actionMessage ? (
      <div className="toolbar-metric-action-status">
        <span role="status">{actionMessage}</span>
        <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setActionMessage(null)}>
          <X aria-hidden="true" />
        </button>
      </div>
    ) : null}
  </>;
});
