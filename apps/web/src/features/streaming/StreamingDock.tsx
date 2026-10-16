import type {
  StreamingAnalyticsPeriod,
  StreamingBotStatus,
  StreamingCatalogResponse,
  StreamingMetricDefinition,
  StreamingMetricTileSnapshot,
  StreamingOAuthProvider,
  StreamingOverlaySettings,
  StreamingOverlaySnapshot,
  StreamingOverlayTile,
  StreamingPlatformAccount
} from "@space/contracts";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  GripVertical,
  LayoutGrid,
  Loader2,
  Music2,
  Plug,
  Radio,
  RefreshCw,
  Save,
  Trash2,
  Unplug,
  Youtube,
  Discord,
  XSocialIcon
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { SpaceApiError, api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { writeClipboardText } from "../clipboard-dock/clipboard-events.js";
import { useIsDockActive } from "../docks/dock-active-context.js";
import {
  DockButton,
  DockIconButton,
  DockNotice,
  DockState,
  DockToolbar,
  useDockConfirm
} from "../dock-kit/DockKit.js";
import {
  StreamingMetricGrid,
  useStreamingOverlay
} from "./StreamingOverlay.js";
import { StreamingBotTab } from "./StreamingBotTab.js";
import { StreamingMemoryTab } from "./StreamingMemoryTab.js";
import { StreamingModerationTab } from "./StreamingModerationTab.js";
import { StreamingActivityTab } from "./StreamingActivityTab.js";
import { streamingCapabilities } from "./streaming-capabilities.js";
import {
  accountStatusLabel,
  authorizationStatusLabel,
  providerLabel,
  readableCode,
  readinessCodeLabel,
  readinessStatusLabel
} from "./streaming-labels.js";
import "./streaming.css";

type StreamingDraft = Pick<StreamingOverlaySettings, "tiles" | "customTextEnabled" | "customText"> & {
  expectedVersion: number;
};

const PROVIDERS: StreamingOAuthProvider[] = ["YOUTUBE", "TWITCH", "TIKTOK", "X", "DISCORD"];
const PERIODS: StreamingAnalyticsPeriod[] = [7, 28, 90];

type StreamingTab = "overview" | "bot" | "memory" | "moderation" | "display" | "activity";

const TABS: ReadonlyArray<{ id: StreamingTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "bot", label: "Bot" },
  { id: "memory", label: "Memory" },
  { id: "moderation", label: "Moderation" },
  { id: "display", label: "Display" },
  { id: "activity", label: "Activity" }
];

