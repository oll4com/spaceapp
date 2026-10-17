import type { FreelanceCopilotAutonomy, FreelanceRunCounters, FreelanceRunView, Pane } from "@space/contracts";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { FREELANCE_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import type { CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Pause, PanelRight, Play, Square } from "../ui-theme/app-icons.js";
import { AUTONOMY_TEXT } from "./SetupTab.js";

const RUN_LABEL = { IDLE: "Idle", RUNNING: "Running", PAUSED: "Paused", STOPPED: "Stopped" } as const;

/** Agent chip with runtime picker, run state and autonomy, the platforms in use, run controls and the compact toggles. */
export function FreelanceCommandBar({ pane, runtimeOptions, autonomy, channels, paused, runState, counters, needsYou, backlog, runBusy, onRun, railOpen, layout = "split", switching, onSwitchRuntime, onSetDefault, onTogglePaused, onToggleRail }: {
  pane: Pane;
  runtimeOptions: CopilotRuntimeOption[];
  autonomy: FreelanceCopilotAutonomy;
  /** Platforms switched on / all platforms. */
  channels: { enabled: number; total: number };
  paused: boolean;
  runState: FreelanceRunView["status"];
  counters: FreelanceRunCounters | null;
  /** Ready clients, reviews, questions and accounts waiting for the operator. */
  needsYou: number;
  /** Briefs, mails, approved messages and follow-ups waiting for the agent. */
  backlog: number;
  runBusy: boolean;
  onRun(action: "start" | "pause" | "stop"): void;
  railOpen: boolean;
  layout?: "split" | "stacked";
  switching: boolean;
  onSwitchRuntime(runtimeId: string): void;
  onSetDefault(): void;
  onTogglePaused(checked: boolean): void;
  onToggleRail(): void;
}) {
  return (
    <header className="jc-bar" aria-label="Freelance Copilot command bar" data-layout={layout}>
      <div className="jc-bar-row primary">
        <AgentChip kind={FREELANCE_COPILOT_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={switching} onSwitchRuntime={onSwitchRuntime} onSetDefault={onSetDefault} />
        <div className={`jc-run-pill state-${runState.toLowerCase()}`} role="status" aria-live="polite">
          <span className="jc-run-label">{RUN_LABEL[runState]} · {AUTONOMY_TEXT[autonomy].label}</span>
          <span className="jc-run-queue" title="Platforms the copilot may use">{channels.enabled}/{channels.total} platforms</span>
          {backlog ? <span className="jc-run-queue" title="Briefs, mails, approved messages and follow-ups waiting for the copilot">{backlog} queued</span> : null}
          {needsYou ? <span className="jc-run-needs" title="Ready clients, reviews, questions or accounts waiting for you">{needsYou} need{needsYou === 1 ? "s" : ""} you</span> : null}
        </div>
      </div>
      <div className="jc-bar-row secondary">
        <div className="jc-run-controls" role="group" aria-label="Run controls">
          {runState === "RUNNING" ? (
            <button type="button" className="jc-button" disabled={runBusy} onClick={() => onRun("pause")} title="Pause after the current item"><Pause aria-hidden="true" /> <span>Pause</span></button>
          ) : (
            <button type="button" className="jc-button primary" disabled={runBusy} onClick={() => onRun("start")} title={runState === "PAUSED" ? "Resume the run" : "Work through briefs, new mail, approved messages and due follow-ups"}>
              <Play aria-hidden="true" /> <span>{runState === "PAUSED" ? "Resume" : "Start"}</span>
            </button>
          )}
          {runState === "RUNNING" || runState === "PAUSED" ? <button type="button" className="jc-button ghost danger" disabled={runBusy} onClick={() => onRun("stop")} title="Stop the run"><Square aria-hidden="true" /> <span>Stop</span></button> : null}
        </div>
        <div className="jc-counters" aria-label="This run">
          {counters ? (
            <>
              <span className="jc-counter" title="Proposals and messages written"><strong>{counters.drafted}</strong> drafted</span>
              <span className="jc-counter ok" title="Proposals and messages sent"><strong>{counters.sent}</strong> sent</span>
              {counters.failed ? <span className="jc-counter warn" title="Sends that failed"><strong>{counters.failed}</strong> failed</span> : null}
            </>
          ) : null}
        </div>
        <div className="jc-bar-toggles">
          {layout === "stacked" ? (
            <SpaceToggle compact className="jc-toggle" label={<Pause aria-hidden="true" />} ariaLabel="Paused" title="Paused: the copilot opens no new work item and sends nothing" checked={paused} onChange={onTogglePaused} />
          ) : (
            <SpaceToggle compact className="jc-toggle" label="Paused" checked={paused} onChange={onTogglePaused} />
          )}
          {layout === "split" ? (
            <button type="button" className={`jc-icon-button${railOpen ? " selected" : ""}`} aria-pressed={railOpen} aria-label={railOpen ? "Collapse the copilot rail" : "Expand the copilot rail"} title={railOpen ? "Collapse rail" : "Expand rail"} onClick={onToggleRail}>
              <PanelRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
