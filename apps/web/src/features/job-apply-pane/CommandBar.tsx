import { useEffect, useRef, useState } from "react";
import type { JobApplyStats, Pane, UiLanguage } from "@space/contracts";
import { cliRuntimePresentation } from "../../cli-runtime-presentation.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { uiText, useUiLanguage } from "../ui-language/ui-language.js";
import { BookmarkPlus, Check, ChevronDown, PanelRight, Pause, Play, RefreshCw, Square, Terminal } from "../ui-theme/app-icons.js";
import { paneModelLabel, type JobCopilotRuntimeOption } from "./agent-runtimes.js";
import type { JobApplyTodayCounts } from "./useJobApply.js";

export type JobCopilotRunState = "IDLE" | "RUNNING" | "PAUSED" | "STOPPED";

export interface CommandBarProps {
  pane: Pane;
  runtimeOptions: JobCopilotRuntimeOption[];
  counts: JobApplyTodayCounts;
  /** Totals since the first day; the counters fall back to today's when missing. */
  stats?: JobApplyStats | null;
  runState: JobCopilotRunState;
  /** Completed / total of the current run; null when idle. */
  progress: { done: number; total: number } | null;
  paused: boolean;
  railOpen: boolean;
  /** Stacked (phone) layout: two rows, no rail toggle; the rail tabs live at the bottom of the pane. */
  layout?: "split" | "stacked";
  switching: boolean;
  /** Pending questions or reviews the operator owes the copilot. */
  needsYou: number;
  runBusy: boolean;
  onRun(action: "start" | "pause" | "stop"): void;
  onSwitchRuntime(runtimeId: string): void;
  /** A fresh conversation on the same agent; the current one stays in the task history. */
  onNewSession?(): void;
  /** New Job Copilot panes open with this pane's agent and account. */
  onSetDefault(): void;
  onTogglePaused(checked: boolean): void;
  onToggleRail(): void;
}

function ProgressRing({ progress, state }: { progress: { done: number; total: number } | null; state: JobCopilotRunState }) {
  const ratio = progress && progress.total > 0 ? Math.min(1, progress.done / progress.total) : 0;
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg className="jc-run-ring" viewBox="0 0 18 18" aria-hidden="true" data-state={state.toLowerCase()}>
      <circle cx="9" cy="9" r={radius} className="jc-run-ring-track" />
      <circle cx="9" cy="9" r={radius} className="jc-run-ring-value" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - ratio)} />
    </svg>
  );
}

const RUN_LABEL: Record<JobCopilotRunState, string> = { IDLE: "Idle", RUNNING: "Running", PAUSED: "Paused", STOPPED: "Stopped" };

/** "2026-10-13" → "Oct 13", read as a local calendar day. */
export function shortDay(day: string, language: UiLanguage = "en"): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString(language === "el" ? "el" : "en", { month: "short", day: "numeric" });
}

type Translate = (text: string, vars?: Record<string, string | number>) => string;

/** A counter with its number in bold: the words are the translation of `text` (it holds a `{count}` slot), so a language puts the number where it belongs. */
export function Counted({ text, count, t }: { text: string; count: number; t: Translate }) {
  const [before = "", after = ""] = t(text, { count: "\u0000" }).split("\u0000");
  return <>{before}<strong>{count}</strong>{after}</>;
}

