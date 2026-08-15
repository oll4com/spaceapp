import { useEffect, useState } from "react";
import type { AppDiagnosticsStatus } from "@space/contracts";
import { Activity, Camera, CircleStop, RefreshCw, ShieldCheck } from "../ui-theme/app-icons.js";
import { api } from "../../api.js";
import {
  APP_DIAGNOSTICS_STATE_EVENT,
  applyAppDiagnosticsStatus,
  getAppDiagnosticsClientState,
  refreshAppDiagnosticsStatus,
  type AppDiagnosticsClientState
} from "../../app-diagnostics/app-diagnostics-bootstrap.js";
import {
  APP_DIAGNOSTICS_RECORDER_STATE_EVENT,
  getAppDiagnosticsRecorderState,
  startAppDiagnosticsVideoRecording,
  stopAppDiagnosticsVideoRecording,
  type AppDiagnosticsRecorderState
} from "../../app-diagnostics/app-diagnostics-video-recorder.js";
import { SettingsActionMenu } from "../settings/SettingsActionMenu.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import "./app-diagnostics-settings.css";

interface AppDiagnosticsSettingsClient {
  updateStatus(isEnabled: boolean): Promise<AppDiagnosticsStatus>;
}

interface AppDiagnosticsSettingsCardProps {
  canManage: boolean;
  state?: AppDiagnosticsClientState;
  recorderState?: AppDiagnosticsRecorderState;
  client?: AppDiagnosticsSettingsClient;
  onStatus?: (status: AppDiagnosticsStatus) => void | Promise<void>;
  onStartRecording?: () => void | Promise<void>;
  onStopRecording?: () => void | Promise<void>;
}

function useDiagnosticsState(override?: AppDiagnosticsClientState): AppDiagnosticsClientState {
  const [state, setState] = useState(() => override ?? getAppDiagnosticsClientState());
  useEffect(() => {
    if (override) {
      setState(override);
      return;
    }
    const update = () => setState(getAppDiagnosticsClientState());
    window.addEventListener(APP_DIAGNOSTICS_STATE_EVENT, update);
    return () => window.removeEventListener(APP_DIAGNOSTICS_STATE_EVENT, update);
  }, [override]);
  return override ?? state;
}

function useRecorderState(override?: AppDiagnosticsRecorderState): AppDiagnosticsRecorderState {
  const [state, setState] = useState(() => override ?? getAppDiagnosticsRecorderState());
  useEffect(() => {
    if (override) {
      setState(override);
      return;
    }
    const update = () => setState(getAppDiagnosticsRecorderState());
    window.addEventListener(APP_DIAGNOSTICS_RECORDER_STATE_EVENT, update);
    return () => window.removeEventListener(APP_DIAGNOSTICS_RECORDER_STATE_EVENT, update);
  }, [override]);
  return override ?? state;
}

