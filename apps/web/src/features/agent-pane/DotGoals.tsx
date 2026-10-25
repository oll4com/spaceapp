import { useEffect, useState, type FormEvent } from "react";
import type { DotGoal, DotProfile } from "@space/contracts";
import { api } from "../../api.js";
import { Crosshair, X } from "../ui-theme/app-icons.js";

const statusLabels: Record<DotGoal["status"], string> = {
  ACTIVE: "Active", PAUSED: "Paused", COMPLETED: "Completed", BLOCKED: "Needs you", CANCELLED: "Cancelled",
  BUDGET_EXHAUSTED: "Out of budget", FAILED: "Stopped"
};
export const dotGoalStatusLabel = (status: DotGoal["status"]) => statusLabels[status];
const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);

/** Sets a server-run Goal on the selected Dot's conversation. */
export function DotGoalDialog({ dot, sessionId, onClose, onCreated, create = api.createDotGoal }: {
  dot: DotProfile; sessionId: string; onClose: () => void; onCreated: (goal: DotGoal) => void;
  create?: typeof api.createDotGoal;
}) {
  const [objective, setObjective] = useState("");
  const [milestones, setMilestones] = useState("");
  const [criteria, setCriteria] = useState("");
  const [maxSteps, setMaxSteps] = useState(20);
  const [maxHours, setMaxHours] = useState(3);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const milestoneList = lines(milestones), criteriaList = lines(criteria);
  const valid = objective.trim().length > 0 && milestoneList.length <= 20 && criteriaList.length <= 10
    && maxSteps >= 1 && maxSteps <= 200 && maxHours > 0 && maxHours <= 24;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!valid || pending) return;
    setPending(true); setError(null);
    try {
      const { goal } = await create(dot.dotId, { sessionId, objective: objective.trim(), milestones: milestoneList, criteria: criteriaList,
        budget: { maxSteps, maxMinutes: Math.max(5, Math.round(maxHours * 60)) } });
      onCreated(goal);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The Goal could not start.");
    } finally { setPending(false); }
  }
  return <div className="attachment-modal codex-resume-modal" onClick={() => { if (!pending) onClose(); }}>
    <section className="attachment-modal-body codex-resume-modal-body dots-goal-dialog" role="dialog" aria-modal="true" aria-label={`Set a goal for ${dot.name}`}
      onClick={(event) => event.stopPropagation()}>
      <button type="button" className="terminal-upload-modal-close codex-resume-modal-close" aria-label="Close goal editor" disabled={pending} onClick={onClose}>
        <X aria-hidden="true" />
      </button>
      <div className="codex-resume-modal-header">
        <span className="terminal-upload-modal-label codex-resume-modal-label"><Crosshair aria-hidden="true" />Goal</span>
        <strong>Set a goal for {dot.name}</strong>
        <small>{dot.name} keeps working step by step on the server, even when this tab is closed. You can pause, guide or cancel it.</small>
      </div>
      <form className="codex-goal-editor" onSubmit={(event) => void submit(event)}>
        <label><span>Objective</span>
          <textarea aria-label="Goal objective" autoFocus rows={3} value={objective} disabled={pending} maxLength={4000}
            onChange={(event) => setObjective(event.currentTarget.value)} /></label>
        <label><span>Milestones (optional, one per line)</span>
          <textarea aria-label="Goal milestones" rows={3} value={milestones} disabled={pending} onChange={(event) => setMilestones(event.currentTarget.value)} /></label>
        <label><span>Done when (optional, one per line)</span>
          <textarea aria-label="Goal completion criteria" rows={2} value={criteria} disabled={pending} onChange={(event) => setCriteria(event.currentTarget.value)} /></label>
        <div className="dots-goal-budget">
          <label><span>Max steps</span><input type="number" min={1} max={200} value={maxSteps} disabled={pending}
            onChange={(event) => setMaxSteps(Number(event.currentTarget.value))} /></label>
          <label><span>Max hours</span><input type="number" min={0.1} max={24} step="any" value={maxHours} disabled={pending}
            onChange={(event) => setMaxHours(Number(event.currentTarget.value))} /></label>
        </div>
        {milestoneList.length > 20 ? <p role="alert">Use at most 20 milestones.</p> : null}
        {criteriaList.length > 10 ? <p role="alert">Use at most 10 completion criteria.</p> : null}
        {error ? <p role="alert">{error}</p> : null}
        <div>
          <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
          <button type="submit" disabled={pending || !valid}>{pending ? "Starting…" : "Start goal"}</button>
        </div>
      </form>
    </section>
  </div>;
}

