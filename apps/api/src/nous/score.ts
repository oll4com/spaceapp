import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DOT_SCHEDULE_GRACE_MS, nextDotScheduleRun, nousScoreRangeSchema, type NousScore, type NousScoreHistory, type NousScoreItem, type NousScoreRange,
  type NousScoreTile, type NousTurnFacts, type NousMarketingPostRow, type NousMarketingReport, type NousDecision, type NousGoal, type NousProgram, type GatewayLostWindow } from "@space/contracts";
import type { NousScoreSnapshot } from "@space/db";
import { BROWSER_IDLE_MS } from "../browser-reaper.js";
import { tokenCount } from "./lost-tokens.js";
import type { ApprovalSettlement } from "./approvals.js";
import { predictionAccuracy } from "./predictions.js";
import { NOUS_WEIGHTS, type NousDimension, type NousDimensionScore, type NousScorecard } from "./progress.js";
import { SETTLED_DECISION_OUTCOME } from "./workbench.js";

/**
 * Score (operator 3/11 23:11 BKK «θα σε βαθμολογεί αρνητικά όσο πλάνα και request μένουν ανοιχτά», plan clipboard:1NF6u6gcCwtj): Nous's
 * performance as points that can go negative. What is open costs points for as long as it stays open; what was finished in the scorecard's
 * window (7 days) gives them; utilization against its target and the scorecard's own change against its baseline add or take.
 * Every weight is in NOUS_SCORE_WEIGHTS; nothing else in the score is a number to tune.
 */
export const NOUS_SCORE_WEIGHTS = {
  /** Each open plan, its squared full-day age, and more when no open pane works on it or it is STALLED (stalled-plans.ts). */
  openPlan: -2, openPlanPerDay: -2, planAgeExponent: 2, planNoWorkingPane: -3, planStalled: -5,
  /**
   * Every open pane; an idle or finished pane left open past one hour costs extra. Each completed day in the window also costs its average
   * number of open panes (all types, from the 15-minute snapshots) × paneDay (operator 4/11 nous_msg:44e3fd48).
   */
  openPane: -1, paneIdlePast1h: -2, paneDay: -0.2,
  /**
   * Idle open browsers (operator 5/11 14:47 BKK «αρνητική βαθμολογία … για όσους browser κρατάς ανοιχτούς χωρίς να χρειάζονται»): a live pane
   * browser with no use for over BROWSER_IDLE_MS (30 min), per started hour past it; and each one Space's browser reaper had to close in the window.
   */
  idleBrowserPerHour: -2, browserReaped: -2,
  /**
   * Approved but not done (operator 5/11 20:36 BKK nous_msg:2d54c4e1 «οταν δεν στελνεις πραγματα που σου εχω πει … αρνητικη βαθμολογια»): each
   * EXTERNAL decision approved and not confirmed done, once its grace is over, plus its squared full hours past the grace.
   */
  approvedNotDone: -5, approvedNotDonePerHour: -0.25, approvedNotDoneAgeExponent: 2, approvedNotDoneGraceHours: 2,
  /** Each unmet day, each completed day without recorded progress in the window, and each day late. */
  goalPerDay: -2, goalNoProgressDay: -3, goalOverdueDay: -20,
  /**
   * Daily error signals; tool refusals are gates, counted separately without a penalty. A chat error is a Nous turn that FAILED or timed out;
   * a failed decision is an answered one whose action failed (operator 4/11 nous_msg:44e3fd48).
   */
  toolFailure: -2, lesson: -5, decisionDeclined: -5, predictionMiss: -3, chatError: -1, decisionFailed: -3,
  /** Each open operator request, and more once it is past 1 hour, 6 hours and 24 hours open (each step adds to the one before). */
  openRequest: -2, requestPast1h: -2, requestPast6h: -4, requestPast24h: -8,
  /** Each plan completed and each request recorded Done (space_request_done) in the window. */
  planCompleted: 5, requestDone: 3,
  /** Per point of today's average utilization above (+) or below (−) its target. */
  utilizationPerPoint: 0.5,
  /**
   * Lost tokens, its own variable (operator 5/11 nous_msg:b489788c «μεγάλη μείωση στο Score»): per point of a subscription week left unused at its
   * reset in the window. ~30% of one Max account's week (−2,850) costs more than every other variable but Daily Nous errors (stable 5/11 05:03
   * UTC: Open plans −2,680, Daily Nous errors −2,981).
   */
  lostAtResetPerPoint: -95,
  /** Each operator correction in the turn facts, and each decision flagged could-have-decided. */
  correction: -5, couldHaveDecided: -3,
  /** Per point of the scorecard's overall above (+) or below (−) its 2026-10-17 baseline, split by dimension as its weights split it. */
  scorecardPerPoint: 0.5,
  /** Each day a DAILY task with a pane was due and nothing was typed into its pane (operator 4/11, nous_msg:02e5be1d). */
  dailyTaskMissed: -5,
  /**
   * Per operator message (operator 4/11, nous_msg:0f7467f0): a first answer later than the reply target, again past ten times it; a Done
   * record later than the Done target, again past 24 hours. Charged on the message's local day.
   */
  slowReply: -2, slowReplyPast10x: -2, slowDone: -2, slowDonePast24h: -4,
  /**
   * Big projects (operator 4/11, nous_msg:5e5d7526 and c9ec2d1a: funding, jobs, crypto, freelance): per point of a project's success rate below
   * 100 %; per day since its first try × the share it falls short (the lower the rate and the more days, the more); each program still open.
   */
  projectShortfallPerPoint: -0.2, projectDay: -1, programOpen: -1,
  /** A program found but not applied to yet (operator 4/11 nous_msg:44e3fd48): new candidates must not swamp the Score. */
  programNotApplied: -0.2,
  /**
   * Marketing (operator 5/11 10:42 BKK, plan clipboard:netzt-nNvtBL): per point of the marketing score below its target, and per day in a row
   * below it × the share short (more each day it stays so); each post of the window that failed to publish or reached no one; each of the last
   * 7 days without a post that brought anything.
   */
  marketingPerPoint: -0.2, marketingDayBelowTarget: -1, marketingFailed: -2, marketingZeroReach: -0.5, marketingDayWithoutResult: -1
} as const;
/** Nous's first answer to an operator message is due within this (Nous 4/11); its Done within the other. */
export const NOUS_SCORE_REPLY_TARGET_MS = 2 * 60_000;
export const NOUS_SCORE_DONE_TARGET_MS = 6 * 3_600_000;
export const NOUS_SCORE_WINDOW_DAYS = 7;
export const NOUS_SCORE_STARTUP_MS = 2_000;
/**
 * The only recompute is this timer's, plus one NOUS_SCORE_EVENT_DELAY_MS after the operator writes (operator 4/11 nous_msg:b85ffb5b: the
 * least load on the server); reads never recompute. A recompute reads a week of turns, decisions, notifications and every room's panes.
 */
