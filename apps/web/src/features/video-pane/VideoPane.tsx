import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Pane, VideoRequest } from "@space/contracts";
import { api } from "../../api.js";
import { AgentChip } from "../copilot-kit/AgentChip.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { VIDEO_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { SpaceToggle } from "../ui-controls/SpaceToggle.js";
import { ClipboardList, Film, Images, Music2, PanelRight, Settings, Terminal } from "../ui-theme/app-icons.js";
import { LibraryTab } from "./LibraryTab.js";
import { MusicTab } from "./MusicTab.js";
import { RequestsTab, VIDEO_OPEN_STATUSES } from "./RequestsTab.js";
import { SetupTab } from "./SetupTab.js";
import { StudioView } from "./StudioView.js";
import { useVideoData } from "./useVideo.js";
import "../copilot-kit/copilot-pane.css";
import "./video-pane.css";

export interface VideoPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's editor terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
}

export type VideoRailTab = "studio" | "requests" | "library" | "music" | "setup" | "terminal";
const RAIL_TABS: readonly VideoRailTab[] = ["requests", "library", "music", "setup", "terminal"];
const TAB_LABELS: Record<VideoRailTab, string> = { studio: "Studio", requests: "Requests", library: "Library", music: "Music", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { studio: Film, requests: ClipboardList, library: Images, music: Music2, setup: Settings, terminal: Terminal } as const;

/** The tabs a layout offers, in strip order: the Studio leads only when it is a tab of its own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): VideoRailTab[] {
  return layout === "stacked" ? ["studio", ...RAIL_TABS] : [...RAIL_TABS];
}
export function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): VideoRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as VideoRailTab) ? (tab as VideoRailTab) : "requests";
}

/**
 * The Video pane: the Studio, a command bar (editor, queue, pause) and a collapsible, resizable rail with Requests, Library, Music,
 * Setup and the editor's terminal. The terminal element stays mounted whichever tab is active; PaneCard renders it with its usual
 * props. Narrow panes stack: one surface at a time, the Studio as a tab, the tab strip at the bottom.
 */
export function VideoPane({ pane, isVisible, terminal }: VideoPaneProps) {
  const data = useVideoData(pane, isVisible);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<VideoRailTab>>(() => readRailPreference(`space:video:rail:${pane.id}`, ["studio", ...RAIL_TABS], "requests"));
  const [notice, setNotice] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<VideoRequest | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, VIDEO_KIND), [data.runtimes]);
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const agent = useCopilotAgent({ kind: VIDEO_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });
  const open = useMemo(() => data.requests.filter((request) => VIDEO_OPEN_STATUSES.includes(request.status)), [data.requests]);
  const needsYou = useMemo(() => open.filter((request) => request.status === "NEEDS_APPROVAL" || (request.question && !request.answer)).length, [open]);
  const paused = data.settings?.settings.paused ?? false;
  // The open request follows the list, so its status and question stay current.
  const shownRequest = useMemo(() => openRequest ? data.requests.find((request) => request.id === openRequest.id) ?? openRequest : null, [data.requests, openRequest]);

  useEffect(() => { writeRailPreference(`space:video:rail:${pane.id}`, rail); }, [pane.id, rail]);
  // A notification click opens the request it points at.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; target?: string }>).detail;
      if (detail?.paneId === pane.id && /^request:/.test(detail.target ?? "")) setRail((current) => ({ ...current, collapsed: false, tab: "requests" }));
    };
    window.addEventListener("space:notification-open", onOpen);
    return () => window.removeEventListener("space:notification-open", onOpen);
  }, [pane.id]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!data.settings) return;
    const next = { ...data.settings, settings: { ...data.settings.settings, paused: checked } };
    data.setSettings(next);
    try { data.setSettings((await api.updateVideoSettings(pane.id, next)).metadata); } catch { void data.refresh(); }
  }, [data, pane.id]);
  const openInStudio = useCallback((request: VideoRequest | null) => {
    setOpenRequest(request);
    if (request && layout === "stacked") setRail((current) => ({ ...current, tab: "studio" }));
  }, [layout]);
  const selectTab = useCallback((tab: VideoRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const tabs: CopilotRailTabDefinition<VideoRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id], badge: id === "requests" ? open.length || null : null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  const railOpen = layout === "stacked" || !rail.collapsed;
  const studioShown = layout === "split" || activeTab === "studio" || rail.collapsed;

  return (
    <div ref={paneRef} className="jc-pane vd-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"} data-studio={studioShown ? "visible" : "hidden"}
      style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <header className="jc-bar" aria-label="Video command bar" data-layout={layout}>
        <div className="jc-bar-row primary">
          <AgentChip kind={VIDEO_KIND} pane={pane} runtimeOptions={runtimeOptions} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()} />
          <div className={`jc-run-pill state-${paused ? "paused" : open.length ? "running" : "idle"}`} role="status" aria-live="polite">
            <span className="jc-run-label">{paused ? "Paused" : open.length ? `${open.length} request${open.length === 1 ? "" : "s"}` : "No requests"} · {data.settings?.settings.requestAutonomy === "APPROVAL" ? "Needs my approval" : "Delivers automatically"}</span>
            {needsYou ? <span className="jc-run-needs" title="Approvals or questions waiting for you">{needsYou} need{needsYou === 1 ? "s" : ""} you</span> : null}
          </div>
        </div>
        <div className="jc-bar-row secondary">
          <div className="jc-bar-toggles">
            <SpaceToggle compact className="jc-toggle" label="Paused" checked={paused} onChange={(checked) => void togglePaused(checked)} />
            {layout === "split" ? (
              <button type="button" className={`jc-icon-button${railOpen ? " selected" : ""}`} aria-pressed={railOpen} aria-label={railOpen ? "Collapse the video rail" : "Expand the video rail"} title={railOpen ? "Collapse rail" : "Expand rail"} onClick={toggleRail}>
                <PanelRight aria-hidden="true" />
              </button>
            ) : null}
          </div>
        </div>
      </header>
      {notice || data.error ? <div className="jc-notice" role="status">{notice ?? data.error}</div> : null}
      <div className="jc-body">
        <section className="jc-main vd-main" aria-label="Studio" data-active={studioShown ? "true" : "false"} aria-hidden={studioShown ? undefined : "true"}>
          {data.settings ? <StudioView pane={pane} settings={data.settings.settings} assets={data.assets} requests={data.requests} media={data.media} request={shownRequest}
            onChanged={() => void data.refresh()} onSelectRequest={openInStudio} onFindMusic={() => selectTab("music")} /> : <p className="jc-muted jc-panel-loading" role="status">Loading the Studio…</p>}
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label="Resize the video rail" aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "requests" ? <RequestsTab paneId={pane.id} requests={data.requests} onOpen={openInStudio} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "library" ? <LibraryTab paneId={pane.id} assets={data.assets} onChanged={() => void data.refresh()} /> : null}
          {railOpen && activeTab === "music" ? <MusicTab paneId={pane.id} assets={data.assets} onChanged={() => void data.refresh()} /> : null}
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
