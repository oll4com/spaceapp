import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { NousGoal, NousGoalsView, NousOverview } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockIconButton, DockNotice, DockState, useDockConfirm } from "../dock-kit/DockKit.js";
import { ArrowDown, ArrowUp, Check, Pause, Pencil, Play, Plus, RotateCcw, Target, Trash2, X } from "../ui-theme/app-icons.js";

/**
 * Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the operator's standing objectives in priority order, with
 * what Nous recorded on each (progress, success criteria, plans, what it waits on, its last move), the loop's state and the cost
 * per goal. Add, edit the text, reorder, pause, resume, drop, reopen, delete: the operator's hands only; Nous marks achieved.
 */
type GoalView = NousGoalsView["goals"][number];
const STATUS_LABELS: Record<NousGoal["status"], string> = { ACTIVE: "Active", PAUSED: "Paused", ACHIEVED: "Achieved", DROPPED: "Dropped" };
const WAIT_LABELS: Record<NonNullable<NousGoal["waitsOn"]>["kind"], string> = { OPERATOR: "You", DATE: "A date", PROMOTE: "A promote", THIRD_PARTY: "A third party", PLAN: "A plan", NOUS: "Nous", SERVER: "The server" };
const money = (usd: number) => `$${usd.toFixed(2)}`;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

export function NousGoals({ active, overview, onChanged }: { active: boolean; overview: NousOverview | null; onChanged?: () => void }) {
  const [view, setView] = useState<NousGoalsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, confirmDialog } = useDockConfirm();
  const load = useCallback(async () => {
    try { setView((await api.nousGoals()).view ?? null); } catch (err) { setError(messageOf(err, "The goals could not be loaded.")); }
  }, []);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const tick = async () => { if (!cancelled) await load(); };
    void tick();
    const timer = window.setInterval(() => void tick(), 10_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active, load]);
  const act = async (work: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try { await work(); await load(); onChanged?.(); } catch (err) { setError(messageOf(err, fallback)); } finally { setBusy(false); }
  };
  const add = (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value) return;
    void act(async () => { await api.createNousGoal(value); setText(""); }, "The goal could not be added.");
  };
  const goals = view?.goals ?? [];
  const open = goals.filter((goal) => goal.status === "ACTIVE" || goal.status === "PAUSED");
  const closed = goals.filter((goal) => goal.status === "ACHIEVED" || goal.status === "DROPPED");
  const move = (goal: GoalView, direction: -1 | 1) => {
    const ids = open.map((entry) => entry.id);
    const index = ids.indexOf(goal.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target]!, ids[index]!];
    void act(() => api.reorderNousGoals(ids), "The goals could not be reordered.");
  };
  const planOf = (id: string) => overview?.plans.find((plan) => plan.id === id);
  const loop = view?.loop;
  const loopState = !loop ? null : loop.held ? "held" : loop.running ? "running" : "on";
  return (
    <div className="nous-decisions nous-goals" data-sensitive-masked="manual">
      {/* The add field looks and behaves like the message composer: Enter adds, Shift+Enter breaks the line. */}
      <form className="nous-goal-add" onSubmit={add}>
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={1} maxLength={4_000} aria-label="New goal" placeholder="A new goal for Nous"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
        <DockIconButton label="Add goal" icon={Plus} tone="primary" type="submit" disabled={busy || !text.trim()} />
      </form>
      {loop ? (
        <p className={`nous-goals-loop is-${loopState}`} role="status">
          <span className="nous-goals-dot" aria-hidden="true" />
          {loop.held ? `Goal loop held: ${loop.held}` : loop.running ? "Goal loop on · a goal turn runs now"
            : loop.nextAt ? `Goal loop on · next goal turn ${formatUserTime(loop.nextAt)}` : open.some((goal) => goal.status === "ACTIVE") ? "Goal loop on" : "Goal loop on · waiting for an active goal"}
        </p>
      ) : null}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {view === null && !error ? <DockState kind="loading" title="Loading the goals" /> : null}
      {view !== null && goals.length === 0 ? <DockState kind="empty" icon={Target} title="No goals yet" detail="Write one above, or type /goal followed by what you want in the conversation. Nous breaks it into plans, panes and helpers and keeps at it until it is achieved." /> : null}
      {open.map((goal, index) => <GoalCard key={goal.id} goal={goal} busy={busy} planOf={planOf} onAct={act} confirm={confirm}
        onMove={open.length > 1 ? (direction) => move(goal, direction) : undefined} first={index === 0} last={index === open.length - 1} />)}
      {closed.length ? <h4 className="nous-goals-divider">Achieved or dropped</h4> : null}
      {closed.map((goal) => <GoalCard key={goal.id} goal={goal} busy={busy} planOf={planOf} onAct={act} confirm={confirm} first last />)}
      {confirmDialog}
    </div>
  );
}