const readinessTone: Record<string, string> = {
  READY: "is-success",
  UNCONFIGURED: "is-warning",
  ERROR: "is-danger"
};

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
  const isDockActive = useIsDockActive();
  const { confirm, confirmDialog } = useDockConfirm();
  const tabsId = useId();
  const tabRefs = useRef(new Map<StreamingTab, HTMLButtonElement>());
  const [activeTab, setActiveTab] = useState<StreamingTab>("overview");
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
  /** Overlay autosave runs apart from provider actions, so it never disables their buttons. */
  const [saving, setSaving] = useState(false);
  const [botStatus, setBotStatus] = useState<StreamingBotStatus | null>(null);
  /** The Bot tab stays mounted once opened, so unsaved bot settings survive a tab switch. */
  const [botTabOpened, setBotTabOpened] = useState(false);
  const [copiedProvider, setCopiedProvider] = useState<StreamingOAuthProvider | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedProviders, setExpandedProviders] = useState<Set<StreamingOAuthProvider>>(() => new Set());
  /** The preview the operator asked for; it only polls while the dock is visible. */
  const [previewRequested, setPreviewRequested] = useState(false);
  /** Shows "saved" after an overlay save until the next edit. */
  const [justSaved, setJustSaved] = useState(false);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const queuedDraftRef = useRef<StreamingDraft | null>(null);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    setSaving(true);
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
      setJustSaved(true);
      await refreshSnapshot();
    } catch (saveError) {
      if (saveError instanceof SpaceApiError && saveError.status === 409) {
        await loadCatalog("A newer overlay version was loaded. Review it before saving again.");
      } else {
        setError(saveError instanceof Error ? saveError.message : "The streaming overlay could not be saved.");
      }
    } finally {
      savingRef.current = false;
      setSaving(false);
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

  const loadBotStatus = useCallback(async () => {
    try {
      const status = await api.streamingBotStatus();
      if (mounted.current) setBotStatus(status);
    } catch {
      // The status strip is optional; the Bot tab shows the full error.
      if (mounted.current) setBotStatus(null);
    }
  }, []);

  const loadCatalog = useCallback(async (message?: string) => {
    setLoading(true);
    void loadBotStatus();
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
  }, [loadBotStatus]);

  useEffect(() => {
    mounted.current = true;
    void loadCatalog();
    return () => {
      mounted.current = false;
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      setPreviewActive(false);
    };
  }, [loadCatalog, setPreviewActive]);

  // The draft preview polls the overlay snapshot; pause it while the dock is hidden.
  useEffect(() => {
    setPreviewActive(previewRequested && isDockActive);
  }, [isDockActive, previewRequested, setPreviewActive]);

  // Window focus (for example after finishing OAuth in another tab) reloads
  // the catalog, but only while the dock is visible. Becoming visible again
  // catches up once.
  const wasDockActiveRef = useRef(isDockActive);
  useEffect(() => {
    const becameActive = isDockActive && !wasDockActiveRef.current;
    wasDockActiveRef.current = isDockActive;
    if (!isDockActive) return;
    if (becameActive) {
      void loadCatalog();
      void refreshSnapshot();
    }
    function handleWindowFocus() {
      void loadCatalog();
      void refreshSnapshot();
    }
    window.addEventListener("focus", handleWindowFocus);
    return () => window.removeEventListener("focus", handleWindowFocus);
  }, [isDockActive, loadCatalog, refreshSnapshot]);

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
    setJustSaved(false);
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

  async function copyConnectLink(provider: StreamingOAuthProvider) {
    setPendingAction(`copy:${provider}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.startStreamingOAuth(provider);
      const targetUrl = result.authorizationUrl.startsWith("http")
        ? result.authorizationUrl
        : new URL(result.authorizationUrl, window.location.origin).toString();
      await writeClipboardText(targetUrl);
      setCopiedProvider(provider);
      if (copyResetTimerRef.current) clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = setTimeout(() => {
        setCopiedProvider((current) => (current === provider ? null : current));
      }, 2500);
      setNotice(`${providerLabel(provider)} login link copied to clipboard.`);
    } catch (copyError) {
      setError(copyError instanceof Error ? copyError.message : "Provider login link could not be copied.");
    } finally {
      setPendingAction(null);
    }
  }

  async function saveOverlay() {
    if (!draft) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    await saveDraftDirect(draft);
  }

  async function removeAccount(account: StreamingPlatformAccount) {
    const accepted = await confirm({
      title: `Remove ${account.displayName}?`,
      message: "Space stops reading this account and its overlay tiles show no value. You can connect it again later.",
      confirmLabel: "Remove account"
    });
    if (!accepted) return;
    await runAction(`remove:${account.id}`, () => api.removeStreamingAccount(account.id), `${account.displayName} was removed.`);
  }

  async function disconnectAuthorization(authorizationId: string, provider: StreamingOAuthProvider, accountCount: number) {
    const label = providerLabel(provider);
    const accepted = await confirm({
      title: `Disconnect ${label}?`,
      message: `Space loses access to ${accountCount === 1 ? "the connected account" : `${accountCount} connected accounts`} until you connect ${label} again.`,
      confirmLabel: "Disconnect"
    });
    if (!accepted) return;
    await runAction(`disconnect:${authorizationId}`, () => api.disconnectStreamingAuthorization(authorizationId), `${label} authorization was disconnected.`);
  }

  function updateCustomText(update: Partial<Pick<StreamingDraft, "customText" | "customTextEnabled">>) {
    setDraft((current) => {
      if (!current) return current;
      const nextDraft = { ...current, ...update };
      scheduleAutoSave(nextDraft);
      return nextDraft;
    });
    setJustSaved(false);
  }

  function selectTab(tab: StreamingTab, focus = false) {
    setActiveTab(tab);
    if (tab === "bot") setBotTabOpened(true);
    if (focus) tabRefs.current.get(tab)?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let next = -1;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectTab(TABS[next]!.id, true);
  }

  if (loading && !catalog) {
    return (
      <div className="dock-panel streaming-dock">
        <DockState kind="loading" title="Loading streaming integrations…" />
      </div>
    );
  }

  if (!catalog || !draft) {
    return (
      <div className="dock-panel streaming-dock">
        <DockState
          kind="error"
          title="Streaming integrations could not be loaded"
          detail={error ?? "Try again in a moment."}
          action={{ label: "Try again", icon: RefreshCw, onClick: () => void loadCatalog() }}
        />
      </div>
    );
  }

  const preview = draftPreview(catalog, draft, snapshot);
  // An API from before the setup checklist answers without it while a deploy settles.
  const botSetup = botStatus?.setup ?? [];
  const spaceMetrics = catalog.metrics.filter((metric) => metric.provider === "SPACE");
  const allSpaceMetricsSelected = spaceMetrics.every((metric) =>
    draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000SPACE`)
  );
  const showsOverlaySettings = activeTab === "overview" || activeTab === "display";

  return (
    <div className="dock-panel streaming-dock" aria-label="Streaming controls">
      <DockToolbar
        className="streaming-toolbar"
        summary={<>Overlay <strong>{enabled ? "on" : "off"}</strong> in this window</>}
      >
        <DockIconButton
          label="Refresh streaming integrations"
          icon={RefreshCw}
          busy={loading}
          disabled={loading}
          onClick={() => void loadCatalog()}
        />
      </DockToolbar>

      <div className="streaming-dock-tabs" role="tablist" aria-label="Streaming dock sections">
        {TABS.map((tab, index) => {
          const selected = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={`${tabsId}-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`${tabsId}-panel`}
              tabIndex={selected ? 0 : -1}
              className={`streaming-dock-tab${selected ? " is-selected" : ""}`}
              onClick={() => selectTab(tab.id)}
              onKeyDown={(event) => handleTabKeyDown(event, index)}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      <div
        className="streaming-tab-panel"
        role="tabpanel"
        id={`${tabsId}-panel`}
        aria-labelledby={`${tabsId}-tab-${activeTab}`}
      >
      {botTabOpened || activeTab === "bot" ? (
        <div hidden={activeTab !== "bot"}><StreamingBotTab active={activeTab === "bot" && isDockActive} onStatus={setBotStatus} /></div>
      ) : null}
      {activeTab === "memory" ? <StreamingMemoryTab /> :
        activeTab === "moderation" ? <StreamingModerationTab /> : activeTab === "activity" ? <StreamingActivityTab /> : null}

      {showsOverlaySettings || error || notice ? (
        <div className="streaming-status-stack">
          {!showsOverlaySettings ? null : saving ? (
            <DockNotice tone="info" className="streaming-save-status">Saving overlay changes…</DockNotice>
          ) : isDirty ? (
            <DockNotice tone="warning" className="streaming-save-status">
              <span>Unsaved overlay changes</span>
              <DockButton icon={Save} className="streaming-save-now" onClick={() => void saveOverlay()} disabled={saving}>
                Save now
              </DockButton>
            </DockNotice>
          ) : justSaved ? (
            <DockNotice tone="success" className="streaming-save-status" onDismiss={() => setJustSaved(false)}>Overlay changes saved.</DockNotice>
          ) : null}
          {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
          {notice ? <DockNotice tone="info" onDismiss={() => setNotice(null)}>{notice}</DockNotice> : null}
        </div>
      ) : null}

      {activeTab === "display" ? (
        <section className="streaming-session-card" aria-labelledby="streaming-session-heading">
          <div>
            <h3 id="streaming-session-heading" className="dock-kit-section-title">This window</h3>
            <p className="streaming-hint">Overlay activation stays in this tab and is never saved globally.</p>
          </div>
          <SpaceToggle
            className="streaming-session-toggle"
            checked={enabled}
            label="Overlay"
            onChange={setEnabled}
          />
        </section>
      ) : null}

      {activeTab === "overview" ? <>
      {botStatus ? (
        <nav className="streaming-status-strip" aria-label="Chat companion status">
          <button type="button" className="streaming-status-chip" onClick={() => selectTab("bot")}>
            <span className="streaming-status-chip-label">Bot</span>
            {botSetup.some((item) => !item.ok)
              ? <span className="dock-kit-badge is-warning">Setup {botSetup.filter((item) => item.ok).length}/{botSetup.length}</span>
              : <span className={`dock-kit-badge ${botStatus.enabled ? "is-success" : ""}`}>{botStatus.enabled ? "Active" : "Paused"}</span>}
          </button>
          <button type="button" className="streaming-status-chip" onClick={() => selectTab("moderation")}>
            <span className="streaming-status-chip-label">Moderation</span>
            <span className={`dock-kit-badge ${botStatus.moderationEnabled ? "is-success" : ""}`}>{botStatus.moderationEnabled ? "On" : "Off"}</span>
          </button>
          <button type="button" className="streaming-status-chip" onClick={() => selectTab("memory")}>
            <span className="streaming-status-chip-label">Memory</span>
            <span className={`dock-kit-badge ${(botStatus.memoryPending ?? 0) > 0 ? "is-accent" : ""}`}>{botStatus.memoryPending ?? 0} pending</span>
          </button>
        </nav>
      ) : null}
      <section className="streaming-section" aria-labelledby="streaming-providers-heading">
        <div className="streaming-section-heading">
          <h3 id="streaming-providers-heading" className="dock-kit-section-title">Providers</h3>
          <span className="streaming-tile-count" title="Overlay tiles in use"><span>{draft.tiles.length}/64</span> tiles</span>
          {catalog.accounts.length > 0 ? (
            <DockButton
              tone="ghost"
              className="streaming-select-all-button"
              onClick={toggleAllProviderMetrics}
              aria-label={allProviderMetricsSelected ? "Deselect all provider metrics" : "All provider metrics"}
            >
              {allProviderMetricsSelected ? "Deselect all" : "All provider metrics"}
            </DockButton>
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
                {/* The header toggles on click for the pointer; the chevron is the keyboard and screen reader control. */}
                <header className="streaming-provider-header" onClick={() => toggleProviderExpanded(provider)}>
                  <span className="streaming-provider-mark"><ProviderIcon provider={provider} /></span>
                  <div className="streaming-provider-meta">
                    <div className="streaming-provider-meta-row">
                      <h4>{providerLabel(provider)}</h4>
                      <span className={`dock-kit-badge streaming-readiness ${readinessTone[readiness?.status ?? "ERROR"] ?? ""}`}>{readinessStatusLabel(readiness?.status)}</span>
                      {accounts.length > 0 ? (
                        <span className="dock-kit-badge">
                          {accounts.length} {accounts.length === 1 ? "account" : "accounts"}
                        </span>
                      ) : null}
                    </div>
                    {readiness?.status !== "READY" && readiness?.code ? (
                      <span className="streaming-readiness-detail">{readinessCodeLabel(readiness.code)}</span>
                    ) : null}
                  </div>
                  <div className="streaming-provider-header-actions">
                    <DockButton
                      tone={accounts.length > 0 || !ready ? "default" : "primary"}
                      icon={Plug}
                      busy={pendingAction === `connect:${provider}`}
                      title={ready ? undefined : `Available once the client file is ready: ${readinessCodeLabel(readiness?.code ?? "UNAVAILABLE")}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void connect(provider);
                      }}
                      disabled={!ready || pendingAction !== null}
                    >
                      {accounts.some((account) => account.status !== "ACTIVE") ? "Reconnect" : accounts.length > 0 ? "Connect another" : "Connect"}
                    </DockButton>
                    <DockButton
                      tone="ghost"
                      className={`streaming-copy-link-btn ${copiedProvider === provider ? "is-copied" : ""}`}
                      icon={copiedProvider === provider ? Check : Copy}
                      busy={pendingAction === `copy:${provider}`}
                      title={copiedProvider === provider ? "Link copied" : ready ? `Copy ${providerLabel(provider)} login link` : "Available once the client file is ready"}
                      aria-label={copiedProvider === provider ? "Link copied" : `Copy ${providerLabel(provider)} login link`}
                      onClick={(e) => {
                        e.stopPropagation();
                        void copyConnectLink(provider);
                      }}
                      disabled={!ready || pendingAction !== null}
                    >
                      {copiedProvider === provider ? "Copied" : "Copy link"}
                    </DockButton>
                    <button
                      type="button"
                      className="streaming-provider-chevron"
                      aria-expanded={isExpanded}
                      aria-label={isExpanded ? `Collapse ${providerLabel(provider)}` : `Expand ${providerLabel(provider)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleProviderExpanded(provider);
                      }}
                    >
                      {isExpanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                    </button>
                  </div>
                </header>

                {isExpanded ? (
                  <div className="streaming-provider-body">
                    <p className="streaming-hint">{readiness?.message ?? "Provider readiness is unavailable."}</p>

                    {accounts.length === 0 ? <p className="streaming-hint">No accounts connected yet.</p> : (
                      <ul className="streaming-account-list">
                        {accounts.map((account) => {
                          const capabilities = streamingCapabilities(account, authorizations.find(item => item.id === account.authorizationId));
                          const allSelected = accountMetrics(catalog, account).every((metric) =>
                            draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000${account.id}`)
                          );
                          return (
                            <li key={account.id} className="streaming-account-card">
                              <div className="streaming-account-heading">
                                <div><strong>{account.displayName}</strong><span>{account.badge} · {accountStatusLabel(account.status)}</span></div>
                                <div className="streaming-inline-actions">
                                  <DockButton icon={CheckCircle2} busy={pendingAction === `verify:${account.id}`}
                                    onClick={() => void runAction(`verify:${account.id}`, () => api.verifyStreamingAccount(account.id), `${account.displayName} was verified.`)}
                                    disabled={pendingAction !== null}>
                                    Verify
                                  </DockButton>
                                  <DockButton icon={Trash2} className="streaming-danger-button" busy={pendingAction === `remove:${account.id}`}
                                    onClick={() => void removeAccount(account)} disabled={pendingAction !== null}>
                                    Remove account
                                  </DockButton>
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
                              {capabilities.reason ? <small className="streaming-hint">{capabilities.reason}</small> : null}
                              {account.safeErrorMessage ? (
                                <p className="streaming-safe-error" title={account.safeErrorCode ? readableCode(account.safeErrorCode) : undefined}>{account.safeErrorMessage}</p>
                              ) : null}
                              <fieldset className="streaming-metric-options" aria-label={`Metrics for ${account.displayName}`}>
                                <div className="streaming-metric-header">
                                  <span className="streaming-metric-title">Metrics for {account.displayName}</span>
                                  <DockButton tone="ghost" className="streaming-select-all-button" onClick={() => toggleAllAccountMetrics(account)}>
                                    {allSelected ? "Deselect all" : "All metrics"}
                                  </DockButton>
                                </div>
                                {accountMetrics(catalog, account).map((metric) => {
                                  const checked = draft.tiles.some((tile) => tileIdentity(tile) === `${metric.key}\u0000${account.id}`);
                                  return (
                                    <SpaceToggle
                                      key={metric.key}
                                      compact
                                      checked={checked}
                                      label={metric.label}
                                      detail={readableCode(metric.category)}
                                      onChange={() => toggleMetric(metric, account)}
                                    />
                                  );
                                })}
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
                            <span>{authorization.accountCount} account{authorization.accountCount === 1 ? "" : "s"} · {authorizationStatusLabel(authorization.status)}</span>
                            <DockButton icon={Unplug} className="streaming-danger-button" busy={pendingAction === `disconnect:${authorization.id}`}
                              onClick={() => void disconnectAuthorization(authorization.id, provider, authorization.accountCount)}
                              disabled={pendingAction !== null}>
                              Disconnect authorization
                            </DockButton>
                            {authorization.safeErrorMessage ? (
                              <p className="streaming-safe-error" title={authorization.safeErrorCode ? readableCode(authorization.safeErrorCode) : undefined}>{authorization.safeErrorMessage}</p>
                            ) : null}
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
        <div className="streaming-section-heading"><h3 id="streaming-space-heading" className="dock-kit-section-title">Space metrics</h3></div>
        <fieldset className="streaming-metric-options streaming-space-options" aria-label="Metrics from this Space installation">
          <div className="streaming-metric-header">
            <span className="streaming-metric-title">Metrics from this Space installation</span>
            <DockButton tone="ghost" className="streaming-select-all-button" onClick={toggleAllSpaceMetrics}>
              {allSpaceMetricsSelected ? "Deselect all" : "All metrics"}
            </DockButton>
          </div>
          {spaceMetrics.map((metric) => (
            <SpaceToggle
              key={metric.key}
              compact
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
          <h3 id="streaming-layout-heading" className="dock-kit-section-title">Overlay layout</h3>
          <span className={`streaming-tile-count${draft.tiles.length >= 64 ? " at-limit" : ""}`}>{draft.tiles.length}/64</span>
        </div>
        {draft.tiles.length === 0 ? (
          <DockState
            kind="empty"
            icon={LayoutGrid}
            title="No overlay tiles yet"
            detail="Turn on metrics in the Overview tab to build the overlay."
            action={{ label: "Go to Overview", onClick: () => selectTab("overview", true) }}
          />
        ) : (
          <ol className="streaming-layout-list" aria-label="Streaming overlay tile order">
            {draft.tiles.map((tile, index) => {
              const metric = metricsByKey.get(tile.metricKey);
              const account = tile.accountId ? accountsById.get(tile.accountId) : null;
              const label = metric?.label ?? tile.metricKey;
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
                  <GripVertical aria-label={`Drag ${label}`} />
                  <div><strong>{label}</strong><span>{account?.badge ?? "Space"}</span></div>
                  <div className="streaming-layout-row-controls">
                    {metric?.analyticsPeriod ? (
                      <label className="streaming-period-select">
                        <span>Period</span>
                        <select className="dock-kit-select" value={tile.analyticsPeriod ?? 28} onChange={(event) => updateTilePeriod(index, Number(event.target.value) as StreamingAnalyticsPeriod)}>
                          {PERIODS.map((period) => <option value={period} key={period}>{period} days</option>)}
                        </select>
                      </label>
                    ) : null}
                    <div className="streaming-order-actions">
                      <DockIconButton label={`Move ${label} earlier`} icon={ChevronLeft} onClick={() => setDraftTiles((tiles) => moveItem(tiles, index, index - 1))} disabled={index === 0} />
                      <DockIconButton label={`Move ${label} later`} icon={ChevronRight} onClick={() => setDraftTiles((tiles) => moveItem(tiles, index, index + 1))} disabled={index === draft.tiles.length - 1} />
                      <DockIconButton label={`Remove ${label}`} icon={Trash2} tone="danger" onClick={() => setDraftTiles((tiles) => tiles.filter((_, tileIndex) => tileIndex !== index))} />
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
            onChange={(checked) => updateCustomText({ customTextEnabled: checked })}
          />
          <textarea
            className="dock-kit-field"
            aria-label="Streaming overlay custom text"
            rows={2}
            maxLength={160}
            value={draft.customText}
            onChange={(event) => updateCustomText({ customText: twoLineText(event.target.value) })}
            placeholder="Optional two-line message"
          />
          <small className={`dock-kit-counter${draft.customText.length >= 160 ? " is-over" : ""}`}>{draft.customText.length}/160 · maximum two lines</small>
        </div>

        <SpaceToggle
          className="streaming-preview-toggle"
          checked={previewRequested}
          label="Draft preview"
          onChange={setPreviewRequested}
        />
        {previewRequested ? (
          <div className="streaming-draft-preview" aria-label="Streaming overlay draft preview">
            {preview.tiles.length > 0 ? <StreamingMetricGrid snapshot={preview} className="streaming-preview-grid" /> : <p className="streaming-hint">No metrics selected.</p>}
            {preview.customTextEnabled && preview.customText ? <p className="streaming-overlay-custom-text">{preview.customText}</p> : null}
            {snapshotError ? <p className="streaming-safe-error" role="status">{snapshotError}</p> : null}
          </div>
        ) : null}

        <DockButton tone="primary" icon={Save} busy={saving} className="streaming-save-button" onClick={() => void saveOverlay()} disabled={pendingAction !== null || draft.tiles.length > 64}>
          Save overlay
        </DockButton>
      </section>
      ) : null}
      </div>
      {confirmDialog}
    </div>
  );
}
