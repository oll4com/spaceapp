import { useEffect, useState } from "react";
import type { DotComputer as DotComputerState, DotComputerRun, DotProfile } from "@space/contracts";
import { api } from "../../api.js";
import { CircleStop, Globe, RotateCw } from "../ui-theme/app-icons.js";
import { DotWorkspaceFiles } from "./DotDeliverables.js";

const kindLabels: Record<DotComputerRun["kind"], string> = { CHAT: "Task", GOAL: "Goal step", SCHEDULE: "Scheduled" };
function when(iso: string): string {
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

/** The Dot's own computer: private workspace, live work across rooms, its browsers, and a stop control. */
export function DotComputer({ dot, sessionId, roomId = null, visible = true, read = api.dotComputer, stop = api.stopDotComputer }: {
  dot: DotProfile | null; sessionId: string | null; roomId?: string | null; visible?: boolean;
  read?: typeof api.dotComputer; stop?: typeof api.stopDotComputer;
}) {
  const [state, setState] = useState<{ key: string; value: DotComputerState | null; failed: boolean }>({ key: "", value: null, failed: false });
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const key = dot?.dotId ?? "none";
  useEffect(() => {
    if (!dot || !visible) return;
    let current = true;
    const load = () => void Promise.resolve().then(() => read(dot.dotId)).then((value) => {
      if (!current) return;
      if (value.dotId !== dot.dotId) throw Error("Dot computer identity mismatch");
      setState({ key: dot.dotId, value, failed: false });
    }).catch(() => { if (current) setState((previous) => ({ key: dot.dotId, value: previous.key === dot.dotId ? previous.value : null, failed: true })); });
    load();
    // Live work changes while the view is open; refresh only while the tab is visible.
    const timer = window.setInterval(() => { if (document.visibilityState !== "hidden") load(); }, 15_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [dot?.dotId, visible, revision, read]);
  async function stopWork(scope: "all" | "session") {
    if (!dot || busy) return;
    setBusy(true); setNotice(null);
    try {
      const result = await stop(dot.dotId, scope === "session" ? sessionId : null);
      const parts = [result.interruptedRuns ? `${result.interruptedRuns} task${result.interruptedRuns === 1 ? "" : "s"} stopped` : null,
        result.pausedGoals ? `${result.pausedGoals} goal${result.pausedGoals === 1 ? "" : "s"} paused` : null].filter(Boolean);
      setNotice(parts.length ? `${parts.join(", ")}.` : "Nothing was running.");
      setRevision((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The work could not be stopped.");
    } finally { setBusy(false); }
  }
  if (!dot) return <section className="dots-panel" aria-label="Computer"><h3>Computer</h3><p>Choose a Dot to see its computer.</p></section>;
  const value = state.key === key ? state.value : null;
  const failed = state.key === key && state.failed;
  const working = Boolean(value && (value.runs.length || value.goals.some((goal) => goal.status === "ACTIVE")));
  return <section className="dots-panel dots-computer" aria-label={`${dot.name}'s computer`}>
    <div className="dots-computer-head">
      <h3>Computer</h3>
      <button type="button" className="dots-icon-button" aria-label="Refresh computer" title="Refresh" onClick={() => setRevision((current) => current + 1)}>
        <RotateCw aria-hidden="true" /></button>
    </div>
    {!value ? failed ? <div role="status"><p>Computer unavailable.</p><button type="button" onClick={() => setRevision((current) => current + 1)}>Retry</button></div>
      : <p role="status">Loading computer…</p> : <>
      <div className="dots-computer-work">
        <h4>Live work <span className="dots-computer-count">{value.limits.activeTasks} of {value.limits.maxConcurrentTasks} task slots</span></h4>
        {value.runs.length ? <ul className="dots-records">{value.runs.map((run) => <li key={run.runId}>
          <strong>{run.title ?? kindLabels[run.kind]}</strong>
          <span>{kindLabels[run.kind]} · {run.status === "RUNNING" ? "Running" : "Queued"}{run.roomName ? ` · ${run.roomName}` : ""}</span>
          <time dateTime={run.startedAt}>Started {when(run.startedAt)}</time>
        </li>)}</ul> : <p>No task is running.</p>}
        {value.goals.length ? <ul className="dots-records">{value.goals.map((goal) => <li key={goal.goalId}>
          <strong>{goal.objective}</strong>
          <span>Goal · {goal.status === "ACTIVE" ? "Active" : goal.status === "PAUSED" ? "Paused" : "Needs you"} · Step {goal.steps} of {goal.maxSteps}</span>
        </li>)}</ul> : null}
        <div className="dots-computer-actions">
          {sessionId ? <button type="button" disabled={busy || !working} onClick={() => void stopWork("session")}>
            <CircleStop aria-hidden="true" />Stop this task</button> : null}
          <button type="button" className="dots-computer-stop-all" disabled={busy || !working} onClick={() => void stopWork("all")}>
            <CircleStop aria-hidden="true" />{busy ? "Stopping…" : `Stop all ${dot.name}'s work`}</button>
        </div>
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      <div className="dots-computer-workspace">
        <h4>Workspace</h4>
        <p className="dots-panel-hint">{dot.name}'s private folder for drafts, downloads and files it makes. It is created the first time {dot.name} works.</p>
        <code className="dots-computer-path">{value.workspace.path}</code>
        {!value.workspace.exists ? <p>Not created yet.</p> : <DotWorkspaceFiles dot={dot} roomId={roomId} rootEntries={value.workspace.entries} refreshKey={revision} />}
        {value.workspace.totalEntries > value.workspace.entries.length
          ? <p className="dots-panel-hint">{value.workspace.sortedAll
            ? `Showing the ${value.workspace.entries.length} most recent of ${value.workspace.totalEntries} items.`
            : `Showing ${value.workspace.entries.length} of ${value.workspace.totalEntries} items. The folder is too large to sort completely.`}</p> : null}
      </div>
      <div className="dots-computer-browsers">
        <h4>Browser</h4>
        <p className="dots-panel-hint">{dot.name} opens its own Browser pane when it needs the web. It has a separate profile and is not signed in to your accounts.</p>
        {value.browsers.length ? <ul className="dots-records">{value.browsers.map((browser) => <li key={browser.paneId}>
          <strong><Globe aria-hidden="true" /> {browser.title ?? (browser.active ? "Browser" : "Browser (stopped)")}</strong>
          <span>{browser.roomName ?? "Room"}{browser.currentUrl ? ` · ${browser.currentUrl}` : ""}</span>
        </li>)}</ul> : <p>No browser open.</p>}
      </div>
    </>}
  </section>;
}