function formatBytes(value: number): string {
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} B`;
}

function formatEnabledAt(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "Not active";
}

const defaultClient: AppDiagnosticsSettingsClient = {
  updateStatus: (isEnabled) => api.updateAppDiagnosticsStatus(isEnabled)
};

export function AppDiagnosticsSettingsCard({
  canManage,
  state: stateOverride,
  recorderState: recorderStateOverride,
  client = defaultClient,
  onStatus = applyAppDiagnosticsStatus,
  onStartRecording = startAppDiagnosticsVideoRecording,
  onStopRecording = () => stopAppDiagnosticsVideoRecording("USER")
}: AppDiagnosticsSettingsCardProps) {
  const state = useDiagnosticsState(stateOverride);
  const recorder = useRecorderState(recorderStateOverride);
  const [pending, setPending] = useState(false);
  const [consentOpen, setConsentOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = state.status;
  const isEnabled = status?.isEnabled ?? false;
  const recorderBusy = recorder.status === "REQUESTING" || recorder.status === "STOPPING";
  const recordingElsewhere = status?.recorder.status === "ACTIVE" && recorder.status !== "RECORDING";

  const toggle = async (isEnabledNext: boolean) => {
    if (!canManage || pending) return;
    setPending(true);
    setError(null);
    try {
      const updated = await client.updateStatus(isEnabledNext);
      await onStatus(updated);
      if (!isEnabledNext) setConsentOpen(false);
    } catch (changeError) {
      setError(changeError instanceof Error ? changeError.message : "Diagnostics setting could not be changed.");
    } finally {
      setPending(false);
    }
  };

  const beginRecording = async () => {
    setConsentOpen(false);
    setError(null);
    try {
      await onStartRecording();
    } catch (recordingError) {
      setError(recordingError instanceof Error ? recordingError.message : "Tab recording could not start.");
    }
  };

  return (
    <section
      className={`agent-settings-card settings-flat-card app-diagnostics-card${isEnabled ? " is-enabled" : ""}`}
      aria-label="App diagnostics settings"
      data-diagnostics-surface="SETTINGS"
    >
      <div className="agent-settings-section-title settings-flat-heading app-diagnostics-title">
        <Activity aria-hidden="true" />
        <span>
          <strong>App diagnostics</strong>
          <small>Global rolling technical capture for connected Space clients.</small>
        </span>
        <div className="settings-flat-heading-actions">
          <span className={`status ${isEnabled ? "bad" : "muted"}`}>{isEnabled ? "DEBUG ON" : "OFF"}</span>
          <SettingsActionMenu
            label="App diagnostics actions"
            disabled={pending || recorderBusy}
            actions={[
              {
                id: "refresh",
                label: "Refresh status",
                icon: RefreshCw,
                onSelect: () => void refreshAppDiagnosticsStatus()
              },
              ...(canManage && isEnabled && recorder.status === "RECORDING" && recorder.paused ? [{
                id: "continue-recording",
                label: "Continue tab recording",
                icon: Camera,
                disabled: recorderBusy,
                onSelect: () => void onStartRecording()
              }] : []),
              ...(canManage && isEnabled ? [{
                id: recorder.status === "RECORDING" ? "stop-recording" : "start-recording",
                label: recorder.status === "RECORDING" ? "Stop recording" : "Start tab recording",
                icon: recorder.status === "RECORDING" ? CircleStop : Camera,
                danger: recorder.status === "RECORDING",
                disabled: recordingElsewhere,
                onSelect: () => {
                  if (recorder.status === "RECORDING") void onStopRecording();
                  else setConsentOpen(true);
                }
              }] : [])
            ]}
          />
        </div>
      </div>

      <SpaceToggle
        className="settings-flat-row settings-flat-toggle-row app-diagnostics-toggle"
        name="app-diagnostics-enabled"
        ariaLabel="Enable global app diagnostics"
        label="Debug capture"
        detail={pending ? "Updating global state…" : "Keep a rolling 24-hour technical trace."}
        checked={isEnabled}
        disabled={!canManage || pending || !status}
        onChange={(nextEnabled) => void toggle(nextEnabled)}
      />

      <p className="settings-flat-note">
        8 GiB total · 512 MiB technical reserve · one visual recorder.
      </p>
      <dl className="app-diagnostics-metrics settings-flat-metrics" data-sensitive-ignore>
        <div><dt>Enabled</dt><dd>{formatEnabledAt(status?.enabledAt ?? null)}</dd></div>
        <div><dt>Storage</dt><dd>{formatBytes(status?.usage.totalBytes ?? 0)} / 8 GiB</dd></div>
        <div><dt>Segments</dt><dd>{status?.usage.segmentCount ?? 0}</dd></div>
        <div><dt>Dropped</dt><dd>{(status?.counters.droppedEvents ?? 0) + state.collector.droppedEvents}</dd></div>
        <div><dt>Quota evictions</dt><dd>{status?.counters.quotaDrops ?? 0}</dd></div>
        <div><dt>Recorder</dt><dd>{recordingElsewhere ? "Active in another tab" : recorder.status}</dd></div>
      </dl>

      {!canManage ? (
        <p className="settings-flat-note" role="status">
          Operators can inspect this global state. Only admins can change it or record a tab.
        </p>
      ) : null}

      {consentOpen ? (
        <div className="app-diagnostics-consent" role="dialog" aria-modal="true" aria-label="Confirm diagnostic tab recording">
          <div className="app-diagnostics-consent-heading">
            <ShieldCheck aria-hidden="true" />
            <strong>Share only this Space tab</strong>
          </div>
          <p>
            Diagnostic video can contain anything visible in the selected tab. Space records at
            1280×720, 5 fps, 500 kbps, without audio, and keeps it for at most 24 hours.
          </p>
          <div>
            <button type="button" onClick={() => setConsentOpen(false)}>Cancel</button>
            <button type="button" onClick={() => void beginRecording()}>Share this Space tab</button>
          </div>
        </div>
      ) : null}

      {error || recorder.errorCode || state.lastErrorCode ? (
        <p className="app-diagnostics-error" role="alert">
          {error ?? recorder.errorCode ?? state.lastErrorCode}
        </p>
      ) : null}
    </section>
  );
}

export function AppDiagnosticsGlobalIndicators({
  state: stateOverride,
  recorderState: recorderStateOverride
}: {
  state?: AppDiagnosticsClientState;
  recorderState?: AppDiagnosticsRecorderState;
}) {
  const state = useDiagnosticsState(stateOverride);
  const recorder = useRecorderState(recorderStateOverride);
  const isEnabled = state.status?.isEnabled ?? false;
  const isRecording = recorder.status === "RECORDING" || state.status?.recorder.status === "ACTIVE";
  if (!isEnabled && !isRecording) return null;
  return (
    <div className="app-diagnostics-indicators" role="status" aria-live="polite">
      {isEnabled ? <span className="app-diagnostics-debug-badge">DEBUG ON</span> : null}
      {isRecording ? <span className="app-diagnostics-rec-badge"><i aria-hidden="true" />REC</span> : null}
    </div>
  );
}
