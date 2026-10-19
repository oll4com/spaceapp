import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { isImportedJobApplication, type Pane } from "@space/contracts";
import { api } from "../../api.js";
import { dispatchBrowserPaneActionEvent } from "../browser-pane/events.js";
import { ActivityTab } from "./ActivityTab.js";
import { loadDefaultAccountProfileId } from "./AgentAccountField.js";
import { jobCopilotAccountFor, jobCopilotAgentLabel, jobCopilotRuntimeOptions, loadPaneAccountProfileId, saveJobCopilotLaunch } from "./agent-runtimes.js";
import { CommandBar } from "./CommandBar.js";
import { CopilotRail, RAIL_TAB_ICONS, type CopilotRailTab, type CopilotRailTabDefinition } from "./CopilotRail.js";
import { FieldsTab } from "./FieldsTab.js";
import { HandoffOverlay } from "./HandoffOverlay.js";
import { HeldBrowserStrip } from "../copilot-kit/HandoffOverlay.js";
import { browserVisible, resolveActiveTab, tabsForLayout } from "./layout.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { MemoryTab } from "./MemoryTab.js";
import { QueueTab } from "./QueueTab.js";
import { SetupWizard } from "./SetupWizard.js";
import { StartOver } from "./StartOver.js";
import { handoffPostingFor, runProgress, todayCounts, useJobApplyData } from "./useJobApply.js";
import { useBrowserControlHeld, useLiveHandoff } from "../copilot-kit/live-handoff.js";
import "./job-copilot-pane.css";

export interface JobCopilotPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's CLI agent terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
  /** The pane's managed browser, rendered by PaneCard with its usual props. */
  browser: ReactNode;
}

const RAIL_MIN_WIDTH = 300;
const RAIL_MAX_WIDTH = 720;
const RAIL_DEFAULT_WIDTH = 520;

interface RailPreference { width: number; collapsed: boolean; tab: CopilotRailTab }

function railStorageKey(paneId: string): string {
  return `space:job-copilot:rail:${paneId}`;
}

function readRailPreference(paneId: string): RailPreference {
  try {
    const raw = window.localStorage.getItem(railStorageKey(paneId));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<RailPreference>;
      return {
        width: typeof parsed.width === "number" ? Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, parsed.width)) : RAIL_DEFAULT_WIDTH,
        collapsed: parsed.collapsed === true,
        tab: parsed.tab && parsed.tab in RAIL_TAB_ICONS ? parsed.tab : "activity"
      };
    }
  } catch {
    // Preference storage is optional.
  }
  return { width: RAIL_DEFAULT_WIDTH, collapsed: false, tab: "activity" };
}

function writeRailPreference(paneId: string, preference: RailPreference): void {
  try {
    window.localStorage.setItem(railStorageKey(paneId), JSON.stringify(preference));
  } catch {
    // Preference storage is optional.
  }
}

const TAB_LABELS: Record<CopilotRailTab, string> = { browser: "Browser", activity: "Activity", queue: "Queue", fields: "Fields", memory: "Memory", setup: "Setup", terminal: "Terminal" };

/**
 * Job Copilot: full-bleed live browser, a command bar (agent, run state, counters) and a
 * collapsible, resizable rail with Queue, Setup and the agent terminal. The terminal element
 * stays mounted whichever tab is active; PaneCard renders it with its usual props. Narrow panes
 * (phones) stack: one surface at a time, the browser as a tab, the tab strip at the bottom.
 */
