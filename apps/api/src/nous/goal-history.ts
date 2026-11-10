import { historySince, type DeployQueueTicket, type NousDecision, type NousGoal, type NousGoalEvent, type NousGoalHistoryEntry, type NousGoalHistoryKind, type NousGoalHistoryPage, type NousMessage, type NousTurnFacts } from "@space/contracts";
import type { PaneReport } from "@space/db";
import { durationText } from "./digest.js";

/**
 * A goal's work history (operator 1/11 03:35 BKK «Θέλω να μπορώ ανα goal να δω ιστορικό εργασιών που έχουν γίνει», plan
 * clipboard:jNDx8l-vMEl9). The goal log (nous_goal_events) is mostly WAITS, PROGRESS and NOTE lines; this reads what was done: the goal's
 * turns (nous_turn_facts.goal_id) with their answers, the work tool rows of those turns, the decisions they asked and how the operator
 * answered, the pane reports on the goal's plans and the merge-queue tickets they name. Newest first, every entry whole, paged.
 */
export const NOUS_GOAL_HISTORY_PAGE = 30;

/** The tools whose DONE rows are work; reads (space_read_pane, space_db_query, …) are left out. */
export const NOUS_GOAL_WORK_TOOLS: Readonly<Record<string, NousGoalHistoryKind>> = {
  space_send_to_pane: "BRIEF", space_copilot_brief: "BRIEF", space_answer_pane: "BRIEF", space_design_request: "BRIEF", space_video_request: "BRIEF",
  space_open_panes: "PANE", space_close_pane: "PANE", space_restart_pane: "PANE", space_stop_pane: "PANE", space_execute: "PANE", space_create_room: "PANE",
  space_copilot_control: "PANE", space_set_pane_model: "PANE",
  space_plan_create: "PLAN", space_plan_update: "PLAN", space_task_add: "PLAN", space_task_update: "PLAN",
  space_ask_operator: "DECISION", space_withdraw_decision: "DECISION", space_settle_decision: "DECISION",
  space_notify_operator: "CARD", space_focus_pane: "CARD",
  space_request_done: "DONE"
};
/** Space's own pane reports (a heartbeat, a turn's last answer) say nothing the history needs. */
const QUIET_REPORTS = new Set(["HEARTBEAT", "TURN_END"]);
const PANE_ID = /\bpane:[A-Za-z0-9_-]{6,80}/;
const PLAN_ID = /\bclipboard:[A-Za-z0-9_-]{6,64}/;
const PLAN_IDS = new RegExp(PLAN_ID.source, "g");
const DECISION_ID = /\bnous_decision:[A-Za-z0-9_-]{6,80}/;
const TICKET_IDS = /\bq-\d{8}-\d{6}-[a-z0-9]{2,12}\b/g;

export interface GoalHistorySources {
  events: NousGoalEvent[];
  turns: NousTurnFacts[];
  tools: NousMessage[];
  decisions: ReadonlyMap<string, NousDecision>;
  reports: PaneReport[];
  tickets: ReadonlyArray<{ ticket: DeployQueueTicket; onStable: boolean }>;
  panes: ReadonlyMap<string, { roomId: string; name: string }>;
}

type Refs = NousGoalHistoryEntry["refs"];
const str = (value: unknown) => typeof value === "string" ? value : "";
const toolText = (row: NousMessage) => [row.content, str(row.meta.result), str(row.meta.text)].join("\n");
const isoOf = (value: string | null | undefined) => { const at = value ? Date.parse(value) : NaN; return Number.isNaN(at) ? null : new Date(at).toISOString(); };
const lines = (...parts: Array<string | null | undefined | false>) => parts.filter((part): part is string => Boolean(part && part.trim())).join("\n\n") || null;
const seconds = (ms: number) => ms < 60_000 ? `${Math.max(1, Math.round(ms / 1_000))} s` : durationText(ms);
const order = (left: { at: string; id: string }, right: { at: string; id: string }) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id);
const byTime = (left: NousGoalEvent, right: NousGoalEvent) => left.at.localeCompare(right.at) || Number(left.id) - Number(right.id) || left.id.localeCompare(right.id);

function paneRefs(paneId: string | null | undefined, panes: GoalHistorySources["panes"], roomId?: string | null): Refs {
  if (!paneId) return {};
  const pane = panes.get(paneId);
  const room = roomId ?? pane?.roomId;
  return { paneId, ...(room ? { roomId: room } : {}), ...(pane ? { paneName: pane.name } : {}) };
}

