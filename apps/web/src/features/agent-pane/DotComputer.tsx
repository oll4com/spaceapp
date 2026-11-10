import { useEffect, useState } from "react";
import type { DotComputer as DotComputerState, DotComputerRun, DotProfile } from "@space/contracts";
import { api } from "../../api.js";
import { CircleStop, Globe, RotateCw } from "../ui-theme/app-icons.js";
import { DotWorkspaceFiles } from "./DotDeliverables.js";
import { useUiLanguage, uiText } from "../ui-language/ui-language.js";

const kindLabels: Record<DotComputerRun["kind"], string> = { CHAT: "Task", GOAL: "Goal step", SCHEDULE: "Scheduled" };
function when(iso: string): string {
  try { return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" }); } catch { return iso; }
}

/** The Dot's own computer: private workspace, live work across rooms, its browsers, and a stop control. */
export function DotComputer({ dot, sessionId, roomId = null, visible = true, read = api.dotComputer, stop = api.stopDotComputer }: {
  dot: DotProfile | null; sessionId: string | null; roomId?: string | null; visible?: boolean;
  read?: typeof api.dotComputer; stop?: typeof api.stopDotComputer;
}) {
  const language = useUiLanguage();
  const t = (text: string, vars?: Record<string, string | number>) => uiText(language, text, vars);
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
      const parts = [result.interruptedRuns ? t(result.interruptedRuns === 1 ? "{count} task stopped" : "{count} tasks stopped", { count: result.interruptedRuns }) : null,
        result.pausedGoals ? t(result.pausedGoals === 1 ? "{count} goal paused" : "{count} goals paused", { count: result.pausedGoals }) : null].filter(Boolean);
      setNotice(parts.length ? `${parts.join(", ")}.` : t("Nothing was running."));
      setRevision((value) => value + 1);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t("The work could not be stopped."));
    } finally { setBusy(false); }
  }
  if (!dot) return <section className="dots-panel" aria-label={t("Computer")}><h3>{t("Computer")}</h3><p>{t("Choose a Dot to see its computer.")}</p></section>;
  const value = state.key === key ? state.value : null;
  const failed = state.key === key && state.failed;
  const working = Boolean(value && (value.runs.length || value.goals.some((goal) => goal.status === "ACTIVE")));
  return <section className="dots-panel dots-computer" aria-label={t("{name}'s computer", { name: dot.name })}>
    <div className="dots-computer-head">
      <h3>{t("Computer")}</h3>
      <button type="button" className="dots-icon-button" aria-label={t("Refresh computer")} title={t("Refresh")} onClick={() => setRevision((current) => current + 1)}>
        <RotateCw aria-hidden="true" /></button>
    </div>
    {!value ? failed ? <div role="status"><p>{t("Computer unavailable.")}</p><button type="button" onClick={() => setRevision((current) => current + 1)}>{t("Retry")}</button></div>
      : <p role="status">{t("Loading computer…")}</p> : <>
      <div className="dots-computer-work">
        <h4>{t("Live work")} <span className="dots-computer-count">{t("{active} of {max} task slots", { active: value.limits.activeTasks, max: value.limits.maxConcurrentTasks })}</span></h4>
        {value.runs.length ? <ul className="dots-records">{value.runs.map((run) => <li key={run.runId}>
          <strong>{run.title ?? t(kindLabels[run.kind])}</strong>
          <span>{t(kindLabels[run.kind])} · {run.status === "RUNNING" ? t("Running") : t("Queued")}{run.roomName ? ` · ${run.roomName}` : ""}</span>
          <time dateTime={run.startedAt}>{t("Started {when}", { when: when(run.startedAt) })}</time>
        </li>)}</ul> : <p>{t("No task is running.")}</p>}
        {value.goals.length ? <ul className="dots-records">{value.goals.map((goal) => <li key={goal.goalId}>
          <strong>{goal.objective}</strong>
          <span>{t("Goal")} · {goal.status === "ACTIVE" ? t("Active") : goal.status === "PAUSED" ? t("Paused") : t("Needs you")} · {t("Step {steps} of {max}", { steps: goal.steps, max: goal.maxSteps })}</span>
        </li>)}</ul> : null}
        <div className="dots-computer-actions">
          {sessionId ? <button type="button" disabled={busy || !working} onClick={() => void stopWork("session")}>
            <CircleStop aria-hidden="true" />{t("Stop this task")}</button> : null}
          <button type="button" className="dots-computer-stop-all" disabled={busy || !working} onClick={() => void stopWork("all")}>
            <CircleStop aria-hidden="true" />{busy ? t("Stopping…") : t("Stop all {name}'s work", { name: dot.name })}</button>
        </div>
        {notice ? <p role="status">{notice}</p> : null}
      </div>
      <div className="dots-computer-workspace">
        <h4>{t("Workspace")}</h4>
        <p className="dots-panel-hint">{t("{name}'s private folder for drafts, downloads and files it makes. It is created the first time {name} works.", { name: dot.name })}</p>
        <code className="dots-computer-path">{value.workspace.path}</code>
        {!value.workspace.exists ? <p>{t("Not created yet.")}</p> : <DotWorkspaceFiles dot={dot} roomId={roomId} rootEntries={value.workspace.entries} refreshKey={revision} />}
        {value.workspace.totalEntries > value.workspace.entries.length
          ? <p className="dots-panel-hint">{value.workspace.sortedAll
            ? t("Showing the {shown} most recent of {total} items.", { shown: value.workspace.entries.length, total: value.workspace.totalEntries })
            : t("Showing {shown} of {total} items. The folder is too large to sort completely.", { shown: value.workspace.entries.length, total: value.workspace.totalEntries })}</p> : null}
      </div>
      <div className="dots-computer-browsers">
        <h4>{t("Browser")}</h4>
        <p className="dots-panel-hint">{t("{name} opens its own Browser pane when it needs the web. It has a separate profile and is not signed in to your accounts.", { name: dot.name })}</p>
        {value.browsers.length ? <ul className="dots-records">{value.browsers.map((browser) => <li key={browser.paneId}>
          <strong><Globe aria-hidden="true" /> {browser.title ?? (browser.active ? t("Browser") : t("Browser (stopped)"))}</strong>
          <span>{browser.roomName ?? t("Room")}{browser.currentUrl ? ` · ${browser.currentUrl}` : ""}</span>
        </li>)}</ul> : <p>{t("No browser open.")}</p>}
      </div>
    </>}
  </section>;
}
