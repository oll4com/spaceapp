import { needsYou, type NousDecision, type NousTurnFacts, type RoomAgentEvent, type SpaceNotification } from "@space/contracts";
import type { NousLedgerRow, RailDecisionCount } from "@space/db";
import { NOUS_GENERAL_NOTICE_KEY, NOUS_PANE_NOTICE_PREFIX, sameCardSubject } from "./pane-notices.js";
import { cardAnswerMatched, predictionAccuracy, predictionText, textPrediction } from "./predictions.js";
import { coordinationOf, coordinationText, failureCauses, failureCausesText, NOUS_CLI_CLOSED_MS, NOUS_TOOL_ERROR_SAMPLES, toolErrorSamples, waitCloser, waitQuestion } from "./progress.js";

/**
 * Nous's daily self-review (operator decision 2026-10-24): Space itself brings Nous, once a day at the operator's chosen hour, the
 * last 24 hours of its own turn facts (turns, failures, the tools that failed most, the decisions the operator answered and the
 * corrections) and asks it to turn the repeated causes into lessons. Until then the review was a scheduled task typed into a pane,
 * and that pane kept getting lost (skipped on 21/10 and 23/10).
 */
export const NOUS_REVIEW_WINDOW_MS = 24 * 3_600_000;

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
  facts: NousTurnFacts[]; decisions: NousDecision[]; cards?: SpaceNotification[]; rails?: RailDecisionCount[] | null; ledger?: NousLedgerRow[];
  /** Queue item 21: the room monitor's WAITING and STUCK events (the scorecard's unblocking sample). */
  waits?: RoomAgentEvent[]; since: string; day: string; hour: number;
  /** R11-2 (5): the day's failed space_db_query rows (their meta's PostgreSQL code and guessed name). */
  dbFailures?: Array<{ dbCode: string; dbGuess?: string | null }>;
  /** R17-6: the day's failed space_mail_read calls by cause (the tool rows' mailCode). */
  mailFailures?: string[];
  /** R20-asks-1: browser handoff notices (BROWSER_HANDOFF), counted among the questions to the operator. */
  handoffs?: SpaceNotification[];
  /** 2/11 rule 6: the window's notifications (every source), for the Needs you count and what Nous closed without the operator. */
  needsYou?: SpaceNotification[];
  /**
   * D (plan clipboard:ZWJJdBgHm64Z): the Requests tab's In progress count kept at the operator's 09:00 and 21:00 within the window, the
   * open requests now, and how many of them had no act (no outcome, no Done, no step sent naming them) for 6 hours.
   */
  requests?: { progress: Array<{ day: string; slot: string; count: number }>; open: number; quiet: number };
  /** R22-5: the DATE waits Nous set on plans and goals and the time follow-ups it added since then (its tool rows' meta.deferral). */
  deferrals?: NousDeferral[];
  /** Plan clipboard:7L5KyWp3kQsP step 5: the copilots' cards (held for Nous or not) and the agents' needs-you cards. */
  asks?: SpaceNotification[];
  /** R65 (goal ee5a573e β): the window's cards and focus requests Space held because a rule, an earlier answer or a memory had the answer, and the lessons of that kind. */
  cardHolds?: { rule: number; memory: number; lessons: string[]; signin?: number; records?: number; duplicate?: number };
  /** Sentry plan step 8: new issues per release deployed in the window (`sentryReleaseLines`). */
  sentry?: string[];
}

/**
 * Plan clipboard:7L5KyWp3kQsP step 5 (goal ee5a573e criteria γ, α/δ): the window's copilot questions held for Nous, answered within their hour or
 * escalated to the operator (released after the hold, or put on Nous's own card), and the agents' needs-you cards raised without "Checked first".
 */