export const NOUS_SCORE_SNAPSHOT_MS = 15 * 60_000;
/** Long enough for the reply target to be met or missed, so the recompute after a message already shows it. */
export const NOUS_SCORE_EVENT_DELAY_MS = 2 * 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** An incident line a lesson gained (tools.ts same-cause save, lessons.ts merge): its date or time. */
const LESSON_INCIDENT = /^--- Incident \((?:merged from \S+, )?(\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?)/gm;
/** Counts are grouped in the owner's local day; refused calls are included in failed by the fact recorder, so subtract them once. */
export interface NousScoreDayErrors { day: string; calls: number; failed: number; refused: number; corrections: number; lessons: number;
  declined: number; predictionMisses: number; couldHaveDecided: number; chatErrors: number; decisionsFailed: number }
const dayFormatters = new Map<string, Intl.DateTimeFormat>();
export function scoreDay(at: number, timeZone: string): string {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) dayFormatters.set(timeZone, formatter = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }));
  return formatter.format(at);
}
const emptyDay = (day: string): NousScoreDayErrors => ({ day, calls: 0, failed: 0, refused: 0, corrections: 0, lessons: 0, declined: 0, predictionMisses: 0, couldHaveDecided: 0, chatErrors: 0, decisionsFailed: 0 });
export function nousScoreErrors(input: { now: number; timeZone: string; facts: NousTurnFacts[]; decisions: NousDecision[];
  lessons: Array<{ key: string; text?: string; updatedAt: string; createdAt?: string | null }>; resetAt?: number }): NousScoreDayErrors[] {
  const days = new Map<string, NousScoreDayErrors>();
  const since = Math.max(input.now - NOUS_SCORE_WINDOW_DAYS * DAY_MS, input.resetAt ?? 0);
  const on = (at: string) => {
    const time = Date.parse(at);
    if (!(time >= since && time <= input.now)) return null;
    const day = scoreDay(time, input.timeZone);
    if (!days.has(day)) days.set(day, emptyDay(day));
    return days.get(day)!;
  };
  for (const fact of input.facts) {
    const day = on(fact.endedAt);
    if (!day) continue;
    for (const tool of Object.values(fact.tools)) { day.calls += tool.calls; day.failed += Math.max(0, tool.failed - tool.refused); day.refused += tool.refused; }
    day.corrections += fact.outcomes.filter((outcome) => outcome.correction).length;
    if (fact.status === "FAILED" || fact.status === "TIMEOUT") day.chatErrors += 1;
  }
  // A lesson counts on its creation and on each incident it gained (a same-cause save or a merged lesson, at the merged one's own date), never on a
  // rewrite or the merge itself (4/11: 52 merges in 7 days each moved an old lesson into today). A note with no created_at counts only its incidents: its update
  // is a rewrite (5/11: 103 legacy lessons rewritten in the window cost ~515 points; migration 0300 gave them their creation date).
  for (const lesson of input.lessons) {
    if (!/^lessons(?:-|$)/.test(lesson.key)) continue;
    const incidents = [...(lesson.text ?? "").matchAll(LESSON_INCIDENT)].map((match) => match[1]!.length === 10 ? `${match[1]}T00:00:00.000Z` : match[1]!);
    for (const at of [lesson.createdAt ?? null, ...incidents]) { const day = at ? on(at) : null; if (day) day.lessons += 1; }
  }
  for (const decision of input.decisions) {
    const answered = decision.answeredAt ? on(decision.answeredAt) : null;
    if (answered) {
      if (decision.status === "DECLINED") answered.declined += 1;
      if (decision.outcome?.startsWith("Failed")) answered.decisionsFailed += 1;
      const prediction = predictionAccuracy([decision], [], new Date(since).toISOString()).decisions;
      answered.predictionMisses += prediction.total - prediction.matched;
    }
    // Feedback is stored on the decision; attribute it to its answer, or creation while still open.
    const day = answered ?? (!decision.answeredAt ? on(decision.createdAt) : null);
    if (day && decision.couldHaveDecided) day.couldHaveDecided += 1;
  }
  return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export interface NousScoreInput {
  now: number;
  /** progress and pane (the working or idle pane's name) only name the lever's move; they cost nothing. */
  plans: Array<{ id: string; title: string; createdAt: string; working: boolean; stalled: string | null; progress?: number; pane?: string | null }>;
  completedPlans: Array<{ id: string; title: string; at: string }>;
  requests: Array<{ id: string | null; summary: string; openedAt: string }>;
  done: Array<{ id: string; title: string; at: string }>;
  utilization: { value: number; target: number; what: string } | null;
  panes: Array<{ id: string; title: string; idleSince: string | null }>;
  /** The live pane browsers unused past 30 minutes that nothing keeps (browser-reaper.ts), and those the reaper closed in the window. */
  browsers?: { idle: Array<{ id: string; title: string; idleSince: string }>; reaped: Array<{ id: string | null; title: string; at: string }> };
  /** The decisions; `sent` is a mail thread's SENT check (mailThreadSent) by decision id, absent where it has no thread or it was not read. */
  approvals?: { decisions: Array<Pick<NousDecision, "id" | "title" | "category" | "status" | "outcome" | "createdAt" | "answeredAt" | "refs">>;
    /** By decision id, what the mail store holds for its thread since the ask (MailCopilotService.threadSend); absent: no reply of ours logged. */
    sends: Record<string, "SENT" | "BOUNCED">;
    /** By decision id, its COPILOT item's final state (approvals.ts): DONE with evidence, or VOID (declined, cancelled, superseded); either drops it. */
    settled?: Record<string, ApprovalSettlement>;
    /** By decision id, the date its approved post is scheduled for (audit 6/11): not owed before it, late only from it. */
    scheduled?: Record<string, string> };
  /** Each completed local day's open panes, averaged over its snapshots (paneDaysOf); the service adds it from its own history. */
  paneDays: Array<{ day: string; average: number; peak: number }>;
  goals: Array<Pick<NousGoal, "id" | "text" | "createdAt" | "status" | "limit"> & { progressDays: string[] }>;
  dailyErrors: NousScoreDayErrors[];
  /** Calendar days and today use the owner's working time zone. */
  timeZone: string;
  /** The OPEN tasks with a DAILY schedule and a pane, and their runs in the window (typed: the text reached the pane). */
  dailyTasks: Array<{ id: string; title: string; createdAt: string; time: string; timeZone: string }>;
  taskRuns: Array<{ taskId: string; dueAt: string; typed: boolean }>;
  /** The operator's messages in the window: Nous's first answer covering each and its Done record, when there is one. */
  messages: Array<{ id: string; at: string; answeredAt: string | null; doneAt: string | null }>;
  programs: Array<Pick<NousProgram, "id" | "page" | "parent" | "program" | "status" | "appliedAt" | "createdAt">>;
  /** The other big projects (job applications, crypto methods, freelance proposals): what succeeded of what was tried, and the first try. */
  projects: Array<{ name: string; succeeded: number; tried: number; what: string; since: string | null }>;
  scorecard: Pick<NousScorecard, "overall" | "baselineOverall" | "baselineDate" | "dimensions" | "failures"> | null;
  /** Each subscription week that reset in the window and the share it left unused (the Gateway's lostTokens windows); empty when unknown. */
  lostAtResets?: Array<Pick<GatewayLostWindow, "label" | "quotaKey" | "resetAt" | "lostPercent" | "lostTokens" | "lostCostUsd">>;
  /** The Marketing page's read (nous/marketing.ts); absent where no Marketing Copilot runs. */
  marketing?: Pick<NousMarketingReport, "score" | "target" | "daysBelowTarget" | "daysWithoutResult"> & {
    posts: Array<Pick<NousMarketingPostRow, "id" | "number" | "channel" | "status" | "at" | "score" | "title">> } | null;
  /** The owner's score reset (NOUS_SCORE_RESET_NOTE): nothing before `at` counts, and `offset` (the score then) is taken off, so it read 0 then. */
  reset?: NousScoreReset | null;
}

/**
 * Score reset (operator 9/11 00:43 BKK nous_msg:8d5af119, goal 401b115b: «reset σε 0 … θετική από εδώ και πέρα»): a system note per owner, its
 * ':' outside space_note's key pattern so Nous cannot write it; only POST /api/nous/score/reset (admin action nous-score-reset) does.
 */
export const NOUS_SCORE_RESET_NOTE = "score:reset";
/** `tiles` (operator 11/11): each tile's points at the reset, taken off that tile so every tile reads 0 then; a reset without it has the one offset tile. */
export interface NousScoreReset { at: string; offset: number; tiles?: Record<string, number> }
export function parseScoreReset(text: string | null | undefined): NousScoreReset | null {
  try {
    const value = JSON.parse(text ?? "null") as Partial<NousScoreReset> | null;
    if (!(value && typeof value.at === "string" && Number.isFinite(Date.parse(value.at)) && typeof value.offset === "number" && Number.isFinite(value.offset))) return null;
    const tiles = value.tiles && typeof value.tiles === "object" ? Object.entries(value.tiles).filter(([, points]) => typeof points === "number" && Number.isFinite(points)) : null;
    return { at: value.at, offset: value.offset, ...(tiles ? { tiles: Object.fromEntries(tiles) } : {}) };
  } catch { return null; }
}

const round = (value: number) => Math.round(value * 10) / 10;
const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(round(value))}`;
const ageText = (ms: number) => ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)} d` : ms >= HOUR_MS ? `${Math.floor(ms / HOUR_MS)} h` : `${Math.floor(ms / 60_000)} min`;
const durationText = (ms: number) => ms < 60_000 ? `${Math.round(ms / 1000)} s` : ageText(ms);
const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)] ?? 0; };
/** Applications decided or waiting count toward a page's success rate; a withdrawn one does not. */
const SUBMITTED_PROGRAMS = new Set(["APPROVED", "REJECTED", "EXPIRED", "APPLIED", "IN_PROGRESS"]);
const OPEN_PROGRAMS = new Set(["APPLIED", "IN_PROGRESS", "DRAFT", "NOT_APPLIED"]);
const tile = (key: NousScoreTile["key"], label: string, items: NousScoreItem[], detail: string): NousScoreTile =>
  ({ key, label, points: round(items.reduce((sum, item) => sum + item.points, 0)), detail, items: [...items].sort((a, b) => a.points - b.points) });

