import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MARKETING_CHANNEL_LABELS, MARKETING_CHANNELS, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { HandoffOverlay, HeldBrowserStrip } from "../copilot-kit/HandoffOverlay.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { MARKETING_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { Activity, Bookmark, Brain, FileText, Globe, Settings, Terminal, TrendingUp } from "../ui-theme/app-icons.js";
import { ActivityTab } from "./ActivityTab.js";
import { AnalyticsTab } from "./AnalyticsTab.js";
import { BookmarksTab } from "./BookmarksTab.js";
import { MarketingCommandBar } from "./CommandBar.js";
import { MemoryTab } from "./MemoryTab.js";
import { PostsTab } from "./PostsTab.js";
import { SetupTab } from "./SetupTab.js";
import { useMarketingCopilotData } from "./useMarketingCopilot.js";
import { useBrowserControlHeld, useLiveHandoff } from "../copilot-kit/live-handoff.js";
import "../copilot-kit/copilot-pane.css";
import "./marketing-copilot-pane.css";

export interface MarketingCopilotPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's CLI agent terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
  /** The pane's managed browser (the operator's own logged-in accounts), rendered by PaneCard with its usual props. */
  browser: ReactNode;
}

export type MarketingRailTab = "browser" | "posts" | "activity" | "analytics" | "memory" | "bookmarks" | "setup" | "terminal";
const RAIL_TABS: readonly MarketingRailTab[] = ["posts", "activity", "analytics", "memory", "bookmarks", "setup", "terminal"];
const TAB_LABELS: Record<MarketingRailTab, string> = { browser: "Browser", posts: "Posts", activity: "Activity", analytics: "Analytics", memory: "Memory", bookmarks: "Bookmarks", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { browser: Globe, posts: FileText, activity: Activity, analytics: TrendingUp, memory: Brain, bookmarks: Bookmark, setup: Settings, terminal: Terminal } as const;

function railStorageKey(paneId: string): string {
  return `space:marketing-copilot:rail:${paneId}`;
}

/** The tabs a layout offers, in strip order: the browser leads only when it is a tab of its own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): MarketingRailTab[] {
  return layout === "stacked" ? ["browser", ...RAIL_TABS] : [...RAIL_TABS];
}

export function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): MarketingRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as MarketingRailTab) ? (tab as MarketingRailTab) : "posts";
}

/**
 * Marketing Copilot: the live browser where the copilot publishes on the operator's own accounts, a command
 * bar (agent, autonomy, channels) and a collapsible, resizable rail with Setup and the agent terminal. The
 * terminal element stays mounted whichever tab is active; PaneCard renders it with its usual props. Narrow
 * panes (phones) stack: one surface at a time, the browser as a tab, the tab strip at the bottom.
 */
export function MarketingCopilotPane({ pane, isVisible, terminal, browser }: MarketingCopilotPaneProps) {
  const data = useMarketingCopilotData(pane, isVisible);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<MarketingRailTab>>(() => readRailPreference(railStorageKey(pane.id), ["browser", ...RAIL_TABS], "posts"));
  const [runBusy, setRunBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, MARKETING_COPILOT_KIND), [data.runtimes]);
  const settings = data.settings?.settings ?? null;
  const channels = useMemo(() => ({ enabled: settings ? MARKETING_CHANNELS.filter((id) => settings.channels[id].enabled).length : 0, total: MARKETING_CHANNELS.length }), [settings]);
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const agent = useCopilotAgent({ kind: MARKETING_COPILOT_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });
  const pending = useMemo(() => data.run?.pending ?? [], [data.run]);
  const handoff = useLiveHandoff(data.handoff);
  const controlHeld = useBrowserControlHeld(pane.id);
  const publishing = useMemo(() => data.posts.find((post) => post.status === "PUBLISHING") ?? null, [data.posts]);
  // A new handoff request brings the browser forward on phones (it is always visible in the split layout).
  const lastHandoffRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handoff || handoff.status !== "REQUESTED" || lastHandoffRef.current === handoff.handoffRequestId) return;
    lastHandoffRef.current = handoff.handoffRequestId;
    if (layout === "stacked") setRail((current) => current.tab === "browser" ? current : { ...current, tab: "browser" });
  }, [handoff, layout]);
  // A notification click opens what it is about: a post in Posts, anything else in Activity.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; target?: string }>).detail;
      if (detail?.paneId !== pane.id) return;
      const tab = detail.target?.startsWith("post:") ? "posts" : "activity";
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
  const reviews = pending.filter((item) => item.kind === "REVIEW").length;
  const runAction = useCallback(async (action: "start" | "pause" | "stop") => {
    if (runBusy) return;
    setRunBusy(true);
    setNotice(null);
    try {
      data.setRun(await api.marketingCopilotRunAction(pane.id, action));
      void data.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be changed.");
    } finally {
      setRunBusy(false);
    }
  }, [data, pane.id, runBusy]);
  // A new review, question or proposal opens the tab it lives in; the first load does not.
  const lastPendingRef = useRef<string | null>(null);
  useEffect(() => {
    const newest = pending[0];
    if (!newest || lastPendingRef.current === newest.id) return;
    const first = lastPendingRef.current === null;
    lastPendingRef.current = newest.id;
    if (first) return;
    const tab = newest.kind === "REVIEW" ? "posts" : "activity";
    setRail((current) => current.collapsed || current.tab !== tab ? { ...current, collapsed: false, tab } : current);
  }, [pending]);

  useEffect(() => { writeRailPreference(railStorageKey(pane.id), rail); }, [pane.id, rail]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!data.settings) return;
    const next = { ...data.settings, settings: { ...data.settings.settings, paused: checked } };
    data.setSettings(next);
    try {
      data.setSettings((await api.updateMarketingCopilotSettings(pane.id, next)).metadata);
    } catch {
      void data.refresh();
    }
  }, [data, pane.id]);

  const selectTab = useCallback((tab: MarketingRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const badges: Partial<Record<MarketingRailTab, number | null>> = { browser: handoff ? 1 : null, posts: reviews || null, activity: pending.length - reviews || null };
  const tabs: CopilotRailTabDefinition<MarketingRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id], badge: badges[id] ?? null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  // The stacked layout has no collapsed rail: the strip is the pane's navigation.
  const railOpen = layout === "stacked" || !rail.collapsed;
  const browserShown = layout === "split" || activeTab === "browser" || rail.collapsed;

  return (
    <div ref={paneRef} className="jc-pane mk-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"} data-browser={browserShown ? "visible" : "hidden"}
      data-handoff={handoff ? handoff.status.toLowerCase() : undefined} style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <MarketingCommandBar pane={pane} runtimeOptions={runtimeOptions} autonomy={settings?.autonomy ?? "ASSIST"} channels={channels} paused={settings?.paused ?? false}
        runState={data.run?.status ?? "IDLE"} counters={data.run?.run?.counters ?? null} needsYou={pending.length} backlog={data.run?.backlog ?? 0} runBusy={runBusy} onRun={(action) => void runAction(action)}
        railOpen={railOpen} layout={layout} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()}
        onTogglePaused={(checked) => void togglePaused(checked)} onToggleRail={toggleRail} />
      {notice || data.error ? <div className="jc-notice" role="status">{notice ?? data.error}</div> : null}
      <div className="jc-body">
        <section className="jc-browser" aria-label="Live browser" data-active={browserShown ? "true" : "false"} aria-hidden={browserShown ? undefined : "true"}>
          {browser}
          {handoff ? <HandoffOverlay handoff={handoff} detail={publishing ? `Publishing on ${MARKETING_CHANNEL_LABELS[publishing.channel]}${publishing.title ? `: ${publishing.title}` : ""}` : null}
            onTakeControl={takeControl} onReturnToAgent={returnToAgent} />
            : controlHeld ? <HeldBrowserStrip onReturnToAgent={returnToAgent} /> : null}
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label="Resize the copilot rail" aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "posts" ? <PostsTab paneId={pane.id} posts={data.posts} campaigns={data.campaigns} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "activity" ? <ActivityTab paneId={pane.id} events={data.events} pending={pending} onChanged={() => void data.refresh()} onOpenPosts={() => selectTab("posts")} /> : null}
          {railOpen && activeTab === "analytics" ? <AnalyticsTab /> : null}
          {railOpen && activeTab === "memory" ? <MemoryTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "bookmarks" ? <BookmarksTab paneId={pane.id} onOpened={() => { if (layout === "stacked") selectTab("browser"); }} /> : null}
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
