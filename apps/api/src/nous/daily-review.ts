import type { NousDecision, NousTurnFacts, SpaceNotification } from "@space/contracts";
import type { NousLedgerRow, RailDecisionCount } from "@space/db";
import { NOUS_GENERAL_NOTICE_KEY, NOUS_PANE_NOTICE_PREFIX } from "./pane-notices.js";
import { predictionAccuracy, predictionText } from "./predictions.js";

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

/** cards: Nous's NOUS notifications (its cards and focus requests are the same record since 2026-10-24). */
export interface DailyReviewInput {
  facts: NousTurnFacts[]; decisions: NousDecision[]; cards?: SpaceNotification[]; rails?: RailDecisionCount[] | null; ledger?: NousLedgerRow[]; since: string; day: string; hour: number;
}

/** Goal 7365014c-e: the ledger's answers, how many went as predicted, and the misses to learn from (at most 10). */
export function ledgerLines(rows: NousLedgerRow[]): string[] {
  const scored = rows.filter((row) => row.match !== null);
  const misses = scored.filter((row) => row.match === false);
  return [`- ${rows.length} answers, ${scored.length - misses.length} of ${scored.length} with a prediction went as predicted`,
    ...misses.slice(0, 10).map((row) => `- Miss [${row.source}] "${row.title.slice(0, 120)}": predicted ${row.predicted}, answered "${row.answer.slice(0, 160)}"`)];
}

const RAIL_KINDS: Record<string, string> = { REVIEW_DECIDED: "reviews", RULE_DECIDED: "rules", CAMPAIGN_DECIDED: "campaigns", LEAD_DECIDED: "leads", ANSWERED: "questions" };

/** Goal 7365014c-b: one line per rail with the operator's answers (approve, edit, reject, ...) per kind, then Nous's own decisions. */
export function railDecisionLines(rows: RailDecisionCount[] | null, decisions: NousDecision[], since: string): string[] {
  const bySource = new Map<string, Map<string, string[]>>();
  for (const row of rows ?? []) {
    const kinds = bySource.get(row.source) ?? new Map<string, string[]>();
    const kind = RAIL_KINDS[row.type] ?? row.type.toLowerCase();
    kinds.set(kind, [...(kinds.get(kind) ?? []), `${row.decision} ${row.count}`]);
    bySource.set(row.source, kinds);
  }
  const answered = decisions.filter((decision) => decision.status !== "OPEN" && decision.status !== "CANCELLED" && (decision.answeredAt ?? "") >= since);
  const count = (status: NousDecision["status"]) => answered.filter((decision) => decision.status === status).length;
  return [
    ...(rows === null ? ["- The rails could not be read here."] : bySource.size ? [...bySource].map(([source, kinds]) => `- ${source}: ${[...kinds].map(([kind, parts]) => `${kind} ${parts.join(", ")}`).join("; ")}`) : ["- No answers in the copilot rails or needs-you cards."]),
    `- Nous decisions: approved ${count("APPROVED")}, declined ${count("DECLINED")}, in words ${count("ANSWERED")}`
  ];
}

