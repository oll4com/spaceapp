import type { NousDecision, NousTurnFacts, RoomAgentEvent } from "@space/contracts";
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
export interface NousScorecard {
  version: 1;
  baselineDate: string;
  window: { from: string; to: string; turns: number };
  /** Fewer turns than NOUS_SCORECARD_MIN_TURNS: the numbers are shown, but Nous says there is not enough data yet. */
  enoughData: boolean;
  overall: number; baselineOverall: number; changePoints: number; changePercent: number;
  dimensions: Record<NousDimension, NousDimensionScore>;
  /** Goal 7365014c-a: answers as Nous predicted over the window (its own dimension, outside the frozen v1 weights). */
  predictions?: { decisions: { matched: number; total: number }; cards: { matched: number; total: number } };
  /** What the weekly review reads (nous-failures). */
  failures: { tools: Array<{ name: string; failed: number }>; missing: string[]; corrections: string[]; staleDecisions: string[]; couldHaveDecided: string[] };
}
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
  if (waits.length) {
    const minutes = median(waits.map((event) => (end(event) - Date.parse(event.createdAt)) / 60_000));
    const speed = Math.max(0, 1 - minutes / 30);
    // An answered prompt is Nous's (HANDLED: through its tools); a pane that moved on or an operator's ack is not. OVERLAPs count for speed only.
    const closed = waits.filter((event) => event.kind !== "OVERLAP" && event.status !== "OPEN");
    // No answered prompt in the window: speed alone.
    const share = closed.length ? closed.filter((event) => event.status === "HANDLED").length / closed.length : speed;
    measured.unblocking = { score: 100 * (speed + share) / 2, sample: waits.length, note: `median ${round(minutes)} min, ${closed.filter((event) => event.status === "HANDLED").length} of ${closed.length} answered by Nous` };
  }

  if (facts.length) {
    const days = Math.max(1, (now - Math.max(from, Math.min(...facts.map((turn) => Date.parse(turn.startedAt))))) / DAY_MS);
    const points = facts.reduce((sum, turn) => sum + turn.planPoints, 0);
    measured.planMovement = { score: Math.min(100, points / days), sample: facts.length, note: `${points} plan points in ${round(days)} days` };
  }

  const stale = decisions.filter((decision) => (decision.status === "CANCELLED" && (decision.answer ?? "").startsWith("Withdrawn by Nous"))
    || (decision.status === "OPEN" && now - Date.parse(decision.createdAt) > DAY_MS));
  const small = decisions.filter((decision) => decision.couldHaveDecided && !stale.includes(decision));
  const missed = outcomes.filter((item) => item.correction && item.outcome === "OPERATOR");
  if (decisions.length + missed.length) {
    measured.escalation = { score: 100 * (decisions.length - stale.length - small.length) / (decisions.length + missed.length), sample: decisions.length + missed.length,
      note: `${decisions.length} asked, ${stale.length} stale, ${small.length} it could have decided, ${missed.length} missed` };
  }

  const corrections = outcomes.filter((item) => item.correction && item.outcome !== "OPERATOR");
  if (facts.length) {
    const toolMistakes = facts.reduce((sum, turn) => sum + Object.values(turn.tools).reduce((inner, tool) => inner + tool.failed - tool.refused, 0), 0);
    const failedTurns = facts.filter((turn) => turn.status === "FAILED" || turn.status === "TIMEOUT").length;
    const mistakes = toolMistakes + failedTurns + corrections.length;
    measured.reliability = { score: 100 * Math.max(0, 1 - mistakes / facts.length), sample: facts.length,
      note: `${mistakes} mistakes in ${facts.length} turns (${toolMistakes} tool, ${failedTurns} turn, ${corrections.length} corrections)` };
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
  for (const turn of facts) for (const [name, tool] of Object.entries(turn.tools)) if (tool.failed > tool.refused) toolFailures.set(name, (toolFailures.get(name) ?? 0) + tool.failed - tool.refused);
  return {
    version: 1, baselineDate: NOUS_BASELINE.date,
    window: { from: new Date(from).toISOString(), to: new Date(now).toISOString(), turns: facts.length },
    enoughData: facts.length >= NOUS_SCORECARD_MIN_TURNS,
    overall, baselineOverall, changePoints: round(overall - baselineOverall), changePercent: round(100 * (overall - baselineOverall) / baselineOverall),
    dimensions,
    failures: {
      tools: [...toolFailures].map(([name, failed]) => ({ name, failed })).sort((left, right) => right.failed - left.failed).slice(0, 10),
      missing: [...new Set(outcomes.filter((item) => item.outcome === "HELPER" && item.missing).map((item) => item.missing!))].slice(0, 20),
      corrections: [...corrections, ...missed].map((item) => item.summary).slice(0, 20),
      staleDecisions: stale.map((decision) => decision.title).slice(0, 20),
      couldHaveDecided: small.map((decision) => decision.title).slice(0, 20)
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
    ...(Object.entries(card.dimensions) as Array<[NousDimension, NousDimensionScore]>).map(([key, value]) =>
      `- ${key} ${value.score} (${signed(value.change)} vs ${value.baseline}; weight ${NOUS_WEIGHTS[key] * 100}%): ${value.note}`)
  ];
  if (card.predictions) lines.push(`- prediction (own dimension, not in the v1 score): decisions ${predictionText(card.predictions.decisions)}, cards ${predictionText(card.predictions.cards)}`);
  if (card.failures.missing.length) lines.push(`Missing tools you reported: ${card.failures.missing.join("; ")}`);
  if (card.failures.tools.length) lines.push(`Failed tools: ${card.failures.tools.map((tool) => `${tool.name} ${tool.failed}`).join(", ")}`);
  return lines.join("\n");
}
