import {
  cliRuntimeDisablePreviewSchema,
  type CliAccountProfileDetailsResponse,
  type CliAccountIdentitiesResponse,
  type CliRuntimeDisablePreview,
  type CliRuntimeRestartSessionsResult,
  type CliRuntimeSettingsResponse,
  type CliToggleRuntimeId,
  type HarnessMaintenanceRestartResult,
  type UpdateHarnessEnabledInput,
  type UpdateHarnessEnabledResult,
  type UpdateHarnessVpnResult,
  type CliVpnConnection,
  type CliEgressRouteId,
  type CliVpnProfileId,
  type CreateCliAccountProfileInput,
  type CreateCliAccountProfileResponse,
  type ListCliAccountProfilesResponse,
  type RemoveCliAccountProfileResponse,
  type UpdateCliAccountProfileInput,
  type UpdateCliAccountProfileResponse,
  type UpdateCliGlobalEgressResult,
  type RestartCliRuntimeVpnSessionsResult,
  type UpdateCliRuntimeSettingInput,
  type UpdateCliRuntimeSettingResult,
  type UpdateCliRuntimeVpnInput,
  type UpdateCliRuntimeVpnResult
} from "@space/contracts";
import { AlertTriangle, Loader2, Recycle, RefreshCw, Shield, Terminal, Trash2, Upload, Users } from "../ui-theme/app-icons.js";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, SpaceApiError } from "../../api.js";
import { SettingsActionMenu, type SettingsActionMenuItem } from "../settings/SettingsActionMenu.js";
import { SettingsDisclosure } from "../settings/SettingsDisclosure.js";
import { useAutoDismiss, DEFAULT_NOTICE_DISMISS_MS } from "../../use-auto-dismiss.js";
import { CLI_MAINTENANCE_PRESENTATIONS, cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  dispatchCliRuntimeVisibilityChange,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";
import { publishCliVpnRoutingStatus } from "../../cli-vpn-routing.js";
import { CliAccountsPanel } from "../cli-accounts/CliAccountsPanel.js";
import { getSpaceRuntime } from "../../runtime/SpaceRuntime.js";
import { readStoredSuppressNotifications } from "../../notifications-settings.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { DockNotice, DockState } from "../dock-kit/DockKit.js";
import "./cli-runtime-settings.css";

const VPN_PROFILE_MANAGER_STORAGE_KEY = "space.cliVpnProfileManager.profileId";
const VPN_PROFILE_IDS = ["greece", "thailand", "mullvad", "nord"] as const;

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
  cliRuntimeSettings: (options?: { forceRefresh?: boolean }) => Promise<CliRuntimeSettingsResponse>;
  cliRuntimeSettingsSnapshot?: () => CliRuntimeSettingsResponse | null;
  cliRuntimeDisablePreview: (runtimeId: string) => Promise<CliRuntimeDisablePreview>;
  cliRuntimeRestart?: (runtimeId: string) => Promise<CliRuntimeRestartSessionsResult>;
  restartHarness?: () => Promise<HarnessMaintenanceRestartResult>;
  updateHarnessEnabled?: (input: UpdateHarnessEnabledInput) => Promise<UpdateHarnessEnabledResult>;
  updateCliRuntimeSetting: (
    runtimeId: string,
    input: UpdateCliRuntimeSettingInput
  ) => Promise<UpdateCliRuntimeSettingResult>;
  updateCliGlobalEgress?: (routeId: CliEgressRouteId) => Promise<UpdateCliGlobalEgressResult>;
  replaceCliEgressProfile?: (profileId: CliVpnProfileId, config: string) => Promise<CliVpnConnection>;
  verifyCliEgressProfile?: (profileId: CliVpnProfileId) => Promise<CliVpnConnection>;
  removeCliEgressProfile?: (profileId: CliVpnProfileId) => Promise<CliVpnConnection>;
  rotateCliMullvadCity?: () => Promise<CliVpnConnection>;
  rotateCliNordCity?: () => Promise<CliVpnConnection>;
  replaceCliVpnProfile?: (config: string) => Promise<CliVpnConnection>;
  verifyCliVpnProfile?: () => Promise<CliVpnConnection>;
  removeCliVpnProfile?: () => Promise<CliVpnConnection>;
  updateCliRuntimeVpn?: (runtimeId: string, input: UpdateCliRuntimeVpnInput) => Promise<UpdateCliRuntimeVpnResult>;
  updateHarnessVpn?: (input: UpdateCliRuntimeVpnInput) => Promise<UpdateHarnessVpnResult>;
  restartCliRuntimeVpnSessions?: (runtimeId: string) => Promise<RestartCliRuntimeVpnSessionsResult>;
  listCliAccountProfiles?: (runtimeId: string) => Promise<ListCliAccountProfilesResponse>;
  createCliAccountProfile?: (input: CreateCliAccountProfileInput) => Promise<CreateCliAccountProfileResponse>;
  updateCliAccountProfile?: (runtimeId: string, profileId: string, input: UpdateCliAccountProfileInput) => Promise<UpdateCliAccountProfileResponse>;
  getCliAccountProfileDetails?: (runtimeId: string, profileId: string) => Promise<CliAccountProfileDetailsResponse>;
  cliAccountIdentities?: (refresh?: boolean) => Promise<CliAccountIdentitiesResponse>;
  removeCliAccountProfile?: (runtimeId: string, profileId: string) => Promise<RemoveCliAccountProfileResponse>;
  invalidateCliRuntimes: (change?: { runtimeId?: string; enabled?: boolean }) => void;
  invalidateCliRuntimeSettings?: () => void;
}

