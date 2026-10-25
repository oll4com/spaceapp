import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Bell,
  BellOff,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Gauge,
  Globe,
  Pause,
  Play,
  RotateCw,
  ScrollText,
  Volume2,
  VolumeX,
  Zap,
} from "../ui-theme/app-icons.js";
import { formatAppTime, useDateTimeSettings, type DateTimeSettings } from "../date-time-settings/date-time-settings.js";
import {
  AccountQuotaCard,
  AvailabilityFilterBar,
  countAvailability,
  type AccountQuotaEntry,
  type AvailabilityCounts,
} from "../toolbar-metrics/AccountQuotaCards.js";
import { formatUntil, matchesAvailabilityFilter } from "../toolbar-metrics/account-availability.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { AlarmLogModal } from "./AlarmLogModal.js";
import { DesktopWidgetContainer } from "./DesktopWidgetContainer.js";
import { computeApiProviderMetrics } from "./quota-aggregates.js";
import {
  buildQuotaOverview,
  watchedQuota,
  type ProviderQuotaOverview,
  type QuotaOverview,
  type WatchedQuota,
} from "./quota-overview.js";
import {
  fetchSharedQuotaMetrics,
  peekSharedQuotaMetrics,
  subscribeSharedQuota,
  type SharedQuotaCache,
} from "./shared-quota-cache.js";
import type { AiQuotaAlertProvider, AiQuotaTab, AiQuotaWidgetConfig, DesktopWidgetState } from "./types.js";
import { useQuotaResetAlert } from "./use-quota-reset-alert.js";
import { loadAiQuotaWidgetConfig, saveWidgetConfig } from "./widget-storage.js";
import "./ai-quota-widget.css";

export {
  computeApiProviderMetrics,
  computeQuotaAggregates,
  getAntigravityTierMultiplier,
  getCodexTierMultiplier,
  type AllQuotaAggregates,
  type ApiProviderMetrics,
  type ProviderQuotaMetrics,
  type QuotaBreakdownItem,
} from "./quota-aggregates.js";
export { fetchSharedQuotaMetrics, type SharedQuotaCache } from "./shared-quota-cache.js";

type HealthState = "available" | "soon" | "exhausted" | "unknown";

function healthOf(counts: AvailabilityCounts): HealthState {
  if (counts.available > 0) return "available";
  if (counts.soon > 0) return "soon";
  if (counts.exhausted > 0) return "exhausted";
  return "unknown";
}

