import {
  type AgentRuntime,
  type CliRuntimeSettingsResponse,
  type CliToggleRuntimeId
} from "@space/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, SpaceApiError } from "../../api.js";
import { MAX_CLI_IMAGE_PREVIEW_LIMIT, MIN_CLI_IMAGE_PREVIEW_LIMIT, normalizeCliImagePreviewLimit } from "../../cli-upload-settings.js";
import type { WarmRoomCapacitySnapshot } from "../../warm-room-capacity-controller.js";
import { CliRuntimeSettingsCard } from "../cli-runtime-settings/CliRuntimeSettingsCard.js";
import { AlertTriangle, CheckCircle2, Gauge, Images, Loader2, RefreshCw, Terminal, X } from "../ui-theme/app-icons.js";

interface CliDockProps {
  canManage: boolean;
  cliImagePreviewLimit: number;
  warmRoomEnabled: boolean;
  warmRoomCapacity: WarmRoomCapacitySnapshot;
  onCliImagePreviewLimitChange: (limit: number) => void;
  onWarmRoomEnabledChange: (enabled: boolean) => void;
  onOpenRestartAll: () => void;
  restartAllPending: boolean;
}

interface RuntimeRestartDialogState {
  runtimeId: CliToggleRuntimeId;
  runtimeName: string;
}

function runtimeStatusLabel(runtime: AgentRuntime): string {
  if (runtime.adapterStatus === "ENABLED" && runtime.authState === "READY" && runtime.status === "ENABLED") {
    return "Ready";
  }
  return runtime.statusReason || "Unavailable";
}