/** Every entry of the goal's history, newest first (pure). */
export function buildGoalHistory(sources: GoalHistorySources): NousGoalHistoryEntry[] {
  const { panes } = sources;
  const entries: NousGoalHistoryEntry[] = [];
  const events = [...sources.events].sort(byTime);
  // A wait recorded again as it was (WAITS 499 of the log's lines) is no news: only a changed wait shows.
  const changedWaits = new Set<string>();
  let lastWait: string | null = null;
  for (const event of events.filter((entry) => entry.kind === "WAITS")) {
    const text = event.text.replace(/\s+/g, " ").trim().toLowerCase();
    if (text !== lastWait) changedWaits.add(event.id);
    lastWait = text;
  }
  const waitTitle = (text: string) => /^waits on/i.test(text) ? text : `Waits on ${text}`;

  // The goal's turns: from their facts, or the answer alone when a turn left no facts.
  const turns = new Map<string, { turnId: string; startedAt: string; endedAt: string; status: NousTurnFacts["status"]; costUsd: number | null }>();
  for (const fact of sources.turns) turns.set(fact.turnId, { turnId: fact.turnId, startedAt: fact.startedAt, endedAt: fact.endedAt, status: fact.status, costUsd: fact.costUsd });
  for (const event of events) if (event.kind === "TURN" && event.turnId && !turns.has(event.turnId)) turns.set(event.turnId, { turnId: event.turnId, startedAt: event.at, endedAt: event.at, status: "DONE", costUsd: null });
  const workTurns = new Set(sources.tools.map((row) => row.turnId));

  // The goal's own changes; PROGRESS, WAITS, NOTE and the answer of one of its turns fold into that turn's entry.
  const goalEntry = (event: NousGoalEvent, title: string, detail: string | null, refs: Refs = {}) =>
    entries.push({ id: `event:${event.id}`, at: event.at, kind: "GOAL", title, detail, refs });
  for (const event of events) {
    const inTurn = event.turnId !== null && turns.has(event.turnId);
    if (event.kind === "CRITERIA") goalEntry(event, "Success criteria", event.text);
    else if (event.kind === "PLANS") goalEntry(event, `Plans: ${event.text}`, null, PLAN_ID.test(event.text) ? { planId: PLAN_ID.exec(event.text)![0] } : {});
    else if (event.kind === "ACHIEVED") goalEntry(event, "Achieved", event.text);
    else if (inTurn || event.kind === "TURN") continue;
    else if (event.kind === "PROGRESS") goalEntry(event, `Progress ${event.text}`, null);
    else if (event.kind === "WAITS") { if (changedWaits.has(event.id)) goalEntry(event, waitTitle(event.text), null); }
    else if (event.kind === "NOTE") goalEntry(event, "Note", event.text);
    else goalEntry(event, event.text, null);
  }

  // Turns oldest first, so a run of turns that did no new work folds into one entry.
  type TurnEntry = { entry: NousGoalHistoryEntry; quiet: boolean; startedAt: string; done: boolean };
  const turnEntries: TurnEntry[] = [...turns.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt)).map((turn) => {
    const mine = events.filter((event) => event.turnId === turn.turnId);
    const progress = mine.filter((event) => event.kind === "PROGRESS");
    const moved = progress.length ? `${progress[0]!.text.split(" → ")[0]} → ${progress.at(-1)!.text.split(" → ").at(-1)}` : null;
    const wait = mine.filter((event) => event.kind === "WAITS" && changedWaits.has(event.id)).at(-1);
    const answer = mine.filter((event) => event.kind === "TURN").at(-1)?.text ?? null;
    const note = mine.filter((event) => event.kind === "NOTE").at(-1)?.text ?? null;
    const quiet = !workTurns.has(turn.turnId) && !moved && !wait && !mine.some((event) => event.kind === "CRITERIA" || event.kind === "PLANS" || event.kind === "ACHIEVED");
    const ms = Date.parse(turn.endedAt) - Date.parse(turn.startedAt);
    const title = [`Goal turn${turn.status === "DONE" ? "" : ` ${turn.status.toLowerCase()}`}`, ms > 0 ? seconds(ms) : null,
      turn.costUsd !== null ? `$${turn.costUsd.toFixed(2)}` : null, moved ? `progress ${moved}` : null].filter(Boolean).join(" · ");
    const detail = lines(answer, note && note.trim() !== answer?.trim() ? `Note: ${note}` : null, wait ? waitTitle(wait.text) : null);
    return { entry: { id: `turn:${turn.turnId}`, at: turn.endedAt, kind: "TURN" as const, title, detail, refs: {} }, quiet, startedAt: turn.startedAt, done: turn.status === "DONE" };
  });
  for (let index = 0; index < turnEntries.length;) {
    const run = [turnEntries[index]!];
    while (run[0]!.quiet && turnEntries[index + run.length]?.quiet) run.push(turnEntries[index + run.length]!);
    index += run.length;
    const newest = run.at(-1)!;
    if (run.length === 1) { entries.push(newest.entry); continue; }
    const notDone = run.filter((turn) => !turn.done).length;
    entries.push({ ...newest.entry, id: `turns:${newest.entry.id.slice(5)}`, since: run[0]!.startedAt,
      title: `${run.length} goal turns, no new work${notDone ? ` (${notDone} not done)` : ""}` });
  }

  // What those turns did.
  for (const row of sources.tools) {
    const kind = NOUS_GOAL_WORK_TOOLS[str(row.meta.name)];
    if (!kind) continue;
    const text = toolText(row);
    const typed = str(row.meta.text) || null;
    const decision = DECISION_ID.test(text) ? sources.decisions.get(DECISION_ID.exec(text)![0]) : undefined;
    const answer = decision ? decision.status === "OPEN" ? "Waiting for your answer." : `Your answer: ${decision.status.toLowerCase()}${decision.answer ? `: ${decision.answer}` : ""}${decision.outcome ? `\nWhat Space did: ${decision.outcome}` : ""}` : null;
    const detail = typed ?? (decision ? lines(decision.body, answer) : kind === "PLAN" || kind === "DONE" || kind === "CARD" ? str(row.meta.result) || null : null);
    const ticket = text.match(TICKET_IDS)?.[0];
    const planId = PLAN_ID.exec(text)?.[0] ?? decision?.refs.planId;
    const refs: Refs = { ...paneRefs(PANE_ID.exec(text)?.[0] ?? decision?.refs.paneId, panes, decision?.refs.roomId), ...(planId ? { planId } : {}),
      ...(ticket ? { ticket } : {}), ...(decision ? { decisionId: decision.id } : {}) };
    // The row keeps the typed text clipped after its display; the whole text is the detail.
    entries.push({ id: `tool:${row.id}`, at: row.createdAt, kind, title: typed ? row.content.replace(/: “[\s\S]*”$/, "") : row.content, detail, refs });
  }

  for (const report of sources.reports) {
    if (QUIET_REPORTS.has(report.status)) continue;
    const refs = { ...paneRefs(report.paneId, panes, report.roomId), ...(report.planId ? { planId: report.planId } : {}), ...(report.ticket ? { ticket: report.ticket } : {}) };
    const title = `${refs.paneName ?? "A pane"} ${report.status.toLowerCase().replace("_", " ")}${report.step !== null ? ` step ${report.step}` : ""}${report.percent !== null ? ` (${report.percent}%)` : ""}: ${report.summary}`;
    entries.push({ id: `report:${report.id}`, at: new Date(report.at).toISOString(), kind: "REPORT", title,
      detail: lines(report.body !== report.summary ? report.body : null, report.next ? `Next: ${report.next}` : null, report.needs ? `Needs: ${report.needs}` : null), refs });
  }

  for (const { ticket, onStable } of sources.tickets) {
    const at = isoOf(ticket.statusSince) ?? isoOf(ticket.updatedAt);
    if (!at) continue;
    const state = ticket.status === "DEPLOYED" ? onStable ? "live on stable" : "deployed on dev, not on stable yet" : ticket.status.toLowerCase().replace("_", " ");
    const submitter = ticket.submitter;
    const refs: Refs = { ticket: ticket.id, ...(submitter?.paneId ? { paneId: submitter.paneId, ...(submitter.roomId ? { roomId: submitter.roomId } : {}),
      ...(submitter.paneTitle ? { paneName: submitter.paneTitle } : {}) } : {}) };
    entries.push({ id: `ticket:${ticket.id}`, at, kind: "TICKET", title: `${ticket.id} ${state}: ${ticket.summary}`,
      detail: lines(ticket.note, ticket.deployedCommit ? `Commit ${ticket.deployedCommit.slice(0, 12)}` : null), refs });
  }
  return entries.sort(order);
}