interface DisableDialogState {
  preview: CliRuntimeDisablePreview;
  runtimeName: string;
  notice: string | null;
  error: string | null;
}

interface RestartDialogState {
  runtimeId: MaintenanceRuntimeId;
  runtimeName: string;
}

type MaintenanceRuntimeId = CliToggleRuntimeId | "cli:harness";

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim() ? error.message : fallback;
}

function withSelectedVpnConnection(
  response: CliRuntimeSettingsResponse,
  connection: CliVpnConnection
): CliRuntimeSettingsResponse {
  const selectedRoute = response.egress?.selectedRoute;
  return {
    ...response,
    vpnConnection: connection,
    egress: response.egress && selectedRoute && selectedRoute !== "direct"
      ? {
          ...response.egress,
          profiles: {
            ...response.egress.profiles,
            [selectedRoute]: connection
          }
        }
      : response.egress
  };
}

function applyRuntimeVpnResult(
  response: CliRuntimeSettingsResponse,
  runtimeId: CliToggleRuntimeId,
  result: UpdateCliRuntimeVpnResult
): CliRuntimeSettingsResponse {
  const updated = withSelectedVpnConnection(response, result.connection);
  return {
    ...updated,
    settings: updated.settings.map((setting) => setting.runtimeId === runtimeId ? result.setting : setting),
    vpnApplications: updated.vpnApplications.map((application) => application.runtimeId === runtimeId
      ? { runtimeId, ...result.application }
      : application),
    egress: updated.egress
      ? {
          ...updated.egress,
          applications: updated.egress.applications.map((application) => application.runtimeId === runtimeId
            ? {
                runtimeId,
                routeId: result.setting.vpnEnabled ? updated.egress!.selectedRoute : "direct",
                appliedSessionIds: result.application.appliedSessionIds,
                restartRequiredSessionIds: result.application.restartRequiredSessionIds
              }
            : application)
        }
      : updated.egress,
    checkedAt: result.setting.updatedAt
  };
}

const cliEgressRoutes: ReadonlyArray<{ id: CliEgressRouteId; label: string }> = [
  { id: "direct", label: "Direct · Germany" },
  { id: "greece", label: "VPN · Greece" },
  { id: "thailand", label: "VPN · Thailand" },
  { id: "mullvad", label: "VPN · Mullvad" },
  { id: "nord", label: "VPN · NordVPN" }
];

function cliEgressRouteLabel(routeId: CliEgressRouteId): string {
  return cliEgressRoutes.find((route) => route.id === routeId)?.label ?? routeId;
}

/** Readable connection states instead of raw codes such as NOT_CONFIGURED. */
function cliVpnStatusLabel(status: string): string {
  switch (status) {
    case "DIRECT": return "Direct";
    case "CONNECTED": return "Connected";
    case "NOT_CONFIGURED": return "Not set up";
    case "ERROR": return "Error";
    case "BLOCKED": return "Blocked";
    default: return status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, " ");
  }
}

