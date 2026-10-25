import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Pane } from "@space/contracts";
import { api } from "../../api.js";
import { CopilotRail, type CopilotRailTabDefinition } from "../copilot-kit/CopilotRail.js";
import { MAIL_COPILOT_KIND } from "../copilot-kit/copilot-kind.js";
import { useCopilotLayout } from "../copilot-kit/copilot-layout.js";
import { copilotRuntimeOptions } from "../copilot-kit/copilot-runtimes.js";
import { RAIL_DEFAULT_WIDTH, RAIL_MAX_WIDTH, RAIL_MIN_WIDTH, readRailPreference, writeRailPreference, type RailPreference } from "../copilot-kit/rail-preference.js";
import { useCopilotAgent } from "../copilot-kit/useCopilotAgent.js";
import { Activity, Brain, Mail, Settings, ShieldCheck, Terminal } from "../ui-theme/app-icons.js";
import { AccountsView, paneAccounts } from "./AccountsView.js";
import { ActivityTab } from "./ActivityTab.js";
import { MemoryTab } from "./MemoryTab.js";
import { RulesTab } from "./RulesTab.js";
import { MailCommandBar } from "./CommandBar.js";
import { MailClient } from "./MailClient.js";
import { useMailbox } from "./useMailbox.js";
import { SetupTab } from "./SetupTab.js";
import { useMailCopilotData } from "./useMailCopilot.js";
import "../copilot-kit/copilot-pane.css";
import "./mail-copilot-pane.css";

export interface MailCopilotPaneProps {
  pane: Pane;
  isVisible: boolean;
  /** The pane's CLI agent terminal, rendered by PaneCard with its usual props. */
  terminal: ReactNode;
}

export type MailRailTab = "mail" | "activity" | "memory" | "rules" | "setup" | "terminal";
const RAIL_TABS: readonly MailRailTab[] = ["activity", "memory", "rules", "setup", "terminal"];
const TAB_LABELS: Record<MailRailTab, string> = { mail: "Mail", activity: "Activity", memory: "Memory", rules: "Rules", setup: "Setup", terminal: "Terminal" };
const TAB_ICONS = { mail: Mail, activity: Activity, memory: Brain, rules: ShieldCheck, setup: Settings, terminal: Terminal } as const;

function railStorageKey(paneId: string): string {
  return `space:mail-copilot:rail:${paneId}`;
}

/** The tabs a layout offers, in strip order: the mailbox leads only when it is a tab of its own (stacked). */
export function tabsForLayout(layout: "split" | "stacked"): MailRailTab[] {
  return layout === "stacked" ? ["mail", ...RAIL_TABS] : [...RAIL_TABS];
}

export function resolveActiveTab(tab: string | null | undefined, layout: "split" | "stacked"): MailRailTab {
  const available = tabsForLayout(layout);
  return available.includes(tab as MailRailTab) ? (tab as MailRailTab) : "activity";
}

/**
 * Mail Copilot: the mailbox surface, a command bar (agent, autonomy, accounts) and a collapsible, resizable
 * rail with Setup and the agent terminal. The terminal element stays mounted whichever tab is active;
 * PaneCard renders it with its usual props. Narrow panes (phones) stack: one surface at a time, the
 * mailbox as a tab, the tab strip at the bottom.
 */