export function askLines(asks: SpaceNotification[], since: string): string[] {
  const held = asks.filter((item) => item.source !== "AGENT" && item.createdAt >= since && Boolean(item.payload.heldForNous || item.payload.releasedFromNous));
  const released = held.filter((item) => item.payload.releasedFromNous);
  const forwarded = held.filter((item) => !item.payload.releasedFromNous && typeof (item.payload.heldForNous as { card?: unknown }).card === "string");
  const settledAt = (item: SpaceNotification) => Date.parse(item.resolvedAt ?? item.ackedAt ?? "");
  const inHour = held.filter((item) => !released.includes(item) && !forwarded.includes(item) && settledAt(item) - Date.parse(item.createdAt) <= 3_600_000);
  // Copilot NEEDS_USER cards go straight to the operator (never held for Nous), so they carry "Checked first" too (goal ee5a573e).
  const cards = asks.filter((item) => (item.source === "AGENT" ? item.kind === "NEEDS_YOU" : item.kind === "NEEDS_USER") && String(item.payload.alertAt ?? item.createdAt) >= since);
  const bare = cards.filter((item) => !item.body.includes("\n\nChecked first:\n"));
  return [`- Copilot questions held for you: ${held.length}; answered within their hour: ${inHour.length}; escalated to the operator: ${released.length + forwarded.length} `
    + `(after the hold ${released.length}, on your cards ${forwarded.length}); later or still waiting: ${held.length - inHour.length - released.length - forwarded.length}`,
  `- Agents' and copilots' needs-you cards: ${cards.length}; without "Checked first": ${bare.length}${bare.length ? ` (${bare.map((item) => item.title).join("; ")})` : ""}`];
}

/** R22-5: one deferral Nous made: a plan's or goal's DATE wait, or a follow-up on a time; `at` is when it was set. */
export interface NousDeferral { at: string; kind: "PLAN" | "GOAL" | "FOLLOWUP"; id: string; until: string | null; what: string }
/** A follow-up an hour or less ahead is a check, not a deferral. */
export const DEFERRAL_FOLLOWUP_MIN_MS = 60 * 60_000;
/** The hold a quota reset names; tools.ts refuses it while the pool the wait names has room now (2026-11-06 REVIEW). */
export const QUOTA_RESET_HOLD = "a cap or quota reset";
// R22-5's heuristic: a reason naming one of these is a real hold; anything else could have run the same day.
const DEFERRAL_HOLDS: Array<[string, RegExp]> = [
  ["the operator's hands", /\boperator\b|\bapprov|χειριστ|έγκρισ/i],
  ["a sign-in", /sign[- ]?in|log[- ]?in|\b(?:2fa|mfa|otp|captcha)\b|hand-?off|verification code|σύνδεσ/i],
  ["a third party", /third[- ]party|\b(?:vendor|client|customer|support|recruiter)s?\b|their (?:reply|answer)|reply from|τρίτ/i],
  ["quiet hours", /quiet hours|held for the morning|ώρες ησυχίας/i],
  // 2026-11-07 REVIEW: «Επαναφορά του Claude Max dev» (Greek for its reset) was read as no hold at all.
  [QUOTA_RESET_HOLD, /\breset|\b(?:daily|weekly|hourly) (?:cap|limit)|\bquota\b|rate[- ]limit|usage limit|low[- ]spend|επαναφορ|μηδενισμ/i],
  // 2026-11-02 REVIEW (20 of 85 "could have run today", most of them follow-ups on the batched promote, rule 04c051fe): a promote or a ticket on its way is a real hold.
  ["the promote cadence or a ticket", /\bpromot|\bdeploying\b|\bq-\d{8}-\d{6}-[0-9a-f]{4}\b|merge queue|space-queue/i],
  ["a real date", /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b|\b(?:mon|tues|wednes|thurs|fri|satur|sun)day\b|deadline|\bdue (?:on|by|at)\b|προθεσμ/i],
  // Queue items 846 + 915 (goal 35813e48): a fixed window ("reboot window 04:30-05:00") and a running job's ETA are real holds too.
  ["a fixed time window", /\b\d{1,2}:\d{2}\s*[-–]\s*\d{1,2}:\d{2}\b|\b(?:maintenance|reboot|backup|release|change) window\b/i],
  ["a running job's ETA", /\beta\b|\b(?:finish|complet|end)(?:es|s)? (?:at|by|around)\b|still running/i],
  // 5/11 (3 of 5 refusals: a goal's next pendings list at its own «ανά 3 ώρες» rhythm): a set cadence is a real hold.
  ["a set cadence", /\bevery \d+ (?:min|hour|day|week)|(?:ανά|κάθε) \d+ (?:λεπτ|ώρ|μέρ|ημέρ|εβδομ)/i]
];
/** The reason tools.ts appends to a wait the run-now gate let through on it: "(wait reason: …)" on a follow-up, "(reason: …)" on a plan or goal. */
const WAIT_REASON = /\((?:wait )?reason: [^]+\)\s*$/;
/** The hold a deferral's words name (R22-5's heuristic), undefined when none: then it could run the same day. */
export const deferralHold = (what: string) => DEFERRAL_HOLDS.find(([, words]) => words.test(what))?.[0];

