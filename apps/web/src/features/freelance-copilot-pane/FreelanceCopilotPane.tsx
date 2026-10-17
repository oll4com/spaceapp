import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { FREELANCE_CHANNELS, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { HandoffOverlay, HeldBrowserStrip } from "../copilot-kit/HandoffOverlay.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { FREELANCE_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { Activity, Boxes, Brain, Globe, Settings, Terminal, Users } from "../ui-theme/app-icons.js";
import { ActivityTab } from "./ActivityTab.js";
import { FreelanceCommandBar } from "./CommandBar.js";
import { LeadsTab } from "./LeadsTab.js";
import { MemoryTab } from "./MemoryTab.js";
import { PlatformsTab } from "./PlatformsTab.js";
import { SetupTab } from "./SetupTab.js";
import { useFreelanceCopilotData } from "./useFreelanceCopilot.js";
import { useBrowserControlHeld, useLiveHandoff } from "../copilot-kit/live-handoff.js";
import "../copilot-kit/copilot-pane.css";
import "../marketing-copilot-pane/marketing-copilot-pane.css";
import "./freelance-copilot-pane.css";

export interface FreelanceCopilotPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's CLI agent terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
  /** The pane's managed browser (the platform accounts), rendered by PaneCard with its usual props. */
  browser: ReactNode;
}

