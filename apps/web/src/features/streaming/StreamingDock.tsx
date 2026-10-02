import type {
  StreamingAnalyticsPeriod,
  StreamingCatalogResponse,
  StreamingMetricDefinition,
  StreamingMetricTileSnapshot,
  StreamingOAuthProvider,
  StreamingOverlaySettings,
  StreamingOverlaySnapshot,
  StreamingOverlayTile,
  StreamingPlatformAccount,
  StreamingProvider
} from "@space/contracts";
import {
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
  Music2,
  Radio,
  RefreshCw,
  Save,
  Trash2,
  Youtube,
  Discord,
  XSocialIcon
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpaceApiError, api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  StreamingMetricGrid,
  useStreamingOverlay
} from "./StreamingOverlay.js";
import { StreamingBotTab } from "./StreamingBotTab.js";
import { StreamingMemoryTab } from "./StreamingMemoryTab.js";
import { StreamingModerationTab } from "./StreamingModerationTab.js";
import { StreamingActivityTab } from "./StreamingActivityTab.js";
import { streamingCapabilities } from "./streaming-capabilities.js";
import "./streaming.css";

type StreamingDraft = Pick<StreamingOverlaySettings, "tiles" | "customTextEnabled" | "customText"> & {
  expectedVersion: number;
};

const PROVIDERS: StreamingOAuthProvider[] = ["YOUTUBE", "TWITCH", "TIKTOK", "X", "DISCORD"];
const PERIODS: StreamingAnalyticsPeriod[] = [7, 28, 90];

function providerLabel(provider: StreamingProvider): string {
  if (provider === "YOUTUBE") return "YouTube";
  if (provider === "TWITCH") return "Twitch";
  if (provider === "TIKTOK") return "TikTok";
  if (provider === "X") return "X";
  if (provider === "DISCORD") return "Discord";
  return "Space";
}

function ProviderIcon({ provider }: { provider: StreamingOAuthProvider }) {
  if (provider === "YOUTUBE") return <Youtube aria-hidden="true" />;
  if (provider === "TWITCH") return <Radio aria-hidden="true" />;
  if (provider === "TIKTOK") return <Music2 aria-hidden="true" />;
  if (provider === "X") return <XSocialIcon aria-hidden="true" />;
  return <Discord aria-hidden="true" />;
}

function settingsDraft(settings: StreamingOverlaySettings): StreamingDraft {
  return {
    expectedVersion: settings.version,
    tiles: settings.tiles.map((tile) => ({ ...tile })),
    customTextEnabled: settings.customTextEnabled,
    customText: settings.customText
  };
}

function tileIdentity(tile: StreamingOverlayTile): string {
  return `${tile.metricKey}\u0000${tile.accountId ?? "SPACE"}`;
}

function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item === undefined) return items;
  next.splice(to, 0, item);
  return next;
}

function twoLineText(value: string): string {
  const lines = value.replaceAll("\r", "").split("\n");
  return lines.slice(0, 2).join("\n").slice(0, 160);
}

function accountMetrics(catalog: StreamingCatalogResponse, account: StreamingPlatformAccount): StreamingMetricDefinition[] {
  return catalog.metrics.filter((metric) => metric.provider === account.provider);
}

function draftPreview(
  catalog: StreamingCatalogResponse,
  draft: StreamingDraft,
  snapshot: StreamingOverlaySnapshot | null
): StreamingOverlaySnapshot {
  const values = new Map(
    (snapshot?.tiles ?? []).map((tile) => [`${tile.metricKey}\u0000${tile.accountId ?? "SPACE"}`, tile])
  );
  const accounts = new Map(catalog.accounts.map((account) => [account.id, account]));
  const metrics = new Map(catalog.metrics.map((metric) => [metric.key, metric]));
  const tiles: StreamingMetricTileSnapshot[] = draft.tiles.map((tile) => {
    const existing = values.get(tileIdentity(tile));
    if (existing) return existing;
    const metric = metrics.get(tile.metricKey);
    const account = tile.accountId ? accounts.get(tile.accountId) : null;
    return {
      metricKey: tile.metricKey,
      accountId: tile.accountId,
      provider: metric?.provider ?? "SPACE",
      label: metric?.label ?? tile.metricKey,
      badge: account?.badge ?? (metric?.provider === "SPACE" ? "Space" : "Account"),
      value: null,
      state: "UNAVAILABLE",
      sampledAt: null
    };
  });
  return {
    generatedAt: snapshot?.generatedAt ?? new Date(0).toISOString(),
    settingsVersion: draft.expectedVersion,
    tiles,
    customTextEnabled: draft.customTextEnabled,
    customText: draft.customText,
    botTickerEnabled: snapshot?.botTickerEnabled ?? false,
    botTicker: snapshot?.botTicker ?? []
  };
}