/** Agent chip with runtime picker, run state, the counters since the first day and the compact toggles. */
export function CommandBar({ pane, runtimeOptions, counts, stats = null, runState, progress, paused, railOpen, layout = "split", switching, needsYou, runBusy, onRun, onSwitchRuntime, onNewSession, onSetDefault, onTogglePaused, onToggleRail }: CommandBarProps) {
  const language = useUiLanguage();
  const t: Translate = (text, vars) => uiText(language, text, vars);
  const shown = stats?.totals ?? counts;
  const since = stats?.firstDay ? shortDay(stats.firstDay, language) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const runtimeId = pane.terminalRuntimeId ?? null;
  const current = runtimeOptions.find((option) => option.runtime.id === runtimeId) ?? null;
  const presentation = runtimeId ? cliRuntimePresentation(runtimeId) : null;
  const model = paneModelLabel(pane);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => { if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false); };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("pointerdown", onPointer); window.removeEventListener("keydown", onKey); };
  }, [menuOpen]);

  return (
    <header className="jc-bar" aria-label={t("Job Copilot command bar")} data-layout={layout}>
      <div className="jc-bar-row primary">
      <div className="jc-agent" ref={menuRef}>
        <button type="button" className="jc-agent-chip" aria-haspopup="menu" aria-expanded={menuOpen} aria-label={t("Copilot agent: {agent}", { agent: current?.runtime.displayName ?? runtimeId ?? t("none") })}
          disabled={switching} onClick={() => setMenuOpen((open) => !open)}>
          {presentation ? <img src={presentation.iconSrc} alt="" aria-hidden="true" /> : <Terminal aria-hidden="true" />}
          <span className="jc-agent-name">{switching ? t("Switching…") : current?.runtime.displayName ?? presentation?.displayName ?? t("Choose an agent")}</span>
          {model ? <span className="jc-agent-model">{model}</span> : null}
          <ChevronDown aria-hidden="true" />
        </button>
        {menuOpen ? (
          <div className="jc-menu" role="menu" aria-label={t("Switch copilot agent")}>
            <p className="jc-menu-hint">{t("Switching restarts this pane's CLI session.")}</p>
            {runtimeOptions.map(({ runtime, ready, recommended }) => {
              const option = cliRuntimePresentation(runtime.id);
              const active = runtime.id === runtimeId;
              return (
                <button key={runtime.id} type="button" role="menuitemradio" aria-checked={active} className={`jc-menu-item${active ? " selected" : ""}`}
                  disabled={!ready || active} title={ready ? undefined : runtime.statusReason}
                  onClick={() => { setMenuOpen(false); onSwitchRuntime(runtime.id); }}>
                  {option ? <img src={option.iconSrc} alt="" aria-hidden="true" /> : <Terminal aria-hidden="true" />}
                  <span className="jc-menu-item-copy">
                    <strong>{runtime.displayName}</strong>
                    <small>{ready ? (recommended ? t("Recommended") : t("Ready")) : runtime.statusReason}</small>
                  </span>
                  {active ? <Check aria-hidden="true" /> : null}
                </button>
              );
            })}
            {onNewSession ? (
              <button type="button" role="menuitem" className="jc-menu-item" disabled={!runtimeId || switching}
                onClick={() => { setMenuOpen(false); onNewSession(); }}>
                <RefreshCw aria-hidden="true" />
                <span className="jc-menu-item-copy">
                  <strong>{t("Start a new session")}</strong>
                  <small>{t("The copilot starts a fresh conversation; this one stays in the task history.")}</small>
                </span>
              </button>
            ) : null}
            <button type="button" role="menuitem" className="jc-menu-item jc-menu-default" disabled={!runtimeId}
              onClick={() => { setMenuOpen(false); onSetDefault(); }}>
              <BookmarkPlus aria-hidden="true" />
              <span className="jc-menu-item-copy">
                <strong>{t("Set as default for new Job Copilot panes")}</strong>
                <small>{t("New panes open with this agent and account without asking.")}</small>
              </span>
            </button>
          </div>
        ) : null}
      </div>

      <div className={`jc-run-pill state-${runState.toLowerCase()}`} role="status" aria-live="polite">
        <ProgressRing progress={progress} state={runState} />
        <span className="jc-run-label">{t(RUN_LABEL[runState])}{progress ? ` ${progress.done}/${progress.total}` : ""}</span>
        <span className="jc-run-queue" title={t("Queued postings")}>{t("{count} queued", { count: counts.queued })}</span>
        {counts.deferred ? <span className="jc-run-queue" title={t("Waiting for an employer limit; the next one is free on {date}", { date: counts.nextFreeAt?.slice(0, 10) ?? "" })}>{t("{count} deferred", { count: counts.deferred })}</span> : null}
        {needsYou ? <span className="jc-run-needs" title={t("Questions or reviews waiting for you")}>{needsYou === 1 ? t("1 needs you") : t("{count} need you", { count: needsYou })}</span> : null}
      </div>
      </div>
      <div className="jc-bar-row secondary">
      <div className="jc-run-controls" role="group" aria-label={t("Run controls")}>
        {runState === "RUNNING" ? (
          <button type="button" className="jc-button" disabled={runBusy} onClick={() => onRun("pause")} title={t("Pause after the current application")}><Pause aria-hidden="true" /> {t("Pause")}</button>
        ) : (
          <button type="button" className="jc-button primary" disabled={runBusy} onClick={() => onRun("start")}
            title={runState === "PAUSED" ? t("Resume the run") : counts.queued > 0 ? t("Start working through the queue")
              : counts.deferred ? t("Find new postings, queue them and apply (every queued posting waits for an employer limit; the next one is free on {date})", { date: counts.nextFreeAt?.slice(0, 10) ?? "" })
                : t("Find new postings, queue them and apply")}>
            <Play aria-hidden="true" /> {runState === "PAUSED" ? t("Resume") : t("Start")}
          </button>
        )}
        {runState === "RUNNING" || runState === "PAUSED" ? (
          <button type="button" className="jc-button ghost danger" disabled={runBusy} onClick={() => onRun("stop")} title={t("Stop the run; the current application keeps its state")}><Square aria-hidden="true" /> {t("Stop")}</button>
        ) : null}
      </div>

      <div className="jc-counters" aria-label={since ? t("Since {day}", { day: since }) : t("Today")}
        title={stats ? (stats.today.failed
          ? t("Today: {applied} applied, {verified} verified, {failed} failed", { applied: stats.today.applied, verified: stats.today.verified, failed: stats.today.failed })
          : t("Today: {applied} applied, {verified} verified", { applied: stats.today.applied, verified: stats.today.verified })) : undefined}>
        <span className="jc-counter" title={since ? t("Submitted since {day}", { day: since }) : t("Submitted today")}><Counted t={t} text="{count} applied" count={shown.applied} /></span>
        <span className="jc-counter ok" title={since ? t("Verified with evidence since {day}", { day: since }) : t("Verified with evidence today")}><Counted t={t} text="{count} verified" count={shown.verified} /></span>
        {shown.failed ? <span className="jc-counter bad" title={since ? t("Failed since {day}", { day: since }) : t("Failed today")}><Counted t={t} text="{count} failed" count={shown.failed} /></span> : null}
        {shown.needsUser ? <span className="jc-counter warn" title={t("Waiting for you")}><Counted t={t} text="{count} need you" count={shown.needsUser} /></span> : null}
      </div>

      <div className="jc-bar-toggles">
        {layout === "stacked" ? (
          <SpaceToggle compact className="jc-toggle" label={<Pause aria-hidden="true" />} ariaLabel={t("Paused")} title={t("Paused: the copilot opens no new posting")} checked={paused} onChange={onTogglePaused} />
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