/** R22-5 (goal 35813e48, operator «Μην αφήνεις για αύριο ότι μπορείς να κάνεις σήμερα τώρα!!»): each deferral of the day, justified or not, then the misses. */
export function deferralLines(deferrals: NousDeferral[], since: string): string[] {
  const day = deferrals.filter((item) => item.at >= since && (item.kind !== "FOLLOWUP" || !item.until || Date.parse(item.until) - Date.parse(item.at) > DEFERRAL_FOLLOWUP_MIN_MS))
    .sort((left, right) => left.at.localeCompare(right.at));
  let missed = 0;
  let reasoned = 0;
  const lines = day.map((item) => {
    const hold = deferralHold(item.what);
    // Daily self-upgrade 5/11 (2026-11-05 REVIEW item 5, 7 of 138): the run-now gate already refused every such wait without a reason, so a
    // wait whose words name no hold passed on the reason Nous gave (tools.ts runNowProblem); that is Nous's judgment to check, not a code item.
    const reason = !hold && WAIT_REASON.test(item.what);
    if (reason) reasoned += 1;
    else if (!hold) missed += 1;
    return `- ${item.at.slice(0, 16).replace("T", " ")} UTC ${item.kind.toLowerCase()} ${item.id} until ${item.until ?? "no time"}: "${item.what.replace(/\s+/g, " ").trim()}" → ${hold ? `justified (${hold})` : reason ? "HELD ONLY BY YOUR REASON" : "COULD HAVE RUN TODAY"}`;
  });
  return [...(lines.length ? lines : ["- none"]),
    `- Could have run today: ${missed} of ${day.length}${missed ? " (each one is a miss: run it in this turn, or record what really holds it)" : ""}`,
    ...(reasoned ? [`- Held only by the reason you gave: ${reasoned} (judge each: a reason that holds nothing is a lesson and the work runs now; no code item)`] : [])];
}

/**
 * Queue item 21 and round 9 item 3: each wait of the day, its kind and question, its minutes and who ended it (`waitCloser`); a pane
 * that left the wait by itself within 30 s is a flicker, as in the scorecard. A wait no agent answered is marked UNANSWERED.
 */
export function waitLines(events: RoomAgentEvent[], since: string): string[] {
  const minutes = (event: RoomAgentEvent) => Math.round((Date.parse(event.updatedAt) - Date.parse(event.createdAt)) / 6_000) / 10;
  const waits = events.filter((event) => (event.kind === "WAITING" || event.kind === "STUCK") && event.createdAt >= since
    && !(event.status === "RESOLVED" && Date.parse(event.updatedAt) - Date.parse(event.createdAt) < 30_000))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  return waits.length ? waits.map((event) => {
    const closer = waitCloser(event);
    const how = event.status === "OPEN" ? "still open" : `${closer.byAgent ? "answered" : "UNANSWERED"} (${minutes(event)} min): closed by ${closer.who}`
      + (!closer.byAgent && closer.who.startsWith("the pane itself") && minutes(event) * 60_000 < NOUS_CLI_CLOSED_MS ? " (closed by its CLI within 3 min: out of the adjusted score)" : "");
    return `- ${event.createdAt.slice(11, 16)} UTC ${event.paneName ?? event.paneId ?? event.roomId} ${event.kind} "${waitQuestion(event)}": ${how}`;
  })
    : ["- No pane waited (flickers under 30 s left out)."];
}

/** R17-6: the day's failed mail reads by cause, most first. */
export function mailFailureLines(codes: string[]): string[] {
  if (!codes.length) return ["- No mail read failed."];
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([code, count]) => `- ${code}: ${count}`);
}