/** The review turn's text: the figures Space can count, then the orders. */
export function renderDailyReview({ facts, decisions, cards = [], rails, ledger, since, day, hour }: DailyReviewInput): string {
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
  // Ask last (operator goal ee5a573e, 2026-10-27): every question the operator got, so the review finds the ones Nous could have answered itself.
  const raised = cards.filter((card) => (card.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX) || card.dedupeKey === NOUS_GENERAL_NOTICE_KEY)
    && String(card.payload.alertAt ?? card.createdAt) >= since).length;
  const asked = decisions.filter((decision) => decision.createdAt >= since);
  const questions = asked.filter((decision) => decision.category === "DIRECTION" || !decision.action).length;
  const couldHave = answered.filter((decision) => decision.couldHaveDecided === true);
  // Goal 7365014c-a: the operator answered as predicted; the 30 days come from the same lists (the review reads up to 500 decisions).
  const month = new Date(Date.parse(since) - 29 * 86_400_000).toISOString();
  const week = new Date(Date.parse(since) - 6 * 86_400_000).toISOString();
  const [weekly, monthly] = [predictionAccuracy(decisions, cards, week), predictionAccuracy(decisions, cards, month)];
  // Item 30 (28/10 05:33: cards 8 of 17 as predicted): the cards the operator answered against Nous's recommended option.
  const against = cards.flatMap((card) => {
    const recommended = (card.payload.ask as { recommended?: unknown } | undefined)?.recommended;
    const answer = card.payload.answer as { text?: unknown; at?: unknown; by?: unknown } | undefined;
    return typeof recommended === "string" && typeof answer?.text === "string" && String(answer.at ?? card.updatedAt) >= since && answer.by !== "ALWAYS" && answer.text.trim() !== recommended
      ? [`"${card.title.slice(0, 100)}" recommended "${recommended}", answered "${answer.text.slice(0, 120)}"`] : [];
  });
  return [
    `# Daily self-review (from Space, not the operator; once a day at ${String(hour).padStart(2, "0")}:00 in the operator's zone; today ${day})`,
    "## The last 24 hours, from your own turn facts",
    `- Turns: ${window.length} (${[...byReason.entries()].map(([reason, entry]) => `${reason} ${entry.turns}${entry.failed ? `, ${entry.failed} failed` : ""}`).join("; ") || "none"}); turns that failed, timed out or were stopped: ${failedTurns}`,
    `- Tool calls: ${totals.calls}; mistakes (failed calls that were not a gate holding back): ${totals.failed - totals.refused}; held by a gate: ${totals.refused}`,
    `- Tools that failed most: ${mistakes.length ? mistakes.map((entry) => `${entry.name} ${entry.mistakes} of ${entry.calls}`).join(", ") : "none"}`,
    `- Decisions the operator answered: ${answered.length} (approved ${count("APPROVED")}, declined ${count("DECLINED")}, in words ${count("ANSWERED")}); "you could have decided this": ${answered.filter((decision) => decision.couldHaveDecided === true).length}`,
    `- Corrections by the operator: ${corrections.length}${corrections.length ? `: ${corrections.slice(0, 10).map((summary) => `"${summary.slice(0, 120)}"`).join("; ")}` : ""}`,
    "## Questions to the operator (ask last, goal ee5a573e)",
    `- Cards and focus requests raised: ${raised}`,
    `- Decisions asked: ${asked.length}; questions among them (DIRECTION or without an action): ${questions}`,
    `- "You could have decided this": ${couldHave.length}${couldHave.length ? `: ${couldHave.slice(0, 10).map((decision) => `"${decision.title.slice(0, 120)}"`).join("; ")}` : ""}`,
    `- Predictions (goal 7365014c): decisions ${predictionText(weekly.decisions)} over 7 days, ${predictionText(monthly.decisions)} over 30; cards ${predictionText(weekly.cards)} over 7 days, `
      + `${predictionText(monthly.cards)} over 30. Write «Πρόβλεψη: ναι|όχι (N%)» in every recommendation and a recommended option on every card; learn from each miss.`,
    `- Cards answered against your recommendation: ${against.length}${against.length ? `: ${against.slice(0, 10).join("; ")}` : ""}`,
    "- For each question the answer to which was in your own sources (Space Memory, notes, pane reports, files, Vault, mail, DB, git, web, Live history), add a lesson naming where it was.",
    ...(rails === undefined ? [] : ["## The operator's answers in every rail (goal 7365014c-b)", ...railDecisionLines(rails, decisions, since)]),
    ...(ledger === undefined ? [] : ["## Decision ledger (goal 7365014c-e)", ...ledgerLines(ledger)]),
    "## Orders",
    "1. Read space_nous_progress (your scorecard) and space_nous_decisions (approved actions that failed).",
    "2. Find the repeated causes behind the failed tool calls and the corrections above (read the tool rows of those turns in the conversation if needed). For each cause, update your note \"lessons\" (space_note): one lesson per cause (what went wrong, why it mattered, what to do instead), merge duplicates, delete a lesson that turned out wrong.",
    `3. Save one Space Memory entry titled "Nous daily review ${day}" tagged nous-review (space_memory_save) with the figures above and the lessons you changed; tag operator-rule only when the operator's own words set a rule.`,
    // Item 13: the day's repeated causes go to the daily upgrade round's queue, which codes them.
    `4. Append to nous/upgrades/queue.md (space_files_write, mode append) a "## ${day} REVIEW" block with one "- OPEN ${day} REVIEW: <cause>; evidence: <tools and counts above>; fix: <the code change you want>" line per cause that repeated (the tools that failed most, the corrections, the cards answered against your recommendation); nothing when no cause repeats.`,
    "5. End with five lines: turns and failures, lessons changed, what you will do differently from today, what needs the operator (nothing: say so). No helpers for this turn; no new decisions unless a failure needs the operator's hands."
  ].join("\n");
}