/** Marketing's cost: the score short of its target (more each day in a row), failed and no-reach posts of the window, days without a result. */
function marketingItems(input: NonNullable<NousScoreInput["marketing"]>, now: number, resetAt: number): NousScoreItem[] {
  const w = NOUS_SCORE_WEIGHTS;
  // Days before the reset do not count.
  const sinceReset = Math.floor((now - resetAt) / DAY_MS);
  const marketing = { ...input, daysBelowTarget: Math.min(input.daysBelowTarget, sinceReset), daysWithoutResult: Math.min(input.daysWithoutResult, sinceReset) };
  const short = marketing.score === null ? 0 : Math.max(0, marketing.target - marketing.score);
  const recent = marketing.posts.filter((post) => Date.parse(post.at) > Math.max(now - NOUS_SCORE_WINDOW_DAYS * DAY_MS, resetAt));
  const post = (entry: (typeof recent)[number], points: number, detail: string): NousScoreItem =>
    ({ id: entry.id, label: `#${entry.number} ${entry.channel}${entry.title ? `: ${entry.title.slice(0, 80)}` : ""}`, points, detail });
  return [
    ...(short ? [{ id: null, label: `Marketing score ${marketing.score}/100, target ${marketing.target}`,
      points: round(short * w.marketingPerPoint + marketing.daysBelowTarget * w.marketingDayBelowTarget * (short / marketing.target)),
      detail: `${marketing.daysBelowTarget} d in a row below it · ${w.marketingPerPoint} a point short, ${w.marketingDayBelowTarget} a day × the share short` }] : []),
    ...recent.filter((entry) => entry.status === "FAILED").map((entry) => post(entry, w.marketingFailed, "failed to publish")),
    ...recent.filter((entry) => entry.status === "PUBLISHED" && entry.score === 0).map((entry) => post(entry, w.marketingZeroReach, "published, reached no one")),
    ...(marketing.daysWithoutResult ? [{ id: null, label: `${marketing.daysWithoutResult} of the last 7 days without a post that brought anything`,
      points: marketing.daysWithoutResult * w.marketingDayWithoutResult, detail: `${w.marketingDayWithoutResult} a day` }] : [])
  ];
}

/** A move that cuts the Score (operator 5/11 12:32 BKK: the Score is Nous's first measure): what it costs now, what one more day adds, the move. */
export interface NousScoreLever { id: string | null; label: string; points: number; perDay: number; action: string }