/** R11-2 (5): the day's failed database reads by PostgreSQL code, with the names guessed most (the tool rows' meta). */
export function dbFailureLines(rows: Array<{ dbCode: string; dbGuess?: string | null }>): string[] {
  if (!rows.length) return ["- No database read failed."];
  const byCode = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const guesses = byCode.get(row.dbCode) ?? new Map<string, number>();
    if (row.dbGuess) guesses.set(row.dbGuess, (guesses.get(row.dbGuess) ?? 0) + 1);
    byCode.set(row.dbCode, guesses);
  }
  const label: Record<string, string> = { "42703": "wrong column", "42P01": "no such table", "42702": "ambiguous column", "42601": "syntax" };
  return [...byCode].sort((a, b) => rows.filter((row) => row.dbCode === b[0]).length - rows.filter((row) => row.dbCode === a[0]).length).map(([code, guesses]) => {
    const count = rows.filter((row) => row.dbCode === code).length;
    const top = [...guesses].sort((a, b) => b[1] - a[1]).map(([name, times]) => `${name}${times > 1 ? ` ×${times}` : ""}`);
    return `- ${code}${label[code] ? ` (${label[code]})` : ""}: ${count}${top.length ? `; guessed: ${top.join(", ")}` : ""}`;
  });
}

/** R10-6: the day's OVERLAP notices in one line (coordination, not waits). */
export function coordinationLine(events: RoomAgentEvent[], since: string, now = Date.now()): string {
  const day = coordinationOf(events.filter((event) => event.createdAt >= since), now);
  return day ? `- Coordination (OVERLAP notices, not waits): ${coordinationText(day)}.` : "- Coordination: no OVERLAP notice.";
}