function useClock(intervalMs: number): number {
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setClock(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return clock;
}

// Codex accounts are named by e-mail; the name before the @ is enough in a narrow widget.
function shortName(title: string): string {
  const at = title.indexOf("@");
  return at > 0 ? title.slice(0, at) : title;
}

function backText(next: QuotaOverview["next"], clock: number, settings?: DateTimeSettings): string | null {
  if (!next) return null;
  const until = formatUntil(next.backAt, clock, settings);
  return until ? `${shortName(next.title)} · ${next.provider} ${until}` : null;
}

function AvailabilityRing({ counts, state }: { counts: AvailabilityCounts; state: HealthState }) {
  const radius = 17;
  const circumference = 2 * Math.PI * radius;
  const total = Math.max(counts.all, 1);
  let offset = 0;
  const segments = (["available", "soon", "exhausted"] as const).map((key) => {
    const length = (counts[key] / total) * circumference;
    const segment = { key, length, offset };
    offset += length;
    return segment;
  });
  return (
    <span className={`aiq-ring is-${state}`} aria-hidden="true">
      <svg viewBox="0 0 44 44">
        <circle className="aiq-ring-track" cx="22" cy="22" r={radius} />
        {segments.filter((segment) => segment.length > 0).map((segment) => (
          <circle
            key={segment.key}
            className={`aiq-ring-segment is-${segment.key}`}
            cx="22"
            cy="22"
            r={radius}
            strokeDasharray={`${segment.length} ${circumference - segment.length}`}
            strokeDashoffset={-segment.offset}
          />
        ))}
      </svg>
      <b>{counts.available}</b>
    </span>
  );
}

function AvailabilityBar({ counts }: { counts: AvailabilityCounts }) {
  const other = Math.max(0, counts.all - counts.available - counts.soon - counts.exhausted);
  return (
    <span className="aiq-bar" aria-hidden="true">
      {(["available", "soon", "exhausted"] as const).map((key) =>
        counts[key] ? <span key={key} className={`is-${key}`} style={{ flexGrow: counts[key] }} /> : null
      )}
      {other ? <span className="is-other" style={{ flexGrow: other }} /> : null}
    </span>
  );
}

function AverageMeter({ label, value }: { label: string; value: number | null }) {
  const tone = value == null ? "none" : value < 1 ? "critical" : value <= 30 ? "warning" : "healthy";
  return (
    <span className={`aiq-avg is-${tone}`} title={`Average ${label === "5h" ? "5-hour" : "weekly"} quota left across connected accounts`}>
      <span>{label}</span>
      <span className="aiq-avg-track"><span style={{ width: `${Math.min(Math.max(value ?? 0, 0), 100)}%` }} /></span>
      <b>{value == null ? "—" : `${Math.round(value)}%`}</b>
    </span>
  );
}

function ProviderSummary({ overview, clock, settings, onOpen }: {
  overview: ProviderQuotaOverview;
  clock: number;
  settings?: DateTimeSettings;
  onOpen?: () => void;
}) {
  const { counts } = overview;
  const state = healthOf(counts);
  const until = overview.next ? formatUntil(overview.next.backAt, clock, settings) : null;
  const offline = counts.all - counts.available - counts.soon - counts.exhausted;
  const note = overview.next && until
    ? `Next back ${until} · ${shortName(overview.next.title)}`
    : counts.available === counts.all
      ? "Every account has quota"
      : [
          counts.soon ? `${counts.soon} back soon` : null,
          counts.exhausted ? `${counts.exhausted} exhausted` : null,
          offline ? `${offline} not connected` : null,
        ].filter(Boolean).join(" · ");
  const body = (
    <>
      <AvailabilityRing counts={counts} state={state} />
      <span className="aiq-provider-body">
        <span className="aiq-provider-head">
          <strong>{overview.label}</strong>
          <span className={`aiq-provider-ready is-${state}`}>{counts.available}/{counts.all} ready</span>
        </span>
        <span className="aiq-provider-meters">
          <AverageMeter label="5h" value={overview.fiveHourAverage} />
          <AverageMeter label="Week" value={overview.weeklyAverage} />
        </span>
        <small>{note}</small>
      </span>
      {onOpen ? <ChevronRight className="aiq-provider-chevron" aria-hidden="true" /> : null}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className={`aiq-provider is-${state}`}
      data-provider={overview.provider}
      onClick={onOpen}
      aria-label={`${overview.label}: ${counts.available} of ${counts.all} accounts ready`}
    >{body}</button>
  ) : (
    <div className={`aiq-provider is-${state}`} data-provider={overview.provider}>{body}</div>
  );
}

function AccountList({ entries, filter, onFilterChange, clock, settings }: {
  entries: AccountQuotaEntry[];
  filter: NonNullable<AiQuotaWidgetConfig["availabilityFilter"]>;
  onFilterChange: (filter: NonNullable<AiQuotaWidgetConfig["availabilityFilter"]>) => void;
  clock: number;
  settings?: DateTimeSettings;
}) {
  const shown = entries.filter((entry) => matchesAvailabilityFilter(entry.availability.state, filter));
  return (
    <div className="aiq-accounts">
      <AvailabilityFilterBar counts={countAvailability(entries)} value={filter} onChange={onFilterChange} />
      <ul className="account-quota-list">
        {shown.map((entry) => <AccountQuotaCard key={entry.id} entry={entry} clock={clock} settings={settings} />)}
        {!shown.length ? <li className="aiq-empty">{entries.length ? "No accounts match this filter." : "No accounts reported yet."}</li> : null}
      </ul>
    </div>
  );
}

const alertProviders: Array<{ key: AiQuotaAlertProvider; label: string }> = [
  { key: "all", label: "Any" },
  { key: "codex", label: "Codex" },
  { key: "gemini", label: "Gemini" },
  { key: "claude", label: "Claude" },
];

function AlertsCard({ config, watched, clock, settings, onUpdate, onTest }: {
  config: AiQuotaWidgetConfig;
  watched: WatchedQuota | null;
  clock: number;
  settings?: DateTimeSettings;
  onUpdate: (patch: Partial<AiQuotaWidgetConfig>) => void;
  onTest: () => void;
}) {
  const enabled = config.alertsEnabled === true;
  const next = watched?.next ?? null;
  const until = next ? formatUntil(next.backAt, clock, settings) : null;
  const status = !watched || watched.total === 0
    ? "No connected accounts to watch."
    : watched.available > 0
      ? `${watched.available} of ${watched.total} watched accounts ready.${enabled ? " You will hear a chime when quota returns after all run out." : ""}`
      : `All watched accounts are out of quota.${next && until ? ` Next back: ${shortName(next.title)} · ${next.provider} ${until}.` : ""}`;
  return (
    <section className={`aiq-alerts${enabled ? " is-on" : ""}`} aria-label="Reset alerts">
      <SpaceToggle
        className="aiq-alerts-toggle"
        checked={enabled}
        ariaLabel="Reset alerts"
        label={<span className="aiq-alerts-title">{enabled ? <Bell aria-hidden="true" /> : <BellOff aria-hidden="true" />}Reset alerts</span>}
        onChange={(checked) => onUpdate({ alertsEnabled: checked })}
      />
      <p className={`aiq-alerts-status is-${watched && watched.available > 0 ? "ready" : "waiting"}`}>{status}</p>
      <div className="aiq-segmented" role="radiogroup" aria-label="Watch accounts">
        {alertProviders.map((option) => (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={(config.alertProvider ?? "all") === option.key}
            className={(config.alertProvider ?? "all") === option.key ? "is-active" : ""}
            onClick={() => onUpdate({ alertProvider: option.key })}
          >{option.label}</button>
        ))}
      </div>
      <div className="aiq-alerts-options">
        <button
          type="button"
          className={config.proOnly ? "is-active" : ""}
          aria-pressed={config.proOnly === true}
          title="Watch only Codex Pro plans and Google AI Pro tiers; Claude accounts are always watched"
          onClick={() => onUpdate({ proOnly: !config.proOnly })}
        >Pro accounts only</button>
        <button
          type="button"
          className={config.soundEnabled !== false ? "is-active" : ""}
          aria-pressed={config.soundEnabled !== false}
          onClick={() => onUpdate({ soundEnabled: config.soundEnabled === false })}
        >{config.soundEnabled !== false ? <Volume2 aria-hidden="true" /> : <VolumeX aria-hidden="true" />}Sound</button>
        <button type="button" onClick={onTest} title="Play the alert once">Test alert</button>
      </div>
    </section>
  );
}

function ApiProviders({ sample }: { sample: SharedQuotaCache | null }) {
  const providers = sample?.api?.data ?? [];
  return (
    <ul className="aiq-api-list">
      {providers.map((provider) => (
        <li key={provider.id} className={`aiq-api-row is-${provider.status.toLowerCase()}`}>
          <span className="aiq-api-head">
            <strong>{provider.label}</strong>
            <span className="aiq-api-badge">{provider.balance ? provider.balance : provider.status === "CONNECTED" ? "Connected" : provider.status.toLowerCase()}</span>
          </span>
          {provider.detail ? <small>{provider.detail}</small> : null}
        </li>
      ))}
      {!providers.length ? <li className="aiq-empty">No API providers configured.</li> : null}
    </ul>
  );
}

export function AiQuotaPanel({ sample, overview, watched, config, onUpdate, clock, loading, onRefresh, alertActive, onDismissAlert, onTestAlert }: {
  sample: SharedQuotaCache | null;
  overview: QuotaOverview;
  watched: WatchedQuota | null;
  config: AiQuotaWidgetConfig;
  onUpdate: (patch: Partial<AiQuotaWidgetConfig>) => void;
  clock: number;
  loading: boolean;
  onRefresh: () => void;
  alertActive: boolean;
  onDismissAlert: () => void;
  onTestAlert: () => void;
}) {
  const { settings } = useDateTimeSettings();
  const tab = config.activeTab;
  const filter = config.availabilityFilter ?? "all";
  const api = computeApiProviderMetrics(sample?.api);
  const state = healthOf(overview.counts);
  const next = backText(overview.next, clock, settings);
  const providerTab = overview.providers.find((provider) => provider.provider === tab) ?? null;
  const tabs: Array<{ key: AiQuotaTab; label: string; badge: string | null }> = [
    { key: "all", label: "All", badge: null },
    ...overview.providers.map((provider) => ({ key: provider.provider as AiQuotaTab, label: provider.label, badge: `${provider.counts.available}/${provider.counts.all}` })),
    { key: "api", label: "API", badge: api.totalProviders ? `${api.connectedProviders}/${api.totalProviders}` : null },
  ];
  const readyTitles = watched?.availableAccounts.slice(0, 3).map((account) => `${shortName(account.title)} (${account.provider})`).join(", ");
  let body: ReactNode;
  if (tab === "api") {
    body = <ApiProviders sample={sample} />;
  } else if (providerTab) {
    body = (
      <>
        <ProviderSummary overview={providerTab} clock={clock} settings={settings} />
        <AccountList entries={providerTab.entries} filter={filter} onFilterChange={(value) => onUpdate({ availabilityFilter: value })} clock={clock} settings={settings} />
      </>
    );
  } else {
    body = (
      <>
        <div className="aiq-providers">
          {overview.providers.map((provider) => (
            <ProviderSummary key={provider.provider} overview={provider} clock={clock} settings={settings} onOpen={() => onUpdate({ activeTab: provider.provider })} />
          ))}
          {!overview.providers.length ? <p className="aiq-empty">{loading ? "Loading accounts…" : "No AI accounts reported yet."}</p> : null}
        </div>
        <button type="button" className="aiq-api-strip" onClick={() => onUpdate({ activeTab: "api" })}>
          <Globe aria-hidden="true" />
          <span>API providers</span>
          <b>{api.connectedProviders}/{api.totalProviders} connected</b>
          {api.totalBalanceUsd > 0 ? <small>${api.totalBalanceUsd.toFixed(2)}</small> : null}
          <ChevronRight aria-hidden="true" />
        </button>
        <AlertsCard config={config} watched={watched} clock={clock} settings={settings} onUpdate={onUpdate} onTest={onTestAlert} />
        <button
          type="button"
          className="aiq-expander"
          aria-expanded={config.showAllAccounts === true}
          onClick={() => onUpdate({ showAllAccounts: !config.showAllAccounts })}
        >
          <span>All accounts ({overview.entries.length})</span>
          {config.showAllAccounts ? <ChevronUp aria-hidden="true" /> : <ChevronDown aria-hidden="true" />}
        </button>
        {config.showAllAccounts ? (
          <AccountList entries={overview.entries} filter={filter} onFilterChange={(value) => onUpdate({ availabilityFilter: value })} clock={clock} settings={settings} />
        ) : null}
      </>
    );
  }
  return (
    <div className="aiq">
      {alertActive ? (
        <div className="aiq-alert" role="alert">
          <Zap aria-hidden="true" />
          <span>
            <strong>Quota is back</strong>
            <small>{readyTitles ? `Ready now: ${readyTitles}` : "Test alert"}</small>
          </span>
          <button type="button" onClick={onDismissAlert}>Dismiss</button>
        </div>
      ) : null}
      <section className={`aiq-hero is-${state}`} aria-label="Account availability">
        <span className="aiq-hero-count"><strong>{overview.counts.available}</strong><span>/{overview.counts.all}</span></span>
        <span className="aiq-hero-text">
          <b>{overview.counts.available > 0 ? "accounts ready now" : overview.counts.all ? "No account ready" : "Waiting for accounts"}</b>
          <small>{next ? `Next back: ${next}` : overview.counts.all && overview.counts.available === overview.counts.all ? "Every account has quota" : " "}</small>
        </span>
        <AvailabilityBar counts={overview.counts} />
        <span className="aiq-legend">
          <span className="is-available"><i />{overview.counts.available} available</span>
          <span className="is-soon"><i />{overview.counts.soon} back soon</span>
          <span className="is-exhausted"><i />{overview.counts.exhausted} exhausted</span>
        </span>
      </section>
      <div className="aiq-tabs" role="tablist" aria-label="Quota providers">
        {tabs.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? "is-active" : ""}
            onClick={() => onUpdate({ activeTab: item.key })}
          >
            {item.label}{item.badge ? <small>{item.badge}</small> : null}
          </button>
        ))}
      </div>
      {body}
      <footer className="aiq-footer">
        <span>{sample ? `Updated ${formatAppTime(sample.fetchedAt)}` : loading ? "Loading…" : "No sample yet"}</span>
        <span>{config.autoRefresh ? `Live · every ${Math.max(60, config.refreshIntervalSeconds)}s` : "Paused"}</span>
        <button
          type="button"
          className="aiq-icon-btn"
          onClick={() => onUpdate({ autoRefresh: !config.autoRefresh })}
          aria-label={config.autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
          title={config.autoRefresh ? "Pause auto-refresh" : "Resume auto-refresh"}
        >{config.autoRefresh ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}</button>
        <button
          type="button"
          className={`aiq-icon-btn${loading ? " is-spinning" : ""}`}
          onClick={onRefresh}
          disabled={loading}
          aria-label="Refresh quota now"
          title="Refresh quota now"
        ><RotateCw aria-hidden="true" /></button>
      </footer>
    </div>
  );
}