export function CliDock({
  canManage,
  cliImagePreviewLimit,
  warmRoomEnabled,
  warmRoomCapacity,
  onCliImagePreviewLimitChange,
  onWarmRoomEnabledChange,
  onOpenRestartAll,
  restartAllPending
}: CliDockProps) {
  const [response, setResponse] = useState<CliRuntimeSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRuntimeId, setPendingRuntimeId] = useState<CliToggleRuntimeId | null>(null);
  const [restartDialog, setRestartDialog] = useState<RuntimeRestartDialogState | null>(null);
  const [restartResult, setRestartResult] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);

  const loadSettings = useCallback(async () => {
    if (!canManage) return;
    const requestId = ++loadRequestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.cliRuntimeSettings();
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setResponse(next);
      }
    } catch (loadError) {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setError(loadError instanceof Error ? loadError.message : "CLI runtimes could not be loaded.");
      }
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, [canManage]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSettings();
    return () => {
      mountedRef.current = false;
    };
  }, [loadSettings]);

  const runtimeById = useMemo(
    () => new Map(response?.runtimes.map((runtime) => [runtime.id, runtime]) ?? []),
    [response]
  );
  const settingById = useMemo(
    () => new Map(response?.settings.map((setting) => [setting.runtimeId, setting]) ?? []),
    [response]
  );

  const runtimes = useMemo(() => {
    const source = response?.runtimes ?? [];
    return [...source].sort((left, right) => left.displayName.localeCompare(right.displayName));
  }, [response]);

  async function confirmRuntimeRestart() {
    if (!restartDialog || pendingRuntimeId) return;
    const { runtimeId, runtimeName } = restartDialog;
    setPendingRuntimeId(runtimeId);
    setRestartResult(null);
    setError(null);
    try {
      const result = await api.cliRuntimeRestart(runtimeId);
      const restarted = result.restartedSessionIds.length;
      const failed = result.failedSessionIds.length;
      setRestartResult(
        failed > 0
          ? `${runtimeName}: ${restarted} restarted, ${failed} failed.`
          : `${runtimeName}: ${restarted} session${restarted === 1 ? "" : "s"} restarted.`
      );
    } catch (restartError) {
      setError(restartError instanceof SpaceApiError ? restartError.message : restartError instanceof Error ? restartError.message : "CLI runtime restart failed.");
    } finally {
      setPendingRuntimeId(null);
      setRestartDialog(null);
    }
  }

  return (
    <div className="cli-dock">
      <div className="dock-section-heading">
        <span>CLI runtimes</span>
        {canManage && (
          <button type="button" className="icon-button" onClick={() => void loadSettings()} aria-label="Refresh CLI runtimes">
            <RefreshCw aria-hidden="true" />
          </button>
        )}
      </div>

      {!canManage ? (
        <p className="dock-muted-text">The ADMIN role can restart CLI runtimes.</p>
      ) : (
        <>
          {error ? <p className="dock-error-text" role="alert">{error}</p> : null}
          {restartResult ? (
            <p className="cli-dock-restart-result" role="status">
              <CheckCircle2 aria-hidden="true" />
              <span>{restartResult}</span>
              <button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setRestartResult(null)}><X aria-hidden="true" /></button>
            </p>
          ) : null}

          <div className="cli-dock-restart-all">
            <div className="cli-dock-restart-all-heading">
              <Terminal aria-hidden="true" />
              <span>Restart all CLI runtimes</span>
            </div>
            <p className="dock-muted-text">
              Stops and restarts the sessions of every CLI type (codex, claude, gemini, opencode, kimi, ...). Other CLI types keep running between each restart.
            </p>
            <button
              type="button"
              className="dock-primary-button"
              disabled={restartAllPending || loading}
              onClick={onOpenRestartAll}
            >
              {restartAllPending ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
              Restart all
            </button>
          </div>

          <div className="cli-dock-runtime-list">
            {runtimes.length === 0 && loading ? (
              <p className="dock-muted-text">Loading CLI runtimes...</p>
            ) : runtimes.length === 0 ? (
              <p className="dock-muted-text">No CLI runtimes discovered.</p>
            ) : (
              runtimes.map((runtime) => {
                const runtimeId = runtime.id as CliToggleRuntimeId;
                const setting = settingById.get(runtimeId);
                const enabled = setting?.enabled === true;
                return (
                  <div className="cli-dock-runtime-row" key={runtime.id}>
                    <div className="cli-dock-runtime-main">
                      <span className="cli-dock-runtime-name">{runtime.displayName}</span>
                      <span className="dock-muted-text">{enabled ? runtimeStatusLabel(runtime) : "Disabled"}</span>
                    </div>
                    <button
                      type="button"
                      className="agent-tools-scope-button"
                      disabled={!enabled || pendingRuntimeId !== null || restartAllPending}
                      onClick={() => setRestartDialog({ runtimeId, runtimeName: runtime.displayName })}
                    >
                      {pendingRuntimeId === runtimeId ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
                      Restart
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </>
      )}

      <CliRuntimeSettingsCard canManage={canManage} />

      <section className="agent-settings-card warm-room-cache-settings-card" aria-label="Warm room cache settings">
        <div className="agent-settings-section-title">
          <Gauge aria-hidden="true" />
          <span>
            <strong>Warm room cache</strong>
            <small>{warmRoomEnabled ? "Capacity adapts to this browser." : "Disabled in this browser."}</small>
          </span>
        </div>
        <label className="settings-toggle-row warm-room-enable-toggle">
          <input
            type="checkbox"
            name="warm-room-cache-enabled"
            checked={warmRoomEnabled}
            onChange={(event) => onWarmRoomEnabledChange(event.target.checked)}
            aria-label="Enable warm room cache"
          />
          <span>Enable warm room cache</span>
        </label>
        <dl
          className="warm-room-capacity-status"
          role="status"
          aria-label="Warm room capacity status"
        >
          <div><dt>Safe capacity</dt><dd>{warmRoomCapacity.effectiveSafeRoomCapacity} rooms</dd></div>
          <div><dt>Warm rooms</dt><dd>{warmRoomCapacity.warmRoomCount}</dd></div>
          <div><dt>Connected panes</dt><dd>{warmRoomCapacity.connectedPaneCount}</dd></div>
          <div><dt>Memory source</dt><dd>{warmRoomCapacity.memorySource}</dd></div>
          <div>
            <dt>Pressure</dt>
            <dd>{warmRoomCapacity.pressureReasons.length
              ? warmRoomCapacity.pressureReasons.join(", ")
              : "Healthy"}</dd>
          </div>
          <div>
            <dt>Admission</dt>
            <dd>{warmRoomEnabled ? "Auto Open safely" : "Disabled"}</dd>
          </div>
        </dl>
        <p className="settings-card-note">
          {warmRoomEnabled
            ? "Space keeps one full-room reserve for an atomic cold reveal."
            : "Only the active room is mounted while the cache is off."}
        </p>
        <p className="settings-card-note">
          {warmRoomEnabled
            ? "Pressure reduces hidden warm rooms before affecting navigation."
            : "CLI processes continue running on the pane host when you leave a room."}
        </p>
      </section>

      <section className="agent-settings-card cli-upload-settings-card" aria-label="CLI photo preview settings">
        <div className="agent-settings-section-title">
          <Images aria-hidden="true" />
          <span>
            <strong>CLI photo previews</strong>
            <small>{cliImagePreviewLimit} images retained in the floating preview strip.</small>
          </span>
        </div>
        <div className="basic-settings-grid">
          <label>
            <span>Photo previews</span>
            <input
              type="number"
              min={MIN_CLI_IMAGE_PREVIEW_LIMIT}
              max={MAX_CLI_IMAGE_PREVIEW_LIMIT}
              step={1}
              aria-label="CLI photo preview limit"
              name="cli-image-preview-limit"
              value={cliImagePreviewLimit}
              onChange={(event) => onCliImagePreviewLimitChange(normalizeCliImagePreviewLimit(event.target.value))}
            />
          </label>
        </div>
      </section>

      {restartDialog ? (
        <div className="cli-runtime-disable-backdrop" onClick={() => { if (!pendingRuntimeId) setRestartDialog(null); }}>
          <section
            className="cli-runtime-disable-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cli-runtime-restart-title"
          >
            <div className="cli-runtime-disable-heading">
              <AlertTriangle aria-hidden="true" />
              <strong id="cli-runtime-restart-title">Restart {restartDialog.runtimeName}?</strong>
            </div>
            <p className="cli-runtime-disable-impact">
              All active {restartDialog.runtimeName} sessions are stopped and started again. Other CLI types are not affected.
            </p>
            <div className="cli-runtime-disable-actions">
              <button type="button" onClick={() => setRestartDialog(null)} disabled={pendingRuntimeId !== null}>
                Cancel
              </button>
              <button type="button" className="is-danger" onClick={() => void confirmRuntimeRestart()} disabled={pendingRuntimeId !== null}>
                {pendingRuntimeId === restartDialog.runtimeId ? "Restarting..." : "Restart"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