export function JobCopilotPane({ pane, isVisible, terminal, browser }: JobCopilotPaneProps) {
  const data = useJobApplyData(pane, isVisible);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference>(() => readRailPreference(pane.id));
  const [selectedApplicationId, setSelectedApplicationId] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [terminalKey, setTerminalKey] = useState(0);
  // A pane opened on the saved default says so once, for a few seconds.
  const [notice, setNotice] = useState<string | null>(null);
  const lastHandoffRef = useRef<string | null>(null);
  const mountedAtRef = useRef(Date.now());
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const counts = useMemo(() => todayCounts(data.applications, data.run?.queue), [data.applications, data.run?.queue]);
  const runtimeOptions = useMemo(() => jobCopilotRuntimeOptions(data.runtimes), [data.runtimes]);
  const handoff = useLiveHandoff(data.handoff);
  const controlHeld = useBrowserControlHeld(pane.id);
  const paused = data.settings?.settings.paused ?? false;
  const handoffPosting = useMemo(() => (handoff ? handoffPostingFor(handoff.reason, data.applications, data.run?.current) : null), [handoff, data.applications, data.run]);
  const runState = data.run?.status ?? "IDLE";
  const progress = useMemo(() => runProgress(data.run), [data.run]);
  const pending = data.run?.pending ?? [];
  const selectedApplication = useMemo(() => data.applications.find((application) => application.id === selectedApplicationId) ?? null, [data.applications, selectedApplicationId]);
  // Without a pick the Fields tab follows the work: the current posting, the one waiting for the operator,
  // then the latest one Space worked (the tracker lists the most recently updated first; imported history has no fields).
  const fieldsApplication = useMemo(() => selectedApplication ?? data.run?.current
    ?? data.applications.find((application) => application.id === pending[0]?.applicationId)
    ?? data.applications.find((application) => application.status !== "QUEUED" && !isImportedJobApplication(application)) ?? null, [data.applications, data.run, pending, selectedApplication]);
  const lastPendingRef = useRef<string | null>(null);

  // A new question or review opens the Activity tab; the notification itself comes through Space notifications.
  useEffect(() => {
    const newest = pending[0];
    if (!newest || lastPendingRef.current === newest.id) return;
    const first = lastPendingRef.current === null;
    lastPendingRef.current = newest.id;
    if (first && Date.now() - mountedAtRef.current < 10_000) return;
    setRail((current) => current.collapsed || current.tab === "activity" ? { ...current, collapsed: false, tab: "activity" } : current);
  }, [pending]);

  useEffect(() => { writeRailPreference(pane.id, rail); }, [pane.id, rail]);

  useEffect(() => {
    if (!handoff || handoff.status !== "REQUESTED" || lastHandoffRef.current === handoff.handoffRequestId) return;
    lastHandoffRef.current = handoff.handoffRequestId;
    if (layout === "stacked") setRail((current) => current.tab === "browser" ? current : { ...current, tab: "browser" });
  }, [handoff, layout]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!data.settings) return;
    const next = { ...data.settings, settings: { ...data.settings.settings, paused: checked } };
    data.setSettings(next);
    try {
      const response = await api.updateJobApplySettings(pane.id, next);
      data.setSettings(response.metadata);
    } catch {
      void data.refresh();
    }
  }, [data, pane.id]);

  /**
   * Switch the pane's agent (CLI, account or both): PATCH the runtime, restart the CLI on that account (the API keeps
   * it as the pane's agent), then remount the terminal element so it attaches to the new session. Without an account
   * the CLI starts on the user's default account for it, else on that CLI's default pane account.
   */
  const switchAgent = useCallback(async (runtimeId: string, accountProfileId?: string) => {
    const sameRuntime = runtimeId === pane.terminalRuntimeId;
    if (switching || (sameRuntime && accountProfileId === undefined)) return;
    if (sameRuntime && accountProfileId === await loadPaneAccountProfileId(pane.id, runtimeId)) return;
    setSwitching(true);
    setNotice(null);
    try {
      const remembered = accountProfileId === undefined ? (await api.userSettings().catch(() => null))?.jobCopilot : null;
      const account = jobCopilotAccountFor(runtimeId, accountProfileId
        ?? (remembered?.runtimeId === runtimeId && remembered.accountProfileId ? remembered.accountProfileId : await loadDefaultAccountProfileId(runtimeId)));
      if (!sameRuntime) await api.updatePane(pane.id, { terminalRuntimeId: runtimeId });
      await api.createCliSession(pane.id, { runtimeId, forceRestart: true, includeTranscript: false, ...(account ? { accountProfileId: account } : {}) });
      setTerminalKey((key) => key + 1);
      setRail((current) => ({ ...current, collapsed: false, tab: "terminal" }));
      void data.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The copilot agent could not be switched.");
    } finally {
      setSwitching(false);
    }
  }, [data, pane.id, pane.terminalRuntimeId, switching]);
  /** A fresh conversation on the same agent and account; the previous one stays in the task history. */
  const startNewSession = useCallback(async () => {
    const runtimeId = pane.terminalRuntimeId;
    if (!runtimeId || switching) return;
    setSwitching(true);
    setNotice(null);
    try {
      const account = jobCopilotAccountFor(runtimeId, await loadPaneAccountProfileId(pane.id, runtimeId));
      await api.createCliSession(pane.id, { runtimeId, forceRestart: true, includeTranscript: false, ...(account ? { accountProfileId: account } : {}) });
      setTerminalKey((key) => key + 1);
      setRail((current) => ({ ...current, collapsed: false, tab: "terminal" }));
      setNotice("Started a new session. The previous conversation stays in the task history.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "A new session could not be started.");
    } finally {
      setSwitching(false);
    }
  }, [pane.id, pane.terminalRuntimeId, switching]);
  const [accountRevision, setAccountRevision] = useState(0);
  // Setup → Agent reloads the pane's account after every switch.
  useEffect(() => { if (!switching) setAccountRevision((revision) => revision + 1); }, [switching]);

  /** New Job Copilot panes open with this pane's agent and account, without asking. */
  const setAsDefault = useCallback(async () => {
    const runtimeId = pane.terminalRuntimeId;
    if (!runtimeId) return;
    try {
      // The account the pane's CLI runs on now (the terminal's account menu may have changed it).
      const accountProfileId = await loadPaneAccountProfileId(pane.id, runtimeId);
      await saveJobCopilotLaunch({ runtimeId, accountProfileId, askOnLaunch: false });
      const option = runtimeOptions.find((entry) => entry.runtime.id === runtimeId);
      setNotice(`New Job Copilot panes open with ${jobCopilotAgentLabel(runtimeId, option?.runtime)}${accountProfileId ? ` (${accountProfileId} account)` : ""} from now on.`);
    } catch (error) {
      setNotice(error instanceof Error ? `The default agent could not be saved: ${error.message}` : "The default agent could not be saved.");
    }
  }, [pane.id, pane.terminalRuntimeId, runtimeOptions]);

  const runAction = useCallback(async (action: "start" | "pause" | "stop") => {
    if (runBusy) return;
    setRunBusy(true);
    setNotice(null);
    try {
      const view = action === "start" ? await api.startJobApplyRun(pane.id) : action === "pause" ? await api.pauseJobApplyRun(pane.id) : await api.stopJobApplyRun(pane.id);
      data.setRun(view);
      if (action === "start") setRail((current) => ({ ...current, collapsed: false, tab: layout === "stacked" ? "browser" : current.tab === "setup" ? "activity" : current.tab }));
      void data.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be changed.");
    } finally {
      setRunBusy(false);
    }
  }, [data, layout, pane.id, runBusy]);

  const takeControl = useCallback(() => {
    dispatchBrowserPaneActionEvent({ paneId: pane.id, action: "handoff", roomId: pane.roomId });
  }, [pane.id, pane.roomId]);
  const returnToAgent = useCallback(() => {
    dispatchBrowserPaneActionEvent({ paneId: pane.id, action: "release", roomId: pane.roomId });
    void data.refresh();
  }, [data, pane.id, pane.roomId]);

  const selectTab = useCallback((tab: CopilotRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const badges: Partial<Record<CopilotRailTab, number | null>> = { browser: handoff ? 1 : null, activity: pending.length || null, queue: counts.queued + counts.deferred || null };
  const tabs: CopilotRailTabDefinition[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: RAIL_TAB_ICONS[id], badge: badges[id] ?? null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  // The stacked layout has no collapsed rail: the strip is the pane's navigation.
  const railOpen = layout === "stacked" || !rail.collapsed;
  const browserShown = browserVisible(layout, activeTab, rail.collapsed);

  return (
    <div ref={paneRef} className="jc-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"} data-browser={browserShown ? "visible" : "hidden"}
      data-handoff={handoff ? handoff.status.toLowerCase() : undefined} style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <CommandBar pane={pane} runtimeOptions={runtimeOptions} counts={counts} stats={data.stats} runState={runState} progress={progress} paused={paused} layout={layout}
        railOpen={railOpen} switching={switching} needsYou={pending.length} runBusy={runBusy} onRun={(action) => void runAction(action)}
        onSwitchRuntime={(runtimeId) => void switchAgent(runtimeId)} onNewSession={() => void startNewSession()} onSetDefault={() => void setAsDefault()}
        onTogglePaused={(checked) => void togglePaused(checked)} onToggleRail={toggleRail} />
      {notice || data.error ? <div className="jc-notice" role="status">{notice ?? data.error}</div> : null}
      <div className="jc-body">
        <section className="jc-browser" aria-label="Live browser" data-active={browserShown ? "true" : "false"} aria-hidden={browserShown ? undefined : "true"}>
          {browser}
          {handoff ? <HandoffOverlay handoff={handoff} posting={handoffPosting} onTakeControl={takeControl} onReturnToAgent={returnToAgent} />
            : controlHeld ? <HeldBrowserStrip onReturnToAgent={returnToAgent} /> : null}
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label="Resize the copilot rail" aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "activity" ? (
            <ActivityTab events={data.events} pending={pending} applications={data.applications} stats={data.stats} selectedId={selectedApplicationId} onSelect={setSelectedApplicationId} onChanged={() => void data.refresh()} />
          ) : null}
          {railOpen && activeTab === "fields" ? <FieldsTab paneId={pane.id} application={fieldsApplication} /> : null}
          {railOpen && activeTab === "memory" ? <MemoryTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "queue" ? (
            <QueueTab applications={data.applications} campaignStartedAt={data.profile?.campaignStartedAt ?? null} paneId={pane.id} selectedId={selectedApplicationId} onSelect={setSelectedApplicationId}
              onCreated={(application) => data.setApplications((current) => [application, ...current.filter((entry) => entry.id !== application.id)])} onRefresh={() => void data.refresh()} />
          ) : null}
          {railOpen && activeTab === "setup" && data.profile && data.settings ? (
            <SetupWizard pane={pane} profile={data.profile} settings={data.settings} runtimeOptions={runtimeOptions}
              onProfileChange={data.setProfile} onSettingsChange={data.setSettings} switching={switching} accountRevision={accountRevision}
              onSwitchAgent={(runtimeId, accountProfileId) => void switchAgent(runtimeId, accountProfileId)} onSetDefault={() => void setAsDefault()}
              footer={<StartOver campaignStartedAt={data.profile.campaignStartedAt} stats={data.stats} applications={data.applications} onDone={() => void data.refresh()} />} />
          ) : null}
          {railOpen && activeTab === "setup" && (!data.profile || !data.settings) ? <p className="jc-muted jc-panel-loading" role="status">Loading setup…</p> : null}
          <div key={terminalKey} className="jc-panel-terminal" role="tabpanel" id="jc-panel-terminal" aria-labelledby="jc-tab-terminal" data-active={railOpen && activeTab === "terminal" ? "true" : "false"}>
            {terminal}
          </div>
        </CopilotRail>
      </div>
    </div>
  );
}
