import {
  cliRuntimeDisablePreviewSchema,
  cliToggleRuntimeIds,
  type AgentRuntime,
  type CliRuntimeDisablePreview,
  type CliRuntimeSettingsResponse,
  type CliToggleRuntimeId,
  type CliVpnConnection,
  type CliEgressRouteId,
  type CliVpnProfileId,
  type UpdateCliGlobalEgressResult,
  type RestartCliRuntimeVpnSessionsResult,
  type UpdateCliRuntimeSettingInput,
  type UpdateCliRuntimeSettingResult,
  type UpdateCliRuntimeVpnInput,
  type UpdateCliRuntimeVpnResult
} from "@space/contracts";
import { AlertTriangle, Loader2, RefreshCw, Shield, Terminal, Trash2, Upload, X } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, SpaceApiError } from "../../api.js";
import { useAutoDismiss, DEFAULT_NOTICE_DISMISS_MS } from "../../use-auto-dismiss.js";
import { CLI_RUNTIME_PRESENTATIONS, cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  dispatchCliRuntimeVisibilityChange,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";
import { publishCliVpnRoutingStatus } from "../../cli-vpn-routing.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";

const VPN_PROFILE_MANAGER_STORAGE_KEY = "space.cliVpnProfileManager.profileId";
const VPN_PROFILE_IDS = ["greece", "thailand", "mullvad"] as const;

function managedVpnProfileStorage(): Storage | null {
  try {
    return getSpaceRuntime().platform.localStorage;
  } catch {
    try {
      return window.localStorage;
    } catch {
      return null;
    }
  }
}

function readManagedVpnProfileId(): CliVpnProfileId {
  const stored = managedVpnProfileStorage()?.getItem(VPN_PROFILE_MANAGER_STORAGE_KEY);
  return (VPN_PROFILE_IDS as readonly string[]).includes(stored ?? "")
    ? (stored as CliVpnProfileId)
    : "greece";
}

function writeManagedVpnProfileId(profileId: CliVpnProfileId): void {
  try {
    managedVpnProfileStorage()?.setItem(VPN_PROFILE_MANAGER_STORAGE_KEY, profileId);
  } catch {
    void 0;
  }
}

export interface CliRuntimeSettingsClient {
  cliRuntimeSettings: () => Promise<CliRuntimeSettingsResponse>;
  cliRuntimeDisablePreview: (runtimeId: string) => Promise<CliRuntimeDisablePreview>;
  updateCliRuntimeSetting: (
    runtimeId: string,
    input: UpdateCliRuntimeSettingInput
  ) => Promise<UpdateCliRuntimeSettingResult>;
  updateCliGlobalEgress?: (routeId: CliEgressRouteId) => Promise<UpdateCliGlobalEgressResult>;
  replaceCliEgressProfile?: (profileId: CliVpnProfileId, config: string) => Promise<CliVpnConnection>;
  verifyCliEgressProfile?: (profileId: CliVpnProfileId) => Promise<CliVpnConnection>;
  removeCliEgressProfile?: (profileId: CliVpnProfileId) => Promise<CliVpnConnection>;
  rotateCliMullvadCity?: () => Promise<CliVpnConnection>;
  replaceCliVpnProfile?: (config: string) => Promise<CliVpnConnection>;
  verifyCliVpnProfile?: () => Promise<CliVpnConnection>;
  removeCliVpnProfile?: () => Promise<CliVpnConnection>;
  updateCliRuntimeVpn?: (runtimeId: string, input: UpdateCliRuntimeVpnInput) => Promise<UpdateCliRuntimeVpnResult>;
  restartCliRuntimeVpnSessions?: (runtimeId: string) => Promise<RestartCliRuntimeVpnSessionsResult>;
  invalidateCliRuntimes: () => void;
}

interface DisableDialogState {
  preview: CliRuntimeDisablePreview;
  runtimeName: string;
  notice: string | null;
  error: string | null;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

const cliEgressRoutes: ReadonlyArray<{ id: CliEgressRouteId; label: string }> = [
  { id: "direct", label: "Direct · Germany" },
  { id: "greece", label: "VPN · Greece" },
  { id: "thailand", label: "VPN · Thailand" },
  { id: "mullvad", label: "VPN · Mullvad" }
];

function cliEgressRouteLabel(routeId: CliEgressRouteId): string {
  return cliEgressRoutes.find((route) => route.id === routeId)?.label ?? routeId;
}

function cliVpnProfileLabel(profileId: CliVpnProfileId): string {
  return profileId === "greece" ? "Greece WireGuard" : profileId === "thailand" ? "Thailand WireGuard" : "Mullvad WireGuard";
}

function runtimeStatus(runtime: AgentRuntime | undefined): { installation: string; authentication: string; reason: string } {
  if (!runtime) {
    return { installation: "Not detected", authentication: "Auth unavailable", reason: "Runtime inventory is unavailable." };
  }
  const installation = runtime.adapterStatus === "ENABLED"
    ? "Installed"
    : runtime.adapterStatus === "ERROR"
      ? "Install error"
      : "Unavailable";
  const authentication = runtime.authState === "READY"
    ? "Authenticated"
    : runtime.authState === "SETUP_REQUIRED"
      ? "Setup required"
      : runtime.authState === "LOGIN_REQUIRED"
        ? "Login required"
        : "Auth unavailable";
  return { installation, authentication, reason: runtime.statusReason };
}

function DisableRuntimeDialog({
  dialog,
  pending,
  onCancel,
  onConfirm,
  onDismissNotice,
  onDismissError
}: {
  dialog: DisableDialogState;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onDismissNotice: () => void;
  onDismissError: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && !pending) {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const buttons = Array.from(bodyRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const first = buttons[0];
    const last = buttons.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const sessions = dialog.preview.activeSessionCount;
  const panes = dialog.preview.openPaneCount;
  const isCodexMaster = dialog.preview.runtimeId === "cli:codex";
  return createPortal(
    <div className="cli-runtime-disable-backdrop" onClick={() => { if (!pending) onCancel(); }}>
      <div
        ref={bodyRef}
        className="cli-runtime-disable-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-runtime-disable-title"
        aria-describedby="cli-runtime-disable-impact"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="cli-runtime-disable-heading">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong id="cli-runtime-disable-title">Disable {dialog.runtimeName}?</strong>
            <small>{isCodexMaster
              ? "This turns off Codex CLI, Chat, Room Agent, and Codex tools globally."
              : "This runtime disappears globally until an administrator enables it again."}</small>
          </span>
        </div>
        {isCodexMaster ? (
          <ul id="cli-runtime-disable-impact" className="cli-runtime-disable-impact cli-runtime-master-impact">
            <li><strong>{sessions}</strong> active Codex CLI {sessions === 1 ? "session" : "sessions"} will stop.</li>
            <li><strong>{panes}</strong> open Codex CLI {panes === 1 ? "pane" : "panes"} will close.</li>
            <li><strong>{dialog.preview.activeChatRunCount}</strong> active native Chat {dialog.preview.activeChatRunCount === 1 ? "run" : "runs"} will stop.</li>
            <li><strong>{dialog.preview.openChatPaneCount}</strong> open Chat {dialog.preview.openChatPaneCount === 1 ? "pane" : "panes"} will close.</li>
            <li><strong>{dialog.preview.activeRoomAgentMissionCount}</strong> active Room Agent {dialog.preview.activeRoomAgentMissionCount === 1 ? "mission" : "missions"} will stop.</li>
            <li><strong>{dialog.preview.matchingProcessCount}</strong> running Codex {dialog.preview.matchingProcessCount === 1 ? "process" : "processes"} will be terminated.</li>
          </ul>
        ) : (
          <p id="cli-runtime-disable-impact" className="cli-runtime-disable-impact">
            <strong>{sessions}</strong> active {sessions === 1 ? "session" : "sessions"} will stop and <strong>{panes}</strong> open {panes === 1 ? "pane" : "panes"} will close.
          </p>
        )}
        <p className="cli-runtime-disable-note">
          Saved task history and transcripts stay intact. Enabling the runtime later will not reopen these sessions or panes.
        </p>
        {dialog.notice ? (
          <p className="cli-runtime-disable-stale" role="status">{dialog.notice}<button type="button" className="notice-close" aria-label="Dismiss message" onClick={onDismissNotice}><X aria-hidden="true" /></button></p>
        ) : null}
        {dialog.error ? (
          <p className="cli-runtime-disable-error" role="alert">{dialog.error}<button type="button" className="notice-close" aria-label="Dismiss message" onClick={onDismissError}><X aria-hidden="true" /></button></p>
        ) : null}
        <div className="cli-runtime-disable-actions">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending}>Cancel</button>
          <button className="is-danger" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="spin" aria-hidden="true" /> : null}
            Disable {dialog.runtimeName}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function CliRuntimeSettingsCard({
  canManage,
  client = api
}: {
  canManage: boolean;
  client?: CliRuntimeSettingsClient;
}) {
  const [response, setResponse] = useState<CliRuntimeSettingsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingRuntimeId, setPendingRuntimeId] = useState<CliToggleRuntimeId | null>(null);
  const [pendingVpnRuntimeId, setPendingVpnRuntimeId] = useState<CliToggleRuntimeId | null>(null);
  const [pendingEgressRoute, setPendingEgressRoute] = useState<CliEgressRouteId | null>(null);
  const [vpnProfilePending, setVpnProfilePending] = useState(false);
  const [vpnProfileId, setVpnProfileId] = useState<CliVpnProfileId>(readManagedVpnProfileId);
  const [vpnProfileConfig, setVpnProfileConfig] = useState("");
  const [vpnProfileFilename, setVpnProfileFilename] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DisableDialogState | null>(null);
  const toggleRefs = useRef(new Map<CliToggleRuntimeId, HTMLInputElement>());
  const mountedRef = useRef(true);

  useAutoDismiss(error, setError);
  useAutoDismiss(feedback, setFeedback);

  useEffect(() => {
    if (!dialog?.notice) return;
    const timer = window.setTimeout(() => {
      setDialog((current) => (current?.notice === dialog.notice ? { ...current, notice: null } : current));
    }, DEFAULT_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [dialog?.notice]);

  useEffect(() => {
    if (!dialog?.error) return;
    const timer = window.setTimeout(() => {
      setDialog((current) => (current?.error === dialog.error ? { ...current, error: null } : current));
    }, DEFAULT_NOTICE_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [dialog?.error]);
  const loadRequestIdRef = useRef(0);

  const loadSettings = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!canManage) return;
    setLoading(true);
    setError(null);
    try {
      const next = await client.cliRuntimeSettings();
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setResponse(next);
        publishCliVpnRoutingStatus();
      }
    } catch (loadError) {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setError(errorMessage(loadError, "CLI runtime settings could not be loaded."));
      }
    } finally {
      if (mountedRef.current && requestId === loadRequestIdRef.current) setLoading(false);
    }
  }, [canManage, client]);

  useEffect(() => {
    mountedRef.current = true;
    void loadSettings();
    return () => {
      mountedRef.current = false;
    };
  }, [loadSettings]);

  useEffect(() => {
    if (!canManage) return;
    const handleVisibilityChange = (event: Event) => {
      const change = readCliRuntimeVisibilityChange(event);
      if (!change || change.source === "settings-card") return;
      void loadSettings();
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
  }, [canManage, loadSettings]);

  useEffect(() => {
    const removed = response?.egress?.removedProfiles ?? [];
    if (!removed.includes(vpnProfileId)) return;
    const fallback = (["greece", "thailand", "mullvad"] as const).find((profileId) => !removed.includes(profileId)) ?? "greece";
    setVpnProfileId(fallback);
    writeManagedVpnProfileId(fallback);
    setVpnProfileConfig("");
    setVpnProfileFilename("");
  }, [response, vpnProfileId]);

  const settingById = useMemo(
    () => new Map(response?.settings.map((setting) => [setting.runtimeId, setting]) ?? []),
    [response]
  );
  const runtimeById = useMemo(
    () => new Map(response?.runtimes.map((runtime) => [runtime.id, runtime]) ?? []),
    [response]
  );
  const vpnApplicationById = useMemo(
    () => new Map(response?.vpnApplications.map((application) => [application.runtimeId, application]) ?? []),
    [response]
  );

  function restoreToggleFocus(runtimeId: CliToggleRuntimeId) {
    window.requestAnimationFrame(() => toggleRefs.current.get(runtimeId)?.focus());
  }

  function closeDialog() {
    if (!dialog || pendingRuntimeId) return;
    const runtimeId = dialog.preview.runtimeId;
    setDialog(null);
    restoreToggleFocus(runtimeId);
  }

  function applySettingResult(runtimeId: CliToggleRuntimeId, result: UpdateCliRuntimeSettingResult) {
    setResponse((current) => current ? {
      ...current,
      settings: current.settings.map((setting) => setting.runtimeId === runtimeId ? result.setting : setting)
    } : current);
    client.invalidateCliRuntimes();
    dispatchCliRuntimeVisibilityChange({ runtimeId, enabled: result.setting.enabled, source: "settings-card" });
    const unresolvedSessions = result.cleanup?.unresolvedSessionIds.length ?? 0;
    const unresolvedPanes = result.cleanup?.unresolvedPaneIds.length ?? 0;
    const unresolvedChatRuns = result.cleanup?.unresolvedChatPaneIds.length ?? 0;
    const unresolvedRoomAgentMissions = result.cleanup?.unresolvedRoomAgentMissionIds.length ?? 0;
    const displayName = cliRuntimePresentation(runtimeId)?.displayName ?? runtimeId;
    const hasUnresolvedCleanup = unresolvedSessions
      + unresolvedPanes
      + unresolvedChatRuns
      + unresolvedRoomAgentMissions > 0;
    setFeedback(hasUnresolvedCleanup && runtimeId === "cli:codex"
      ? `${displayName} is disabled, but cleanup remains unresolved: ${unresolvedSessions} CLI sessions, ${unresolvedPanes} panes, ${unresolvedChatRuns} Chat runs/panes, and ${unresolvedRoomAgentMissions} Room Agent missions.`
      : hasUnresolvedCleanup
        ? `${displayName} is disabled, but ${unresolvedSessions} sessions and ${unresolvedPanes} panes remain unresolved.`
        : `${displayName} is now ${result.setting.enabled ? "enabled" : "disabled"}.`);
  }

  async function requestToggle(runtimeId: CliToggleRuntimeId, enabled: boolean) {
    if (pendingRuntimeId) return;
    setError(null);
    setFeedback(null);
    setPendingRuntimeId(runtimeId);
    if (enabled) {
      try {
        const result = await client.updateCliRuntimeSetting(runtimeId, { enabled: true });
        applySettingResult(runtimeId, result);
      } catch (updateError) {
        setError(errorMessage(updateError, "CLI runtime could not be enabled."));
      } finally {
        setPendingRuntimeId(null);
      }
      return;
    }
    try {
      const preview = await client.cliRuntimeDisablePreview(runtimeId);
      setDialog({
        preview,
        runtimeName: cliRuntimePresentation(runtimeId)?.displayName ?? runtimeId,
        notice: null,
        error: null
      });
    } catch (previewError) {
      setError(errorMessage(previewError, "Disable impact could not be loaded."));
    } finally {
      setPendingRuntimeId(null);
    }
  }

  async function confirmDisable() {
    if (!dialog || pendingRuntimeId) return;
    const runtimeId = dialog.preview.runtimeId;
    setPendingRuntimeId(runtimeId);
    setDialog((current) => current ? { ...current, error: null } : current);
    try {
      const result = await client.updateCliRuntimeSetting(runtimeId, {
        enabled: false,
        confirmationToken: dialog.preview.confirmationToken
      });
      applySettingResult(runtimeId, result);
      setDialog(null);
      restoreToggleFocus(runtimeId);
    } catch (updateError) {
      const parsedStalePreview = updateError instanceof SpaceApiError
        && updateError.code === "CLI_RUNTIME_DISABLE_CONFIRMATION_STALE"
          ? cliRuntimeDisablePreviewSchema.safeParse(updateError.details)
          : null;
      const stalePreview = parsedStalePreview?.success && parsedStalePreview.data.runtimeId === runtimeId
        ? parsedStalePreview.data
        : null;
      if (stalePreview) {
        setDialog((current) => current ? {
          ...current,
          preview: stalePreview,
          notice: "The impact changed. Review the updated counts and confirm again.",
          error: null
        } : current);
      } else {
        setDialog((current) => current ? {
          ...current,
          error: errorMessage(updateError, "CLI runtime could not be disabled.")
        } : current);
      }
    } finally {
      setPendingRuntimeId(null);
    }
  }

  async function selectVpnProfile(profileId: CliVpnProfileId, file: File | null) {
    setError(null);
    setFeedback(null);
    setVpnProfileId(profileId);
    setVpnProfileConfig("");
    setVpnProfileFilename("");
    if (!file) return;
    if (file.size < 64 || file.size > 65_536) {
      setError("WireGuard configuration must be between 64 bytes and 64 KiB.");
      return;
    }
    try {
      const config = await file.text();
      setVpnProfileConfig(config);
      setVpnProfileFilename(file.name);
    } catch {
      setError("WireGuard configuration could not be read.");
    }
  }

  function selectVpnProfileManager(profileId: CliVpnProfileId) {
    if (vpnControlsPending || profileId === vpnProfileId) return;
    setVpnProfileId(profileId);
    writeManagedVpnProfileId(profileId);
    setVpnProfileConfig("");
    setVpnProfileFilename("");
    setError(null);
    setFeedback(null);
  }

  async function saveVpnProfile(profileId: CliVpnProfileId) {
    if (!vpnProfileConfig || vpnProfilePending) return;
    setVpnProfilePending(true);
    setError(null);
    setFeedback(null);
    try {
      if (!client.replaceCliEgressProfile) throw new Error("Global CLI egress profile controls are unavailable.");
      await client.replaceCliEgressProfile(profileId, vpnProfileConfig);
      setVpnProfileConfig("");
      setVpnProfileFilename("");
      await loadSettings();
      setFeedback(`${cliVpnProfileLabel(profileId)} profile saved and verified.`);
    } catch (profileError) {
      setError(errorMessage(profileError, "WireGuard profile could not be saved and verified."));
    } finally {
      setVpnProfilePending(false);
    }
  }

  async function verifyVpnProfile(profileId: CliVpnProfileId) {
    if (vpnProfilePending) return;
    setVpnProfilePending(true);
    setError(null);
    setFeedback(null);
    try {
      if (!client.verifyCliEgressProfile) throw new Error("Global CLI egress profile controls are unavailable.");
      await client.verifyCliEgressProfile(profileId);
      await loadSettings();
      setFeedback(`${cliVpnProfileLabel(profileId)} handshake, DNS and egress were verified.`);
    } catch (verifyError) {
      setError(errorMessage(verifyError, "CLI VPN verification failed."));
    } finally {
      setVpnProfilePending(false);
    }
  }

  async function removeVpnProfile(profileId: CliVpnProfileId) {
    if (vpnProfilePending) return;
    setVpnProfilePending(true);
    setError(null);
    setFeedback(null);
    try {
      if (!client.removeCliEgressProfile) throw new Error("Global CLI egress profile controls are unavailable.");
      await client.removeCliEgressProfile(profileId);
      await loadSettings();
      setFeedback(`${cliVpnProfileLabel(profileId)} profile removed.`);
    } catch (removeError) {
      setError(errorMessage(removeError, "WireGuard profile could not be removed."));
    } finally {
      setVpnProfilePending(false);
    }
  }

  async function rotateMullvadCity() {
    if (vpnProfilePending) return;
    setVpnProfilePending(true);
    setError(null);
    setFeedback(null);
    try {
      if (!client.rotateCliMullvadCity) throw new Error("Mullvad city controls are unavailable.");
      const connection = await client.rotateCliMullvadCity();
      await loadSettings();
      publishCliVpnRoutingStatus();
      setFeedback(connection.relay
        ? `Mullvad changed to ${connection.relay.cityName}, ${connection.relay.countryName} (${connection.egressIpv4 ?? "public IP verifying"}).`
        : "Mullvad city changed and the new egress was verified.");
    } catch (rotateError) {
      setError(errorMessage(rotateError, "Mullvad city could not be changed."));
    } finally {
      setVpnProfilePending(false);
    }
  }

  async function updateGlobalRoute(routeId: CliEgressRouteId) {
    if (pendingEgressRoute || routeId === response?.egress?.selectedRoute) return;
    setPendingEgressRoute(routeId);
    setError(null);
    setFeedback(null);
    try {
      if (!client.updateCliGlobalEgress) throw new Error("Global CLI egress controls are unavailable.");
      const result = await client.updateCliGlobalEgress(routeId);
      await loadSettings();
      publishCliVpnRoutingStatus();
      const routeLabel = cliEgressRouteLabel(routeId);
      setFeedback(
        routeId === "direct"
          ? "Direct selected; VPN was turned off for every CLI."
          : result.failedSessionIds.length
            ? `${routeLabel} selected for VPN-enabled CLIs; ${result.failedSessionIds.length} legacy sessions could not restart.`
            : `${routeLabel} selected for VPN-enabled CLIs${result.restartedSessionIds.length ? `; ${result.restartedSessionIds.length} legacy sessions restarted automatically` : ""}.`
      );
    } catch (vpnError) {
      setError(errorMessage(vpnError, "Global CLI egress could not be changed."));
    } finally {
      setPendingEgressRoute(null);
    }
  }

  async function updateRuntimeVpn(runtimeId: CliToggleRuntimeId, enabled: boolean) {
    if (pendingVpnRuntimeId) return;
    setPendingVpnRuntimeId(runtimeId);
    setError(null);
    setFeedback(null);
    try {
      if (!client.updateCliRuntimeVpn) throw new Error("Per-CLI VPN controls are unavailable.");
      await client.updateCliRuntimeVpn(runtimeId, { enabled });
      await loadSettings();
      publishCliVpnRoutingStatus();
      const displayName = cliRuntimePresentation(runtimeId)?.displayName ?? runtimeId;
      setFeedback(enabled
        ? `${displayName} now uses ${cliEgressRouteLabel(selectedRoute)}. Active sessions were restarted when needed.`
        : `${displayName} now uses Direct network access. Active sessions were restarted when needed.`);
    } catch (vpnError) {
      setError(errorMessage(vpnError, "CLI VPN route could not be changed."));
    } finally {
      setPendingVpnRuntimeId(null);
    }
  }

  if (!canManage) return null;
  const selectedRoute = response?.egress?.selectedRoute ?? "direct";
  const removedProfiles = response?.egress?.removedProfiles ?? [];
  const availableProfileIds = (["greece", "thailand", "mullvad"] as const).filter((profileId) => !removedProfiles.includes(profileId));
  const availableEgressRoutes = cliEgressRoutes.filter((route) => route.id === "direct" || !removedProfiles.includes(route.id));
  const vpnControlsPending = vpnProfilePending || Boolean(pendingEgressRoute) || Boolean(pendingVpnRuntimeId);
  const selectedRouteStatus = selectedRoute === "direct"
    ? "DIRECT"
    : response?.egress?.profiles[selectedRoute].status ?? "NOT_CONFIGURED";
  const selectedEgressIp = selectedRoute === "direct"
    ? response?.egress?.directEgressIpv4
    : response?.egress?.profiles[selectedRoute].egressIpv4;
  const managedProfile = response?.egress?.profiles[vpnProfileId];
  const managedProfileLabel = cliVpnProfileLabel(vpnProfileId);
  const managedProfileIsActive = selectedRoute === vpnProfileId;
  const managedProfileHasDraft = Boolean(vpnProfileConfig);

  return (
    <section className="agent-settings-card cli-runtime-settings-card" aria-label="CLI runtime visibility settings" aria-busy={loading}>
      <div className="agent-settings-section-title cli-runtime-settings-title">
        <Terminal aria-hidden="true" />
        <span>
          <strong>CLI runtimes</strong>
          <small>Global launcher, pane and history visibility. Administrator only.</small>
        </span>
        <button
          className="icon-action"
          type="button"
          aria-label="Refresh CLI runtime settings"
          title="Refresh CLI runtime settings"
          disabled={loading || Boolean(pendingRuntimeId)}
          onClick={() => void loadSettings()}
        >
          <RefreshCw aria-hidden="true" />
        </button>
      </div>

      <div className={`cli-vpn-profile${selectedRouteStatus === "DIRECT" || selectedRouteStatus === "CONNECTED" ? " is-connected" : ""}`} aria-label="Global CLI network route">
        <div className="cli-vpn-profile-heading">
          <Shield aria-hidden="true" />
          <span>
            <strong>VPN route for enabled CLIs</strong>
            <small>Choose the VPN provider below; each CLI can then use it or stay Direct. Native Chat, Room Agent, root shell and Space services stay direct.</small>
          </span>
          <span className={`cli-vpn-health is-${selectedRouteStatus === "DIRECT" ? "connected" : selectedRouteStatus.toLowerCase()}`}>
            {selectedRouteStatus}
          </span>
        </div>
        {response?.vpnSupported ? (
          <>
            <div className="cli-vpn-profile-details">
              <span>Selected <strong>{cliEgressRouteLabel(selectedRoute)}</strong></span>
              {selectedEgressIp ? <span>Public IPv4 <strong>{selectedEgressIp}</strong></span> : null}
              <span>VPN leak protection <strong>Blocks VPN-enabled CLI traffic if the tunnel fails</strong></span>
            </div>
            <div className="cli-egress-route-select">
              <label htmlFor="cli-egress-route">VPN route for enabled CLIs</label>
              <select
                id="cli-egress-route"
                name="cli-egress-route"
                aria-label="VPN route for enabled CLIs"
                value={selectedRoute}
                disabled={vpnControlsPending}
                onChange={(event) => void updateGlobalRoute(event.target.value as CliEgressRouteId)}
              >
                {availableEgressRoutes.map(({ id, label }) => {
                  const connection = id === "direct" ? null : response.egress?.profiles[id];
                  return <option key={id} value={id} disabled={id !== "direct" && connection?.status !== "CONNECTED"}>{label}</option>;
                })}
              </select>
              <small>{pendingEgressRoute
                ? <><Loader2 className="spin" aria-hidden="true" />Applying {cliEgressRouteLabel(pendingEgressRoute)}…</>
                : selectedRoute === "direct"
                  ? "Direct selected; all CLI VPN toggles are off."
                  : selectedEgressIp ?? response.egress?.profiles[selectedRoute].status ?? "Profile setup required"}</small>
            </div>
            <div className="cli-egress-profile-manager" aria-label="VPN profile manager">
              {availableProfileIds.length === 0 ? (
                <small className="cli-egress-profile-helper">All VPN profiles were removed. No profile can be configured.</small>
              ) : (
                <>
                  <div className="cli-egress-route-select">
                    <label htmlFor="cli-egress-profile">VPN profile to manage</label>
                    <select
                      id="cli-egress-profile"
                      name="cli-egress-profile"
                      aria-label="VPN profile to manage"
                      value={vpnProfileId}
                      disabled={vpnControlsPending}
                      onChange={(event) => selectVpnProfileManager(event.target.value as CliVpnProfileId)}
                    >
                      {availableProfileIds.map((profileId) => (
                        <option key={profileId} value={profileId}>{cliVpnProfileLabel(profileId)}</option>
                      ))}
                    </select>
                    <small>Managing a profile does not change the route used by CLI sessions.</small>
                  </div>
                  <div className={`cli-egress-profile${managedProfile?.status === "CONNECTED" ? " is-connected" : ""}`}>
                    <div className="cli-egress-profile-title">
                      <strong>{managedProfileLabel}</strong>
                      <span>{managedProfile?.status ?? "NOT_CONFIGURED"}</span>
                    </div>
                    <div className="cli-vpn-profile-details">
                      <span>Public IPv4 <strong>{managedProfile?.egressIpv4 ?? "Not verified"}</strong></span>
                      {vpnProfileId === "mullvad" && managedProfile?.relay ? (
                        <>
                          <span>City <strong>{managedProfile.relay.cityName}</strong></span>
                          <span>Country <strong>{managedProfile.relay.countryName}</strong></span>
                          <span>Relay <strong>{managedProfile.relay.hostname}</strong></span>
                        </>
                      ) : null}
                    </div>
                    <div className="cli-vpn-profile-actions">
                      <button type="button" disabled={!managedProfile?.profileConfigured || vpnControlsPending} onClick={() => void verifyVpnProfile(vpnProfileId)}>Verify</button>
                      {vpnProfileId === "mullvad" ? (
                        <button type="button" disabled={!managedProfile?.profileConfigured || vpnControlsPending} onClick={() => void rotateMullvadCity()}>
                          {vpnProfilePending ? <Loader2 className="spin" aria-hidden="true" /> : null}
                          Change city
                        </button>
                      ) : null}
                      <button className="is-danger" type="button" disabled={!managedProfile?.profileConfigured || managedProfileIsActive || vpnControlsPending} onClick={() => void removeVpnProfile(vpnProfileId)}>
                        <Trash2 aria-hidden="true" />Remove
                      </button>
                    </div>
                    {managedProfileIsActive ? <small className="cli-egress-profile-helper">Select Direct before removing the currently active profile.</small> : null}
                    <div className="cli-vpn-profile-upload">
                      <label className="cli-vpn-file-picker">
                        <Upload aria-hidden="true" />
                        <span>{vpnProfileFilename || "Choose WireGuard .conf"}</span>
                        <input
                          type="file"
                          name={`cli-vpn-profile-${vpnProfileId}`}
                          accept=".conf,text/plain"
                          aria-label={`Choose ${managedProfileLabel} configuration`}
                          disabled={vpnControlsPending}
                          onChange={(event) => void selectVpnProfile(vpnProfileId, event.target.files?.[0] ?? null)}
                        />
                      </label>
                      <button type="button" disabled={!managedProfileHasDraft || vpnControlsPending} onClick={() => void saveVpnProfile(vpnProfileId)}>
                        {vpnProfilePending ? <Loader2 className="spin" aria-hidden="true" /> : null}
                        Save &amp; verify
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
            <small className="cli-vpn-profile-note">Private keys stay root-only and are never returned to the browser or audit log.</small>
          </>
        ) : (
          <small className="cli-vpn-profile-note">CLI VPN support is disabled on this Space installation.</small>
        )}
      </div>

      {!response && loading ? <p className="cli-runtime-settings-state" role="status"><Loader2 className="spin" aria-hidden="true" />Loading CLI runtime settings…</p> : null}
      <div className="cli-runtime-settings-list">
        {CLI_RUNTIME_PRESENTATIONS.map((presentation) => {
          const runtimeId = presentation.id as CliToggleRuntimeId;
          const setting = settingById.get(runtimeId);
          const enabled = setting?.enabled ?? true;
          const vpnEnabled = setting?.vpnEnabled ?? false;
          const vpnApplication = vpnApplicationById.get(runtimeId);
          const status = runtimeStatus(runtimeById.get(runtimeId));
          return (
            <div className={`cli-runtime-settings-row${enabled ? "" : " is-disabled"}`} key={runtimeId} data-runtime-id={runtimeId}>
              <img src={presentation.iconSrc} alt="" aria-hidden="true" data-terminal-runtime-brand={presentation.brand} draggable={false} />
              <div className="cli-runtime-settings-copy">
                <div className="cli-runtime-settings-name">
                  <strong>{presentation.displayName}</strong>
                  {runtimeId === "cli:codex" ? <span>Master</span> : null}
                </div>
                <div className="cli-runtime-settings-badges" aria-label={`${presentation.displayName} status`}>
                  <span>{status.installation}</span>
                  <span>{status.authentication}</span>
                  <span>{runtimeId === "cli:codex" ? `Master ${enabled ? "On" : "Off"}` : enabled ? "Visible" : "Hidden"}</span>
                  <span className={`is-vpn-mode is-${vpnApplication?.effectiveMode === "VPN" ? "vpn" : vpnApplication?.effectiveMode === "BLOCKED" ? "blocked" : "direct"}`}>
                    {vpnApplication?.effectiveMode === "VPN" ? cliEgressRouteLabel(selectedRoute) : "Direct"}
                  </span>
                  {(vpnApplication?.restartRequiredSessionIds.length ?? 0) > 0
                    ? <span className="is-restart-required">Restart failed ({vpnApplication!.restartRequiredSessionIds.length})</span>
                    : null}
                </div>
                <small>{runtimeId === "cli:codex"
                  ? "Controls Codex CLI, Chat, Room Agent, and Codex tools globally."
                  : status.reason}</small>
              </div>
              <label className="cli-runtime-vpn-toggle" title={selectedRoute === "direct" && !vpnEnabled ? "Choose a VPN route before enabling this CLI." : undefined}>
                <input
                  type="checkbox"
                  role="switch"
                  name={`cli-runtime-vpn-${presentation.brand}`}
                  aria-label={`Use VPN for ${presentation.displayName}`}
                  checked={vpnEnabled}
                  disabled={!response || !enabled || Boolean(pendingVpnRuntimeId) || (selectedRoute === "direct" && !vpnEnabled)}
                  onChange={(event) => void updateRuntimeVpn(runtimeId, event.target.checked)}
                />
                <span>VPN {vpnEnabled ? "On" : "Off"}</span>
              </label>
              <label className="cli-runtime-visibility-toggle">
                <input
                  ref={(element) => {
                    if (element) toggleRefs.current.set(runtimeId, element);
                    else toggleRefs.current.delete(runtimeId);
                  }}
                  type="checkbox"
                  role="switch"
                  name={`cli-runtime-enabled-${presentation.brand}`}
                  aria-label={`Enable ${presentation.displayName}`}
                  checked={enabled}
                  disabled={!response || Boolean(pendingRuntimeId)}
                  onChange={(event) => void requestToggle(runtimeId, event.target.checked)}
                />
                <span>{enabled ? "On" : "Off"}</span>
              </label>
            </div>
          );
        })}
      </div>
      {error ? (
        <p className="cli-runtime-settings-error" role="alert">{error}<button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setError(null)}><X aria-hidden="true" /></button></p>
      ) : null}
      {feedback ? (
        <p className="cli-runtime-settings-feedback" role="status">{feedback}<button type="button" className="notice-close" aria-label="Dismiss message" onClick={() => setFeedback(null)}><X aria-hidden="true" /></button></p>
      ) : null}
      {dialog ? (
        <DisableRuntimeDialog
          dialog={dialog}
          pending={pendingRuntimeId === dialog.preview.runtimeId}
          onCancel={closeDialog}
          onConfirm={() => void confirmDisable()}
          onDismissNotice={() => setDialog((current) => current ? { ...current, notice: null } : current)}
          onDismissError={() => setDialog((current) => current ? { ...current, error: null } : current)}
        />
      ) : null}
    </section>
  );
}
