import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { MONITORING_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import { Activity, Brain, ChartColumn, PanelRight, Pause, Play, Radar, Server, Settings, Square, Terminal } from "../ui-theme/app-icons.js";
import { ActivityTab } from "./ActivityTab.js";
import { ChartsTab } from "./ChartsTab.js";
import { AlertsView } from "./AlertsView.js";
import { MemoryTab } from "./MemoryTab.js";
import { SetupTab } from "./SetupTab.js";
import { TargetsTab } from "./TargetsTab.js";
import { useMonitoringCopilotData } from "./useMonitoringCopilot.js";
import { onPaneTarget } from "../notifications/pane-target.js";
import "../copilot-kit/copilot-pane.css";
import "./monitoring-copilot-pane.css";
import { CopilotNotice } from "../copilot-kit/CopilotNotice.js";

export interface MonitoringCopilotPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's agent terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
}

export type MonitoringRailTab = "alerts" | "activity" | "targets" | "charts" | "memory" | "setup" | "terminal";
const RAIL_TABS: readonly MonitoringRailTab[] = ["activity", "targets", "charts", "memory", "setup", "terminal"];
const TAB_LABELS: Record<MonitoringRailTab, string> = { alerts: "Alerts", activity: "Activity", targets: "Targets", charts: "Charts", memory: "Memory", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { alerts: Radar, activity: Activity, targets: Server, charts: ChartColumn, memory: Brain, setup: Settings, terminal: Terminal } as const;

/** The tabs a layout offers, in strip order: the alerts lead only when they are a tab of their own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): MonitoringRailTab[] {
  return layout === "stacked" ? ["alerts", ...RAIL_TABS] : [...RAIL_TABS];
}
function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): MonitoringRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as MonitoringRailTab) ? (tab as MonitoringRailTab) : "activity";
}

/**
 * The Monitoring Copilot pane: the collector's alerts (firing first, the 30-day history on request), a command bar (agent, run
 * state, paused) and a collapsible, resizable rail with Activity (briefs, questions, the alert and guardian timeline), Targets,
 * Charts, Memory, Setup and the agent's terminal. The terminal element stays mounted whichever tab is active; PaneCard renders it with its
 * usual props. Narrow panes stack.
 */
export function MonitoringCopilotPane({ pane, isVisible, terminal }: MonitoringCopilotPaneProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const data = useMonitoringCopilotData(pane, isVisible);
  const state = data.state;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<MonitoringRailTab>>(() => readRailPreference(`space:monitoring-copilot:rail:${pane.id}`, ["alerts", ...RAIL_TABS], "activity"));
  const [notice, setNotice] = useState<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, MONITORING_COPILOT_KIND), [data.runtimes]);
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const agent = useCopilotAgent({ kind: MONITORING_COPILOT_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });
  const settings = state?.metadata.settings;
  const run = state?.run;
  const firing = state?.summary.firing;
  const collector = state?.summary.collector;

  useEffect(() => { writeRailPreference(`space:monitoring-copilot:rail:${pane.id}`, rail); }, [pane.id, rail]);
  // A notification click (a question, a guardian message) opens Activity; an alert opens the alerts; the collector card opens Setup.
  useEffect(() => {
    return onPaneTarget(pane.id, (target) => {
      if (/^(question|event):/.test(target)) setRail((current) => ({ ...current, collapsed: false, tab: "activity" }));
      else if (target === "setup") setRail((current) => ({ ...current, collapsed: false, tab: "setup" }));
      else if (/^alert:/.test(target) && layout === "stacked") setRail((current) => ({ ...current, tab: "alerts" }));
    });
  }, [layout, pane.id]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!state) return;
    const next = { ...state.metadata, settings: { ...state.metadata.settings, paused: checked } };
    data.setSettings(next);
    try { data.setSettings((await api.updateMonitoringCopilotSettings(pane.id, next)).metadata); } catch { void data.refresh(); }
  }, [data, pane.id, state]);

  const [runBusy, setRunBusy] = useState(false);
  const runAction = useCallback(async (action: "start" | "pause" | "stop") => {
    setRunBusy(true);
    try {
      const view = await api.monitoringCopilotRun(pane.id, action);
      setNotice(action !== "start" ? null : view.kickoffSent ? uiText(language, "Run started: the agent got its kickoff.")
        : uiText(language, "Run started. No kickoff was typed: the agent is already working, its CLI is not at an empty prompt, or no brief waits; it picks up new briefs on its own."));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : uiText(language, "The run could not be changed."));
    } finally {
      setRunBusy(false);
      void data.refresh();
    }
  }, [data, language, pane.id]);

  const selectTab = useCallback((tab: MonitoringRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
  const toggleRail = useCallback(() => setRail((current) => ({ ...current, collapsed: !current.collapsed })), []);
  const onResizeStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (rail.collapsed) return;
    resizeRef.current = { startX: event.clientX, startWidth: rail.width };
    event.currentTarget.setPointerCapture(event.pointerId);
  }, [rail.collapsed, rail.width]);
  const onResizeMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const start = resizeRef.current;
    if (!start) return;
    const width = Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, start.startWidth + (start.startX - event.clientX)));
    setRail((current) => current.width === width ? current : { ...current, width });
  }, []);
  const onResizeEnd = useCallback(() => { resizeRef.current = null; }, []);

  const needsYou = (run?.openQuestions ?? 0) + (run?.openReviews ?? 0);
  const tabs: CopilotRailTabDefinition<MonitoringRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id],
    badge: id === "activity" ? needsYou || null : id === "alerts" ? firing?.CRITICAL || null : null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  const railOpen = layout === "stacked" || !rail.collapsed;
  const alertsShown = layout === "split" || activeTab === "alerts" || rail.collapsed;
  const paused = settings?.paused ?? false;
  const runLabel = paused ? t("Paused") : run?.status === "PAUSED" ? t("Run paused") : run?.status === "STOPPED" ? t("Run stopped")
    : collector?.reachable === false ? t("Collector down") : firing ? t("{critical} critical · {warnings} warnings", { critical: firing.CRITICAL, warnings: firing.WARNING }) : t("Loading");

  return (
    <div ref={paneRef} className="jc-pane mc-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"}
      style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <header className="jc-bar" aria-label={t("Monitoring Copilot command bar")} data-layout={layout}>
        <div className="jc-bar-row primary">
          <AgentChip kind={MONITORING_COPILOT_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()} />
          <div className={`jc-run-pill state-${paused || run?.status === "PAUSED" || run?.status === "STOPPED" ? "paused" : collector?.reachable === false || firing?.CRITICAL ? "running" : "idle"}`} role="status" aria-live="polite">
            <span className="jc-run-label">{runLabel}</span>
            {needsYou ? <span className="jc-run-needs" title={t("Questions waiting for you")}>{needsYou === 1 ? t("{count} needs you", { count: needsYou }) : t("{count} need you", { count: needsYou })}</span> : null}
          </div>
        </div>
        <div className="jc-bar-row secondary">
          <div className="jc-run-controls" role="group" aria-label={t("Run controls")}>
            {run?.status === "RUNNING" ? (
              <button type="button" className="jc-button" disabled={runBusy} onClick={() => void runAction("pause")} title={t("Pause: no new briefs until it starts again")}><Pause aria-hidden="true" /> {t("Pause")}</button>
            ) : (
              <button type="button" className="jc-button primary" disabled={runBusy || !state || paused} onClick={() => void runAction("start")}
                title={paused ? t("Turn Paused off to start") : run?.status === "PAUSED" ? t("Resume the run") : t("Start: the agent works through the briefs and answers waiting for it")}>
                <Play aria-hidden="true" /> {run?.status === "PAUSED" ? t("Resume") : t("Start")}
              </button>
            )}
            {run?.status === "RUNNING" || run?.status === "PAUSED" ? (
              <button type="button" className="jc-button ghost danger" disabled={runBusy} onClick={() => void runAction("stop")} title={t("Stop the run")}><Square aria-hidden="true" /> {t("Stop")}</button>
            ) : null}
          </div>
          <div className="jc-bar-toggles">
            <SpaceToggle compact className="jc-toggle" label={t("Paused")} checked={paused} disabled={!state} onChange={(checked) => void togglePaused(checked)} />
            {layout === "split" ? (
              <button type="button" className={`jc-icon-button${railOpen ? " selected" : ""}`} aria-pressed={railOpen} aria-label={railOpen ? t("Collapse the Monitoring Copilot rail") : t("Expand the Monitoring Copilot rail")} title={railOpen ? t("Collapse rail") : t("Expand rail")} onClick={toggleRail}>
                <PanelRight aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <CopilotNotice text={notice || data.error} loaded={Boolean(data.state)} />
      <div className="jc-body">
        <section className="jc-main mc-main" aria-label={t("Alerts")} data-active={alertsShown ? "true" : "false"} aria-hidden={alertsShown ? undefined : "true"}>
          <AlertsView state={state} />
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label={t("Resize the Monitoring Copilot rail")} aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail firstRead={{ text: notice || data.error, loaded: Boolean(data.state) }} tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "activity" ? <ActivityTab paneId={pane.id} events={state?.events ?? []} actions={state?.actions ?? []} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "targets" ? <TargetsTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "charts" ? <ChartsTab paneId={pane.id} visible={isVisible} /> : null}
          {railOpen && activeTab === "memory" ? <MemoryTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "setup" && state ? (
            <SetupTab pane={pane} settings={state.metadata} collectorConfig={state.collectorConfig} runtimeOptions={runtimeOptions} switching={agent.switching} accountRevision={agent.accountRevision}
              onSettingsChange={data.setSettings} onSwitchAgent={(runtimeId, accountProfileId) => void agent.switchAgent(runtimeId, accountProfileId)} onSetDefault={() => void agent.setAsDefault()} />
          ) : null}
          <div key={agent.terminalKey} className="jc-panel-terminal" role="tabpanel" id="jc-panel-terminal" aria-labelledby="jc-tab-terminal" data-active={railOpen && activeTab === "terminal" ? "true" : "false"}>
            {terminal}
          </div>
        </CopilotRail>
      </div>
    </div>
  );
}