function cliVpnProfileLabel(profileId: CliVpnProfileId): string {
  return profileId === "greece" ? "Greece WireGuard" : profileId === "thailand" ? "Thailand WireGuard" : profileId === "mullvad" ? "Mullvad WireGuard" : "NordVPN WireGuard";
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
  // Closing open work needs its own confirmation, renewed whenever the reviewed impact changes.
  const [acknowledgedToken, setAcknowledgedToken] = useState<string | null>(null);

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
    const buttons = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
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
  const closingPanes = panes + dialog.preview.openChatPaneCount;
  const stoppingWork = sessions + dialog.preview.activeChatRunCount + dialog.preview.activeRoomAgentMissionCount;
  const requiresAcknowledgement = closingPanes + stoppingWork > 0;
  const acknowledged = !requiresAcknowledgement || acknowledgedToken === dialog.preview.confirmationToken;
  return createPortal(
    <div className="cli-runtime-disable-backdrop" onClick={() => { if (!pending) onCancel(); }}>
      <div
        ref={bodyRef}
        className="cli-runtime-disable-dialog dock-kit-scope"
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
          Saved task history and transcripts stay intact. Enabling {dialog.runtimeName} again reopens the CLI panes closed here and resumes their tasks.
        </p>
        {requiresAcknowledgement ? (
          <SpaceToggle
            compact
            checked={acknowledged}
            disabled={pending}
            onChange={(checked) => setAcknowledgedToken(checked ? dialog.preview.confirmationToken : null)}
            label={closingPanes > 0
              ? `Close ${closingPanes} open ${closingPanes === 1 ? "pane" : "panes"} and stop their work`
              : `Stop ${stoppingWork} active ${stoppingWork === 1 ? "task" : "tasks"}`}
          />
        ) : null}
        {dialog.notice ? <DockNotice tone="warning" className="cli-runtime-notice" onDismiss={onDismissNotice}>{dialog.notice}</DockNotice> : null}
        {dialog.error ? <DockNotice className="cli-runtime-notice" onDismiss={onDismissError}>{dialog.error}</DockNotice> : null}
        <div className="cli-runtime-disable-actions">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending}>Cancel</button>
          <button className="is-danger" type="button" onClick={onConfirm} disabled={pending || !acknowledged}>
            {pending ? <Loader2 className="spin" aria-hidden="true" /> : null}
            Disable {dialog.runtimeName}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function RestartRuntimeDialog({
  dialog,
  pending,
  onCancel,
  onConfirm
}: {
  dialog: RestartDialogState;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
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

  return createPortal(
    <div className="cli-runtime-disable-backdrop" onClick={() => { if (!pending) onCancel(); }}>
      <div
        ref={bodyRef}
        className="cli-runtime-disable-dialog dock-kit-scope"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cli-runtime-restart-title"
        aria-describedby="cli-runtime-restart-impact"
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="cli-runtime-disable-heading">
          <AlertTriangle aria-hidden="true" />
          <span>
            <strong id="cli-runtime-restart-title">Restart {dialog.runtimeName}?</strong>
            <small>Other CLI runtimes are not affected.</small>
          </span>
        </div>
        <p id="cli-runtime-restart-impact" className="cli-runtime-disable-impact">
          All active {dialog.runtimeName} sessions will stop and start again.
        </p>
        <div className="cli-runtime-disable-actions">
          <button ref={cancelRef} type="button" onClick={onCancel} disabled={pending}>Cancel</button>
          <button className="is-danger" type="button" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="spin" aria-hidden="true" /> : <RefreshCw aria-hidden="true" />}
            {pending ? "Restarting…" : `Restart ${dialog.runtimeName}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

export function CliRuntimeSettingsCard({
  canManage,
  client = api,
  onOpenRestartAll,
  restartAllPending = false,
  disclosures = false
}: {
  canManage: boolean;
  client?: CliRuntimeSettingsClient;
  onOpenRestartAll?: () => void;
  restartAllPending?: boolean;
  disclosures?: boolean;
}) {
  const [response, setResponse] = useState<CliRuntimeSettingsResponse | null>(
    () => client.cliRuntimeSettingsSnapshot?.() ?? null
  );
  const [loading, setLoading] = useState(false);
  const [pendingRuntimeId, setPendingRuntimeId] = useState<CliToggleRuntimeId | null>(null);
  const [pendingRestartRuntimeId, setPendingRestartRuntimeId] = useState<MaintenanceRuntimeId | null>(null);
  const [harnessEnabledPending, setHarnessEnabledPending] = useState(false);
  const [pendingVpnRuntimeId, setPendingVpnRuntimeId] = useState<MaintenanceRuntimeId | null>(null);
  const [pendingEgressRoute, setPendingEgressRoute] = useState<CliEgressRouteId | null>(null);
  const [vpnProfilePending, setVpnProfilePending] = useState(false);
  const [vpnProfileId, setVpnProfileId] = useState<CliVpnProfileId>(readManagedVpnProfileId);
  const [removeConfirmationProfileId, setRemoveConfirmationProfileId] = useState<CliVpnProfileId | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A failed first load has nothing to show behind it, so it stays until Try again (not auto-dismissed).
  const [loadError, setLoadError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [feedbackSensitive, setFeedbackSensitive] = useState(false);
  const [dialog, setDialog] = useState<DisableDialogState | null>(null);
  const [restartDialog, setRestartDialog] = useState<RestartDialogState | null>(null);
  const rowRefs = useRef(new Map<MaintenanceRuntimeId, HTMLDivElement>());
  const responseRef = useRef(response);
  responseRef.current = response;
  const restartRefs = useRef(new Map<MaintenanceRuntimeId, HTMLButtonElement>());
  const vpnProfileFileInputRef = useRef<HTMLInputElement | null>(null);
  const mountedRef = useRef(true);

  useAutoDismiss(error, setError);
  useAutoDismiss(feedback, setFeedback);

  useEffect(() => {
    if (!feedback) setFeedbackSensitive(false);
  }, [feedback]);

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

  const loadSettings = useCallback(async (options: { forceRefresh?: boolean } = {}) => {
    const requestId = ++loadRequestIdRef.current;
    if (!canManage) return;
    setLoading(true);
    setError(null);
    try {
      const next = await client.cliRuntimeSettings(options);
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        setResponse(next);
        setLoadError(null);
        publishCliVpnRoutingStatus();
      }
    } catch (cause) {
      if (mountedRef.current && requestId === loadRequestIdRef.current) {
        const message = errorMessage(cause, "CLI runtime settings could not be loaded.");
        if (responseRef.current) setError(message);
        else setLoadError(message);
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
      client.invalidateCliRuntimeSettings?.();
      void loadSettings();
    };
    window.addEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
    return () => window.removeEventListener(CLI_RUNTIME_VISIBILITY_EVENT, handleVisibilityChange);
  }, [canManage, client, loadSettings]);

  useEffect(() => {
    const removed = response?.egress?.removedProfiles ?? [];
    if (!removed.includes(vpnProfileId)) return;
    const fallback = (["greece", "thailand", "mullvad", "nord"] as const).find((profileId) => !removed.includes(profileId)) ?? "greece";
    setVpnProfileId(fallback);
    writeManagedVpnProfileId(fallback);
    setRemoveConfirmationProfileId(null);
  }, [response, vpnProfileId]);

  const settingById = useMemo(
    () => new Map(response?.settings.map((setting) => [setting.runtimeId, setting]) ?? []),
    [response]
  );
  function restoreToggleFocus(runtimeId: CliToggleRuntimeId) {
    window.requestAnimationFrame(() => rowRefs.current.get(runtimeId)
      ?.querySelector<HTMLInputElement>('input[role="switch"][name^="cli-runtime-enabled-"]')?.focus());
  }

  function restoreRestartFocus(runtimeId: MaintenanceRuntimeId) {
    window.requestAnimationFrame(() => restartRefs.current.get(runtimeId)?.focus());
  }

  function closeRestartDialog() {
    if (!restartDialog || pendingRestartRuntimeId) return;
    const runtimeId = restartDialog.runtimeId;
    setRestartDialog(null);
    restoreRestartFocus(runtimeId);
  }

  async function restartRuntime(runtimeId: MaintenanceRuntimeId, runtimeName: string) {
    if (pendingRestartRuntimeId) return;
    setPendingRestartRuntimeId(runtimeId);
    setError(null);
    setFeedback(null);
    try {
      const result = runtimeId === "cli:harness"
        ? client.restartHarness
          ? await client.restartHarness()
          : (() => { throw new Error("Harness restart controls are unavailable."); })()
        : client.cliRuntimeRestart
          ? await client.cliRuntimeRestart(runtimeId)
          : (() => { throw new Error("Per-CLI restart controls are unavailable."); })();
      client.invalidateCliRuntimeSettings?.();
      if (runtimeId === "cli:harness") {
        setFeedback("DeepSeek Harness restarted.");
      } else if ("restartedSessionIds" in result) {
        const restarted = result.restartedSessionIds.length;
        const failed = result.failedSessionIds.length;
        setFeedback(failed > 0
          ? `${runtimeName}: ${restarted} restarted, ${failed} failed.`
          : `${runtimeName}: ${restarted} session${restarted === 1 ? "" : "s"} restarted.`);
      }
      void loadSettings({ forceRefresh: true });
    } catch (restartError) {
      setError(errorMessage(restartError, "CLI runtime restart failed."));
    } finally {
      setPendingRestartRuntimeId(null);
      setRestartDialog(null);
      restoreRestartFocus(runtimeId);
    }
  }

  async function confirmRuntimeRestart() {
    if (!restartDialog || pendingRestartRuntimeId) return;
    await restartRuntime(restartDialog.runtimeId, restartDialog.runtimeName);
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
    client.invalidateCliRuntimes({ runtimeId, enabled: result.setting.enabled });
    client.invalidateCliRuntimeSettings?.();
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
    if (!readStoredSuppressNotifications()) {
      setFeedback(hasUnresolvedCleanup && runtimeId === "cli:codex"
        ? `${displayName} is disabled, but cleanup remains unresolved: ${unresolvedSessions} CLI sessions, ${unresolvedPanes} panes, ${unresolvedChatRuns} Chat runs/panes, and ${unresolvedRoomAgentMissions} Room Agent missions.`
        : hasUnresolvedCleanup
          ? `${displayName} is disabled, but ${unresolvedSessions} sessions and ${unresolvedPanes} panes remain unresolved.`
          : result.restoredPaneIds?.length
            ? `${displayName} is now enabled. Reopening ${result.restoredPaneIds.length} ${result.restoredPaneIds.length === 1 ? "pane" : "panes"} it closed.`
            : `${displayName} is now ${result.setting.enabled ? "enabled" : "disabled"}.`);
    }
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

  async function updateHarnessEnabled(enabled: boolean) {
    if (harnessEnabledPending) return;
    setHarnessEnabledPending(true);
    setError(null);
    setFeedback(null);
    try {
      if (!client.updateHarnessEnabled) throw new Error("Harness service controls are unavailable.");
      const result = await client.updateHarnessEnabled({ enabled });
      setResponse((current) => current ? { ...current, harness: result.status } : current);
      client.invalidateCliRuntimes({ enabled: result.status.enabled });
      client.invalidateCliRuntimeSettings?.();
      dispatchCliRuntimeVisibilityChange({ enabled: result.status.enabled, source: "settings-card" });
      publishCliVpnRoutingStatus();
      if (!readStoredSuppressNotifications()) {
        setFeedback(`DeepSeek Harness is now ${result.status.enabled ? "active" : "inactive"}.`);
      }
    } catch (updateError) {
      setError(errorMessage(updateError, "Harness service state could not be changed."));
    } finally {
      setHarnessEnabledPending(false);
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
    if (!file) return;
    if (file.size < 64 || file.size > 65_536) {
      setError("WireGuard configuration must be between 64 bytes and 64 KiB.");
      return;
    }
    try {
      const config = await file.text();
      if (!client.replaceCliEgressProfile) throw new Error("Global CLI egress profile controls are unavailable.");
      setVpnProfilePending(true);
      await client.replaceCliEgressProfile(profileId, config);
      await loadSettings();
      setFeedback(`${cliVpnProfileLabel(profileId)} profile imported and verified.`);
    } catch (profileError) {
      setError(errorMessage(profileError, "WireGuard profile could not be read, saved and verified."));
    } finally {
      setVpnProfilePending(false);
    }
  }

  function selectVpnProfileManager(profileId: CliVpnProfileId) {
    if (vpnControlsPending || profileId === vpnProfileId) return;
    setVpnProfileId(profileId);
    writeManagedVpnProfileId(profileId);
    setRemoveConfirmationProfileId(null);
    setError(null);
    setFeedback(null);
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
      setRemoveConfirmationProfileId(null);
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
      setFeedbackSensitive(Boolean(connection.relay));
    } catch (rotateError) {
      setError(errorMessage(rotateError, "Mullvad city could not be changed."));
    } finally {
      setVpnProfilePending(false);
    }
  }

  async function rotateNordCity() {
    if (vpnProfilePending) return;
    setVpnProfilePending(true);
    setError(null);
    setFeedback(null);
    try {
      if (!client.rotateCliNordCity) throw new Error("NordVPN city controls are unavailable.");
      const connection = await client.rotateCliNordCity();
      await loadSettings();
      publishCliVpnRoutingStatus();
      setFeedback(connection.relay
        ? `NordVPN changed to ${connection.relay.cityName}, ${connection.relay.countryName} (${connection.egressIpv4 ?? "public IP verifying"}).`
        : "NordVPN city changed and the new egress was verified.");
      setFeedbackSensitive(Boolean(connection.relay));
    } catch (rotateError) {
      setError(errorMessage(rotateError, "NordVPN city could not be changed."));
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

  async function updateRuntimeVpn(runtimeId: MaintenanceRuntimeId, enabled: boolean) {
    if (pendingVpnRuntimeId) return;
    setPendingVpnRuntimeId(runtimeId);
    setError(null);
    setFeedback(null);
    try {
      if (runtimeId === "cli:harness") {
        if (!client.updateHarnessVpn) throw new Error("Harness VPN controls are unavailable.");
        const result = await client.updateHarnessVpn({ enabled });
        setResponse((current) => current
          ? {
              ...withSelectedVpnConnection(current, result.connection),
              harness: result.status
            }
          : current);
      } else {
        if (!client.updateCliRuntimeVpn) throw new Error("Per-CLI VPN controls are unavailable.");
        const result = await client.updateCliRuntimeVpn(runtimeId, { enabled });
        setResponse((current) => current ? applyRuntimeVpnResult(current, runtimeId, result) : current);
      }
      publishCliVpnRoutingStatus();
      const displayName = cliRuntimePresentation(runtimeId)?.displayName ?? runtimeId;
      setFeedback(enabled
        ? `${displayName} now uses ${cliEgressRouteLabel(selectedRoute)}. Active sessions were restarted when needed.`
        : `${displayName} now uses Direct network access. Active sessions were restarted when needed.`);
      void loadSettings({ forceRefresh: true });
    } catch (vpnError) {
      setError(errorMessage(vpnError, "CLI VPN route could not be changed."));
    } finally {
      setPendingVpnRuntimeId(null);
    }
  }

  if (!canManage) return null;
  const selectedRoute = response?.egress?.selectedRoute ?? "direct";
  const removedProfiles = response?.egress?.removedProfiles ?? [];
  const availableProfileIds = (["greece", "thailand", "mullvad", "nord"] as const).filter((profileId) => !removedProfiles.includes(profileId));
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
  const runtimeActionsPending = Boolean(
    pendingRuntimeId
    || pendingRestartRuntimeId
    || pendingVpnRuntimeId
    || pendingEgressRoute
    || vpnProfilePending
    || harnessEnabledPending
  );
  const runtimeMenuActions: SettingsActionMenuItem[] = [{
    id: "refresh",
    label: "Refresh CLI runtimes",
    icon: RefreshCw,
    onSelect: () => void loadSettings({ forceRefresh: true })
  }];
  if (onOpenRestartAll) {
    runtimeMenuActions.push({
      id: "restart-all",
      label: "Restart all CLI runtimes",
      icon: Recycle,
      onSelect: onOpenRestartAll
    });
  }
  const profileMenuActions: SettingsActionMenuItem[] = [
    {
      id: "verify",
      label: "Verify profile",
      icon: RefreshCw,
      disabled: !managedProfile?.profileConfigured,
      onSelect: () => void verifyVpnProfile(vpnProfileId)
    },
    ...(vpnProfileId === "mullvad" ? [{
      id: "change-city",
      label: "Change Mullvad city",
      icon: RefreshCw,
      disabled: !managedProfile?.profileConfigured,
      onSelect: () => void rotateMullvadCity()
    }] : []),
    ...(vpnProfileId === "nord" ? [{
      id: "change-city",
      label: "Change NordVPN city",
      icon: RefreshCw,
      disabled: !managedProfile?.profileConfigured,
      onSelect: () => void rotateNordCity()
    }] : []),
    {
      id: "replace-profile",
      label: managedProfile?.profileConfigured ? "Replace WireGuard profile" : "Import WireGuard profile",
      icon: Upload,
      onSelect: () => vpnProfileFileInputRef.current?.click()
    },
    {
      id: "remove-profile",
      label: "Remove profile",
      icon: Trash2,
      danger: true,
      disabled: !managedProfile?.profileConfigured || managedProfileIsActive,
      onSelect: () => setRemoveConfirmationProfileId(vpnProfileId)
    }
  ];

  const vpnProfileContent = (
    <div hidden={!response} className={`cli-vpn-profile settings-flat-vpn${selectedRouteStatus === "DIRECT" || selectedRouteStatus === "CONNECTED" ? " is-connected" : ""}`} aria-label="Global CLI network route">
      <div className="cli-vpn-profile-heading">
        <Shield aria-hidden="true" />
        <span>
          <strong>CLI VPN route</strong>
          <small>Choose one route, then turn VPN on for each CLI that should use it.</small>
        </span>
        <span className={`cli-vpn-health is-${selectedRouteStatus === "DIRECT" ? "connected" : selectedRouteStatus.toLowerCase()}`}>
          {cliVpnStatusLabel(selectedRouteStatus)}
        </span>
      </div>
      {response?.vpnSupported ? (
        <>
          <dl className="cli-vpn-profile-details settings-flat-metrics">
            <div><dt>Route</dt><dd>{cliEgressRouteLabel(selectedRoute)}</dd></div>
            {selectedEgressIp ? <div><dt>IPv4</dt><dd data-sensitive-masked="manual">{selectedEgressIp}</dd></div> : null}
            <div><dt>Leak guard</dt><dd>Protected</dd></div>
          </dl>
          <label className="settings-flat-row cli-egress-route-select">
            <span className="settings-flat-row-copy">
              <strong>Route</strong>
              <small>{pendingEgressRoute ? `Applying ${cliEgressRouteLabel(pendingEgressRoute)}…` : "Used by every CLI whose VPN switch is on."}</small>
            </span>
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
          </label>
          <div className="cli-egress-profile-manager" aria-label="VPN profile manager">
            {availableProfileIds.length === 0 ? (
              <small className="cli-egress-profile-helper">All VPN profiles were removed. No profile can be configured.</small>
            ) : (
              <>
                <label className="settings-flat-row cli-egress-route-select">
                  <span className="settings-flat-row-copy">
                    <strong>Profile</strong>
                    <small>Select the WireGuard profile to inspect or manage.</small>
                  </span>
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
                </label>
                <div className={`cli-egress-profile${managedProfile?.status === "CONNECTED" ? " is-connected" : ""}`}>
                  <div className="cli-egress-profile-title">
                    <span className="settings-flat-row-copy">
                      <strong>{managedProfileLabel}</strong>
                      <small>WireGuard settings stored on the server.</small>
                    </span>
                    <div className="settings-flat-heading-actions">
                      <span data-sensitive-masked={vpnProfileId === "mullvad" || vpnProfileId === "nord" ? "manual" : undefined}>{cliVpnStatusLabel(managedProfile?.status ?? "NOT_CONFIGURED")}</span>
                      <SettingsActionMenu
                        label={`${managedProfileLabel} actions`}
                        actions={profileMenuActions}
                        disabled={vpnControlsPending}
                      />
                    </div>
                  </div>
                  <input
                    ref={vpnProfileFileInputRef}
                    type="file"
                    hidden
                    name={`cli-vpn-profile-${vpnProfileId}`}
                    accept=".conf,text/plain"
                    aria-label={`Choose ${managedProfileLabel} configuration`}
                    disabled={vpnControlsPending}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0] ?? null;
                      event.currentTarget.value = "";
                      void selectVpnProfile(vpnProfileId, file);
                    }}
                  />
                  <div data-sensitive-masked={vpnProfileId === "mullvad" || vpnProfileId === "nord" ? "block" : undefined}>
                    <dl className="cli-vpn-profile-details settings-flat-metrics">
                      <div><dt>Public IPv4</dt><dd data-sensitive-masked="manual">{managedProfile?.egressIpv4 ?? "Not verified"}</dd></div>
                      {(vpnProfileId === "mullvad" || vpnProfileId === "nord") && managedProfile?.relay ? (
                        <>
                          <div><dt>City</dt><dd>{managedProfile.relay.cityName}</dd></div>
                          <div><dt>Country</dt><dd>{managedProfile.relay.countryName}</dd></div>
                          <div><dt>Relay</dt><dd>{managedProfile.relay.hostname}</dd></div>
                        </>
                      ) : null}
                    </dl>
                  </div>
                  {managedProfileIsActive ? <small className="cli-egress-profile-helper">Select Direct before removing the currently active profile.</small> : null}
                  {removeConfirmationProfileId === vpnProfileId ? (
                    <div className="cli-vpn-remove-confirmation" role="alertdialog" aria-label={`Confirm ${managedProfileLabel} removal`}>
                      <p>Remove this stored WireGuard profile?</p>
                      <div>
                        <button type="button" disabled={vpnProfilePending} onClick={() => setRemoveConfirmationProfileId(null)}>Cancel</button>
                        <button type="button" className="is-danger" disabled={vpnProfilePending} onClick={() => void removeVpnProfile(vpnProfileId)}>Remove</button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </>
      ) : (
        <small className="cli-vpn-profile-note">CLI VPN support is disabled on this Space installation.</small>
      )}
    </div>
  );

  const accountProfilesContent = <CliAccountsPanel canManage={canManage} client={client} />;

  const runtimeListContent = (
    <div hidden={!response} className="cli-runtime-settings-list">
      <div className="cli-runtime-settings-columns" aria-hidden="true">
        <span>CLI Runtime</span>
        <div className="cli-runtime-settings-columns-actions">
          <span>Restart</span>
          <span>VPN</span>
          <span>Active</span>
        </div>
      </div>
      {CLI_MAINTENANCE_PRESENTATIONS.map((presentation) => {
        const runtimeId = presentation.id as MaintenanceRuntimeId;
        const isHarness = runtimeId === "cli:harness";
        const setting = isHarness ? response?.harness : settingById.get(runtimeId);
        const enabled = setting?.enabled ?? true;
        const vpnEnabled = setting?.vpnEnabled ?? false;
        return (
          <div
            ref={(element) => {
              if (element) rowRefs.current.set(runtimeId, element);
              else rowRefs.current.delete(runtimeId);
            }}
            className={`cli-runtime-settings-row${enabled ? "" : " is-disabled"}`}
            key={runtimeId}
            data-runtime-id={runtimeId}
          >
            <img src={presentation.iconSrc} alt="" aria-hidden="true" data-terminal-runtime-brand={presentation.brand} draggable={false} />
            <div className="cli-runtime-settings-name">
              <strong>{presentation.displayName}</strong>
            </div>
            <div className="cli-runtime-settings-actions">
              <button
                ref={(element) => {
                  if (element) restartRefs.current.set(runtimeId, element);
                  else restartRefs.current.delete(runtimeId);
                }}
                className="cli-runtime-restart-button"
                type="button"
                aria-label={`Restart ${presentation.displayName}`}
                title={`Restart ${presentation.displayName}`}
                disabled={!response || !enabled || runtimeActionsPending || restartAllPending}
                onClick={() => {
                  if (isHarness) {
                    void restartRuntime(runtimeId, presentation.displayName);
                  } else {
                    setRestartDialog({ runtimeId, runtimeName: presentation.displayName });
                  }
                }}
              >
                {pendingRestartRuntimeId === runtimeId ? <Loader2 className="spin" aria-hidden="true" /> : <Recycle aria-hidden="true" />}
              </button>
              <SpaceToggle
                className="cli-runtime-switch cli-runtime-vpn-switch"
                name={`cli-runtime-vpn-${presentation.brand}`}
                ariaLabel={`Use VPN for ${presentation.displayName}`}
                label={pendingVpnRuntimeId === runtimeId ? <Loader2 className="spin" aria-hidden="true" /> : "VPN"}
                title={selectedRoute === "direct" && !vpnEnabled
                  ? "Choose a VPN route before enabling this CLI."
                  : `VPN ${vpnEnabled ? "on" : "off"} for ${presentation.displayName}`}
                checked={vpnEnabled}
                disabled={!response || !enabled || runtimeActionsPending || restartAllPending || (selectedRoute === "direct" && !vpnEnabled)}
                onChange={(checked) => void updateRuntimeVpn(runtimeId, checked)}
              />
              <SpaceToggle
                className="cli-runtime-switch cli-runtime-enabled-switch"
                name={isHarness ? "cli-runtime-enabled-harness" : `cli-runtime-enabled-${presentation.brand}`}
                ariaLabel={`Enable ${presentation.displayName}`}
                label="Active"
                title={isHarness ? `DeepSeek Harness ${enabled ? "active" : "inactive"}` : `${presentation.displayName} ${enabled ? "on" : "off"}`}
                checked={enabled}
                disabled={!response || runtimeActionsPending || restartAllPending}
                onChange={(checked) => void (isHarness ? updateHarnessEnabled(checked) : requestToggle(runtimeId as CliToggleRuntimeId, checked))}
              />
            </div>
          </div>
        );
      })}
    </div>
  );

  const runtimeDialogsContent = (
    <>
      {error ? <DockNotice className="cli-runtime-notice" onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {!readStoredSuppressNotifications() && feedback ? (
        <DockNotice tone="success" className="cli-runtime-notice" onDismiss={() => setFeedback(null)}>
          <span data-sensitive-masked={feedbackSensitive ? "manual" : undefined}>{feedback}</span>
        </DockNotice>
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
      {restartDialog ? (
        <RestartRuntimeDialog
          dialog={restartDialog}
          pending={pendingRestartRuntimeId === restartDialog.runtimeId}
          onCancel={closeRestartDialog}
          onConfirm={() => void confirmRuntimeRestart()}
        />
      ) : null}
    </>
  );

  // Plain computation: hooks must not run after the ADMIN-only early return above.
  const enabledCount = CLI_MAINTENANCE_PRESENTATIONS.filter((presentation) => {
    const runtimeId = presentation.id as MaintenanceRuntimeId;
    const setting = runtimeId === "cli:harness" ? response?.harness : settingById.get(runtimeId);
    return setting?.enabled ?? true;
  }).length;

  const loadState = response ? null : loadError ? (
    <DockState kind="error" title="CLI runtime settings could not be loaded" detail={loadError}
      action={{ label: "Try again", icon: RefreshCw, onClick: () => void loadSettings({ forceRefresh: true }) }} />
  ) : (
    <DockState kind="loading" title="Loading CLI runtime settings…" />
  );

  if (disclosures) {
    return (
      <>
        <SettingsDisclosure
          title="CLI runtimes"
          description="Turn CLIs on or off, restart them and choose which use the VPN."
          scope="Installation"
          icon={Terminal}
        >
          <section className="agent-settings-card settings-flat-card cli-runtime-settings-card" aria-label="CLI runtime visibility settings" aria-busy={loading || !response}>
            <div className="agent-settings-section-title settings-flat-heading cli-runtime-settings-title">
              <Terminal aria-hidden="true" />
              <span>
                <strong>CLI runtimes</strong>
                <small>{!response && loadError ? "Not loaded" : !response || loading ? "Loading CLI runtime settings…" : `${enabledCount} of ${CLI_MAINTENANCE_PRESENTATIONS.length} runtimes active`}</small>
              </span>
              <SettingsActionMenu
                label="CLI runtime actions"
                actions={runtimeMenuActions}
                disabled={!response || loading || runtimeActionsPending || restartAllPending}
              />
            </div>

            {loadState}

            {runtimeListContent}
            {runtimeDialogsContent}
          </section>
        </SettingsDisclosure>

        <SettingsDisclosure
          title="CLI VPN route"
          description="Send CLI traffic through a VPN route of your choice."
          scope="Installation"
          icon={Shield}
        >
          <section className="agent-settings-card settings-flat-card cli-vpn-settings-card" aria-label="CLI VPN route settings">
            {loadState}
            {vpnProfileContent}
          </section>
        </SettingsDisclosure>

        <SettingsDisclosure
          title="CLI accounts"
          description="Manage isolated Gemini, Claude, GitHub Copilot, and Cursor account profiles."
          scope="Installation"
          icon={Users}
        >
          <section className="agent-settings-card settings-flat-card cli-gemini-accounts-card" aria-label="CLI account profile settings">
            {accountProfilesContent}
          </section>
        </SettingsDisclosure>

      </>
    );
  }

  return (
    <section className="agent-settings-card settings-flat-card cli-runtime-settings-card" aria-label="CLI runtime visibility settings" aria-busy={loading || !response}>
      <div className="agent-settings-section-title settings-flat-heading cli-runtime-settings-title">
        <Terminal aria-hidden="true" />
        <span>
          <strong>CLI runtimes</strong>
          <small>Turn CLIs on or off, restart them and choose which use the VPN.</small>
        </span>
        <SettingsActionMenu
          label="CLI runtime actions"
          actions={runtimeMenuActions}
          disabled={!response || loading || runtimeActionsPending || restartAllPending}
        />
      </div>

      {loadState}

      {vpnProfileContent}
      {accountProfilesContent}
      {runtimeListContent}
      {runtimeDialogsContent}
    </section>
  );
}