export type FreelanceRailTab = "browser" | "leads" | "platforms" | "activity" | "memory" | "setup" | "terminal";
const RAIL_TABS: readonly FreelanceRailTab[] = ["leads", "platforms", "activity", "memory", "setup", "terminal"];
const TAB_LABELS: Record<FreelanceRailTab, string> = { browser: "Browser", leads: "Leads", platforms: "Platforms", activity: "Activity", memory: "Memory", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { browser: Globe, leads: Users, platforms: Boxes, activity: Activity, memory: Brain, setup: Settings, terminal: Terminal } as const;

function railStorageKey(paneId: string): string {
  return `space:freelance-copilot:rail:${paneId}`;
}

/** The tabs a layout offers, in strip order: the browser leads only when it is a tab of its own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): FreelanceRailTab[] {
  return layout === "stacked" ? ["browser", ...RAIL_TABS] : [...RAIL_TABS];
}

export function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): FreelanceRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as FreelanceRailTab) ? (tab as FreelanceRailTab) : "leads";
}

/**
 * Freelance Copilot: the live browser where the copilot registers, finds work and talks to clients on the platform
 * accounts, a command bar (agent, autonomy, platforms) and a collapsible, resizable rail with Leads, Platforms, Setup and the agent terminal. The
 * terminal element stays mounted whichever tab is active; PaneCard renders it with its usual props. Narrow
 * panes (phones) stack: one surface at a time, the browser as a tab, the tab strip at the bottom.
 */
export function FreelanceCopilotPane({ pane, isVisible, terminal, browser }: FreelanceCopilotPaneProps) {
  const data = useFreelanceCopilotData(pane, isVisible);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<FreelanceRailTab>>(() => readRailPreference(railStorageKey(pane.id), ["browser", ...RAIL_TABS], "leads"));
  const [runBusy, setRunBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, FREELANCE_COPILOT_KIND), [data.runtimes]);
  const settings = data.settings?.settings ?? null;
  const channels = useMemo(() => ({ enabled: settings ? FREELANCE_CHANNELS.filter((id) => settings.channels[id].enabled).length : 0, total: FREELANCE_CHANNELS.length }), [settings]);
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const agent = useCopilotAgent({ kind: FREELANCE_COPILOT_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });
  const pending = useMemo(() => data.run?.pending ?? [], [data.run]);
  const handoff = useLiveHandoff(data.handoff);
  const controlHeld = useBrowserControlHeld(pane.id);
  const sendingOn = useMemo(() => data.events.find((event) => event.type === "SENDING") ?? null, [data.events]);
  // A new handoff request brings the browser forward on phones (it is always visible in the split layout).
  const lastHandoffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || handoff.status !== "REQUESTED" || lastHandoffRef.current === handoff.handoffRequestId) return;
    lastHandoffRef.current = handoff.handoffRequestId;
    if (layout === "stacked") setRail((current) => current.tab === "browser" ? current : { ...current, tab: "browser" });
  }, [handoff, layout]);
  // A notification click opens what it is about: a lead in Leads, anything else in Activity.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; target?: string }>).detail;
      if (detail?.paneId !== pane.id) return;
      const tab = detail.target?.startsWith("lead:") ? "leads" : "activity";
      setRail((current) => ({ ...current, collapsed: false, tab }));
    };
    window.addEventListener("space:notification-open", onOpen);
    return () => window.removeEventListener("space:notification-open", onOpen);
  }, [pane.id]);
  const takeControl = useCallback(() => dispatchBrowserPaneActionEvent({ paneId: pane.id, action: "handoff", roomId: pane.roomId }), [pane.id, pane.roomId]);
  const returnToAgent = useCallback(() => {
    dispatchBrowserPaneActionEvent({ paneId: pane.id, action: "release", roomId: pane.roomId });
    void data.refresh();
  }, [data, pane.id, pane.roomId]);
  const inLeads = pending.filter((item) => item.kind === "REVIEW" || item.kind === "CLIENT_READY").length;
  const runAction = useCallback(async (action: "start" | "pause" | "stop") => {
    if (runBusy) return;
    setRunBusy(true);
    setNotice(null);
    try {
      data.setRun(await api.freelanceCopilotRunAction(pane.id, action));
      void data.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be changed.");
    } finally {
      setRunBusy(false);
    }
  }, [data, pane.id, runBusy]);
  // A ready client, review, question or proposal opens the tab it lives in; the first load does not.
  const lastPendingRef = useRef<string | null>(null);
  useEffect(() => {
    const newest = pending[0];
    if (!newest || lastPendingRef.current === newest.id) return;
    const first = lastPendingRef.current === null;
    lastPendingRef.current = newest.id;
    if (first) return;
    const tab = newest.kind === "REVIEW" || newest.kind === "CLIENT_READY" ? "leads" : "activity";
    setRail((current) => current.collapsed || current.tab !== tab ? { ...current, collapsed: false, tab } : current);
  }, [pending]);

  useEffect(() => { writeRailPreference(railStorageKey(pane.id), rail); }, [pane.id, rail]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!data.settings) return;
    const next = { ...data.settings, settings: { ...data.settings.settings, paused: checked } };
    data.setSettings(next);
    try {
      data.setSettings((await api.updateFreelanceCopilotSettings(pane.id, next)).metadata);
    } catch {
      void data.refresh();
    }
  }, [data, pane.id]);

  const selectTab = useCallback((tab: FreelanceRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const badges: Partial<Record<FreelanceRailTab, number | null>> = { browser: handoff ? 1 : null, leads: inLeads || null, activity: pending.length - inLeads || null };
  const tabs: CopilotRailTabDefinition<FreelanceRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id], badge: badges[id] ?? null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  // The stacked layout has no collapsed rail: the strip is the pane's navigation.
  const railOpen = layout === "stacked" || !rail.collapsed;
  const browserShown = layout === "split" || activeTab === "browser" || rail.collapsed;

  return (
    <div ref={paneRef} className="jc-pane mk-pane fl-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"} data-browser={browserShown ? "visible" : "hidden"}
      data-handoff={handoff ? handoff.status.toLowerCase() : undefined} style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <FreelanceCommandBar pane={pane} runtimeOptions={runtimeOptions} autonomy={settings?.autonomy ?? "ASSIST"} channels={channels} paused={settings?.paused ?? false}
        runState={data.run?.status ?? "IDLE"} counters={data.run?.run?.counters ?? null} needsYou={pending.length} backlog={data.run?.backlog ?? 0} runBusy={runBusy} onRun={(action) => void runAction(action)}
        railOpen={railOpen} layout={layout} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()}
        onTogglePaused={(checked) => void togglePaused(checked)} onToggleRail={toggleRail} />
      {notice || data.error ? <div className="jc-notice" role="status">{notice ?? data.error}</div> : null}
      <div className="jc-body">
        <section className="jc-browser" aria-label="Live browser" data-active={browserShown ? "true" : "false"} aria-hidden={browserShown ? undefined : "true"}>
          {browser}
          {handoff ? <HandoffOverlay handoff={handoff} detail={sendingOn ? sendingOn.message : null}
            onTakeControl={takeControl} onReturnToAgent={returnToAgent} />
            : controlHeld ? <HeldBrowserStrip onReturnToAgent={returnToAgent} /> : null}
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label="Resize the copilot rail" aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "leads" ? <LeadsTab paneId={pane.id} leads={data.leads} pending={pending} funnel={data.funnel} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "platforms" ? <PlatformsTab paneId={pane.id} leads={data.leads} funnel={data.funnel} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "activity" ? <ActivityTab paneId={pane.id} events={data.events} pending={pending} onChanged={() => void data.refresh()} onOpenLeads={() => selectTab("leads")} onOpenSetup={() => selectTab("setup")} /> : null}
          {railOpen && activeTab === "memory" ? <MemoryTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "setup" && data.settings ? (
            <SetupTab pane={pane} settings={data.settings} onOpenBrowser={() => { if (layout === "stacked") selectTab("browser"); }} runtimeOptions={runtimeOptions} switching={agent.switching} accountRevision={agent.accountRevision}
              onSettingsChange={data.setSettings} onSwitchAgent={(runtimeId, accountProfileId) => void agent.switchAgent(runtimeId, accountProfileId)} onSetDefault={() => void agent.setAsDefault()} />
          ) : null}
          {railOpen && activeTab === "setup" && !data.settings ? <p className="jc-muted jc-panel-loading" role="status">{data.loading ? "Loading setup…" : "Setup is unavailable."}</p> : null}
          <div key={agent.terminalKey} className="jc-panel-terminal" role="tabpanel" id="jc-panel-terminal" aria-labelledby="jc-tab-terminal" data-active={railOpen && activeTab === "terminal" ? "true" : "false"}>
            {terminal}
          </div>
        </CopilotRail>
      </div>
    </div>
  );
}
