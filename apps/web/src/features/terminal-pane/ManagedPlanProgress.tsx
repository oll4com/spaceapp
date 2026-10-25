import { useState } from "react";
import type { ManagedPlanExecution, PaneCliModelSettings, StageModelSelection } from "@space/contracts";
import { isFinishedExecution } from "./managed-plan-client.js";
import "./managed-plan-progress.css";

export interface ManagedPlanProgressProps {
  execution: ManagedPlanExecution;
  settings: PaneCliModelSettings | null;
  onOverride: (stageId: string, selection: StageModelSelection | null) => Promise<unknown>;
  onControl: (action: "pause" | "resume") => Promise<unknown>;
  error: string | null;
  pending: boolean;
  canControl: boolean;
}
export const executionStatusLabel: Record<ManagedPlanExecution["status"], string> = {
  RUNNING: "Running", SWITCHING_MODEL: "Switching model", RESUMING_STAGE: "Resuming stage", WAITING_FOR_MODEL: "Waiting for model",
  WAITING_FOR_INPUT: "Waiting for input", PAUSED: "Paused", BLOCKED: "Blocked", COMPLETED: "Completed", FAILED: "Failed"
};
const selectionLabel = (selection: StageModelSelection) => `${selection.modelId} · ${selection.reasoningEffort}`;