/** The score and its tiles from what is open now and what happened in the window; pure. */
export function nousScore(input: NousScoreInput): Pick<NousScore, "score" | "tiles" | "breakdown"> & { levers: NousScoreLever[] } {
  const w = NOUS_SCORE_WEIGHTS;
  // After a reset every window and age starts at it: what was open then counts from then, what happened before never.
  const resetAt = input.reset ? Date.parse(input.reset.at) : 0;
  const from = (at: string) => Math.max(Date.parse(at), resetAt);
  const since = Math.max(input.now - NOUS_SCORE_WINDOW_DAYS * DAY_MS, resetAt);
  const inWindow = (at: string) => Date.parse(at) >= since && Date.parse(at) <= input.now;
  const plans = input.plans.map((plan): NousScoreItem => {
    const age = Math.max(0, input.now - from(plan.createdAt));
    const days = Math.floor(age / DAY_MS);
    const points = w.openPlan + w.openPlanPerDay * days ** w.planAgeExponent + (plan.working ? 0 : w.planNoWorkingPane) + (plan.stalled ? w.planStalled : 0);
    return { id: plan.id, label: plan.title, points, detail: [`open ${ageText(age)}`, plan.working ? "a pane works on it" : "no working pane",
      ...(plan.stalled ? [`STALLED: ${plan.stalled}`] : [])].join(" · ") };
  });
  const panes = input.panes.map((pane): NousScoreItem => {
    const idle = pane.idleSince ? Math.max(0, input.now - from(pane.idleSince)) : 0;
    return { id: pane.id, label: pane.title, points: w.openPane + (idle > HOUR_MS ? w.paneIdlePast1h : 0),
      detail: idle > HOUR_MS ? `idle or finished ${ageText(idle)} · left open` : "open" };
  });
  // Each live idle browser: once past 30 min unused, every started hour costs (the first at once).
  const browserHours = (idleSince: string) => Math.max(1, Math.ceil((input.now - from(idleSince) - BROWSER_IDLE_MS) / HOUR_MS));
  const idleBrowsers = (input.browsers?.idle ?? []).map((browser): NousScoreItem => ({ id: browser.id, label: browser.title,
    points: browserHours(browser.idleSince) * w.idleBrowserPerHour, detail: `open, unused ${ageText(Math.max(0, input.now - from(browser.idleSince)))} · ${w.idleBrowserPerHour} an hour past 30 min` }));
  const reapedBrowsers = (input.browsers?.reaped ?? []).filter((browser) => inWindow(browser.at)).map((browser): NousScoreItem => ({ id: browser.id, label: browser.title,
    points: w.browserReaped, detail: `left open unused; Space closed it ${browser.at.slice(0, 16).replace("T", " ")} UTC` }));
  // Approved EXTERNAL decisions not confirmed done (goal 84ba917a): Nous marked it done or void (space_settle_decision), its copilot item ended
  // (settled), a mail send (a thread or recipients) logged to them with no bounce after it (sends), else an outcome that ran.
  // shortcut: a message sent outside Space (an SMTP script, Gmail web) counts only through its copy (Bcc) in a connected account; without one Nous marks it with its message id.
  const approvedAt = (decision: Pick<NousDecision, "createdAt" | "answeredAt">) => from(decision.answeredAt ?? decision.createdAt);
  const scheduledFor = (id: string) => Date.parse(input.approvals?.scheduled?.[id] ?? "") || 0;
  const isMailSend = (decision: Pick<NousDecision, "refs">) => !!decision.refs.mailThread || !!decision.refs.recipients?.length;
  const approvalPoints = (age: number) => {
    const late = Math.floor(age / HOUR_MS - w.approvedNotDoneGraceHours);
    return late < 0 ? 0 : w.approvedNotDone + w.approvedNotDonePerHour * late ** w.approvedNotDoneAgeExponent;
  };
  const notDone = (input.approvals?.decisions ?? []).filter((decision) => decision.status === "APPROVED" && decision.category === "EXTERNAL"
    && approvedAt(decision) >= since && scheduledFor(decision.id) <= input.now && !input.approvals!.settled?.[decision.id] && !SETTLED_DECISION_OUTCOME.test(decision.outcome ?? "")
    && !(isMailSend(decision) ? input.approvals!.sends[decision.id] === "SENT" : !!decision.outcome && !/\b(Failed|Held|Not answered)\b/.test(decision.outcome)));
  // The cause, so the lever names which send failed and why.
  const notDoneCause = (decision: (typeof notDone)[number]) => {
    if (!isMailSend(decision)) return decision.outcome ?? "no outcome recorded: its action never ran";
    const thread = decision.refs.mailThread;
    const where = [thread ? `${thread.account} thread ${thread.threadId}` : "", decision.refs.recipients?.length ? `to ${decision.refs.recipients.join(", ")} in any thread` : ""].filter(Boolean).join(" or ");
    return input.approvals!.sends[decision.id] === "BOUNCED" ? `our send ${where} bounced` : `no send of ours ${where} since the approval`;
  };
  const approved = notDone.map((decision): NousScoreItem => {
    const age = Math.max(0, input.now - Math.max(approvedAt(decision), scheduledFor(decision.id)));
    return { id: decision.id, label: decision.title, points: round(approvalPoints(age)),
      detail: `${scheduledFor(decision.id) ? "scheduled" : "approved"} ${ageText(age)} ago${age < w.approvedNotDoneGraceHours * HOUR_MS ? ` · in its ${w.approvedNotDoneGraceHours} h grace` : ""} · `
        + notDoneCause(decision) };
  });
  const paneDays = input.paneDays.map((day): NousScoreItem => ({ id: null, label: day.day, points: round(day.average * w.paneDay),
    detail: `${round(day.average)} open on average · peak ${day.peak} · ${w.paneDay} a pane a day` }));
  const today = scoreDay(input.now, input.timeZone);
  const todayNumber = Date.parse(`${today}T00:00:00Z`) / DAY_MS;
  const goals = input.goals.filter((goal) => goal.status === "ACTIVE").map((goal): NousScoreItem => {
    const age = Math.max(0, Math.floor((input.now - from(goal.createdAt)) / DAY_MS));
    const createdDay = Date.parse(`${scoreDay(from(goal.createdAt), input.timeZone)}T00:00:00Z`) / DAY_MS;
    // Only completed local days: today can still move. The score window is covered by the retained goal event log.
    const days = Math.max(0, todayNumber - Math.max(createdDay, todayNumber - NOUS_SCORE_WINDOW_DAYS));
    const progress = new Set(goal.progressDays.filter((day) => day < today && Date.parse(`${day}T00:00:00Z`) / DAY_MS >= todayNumber - days));
    const withoutProgress = Math.max(0, days - progress.size);
    // Overdue days begun before the reset are already in its offset; only later ones count (no jump to 1 d right after it).
    const overdueDays = (at: number) => goal.limit?.kind === "DATE" ? Math.max(0, Math.ceil((at - Date.parse(goal.limit.until)) / DAY_MS)) : 0;
    const late = Math.max(0, overdueDays(input.now) - overdueDays(resetAt));
    return { id: goal.id, label: goal.text, points: age * w.goalPerDay + withoutProgress * w.goalNoProgressDay + late * w.goalOverdueDay,
      detail: `${age} d unmet · ${withoutProgress} d without progress in ${NOUS_SCORE_WINDOW_DAYS} days · ${late} d overdue` };
  });
  const errors = input.dailyErrors.filter((day) => day.day <= today && Date.parse(`${day.day}T00:00:00Z`) >= Date.parse(`${scoreDay(since, input.timeZone)}T00:00:00Z`));
  const errorCount = (day: NousScoreDayErrors) => day.failed + day.corrections + day.lessons + day.declined + day.predictionMisses + day.couldHaveDecided + day.chatErrors + day.decisionsFailed;
  const errorCounts = (day: NousScoreDayErrors) => `${day.failed} tool failures / ${day.calls} calls · ${day.refused} refused · ${day.corrections} corrections · ${day.lessons} lessons · ${day.declined} declined · ${day.predictionMisses} prediction misses · ${day.couldHaveDecided} could decide · ${day.chatErrors} chat errors · ${day.decisionsFailed} decisions failed`;
  const dailyErrors = errors.map((day): NousScoreItem => ({ id: null, label: day.day === today ? `Today (${day.day})` : day.day,
    points: day.failed * w.toolFailure + day.corrections * w.correction + day.lessons * w.lesson + day.declined * w.decisionDeclined
      + day.predictionMisses * w.predictionMiss + day.couldHaveDecided * w.couldHaveDecided
      + day.chatErrors * w.chatError + day.decisionsFailed * w.decisionFailed, detail: errorCounts(day) }));
  const todaysErrors = errors.find((day) => day.day === today) ?? emptyDay(today);
  if (!errors.some((day) => day.day === today)) dailyErrors.push({ id: null, label: `Today (${today})`, points: 0, detail: errorCounts(todaysErrors) });
  const totals = errors.reduce((sum, day) => {
    for (const key of ["calls", "failed", "refused", "corrections", "lessons", "declined", "predictionMisses", "couldHaveDecided", "chatErrors", "decisionsFailed"] as const) sum[key] += day[key];
    return sum;
  }, emptyDay(today));
  dailyErrors.push({ id: null, label: `${NOUS_SCORE_WINDOW_DAYS}-day totals`, points: 0, detail: errorCounts(totals) });
  const requests = input.requests.map((request): NousScoreItem => {
    const age = Math.max(0, input.now - from(request.openedAt));
    const points = w.openRequest + (age > HOUR_MS ? w.requestPast1h : 0) + (age > 6 * HOUR_MS ? w.requestPast6h : 0) + (age > DAY_MS ? w.requestPast24h : 0);
    return { id: request.id, label: request.summary, points, detail: `open ${ageText(age)}` };
  });
  const completed = input.completedPlans.filter((plan) => inWindow(plan.at))
    .map((plan): NousScoreItem => ({ id: plan.id, label: plan.title, points: w.planCompleted, detail: `completed ${plan.at.slice(0, 10)}` }));
  const done = input.done.filter((record) => inWindow(record.at))
    .map((record): NousScoreItem => ({ id: record.id, label: record.title, points: w.requestDone, detail: `recorded ${record.at.slice(0, 10)}` }));
  const use = input.utilization;
  const utilization: NousScoreItem[] = use ? [{ id: null, label: `${use.what} ${Math.round(use.value)}% against the ${use.target}% target`,
    points: round((use.value - use.target) * w.utilizationPerPoint), detail: `${signed((use.value - use.target) * w.utilizationPerPoint)} points (${w.utilizationPerPoint} a point)` }] : [];
  const lostAtResets = (input.lostAtResets ?? []).filter((row) => row.lostPercent >= 1 && inWindow(row.resetAt));
  const lostTokens = lostAtResets.map((row): NousScoreItem => ({ id: null, label: `${row.label}${row.quotaKey ? ` (${row.quotaKey})` : ""} left ${row.lostPercent}% of its week at its reset ${row.resetAt.slice(0, 10)}`,
    points: round(row.lostPercent * w.lostAtResetPerPoint), detail: `${row.lostTokens === null ? "worth unknown" : `≈ ${tokenCount(row.lostTokens)} tokens, $${Math.round(row.lostCostUsd ?? 0)}`} · ${w.lostAtResetPerPoint} a point` }));
  const lostPriced = lostAtResets.filter((row) => row.lostTokens !== null);
  // A day is judged once the scheduler's own wait for a busy pane is over (it skips the occurrence then). Every claimed occurrence leaves a
  // run row, so days before the oldest row are days before the run log existed (stable: 31/10 22:33 UTC, 43 of 46 "missed" days 4/11), never misses.
  const logStart = input.taskRuns.length ? Math.min(...input.taskRuns.map((run) => Date.parse(run.dueAt))) - 1 : since;
  const dailyTasks = input.dailyTasks.map((task): NousScoreItem => {
    const due: string[] = [];
    for (let at = nextDotScheduleRun({ kind: "DAILY", time: task.time }, task.timeZone, Math.max(Date.parse(task.createdAt), since, logStart)); at !== null && at <= input.now - DOT_SCHEDULE_GRACE_MS;
      at = nextDotScheduleRun({ kind: "DAILY", time: task.time }, task.timeZone, at)) due.push(scoreDay(at, task.timeZone));
    const ran = new Set(input.taskRuns.filter((run) => run.taskId === task.id && run.typed).map((run) => scoreDay(Date.parse(run.dueAt), task.timeZone)));
    const missed = due.filter((day) => !ran.has(day));
    return { id: task.id, label: task.title, points: missed.length * w.dailyTaskMissed || 0, // never −0
      detail: `${task.time} daily · ran ${due.length - missed.length} of ${due.length} days${missed.length ? ` · missed ${missed.join(", ")}` : ""}` };
  });
  const messageDays = new Map<string, NousScoreInput["messages"]>();
  for (const message of input.messages) if (inWindow(message.at)) {
    const day = scoreDay(Date.parse(message.at), input.timeZone);
    messageDays.set(day, [...(messageDays.get(day) ?? []), message]);
  }
  const response = [...messageDays].sort(([a], [b]) => a.localeCompare(b)).map(([day, messages]): NousScoreItem => {
    // A message still without an answer counts its wait so far.
    const replies = messages.map((message) => (message.answeredAt ? Date.parse(message.answeredAt) : input.now) - Date.parse(message.at));
    const done = messages.flatMap((message) => message.doneAt ? [Date.parse(message.doneAt) - Date.parse(message.at)] : []);
    const over = (values: number[], limit: number) => values.filter((value) => value > limit).length;
    const slow = over(replies, NOUS_SCORE_REPLY_TARGET_MS), waiting = messages.filter((message) => !message.answeredAt).length;
    return { id: null, label: day === today ? `Today (${day})` : day,
      points: slow * w.slowReply + over(replies, 10 * NOUS_SCORE_REPLY_TARGET_MS) * w.slowReplyPast10x + over(done, NOUS_SCORE_DONE_TARGET_MS) * w.slowDone + over(done, DAY_MS) * w.slowDonePast24h || 0,
      detail: `${messages.length} message${messages.length === 1 ? "" : "s"} · first answer median ${durationText(median(replies))}, slowest ${durationText(Math.max(...replies))}, ${slow} over ${durationText(NOUS_SCORE_REPLY_TARGET_MS)}`
        + (waiting ? ` (${waiting} still unanswered)` : "")
        + ` · Done ${done.length}${done.length ? `, median ${durationText(median(done))}, ${over(done, NOUS_SCORE_DONE_TARGET_MS)} over ${durationText(NOUS_SCORE_DONE_TARGET_MS)}` : ""}` };
  });
  // Each big project: its success rate and the days since its first try (Startup programs from its entries), plus what is still open on a page.
  const project = (entry: NousScoreInput["projects"][number], open: NousScoreItem[] = []) => {
    const rate = entry.tried ? (entry.succeeded / entry.tried) * 100 : 0;
    const days = entry.since ? Math.max(0, Math.floor((input.now - from(entry.since)) / DAY_MS)) : 0;
    const summary: NousScoreItem = { id: null, label: `${entry.name}: ${entry.succeeded} of ${entry.tried} ${entry.what} (${Math.round(rate)} %)`,
      points: round((100 - rate) * w.projectShortfallPerPoint + (1 - rate / 100) * days * w.projectDay) || 0,
      detail: `${days} d since the first · ${w.projectShortfallPerPoint} a point below 100 % success, ${w.projectDay} a day × the share short` };
    const items = [summary, ...open];
    return { name: entry.name, items, points: round(items.reduce((sum, item) => sum + item.points, 0)),
      detail: `${entry.succeeded} of ${entry.tried} ${entry.what}, ${Math.round(rate)} % · ${days} d${open.length ? ` · ${open.length} open` : ""}` };
  };
  const firstOf = (values: Array<string | null>) => values.filter((value): value is string => !!value).sort()[0] ?? null;
  // One Startup programs row over every program (the oll4.com funding page is gone, operator 7/11 nous_msg:e9c06cd838de45f4bccda467).
  const projectRows = [...[input.programs].flatMap((entries) => {
    if (!entries.length) return [];
    const sent = entries.filter((program) => SUBMITTED_PROGRAMS.has(program.status));
    const name = "Startup programs";
    return [project({ name, succeeded: sent.filter((program) => program.status === "APPROVED").length, tried: sent.length, what: "applications approved",
      since: firstOf(sent.map((program) => program.appliedAt)) ?? firstOf(entries.map((program) => program.createdAt)) },
    entries.filter((program) => OPEN_PROGRAMS.has(program.status)).map((program): NousScoreItem =>
      ({ id: program.id, label: `${program.parent} › ${program.program}`, points: program.status === "NOT_APPLIED" ? w.programNotApplied : w.programOpen, detail: `${name} · ${program.status.toLowerCase().replace(/_/g, " ")}` })))];
  }), ...input.projects.map((entry) => project(entry))];
  const projects = projectRows.flatMap((row) => row.items);
  const missedDays = dailyTasks.reduce((sum, item) => sum + item.points / w.dailyTaskMissed, 0);
  const todayResponse = response.find((item) => item.label.startsWith("Today"));
  const card = input.scorecard;
  // The scorecard folded in: each dimension's weighted change against its baseline (their sum is the overall's change).
  const scorecard = card ? (Object.entries(card.dimensions) as Array<[NousDimension, NousDimensionScore]>).map(([key, value]): NousScoreItem =>
    ({ id: null, label: `${key} ${value.score} (baseline ${value.baseline})`, points: round(NOUS_WEIGHTS[key] * value.change * w.scorecardPerPoint), detail: value.note })) : [];
  const baseline = input.reset?.tiles;
  const resetLabel = input.reset ? `At the reset ${input.reset.at.slice(0, 16).replace("T", " ")} UTC` : "";
  const tiles = [
    tile("plans", "Open plans", plans, `${plans.length} open`),
    tile("panes", "Open panes", [...panes, ...paneDays], `${panes.length} open · ${panes.filter((pane) => pane.points < w.openPane).length} idle past 1 h`
      + (paneDays.length ? ` · ${round(input.paneDays.reduce((sum, day) => sum + day.average, 0) / input.paneDays.length)} open a day on average` : "")),
    tile("browsers", "Idle open browsers", [...idleBrowsers, ...reapedBrowsers], `${idleBrowsers.length} open unused past 30 min · ${reapedBrowsers.length} closed by Space in ${NOUS_SCORE_WINDOW_DAYS} days`),
    tile("goals", "Goals", goals, `${goals.length} active · unmet days, no progress and overdue`),
    tile("projects", "Big projects", projects, `${projectRows.length} projects · lower success and more days cost more`),
    tile("dailyTasks", "Daily tasks", dailyTasks, `${dailyTasks.length} daily · ${missedDays} missed days in ${NOUS_SCORE_WINDOW_DAYS} days`),
    tile("response", "Response time", response, todayResponse ? `Today: ${todayResponse.detail}` : `No operator message today · first answer within ${durationText(NOUS_SCORE_REPLY_TARGET_MS)}`),
    tile("dailyErrors", "Daily Nous errors", dailyErrors, `Today: ${errorCount(todaysErrors)} · ${NOUS_SCORE_WINDOW_DAYS} days: ${errorCount(totals)}`),
    tile("requests", "Open requests", requests, `${requests.length} open`),
    tile("approvedNotDone", "Approved but not done", approved, `${approved.length} not done · ${approved.filter((item) => item.points < 0).length} past the ${w.approvedNotDoneGraceHours} h grace`),
    tile("completed", "Plans completed", completed, `${completed.length} in ${NOUS_SCORE_WINDOW_DAYS} days`),
    tile("done", "Requests done", done, `${done.length} in ${NOUS_SCORE_WINDOW_DAYS} days`),
    tile("utilization", "Utilization", utilization, `${use ? `${Math.round(use.value)}% · target ${use.target}%` : "no sample yet"}`),
    tile("lostTokens", "Lost tokens", lostTokens, lostAtResets.length
      ? `${round(lostAtResets.reduce((sum, row) => sum + row.lostPercent, 0))} points of weeks left unused at their resets in ${NOUS_SCORE_WINDOW_DAYS} days`
        + (lostPriced.length ? ` ≈ ${tokenCount(lostPriced.reduce((sum, row) => sum + row.lostTokens!, 0))} tokens, $${Math.round(lostPriced.reduce((sum, row) => sum + (row.lostCostUsd ?? 0), 0))}` : "")
      : `no week left room at its reset in ${NOUS_SCORE_WINDOW_DAYS} days`),
    tile("scorecard", "Scorecard", scorecard, card ? `${card.overall} vs ${card.baselineOverall} on ${card.baselineDate}` : "not read"),
    ...(input.marketing ? [tile("marketing", "Marketing", marketingItems(input.marketing, input.now, resetAt), input.marketing.score === null
      ? "no post measured yet" : `${input.marketing.score}/100 · target ${input.marketing.target} · ${input.marketing.daysBelowTarget} d below it`)] : []),
    ...(input.reset && !baseline ? [tile("reset", "Score reset", [{ id: null, label: `Set to 0 on ${input.reset.at.slice(0, 16).replace("T", " ")} UTC`, points: -input.reset.offset,
      detail: `the score then (${signed(input.reset.offset)}) taken off; only what happens after it moves the score` }], "only what happens after it counts")] : [])
  ].map((entry) => baseline?.[entry.key] ? { ...entry, points: round(entry.points - baseline[entry.key]!),
    items: [...entry.items, { id: null, label: resetLabel, points: -baseline[entry.key]!, detail: "what this counted then, taken off; only what happens after it moves it" }] } : entry);
  // What makes up the negative (operator 4/11 nous_msg:5e5d7526): every costing tile, each big project on its own, biggest first.
  const costs = [...tiles.filter((entry) => entry.key !== "projects" && entry.key !== "reset" && entry.points < 0).map((entry) => ({ label: entry.label, points: entry.points, detail: entry.detail })),
    ...projectRows.filter((row) => row.points < 0).map((row) => ({ label: row.name, points: row.points, detail: row.detail }))];
  const lost = costs.reduce((sum, entry) => sum + entry.points, 0);
  const breakdown = costs.map((entry) => ({ ...entry, share: round((entry.points / lost) * 100) })).sort((a, b) => a.points - b.points);
  // Levers: every open item a move of Nous's removes or stops growing, costliest by tomorrow first (no count: No Arbitrary Limits).
  const requestPoints = (age: number) => w.openRequest + (age > HOUR_MS ? w.requestPast1h : 0) + (age > 6 * HOUR_MS ? w.requestPast6h : 0) + (age > DAY_MS ? w.requestPast24h : 0);
  const idlePanes = panes.filter((pane) => pane.points < w.openPane);
  const levers: NousScoreLever[] = [
    ...input.plans.map((plan, index): NousScoreLever => {
      const days = Math.floor(Math.max(0, input.now - from(plan.createdAt)) / DAY_MS);
      const progress = plan.progress ?? 0;
      return { id: plan.id, label: `Plan [${plan.id}] "${plan.title}" ${progress}%`, points: plans[index]!.points,
        perDay: w.openPlanPerDay * ((days + 1) ** w.planAgeExponent - days ** w.planAgeExponent),
        action: progress >= 95 ? "complete it with its proof (space_plan_update), it removes all of it"
          : plan.working ? `${plan.pane ?? "its pane"} works on it: send the next step the moment it reports`
            : plan.pane ? `send ${plan.pane} its next step now` : "no pane works on it: open one and send the next step" };
    }),
    ...input.requests.map((request, index): NousScoreLever => {
      const age = Math.max(0, input.now - from(request.openedAt));
      return { id: request.id, label: `Request${request.id ? ` [${request.id}]` : ""} «${request.summary}»`, points: requests[index]!.points,
        perDay: requestPoints(age + DAY_MS) - requestPoints(age), action: "deliver it and record it Done (space_request_done); a pane on it now if none works on it" };
    }),
    ...notDone.map((decision, index): NousScoreLever => {
      const age = Math.max(0, input.now - approvedAt(decision));
      return { id: decision.id, label: `Approved [${decision.id}] «${decision.title}»: ${notDoneCause(decision)}`, points: approved[index]!.points,
        perDay: round(approvalPoints(age + DAY_MS) - approvalPoints(age)), action: "run it now and confirm it (space_mail_read SENT); done another way or no longer wanted: space_settle_decision with its proof" };
    }),
    ...input.goals.filter((goal) => goal.status === "ACTIVE").map((goal, index): NousScoreLever => {
      const late = goal.limit?.kind === "DATE" && Date.parse(goal.limit.until) < input.now + DAY_MS;
      return { id: goal.id, label: `Goal [${goal.id}] (its words in ## Goals)`, points: goals[index]!.points,
        perDay: w.goalPerDay + (goal.progressDays.includes(today) ? 0 : w.goalNoProgressDay) + (late ? w.goalOverdueDay : 0),
        action: "move its costliest plan and record today's progress (space_goal_update); achieved with evidence removes all of it" };
    }),
    ...dailyTasks.filter((task) => task.points < 0).map((task): NousScoreLever => ({ id: task.id, label: `Daily task [${task.id}] "${task.label}"`, points: task.points,
      perDay: w.dailyTaskMissed, action: "make sure today's run reaches its pane (space_tasks); missed days leave only with the window" })),
    ...(idlePanes.length ? [{ id: null, label: `${idlePanes.length} pane${idlePanes.length === 1 ? "" : "s"} idle or finished past 1 h`, points: round(idlePanes.reduce((sum, pane) => sum + pane.points, 0)),
      perDay: round(idlePanes.length * w.paneDay), action: "save each to memory and close it (Standing orders) before you open new panes: it frees RAM and room slots" }] : []),
    ...(input.browsers?.idle ?? []).map((browser, index): NousScoreLever => ({ id: browser.id, label: `Browser of ${browser.title} unused ${ageText(Math.max(0, input.now - from(browser.idleSince)))}`,
      points: idleBrowsers[index]!.points, perDay: 24 * w.idleBrowserPerHour,
      action: `close it: close its pane if it is done, or its tabs (space_browser_close_tab); each one Space has to close costs ${w.browserReaped}` })),
    ...(use && use.value < use.target ? [{ id: null, label: `Utilization ${Math.round(use.value)}% against ${use.target}%`, points: utilization[0]!.points, perDay: 0,
      action: "dispatch now: plans and requests to idle panes, helpers (space_subagents) on free slots, panes on pools the Provider advice says to use" }] : [])
  ].filter((lever) => lever.points + lever.perDay < 0).sort((a, b) => (a.points + a.perDay) - (b.points + b.perDay));
  return { score: round(tiles.reduce((sum, entry) => sum + entry.points, 0)), tiles, breakdown, levers };
}

