import type { MarketingCopilotAutonomy, MarketingRunCounters, MarketingRunView, Pane } from "@space/contracts";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { MARKETING_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import type { CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { Pause, PanelRight, Play, Square } from "../ui-theme/app-icons.js";
import { AUTONOMY_TEXT } from "./SetupTab.js";

const RUN_LABEL = { IDLE: "Idle", RUNNING: "Running", PAUSED: "Paused", STOPPED: "Stopped" } as const;

/** Agent chip with runtime picker, run state and autonomy, the channels in use, run controls and the compact toggles. */
export function MarketingCommandBar({ pane, runtimeOptions, autonomy, channels, paused, runState, counters, needsYou, backlog, runBusy, onRun, railOpen, layout = "split", switching, onSwitchRuntime, onSetDefault, onTogglePaused, onToggleRail }: {
  pane: Pane;
  runtimeOptions: CopilotRuntimeOption[];
  autonomy: MarketingCopilotAutonomy;
  /** Channels switched on / all channels. */
  channels: { enabled: number; total: number };
  paused: boolean;
  runState: MarketingRunView["status"];
  counters: MarketingRunCounters | null;
  /** Reviews, questions and proposals waiting for the operator. */
  needsYou: number;
  /** Briefs and due posts waiting for the agent. */
  backlog: number;
  runBusy: boolean;
  onRun(action: "start" | "pause" | "stop"): void;
  railOpen: boolean;
  /** Stacked (phone) layout: no rail toggle; the rail tabs live at the bottom of the pane. */
  layout?: "split" | "stacked";
  switching: boolean;
  onSwitchRuntime(runtimeId: string): void;
  onSetDefault(): void;
  onTogglePaused(checked: boolean): void;
  onToggleRail(): void;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <header className="jc-bar" aria-label={t("Marketing Copilot command bar")} data-layout={layout}>
      <div className="jc-bar-row primary">
        <AgentChip kind={MARKETING_COPILOT_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={switching} onSwitchRuntime={onSwitchRuntime} onSetDefault={onSetDefault} />
        <div className={`jc-run-pill state-${runState.toLowerCase()}`} role="status" aria-live="polite">
          <span className="jc-run-label">{t(RUN_LABEL[runState])} · {t(AUTONOMY_TEXT[autonomy].label)}</span>
          <span className="jc-run-queue" title={t("Channels the copilot may use")}>{t("{enabled}/{total} channels", { enabled: channels.enabled, total: channels.total })}</span>
          {backlog ? <span className="jc-run-queue" title={t("Briefs and due posts waiting for the copilot")}>{t("{count} queued", { count: backlog })}</span> : null}
          {needsYou ? <span className="jc-run-needs" title={t("Reviews, questions or proposals waiting for you")}>{needsYou === 1 ? t("{count} needs you", { count: needsYou }) : t("{count} need you", { count: needsYou })}</span> : null}
        </div>
      </div>
      <div className="jc-bar-row secondary">
        <div className="jc-run-controls" role="group" aria-label={t("Run controls")}>
          {runState === "RUNNING" ? (
            <button type="button" className="jc-button" disabled={runBusy} onClick={() => onRun("pause")} title={t("Pause after the current item")}><Pause aria-hidden="true" /> <span>{t("Pause")}</span></button>
          ) : (
            <button type="button" className="jc-button primary" disabled={runBusy} onClick={() => onRun("start")} title={runState === "PAUSED" ? t("Resume the run") : t("Work through your briefs and publish approved posts that are due")}>
              <Play aria-hidden="true" /> <span>{runState === "PAUSED" ? t("Resume") : t("Start")}</span>
            </button>
          )}
          {runState === "RUNNING" || runState === "PAUSED" ? <button type="button" className="jc-button ghost danger" disabled={runBusy} onClick={() => onRun("stop")} title={t("Stop the run")}><Square aria-hidden="true" /> <span>{t("Stop")}</span></button> : null}
        </div>
        <div className="jc-counters" aria-label={t("This run")}>
          {counters ? (
            <>
              <span className="jc-counter" title={t("Drafts written")}><strong>{counters.drafted}</strong> {t("drafted")}</span>
              <span className="jc-counter ok" title={t("Posts published")}><strong>{counters.published}</strong> {t("published")}</span>
              {counters.failed ? <span className="jc-counter warn" title={t("Publications that failed")}><strong>{counters.failed}</strong> {t("failed")}</span> : null}
            </>
          ) : null}
        </div>
        <div className="jc-bar-toggles">
          {layout === "stacked" ? (
            <SpaceToggle compact className="jc-toggle" label={<Pause aria-hidden="true" />} ariaLabel={t("Paused")} title={t("Paused: the copilot opens no new work item and publishes nothing")} checked={paused} onChange={onTogglePaused} />
          ) : (
            <SpaceToggle compact className="jc-toggle" label={t("Paused")} checked={paused} onChange={onTogglePaused} />
          )}
          {layout === "split" ? (
            <button type="button" className={`jc-icon-button${railOpen ? " selected" : ""}`} aria-pressed={railOpen} aria-label={railOpen ? t("Collapse the copilot rail") : t("Expand the copilot rail")} title={railOpen ? t("Collapse rail") : t("Expand rail")} onClick={onToggleRail}>
              <PanelRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