/** One page: entries older than `before` (the oldest `at` the reader holds), of one kind or all; a page never splits entries of one time. */
export function goalHistoryPage(entries: NousGoalHistoryEntry[], query: { before?: string; kind?: NousGoalHistoryKind }, size = NOUS_GOAL_HISTORY_PAGE): NousGoalHistoryPage {
  const counts: Record<string, number> = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  const pool = entries.filter((entry) => (!query.kind || entry.kind === query.kind) && (!query.before || entry.at < query.before));
  let end = Math.min(pool.length, size);
  while (end < pool.length && pool[end]!.at === pool[end - 1]!.at) end += 1;
  return { entries: pool.slice(0, end), hasMore: end < pool.length, counts };
}

export interface GoalHistoryDeps {
  goal(owner: string, id: string): Promise<NousGoal | null>;
  /** Every event of the goal (its log, kept 30 days). */
  events(owner: string, goalId: string): Promise<NousGoalEvent[]>;
  turnFacts(owner: string, since: string): Promise<NousTurnFacts[]>;
  toolRows(owner: string, turnIds: string[], names: string[], since: string): Promise<NousMessage[]>;
  decision(owner: string, id: string): Promise<NousDecision | null>;
  planReports(owner: string, planIds: string[]): Promise<PaneReport[]>;
  ticket(id: string): Promise<DeployQueueTicket | null>;
  /** A DEPLOYED ticket's commit is on stable's main. */
  onStable(ticket: DeployQueueTicket): Promise<boolean>;
  pane(paneId: string): Promise<{ roomId: string; name: string } | null>;
  /** The owner's history period (operator 1/11 03:37 BKK, `history.periodDays`): `historySince` of their settings. */
  since(owner: string): Promise<string>;
}

