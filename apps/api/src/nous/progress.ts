import { NOUS_TURN_FAILED_NO_ERROR, nousDecisionRunsWhen, nousFailureCause, type NousDecision, type NousTurnFacts, type RoomAgentEvent } from "@space/contracts";
import { redactMemoryText } from "@space/runtime";
import { predictionText } from "./predictions.js";

/**
 * Nous's scorecard v1 (plan clipboard:L7RgHsveHbcR, frozen 2026-10-17): six dimensions over the last 7 days against the
 * 2026-10-17 baseline, so Nous can say how much it has improved. Formulas and weights are the operator's to change (a
 * DIRECTION decision); a new version keeps v1 computable from the same facts.
 */
export const NOUS_SCORECARD_WINDOW_DAYS = 7;
export const NOUS_SCORECARD_MIN_TURNS = 20;
const DAY_MS = 86_400_000;

export type NousDimension = "autonomy" | "coverage" | "unblocking" | "planMovement" | "escalation" | "reliability";
export const NOUS_WEIGHTS: Record<NousDimension, number> = { autonomy: 0.25, coverage: 0.15, unblocking: 0.15, planMovement: 0.15, escalation: 0.15, reliability: 0.15 };

/** Measured 2026-10-17 08:48-09:13 UTC (11 turns); unblocking re-measured on the same events with the coded rule below (the plan's hand estimate was 60). */
export const NOUS_BASELINE: { date: string; dimensions: Record<NousDimension, number> } = {
  date: "2026-10-17", dimensions: { autonomy: 57, coverage: 55, unblocking: 78, planMovement: 0, escalation: 25, reliability: 45 }
};

export interface NousCatalogEntry { label: string; reach: string[]; baseline: boolean }
const entry = (label: string, reach: string[], baseline = false): NousCatalogEntry => ({ label, reach, baseline });
/**
 * The 40 operator actions on SpaceApp (catalog v1). `reach`: the tools that reach it, or "tool.argument" when it is one
 * argument of a tool; a new tool is mapped here, the entries stay. `baseline`: reachable on 2026-10-17.
 */
export const NOUS_CATALOG_V1: NousCatalogEntry[] = [
  entry("read rooms", ["space_world"], true), entry("create a room", ["space_create_room"]), entry("rename or activate a room", ["space_rename_room"]),
  entry("open panes", ["space_open_panes"], true), entry("read a pane", ["space_read_pane"], true), entry("prompt a pane", ["space_send_to_pane"], true),
  entry("answer or decline a prompt", ["space_answer_pane"], true), entry("stop a pane", ["space_stop_pane"], true), entry("restart a pane", ["space_restart_pane"], true),
  entry("close a pane", ["space_close_pane"]), entry("set a pane's model", ["space_set_pane_model"], true), entry("pane windows and layout", ["space_execute"]),
  entry("list plans", ["space_plans"], true), entry("read a plan", ["space_plan_read"], true), entry("record plan progress", ["space_plan_update"], true),
  entry("create a plan", ["space_plan_create"]), entry("create a note", ["space_clipboard_note"]), entry("complete a clipboard item", ["space_clipboard_note.completed"]),
  entry("list tasks", ["space_tasks"], true), entry("add a task", ["space_task_add"], true), entry("update a task", ["space_task_update"], true),
  entry("schedule a task", ["space_task_add.schedule"]),
  entry("list notifications", ["space_notifications"], true), entry("resolve a notification", ["space_resolve_notification"], true),
  entry("list copilot items", ["space_copilot_items"], true), entry("answer a copilot question", ["space_copilot_answer"], true),
  entry("copilot settings or pause", []), entry("start a copilot run or brief", ["space_copilot_brief"]),
  entry("release train operations", ["space_release"], true), entry("release approval through a decision", ["space_ask_operator.action"], true),
  entry("ask the operator", ["space_ask_operator"], true), entry("withdraw a decision", ["space_withdraw_decision"]), entry("merge-queue status", ["space_room_status", "space_queue_status"]),
  entry("own notes", ["space_note"], true), entry("Space Memory recall", ["space_memory_recall"]), entry("Space Memory save", ["space_memory_save"]),
  entry("query the monitor feed", ["space_room_status"]), entry("worktree and overlap view", ["space_room_status"]),
  entry("service status and logs", []), entry("token and gateway usage", [])
];