/** Goal 7365014c-e: the ledger's answers, how many went as predicted, and the misses to learn from (at most 10). */
export function ledgerLines(all: NousLedgerRow[]): string[] {
  // The allowances' own approvals (source ALLOWANCE) are no operator answers.
  const rows = all.filter((row) => row.source !== "ALLOWANCE");
  const scored = rows.filter((row) => row.match !== null);
  const misses = scored.filter((row) => row.match === false);
  return [`- ${rows.length} answers, ${scored.length - misses.length} of ${scored.length} with a prediction went as predicted`,
    ...misses.map((row) => `- Miss [${row.source}] "${row.title}": predicted ${row.predicted}, answered "${row.answer}"`)];
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

/**
 * 2/11 rule 6 (operator 10:16 BKK «αφησε μονο οτι πραγματικα θες απο εμας»: ~32 Needs you cards, about 15 his): the window's needs-you cards, how many
 * reached the operator (never held for Nous, or released to him; Nous's own cards), and how many closed without him (resolved by Nous, a copilot or
 * Space, or answered by his standing answers) with the closed ones by source.
 */
export function needsYouLines(records: SpaceNotification[], since: string): string[] {
  const raised = records.filter((item) => item.createdAt >= since && needsYou(item));
  const auto = (item: SpaceNotification) => typeof (item.payload.answer as { by?: unknown } | undefined)?.by === "string";
  const reached = raised.filter((item) => !auto(item) && !item.payload.heldForNous);
  const closed = raised.filter((item) => item.status === "RESOLVED" || (item.status === "ACKED" && auto(item)));
  const nousOnly = closed.filter((item) => !reached.includes(item));
  const bySource = new Map<string, number>();
  for (const item of nousOnly) bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
  const mailToNous = closed.filter((item) => { const answer = item.payload.answer as { by?: unknown; routed?: unknown } | undefined;
    return answer?.by === "HANDLED" && answer.routed === "NOUS"; }).length;
  return [`- Needs you cards raised: ${raised.length}; reached the operator: ${reached.length}; closed without him: ${closed.length}`
    + `${nousOnly.length ? ` (${nousOnly.length} never reached him: ${[...bySource].map(([source, count]) => `${source} ${count}`).join(", ")})` : ""}`
    + `${mailToNous ? `; Mail flags his "I handled it" base rate gave you to act on: ${mailToNous}` : ""}`
    + `; still waiting on him: ${reached.filter((item) => item.status === "OPEN" || item.status === "READ").length}. Every card that reached him and an agent could have done is a miss: name why.`];
}

/** The review turn's text: the figures Space can count, then the orders. */
export function renderDailyReview({ facts, decisions, cards = [], rails, ledger, waits, dbFailures, mailFailures, handoffs, needsYou: needsYouRecords, requests, deferrals, asks, cardHolds, sentry, since, day, hour }: DailyReviewInput): string {
  const window = facts.filter((turn) => turn.startedAt >= since && turn.reason !== "REVIEW");
  const byReason = new Map<string, { turns: number; failed: number }>();
  for (const turn of window) {
    const entry = byReason.get(turn.reason) ?? { turns: 0, failed: 0 };
    entry.turns += 1;
    if (turn.status !== "DONE") entry.failed += 1;
    byReason.set(turn.reason, entry);
  }
  const tools = new Map<string, { calls: number; failed: number; refused: number; errors: Map<string, number> }>();
  for (const turn of window) {
    for (const [name, counts] of Object.entries(turn.tools)) {
      const entry = tools.get(name) ?? { calls: 0, failed: 0, refused: 0, errors: new Map() };
      entry.calls += counts.calls; entry.failed += counts.failed; entry.refused += counts.refused;
      for (const error of toolErrorSamples(counts)) entry.errors.set(error, (entry.errors.get(error) ?? 0) + 1);
      tools.set(name, entry);
    }
  }
  const totals = [...tools.values()].reduce((sum, entry) => ({ calls: sum.calls + entry.calls, failed: sum.failed + entry.failed, refused: sum.refused + entry.refused }), { calls: 0, failed: 0, refused: 0 });
  const mistakes = [...tools.entries()].map(([name, entry]) => ({ name, mistakes: entry.failed - entry.refused, calls: entry.calls, errors: entry.errors })).filter((entry) => entry.mistakes > 0)
    .sort((a, b) => b.mistakes - a.mistakes || a.name.localeCompare(b.name));
  const answered = decisions.filter((decision) => decision.status !== "OPEN" && decision.status !== "CANCELLED" && (decision.answeredAt ?? "") >= since);
  const count = (status: NousDecision["status"]) => answered.filter((decision) => decision.status === status).length;
  const corrections = window.flatMap((turn) => turn.outcomes.filter((outcome) => outcome.correction).map((outcome) => outcome.summary));
  const failedTurns = window.filter((turn) => turn.status !== "DONE").length;
  // Ask last (operator goal ee5a573e, 2026-10-27): every question the operator got, so the review finds the ones Nous could have answered itself.
  const raisedCards = cards.filter((card) => (card.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX) || card.dedupeKey === NOUS_GENERAL_NOTICE_KEY)
    && String(card.payload.alertAt ?? card.createdAt) >= since);
  const raised = raisedCards.length;
  // R66 (4/11: five subjects reached the operator on two cards from two panes): the cards that reached him, by subject (their items' words).
  const subjects: Array<{ label: string; texts: string[]; cards: number }> = [];
  for (const card of raisedCards) {
    const items = Array.isArray(card.payload.items) ? card.payload.items as Array<{ text?: unknown; question?: unknown }> : [];
    const texts = items.map((item) => [item.text, item.question].filter((part) => typeof part === "string" && part).join(" ")).filter(Boolean);
    const own = texts.length ? texts : [String(card.title ?? card.id)];
    const group = subjects.find((entry) => entry.texts.some((text) => own.some((mine) => sameCardSubject(text, mine))));
    if (group) { group.cards += 1; group.texts.push(...own); } else subjects.push({ label: own[0]!.slice(0, 80), texts: own, cards: 1 });
  }
  const repeated = subjects.filter((entry) => entry.cards > 1);
  const asked = decisions.filter((decision) => decision.createdAt >= since);
  const questions = asked.filter((decision) => decision.category === "DIRECTION" || !decision.action).length;
  const couldHave = answered.filter((decision) => decision.couldHaveDecided === true);
  const byAllowance = decisions.filter((decision) => (decision.answeredAt ?? "") >= since && decision.answer?.startsWith("Approved by allowance "));
  // Goal 7365014c-a: the operator answered as predicted; the 30 days come from the same lists (the review reads up to 500 decisions).
  const month = new Date(Date.parse(since) - 29 * 86_400_000).toISOString();
  const week = new Date(Date.parse(since) - 6 * 86_400_000).toISOString();
  const [weekly, monthly] = [predictionAccuracy(decisions, cards, week), predictionAccuracy(decisions, cards, month)];
  // Item 30 (28/10 05:33: cards 8 of 17 as predicted): the cards the operator answered against Nous's recommended option.
  const against = cards.flatMap((card) => cardAnswerMatched(card, since) === false
    ? [`"${card.title}" recommended "${String((card.payload.ask as { recommended?: unknown }).recommended)}", answered "${String((card.payload.answer as { text?: unknown }).text)}"`] : []);
  return [
    `# Daily self-review (from Space, not the operator; once a day at ${String(hour).padStart(2, "0")}:00 in the operator's zone; today ${day})`,
    "## The last 24 hours, from your own turn facts",
    `- Turns: ${window.length} (${[...byReason.entries()].map(([reason, entry]) => `${reason} ${entry.turns}${entry.failed ? `, ${entry.failed} failed` : ""}`).join("; ") || "none"}); turns that failed, timed out or were stopped: ${failedTurns}`
      + (failedTurns ? ` (failures by cause: ${failureCausesText(failureCauses(window))})` : ""),
    `- Tool calls: ${totals.calls}; mistakes (failed calls that were not a gate holding back): ${totals.failed - totals.refused}; held by a gate: ${totals.refused}`,
    `- Tools that failed most: ${mistakes.length ? mistakes.map((entry) => `${entry.name} ${entry.mistakes} of ${entry.calls}`).join(", ") : "none"}`,
    // 2/11 REVIEW: each tool's mistakes of each turn (the first one before 8/11, up to 3 since), so a cause is named, not only counted.
    ...(mistakes.some((entry) => entry.errors.size) ? [`- Error samples (up to ${NOUS_TOOL_ERROR_SAMPLES} per tool per turn): ${mistakes.filter((entry) => entry.errors.size).map((entry) => `${entry.name}: ${[...entry.errors.entries()]
      .sort((a, b) => b[1] - a[1]).map(([text, turns]) => `"${text}"${turns > 1 ? ` ×${turns}` : ""}`).join("; ")}`).join("; ")}`] : []),
    `- Decisions the operator answered: ${answered.length} (approved ${count("APPROVED")}, declined ${count("DECLINED")}, in words ${count("ANSWERED")}); "you could have decided this": ${answered.filter((decision) => decision.couldHaveDecided === true).length}`,
    `- Corrections by the operator: ${corrections.length}${corrections.length ? `: ${corrections.map((summary) => `"${summary}"`).join("; ")}` : ""}`,
    // D (operator 31/10 22:19 BKK «έπρεπε τα 35 να έχουν κλείσει τα περισσότερα»): did the requests move on Nous's own.
    ...(requests ? ["## Operator requests (they move on your own, plan clipboard:ZWJJdBgHm64Z)",
      `- In progress (the Requests tab): ${requests.progress.length ? requests.progress.map((entry) => `${entry.day} ${entry.slot} ${entry.count}`).join(", ") : "no count kept"}; `
        + `open now: ${requests.open}; open more than 6 h with no act: ${requests.quiet}${requests.quiet ? " (each one is a miss: move it in this turn and name the cause)" : ""}`] : []),
    "## Questions to the operator (ask last, goal ee5a573e)",
    `- Cards and focus requests raised: ${raised}`,
    ...(cardHolds ? [`- Cards held because Space already had the answer (R65, R66): ${cardHolds.rule + cardHolds.memory + (cardHolds.signin ?? 0) + (cardHolds.records ?? 0) + (cardHolds.duplicate ?? 0)} `
      + `(a rule or earlier answer ${cardHolds.rule}, a memory ${cardHolds.memory}, a stored sign-in ${cardHolds.signin ?? 0}, Space's records ${cardHolds.records ?? 0}, `
      + `an open card on the same subject ${cardHolds.duplicate ?? 0}); lessons of this kind: ${cardHolds.lessons.length}${cardHolds.lessons.length ? ` (${cardHolds.lessons.join(", ")})` : ""}`] : []),
    ...(raised ? [`- Cards that reached the operator by subject (R66): ${subjects.length} subject${subjects.length === 1 ? "" : "s"}; on more than one card: `
      + `${repeated.length ? repeated.map((entry) => `"${entry.label}" ${entry.cards}`).join(", ") : "none"}`] : []),
    ...(needsYouRecords ? needsYouLines(needsYouRecords, since) : []),
    // R20-asks-1 (30/10: 50 handoff notices, 1 acknowledged): the browser handoffs agents asked of the operator, repeats held without an alert.
    ...(handoffs ? (() => { const day = handoffs.filter((item) => item.createdAt >= since); const repeats = day.filter((item) => item.payload.repeat === true).length;
      return [`- Browser handoffs asked of the operator: ${day.length}${repeats ? ` (${repeats} repeats on the same pane and site, held without an alert)` : ""}; acknowledged ${day.filter((item) => item.status === "ACKED").length}`]; })() : []),
    ...(asks ? askLines(asks, since) : []),
    `- Decisions asked: ${asked.length}; questions among them (DIRECTION or without an action): ${questions}`,
    // R12-11: 0 since the server refuses an ask without one; anything else is a decision asked outside space_ask_operator.
    `- Decisions asked without a prediction: ${asked.filter((decision) => !textPrediction(decision)).length}`,
    `- "You could have decided this": ${couldHave.length}${couldHave.length ? `: ${couldHave.map((decision) => `"${decision.title}"`).join("; ")}` : ""}`,
    `- Predictions (goal 7365014c): decisions ${predictionText(weekly.decisions)} over 7 days, ${predictionText(monthly.decisions)} over 30; cards ${predictionText(weekly.cards)} over 7 days, `
      + `${predictionText(monthly.cards)} over 30. Write "Prediction: yes|no (N%)" in every recommendation and a recommended option on every card; learn from each miss.`,
    // R16-9: cards answered with no recommended option (below the base-rate threshold) cannot be scored.
    ...(ledger === undefined ? [] : [`- Cards answered without a prediction: ${ledger.filter((row) => row.source.startsWith("NEEDS_YOU:") && row.predicted === null && row.at >= since).length}`]),
    `- Cards answered against your recommendation: ${against.length}${against.length ? `: ${against.join("; ")}` : ""}`,
    `- Approved by allowances (no operator answer): ${byAllowance.length}${byAllowance.length ? `: ${byAllowance.map((decision) => `"${decision.title}" (${decision.answer!.slice(12)}${decision.refs.recipients?.length ? ` to ${decision.refs.recipients.join(", ")}` : ""})`).join("; ")}` : ""}`,
    "- For each question the answer to which was in your own sources (Space Memory, notes, pane reports, files, Vault, mail, DB, git, web, Live history), add a lesson naming where it was.",
    ...(rails === undefined ? [] : ["## The operator's answers in every rail (goal 7365014c-b)", ...railDecisionLines(rails, decisions, since)]),
    ...(ledger === undefined ? [] : ["## Decision ledger (goal 7365014c-e)", ...ledgerLines(ledger)]),
    ...(waits === undefined ? [] : ["## Waits on panes (the scorecard's unblocking, queue item 21)", ...waitLines(waits, since), coordinationLine(waits, since)]),
    ...(dbFailures === undefined ? [] : ["## Failed database reads by PostgreSQL code (space_db_query; put a repeated guess in the description's \"Guessed wrong most\" queue item)", ...dbFailureLines(dbFailures)]),
    ...(mailFailures === undefined ? [] : ["## Failed mail reads by cause (space_mail_read)", ...mailFailureLines(mailFailures)]),
    ...(sentry === undefined ? [] : ["## Sentry: new issues per release deployed since then (a release with new issues is a cause to fix; the Monitoring Copilot's cards name them)", ...sentry]),
    ...(deferrals === undefined ? [] : ["## Deferrals today (goal 35813e48: nothing left for tomorrow that can run today; DATE waits on plans and goals, follow-ups over an hour ahead)", ...deferralLines(deferrals, since)]),
    "## Orders",
    "1. Read space_nous_progress (your scorecard) and space_nous_decisions (approved actions that failed).",
    "2. Find the repeated causes behind the failed tool calls and the corrections above (read the tool rows of those turns in the conversation if needed). For each cause, keep one lesson (space_note, key lessons-<cause>: what went wrong, why it mattered, what to do instead); a lesson of an existing cause joins it as an incident. "
    + "Run space_lessons {\"duplicates\": true} and merge each group of one cause (space_lessons merge); delete a lesson that turned out wrong. A cause a code guard can stop goes to a pane now, never only a lesson.",
    `3. Save one Space Memory entry titled "Nous daily review ${day}" tagged nous-review (space_memory_save) with the figures above and the lessons you changed; tag operator-rule only when the operator's own words set a rule.`,
    // Item 13: the day's repeated causes go to the daily upgrade round's queue, which codes them.
    `4. Append to nous/upgrades/queue.md (space_files_write, mode append) a "## ${day} REVIEW" block with one "- OPEN ${day} REVIEW: <cause>; evidence: <tools and counts above>; fix: <the code change you want>" line per cause that repeated (the tools that failed most, the corrections, the cards answered against your recommendation, every UNANSWERED wait above, every deferral that could have run today); nothing when no cause repeats.`,
    "5. End with five lines: turns and failures, lessons changed, what you will do differently from today, what needs the operator (nothing: say so). No helpers for this turn; no new decisions unless a failure needs the operator's hands."
  ].join("\n");
}
