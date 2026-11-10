import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from "react";
import { NOUS_GOAL_HISTORY_KINDS, type NousGoal, type NousGoalHistoryEntry, type NousGoalHistoryKind, type NousGoalHistoryPage, type NousGoalsView, type NousOverview } from "@space/contracts";
import { api } from "../../api.js";
import { formatUserTime } from "../date-time-settings/date-time-settings.js";
import { DockButton, DockChips, DockIconButton, DockNotice, DockState, useDockConfirm } from "../dock-kit/DockKit.js";
import { requestNousFocus } from "../nous-focus/nous-focus-events.js";
import { ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, Pause, Pencil, Play, Plus, RotateCcw, Target, Trash2, X } from "../ui-theme/app-icons.js";
import { useNousUiIds, useNousUiState } from "./nous-ui-state.js";

/**
 * Nous Goals (operator request 2026-10-27, plan clipboard:DR51jZJEB0j1): the operator's standing objectives in priority order, with
 * what Nous recorded on each (progress, success criteria, plans, what it waits on, its last move), the loop's state and the cost
 * per goal. Add, edit the text, reorder, pause, resume, drop, reopen, delete: the operator's hands only; Nous marks achieved.
 * Cards start collapsed to one row and open on a click (operator request 2026-10-31); open cards and work histories stay open on this device.
 */
type GoalView = NousGoalsView["goals"][number];
const STATUS_LABELS: Record<NousGoal["status"], string> = { ACTIVE: "Active", PAUSED: "Paused", ACHIEVED: "Achieved", DROPPED: "Dropped" };
const WAIT_LABELS: Record<NonNullable<NousGoal["waitsOn"]>["kind"], string> = { OPERATOR: "You", DATE: "A date", PROMOTE: "A promote", THIRD_PARTY: "A third party", PLAN: "A plan", NOUS: "Nous", SERVER: "The server" };
const money = (usd: number) => `$${usd.toFixed(2)}`;
const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** Each kind's name, on the filter chips and on every entry. */
const KIND_LABELS: Record<NousGoalHistoryKind, string> = { TURN: "Turn", BRIEF: "Brief", PANE: "Pane", PLAN: "Plan", REPORT: "Report", TICKET: "Ticket",
  DECISION: "Decision", CARD: "Card", DONE: "Done", GOAL: "Goal" };

const isHistoryKind = (value: unknown): value is NousGoalHistoryKind | "ALL" => value === "ALL" || NOUS_GOAL_HISTORY_KINDS.some((kind) => kind === value);

/**
 * A goal's work history (operator 1/11 03:35 BKK, plan clipboard:jNDx8l-vMEl9): what was done for it, newest first and whole, filtered by
 * kind; read when opened, then "Load earlier" pages back. It replaced the goal log, whose waits, progress and notes were mostly noise.
 */