function GoalCard({ goal, busy, planOf, onAct, confirm, onMove, first, last }: {
  goal: GoalView; busy: boolean; planOf(id: string): NousOverview["plans"][number] | undefined;
  onAct(work: () => Promise<unknown>, fallback: string): Promise<void>; confirm: ReturnType<typeof useDockConfirm>["confirm"];
  onMove?(direction: -1 | 1): void; first: boolean; last: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const open = goal.status === "ACTIVE" || goal.status === "PAUSED";
  const save = () => {
    const value = (editing ?? "").trim();
    if (!value || value === goal.text) { setEditing(null); return; }
    void onAct(async () => { await api.updateNousGoal(goal.id, { text: value }); setEditing(null); }, "The goal could not be saved.");
  };
  const status = (next: "ACTIVE" | "PAUSED" | "DROPPED") => void onAct(() => api.updateNousGoal(goal.id, { status: next }), "The goal could not be changed.");
  const remove = async () => {
    if (!(await confirm({ title: "Delete this goal?", message: "Its log goes with it. Nous keeps the plans it opened.", confirmLabel: "Delete" }))) return;
    void onAct(() => api.deleteNousGoal(goal.id), "The goal could not be deleted.");
  };
  const cost = (bucket: GoalView["cost"]["today"]) => `${money(bucket.costUsd)} (${bucket.turns} ${bucket.turns === 1 ? "turn" : "turns"}${bucket.unpriced ? `, ${bucket.unpriced} unpriced` : ""})`;
  const due = goal.nextTurnAt && Date.parse(goal.nextTurnAt) > Date.now();
  return (
    <article className={`nous-goal is-${goal.status.toLowerCase()}`} aria-label={goal.text} data-goal-id={goal.id}>
      <header className="nous-goal-top">
        <span className={`nous-goal-status is-${goal.status.toLowerCase()}`}>{STATUS_LABELS[goal.status]}</span>
        {open ? <span className="nous-goal-rank" title="Priority">#{goal.priority}</span> : null}
        <strong className="nous-goal-percent">{goal.progress}%</strong>
      </header>
      {editing === null ? <h3 className="nous-goal-text">{goal.text}</h3> : (
        <div className="nous-goal-edit">
          <textarea value={editing} onChange={(event) => setEditing(event.target.value)} rows={3} maxLength={4_000} aria-label="Goal text" />
          <span className="nous-goal-edit-actions">
            <DockButton icon={X} disabled={busy} onClick={() => setEditing(null)}>Cancel</DockButton>
            <DockButton tone="primary" icon={Check} disabled={busy} onClick={save}>Save</DockButton>
          </span>
        </div>
      )}
      <span className="nous-goal-bar" aria-hidden="true"><span style={{ width: `${goal.progress}%` }} /></span>
      <dl className="nous-goal-facts">
        <dt>Criteria</dt>
        <dd className={goal.criteria ? undefined : "is-empty"}>{goal.criteria ?? "Nous writes them in its first goal turn."}</dd>
        {goal.planIds.length ? <><dt>Plans</dt><dd>{goal.planIds.map((id) => { const plan = planOf(id); return plan ? `${plan.title} (${plan.progress}%)` : id; }).join(" · ")}</dd></> : null}
        {goal.waitsOn ? <><dt>Waits on</dt><dd className="is-wait">{WAIT_LABELS[goal.waitsOn.kind]}: {goal.waitsOn.what}{goal.waitsOn.until ? ` until ${formatUserTime(goal.waitsOn.until)}` : ""}</dd></> : null}
        <dt>Last move</dt>
        <dd className={goal.lastWorkedAt ? undefined : "is-empty"}>{goal.lastWorkedAt ? `${formatUserTime(goal.lastWorkedAt)}${goal.note ? ` · ${goal.note}` : ""}` : "None yet"}</dd>
        {goal.status === "ACTIVE" ? <><dt>Next turn</dt><dd>{due ? `${formatUserTime(goal.nextTurnAt!)}${goal.unchangedTurns ? ` · nothing moved in ${goal.unchangedTurns} ${goal.unchangedTurns === 1 ? "turn" : "turns"}` : ""}` : "Due now"}</dd></> : null}
        {goal.evidence ? <><dt>Evidence</dt><dd>{goal.evidence}</dd></> : null}
        <dt>Cost</dt>
        <dd>today {cost(goal.cost.today)} · this month {cost(goal.cost.month)}</dd>
      </dl>
      {goal.events.length ? (
        <details className="nous-goal-log"><summary>Log · {goal.events.length}</summary>
          <ol>{goal.events.map((event) => <li key={event.id}><span className="nous-goal-log-when">{formatUserTime(event.at)} · {event.kind.toLowerCase()}</span> {event.text}</li>)}</ol>
        </details>
      ) : null}
      {/* One line of icon buttons; each keeps its name as its tooltip. */}
      <footer className="nous-goal-actions">
        {open && editing === null ? <DockIconButton label="Edit the goal" icon={Pencil} disabled={busy} onClick={() => setEditing(goal.text)} /> : null}
        {open && onMove ? <DockIconButton label="Move up" icon={ArrowUp} disabled={busy || first} onClick={() => onMove(-1)} /> : null}
        {open && onMove ? <DockIconButton label="Move down" icon={ArrowDown} disabled={busy || last} onClick={() => onMove(1)} /> : null}
        {goal.status === "ACTIVE" ? <DockIconButton label="Pause the goal" icon={Pause} disabled={busy} onClick={() => status("PAUSED")} /> : null}
        {goal.status === "PAUSED" ? <DockIconButton label="Resume the goal" icon={Play} disabled={busy} onClick={() => status("ACTIVE")} /> : null}
        {open ? <DockIconButton label="Drop the goal" icon={X} disabled={busy} onClick={() => status("DROPPED")} /> : null}
        {!open ? <DockIconButton label="Reopen the goal" icon={RotateCcw} disabled={busy} onClick={() => status("ACTIVE")} /> : null}
        <DockIconButton label="Delete the goal" icon={Trash2} disabled={busy} onClick={() => void remove()} />
      </footer>
    </article>
  );
}
