import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { SECURITY_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Activity, Brain, PanelRight, Pause, Play, Server, Settings, ShieldHalf, Square, Terminal } from "../ui-theme/app-icons.js";
import { ActivityTab } from "./ActivityTab.js";
import { FindingsView } from "./FindingsView.js";
import { HostsTab } from "./HostsTab.js";
import { MemoryTab } from "./MemoryTab.js";
import { SetupTab } from "./SetupTab.js";
import { useSecurityCopilotData } from "./useSecurityCopilot.js";
import { onPaneTarget } from "../notifications/pane-target.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";
import "../copilot-kit/copilot-pane.css";
import "./security-copilot-pane.css";
import { CopilotNotice } from "../copilot-kit/CopilotNotice.js";

export interface SecurityCopilotPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's agent terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
}

export type SecurityRailTab = "findings" | "activity" | "hosts" | "memory" | "setup" | "terminal";
const RAIL_TABS: readonly SecurityRailTab[] = ["activity", "hosts", "memory", "setup", "terminal"];
const TAB_LABELS: Record<SecurityRailTab, string> = { findings: "Findings", activity: "Activity", hosts: "Hosts", memory: "Memory", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { findings: ShieldHalf, activity: Activity, hosts: Server, memory: Brain, setup: Settings, terminal: Terminal } as const;

/** The tabs a layout offers, in strip order: the findings lead only when they are a tab of their own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): SecurityRailTab[] {
  return layout === "stacked" ? ["findings", ...RAIL_TABS] : [...RAIL_TABS];
}
function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): SecurityRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as SecurityRailTab) ? (tab as SecurityRailTab) : "activity";
}

/**
 * The Security Copilot pane: the fleet's open findings, a command bar (agent, run state, paused, autonomy) and a collapsible,
 * resizable rail with Activity (briefs, held changes, questions, timeline), Hosts, Memory, Setup and the agent's terminal. The
 * terminal element stays mounted whichever tab is active; PaneCard renders it with its usual props. Narrow panes stack.
 */
export function SecurityCopilotPane({ pane, isVisible, terminal }: SecurityCopilotPaneProps) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
  const data = useSecurityCopilotData(pane, isVisible);
  const state = data.state;
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<SecurityRailTab>>(() => readRailPreference(`space:security-copilot:rail:${pane.id}`, ["findings", ...RAIL_TABS], "activity"));
  const [notice, setNotice] = useState<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, SECURITY_COPILOT_KIND), [data.runtimes]);
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const agent = useCopilotAgent({ kind: SECURITY_COPILOT_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });
  const settings = state?.metadata.settings;
  const run = state?.run;
  const counts = state?.summary.openFindings;

  useEffect(() => { writeRailPreference(`space:security-copilot:rail:${pane.id}`, rail); }, [pane.id, rail]);
  // A notification click (a held change, a question, a failed fix) opens Activity; a finding opens the findings.
  useEffect(() => {
    return onPaneTarget(pane.id, (target) => {
      if (/^(review|question|action):/.test(target)) setRail((current) => ({ ...current, collapsed: false, tab: "activity" }));
      else if (/^finding:/.test(target) && layout === "stacked") setRail((current) => ({ ...current, tab: "findings" }));
    });
  }, [layout, pane.id]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!state) return;
    const next = { ...state.metadata, settings: { ...state.metadata.settings, paused: checked } };
    data.setSettings(next);
    try { data.setSettings((await api.updateSecurityCopilotSettings(pane.id, next)).metadata); } catch { void data.refresh(); }
  }, [data, pane.id, state]);

  const [runBusy, setRunBusy] = useState(false);
  const runAction = useCallback(async (action: "start" | "pause" | "stop") => {
    setRunBusy(true);
    try {
      const view = await api.securityCopilotRun(pane.id, action);
      setNotice(action !== "start" ? null : view.kickoffSent ? uiText(language, "Run started: the agent got its kickoff.")
        : uiText(language, "Run started. No kickoff was typed: the agent is already working, its CLI is not at an empty prompt, or there is no open work; it picks up new work on its own."));
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : uiText(language, "The run could not be changed."));
    } finally {
      setRunBusy(false);
      void data.refresh();
    }
  }, [data, language, pane.id]);

  const selectTab = useCallback((tab: SecurityRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const needsYou = (run?.openReviews ?? 0) + (run?.openQuestions ?? 0);
  const tabs: CopilotRailTabDefinition<SecurityRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id],
    badge: id === "activity" ? needsYou || null : id === "findings" ? (counts ? counts.P0 + counts.P1 : 0) || null : null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  const railOpen = layout === "stacked" || !rail.collapsed;
  const findingsShown = layout === "split" || activeTab === "findings" || rail.collapsed;
  const paused = settings?.paused ?? false;
  const runLabel = paused ? t("Paused") : run?.status === "PAUSED" ? t("Run paused") : run?.status === "STOPPED" ? t("Run stopped")
    : counts ? t("{p0} P0 · {p1} P1 · {p2} P2", { p0: counts.P0, p1: counts.P1, p2: counts.P2 }) : t("Loading");

  return (
    <div ref={paneRef} className="jc-pane sc-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"}
      style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <header className="jc-bar" aria-label={t("Security Copilot command bar")} data-layout={layout}>
        <div className="jc-bar-row primary">
          <AgentChip kind={SECURITY_COPILOT_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()} />
          <div className={`jc-run-pill state-${paused || run?.status === "PAUSED" || run?.status === "STOPPED" ? "paused" : counts && counts.P0 + counts.P1 ? "running" : "idle"}`} role="status" aria-live="polite">
            <span className="jc-run-label">{runLabel}</span>
            {needsYou ? <span className="jc-run-needs" title={t("Held changes and questions waiting for you")}>{t(needsYou === 1 ? "{count} needs you" : "{count} need you", { count: needsYou })}</span> : null}
          </div>
          {settings ? <span className="jc-pill sc-autonomy" title={t("Setup → Autonomy")}>{settings.autonomy === "FULL" ? t("Fully autonomous") : t("Assist")}</span> : null}
        </div>
        <div className="jc-bar-row secondary">
          <div className="jc-run-controls" role="group" aria-label={t("Run controls")}>
            {run?.status === "RUNNING" ? (
              <button type="button" className="jc-button" disabled={runBusy} onClick={() => void runAction("pause")} title={t("Pause: no new work until it starts again")}><Pause aria-hidden="true" /> {t("Pause")}</button>
            ) : (
              <button type="button" className="jc-button primary" disabled={runBusy || !state || paused} onClick={() => void runAction("start")}
                title={paused ? t("Turn Paused off to start") : run?.status === "PAUSED" ? t("Resume the run") : t("Start: the agent works through open findings, briefs and hosts due")}>
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
              <button type="button" className={`jc-icon-button${railOpen ? " selected" : ""}`} aria-pressed={railOpen} aria-label={railOpen ? t("Collapse the Security Copilot rail") : t("Expand the Security Copilot rail")} title={railOpen ? t("Collapse rail") : t("Expand rail")} onClick={toggleRail}>
                <PanelRight aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </header>
      <CopilotNotice text={notice || data.error} loaded={Boolean(data.state)} />
      <div className="jc-body">
        <section className="jc-main sc-main" aria-label={t("Findings")} data-active={findingsShown ? "true" : "false"} aria-hidden={findingsShown ? undefined : "true"}>
          <FindingsView paneId={pane.id} state={state} onChanged={() => void data.refresh()} />
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label={t("Resize the Security Copilot rail")} aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail firstRead={{ text: notice || data.error, loaded: Boolean(data.state) }} tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "activity" ? <ActivityTab paneId={pane.id} events={state?.events ?? []} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "hosts" ? <HostsTab hosts={state?.hosts ?? []} summary={state?.summary ?? null} /> : null}
          {railOpen && activeTab === "memory" ? <MemoryTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "setup" && state ? (
            <SetupTab pane={pane} settings={state.metadata} hosts={state.hosts} runtimeOptions={runtimeOptions} switching={agent.switching} accountRevision={agent.accountRevision}
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