export function MailCopilotPane({ pane, isVisible, terminal }: MailCopilotPaneProps) {
  const data = useMailCopilotData(pane, isVisible);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const layout = useCopilotLayout(paneRef);
  const [rail, setRail] = useState<RailPreference<MailRailTab>>(() => readRailPreference(railStorageKey(pane.id), ["mail", ...RAIL_TABS], "activity"));
  const [runBusy, setRunBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const runtimeOptions = useMemo(() => copilotRuntimeOptions(data.runtimes, MAIL_COPILOT_KIND), [data.runtimes]);
  const paused = data.settings?.settings.paused ?? false;
  const autonomy = data.settings?.settings.autonomy ?? "ASSIST";
  const usedAccounts = useMemo(() => paneAccounts(data.settings, data.accounts), [data.accounts, data.settings]);
  // The mailbox opens once an account in the pane allows reading its Gmail; until then the pane shows the accounts.
  const mailboxReady = usedAccounts.some((account) => account.capabilities.includes("MAIL_READ"));
  const mailbox = useMailbox(pane.id, isVisible && mailboxReady, data.settings?.view ? { account: data.settings.view.account, labelId: data.settings.view.labelId } : {});
  const onSwitched = useCallback(() => { setRail((current) => ({ ...current, collapsed: false, tab: "terminal" })); void data.refresh(); }, [data]);
  const pending = useMemo(() => data.run?.pending ?? [], [data.run]);
  const runState = data.run?.status ?? "IDLE";
  const runAction = useCallback(async (action: "start" | "pause" | "stop") => {
    if (runBusy) return;
    setRunBusy(true);
    setNotice(null);
    try {
      const view = action === "start" ? await api.startMailCopilotRun(pane.id) : action === "pause" ? await api.pauseMailCopilotRun(pane.id) : await api.stopMailCopilotRun(pane.id);
      data.setRun(view);
      if (action === "start") setRail((current) => ({ ...current, collapsed: false, tab: current.tab === "setup" ? "activity" : current.tab }));
      void data.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The run could not be changed.");
    } finally {
      setRunBusy(false);
    }
  }, [data, pane.id, runBusy]);
  // A new review or question opens the Activity tab; a notification click opens the conversation it points at.
  const lastPendingRef = useRef<string | null>(null);
  useEffect(() => {
    const newest = pending[0];
    if (!newest || lastPendingRef.current === newest.id) return;
    const first = lastPendingRef.current === null;
    lastPendingRef.current = newest.id;
    if (first) return;
    setRail((current) => current.collapsed || current.tab !== "activity" ? { ...current, collapsed: false, tab: "activity" } : current);
  }, [pending]);
  const openThread = useCallback((account: string, threadId: string) => {
    mailbox.setSelection({ account, labelId: "ALL", query: "" });
    void mailbox.openThread({ account, threadId });
    if (layout === "stacked") setRail((current) => ({ ...current, tab: "mail" }));
  }, [layout, mailbox]);
  const showOnlyThread = useCallback((account: string, threadId: string) => {
    void mailbox.showOnlyThread({ account, threadId });
    if (layout === "stacked") setRail((current) => ({ ...current, tab: "mail" }));
  }, [layout, mailbox]);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<{ paneId?: string; target?: string }>).detail;
      const match = detail?.paneId === pane.id ? /^thread:([^:]+):(.+)$/.exec(detail.target ?? "") : null;
      if (match) openThread(match[1]!, match[2]!);
    };
    window.addEventListener("space:notification-open", onOpen);
    return () => window.removeEventListener("space:notification-open", onOpen);
  }, [openThread, pane.id]);
  const agent = useCopilotAgent({ kind: MAIL_COPILOT_KIND, pane, runtimeOptions, onSwitched, onNotice: setNotice });

  useEffect(() => { writeRailPreference(railStorageKey(pane.id), rail); }, [pane.id, rail]);

  const togglePaused = useCallback(async (checked: boolean) => {
    if (!data.settings) return;
    const next = { ...data.settings, settings: { ...data.settings.settings, paused: checked } };
    data.setSettings(next);
    try {
      const response = await api.updateMailCopilotSettings(pane.id, next);
      data.setSettings(response.metadata);
    } catch {
      void data.refresh();
    }
  }, [data, pane.id]);

  const selectTab = useCallback((tab: MailRailTab) => setRail((current) => ({ ...current, tab, collapsed: false })), []);
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

  const badges: Partial<Record<MailRailTab, number | null>> = { activity: pending.length || null };
  const tabs: CopilotRailTabDefinition<MailRailTab>[] = tabsForLayout(layout).map((id) => ({ id, label: TAB_LABELS[id], icon: TAB_ICONS[id], badge: badges[id] ?? null, available: true }));
  const activeTab = resolveActiveTab(rail.tab, layout);
  // The stacked layout has no collapsed rail: the strip is the pane's navigation.
  const railOpen = layout === "stacked" || !rail.collapsed;
  const mailShown = layout === "split" || activeTab === "mail" || rail.collapsed;

  return (
    <div ref={paneRef} className="jc-pane mc-pane" data-pane-id={pane.id} data-layout={layout} data-rail={railOpen ? "open" : "collapsed"} data-mail={mailShown ? "visible" : "hidden"}
      style={{ "--jc-rail-width": `${rail.width}px` } as React.CSSProperties}>
      <MailCommandBar pane={pane} runtimeOptions={runtimeOptions} autonomy={autonomy} accountCount={{ used: usedAccounts.length, total: data.accounts.length }} paused={paused}
        runState={runState} counters={data.run?.run?.counters ?? null} needsYou={pending.length} runBusy={runBusy} onRun={(action) => void runAction(action)}
        railOpen={railOpen} layout={layout} switching={agent.switching} onSwitchRuntime={(runtimeId) => void agent.switchAgent(runtimeId)} onSetDefault={() => void agent.setAsDefault()}
        onTogglePaused={(checked) => void togglePaused(checked)} onToggleRail={toggleRail} />
      {notice || data.error ? <div className="jc-notice" role="status">{notice ?? data.error}</div> : null}
      <div className="jc-body">
        <section className="jc-main mc-main" aria-label="Mailbox" data-active={mailShown ? "true" : "false"} aria-hidden={mailShown ? undefined : "true"}>
          {mailboxReady ? <MailClient paneId={pane.id} mailbox={mailbox} signature={data.settings?.settings.signature ?? null} stacked={layout === "stacked"} />
            : <AccountsView settings={data.settings} accounts={data.accounts} loading={data.loading} />}
        </section>
        <div className="jc-rail-handle" role="separator" aria-orientation="vertical" aria-label="Resize the copilot rail" aria-hidden={rail.collapsed ? "true" : undefined}
          onPointerDown={onResizeStart} onPointerMove={onResizeMove} onPointerUp={onResizeEnd} onPointerCancel={onResizeEnd} onDoubleClick={() => setRail((current) => ({ ...current, width: RAIL_DEFAULT_WIDTH }))} />
        <CopilotRail tabs={tabs} active={activeTab} collapsed={rail.collapsed} layout={layout} onSelect={selectTab}>
          {railOpen && activeTab === "activity" ? <ActivityTab paneId={pane.id} events={data.events} pending={pending} onChanged={() => void data.refresh()} onOpenThread={openThread} onShowThread={showOnlyThread} /> : null}
          {railOpen && activeTab === "memory" ? <MemoryTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "rules" ? <RulesTab paneId={pane.id} /> : null}
          {railOpen && activeTab === "setup" && data.settings ? (
            <SetupTab pane={pane} settings={data.settings} accounts={data.accounts} runtimeOptions={runtimeOptions} switching={agent.switching} accountRevision={agent.accountRevision}
              onSettingsChange={data.setSettings} onSwitchAgent={(runtimeId, accountProfileId) => void agent.switchAgent(runtimeId, accountProfileId)} onSetDefault={() => void agent.setAsDefault()} />
          ) : null}
          {railOpen && activeTab === "setup" && !data.settings ? <p className="jc-muted jc-panel-loading" role="status">Loading setup…</p> : null}
          <div key={agent.terminalKey} className="jc-panel-terminal" role="tabpanel" id="jc-panel-terminal" aria-labelledby="jc-tab-terminal" data-active={railOpen && activeTab === "terminal" ? "true" : "false"}>
            {terminal}
          </div>
        </CopilotRail>
      </div>
    </div>
  );
}