function GoalHistory({ goalId, open, onToggle, onOpenPlan }: { goalId: string; open: boolean; onToggle: (open: boolean) => void; onOpenPlan?: (id: string) => void }) {
  // Each goal's kind stays as the operator left it (nous_msg:40a252b1); a kind the goal no longer has reads as All.
  const [kind, setKind] = useNousUiState<NousGoalHistoryKind | "ALL">(`goals.history.${goalId}`, "ALL", isHistoryKind);
  const [page, setPage] = useState<NousGoalHistoryPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Only the newest request lands: a filter switched mid-read never shows the other filter's page.
  const latest = useRef(0);
  const load = useCallback(async (before?: string) => {
    const call = ++latest.current;
    setLoading(true);
    setError(null);
    try {
      const next = await api.nousGoalHistory(goalId, { ...(before ? { before } : {}), ...(kind !== "ALL" ? { kind } : {}) });
      if (call === latest.current) setPage((current) => before && current ? { ...next, entries: [...current.entries, ...next.entries] } : next);
    } catch (err) { if (call === latest.current) setError(messageOf(err, "The work history could not be loaded.")); }
    finally { if (call === latest.current) setLoading(false); }
  }, [goalId, kind]);
  useEffect(() => { if (open) void load(); }, [open, load]);
  useEffect(() => { if (page && kind !== "ALL" && !page.counts[kind]) setKind("ALL"); }, [page, kind, setKind]);
  const total = page ? Object.values(page.counts).reduce((sum, count) => sum + count, 0) : null;
  const chips = page ? [{ id: "ALL" as const, label: "All", count: total ?? 0 },
    ...NOUS_GOAL_HISTORY_KINDS.filter((entry) => page.counts[entry]).map((entry) => ({ id: entry, label: KIND_LABELS[entry], count: page.counts[entry]! }))] : [];
  return (
    <details className="nous-goal-history" data-sensitive-masked="manual" open={open} onToggle={(event) => onToggle(event.currentTarget.open)}>
      <summary>Work history{total ? ` · ${total}` : ""}</summary>
      {open ? <>
        {total ? <DockChips label="Show in the work history" options={chips} value={kind} onChange={setKind} /> : null}
        {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
        {page === null && loading ? <DockState kind="loading" title="Loading the work history" /> : null}
        {page && !page.entries.length && !loading ? <p className="nous-goal-history-empty">Nothing done for this goal yet.</p> : null}
        {page?.entries.length ? <ol>{page.entries.map((entry) => <GoalHistoryEntry key={entry.id} entry={entry} onOpenPlan={onOpenPlan} />)}</ol> : null}
        {page?.hasMore ? <DockButton disabled={loading} onClick={() => void load(page.entries.at(-1)!.at)}>{loading ? "Loading…" : "Load earlier"}</DockButton> : null}
      </> : null}
    </details>
  );
}

function GoalHistoryEntry({ entry, onOpenPlan }: { entry: NousGoalHistoryEntry; onOpenPlan?: (id: string) => void }) {
  const { refs } = entry;
  const pane = refs.paneId && refs.roomId ? { roomId: refs.roomId, paneId: refs.paneId } : null;
  return (
    <li className={`nous-goal-history-entry is-${entry.kind.toLowerCase()}`}>
      <span className="nous-goal-history-when">{entry.since ? `${formatUserTime(entry.since)} – ` : ""}{formatUserTime(entry.at)} · {KIND_LABELS[entry.kind]}</span>
      <span className="nous-goal-history-title">{entry.title}</span>
      {entry.detail ? <span className="nous-goal-history-detail">{entry.detail}</span> : null}
      {pane || (refs.planId && onOpenPlan) ? (
        <span className="nous-goal-history-links">
          {pane ? <DockButton onClick={() => requestNousFocus({ ...pane, immediate: true })}>Open {refs.paneName ?? "the pane"}</DockButton> : null}
          {refs.planId && onOpenPlan ? <DockButton onClick={() => onOpenPlan(refs.planId!)}>Open plan</DockButton> : null}
        </span>
      ) : null}
    </li>
  );
}

export function NousGoals({ active, overview, onChanged, onOpenPlan }: { active: boolean; overview: NousOverview | null; onChanged?: () => void; onOpenPlan?: (id: string) => void }) {
  const [view, setView] = useState<NousGoalsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirm, confirmDialog } = useDockConfirm();
  // Kept by goal id, not in the card: a dropped or reopened goal moves between the two lists and stays open. Deleted goals are forgotten.
  const goalIds = view ? view.goals.map((goal) => goal.id) : null;
  const expanded = useNousUiIds("goals.open", goalIds);
  useNousUiIds("goals.history", goalIds);
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
  // Masked: the goals' own words only; the status, rank, percent, bar and Limit row stay readable in masked shots (Nous 1/11).
  return (
    <div className="nous-decisions nous-goals">
      {/* The add field looks and behaves like the message composer: Enter adds, Shift+Enter breaks the line. */}
      <form className="nous-goal-add" onSubmit={add}>
        <textarea data-sensitive-masked="manual" value={text} onChange={(event) => setText(event.target.value)} rows={1} aria-label="New goal" placeholder="A new goal for Nous"
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); add(); } }} />
        <DockIconButton label="Add goal" icon={Plus} tone="primary" type="submit" disabled={busy || !text.trim()} />
      </form>
      {loop ? (
        <p className={`nous-goals-loop is-${loopState}`} role="status" data-sensitive-masked="manual">
          <span className="nous-goals-dot" aria-hidden="true" />
          {loop.held ? `Goal loop held: ${loop.held}` : loop.running ? "Goal loop on · a goal turn runs now"
            : loop.nextAt ? `Goal loop on · next goal turn ${formatUserTime(loop.nextAt)}` : open.some((goal) => goal.status === "ACTIVE") ? "Goal loop on" : "Goal loop on · waiting for an active goal"}
        </p>
      ) : null}
      {error ? <DockNotice onDismiss={() => setError(null)}>{error}</DockNotice> : null}
      {view === null && !error ? <DockState kind="loading" title="Loading the goals" /> : null}
      {view !== null && goals.length === 0 ? <DockState kind="empty" icon={Target} title="No goals yet" detail="Write one above, or type /goal followed by what you want in the conversation. Nous breaks it into plans, panes and helpers and keeps at it until it is achieved." /> : null}
      {open.map((goal, index) => <GoalCard key={goal.id} goal={goal} expanded={expanded.has(goal.id)} onToggle={() => expanded.toggle(goal.id)} busy={busy} planOf={planOf} onAct={act} confirm={confirm} onOpenPlan={onOpenPlan}
        onMove={open.length > 1 ? (direction) => move(goal, direction) : undefined} first={index === 0} last={index === open.length - 1} />)}
      {closed.length ? <h4 className="nous-goals-divider">Achieved or dropped</h4> : null}
      {closed.map((goal) => <GoalCard key={goal.id} goal={goal} expanded={expanded.has(goal.id)} onToggle={() => expanded.toggle(goal.id)} busy={busy} planOf={planOf} onAct={act} confirm={confirm} onOpenPlan={onOpenPlan} first last />)}
      {confirmDialog}
    </div>
  );
}