/** The world's "## Score levers now": every lever costliest by tomorrow first, then the costs no move removes (they leave the window by themselves). */
export function nousScoreLeversText(levers: NousScoreLever[], score: Pick<NousScore, "tiles">): string {
  const passive = score.tiles.filter((entry) => ["dailyErrors", "response", "lostTokens"].includes(entry.key) && entry.points < 0);
  return ["## Score levers now (your first measure: take the top move first; points now → tomorrow if left · the move that cuts them)",
    ...(levers.length ? levers.map((lever) => `- ${lever.label.replace(/\s+/g, " ")} · ${signed(lever.points)} now → ${signed(lever.points + lever.perDay)} tomorrow · ${lever.action}`) : ["- none"]),
    ...(passive.length ? [`No move removes ${passive.map((entry) => `${entry.label} ${signed(entry.points)}`).join(", ")}: they leave the ${NOUS_SCORE_WINDOW_DAYS}-day window by themselves; add no new ones.`] : [])].join("\n");
}

/** The world's line and space_nous_progress's: the score, its changes and the tile that costs most with its worst item. */
export function nousScoreLine(score: NousScore): string {
  const worst = [...score.tiles].sort((a, b) => a.points - b.points)[0];
  const item = worst?.items[0];
  const change = (label: string, value: number | null) => value === null ? `${label} –` : `${label} ${signed(value)}`;
  return `Score: ${signed(score.score)} (${change("Δ24h", score.change24h)}, ${change("Δ7d", score.change7d)})`
    + (worst && worst.points < 0 ? `, worst: ${worst.label} ${signed(worst.points)}${item && item.points < 0 ? ` (${item.label.slice(0, 80)} ${signed(item.points)})` : ""}` : "")
    + score.tiles.filter((tile) => ["panes", "browsers", "goals", "dailyErrors", "dailyTasks", "response", "projects", "marketing", "lostTokens", "approvedNotDone"].includes(tile.key))
      .map((tile) => `, ${tile.label}: ${tile.detail} (${signed(tile.points)})`).join("")
    + (score.breakdown.length ? `. Negative by variable: ${score.breakdown.map((entry) => `${entry.label} ${signed(entry.points)} (${entry.share} %)`).join(", ")}` : "")
    + ". Open panes (now and each past day's average), browsers kept open unused past 30 min (per hour, and each Space had to close) and requests cost points; plan age grows quadratically. Unmet goals cost per day, more without progress or past deadline. Daily errors count failed tools, failed or timed-out turns and declined, mispredicted or failed decisions."
    + " Each missed day of a daily task costs points, so does a first answer slower than 2 min or a Done slower than 6 h, and the big projects' (funding, jobs, crypto, freelance) low success, more each day without it, and marketing below its target (failed and no-reach posts, days without a result)."
    + ` Lost tokens (a subscription week left unused at its reset) cost ${-NOUS_SCORE_WEIGHTS.lostAtResetPerPoint} a point.`
    + ` EXTERNAL decisions approved and not confirmed done (their copilot item's final state or its replacement post's, not before an approved post's scheduled date, one done settles its duplicates, a send of ours to their recipients or in any thread of any account with no bounce for them after it, else an outcome that ran; space_settle_decision marks one done with proof or void) cost points past a ${NOUS_SCORE_WEIGHTS.approvedNotDoneGraceHours} h grace, more each hour.`;
}

