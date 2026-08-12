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
  ChevronLeft,
  ChevronRight,
  GripVertical,
  Loader2,
  Music2,
  Radio,
  RefreshCw,
  Save,
  Trash2,
  Youtube
} from "../ui-theme/app-icons.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SpaceApiError, api } from "../../api.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import {
  StreamingMetricGrid,
  useStreamingOverlay
} from "./StreamingOverlay.js";
import "./streaming.css";

type StreamingDraft = Pick<StreamingOverlaySettings, "tiles" | "customTextEnabled" | "customText"> & {
  expectedVersion: number;
};

const PROVIDERS: StreamingOAuthProvider[] = ["YOUTUBE", "TWITCH", "TIKTOK"];
const PERIODS: StreamingAnalyticsPeriod[] = [7, 28, 90];

function providerLabel(provider: StreamingProvider): string {
  if (provider === "YOUTUBE") return "YouTube";
  if (provider === "TWITCH") return "Twitch";
  if (provider === "TIKTOK") return "TikTok";
  return "Space";
}

function ProviderIcon({ provider }: { provider: StreamingOAuthProvider }) {
  const Icon = provider === "YOUTUBE" ? Youtube : provider === "TWITCH" ? Radio : Music2;
  return <Icon aria-hidden="true" />;
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
    customText: draft.customText
  };
}

export function StreamingDock() {
  const runtime = getSpaceRuntime();
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
  const mounted = useRef(true);

  const loadCatalog = useCallback(async (message?: string) => {
    setLoading(true);
    try {
      const next = await api.streamingCatalog();
      if (!mounted.current) return;
      setCatalog(next);
      setDraft(settingsDraft(next.settings));
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
    }
    window.addEventListener("message", handleOAuthMessage);
    return () => window.removeEventListener("message", handleOAuthMessage);
  }, [loadCatalog]);

  const metricsByKey = useMemo(
    () => new Map(catalog?.metrics.map((metric) => [metric.key, metric]) ?? []),
    [catalog?.metrics]
  );
  const accountsById = useMemo(
    () => new Map(catalog?.accounts.map((account) => [account.id, account]) ?? []),
    [catalog?.accounts]
  );

  function setDraftTiles(updater: (tiles: StreamingOverlayTile[]) => StreamingOverlayTile[]) {
    setDraft((current) => current ? { ...current, tiles: updater(current.tiles) } : current);
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
    if (draft.tiles.length >= 12) {
      setError("The overlay can show at most 12 metric tiles.");
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
    setPendingAction("save");
    setError(null);
    setNotice(null);
    try {
      const saved = await api.updateStreamingOverlaySettings({
        expectedVersion: draft.expectedVersion,
        tiles: draft.tiles,
        customTextEnabled: draft.customTextEnabled,
        customText: draft.customText
      });
      setDraft(settingsDraft(saved));
      setCatalog((current) => current ? { ...current, settings: saved } : current);
      setNotice("The global streaming overlay was saved.");
      await refreshSnapshot();
    } catch (saveError) {
      if (saveError instanceof SpaceApiError && saveError.status === 409) {
        await loadCatalog("A newer overlay version was loaded. Review it before saving again.");
      } else {
        setError(saveError instanceof Error ? saveError.message : "The streaming overlay could not be saved.");
      }
    } finally {
      setPendingAction(null);
    }
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

      {error ? <div className="streaming-message error" role="alert">{error}</div> : null}
      {notice ? <div className="streaming-message notice" role="status">{notice}</div> : null}

      <section className="streaming-section" aria-labelledby="streaming-providers-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Official connections</span><h3 id="streaming-providers-heading">Providers</h3></div>
        </div>
        <div className="streaming-provider-list">
          {PROVIDERS.map((provider) => {
            const readiness = catalog.providers.find((entry) => entry.provider === provider);
            const accounts = catalog.accounts.filter((account) => account.provider === provider);
            const authorizations = catalog.authorizations.filter((authorization) => authorization.provider === provider);
            const ready = readiness?.status === "READY";
            return (
              <article className="streaming-provider-card" key={provider} data-provider={provider}>
                <header>
                  <span className="streaming-provider-mark"><ProviderIcon provider={provider} /></span>
                  <div><h4>{providerLabel(provider)}</h4><span className={`streaming-readiness status-${readiness?.status.toLowerCase() ?? "error"}`}>{readiness?.status ?? "ERROR"}</span></div>
                  <button type="button" onClick={() => void connect(provider)} disabled={!ready || pendingAction !== null}>
                    {pendingAction === `connect:${provider}` ? <Loader2 className="spin" aria-hidden="true" /> : null}
                    Connect another
                  </button>
                </header>
                <p className="streaming-provider-detail">{readiness?.message ?? "Provider readiness is unavailable."}</p>
                {readiness?.status !== "READY" ? <code className="streaming-safe-code">{readiness?.code ?? "READINESS_UNAVAILABLE"}</code> : null}

                {accounts.length === 0 ? <p className="streaming-empty">No connected accounts.</p> : (
                  <ul className="streaming-account-list">
                    {accounts.map((account) => (
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
                        {account.safeErrorMessage ? <div className="streaming-safe-error"><code>{account.safeErrorCode}</code><span>{account.safeErrorMessage}</span></div> : null}
                        <fieldset className="streaming-metric-options">
                          <legend>Metrics for {account.displayName}</legend>
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
                        </fieldset>
                      </li>
                    ))}
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
              </article>
            );
          })}
        </div>
      </section>

      <section className="streaming-section" aria-labelledby="streaming-space-heading">
        <div className="streaming-section-heading"><div><span className="streaming-eyebrow">Built in</span><h3 id="streaming-space-heading">Space metrics</h3></div></div>
        <fieldset className="streaming-metric-options streaming-space-options">
          <legend>Metrics from this Space installation</legend>
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

      <section className="streaming-section" aria-labelledby="streaming-layout-heading">
        <div className="streaming-section-heading">
          <div><span className="streaming-eyebrow">Global order</span><h3 id="streaming-layout-heading">Overlay layout</h3></div>
          <strong className={draft.tiles.length >= 12 ? "at-limit" : ""}>{draft.tiles.length}/12</strong>
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
                </li>
              );
            })}
          </ol>
        )}

        <div className="streaming-custom-text">
          <SpaceToggle
            checked={draft.customTextEnabled}
            label="Custom footer text"
            onChange={(checked) => setDraft((current) => current ? { ...current, customTextEnabled: checked } : current)}
          />
          <textarea aria-label="Streaming overlay custom text" rows={2} maxLength={160} value={draft.customText} onChange={(event) => setDraft((current) => current ? { ...current, customText: twoLineText(event.target.value) } : current)} placeholder="Optional two-line message" />
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

        <button type="button" className="streaming-save-button" onClick={() => void saveOverlay()} disabled={pendingAction !== null || draft.tiles.length > 12}>
          {pendingAction === "save" ? <Loader2 className="spin" aria-hidden="true" /> : <Save aria-hidden="true" />} Save overlay
        </button>
      </section>
    </div>
  );
}