/** The selected conversation's Goal: progress, budget and owner controls. */
export function DotGoalStrip({ dot, sessionId, refreshKey, visible = true, onChanged, read = api.dotGoals, control = api.controlDotGoal, steer = api.steerDotGoal }: {
  dot: DotProfile | null; sessionId: string | null; refreshKey: string; visible?: boolean; onChanged?: (goal: DotGoal | null) => void;
  read?: typeof api.dotGoals; control?: typeof api.controlDotGoal; steer?: typeof api.steerDotGoal;
}) {
  const [goal, setGoal] = useState<DotGoal | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [guidance, setGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let current = true;
    if (!dot || !sessionId) { setGoal(null); onChanged?.(null); return; }
    void Promise.resolve().then(() => read(dot.dotId, sessionId)).then((result) => {
      if (!current || result.dotId !== dot.dotId) return;
      const latest = result.items.find((item) => item.sessionId === sessionId && item.dotId === dot.dotId) ?? null;
      setGoal(latest); onChanged?.(latest);
    }).catch(() => { if (current) setError("Goal status is unavailable."); });
    return () => { current = false; };
  }, [dot?.dotId, sessionId, refreshKey, read, tick]);
  // Status decided between runs (budget, blocking question) appears without a reload:
  // a slow refresh only while an open Goal is shown in a visible pane and tab.
  const open = goal?.status === "ACTIVE" || goal?.status === "PAUSED" || goal?.status === "BLOCKED";
  useEffect(() => {
    if (!open || !visible) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") setTick((value) => value + 1); }, 30_000);
    return () => clearInterval(timer);
  }, [open, visible]);
  if (!dot || !goal || dismissed === goal.goalId) return null;
  const done = goal.milestones.filter((milestone) => milestone.status === "DONE").length;
  async function act(action: "PAUSE" | "RESUME" | "CANCEL") {
    setBusy(true); setError(null);
    try { const next = (await control(dot!.dotId, goal!.goalId, action)).goal; setGoal(next); onChanged?.(next); setConfirmCancel(false); }
    catch (err) { setError(err instanceof Error ? err.message : "The Goal could not change."); }
    finally { setBusy(false); }
  }
  async function guide(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!guidance.trim() || busy) return;
    setBusy(true); setError(null);
    try { const next = (await steer(dot!.dotId, goal!.goalId, guidance.trim())).goal; setGoal(next); setGuidance(""); }
    catch (err) { setError(err instanceof Error ? err.message : "Guidance was not saved."); }
    finally { setBusy(false); }
  }
  return <section className="dots-goal-strip" data-status={goal.status} aria-label={`${dot.name}'s goal`}>
    <div className="dots-goal-head">
      <span className="dots-goal-status">{dotGoalStatusLabel(goal.status)}</span>
      <strong title={goal.objective}>{goal.objective}</strong>
      {!open ? <button type="button" className="dots-goal-dismiss" aria-label="Dismiss goal" onClick={() => setDismissed(goal.goalId)}><X aria-hidden="true" /></button> : null}
    </div>
    <p className="dots-goal-meta">
      {goal.milestones.length ? `${done}/${goal.milestones.length} milestones · ` : ""}Step {goal.usage.steps} of {goal.budget.maxSteps}
      {goal.statusReason && goal.status !== "ACTIVE" && goal.status !== "BLOCKED" ? ` · ${goal.statusReason}` : ""}
    </p>
    {goal.status === "BLOCKED" && goal.statusReason ? <p className="dots-goal-question" role="status">{dot.name} needs you: {goal.statusReason} Add guidance, then resume.</p> : null}
    {goal.milestones.length ? <ol className="dots-goal-milestones">{goal.milestones.map((milestone) => <li key={milestone.id} data-status={milestone.status}>
      <span aria-hidden="true">{milestone.status === "DONE" ? "✓" : milestone.status === "IN_PROGRESS" ? "…" : "○"}</span>{milestone.title}
      <span className="dots-visually-hidden"> ({milestone.status === "DONE" ? "done" : milestone.status === "IN_PROGRESS" ? "in progress" : "pending"})</span>
    </li>)}</ol> : null}
    {open ? <div className="dots-goal-controls">
      <form onSubmit={(event) => void guide(event)}>
        <input aria-label={`Guide ${dot.name}'s goal`} placeholder={`Guide ${dot.name}…`} value={guidance} maxLength={4000} disabled={busy}
          onChange={(event) => setGuidance(event.currentTarget.value)} />
        <button type="submit" disabled={busy || !guidance.trim()}>Guide</button>
      </form>
      <button type="button" disabled={busy} onClick={() => void act(goal.status === "ACTIVE" ? "PAUSE" : "RESUME")}>{goal.status === "ACTIVE" ? "Pause" : "Resume"}</button>
      {confirmCancel ? <button type="button" className="dots-goal-cancel" disabled={busy} onClick={() => void act("CANCEL")}>Confirm cancel</button>
        : <button type="button" disabled={busy} onClick={() => setConfirmCancel(true)}>Cancel goal</button>}
    </div> : null}
    {error ? <p role="alert" className="dots-goal-error">{error}</p> : null}
  </section>;
}
