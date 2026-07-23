import {
  cliRuntimeDisablePreviewSchema,
  cliToggleRuntimeIds,
  type AgentRuntime,
  type CliRuntimeDisablePreview,
  type CliRuntimeSettingsResponse,
  type CliToggleRuntimeId,
  type UpdateCliRuntimeSettingInput,
  type UpdateCliRuntimeSettingResult
} from "@space/contracts";
import { AlertTriangle, Loader2, RefreshCw, Terminal } from "lucide-react";
import { createPortal } from "react-dom";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { api, SpaceApiError } from "../../api.js";
import { CLI_RUNTIME_PRESENTATIONS, cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import {
  CLI_RUNTIME_VISIBILITY_EVENT,
  dispatchCliRuntimeVisibilityChange,
  readCliRuntimeVisibilityChange
} from "../../cli-runtime-visibility-events.js";

export interface CliRuntimeSettingsClient {
  cliRuntimeSettings: () => Promise<CliRuntimeSettingsResponse>;
  cliRuntimeDisablePreview: (runtimeId: string) => Promise<CliRuntimeDisablePreview>;
  updateCliRuntimeSetting: (
    runtimeId: string,
    input: UpdateCliRuntimeSettingInput
  ) => Promise<UpdateCliRuntimeSettingResult>;
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
  onConfirm
}: {
  dialog: DisableDialogState;
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

  const sessions = dialog.preview.activeSessionCount;
  const panes = dialog.preview.openPaneCount;
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
            <small>This runtime disappears globally until an administrator enables it again.</small>
          </span>
        </div>
        <p id="cli-runtime-disable-impact" className="cli-runtime-disable-impact">
          <strong>{sessions}</strong> active {sessions === 1 ? "session" : "sessions"} will stop and <strong>{panes}</strong> open {panes === 1 ? "pane" : "panes"} will close.
        </p>
        <p className="cli-runtime-disable-note">
          Saved task history and transcripts stay intact. Enabling the runtime later will not reopen these sessions or panes.
        </p>
        {dialog.notice ? <p className="cli-runtime-disable-stale" role="status">{dialog.notice}</p> : null}
        {dialog.error ? <p className="cli-runtime-disable-error" role="alert">{dialog.error}</p> : null}
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
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DisableDialogState | null>(null);
  const toggleRefs = useRef(new Map<CliToggleRuntimeId, HTMLInputElement>());
  const mountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);

  const loadSettings = useCallback(async () => {
    const requestId = ++loadRequestIdRef.current;
    if (!canManage) return;
    setLoading(true);
    setError(null);
    try {
      const next = await client.cliRuntimeSettings();
      if (mountedRef.current && requestId === loadRequestIdRef.current) setResponse(next);
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

  const settingById = useMemo(
    () => new Map(response?.settings.map((setting) => [setting.runtimeId, setting]) ?? []),
    [response]
  );
  const runtimeById = useMemo(
    () => new Map(response?.runtimes.map((runtime) => [runtime.id, runtime]) ?? []),
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
    setFeedback(unresolvedSessions || unresolvedPanes
      ? `${cliRuntimePresentation(runtimeId)?.displayName ?? runtimeId} is disabled, but ${unresolvedSessions} sessions and ${unresolvedPanes} panes remain unresolved.`
      : `${cliRuntimePresentation(runtimeId)?.displayName ?? runtimeId} is now ${result.setting.enabled ? "enabled" : "disabled"}.`);
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

  if (!canManage) return null;

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

      {!response && loading ? <p className="cli-runtime-settings-state" role="status"><Loader2 className="spin" aria-hidden="true" />Loading CLI runtime settings…</p> : null}
      <div className="cli-runtime-settings-list">
        {CLI_RUNTIME_PRESENTATIONS.map((presentation) => {
          const runtimeId = presentation.id as CliToggleRuntimeId;
          const setting = settingById.get(runtimeId);
          const enabled = setting?.enabled ?? true;
          const status = runtimeStatus(runtimeById.get(runtimeId));
          return (
            <div className={`cli-runtime-settings-row${enabled ? "" : " is-disabled"}`} key={runtimeId} data-runtime-id={runtimeId}>
              <img src={presentation.iconSrc} alt="" aria-hidden="true" data-terminal-runtime-brand={presentation.brand} draggable={false} />
              <div className="cli-runtime-settings-copy">
                <strong>{presentation.displayName}</strong>
                <div className="cli-runtime-settings-badges" aria-label={`${presentation.displayName} status`}>
                  <span>{status.installation}</span>
                  <span>{status.authentication}</span>
                  <span>{enabled ? "Visible" : "Hidden"}</span>
                </div>
                <small>{status.reason}</small>
              </div>
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
      {error ? <p className="cli-runtime-settings-error" role="alert">{error}</p> : null}
      {feedback ? <p className="cli-runtime-settings-feedback" role="status">{feedback}</p> : null}
      {dialog ? (
        <DisableRuntimeDialog
          dialog={dialog}
          pending={pendingRuntimeId === dialog.preview.runtimeId}
          onCancel={closeDialog}
          onConfirm={() => void confirmDisable()}
        />
      ) : null}
    </section>
  );
}