interface AiQuotaWidgetProps {
  state: DesktopWidgetState;
  isMultiColumn?: boolean;
  isHeaderDockActive?: boolean;
  onPositionChange: (x: number, y: number, dockedToRail?: boolean, dockPosition?: "rail" | "header") => void;
  onToggleMinimize: () => void;
  onClose: () => void;
  onFocus?: () => void;
}

export function AiQuotaWidget({
  state,
  isMultiColumn = false,
  isHeaderDockActive,
  onPositionChange,
  onToggleMinimize,
  onClose,
  onFocus,
}: AiQuotaWidgetProps) {
  const [config, setConfig] = useState<AiQuotaWidgetConfig>(() => loadAiQuotaWidgetConfig());
  const [sample, setSample] = useState<SharedQuotaCache | null>(() => peekSharedQuotaMetrics());
  const [loading, setLoading] = useState(false);
  const [showAlarmLog, setShowAlarmLog] = useState(false);
  const clock = useClock(state.minimized ? 15_000 : 5_000);
  const { settings } = useDateTimeSettings();

  const updateConfig = useCallback((patch: Partial<AiQuotaWidgetConfig>) => {
    setConfig((previous) => {
      const next = { ...previous, ...patch };
      saveWidgetConfig("ai-quota", next);
      return next;
    });
  }, []);

  const refresh = useCallback(async (force = false) => {
    setLoading(true);
    try {
      setSample(await fetchSharedQuotaMetrics(force));
    } finally {
      setLoading(false);
    }
  }, []);
  const forceRefresh = useCallback(() => void refresh(true), [refresh]);

  useEffect(() => subscribeSharedQuota(setSample), []);
  useEffect(() => {
    void refresh(false);
  }, [refresh]);
  useEffect(() => {
    if (!config.autoRefresh) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh(false);
    }, Math.max(60, config.refreshIntervalSeconds) * 1000);
    return () => clearInterval(timer);
  }, [config.autoRefresh, config.refreshIntervalSeconds, refresh]);

  const overview = useMemo(() => buildQuotaOverview(sample, clock), [sample, clock]);
  const watched = useMemo(
    () => (sample ? watchedQuota(sample, clock, { provider: config.alertProvider ?? "all", proOnly: config.proOnly === true }) : null),
    [sample, clock, config.alertProvider, config.proOnly]
  );
  const alert = useQuotaResetAlert({
    watched,
    sampleId: sample?.fetchedAt ?? null,
    enabled: config.alertsEnabled === true,
    soundEnabled: config.soundEnabled !== false,
    provider: config.alertProvider ?? "all",
    proOnly: config.proOnly === true,
    refresh: forceRefresh,
  });

  const health = healthOf(overview.counts);
  const until = overview.next ? formatUntil(overview.next.backAt, clock, settings) : null;
  const shortUntil = until?.replace(/^in /, "") ?? null;
  const minimizedSummary = (
    <span className={`aiq-mini is-${alert.alertActive ? "available" : health}`} title="AI accounts ready now">
      <i aria-hidden="true" />
      {alert.alertActive
        ? "Quota is back!"
        : overview.counts.available > 0
          ? `${overview.counts.available}/${overview.counts.all} ready`
          : shortUntil ? `Back ${until}` : "No quota"}
    </span>
  );
  const dockedSummary = (
    <div className="widget-docked-rail-body ai-quota-docked-body">
      <div className="ai-quota-docked-row">
        <span className="widget-docked-badge">AI</span>
        <span className="widget-docked-title">Ready</span>
        <span className="widget-docked-countdown">{overview.counts.available}/{overview.counts.all}</span>
      </div>
      <div className="ai-quota-docked-row">
        <span className="widget-docked-title">Next</span>
        <span className="widget-docked-countdown">{overview.counts.available > 0 ? "now" : shortUntil ?? "—"}</span>
      </div>
    </div>
  );
  const headerControls = (
    <>
      <button
        type="button"
        className={`desktop-widget-btn-action${config.alertsEnabled ? "" : " is-muted"}`}
        onClick={() => updateConfig({ alertsEnabled: !config.alertsEnabled })}
        aria-label={config.alertsEnabled ? "Turn reset alerts off" : "Turn reset alerts on"}
        title={config.alertsEnabled ? "Reset alerts on" : "Reset alerts off"}
      >
        {config.alertsEnabled ? <Bell aria-hidden="true" className="widget-header-svg" /> : <BellOff aria-hidden="true" className="widget-header-svg" />}
      </button>
      <button
        type="button"
        className="desktop-widget-btn-action"
        onClick={() => setShowAlarmLog((open) => !open)}
        aria-label="View alarm log"
        title="Alarm log"
      >
        <ScrollText aria-hidden="true" className="widget-header-svg" />
      </button>
    </>
  );

  return (
    <DesktopWidgetContainer
      id="ai-quota"
      title="AI Quota & Usage"
      icon={<Gauge className="widget-header-svg" />}
      x={state.x}
      y={state.y}
      zIndex={state.zIndex}
      minimized={state.minimized}
      dockedToRail={state.dockedToRail}
      dockPosition={state.dockPosition}
      isMultiColumn={isMultiColumn}
      isHeaderDockActive={isHeaderDockActive}
      hideTitleOnMinimize={true}
      onPositionChange={onPositionChange}
      onToggleMinimize={onToggleMinimize}
      onClose={onClose}
      onFocus={onFocus}
      minimizedSummary={minimizedSummary}
      dockedSummary={dockedSummary}
      isAlertActive={alert.alertActive}
      onStopAlert={alert.dismiss}
      headerControls={state.minimized ? undefined : headerControls}
      className={`widget-ai-quota-container${alert.alertActive ? " is-alert" : ""}`}
    >
      <AiQuotaPanel
        sample={sample}
        overview={overview}
        watched={watched}
        config={config}
        onUpdate={updateConfig}
        clock={clock}
        loading={loading}
        onRefresh={forceRefresh}
        alertActive={alert.alertActive}
        onDismissAlert={alert.dismiss}
        onTestAlert={alert.test}
      />
      <AlarmLogModal isOpen={showAlarmLog} onClose={() => setShowAlarmLog(false)} />
    </DesktopWidgetContainer>
  );
}