export function ManagedPlanProgress({ execution, settings, onOverride, onControl, error, pending, canControl }: ManagedPlanProgressProps) {
  const [editing, setEditing] = useState<{ stageId: string; modelId: string; reasoningEffort: string } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const finished = isFinishedExecution(execution);
  const active = execution.snapshot.stages[execution.activeStageIndex];
  const catalog = settings?.sessionId === execution.sessionId && (!settings.threadId || settings.threadId === execution.threadId) ? settings.models : [];
  const locked = !canControl || pending || busy;
  const resumable = ["PAUSED", "BLOCKED"].includes(execution.status);
  const operate = async (operation: () => Promise<unknown>) => {
    setBusy(true); setLocalError(null);
    try { await operation(); } catch (failure) { setLocalError(failure instanceof Error ? failure.message : "Plan control request failed."); }
    finally { setBusy(false); }
  };
  return <div className="managed-plan-progress">
    <div className="terminal-plan-active-title">{execution.snapshot.title || "Plan"}</div>
    <p className="managed-plan-status" role="status" aria-live="polite" aria-atomic="true">
      {finished ? "Plan" : `Stage ${active?.order ?? execution.activeStageIndex + 1}`} · {executionStatusLabel[execution.status]} · {execution.completedStageIds.length} of {execution.snapshot.stages.length} stages completed
    </p>
    {error || localError ? <p className="terminal-plans-error" role="alert">{localError || error}</p> : null}
    {execution.statusReason ? <p className="managed-plan-reason">{execution.statusReason}</p> : null}
    {!finished ? <div className="managed-plan-controls">
      <button type="button" className="terminal-plans-nav-btn" aria-label={resumable ? "Resume plan" : "Pause plan"} disabled={locked || execution.interruptReason === "PAUSE"}
        onClick={() => void operate(() => onControl(resumable ? "resume" : "pause"))}>{execution.interruptReason === "PAUSE" ? "Pausing…" : resumable ? "Resume" : "Pause"}</button>
      {!canControl ? <span>Terminal control is required.</span> : null}
    </div> : null}
    {execution.retryCount > 0 ? <p className="managed-plan-reason">Model retries: {execution.retryCount}{execution.nextRetryAt ? ` · Next retry: ${new Date(execution.nextRetryAt).toLocaleString("en-US")}` : ""}</p> : null}
    {execution.checkpoint ? <details className="managed-plan-checkpoint"><summary>Latest checkpoint</summary><p>{execution.checkpoint}</p></details> : null}
    <div className="managed-plan-stages">
      {execution.snapshot.stages.map((stage, index) => {
        const complete = execution.completedStageIds.includes(stage.id);
        const current = !finished && index === execution.activeStageIndex;
        const mutable = !finished && !complete && index >= execution.activeStageIndex;
        const override = execution.overrides[stage.id];
        const attempts = execution.attempts.filter(attempt => attempt.stageId === stage.id);
        const editor = mutable && editing?.stageId === stage.id ? editing : null;
        const selectedModel = editor ? catalog.find(model => model.id === editor.modelId) : null;
        return <section key={stage.id} className="managed-plan-stage" aria-label={`Stage ${stage.order}: ${stage.title}`}>
          <div className="managed-plan-stage-heading"><strong>{stage.order}. {stage.title}</strong><span>{complete ? "Completed" : current ? executionStatusLabel[execution.status] : "Planned"}</span></div>
          <p>Planned model: {selectionLabel(stage)}</p>
          {override ? <p>Stage override: {selectionLabel(override)}</p> : null}
          {current ? <p>Running model: Pending native confirmation</p> : null}
          {current ? <p className="managed-plan-native-note">Live accepted turn configuration is unavailable. Native accepted configuration appears in history after the turn closes.</p> : null}
          {mutable ? <div className="managed-plan-stage-actions">
            <button type="button" className="terminal-plans-nav-btn" aria-label={`Change model for stage ${stage.order}`} disabled={locked || !catalog.length}
              onClick={() => { setLocalError(null); setEditing({ stageId: stage.id, modelId: (override ?? stage).modelId, reasoningEffort: (override ?? stage).reasoningEffort }); }}>Change model</button>
            {override ? <button type="button" className="terminal-plans-nav-btn" aria-label={`Use plan model for stage ${stage.order}`} disabled={locked || !catalog.length}
              onClick={() => void operate(async () => { await onOverride(stage.id, null); setEditing(null); })}>Use plan model</button> : null}
          </div> : null}
          {editor ? <form className="managed-plan-stage-editor" onSubmit={event => {
            event.preventDefault();
            if (!selectedModel?.supportedReasoningEfforts.includes(editor.reasoningEffort)) return;
            void operate(async () => { await onOverride(stage.id, { modelId: editor.modelId, reasoningEffort: editor.reasoningEffort }); setEditing(null); });
          }}>
            <label>Model<select aria-label={`Model for stage ${stage.order}`} value={editor.modelId} disabled={locked}
              onChange={event => {
                const modelId = event.target.value; const model = catalog.find(item => item.id === modelId);
                setEditing({ ...editor, modelId, reasoningEffort: model?.supportedReasoningEfforts.includes(editor.reasoningEffort) ? editor.reasoningEffort : "" });
              }}>
              {!catalog.some(model => model.id === editor.modelId) ? <option value={editor.modelId} disabled>{editor.modelId} (unavailable)</option> : null}
              {catalog.map(model => <option key={model.id} value={model.id}>{model.displayName}</option>)}
            </select></label>
            <label>Reasoning<select aria-label={`Reasoning for stage ${stage.order}`} value={editor.reasoningEffort} disabled={locked} onChange={event => setEditing({ ...editor, reasoningEffort: event.target.value })}>
              {!selectedModel?.supportedReasoningEfforts.includes(editor.reasoningEffort) ? <option value={editor.reasoningEffort} disabled>{editor.reasoningEffort ? `${editor.reasoningEffort} (unavailable)` : "Choose reasoning"}</option> : null}
              {selectedModel?.supportedReasoningEfforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}
            </select></label>
            <div className="managed-plan-stage-actions"><button type="submit" className="terminal-plans-nav-btn" aria-label={`Apply model for stage ${stage.order}`} disabled={locked || !selectedModel?.supportedReasoningEfforts.includes(editor.reasoningEffort)}>Apply</button>
              <button type="button" className="terminal-plans-nav-btn" onClick={() => setEditing(null)}>Cancel</button></div>
          </form> : null}
          {attempts.length ? <details className="managed-plan-attempts"><summary>Attempt history ({attempts.length})</summary>{attempts.map(attempt => <div key={attempt.id} className="managed-plan-attempt">
            <p>{attempt.status === "COMPLETED" ? "Completed" : attempt.status === "INTERRUPTED" ? "Interrupted" : attempt.status === "FAILED" ? "Failed" : "Pending native confirmation"}</p>
            {attempt.actualSelection ? <>
              <p>Native accepted configuration: {selectionLabel(attempt.actualSelection)}</p>
              <p className="managed-plan-native-note">Accepted turn configuration; provider telemetry is unavailable.</p>
              <p className="managed-plan-native-identity">Thread: {attempt.actualSelection.threadId} · Turn: {attempt.actualSelection.turnId} · Command: {attempt.actualSelection.commandId}</p>
              <p className="managed-plan-native-identity">Observed: {attempt.actualSelection.observedAt} · Closed: {attempt.actualSelection.completedAt}</p>
            </> : <p>Pending native confirmation</p>}
            {attempt.result ? <><p>{attempt.result.summary}</p>{attempt.result.evidence.map((evidence, i) => <p key={i}>{evidence.criterion}: {evidence.result}</p>)}</> : null}
          </div>)}</details> : null}
        </section>;
      })}
    </div>
    {!finished && !catalog.length ? <p className="managed-plan-reason">Native session model catalog is unavailable. Refresh models in the pane picker before changing a stage.</p> : null}
  </div>;
}
