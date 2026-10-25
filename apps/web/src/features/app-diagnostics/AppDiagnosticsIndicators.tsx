import { useEffect, useState } from "react";
import {
  APP_DIAGNOSTICS_STATE_EVENT,
  getAppDiagnosticsClientState,
  type AppDiagnosticsClientState
} from "../../app-diagnostics/app-diagnostics-bootstrap.js";
import {
  APP_DIAGNOSTICS_RECORDER_STATE_EVENT,
  getAppDiagnosticsRecorderState,
  type AppDiagnosticsRecorderState
} from "../../app-diagnostics/app-diagnostics-video-recorder.js";
import "./app-diagnostics-settings.css";

// Always-mounted diagnostics state and DEBUG/REC indicators. Kept separate from
// the settings card so the card UI can be loaded on demand.
export function useDiagnosticsState(override?: AppDiagnosticsClientState): AppDiagnosticsClientState {
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

export function useRecorderState(override?: AppDiagnosticsRecorderState): AppDiagnosticsRecorderState {
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