function GoalCard({ goal, expanded, onToggle, busy, planOf, onAct, confirm, onOpenPlan, onMove, first, last }: {
  goal: GoalView; expanded: boolean; onToggle(): void; busy: boolean; planOf(id: string): NousOverview["plans"][number] | undefined;
  onAct(work: () => Promise<unknown>, fallback: string): Promise<void>; confirm: ReturnType<typeof useDockConfirm>["confirm"];
  onOpenPlan?(id: string): void; onMove?(direction: -1 | 1): void; first: boolean; last: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const history = useNousUiIds("goals.history");
  const bodyId = useId();
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
    <article className={`nous-goal is-${goal.status.toLowerCase()}${expanded ? " is-open" : ""}`} aria-label={goal.text} data-goal-id={goal.id}>
      <button type="button" className="nous-goal-head" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle}>
        <span className={`nous-goal-status is-${goal.status.toLowerCase()}`}>{STATUS_LABELS[goal.status]}</span>
        {open ? <span className="nous-goal-rank" title="Priority">#{goal.priority}</span> : null}
        <span className="nous-goal-line" data-sensitive-masked="manual">{goal.text.split("\n")[0]}</span>
        {/* Operator 1/11 03:39 BKK: a percentage only on a goal with a limit (a deadline or a measurable target). */}
        {goal.limit ? <strong className="nous-goal-percent">{goal.progress}%</strong> : null}
        {/* Wrapped: the shell paints expanded buttons with a direct icon child as active toggles. */}
        <span className="nous-goal-chevron" aria-hidden="true">{expanded ? <ChevronDown /> : <ChevronRight />}</span>
      </button>
      {expanded ? (
        <div className="nous-goal-body" id={bodyId}>
          {editing === null ? <h3 className="nous-goal-text" data-sensitive-masked="manual">{goal.text}</h3> : (
            <div className="nous-goal-edit">
              <textarea data-sensitive-masked="manual" value={editing} onChange={(event) => setEditing(event.target.value)} rows={3} aria-label="Goal text" />
              <span className="nous-goal-edit-actions">
                <DockButton icon={X} disabled={busy} onClick={() => setEditing(null)}>Cancel</DockButton>
                <DockButton tone="primary" icon={Check} disabled={busy} onClick={save}>Save</DockButton>
              </span>
            </div>
          )}
          {goal.limit ? <span className="nous-goal-bar" aria-hidden="true"><span style={{ width: `${goal.progress}%` }} /></span> : null}
          <dl className="nous-goal-facts">
            {/* Right under the bar: the limit is what the percentage measures (long criteria pushed it out of view). */}
            {goal.limit ? <><dt>Limit</dt><dd>{goal.limit.kind === "DATE" ? `By ${formatUserTime(goal.limit.until, { withDate: true })}` : goal.limit.what}</dd></> : null}
            <dt>Criteria</dt>
            <dd className={goal.criteria ? undefined : "is-empty"} data-sensitive-masked="manual">{goal.criteria ?? "Nous writes them in its first goal turn."}</dd>
            {goal.planIds.length ? <><dt>Plans</dt><dd data-sensitive-masked="manual">{goal.planIds.map((id) => { const plan = planOf(id); return plan ? `${plan.title} (${plan.progress}%)` : id; }).join(" · ")}</dd></> : null}
            {goal.waitsOn ? <><dt>Waits on</dt><dd className="is-wait" data-sensitive-masked="manual">{WAIT_LABELS[goal.waitsOn.kind]}: {goal.waitsOn.what}{goal.waitsOn.until ? ` until ${formatUserTime(goal.waitsOn.until)}` : ""}</dd></> : null}
            <dt>Last move</dt>
            <dd className={goal.lastWorkedAt ? undefined : "is-empty"} data-sensitive-masked="manual">{goal.lastWorkedAt ? `${formatUserTime(goal.lastWorkedAt)}${goal.note ? ` · ${goal.note}` : ""}` : "None yet"}</dd>
            {goal.status === "ACTIVE" ? <><dt>Next turn</dt><dd>{due ? `${formatUserTime(goal.nextTurnAt!)}${goal.unchangedTurns ? ` · nothing moved in ${goal.unchangedTurns} ${goal.unchangedTurns === 1 ? "turn" : "turns"}` : ""}` : "Due now"}</dd></> : null}
            {goal.evidence ? <><dt>Evidence</dt><dd data-sensitive-masked="manual">{goal.evidence}</dd></> : null}
            <dt>Cost</dt>
            <dd>today {cost(goal.cost.today)} · this month {cost(goal.cost.month)}</dd>
          </dl>
          <GoalHistory goalId={goal.id} open={history.has(goal.id)} onToggle={(isOpen) => history.setOpen(goal.id, isOpen)} onOpenPlan={onOpenPlan} />
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
        </div>
      ) : null}
    </article>
  );
}