export function StreamingDock() {
  const runtime = getSpaceRuntime();
  const [activeTab, setActiveTab] = useState<"overview" | "bot" | "memory" | "moderation" | "display" | "activity">("overview");
  const {
    enabled,
    setEnabled,
    previewActive,
    setPreviewActive,
    snapshot,
    snapshotError,
    refreshSnapshot
  } = useStreamingOverlay();
  const [catalog, setCatalog] = useState<StreamingCatalogResponse | null>(null);
  const [draft, setDraft] = useState<StreamingDraft | null>(null);
  const [loading, setLoading] = useState(true);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<StreamingOAuthProvider>>(() => new Set());
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const queuedDraftRef = useRef<StreamingDraft | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedChangesRef = useRef(false);

  const toggleProviderExpanded = useCallback((provider: StreamingOAuthProvider) => {
    setExpandedProviders((prev) => {
      const next = new Set(prev);
      if (next.has(provider)) {
        next.delete(provider);
      } else {
        next.add(provider);
      }
      return next;
    });
  }, []);

  const saveDraftDirect = useCallback(async (targetDraft: StreamingDraft) => {
    if (savingRef.current) {
      queuedDraftRef.current = targetDraft;
      return;
    }
    savingRef.current = true;
    setPendingAction("save");
    setError(null);
    try {
      const saved = await api.updateStreamingOverlaySettings({
        expectedVersion: targetDraft.expectedVersion,
        tiles: targetDraft.tiles,
        customTextEnabled: targetDraft.customTextEnabled,
        customText: targetDraft.customText
      });
      hasUnsavedChangesRef.current = false;
      const nextDraft = settingsDraft(saved);
      setDraft(nextDraft);
      setCatalog((current) => current ? { ...current, settings: saved } : current);
      setNotice("Overlay settings saved.");
      await refreshSnapshot();
    } catch (saveError) {
      if (saveError instanceof SpaceApiError && saveError.status === 409) {
        await loadCatalog("A newer overlay version was loaded. Review it before saving again.");
      } else {
        setError(saveError instanceof Error ? saveError.message : "The streaming overlay could not be saved.");
      }
    } finally {
      savingRef.current = false;
      setPendingAction(null);
      if (queuedDraftRef.current) {
        const next = queuedDraftRef.current;
        queuedDraftRef.current = null;
        void saveDraftDirect(next);
      }
    }
  }, [refreshSnapshot]);

  const scheduleAutoSave = useCallback((newDraft: StreamingDraft) => {
    hasUnsavedChangesRef.current = true;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      void saveDraftDirect(newDraft);
    }, 400);
  }, [saveDraftDirect]);

  const loadCatalog = useCallback(async (message?: string) => {
    setLoading(true);
    try {
      const next = await api.streamingCatalog();
      if (!mounted.current) return;
      setCatalog(next);
      setDraft((current) => {
        if (!current) return settingsDraft(next.settings);
        if (hasUnsavedChangesRef.current || savingRef.current) {
          return { ...current, expectedVersion: next.settings.version };
        }
        return settingsDraft(next.settings);
      });
      setError(null);
      if (message) setNotice(message);
    } catch (loadError) {
      if (!mounted.current) return;
      setError(loadError instanceof Error ? loadError.message : "Streaming integrations could not be loaded.");
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void loadCatalog();
    return () => {
      mounted.current = false;
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      setPreviewActive(false);
    };
  }, [loadCatalog, setPreviewActive]);

  useEffect(() => {
    function handleOAuthMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: unknown; provider?: unknown; ok?: unknown } | null;
      if (!data || data.type !== "space.streaming.oauth" || typeof data.ok !== "boolean") return;
      if (!PROVIDERS.includes(data.provider as StreamingOAuthProvider)) return;
      const label = providerLabel(data.provider as StreamingOAuthProvider);
      void loadCatalog(data.ok ? `${label} connection completed.` : `${label} connection did not complete.`);
      void refreshSnapshot();
    }
    function handleStorage(event: StorageEvent) {
      if (event.key !== "space.streaming.oauth" || !event.newValue) return;
      try {
        const data = JSON.parse(event.newValue) as { provider?: unknown; ok?: unknown };
        if (typeof data.ok === "boolean" && PROVIDERS.includes(data.provider as StreamingOAuthProvider)) {
          const label = providerLabel(data.provider as StreamingOAuthProvider);
          void loadCatalog(data.ok ? `${label} connection completed.` : `${label} connection did not complete.`);
          void refreshSnapshot();
        }
      } catch {}
    }
    window.addEventListener("message", handleOAuthMessage);
    window.addEventListener("storage", handleStorage);
    return () => {
      window.removeEventListener("message", handleOAuthMessage);
      window.removeEventListener("storage", handleStorage);
    };
  }, [loadCatalog, refreshSnapshot]);

  const metricsByKey = useMemo(
    () => new Map(catalog?.metrics.map((metric) => [metric.key, metric]) ?? []),
    [catalog?.metrics]
  );
  const accountsById = useMemo(
    () => new Map(catalog?.accounts.map((account) => [account.id, account]) ?? []),
    [catalog?.accounts]
  );

  const isDirty = useMemo(() => {
    if (!catalog || !draft) return false;
    const original = settingsDraft(catalog.settings);
    return JSON.stringify(original.tiles) !== JSON.stringify(draft.tiles)
      || original.customTextEnabled !== draft.customTextEnabled
      || original.customText !== draft.customText;
  }, [catalog, draft]);

  function setDraftTiles(updater: (tiles: StreamingOverlayTile[]) => StreamingOverlayTile[]) {
    setDraft((current) => {
      if (!current) return current;
      const nextDraft = { ...current, tiles: updater(current.tiles) };
      scheduleAutoSave(nextDraft);
      return nextDraft;
    });
    setNotice(null);
  }

  function toggleMetric(metric: StreamingMetricDefinition, account: StreamingPlatformAccount | null) {
    if (!draft) return;
    const identity = `${metric.key}\u0000${account?.id ?? "SPACE"}`;
    const index = draft.tiles.findIndex((tile) => tileIdentity(tile) === identity);
    if (index >= 0) {
      setDraftTiles((tiles) => tiles.filter((_, tileIndex) => tileIndex !== index));
      return;
    }
    if (draft.tiles.length >= 64) {
      setError("The overlay can show at most 64 metric tiles.");
      return;
    }
    setError(null);
    const next: StreamingOverlayTile = {
      metricKey: metric.key,
      accountId: account?.id ?? null,
      ...(metric.analyticsPeriod ? { analyticsPeriod: account?.analyticsPeriod ?? 28 } : {})
    };
    setDraftTiles((tiles) => [...tiles, next]);
  }

  function updateTilePeriod(index: number, analyticsPeriod: StreamingAnalyticsPeriod) {
    setDraftTiles((tiles) => tiles.map((tile, tileIndex) => tileIndex === index ? { ...tile, analyticsPeriod } : tile));
  }

  function toggleAllAccountMetrics(account: StreamingPlatformAccount) {
    if (!draft || !catalog) return;
    const metrics = accountMetrics(catalog, account);
    const allSelected = metrics.every((metric) =>
      draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000${account.id}`)
    );

    if (allSelected) {
      setDraftTiles((tiles) => tiles.filter((tile) => tile.accountId !== account.id));
    } else {
      const existingIdentities = new Set(draft.tiles.map(tileIdentity));
      const toAdd: StreamingOverlayTile[] = [];
      for (const metric of metrics) {
        const id = `${metric.key}\u0000${account.id}`;
        if (!existingIdentities.has(id)) {
          toAdd.push({
            metricKey: metric.key,
            accountId: account.id,
            ...(metric.analyticsPeriod ? { analyticsPeriod: account.analyticsPeriod ?? 28 } : {})
          });
        }
      }
      if (draft.tiles.length + toAdd.length > 64) {
        setError("The overlay can show at most 64 metric tiles.");
        return;
      }
      setError(null);
      setDraftTiles((tiles) => [...tiles, ...toAdd]);
    }
  }

  function toggleAllSpaceMetrics() {
    if (!draft || !catalog) return;
    const spaceMetrics = catalog.metrics.filter((metric) => metric.provider === "SPACE");
    const allSelected = spaceMetrics.every((metric) =>
      draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000SPACE`)
    );

    if (allSelected) {
      setDraftTiles((tiles) => tiles.filter((tile) => tile.accountId !== null));
    } else {
      const existingIdentities = new Set(draft.tiles.map(tileIdentity));
      const toAdd: StreamingOverlayTile[] = [];
      for (const metric of spaceMetrics) {
        const id = `${metric.key}\u0000SPACE`;
        if (!existingIdentities.has(id)) {
          toAdd.push({
            metricKey: metric.key,
            accountId: null
          });
        }
      }
      if (draft.tiles.length + toAdd.length > 64) {
        setError("The overlay can show at most 64 metric tiles.");
        return;
      }
      setError(null);
      setDraftTiles((tiles) => [...tiles, ...toAdd]);
    }
  }

  function toggleAllProviderMetrics() {
    if (!draft || !catalog) return;
    const allTargetTiles: StreamingOverlayTile[] = [];
    for (const account of catalog.accounts) {
      const metrics = accountMetrics(catalog, account);
      for (const metric of metrics) {
        allTargetTiles.push({
          metricKey: metric.key,
          accountId: account.id,
          ...(metric.analyticsPeriod ? { analyticsPeriod: account.analyticsPeriod ?? 28 } : {})
        });
      }
    }
    const allSelected = allTargetTiles.length > 0 && allTargetTiles.every((target) =>
      draft.tiles.some((tile) => tileIdentity(tile) === tileIdentity(target))
    );

    if (allSelected) {
      setDraftTiles((tiles) => tiles.filter((tile) => tile.accountId === null));
    } else {
      const existingIdentities = new Set(draft.tiles.map(tileIdentity));
      const toAdd = allTargetTiles.filter((target) => !existingIdentities.has(tileIdentity(target)));
      if (draft.tiles.length + toAdd.length > 64) {
        setError("The overlay can show at most 64 metric tiles.");
        return;
      }
      setError(null);
      setDraftTiles((tiles) => [...tiles, ...toAdd]);
    }
  }

  const allProviderMetricsSelected = useMemo(() => {
    if (!catalog || !draft || catalog.accounts.length === 0) return false;
    for (const account of catalog.accounts) {
      const metrics = accountMetrics(catalog, account);
      for (const metric of metrics) {
        if (!draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000${account.id}`)) {
          return false;
        }
      }
    }
    return true;
  }, [catalog, draft]);

  async function runAction(key: string, action: () => Promise<unknown>, success: string) {
    setPendingAction(key);
    setError(null);
    setNotice(null);
    try {
      await action();
      await loadCatalog(success);
      await refreshSnapshot();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Streaming action failed.");
    } finally {
      setPendingAction(null);
    }
  }

  async function connect(provider: StreamingOAuthProvider) {
    setPendingAction(`connect:${provider}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.startStreamingOAuth(provider);
      const popup = runtime.platform.openLink(
        result.authorizationUrl,
        `space-streaming-${provider.toLowerCase()}`,
        "popup,width=640,height=760"
      );
      if (!popup) setError("The provider window was blocked. Allow popups for Space and try again.");
      else setNotice(`${providerLabel(provider)} authorization opened in a secure provider window.`);
    } catch (connectError) {
      setError(connectError instanceof Error ? connectError.message : "Provider authorization could not start.");
    } finally {
      setPendingAction(null);
    }
  }

  async function saveOverlay() {
    if (!draft) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    await saveDraftDirect(draft);
  }

  if (loading && !catalog) {
    return <div className="dock-panel streaming-dock" role="status"><Loader2 className="spin" aria-hidden="true" /> Loading streaming integrations…</div>;
  }

  if (!catalog || !draft) {
    return (
      <div className="dock-panel streaming-dock">
        <h2>Streaming</h2>
        {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
        <button type="button" onClick={() => void loadCatalog()}><RefreshCw aria-hidden="true" /> Retry</button>
      </div>
    );
  }

  const preview = draftPreview(catalog, draft, snapshot);

  return (
    <div className="dock-panel streaming-dock" aria-label="Streaming controls">
      <header className="streaming-dock-header">
        <div>
          <span className="streaming-eyebrow">Broadcast companion</span>
          <h2><Radio aria-hidden="true" /> Streaming</h2>
        </div>
        <button type="button" className="icon-button" aria-label="Refresh streaming integrations" title="Refresh" onClick={() => void loadCatalog()} disabled={loading}>
          <RefreshCw className={loading ? "spin" : undefined} aria-hidden="true" />
        </button>
      </header>
      <nav className="streaming-dock-tabs" aria-label="Streaming dock sections">
        <button type="button" className={activeTab === "overview" ? "active" : ""} onClick={() => setActiveTab("overview")}>Overview</button>
        <button type="button" className={activeTab === "bot" ? "active" : ""} onClick={() => setActiveTab("bot")}>Bot</button>
        <button type="button" className={activeTab === "memory" ? "active" : ""} onClick={() => setActiveTab("memory")}>Memory</button>
        <button type="button" className={activeTab === "moderation" ? "active" : ""} onClick={() => setActiveTab("moderation")}>Moderation</button>
        <button type="button" className={activeTab === "display" ? "active" : ""} onClick={() => setActiveTab("display")}>Display</button>
        <button type="button" className={activeTab === "activity" ? "active" : ""} onClick={() => setActiveTab("activity")}>Activity</button>
      </nav>

      {activeTab === "bot" ? <StreamingBotTab /> : activeTab === "memory" ? <StreamingMemoryTab /> :
        activeTab === "moderation" ? <StreamingModerationTab /> : activeTab === "activity" ? <StreamingActivityTab /> : (<>
      {activeTab === "display" ? (
      <section className="streaming-session-card" aria-labelledby="streaming-session-heading">
        <div>
          <h3 id="streaming-session-heading">This window</h3>
          <p>Overlay activation stays in this tab and is never saved globally.</p>
        </div>
        <SpaceToggle
          className="streaming-session-toggle"
          checked={enabled}
          label="Overlay"
          onChange={setEnabled}
        />
      </section>
      ) : null}

      {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
      {notice ? <div className="streaming-message notice" role="status">{notice}</div> : null}
      {isDirty ? (
        <div className="streaming-unsaved-banner" role="status">
          <span>Unsaved overlay changes</span>
          <button type="button" onClick={() => void saveOverlay()} disabled={pendingAction !== null}>
            {pendingAction === "save" ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />} Save now
          </button>
        </div>
      ) : null}

      {activeTab === "overview" ? <>
      <section className="streaming-section" aria-labelledby="streaming-providers-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Official connections</span><h3 id="streaming-providers-heading">Providers <small>{draft.tiles.length}/64</small></h3></div>
          {catalog.accounts.length > 0 ? (
            <button
              type="button"
              className="streaming-select-all-button"
              onClick={toggleAllProviderMetrics}
              aria-label={allProviderMetricsSelected ? "Deselect all provider metrics" : "All provider metrics"}
            >
              {allProviderMetricsSelected ? "Deselect all" : "All provider metrics"}
            </button>
          ) : null}
        </div>
        <div className="streaming-provider-list">
          {PROVIDERS.map((provider) => {
            const readiness = catalog.providers.find((entry) => entry.provider === provider);
            const accounts = catalog.accounts.filter((account) => account.provider === provider);
            const authorizations = catalog.authorizations.filter((authorization) => authorization.provider === provider);
            const ready = readiness?.status === "READY";
            const isExpanded = expandedProviders.has(provider);
            return (
              <article className={`streaming-provider-card ${isExpanded ? "is-expanded" : "is-collapsed"}`} key={provider} data-provider={provider}>
                <header
                  className="streaming-provider-header"
                  role="button"
                  tabIndex={0}
                  aria-expanded={isExpanded}
                  aria-label={`Toggle ${providerLabel(provider)}`}
                  onClick={() => toggleProviderExpanded(provider)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleProviderExpanded(provider);
                    }
                  }}
                >
                  <span className="streaming-provider-mark"><ProviderIcon provider={provider} /></span>
                  <div className="streaming-provider-meta">
                    <div className="streaming-provider-meta-row">
                      <h4>{providerLabel(provider)}</h4>
                      <span className={`streaming-readiness status-${readiness?.status.toLowerCase() ?? "error"}`}>{readiness?.status ?? "ERROR"}</span>
                      {accounts.length > 0 ? (
                        <span className="streaming-provider-account-badge">
                          {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
                        </span>
                      ) : null}
                    </div>
                    {readiness?.status !== "READY" && readiness?.code ? (
                      <code className="streaming-safe-code">{readiness.code}</code>
                    ) : null}
                  </div>
                  <div className="streaming-provider-header-actions">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void connect(provider);
                      }}
                      disabled={!ready || pendingAction !== null}
                    >
                      {pendingAction === `connect:${provider}` ? <Loader2 className="spin" aria-hidden="true" /> : null}
                      {accounts.length > 0 ? "Connect another" : "Connect"}
                    </button>
                    <span
                      className="streaming-provider-chevron"
                      role="button"
                      tabIndex={0}
                      aria-label={isExpanded ? `Collapse ${providerLabel(provider)}` : `Expand ${providerLabel(provider)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProviderExpanded(provider);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleProviderExpanded(provider);
                        }
                      }}
                    >
                      {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </span>
                  </div>
                </header>

                {isExpanded ? (
                  <div className="streaming-provider-body">
                    <p className="streaming-provider-detail">{readiness?.message ?? "Provider readiness is unavailable."}</p>

                    {accounts.length === 0 ? <p className="streaming-empty">No connected accounts.</p> : (
                      <ul className="streaming-account-list">
                        {accounts.map((account) => {
                          const capabilities = streamingCapabilities(account, authorizations.find(item => item.id === account.authorizationId));
                          const allSelected = accountMetrics(catalog, account).every((metric) =>
                            draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000${account.id}`)
                          );
                          return (
                            <li key={account.id} className="streaming-account-card">
                              <div className="streaming-account-heading">
                                <div><strong>{account.displayName}</strong><span>{account.badge} · {account.status}</span></div>
                                <div className="streaming-inline-actions">
                                  <button type="button" onClick={() => void runAction(`verify:${account.id}`, () => api.verifyStreamingAccount(account.id), `${account.displayName} was verified.`)} disabled={pendingAction !== null}>
                                    <CheckCircle2 aria-hidden="true" /> Verify
                                  </button>
                                  <button type="button" className="danger" onClick={() => void runAction(`remove:${account.id}`, () => api.removeStreamingAccount(account.id), `${account.displayName} was removed.`)} disabled={pendingAction !== null}>
                                    <Trash2 aria-hidden="true" /> Remove account
                                  </button>
                                </div>
                              </div>
                              <div className="streaming-capability-grid" aria-label={`Capabilities for ${account.displayName}`}>
                                <div className={`streaming-capability-chip ${capabilities.metrics ? "is-ready" : "is-unavailable"}`}>
                                  <span className="streaming-capability-dot" aria-hidden="true" />
                                  <span className="streaming-capability-label">Metrics</span>
                                  <span className="streaming-capability-status">{capabilities.metrics ? "ON" : "OFF"}</span>
                                </div>
                                <div className={`streaming-capability-chip ${capabilities.readChat ? "is-ready" : "is-unavailable"}`}>
                                  <span className="streaming-capability-dot" aria-hidden="true" />
                                  <span className="streaming-capability-label">Chat</span>
                                  <span className="streaming-capability-status">{capabilities.readChat ? "ON" : "OFF"}</span>
                                </div>
                                <div className={`streaming-capability-chip ${capabilities.reply ? "is-ready" : "is-unavailable"}`}>
                                  <span className="streaming-capability-dot" aria-hidden="true" />
                                  <span className="streaming-capability-label">Replies</span>
                                  <span className="streaming-capability-status">{capabilities.reply ? "ON" : "OFF"}</span>
                                </div>
                                <div className={`streaming-capability-chip ${capabilities.moderate ? "is-ready" : "is-unavailable"}`}>
                                  <span className="streaming-capability-dot" aria-hidden="true" />
                                  <span className="streaming-capability-label">Moderation</span>
                                  <span className="streaming-capability-status">{capabilities.moderate ? "ON" : "OFF"}</span>
                                </div>
                              </div>
                              {capabilities.reason ? <small>{capabilities.reason}</small> : null}
                              {account.safeErrorMessage ? <div className="streaming-safe-error"><code>{account.safeErrorCode}</code><span>{account.safeErrorMessage}</span></div> : null}
                              <fieldset className="streaming-metric-options" aria-label={`Metrics for ${account.displayName}`}>
                                <div className="streaming-metric-header">
                                  <span className="streaming-metric-title">Metrics for {account.displayName}</span>
                                  <button
                                    type="button"
                                    className="streaming-select-all-button"
                                    onClick={() => toggleAllAccountMetrics(account)}
                                  >
                                    {allSelected ? "Deselect all" : "All metrics"}
                                  </button>
                                </div>
                                {accountMetrics(catalog, account).map((metric) => {
                                  const checked = draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000${account.id}`);
                                  return (
                                    <SpaceToggle
                                      key={metric.key}
                                      checked={checked}
                                      label={metric.label}
                                      detail={metric.category.toLowerCase()}
                                      onChange={() => toggleMetric(metric, account)}
                                    />
                                  );
                                })}
                                {isDirty ? (
                                  <button
                                    type="button"
                                    className="streaming-quick-save"
                                    onClick={() => void saveOverlay()}
                                    disabled={pendingAction !== null}
                                  >
                                    {pendingAction === "save" ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />} Save changes
                                  </button>
                                ) : null}
                              </fieldset>
                            </li>
                          );
                        })}
                      </ul>
                    )}

                    {authorizations.length > 0 ? (
                      <div className="streaming-authorizations">
                        {authorizations.map((authorization) => (
                          <div key={authorization.id}>
                            <span>{authorization.accountCount} account{authorization.accountCount === 1 ? "" : "s"} · {authorization.status}</span>
                            <button type="button" className="danger" onClick={() => void runAction(`disconnect:${authorization.id}`, () => api.disconnectStreamingAuthorization(authorization.id), `${providerLabel(provider)} authorization was disconnected.`)} disabled={pendingAction !== null}>
                              Disconnect authorization
                            </button>
                            {authorization.safeErrorMessage ? <p className="streaming-safe-error"><code>{authorization.safeErrorCode}</code><span>{authorization.safeErrorMessage}</span></p> : null}
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      </section>

      <section className="streaming-section" aria-labelledby="streaming-space-heading">
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Built in</span><h3 id="streaming-space-heading">Space metrics</h3></div></div>
        <fieldset className="streaming-metric-options streaming-space-options" aria-label="Metrics from this Space installation">
          <div className="streaming-metric-header">
            <span className="streaming-metric-title">Metrics from this Space installation</span>
            <button
              type="button"
              className="streaming-select-all-button"
              onClick={toggleAllSpaceMetrics}
            >
              {catalog.metrics.filter((metric) => metric.provider === "SPACE").every((metric) =>
                draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000SPACE`)
              ) ? "Deselect all" : "All metrics"}
            </button>
          </div>
          {catalog.metrics.filter((metric) => metric.provider === "SPACE").map((metric) => (
            <SpaceToggle
              key={metric.key}
              checked={draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000SPACE`)}
              label={metric.label}
              onChange={() => toggleMetric(metric, null)}
            />
          ))}
        </fieldset>
      </section>
      </> : null}

      {activeTab === "display" ? (
      <section className="streaming-section" aria-labelledby="streaming-layout-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Global order</span><h3 id="streaming-layout-heading">Overlay layout</h3></div>
          <strong className={draft.tiles.length >= 64 ? "at-limit" : ""}>{draft.tiles.length}/64</strong>
        </div>
        {draft.tiles.length === 0 ? <p className="streaming-empty">Select metrics above to build the overlay.</p> : (
          <ol className="streaming-layout-list" aria-label="Streaming overlay tile order">
            {draft.tiles.map((tile, index) => {
              const metric = metricsByKey.get(tile.metricKey);
              const account = tile.accountId ? accountsById.get(tile.accountId) : null;
              return (
                <li
                  key={`${tileIdentity(tile)}:${index}`}
                  draggable
                  onDragStart={() => setDragIndex(index)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => {
                    if (dragIndex !== null) setDraftTiles((tiles) => moveItem(tiles, dragIndex, index));
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                >
                  <GripVertical aria-label={`Drag ${metric?.label ?? tile.metricKey}`} />
                  <div><strong>{metric?.label ?? tile.metricKey}</strong><span>{account?.badge ?? "Space"}</span></div>
                  <div className="streaming-layout-row-controls">
                    {metric?.analyticsPeriod ? (
                      <label className="streaming-period-select">
                        <span>Period</span>
                        <select value={tile.analyticsPeriod ?? 28} onChange={(event) => updateTilePeriod(index, Number(event.target.value) as StreamingAnalyticsPeriod)}>
                          {PERIODS.map((period) => <option value={period} key={period}>{period} days</option>)}
                        </select>
                      </label>
                    ) : null}
                    <div className="streaming-order-actions">
                      <button type="button" aria-label={`Move ${metric?.label ?? tile.metricKey} earlier`} onClick={() => setDraftTiles((tiles) => moveItem(tiles, index, index - 1))} disabled={index === 0}><ChevronLeft aria-hidden="true" /></button>
                      <button type="button" aria-label={`Move ${metric?.label ?? tile.metricKey} later`} onClick={() => setDraftTiles((tiles) => moveItem(tiles, index, index + 1))} disabled={index === draft.tiles.length - 1}><ChevronRight aria-hidden="true" /></button>
                      <button type="button" aria-label={`Remove ${metric?.label ?? tile.metricKey}`} onClick={() => setDraftTiles((tiles) => tiles.filter((_, tileIndex) => tileIndex !== index))}><Trash2 aria-hidden="true" /></button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <div className="streaming-custom-text">
          <SpaceToggle
            checked={draft.customTextEnabled}
            label="Custom footer text"
            onChange={(checked) => {
              setDraft((current) => {
                if (!current) return current;
                const nextDraft = { ...current, customTextEnabled: checked };
                scheduleAutoSave(nextDraft);
                return nextDraft;
              });
            }}
          />
          <textarea
            aria-label="Streaming overlay custom text"
            rows={2}
            maxLength={160}
            value={draft.customText}
            onChange={(event) => {
              const text = twoLineText(event.target.value);
              setDraft((current) => {
                if (!current) return current;
                const nextDraft = { ...current, customText: text };
                scheduleAutoSave(nextDraft);
                return nextDraft;
              });
            }}
            placeholder="Optional two-line message"
          />
          <small>{draft.customText.length}/160 · maximum two lines</small>
        </div>

        <SpaceToggle
          className="streaming-preview-toggle"
          checked={previewActive}
          label="Draft preview"
          onChange={setPreviewActive}
        />
        {previewActive ? (
          <div className="streaming-draft-preview" aria-label="Streaming overlay draft preview">
            {preview.tiles.length > 0 ? <StreamingMetricGrid snapshot={preview} className="streaming-preview-grid" /> : <p className="streaming-empty">No metrics selected.</p>}
            {preview.customTextEnabled && preview.customText ? <p className="streaming-overlay-custom-text">{preview.customText}</p> : null}
            {snapshotError ? <p className="streaming-safe-error" role="status">{snapshotError}</p> : null}
          </div>
        ) : null}

        <button type="button" className="streaming-save-button" onClick={() => void saveOverlay()} disabled={pendingAction !== null || draft.tiles.length > 64}>
          {pendingAction === "save" ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />} Save overlay
        </button>
      </section>
      ) : null}
      </>)}
    </div>
  );
}
