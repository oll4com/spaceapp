import type { NousDecision, NousTurnFacts } from "@space/contracts";

/**
 * Nous's daily self-review (operator decision 2026-10-24): Space itself brings Nous, once a day at the operator's chosen hour, the
 * last 24 hours of its own turn facts (turns, failures, the tools that failed most, the decisions the operator answered and the
 * corrections) and asks it to turn the repeated causes into lessons. Until then the review was a scheduled task typed into a pane,
 * and that pane kept getting lost (skipped on 21/10 and 23/10).
 */
export const NOUS_REVIEW_WINDOW_MS = 24 * 3_600_000;
export const NOUS_REVIEW_TOP_TOOLS = 10;

/** The operator's local day and hour in their working time zone (an unknown zone reads as UTC). */
export function localDayHour(at: number, timeZone: string): { day: string; hour: number } {
  const parts = (zone: string) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(at));
  let list: Intl.DateTimeFormatPart[];
  try { list = parts(timeZone); } catch { list = parts("UTC"); }
  const get = (type: Intl.DateTimeFormatPartTypes) => list.find((part) => part.type === type)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, hour: Number.parseInt(get("hour"), 10) || 0 };
}

export interface DailyReviewInput { facts: NousTurnFacts[]; decisions: NousDecision[]; since: string; day: string; hour: number }

/** The review turn's text: the figures Space can count, then the orders. */
export function renderDailyReview({ facts, decisions, since, day, hour }: DailyReviewInput): string {
  const window = facts.filter((turn) => turn.startedAt >= since && turn.reason !== "REVIEW");
  const byReason = new Map<string, { turns: number; failed: number }>();
  for (const turn of window) {
    const entry = byReason.get(turn.reason) ?? { turns: 0, failed: 0 };
    entry.turns += 1;
    if (turn.status !== "DONE") entry.failed += 1;
    byReason.set(turn.reason, entry);
  }
  const tools = new Map<string, { calls: number; failed: number; refused: number }>();
  for (const turn of window) {
    for (const [name, counts] of Object.entries(turn.tools)) {
      const entry = tools.get(name) ?? { calls: 0, failed: 0, refused: 0 };
      entry.calls += counts.calls; entry.failed += counts.failed; entry.refused += counts.refused;
      tools.set(name, entry);
    }
  }
  const totals = [...tools.values()].reduce((sum, entry) => ({ calls: sum.calls + entry.calls, failed: sum.failed + entry.failed, refused: sum.refused + entry.refused }), { calls: 0, failed: 0, refused: 0 });
  const mistakes = [...tools.entries()].map(([name, entry]) => ({ name, mistakes: entry.failed - entry.refused, calls: entry.calls })).filter((entry) => entry.mistakes > 0)
    .sort((a, b) => b.mistakes - a.mistakes || a.name.localeCompare(b.name)).slice(0, NOUS_REVIEW_TOP_TOOLS);
  const answered = decisions.filter((decision) => decision.status !== "OPEN" && decision.status !== "CANCELLED" && (decision.answeredAt ?? "") >= since);
  const count = (status: NousDecision["status"]) => answered.filter((decision) => decision.status === status).length;
  const corrections = window.flatMap((turn) => turn.outcomes.filter((outcome) => outcome.correction).map((outcome) => outcome.summary));
  const failedTurns = window.filter((turn) => turn.status !== "DONE").length;
  return [
    `# Daily self-review (from Space, not the operator; once a day at ${String(hour).padStart(2, "0")}:00 in the operator's zone; today ${day})`,
    "## The last 24 hours, from your own turn facts",
    `- Turns: ${window.length} (${[...byReason.entries()].map(([reason, entry]) => `${reason} ${entry.turns}${entry.failed ? `, ${entry.failed} failed` : ""}`).join("; ") || "none"}); turns that failed, timed out or were stopped: ${failedTurns}`,
    `- Tool calls: ${totals.calls}; mistakes (failed calls that were not a gate holding back): ${totals.failed - totals.refused}; held by a gate: ${totals.refused}`,
    `- Tools that failed most: ${mistakes.length ? mistakes.map((entry) => `${entry.name} ${entry.mistakes} of ${entry.calls}`).join(", ") : "none"}`,
    `- Decisions the operator answered: ${answered.length} (approved ${count("APPROVED")}, declined ${count("DECLINED")}, in words ${count("ANSWERED")}); "you could have decided this": ${answered.filter((decision) => decision.couldHaveDecided === true).length}`,
    `- Corrections by the operator: ${corrections.length}${corrections.length ? `: ${corrections.slice(0, 10).map((summary) => `"${summary.slice(0, 120)}"`).join("; ")}` : ""}`,
    "## Orders",
    "1. Read space_nous_progress (your scorecard) and space_nous_decisions (approved actions that failed).",
    "2. Find the repeated causes behind the failed tool calls and the corrections above (read the tool rows of those turns in the conversation if needed). For each cause, update your note \"lessons\" (space_note): one lesson per cause (what went wrong, why it mattered, what to do instead), merge duplicates, delete a lesson that turned out wrong.",
    `3. Save one Space Memory entry titled "Nous daily review ${day}" tagged nous-review (space_memory_save) with the figures above and the lessons you changed; tag operator-rule only when the operator's own words set a rule.`,
    "4. End with five lines: turns and failures, lessons changed, what you will do differently from today, what needs the operator (nothing: say so). No helpers for this turn; no new decisions unless a failure needs the operator's hands."
  ].join("\n");
}