export interface NousDimensionScore { score: number; baseline: number; change: number; sample: number; note: string }

/**
 * Round 9 item 3 (unblocking 52.6, "1 of 8 answered by Nous"): who ended a wait, read from the monitor event's status and the decision
 * its closer wrote. `byAgent` is true only for Nous, the Room Agent or a text Space sent for them; the operator and the pane itself never.
 */
export function waitCloser(event: Pick<RoomAgentEvent, "status" | "decision">): { who: string; byAgent: boolean } {
  const decision = event.decision ?? "";
  if (event.status === "OPEN") return { who: "nobody yet (open: minutes counted to now)", byAgent: false };
  if (event.status === "ACKED") return { who: "the operator (acknowledged)", byAgent: false };
  if (event.status === "ESCALATED") return { who: "the operator (escalated to them)", byAgent: false };
  if (event.status === "RESOLVED" && decision === "The room was deleted.") return { who: "nobody (the room was deleted)", byAgent: false };
  if (event.status === "RESOLVED") return { who: /Space Gateway/.test(decision) ? "Space (moved to Space Gateway)" : "the pane itself (it moved on)", byAgent: false };
  if (/^Nous (sent|answered|declined)/.test(decision)) return { who: "Nous (a send or an answer)", byAgent: true };
  if (/^A text Space sent for Nous or the Room Agent reached the pane/.test(decision)) return { who: "a text Space sent for Nous or the Room Agent", byAgent: true };
  if (/^A coordination text Space sent for Nous or the Room Agent/.test(decision)) return { who: "a coordination text Space sent for Nous or the Room Agent", byAgent: true };
  if (/^The pane continued on its own/.test(decision)) return { who: "the pane itself (it continued on its own)", byAgent: false };
  if (/^You (answered|declined)/.test(decision)) return { who: "the operator (in the Room Agent)", byAgent: false };
  if (/^The Room Agent (sent|answered|declined)/.test(decision)) return { who: "the Room Agent (a send or an answer)", byAgent: true };
  if (/^(Answered "|Told the pane to continue|The Room Agent is coordinating)/.test(decision)) return { who: "the Room Agent autopilot", byAgent: true };
  if (/Space Gateway/.test(decision)) return { who: "Space (moved to Space Gateway)", byAgent: true };
  return { who: `unknown (${decision || "no decision recorded"})`, byAgent: false };
}

/** A wait's question: the first line of what the pane asked (its detail), else its title without "<pane> is waiting: ". */
export const waitQuestion = (event: Pick<RoomAgentEvent, "title" | "detail">) =>
  ((event.detail ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? event.title.replace(/^.*? is waiting: /, ""));

/**
 * R10-4 (unblocking 55.4: 8 of the sample's 9 waits ended by the pane itself in 0.7-2.6 min): a wait the pane ended by itself within
 * 3 minutes with no agent's answer was closed by its CLI (Claude Code denies its removal prompt by itself after 2 minutes). It stays in
 * the list and in the raw v1 score, and leaves the adjusted one.
 */
export const NOUS_CLI_CLOSED_MS = 3 * 60_000;

/** R11-1: turns that failed or timed out, by cause (R17-2: quota). */
/**
 * R66 (5/11 brief: "77 SYSTEM_PROMPT failures in 7 days", all 31/10 and 1/11, both fixed by then): an incident cause names when it last
 * happened, so a count that only waits to leave the window is not read as a live cause.
 */
export interface NousFailureCauses { gateway: number; quota: number; system_prompt: number; timeout: number; other: number; systemPromptLast?: string }
export function failureCauses(facts: Array<Pick<NousTurnFacts, "status" | "error"> & Partial<Pick<NousTurnFacts, "tools" | "startedAt" | "endedAt">>>): NousFailureCauses {
  const causes: NousFailureCauses = { gateway: 0, quota: 0, system_prompt: 0, timeout: 0, other: 0 };
  const outage = outageSignature(facts);
  for (const turn of facts) {
    const cause = outage.has(turn) ? "gateway" : nousFailureCause(turn);
    if (cause) causes[cause] += 1;
    const at = cause === "system_prompt" ? turn.endedAt ?? turn.startedAt : undefined;
    if (at && (!causes.systemPromptLast || at > causes.systemPromptLast)) causes.systemPromptLast = at;
  }
  return causes;
}

/**
 * R16-4 (28/10 23:02 → 29/10 01:13 UTC: 70 turns FAILED at 171-190 s with no tool call and no error, written before migration 0261): a FAILED
 * turn with no error (R38-1: or the fixed no-message reason), no tool call and 150-200 s long, in a run of 3 or more such turns each within 10 minutes of the one before, is an outage.
 */
function outageSignature<T extends Partial<Pick<NousTurnFacts, "status" | "error" | "tools" | "startedAt" | "endedAt">>>(facts: T[]): Set<T> {
  const signed = facts.filter((turn) => turn.status === "FAILED" && (!turn.error || turn.error === NOUS_TURN_FAILED_NO_ERROR) && turn.tools && Object.values(turn.tools).every((tool) => tool.calls === 0)
    && turn.startedAt && turn.endedAt && Date.parse(turn.endedAt) - Date.parse(turn.startedAt) >= 150_000 && Date.parse(turn.endedAt) - Date.parse(turn.startedAt) <= 200_000)
    .sort((left, right) => left.startedAt!.localeCompare(right.startedAt!));
  const outage = new Set<T>();
  let run: T[] = [];
  const close = () => { if (run.length >= 3) for (const turn of run) outage.add(turn); run = []; };
  for (const turn of signed) {
    if (run.length && Date.parse(turn.startedAt!) - Date.parse(run.at(-1)!.startedAt!) > 600_000) close();
    run.push(turn);
  }
  close();
  return outage;
}
export const failureCausesText = (causes: NousFailureCauses) => `gateway ${causes.gateway}, ${causes.quota ? `quota ${causes.quota}, ` : ""}`
  + `${causes.system_prompt ? `SYSTEM_PROMPT ${causes.system_prompt} (the worker refused the turn's prompt or system prompt${causes.systemPromptLast
    ? `; the last at ${causes.systemPromptLast.slice(0, 16).replace("T", " ")} UTC` : ""}), ` : ""}timeout ${causes.timeout}, other ${causes.other}`;

/** R10-6: OVERLAP notices (two worktrees change the same files, a conflict, work outside a release): how many, on how many pairs, who ended them. */
export interface NousCoordination { notices: number; pairs: number; byAgent: number; minutes: number }
export function coordinationOf(events: RoomAgentEvent[], now: number): NousCoordination | null {
  const overlaps = events.filter((event) => event.kind === "OVERLAP");
  if (!overlaps.length) return null;
  const end = (event: RoomAgentEvent) => event.status === "OPEN" || event.status === "ESCALATED" ? now : Date.parse(event.updatedAt);
  return { notices: overlaps.length, pairs: new Set(overlaps.map((event) => event.title)).size, byAgent: overlaps.filter((event) => waitCloser(event).byAgent).length,
    minutes: round(median(overlaps.map((event) => (end(event) - Date.parse(event.createdAt)) / 60_000))) };
}
export const coordinationText = (value: NousCoordination) => `${value.notices} notice${value.notices === 1 ? "" : "s"} on ${value.pairs} pair${value.pairs === 1 ? "" : "s"}, `
  + `${value.byAgent} answered by an agent, median ${value.minutes} min`;

/** One wait of the unblocking sample, as space_nous_progress lists it. `scored`: how the unblocking share counts it. */
export interface NousWaitRow {
  at: string; pane: string; kind: string; question: string; minutes: number; closer: string; byAgent: boolean; scored: "ANSWERED" | "NOT_ANSWERED" | "OPEN" | "SPEED_ONLY";
  /** R10-4: closed by the pane's CLI within 3 minutes, out of the adjusted share. */
  closedByCli?: boolean;
}
export interface NousScorecard {
  version: 1;
  baselineDate: string;
  window: { from: string; to: string; turns: number };
  /** Fewer turns than NOUS_SCORECARD_MIN_TURNS: the numbers are shown, but Nous says there is not enough data yet. */
  enoughData: boolean;
  overall: number; baselineOverall: number; changePoints: number; changePercent: number;
  dimensions: Record<NousDimension, NousDimensionScore>;
  /** The Score view's line (plan clipboard:1NF6u6gcCwtj): points that open plans and requests cost, outside the v1 score. */
  score?: string;
  /** Goal 7365014c-a: answers as Nous predicted over the window (its own dimension, outside the frozen v1 weights). */
  predictions?: { decisions: { matched: number; total: number }; cards: { matched: number; total: number } };
  /** Round 9 item 3: every wait in the unblocking sample, newest first (at most 40). */
  waits?: NousWaitRow[];
  /** R10-4: unblocking without the waits the CLI closed itself within 3 minutes (the v1 dimension stays the raw figure). */
  unblockingAdjusted?: { score: number; sample: number; left: number; note: string };
  /** R12-9: reliability without the OUTAGE turns (Space Gateway refused or was unreachable); the v1 dimension stays the raw figure. */
  reliabilityAdjusted?: { score: number; sample: number; note: string };
  /** R10-6: OVERLAP notices of the sample, coordination rather than waits (their own line, out of the waits list and the adjusted score). */
  coordination?: NousCoordination;
  /** What the weekly review reads (nous-failures). */
  failures: { tools: Array<{ name: string; failed: number; /** The 5 most failing tools' 3 most frequent errors (8/11), the first text of each kind. */ errors?: Array<{ text: string; count: number }> }>; missing: string[]; corrections: string[]; staleDecisions: string[]; couldHaveDecided: string[];
    /** R11-1: failed and timed-out turns by cause (the v1 reliability figure counts every one). */
    byCause?: NousFailureCauses;
    /** R30-2: calls a gate held back (REFUSED: a lesson hold, a duplicate ask); never a reliability mistake. */
    gates?: Array<{ name: string; held: number }> };
}
/** Brief tool-error-samples (8/11): a turn keeps up to 3 failed calls' texts per tool, 200 characters each (the brief's bound: a turn's facts row
 * stays small); the counts still count every failure, and the turn's own TOOL messages keep every whole text. */
export const NOUS_TOOL_ERROR_SAMPLES = 3;
const NOUS_TOOL_ERROR_CHARS = 200;
type NousToolCounts = NousTurnFacts["tools"][string];
export function addToolErrorSample(tool: NousToolCounts, text: string): void {
  const errors = tool.errors ??= [];
  const sample = redactMemoryText(text.trim());
  if (errors.length < NOUS_TOOL_ERROR_SAMPLES) errors.push(sample.length > NOUS_TOOL_ERROR_CHARS ? `${sample.slice(0, NOUS_TOOL_ERROR_CHARS - 1)}…` : sample);
}
/** A tool's error texts in one turn; rows before 8/11 kept only the first, as `error`. */
export const toolErrorSamples = (tool: NousToolCounts): string[] => tool.errors ?? (tool.error ? [tool.error] : []);
/** The same error with other ids, numbers or paths' numbered parts: any word holding a digit becomes #. */
export const toolErrorKey = (text: string) => text.replace(/[\w:.-]*\d[\w:.-]*/g, "#");

export interface NousScorecardInput {
  now: number;
  facts: NousTurnFacts[];
  decisions: NousDecision[];
  /** Monitor events of the owner's rooms. */
  events: RoomAgentEvent[];
  tools: Array<{ name: string; inputSchema: Record<string, unknown> }>;
}

const round = (value: number) => Math.round(value * 10) / 10;
const weighted = (scores: Record<NousDimension, number>) => round((Object.keys(NOUS_WEIGHTS) as NousDimension[]).reduce((sum, key) => sum + NOUS_WEIGHTS[key] * scores[key], 0));
const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

export function nousCatalogCoverage(tools: NousScorecardInput["tools"]): { reachable: number; total: number } {
  const reaches = (ref: string) => {
    const [name, argument] = ref.split(".");
    const tool = tools.find((candidate) => candidate.name === name);
    return Boolean(tool && (!argument || argument in ((tool.inputSchema.properties as Record<string, unknown> | undefined) ?? {})));
  };
  return { reachable: NOUS_CATALOG_V1.filter((item) => item.reach.some(reaches)).length, total: NOUS_CATALOG_V1.length };
}

export function nousScorecard(input: NousScorecardInput): NousScorecard {
  const { now } = input;
  const from = now - NOUS_SCORECARD_WINDOW_DAYS * DAY_MS;
  const facts = input.facts.filter((turn) => Date.parse(turn.startedAt) >= from);
  const outcomes = facts.flatMap((turn) => turn.outcomes);
  const measured: Partial<Record<NousDimension, { score: number; sample: number; note: string }>> = {};

  const self = outcomes.filter((item) => item.outcome === "SELF").length;
  const helper = outcomes.filter((item) => item.outcome === "HELPER").length;
  if (self + helper) measured.autonomy = { score: 100 * self / (self + helper), sample: self + helper, note: `${self} done itself, ${helper} by a helper pane` };

  const coverage = nousCatalogCoverage(input.tools);
  measured.coverage = { score: 100 * coverage.reachable / coverage.total, sample: coverage.total, note: `${coverage.reachable} of ${coverage.total} actions` };

  // Waits whose answer is the operator's (the Room Agent escalated them, or Nous asked a decision about that pane during the wait
  // or within 5 minutes after it: it leaves the prompt first, then asks) are left out.
  const decisions = input.decisions.filter((decision) => Date.parse(decision.createdAt) >= from);
  const end = (event: RoomAgentEvent) => ["HANDLED", "RESOLVED", "ACKED"].includes(event.status) ? Date.parse(event.updatedAt) : now;
  const operatorsWait = (event: RoomAgentEvent) => event.status === "ESCALATED" || (event.kind !== "OVERLAP" && input.decisions.some((decision) =>
    decision.refs.paneId === event.paneId && Date.parse(decision.createdAt) <= end(event) + 5 * 60_000 && (decision.answeredAt ? Date.parse(decision.answeredAt) : now) >= Date.parse(event.createdAt)));
  // Item 29a: a wait the pane left by itself within 30 s is a detector flicker, not a wait anyone could answer (4 of 11 in 20-27/10).
  const flicker = (event: RoomAgentEvent) => event.status === "RESOLVED" && end(event) - Date.parse(event.createdAt) < 30_000;
  const waits = input.events.filter((event) => ["WAITING", "STUCK", "OVERLAP"].includes(event.kind) && Date.parse(event.createdAt) >= from && !operatorsWait(event) && !flicker(event));
  const unblockingOf = (sample: RoomAgentEvent[]) => {
    const minutes = median(sample.map((event) => (end(event) - Date.parse(event.createdAt)) / 60_000));
    const speed = Math.max(0, 1 - minutes / 30);
    // An answered prompt is Nous's (HANDLED: through its tools); a pane that moved on or an operator's ack is not. OVERLAPs count for speed only.
    const closed = sample.filter((event) => event.kind !== "OVERLAP" && event.status !== "OPEN");
    const handled = closed.filter((event) => event.status === "HANDLED").length;
    // No answered prompt in the window: speed alone.
    const share = closed.length ? handled / closed.length : speed;
    return { score: 100 * (speed + share) / 2, sample: sample.length, note: `median ${round(minutes)} min, ${handled} of ${closed.length} answered by Nous` };
  };
  const closedByCli = (event: RoomAgentEvent) => event.kind !== "OVERLAP" && waitCloser(event).who.startsWith("the pane itself") && end(event) - Date.parse(event.createdAt) < NOUS_CLI_CLOSED_MS;
  let unblockingAdjusted: NousScorecard["unblockingAdjusted"];
  if (waits.length) {
    measured.unblocking = unblockingOf(waits);
    // R10-6: OVERLAP notices are coordination, not panes waiting at a prompt: out of the adjusted score (the v1 figure keeps them for speed).
    const kept = waits.filter((event) => event.kind !== "OVERLAP" && !closedByCli(event));
    const cli = waits.filter(closedByCli).length;
    const overlaps = waits.filter((event) => event.kind === "OVERLAP").length;
    const left = cli + overlaps;
    const out = [cli ? `${cli} closed by the CLI within 3 min` : "", overlaps ? `${overlaps} coordination notice${overlaps === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ");
    if (kept.length) {
      const adjusted = unblockingOf(kept);
      unblockingAdjusted = { score: round(adjusted.score), sample: kept.length, left, note: `${adjusted.note}${out ? `; ${out} left out` : ""}` };
    } else unblockingAdjusted = { score: round(measured.unblocking.score), sample: 0, left, note: `no wait left (${out})` };
  }
  const coordination = coordinationOf(waits, now);
  const waitRows: NousWaitRow[] = waits.filter((event) => event.kind !== "OVERLAP").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((event) => {
    const closer = waitCloser(event);
    return { at: event.createdAt, pane: event.paneName ?? event.paneId ?? event.roomId, kind: event.kind, question: waitQuestion(event),
      minutes: round((end(event) - Date.parse(event.createdAt)) / 60_000), closer: closer.who, byAgent: closer.byAgent,
      scored: event.kind === "OVERLAP" ? "SPEED_ONLY" : event.status === "OPEN" ? "OPEN" : event.status === "HANDLED" ? "ANSWERED" : "NOT_ANSWERED",
      ...(closedByCli(event) ? { closedByCli: true } : {}) };
  });

  if (facts.length) {
    const days = Math.max(1, (now - Math.max(from, Math.min(...facts.map((turn) => Date.parse(turn.startedAt))))) / DAY_MS);
    const points = facts.reduce((sum, turn) => sum + turn.planPoints, 0);
    measured.planMovement = { score: Math.min(100, points / days), sample: facts.length, note: `${points} plan points in ${round(days)} days` };
  }

  const stale = decisions.filter((decision) => (decision.status === "CANCELLED" && (decision.answer ?? "").startsWith("Withdrawn by Nous"))
    || (decision.status === "OPEN" && !nousDecisionRunsWhen(decision) && now - Date.parse(decision.createdAt) > DAY_MS));
  const small = decisions.filter((decision) => decision.couldHaveDecided && !stale.includes(decision));
  // R37: an ask replaced by its corrected one (space_ask_operator replaces) is counted on its own line, not as stale.
  const replaced = decisions.filter((decision) => decision.status === "CANCELLED" && (decision.answer ?? "").startsWith("Replaced by "));
  const missed = outcomes.filter((item) => item.correction && item.outcome === "OPERATOR");
  if (decisions.length + missed.length) {
    measured.escalation = { score: 100 * (decisions.length - stale.length - small.length) / (decisions.length + missed.length), sample: decisions.length + missed.length,
      note: `${decisions.length} asked, ${stale.length} stale, ${replaced.length ? `${replaced.length} replaced, ` : ""}${small.length} it could have decided, ${missed.length} missed` };
  }

  const corrections = outcomes.filter((item) => item.correction && item.outcome !== "OPERATOR");
  let reliabilityAdjusted: NousScorecard["reliabilityAdjusted"];
  if (facts.length) {
    const toolMistakes = facts.reduce((sum, turn) => sum + Object.values(turn.tools).reduce((inner, tool) => inner + tool.failed - tool.refused, 0), 0);
    const failedTurns = facts.filter((turn) => turn.status === "FAILED" || turn.status === "TIMEOUT").length;
    const mistakes = toolMistakes + failedTurns + corrections.length;
    measured.reliability = { score: 100 * Math.max(0, 1 - mistakes / facts.length), sample: facts.length,
      note: `${mistakes} mistakes in ${facts.length} turns (${toolMistakes} tool, ${failedTurns} turn, ${corrections.length} corrections)` };
    // R17-2: QUOTA turns (no account had quota) leave it like OUTAGE turns.
    const { gateway, quota } = failureCauses(facts);
    const outage = gateway + quota;
    reliabilityAdjusted = { score: round(facts.length > outage ? 100 * Math.max(0, 1 - (mistakes - outage) / (facts.length - outage)) : measured.reliability.score),
      sample: facts.length - outage, note: `${gateway} OUTAGE turn${gateway === 1 ? "" : "s"} (Space Gateway refused or unreachable)${quota ? `, ${quota} QUOTA turn${quota === 1 ? "" : "s"} (no account had quota)` : ""} left out` };
  }

  const dimensions = Object.fromEntries((Object.keys(NOUS_WEIGHTS) as NousDimension[]).map((key) => {
    const baseline = NOUS_BASELINE.dimensions[key];
    const value = measured[key];
    const score = round(value?.score ?? baseline);
    return [key, { score, baseline, change: round(score - baseline), sample: value?.sample ?? 0, note: value?.note ?? "no data in the window: baseline kept" }];
  })) as Record<NousDimension, NousDimensionScore>;
  const overall = weighted(Object.fromEntries(Object.entries(dimensions).map(([key, value]) => [key, value.score])) as Record<NousDimension, number>);
  const baselineOverall = weighted(NOUS_BASELINE.dimensions);

  const toolFailures = new Map<string, number>();
  const toolErrors = new Map<string, Map<string, { text: string; count: number }>>();
  const gates = new Map<string, number>();
  for (const turn of facts) for (const [name, tool] of Object.entries(turn.tools)) {
    if (tool.failed > tool.refused) toolFailures.set(name, (toolFailures.get(name) ?? 0) + tool.failed - tool.refused);
    if (tool.refused) gates.set(name, (gates.get(name) ?? 0) + tool.refused);
    for (const text of toolErrorSamples(tool)) {
      const kinds = toolErrors.get(name) ?? new Map<string, { text: string; count: number }>();
      const kind = kinds.get(toolErrorKey(text)) ?? { text, count: 0 };
      kind.count += 1;
      kinds.set(toolErrorKey(text), kind);
      toolErrors.set(name, kinds);
    }
  }
  const failedTools = [...toolFailures].map(([name, failed]) => ({ name, failed })).sort((left, right) => right.failed - left.failed);
  return {
    version: 1, baselineDate: NOUS_BASELINE.date,
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), turns: facts.length },
    enoughData: facts.length >= NOUS_SCORECARD_MIN_TURNS,
    overall, baselineOverall, changePoints: round(overall - baselineOverall), changePercent: round(100 * (overall - baselineOverall) / baselineOverall),
    dimensions,
    waits: waitRows,
    ...(unblockingAdjusted ? { unblockingAdjusted } : {}),
    ...(reliabilityAdjusted ? { reliabilityAdjusted } : {}),
    ...(coordination ? { coordination } : {}),
    failures: {
      // Brief tool-error-samples: the top 5 tools' top 3 kinds, so the review sees why they fail (every kind stays in the turns' facts).
      tools: failedTools.map((tool, index) => {
        const kinds = index < 5 ? [...(toolErrors.get(tool.name)?.values() ?? [])].sort((left, right) => right.count - left.count).slice(0, 3) : [];
        return kinds.length ? { ...tool, errors: kinds } : tool;
      }),
      missing: [...new Set(outcomes.filter((item) => item.outcome === "HELPER" && item.missing).map((item) => item.missing!))],
      corrections: [...corrections, ...missed].map((item) => item.summary),
      staleDecisions: stale.map((decision) => decision.title),
      couldHaveDecided: small.map((decision) => decision.title),
      byCause: failureCauses(facts),
      gates: [...gates].map(([name, held]) => ({ name, held })).sort((left, right) => right.held - left.held)
    }
  };
}

const signed = (value: number) => `${value >= 0 ? "+" : ""}${value}`;

/** What space_nous_progress tells Nous, to answer "how much have you improved". */
export function nousProgressText(card: NousScorecard): string {
  const lines = [
    `Score ${card.overall} against ${card.baselineOverall} on ${card.baselineDate}: ${signed(card.changePercent)}% (${signed(card.changePoints)} points).`,
    `Window: ${card.window.from.slice(0, 10)} to ${card.window.to.slice(0, 10)}, ${card.window.turns} turns.`
      + (card.enoughData ? "" : ` Not enough data yet (at least ${NOUS_SCORECARD_MIN_TURNS} turns): say so and give the counts.`),
    ...(card.score ? [card.score] : []),
    ...(Object.entries(card.dimensions) as Array<[NousDimension, NousDimensionScore]>).map(([key, value]) =>
      `- ${key} ${value.score} (${signed(value.change)} vs ${value.baseline}; weight ${NOUS_WEIGHTS[key] * 100}%): ${value.note}`)
  ];
  if (card.unblockingAdjusted) lines.push(`- unblocking adjusted ${card.unblockingAdjusted.score} (raw ${card.dimensions.unblocking.score}; not in the v1 score): ${card.unblockingAdjusted.note}`);
  if (card.reliabilityAdjusted) lines.push(`- reliability adjusted ${card.reliabilityAdjusted.score} (raw ${card.dimensions.reliability.score}; not in the v1 score): ${card.reliabilityAdjusted.note}`);
  if (card.coordination) lines.push(`- coordination (OVERLAP notices: coordination, not waits; outside the waits list and the adjusted score): ${coordinationText(card.coordination)}`);
  if (card.predictions) lines.push(`- prediction (own dimension, not in the v1 score): decisions ${predictionText(card.predictions.decisions)}, cards ${predictionText(card.predictions.cards)}`);
  if (card.waits?.length) {
    // Round 9 item 3: each wait of the unblocking sample, so every one nobody answered becomes a queue item.
    lines.push(`Waits in the unblocking sample (${card.waits.length}, newest first; one not answered by Nous, the Room Agent or a text Space sent is a queue item):`,
      ...card.waits.map((wait) => `- ${wait.at.slice(0, 16).replace("T", " ")} UTC ${wait.pane} ${wait.kind} "${wait.question}": ${wait.minutes} min, closed by ${wait.closer}`
        + `${wait.byAgent ? "" : wait.scored === "OPEN" ? "" : " (UNANSWERED by an agent)"}${wait.scored === "ANSWERED" && !wait.byAgent ? " (the score counts it as answered)" : ""}`
        + (wait.closedByCli ? " (closed by its CLI within 3 min: out of the adjusted score)" : "")));
  }
  if (card.failures.missing.length) lines.push(`Missing tools you reported: ${card.failures.missing.join("; ")}`);
  if (card.failures.byCause && Object.values(card.failures.byCause).some(Boolean)) lines.push(`Turn failures by cause (the v1 reliability figure counts every one): ${failureCausesText(card.failures.byCause)}`);
  if (card.failures.tools.length) lines.push(`Failed tools: ${card.failures.tools.map((tool) => `${tool.name} ${tool.failed}`).join(", ")}`,
    ...card.failures.tools.filter((tool) => tool.errors?.length).map((tool) => `- ${tool.name} errors (sampled up to ${NOUS_TOOL_ERROR_SAMPLES} per turn; same text with other ids or numbers counted together): `
      + tool.errors!.map((error) => `"${error.text}" ×${error.count}`).join("; ")));
  if (card.failures.gates?.length) lines.push(`GATE (held by a gate, not mistakes): ${card.failures.gates.map((tool) => `${tool.name} ${tool.held}`).join(", ")}`);
  return lines.join("\n");
}
