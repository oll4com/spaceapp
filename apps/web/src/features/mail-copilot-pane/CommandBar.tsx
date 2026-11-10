import type { MailCopilotAutonomy, Pane } from "@space/contracts";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { MAIL_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import type { CopilotRuntimeOption } from "../copilot-kit/copilot-runtimes.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { Pause, PanelRight, Play, Square } from "../ui-theme/app-icons.js";

const AUTONOMY_LABEL: Record<MailCopilotAutonomy, string> = { ASSIST: "Assist", RULES: "Rules", FULL: "Full" };

export interface MailCommandBarProps {
  pane: Pane;
  runtimeOptions: CopilotRuntimeOption[];
  autonomy: MailCopilotAutonomy;
  /** Google accounts this pane works with / allowed for Space. */
  accountCount: { used: number; total: number };
  paused: boolean;
  runState: "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";
  counters: { taken: number; replied: number; drafted: number; archived: number; needsUser: number } | null;
  /** Reviews and questions waiting for the operator. */
  needsYou: number;
  runBusy: boolean;
  onRun(action: "start" | "pause" | "stop"): void;
  railOpen: boolean;
  /** Stacked (phone) layout: two rows, no rail toggle; the rail tabs live at the bottom of the pane. */
  layout?: "split" | "stacked";
  switching: boolean;
  onSwitchRuntime(runtimeId: string): void;
  onSetDefault(): void;
  onTogglePaused(checked: boolean): void;
  onToggleRail(): void;
}

/** Agent chip with runtime picker, the autonomy level, the accounts in use and the compact toggles. */
const RUN_LABEL = { IDLE: "Idle", RUNNING: "Running", PAUSED: "Paused", STOPPED: "Stopped" } as const;

export function MailCommandBar({ pane, runtimeOptions, autonomy, accountCount, paused, runState, counters, needsYou, runBusy, onRun, railOpen, layout = "split", switching, onSwitchRuntime, onSetDefault, onTogglePaused, onToggleRail }: MailCommandBarProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  return (
    <header className="jc-bar" aria-label={t("Mail Copilot command bar")} data-layout={layout}>
      <div className="jc-bar-row primary">
        <AgentChip kind={MAIL_COPILOT_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={switching} onSwitchRuntime={onSwitchRuntime} onSetDefault={onSetDefault} />
        <div className={`jc-run-pill state-${runState.toLowerCase()}`} role="status" aria-live="polite">
          <span className="jc-run-label">{t(RUN_LABEL[runState])} · {t(AUTONOMY_LABEL[autonomy])}</span>
          <span className="jc-run-queue" title={t("Google accounts this pane works with")}>{t(accountCount.total === 1 ? "{used}/{total} account" : "{used}/{total} accounts", accountCount)}</span>
          {needsYou ? <span className="jc-run-needs" title={t("Reviews or questions waiting for you")}>{t(needsYou === 1 ? "{count} needs you" : "{count} need you", { count: needsYou })}</span> : null}
        </div>
      </div>
      <div className="jc-bar-row secondary">
        <div className="jc-run-controls" role="group" aria-label={t("Run controls")}>
          {runState === "RUNNING" ? (
            <button type="button" className="jc-button" disabled={runBusy} onClick={() => onRun("pause")} title={t("Pause after the current item")}><Pause aria-hidden="true" /> <span>{t("Pause")}</span></button>
          ) : (
            <button type="button" className="jc-button primary" disabled={runBusy || accountCount.used === 0} onClick={() => onRun("start")} title={runState === "PAUSED" ? t("Resume the run") : t("Start working through new mail and the backlog")}>
              <Play aria-hidden="true" /> <span>{runState === "PAUSED" ? t("Resume") : t("Start")}</span>
            </button>
          )}
          {runState === "RUNNING" || runState === "PAUSED" ? <button type="button" className="jc-button ghost danger" disabled={runBusy} onClick={() => onRun("stop")} title={t("Stop the run")}><Square aria-hidden="true" /> <span>{t("Stop")}</span></button> : null}
        </div>
        <div className="jc-counters" aria-label={t("This run")}>
          {counters ? (
            <>
              <span className="jc-counter" title={t("Items taken")}><strong>{counters.taken}</strong> {t("taken")}</span>
              <span className="jc-counter ok" title={t("Replies sent")}><strong>{counters.replied}</strong> {t("replied")}</span>
              <span className="jc-counter" title={t("Drafts saved")}><strong>{counters.drafted}</strong> {t("drafted")}</span>
              <span className="jc-counter" title={t("Archived")}><strong>{counters.archived}</strong> {t("archived")}</span>
              {counters.needsUser ? <span className="jc-counter warn" title={t("Waiting for you")}><strong>{counters.needsUser}</strong> {t("need you")}</span> : null}
            </>
          ) : null}
        </div>
        <div className="jc-bar-toggles">
          {layout === "stacked" ? (
            <SpaceToggle compact className="jc-toggle" label={<Pause aria-hidden="true" />} ariaLabel={t("Paused")} title={t("Paused: the copilot opens no new work item")} checked={paused} onChange={onTogglePaused} />
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
