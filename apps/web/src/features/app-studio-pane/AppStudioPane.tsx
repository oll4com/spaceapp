import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { APP_STUDIO_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { Activity, PanelRight, Settings, TabletSmartphone, Terminal } from "../ui-theme/app-icons.js";
import { ActivityTab } from "./ActivityTab.js";
import { PreviewView } from "./PreviewView.js";
import { SetupTab } from "./SetupTab.js";
import { useAppStudioData } from "./useAppStudio.js";
import "../copilot-kit/copilot-pane.css";
import "./app-studio-pane.css";

export interface AppStudioPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's app builder terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
}

export type AppStudioRailTab = "preview" | "activity" | "setup" | "terminal";
const RAIL_TABS: readonly AppStudioRailTab[] = ["activity", "setup", "terminal"];
const TAB_LABELS: Record<AppStudioRailTab, string> = { preview: "Preview", activity: "Activity", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { preview: TabletSmartphone, activity: Activity, setup: Settings, terminal: Terminal } as const;

/** The tabs a layout offers, in strip order: the preview leads only when it is a tab of its own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): AppStudioRailTab[] {
  return layout === "stacked" ? ["preview", ...RAIL_TABS] : [...RAIL_TABS];
}
export function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): AppStudioRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as AppStudioRailTab) ? (tab as AppStudioRailTab) : "activity";
}

/**
 * The App Studio pane: the app on Android and iPhone frames, a command bar (app builder, run, pause) and a collapsible,
 * resizable rail with Activity (briefs, questions, timeline), Setup and the app builder's terminal. The terminal element stays
 * mounted whichever tab is active; PaneCard renders it with its usual props. Narrow panes stack: one surface at a time.
 */
export function AppStudioPane({ pane, isVisible, terminal }: AppStudioPaneProps) {
  const data = useAppStudioData(pane, isVisible);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<AppStudioRailTab>>(() => readRailPreference(`space:app-studio:rail:${pane.id}`, ["preview", ...RAIL_TABS], "activity"));
  const [notice, setNotice] = useState<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, APP_STUDIO_KIND), [data.runtimes]);
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const agent = useCopilotAgent({ kind: APP_STUDIO_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });
  const paused = data.settings?.settings.paused ?? false;
  const run = data.run;

  useEffect(() => { writeRailPreference(`space:app-studio:rail:${pane.id}`, rail); }, [pane.id, rail]);
  // A notification click (a question, a finished brief) opens Activity.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; target?: string }>).detail;
      if (detail?.paneId === pane.id && /^(question|brief):/.test(detail.target ?? "")) setRail((current) => ({ ...current, collapsed: false, tab: "activity" }));
    };
    window.addEventListener("space:notification-open", onOpen);
    return () => window.removeEventListener("space:notification-open", onOpen);
  }, [pane.id]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!data.settings) return;
    const next = { ...data.settings, settings: { ...data.settings.settings, paused: checked } };
    data.setSettings(next);
    try { data.setSettings((await api.updateAppStudioSettings(pane.id, next)).metadata); } catch { void data.refresh(); }
  }, [data, pane.id]);

  const selectTab = useCallback((tab: AppStudioRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const tabs: CopilotRailTabDefinition<AppStudioRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id],
    badge: id === "activity" ? run?.openQuestions || null : null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  const railOpen = layout === "stacked" || !rail.collapsed;
  const previewShown = layout === "split" || activeTab === "preview" || rail.collapsed;
  const runLabel = paused ? "Paused" : run?.status === "PAUSED" ? "Run paused" : run?.status === "STOPPED" ? "Run stopped"
    : run?.pendingBriefs ? `${run.pendingBriefs} brief${run.pendingBriefs === 1 ? "" : "s"}` : "No briefs";

  return (
    <div ref={paneRef} className="jc-pane as-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"}
      style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <header className="jc-bar" aria-label="App Studio command bar" data-layout={layout}>
        <div className="jc-bar-row primary">
          <AgentChip kind={APP_STUDIO_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()} />
          <div className={`jc-run-pill state-${paused || run?.status === "PAUSED" || run?.status === "STOPPED" ? "paused" : run?.pendingBriefs ? "running" : "idle"}`} role="status" aria-live="polite">
            <span className="jc-run-label">{runLabel}</span>
            {run?.openQuestions ? <span className="jc-run-needs" title="Questions waiting for you">{run.openQuestions} need{run.openQuestions === 1 ? "s" : ""} you</span> : null}
          </div>
        </div>
        <div className="jc-bar-row secondary">
          <div className="jc-bar-toggles">
            <SpaceToggle compact className="jc-toggle" label="Paused" checked={paused} onChange={(checked) => void togglePaused(checked)} />
            {layout === "split" ? (
              <button type="button" className={`jc-icon-button${railOpen ? " selected" : ""}`} aria-pressed={railOpen} aria-label={railOpen ? "Collapse the App Studio rail" : "Expand the App Studio rail"} title={railOpen ? "Collapse rail" : "Expand rail"} onClick={toggleRail}>
                <PanelRight aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </header>
      {notice || data.error ? <div className="jc-notice" role="status">{notice ?? data.error}</div> : null}
      <div className="jc-body">
        <section className="jc-main as-main" aria-label="Preview" data-active={previewShown ? "true" : "false"} aria-hidden={previewShown ? undefined : "true"}>
          <PreviewView previews={data.previews} />
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label="Resize the App Studio rail" aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "activity" ? <ActivityTab paneId={pane.id} events={data.events} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "setup" && data.settings ? (
            <SetupTab pane={pane} settings={data.settings} runtimeOptions={runtimeOptions} switching={agent.switching} accountRevision={agent.accountRevision}
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