type ScoreRow = { at: string; score: number; parts?: Record<string, number> };
interface Repository {
  addScoreSnapshot(snapshot: NousScoreSnapshot): Promise<boolean>;
  listScoreSnapshots(owner: string, since: string): Promise<ScoreRow[]>;
}

/** Each completed local day of the window whose snapshots counted the open panes: their average and peak (today is charged by the open panes). */
export function paneDaysOf(rows: ScoreRow[], now: number, timeZone: string): NousScoreInput["paneDays"] {
  const first = scoreDay(now - NOUS_SCORE_WINDOW_DAYS * DAY_MS, timeZone), today = scoreDay(now, timeZone);
  const days = new Map<string, number[]>();
  for (const row of rows) {
    const count = row.parts?.openPanes;
    const day = scoreDay(Date.parse(row.at), timeZone);
    if (typeof count !== "number" || day < first || day >= today) continue;
    days.set(day, [...(days.get(day) ?? []), count]);
  }
  return [...days].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, counts]) => ({ day, average: counts.reduce((sum, count) => sum + count, 0) / counts.length, peak: Math.max(...counts) }));
}

export function createNousScore(deps: { repository: Repository; input(owner: string, now: number): Promise<Omit<NousScoreInput, "paneDays">>; owners(): Promise<string[]>;
  /** Stores the owner's reset (NOUS_SCORE_RESET_NOTE) so input() returns it from then on. */
  saveReset?(owner: string, reset: NousScoreReset): Promise<void>;
  now?: () => number; warn?(error: unknown): void }) {
  const now = deps.now ?? Date.now;
  const latest = new Map<string, NousScore>();
  const leversOf = new Map<string, NousScoreLever[]>();
  const running = new Map<string, Promise<NousScore>>();
  // The retained snapshots (30 days), read once per owner; each snapshot this process writes is appended, so neither Δ nor the graph reads them again.
  const snapshots = new Map<string, Promise<ScoreRow[]>>();
  // What a view's snapshot stores: each tile's points and the open panes counted (paneDaysOf reads them back).
  const partsOf = new WeakMap<NousScore, Record<string, number>>();
  const events = new Map<string, ReturnType<typeof setTimeout>>();

  function rowsOf(owner: string): Promise<ScoreRow[]> {
    let rows = snapshots.get(owner);
    if (!rows) {
      snapshots.set(owner, rows = deps.repository.listScoreSnapshots(owner, new Date(now() - 30 * DAY_MS).toISOString()));
      rows.catch(() => snapshots.delete(owner));
    }
    return rows;
  }
  async function compute(owner: string): Promise<NousScore> {
    const at = now();
    const [base, all] = await Promise.all([deps.input(owner, at), rowsOf(owner)]);
    // Snapshots before the reset count neither in the pane days nor in Δ.
    const history = base.reset ? all.filter((row) => Date.parse(row.at) >= Date.parse(base.reset!.at)) : all;
    const { score, tiles, breakdown, levers } = nousScore({ ...base, paneDays: paneDaysOf(history, at, base.timeZone) });
    // The snapshot nearest before the mark, within an hour of it (none when the history is younger).
    const ago = (ms: number) => {
      const before = history.filter((row) => Date.parse(row.at) <= at - ms && Date.parse(row.at) > at - ms - HOUR_MS).at(-1);
      return before ? round(score - before.score) : null;
    };
    const view: NousScore = { at: new Date(at).toISOString(), score, change24h: ago(DAY_MS), change7d: ago(7 * DAY_MS), tiles, breakdown, resetAt: base.reset?.at ?? null };
    partsOf.set(view, { ...Object.fromEntries(tiles.map((entry) => [entry.key, entry.points])), openPanes: base.panes.length });
    latest.set(owner, view);
    leversOf.set(owner, levers);
    return view;
  }
  function refresh(owner: string): Promise<NousScore> {
    let pending = running.get(owner);
    if (!pending) running.set(owner, pending = compute(owner).finally(() => running.delete(owner)));
    return pending;
  }

  let snapshotRunning: Promise<void> | null = null;
  function snapshot(): Promise<void> {
    if (snapshotRunning) return snapshotRunning;
    snapshotRunning = (async () => {
      await Promise.all([...new Set(await deps.owners())].map(async (owner) => {
        try {
          const view = await refresh(owner);
          const parts = partsOf.get(view) ?? {};
          await deps.repository.addScoreSnapshot({ ownerUserId: owner, at: view.at, score: view.score, parts });
          const rows = await rowsOf(owner);
          rows.push({ at: view.at, score: view.score, parts });
          rows.splice(0, rows.findIndex((row) => Date.parse(row.at) >= now() - 30 * DAY_MS));
        } catch (error) { deps.warn?.(error); }
      }));
    })().catch((error) => deps.warn?.(error)).finally(() => { snapshotRunning = null; });
    return snapshotRunning;
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let first: ReturnType<typeof setTimeout> | null = null;
  return {
    start() {
      if (timer) return;
      (first = setTimeout(() => void snapshot(), NOUS_SCORE_STARTUP_MS)).unref?.();
      (timer = setInterval(() => void snapshot(), NOUS_SCORE_SNAPSHOT_MS)).unref?.();
    },
    stop() {
      if (first) clearTimeout(first); if (timer) clearInterval(timer); first = timer = null;
      for (const pending of events.values()) clearTimeout(pending);
      events.clear();
    },
    snapshot,
    /** Something that moves the score happened (the operator wrote): one recompute NOUS_SCORE_EVENT_DELAY_MS later, however many come meanwhile. */
    changed(owner: string) {
      if (events.has(owner)) return;
      const pending = setTimeout(() => { events.delete(owner); void refresh(owner).catch((error) => deps.warn?.(error)); }, NOUS_SCORE_EVENT_DELAY_MS);
      pending.unref?.();
      events.set(owner, pending);
    },
    /** GET /api/nous/score: the newest view as it is; only an owner never computed yet waits for a first one. */
    view: (owner: string): Promise<NousScore> => { const kept = latest.get(owner); return kept ? Promise.resolve(kept) : refresh(owner); },
    /** The newest score computed, without computing (the world and space_nous_progress read it every turn); null before the first. */
    cached: (owner: string) => latest.get(owner) ?? null,
    /** The world's "## Score levers now" from the newest score; null before the first. */
    leversText: (owner: string) => { const kept = latest.get(owner); return kept ? nousScoreLeversText(leversOf.get(owner) ?? [], kept) : null; },
    /**
     * Score reset (admin action nous-score-reset, operator 9/11 nous_msg:8d5af119): the score with every window starting now is stored as the
     * offset and each tile's points as its baseline (operator 11/11: every tile 0, no ±), so all read 0 now and only what happens after moves
     * them. Deletes nothing: older snapshots stay, the chart starts here.
     */
    async reset(owner: string): Promise<NousScore> {
      if (!deps.saveReset) throw new Error("The score reset is not wired here.");
      const at = new Date(now()).toISOString();
      // Errors and pane days are events, so none fall after a reset made this instant.
      const { score, tiles } = nousScore({ ...(await deps.input(owner, Date.parse(at))), reset: { at, offset: 0 }, dailyErrors: [], paneDays: [] });
      await deps.saveReset(owner, { at, offset: score, tiles: Object.fromEntries(tiles.filter((entry) => entry.points !== 0).map((entry) => [entry.key, entry.points])) });
      await running.get(owner)?.catch(() => null); // a compute started before the reset would show the old score
      return refresh(owner);
    },
    /** The snapshots averaged per step of the range, and the newest view as the last point; no recompute. */
    async history(owner: string, range: NousScoreRange): Promise<NousScoreHistory> {
      const rows = await rowsOf(owner);
      const at = now();
      const span = range === "24h" ? DAY_MS : range === "7d" ? 7 * DAY_MS : 30 * DAY_MS;
      // The chart starts at the reset.
      const start = Math.max(at - span, Date.parse(latest.get(owner)?.resetAt ?? "") || 0);
      const size = range === "24h" ? NOUS_SCORE_SNAPSHOT_MS : range === "7d" ? HOUR_MS : 4 * HOUR_MS;
      const groups = new Map<number, { total: number; count: number }>();
      for (const row of rows) {
        const time = Date.parse(row.at);
        if (time < start || time > at) continue;
        const key = Math.floor(time / size) * size;
        const group = groups.get(key) ?? { total: 0, count: 0 };
        group.total += row.score; group.count += 1; groups.set(key, group);
      }
      const points = [...groups].sort(([a], [b]) => a - b).map(([time, group]) => ({ at: new Date(time).toISOString(), value: round(group.total / group.count) }));
      const live = latest.get(owner);
      if (live && Date.parse(live.at) >= start && (!points.length || Date.parse(live.at) > Date.parse(points.at(-1)!.at))) points.push({ at: live.at, value: live.score });
      return { range, points };
    }
  };
}
export type NousScoreService = ReturnType<typeof createNousScore>;

export function registerNousScoreRoutes(app: FastifyInstance, deps: {
  score: NousScoreService; routeOptions: Record<string, unknown>; owner(request: FastifyRequest): Promise<string>;
  parseQuery<TSchema extends z.ZodTypeAny>(schema: TSchema, query: unknown): z.infer<TSchema>;
}): void {
  const query = z.object({ range: nousScoreRangeSchema.default("24h") }).strict();
  app.get("/api/nous/score", deps.routeOptions, async (request) => deps.score.view(await deps.owner(request)));
  app.post("/api/nous/score/reset", deps.routeOptions, async (request) => deps.score.reset(await deps.owner(request)));
  app.get("/api/nous/score/history", deps.routeOptions, async (request) =>
    deps.score.history(await deps.owner(request), deps.parseQuery(query, request.query).range));
}