export function createGoalHistory(deps: GoalHistoryDeps) {
  return {
    /**
     * Null when the goal is not the owner's. shortcut: builds the goal's whole history per page (the turn facts and tool rows of its
     * lifetime, a few thousand rows); page in SQL when a goal's history passes tens of thousands of entries.
     */
    async page(owner: string, goalId: string, query: { before?: string; kind?: NousGoalHistoryKind }): Promise<NousGoalHistoryPage | null> {
      const goal = await deps.goal(owner, goalId);
      if (!goal) return null;
      const window = await deps.since(owner).catch(() => historySince(null));
      const from = window > goal.createdAt ? window : goal.createdAt;
      const [events, facts] = await Promise.all([deps.events(owner, goalId), deps.turnFacts(owner, from)]);
      const turns = facts.filter((fact) => fact.goalId === goalId);
      const turnIds = [...new Set([...turns.map((turn) => turn.turnId), ...events.flatMap((event) => event.kind === "TURN" && event.turnId ? [event.turnId] : [])])];
      const tools = await deps.toolRows(owner, turnIds, Object.keys(NOUS_GOAL_WORK_TOOLS), from);
      // The goal's plans now and before (PLANS events), and those its turns created or updated.
      const planIds = [...new Set([...goal.planIds, ...events.filter((event) => event.kind === "PLANS").flatMap((event) => event.text.match(PLAN_IDS) ?? []),
        ...tools.filter((row) => NOUS_GOAL_WORK_TOOLS[str(row.meta.name)] === "PLAN").flatMap((row) => PLAN_ID.exec(toolText(row))?.[0] ?? [])])];
      const reports = await deps.planReports(owner, planIds);
      const decisionIds = [...new Set(tools.flatMap((row) => DECISION_ID.exec(toolText(row))?.[0] ?? []))];
      const ticketIds = [...new Set([...reports.flatMap((report) => report.ticket ?? []), ...tools.flatMap((row) => toolText(row).match(TICKET_IDS) ?? [])])];
      const [decisions, tickets] = await Promise.all([
        Promise.all(decisionIds.map((id) => deps.decision(owner, id).catch(() => null))),
        Promise.all(ticketIds.map(async (id) => {
          const ticket = await deps.ticket(id).catch(() => null);
          return ticket ? { ticket, onStable: ticket.status === "DEPLOYED" && await deps.onStable(ticket).catch(() => false) } : null;
        }))]);
      const decisionMap = new Map(decisions.flatMap((decision) => decision ? [[decision.id, decision] as const] : []));
      const paneIds = [...new Set([...reports.map((report) => report.paneId), ...tools.flatMap((row) => PANE_ID.exec(toolText(row))?.[0] ?? []),
        ...[...decisionMap.values()].flatMap((decision) => decision.refs.paneId ?? [])])];
      const panes = new Map((await Promise.all(paneIds.map(async (id) => [id, await deps.pane(id).catch(() => null)] as const)))
        .flatMap(([id, pane]) => pane ? [[id, pane] as const] : []));
      const entries = buildGoalHistory({ events, turns, tools, decisions: decisionMap, reports, tickets: tickets.flatMap((entry) => entry ?? []), panes });
      // Only what happened inside the window: the goal's older events, reports and tickets are read whole, then left out here.
      return goalHistoryPage(entries.filter((entry) => entry.at >= from), query);
    }
  };
}
export type NousGoalHistory = ReturnType<typeof createGoalHistory>;
