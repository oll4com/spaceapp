import { cliToggleRuntimeIds, type ClipboardItem, type ManagedPlanExecution, type NousDecision, type NousSettings, type NousTurnFacts, type Pane, type SpaceNotification, type TaskItem } from "@space/contracts";
import type { NousLedgerRow, NousPaneCloseout, RailDecisionCount, NousPaneCloseoutsRepository, NousPaneSummaryRow, NousPlanMarksRepository, PaneReport } from "@space/db";
import { isCliPane } from "../pane-guards.js";
import { durationText, paneLabel } from "./digest.js";
import { boardPanes, type BoardPaneInput, type PaneBoardSnapshot } from "./pane-board.js";
import { NOUS_PANE_NOTICE_PREFIX } from "./pane-notices.js";
import { nousPlanActivity, renderStandingPlansPrompt } from "./stalled-plans.js";
import { stalledHold, type PlanMap } from "./plan-map.js";

/**
 * Standing orders (operator orders 2026-10-21): Space itself, every `tickMinutes`, 24/7 and whatever the inbox does, finds
 * (a) the finished CLI panes (done or idle for `finishedAfterMinutes`, nothing waiting on them) and (b) the stalled plans, and
 * brings them to Nous in a STANDING turn of their own until each one is handled. Nous does the judgment and the actions per
 * pane with its tools: it sends "save to memory" (space_send_to_pane), Space verifies the save from the pane's reports, Nous
 * closes the pane (space_close_pane) or keeps it open (space_pane_checked KEEP_OPEN). The close-out's state per pane lives in
 * nous_pane_closeouts, written from Nous's own tool calls (tools.ts), so a restart loses nothing and nothing is asked twice.
 * Until 2026-10-20 the rule lived only in Space Memory and in a follow-up Nous re-armed hourly, and that chain broke.
 */
import { NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT } from "./save-request.js";
import { localDayHour, NOUS_REVIEW_WINDOW_MS, renderDailyReview } from "./daily-review.js";
export { NOUS_SAVE_REQUEST, NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT } from "./save-request.js";
const MEMORY_ID = /space_memory:[a-f0-9]{6,}/i;
const SAVED_WORDS = /\b(?:saved|deduplicated)\b/i;
const MINUTE = 60_000;
/** A save request still settling: the pane's turn and its report take a moment. */
const SETTLE_MS = 2 * MINUTE;
/** After this without a verified save the pane is Nous's call: read it, ask once more, or keep it open. */
export const NOUS_SAVE_WAIT_MS = 20 * MINUTE;
/** The same pane line is not repeated to Nous more often than this unless its state changed. */
const RELIST_MS = 30 * MINUTE;
const KEEP_VERDICTS = new Set(["KEEP_OPEN", "WAITING_OPERATOR", "WAITING_DATE", "BLOCKED"]);
const BOARD_WAITS = new Set(["OPERATOR", "DATE", "PROMOTE", "THIRD_PARTY"]);
const OPEN_PLAN = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
/** A pane whose task runs this soon stays open: closing it would only reopen it (operator order 2026-10-24: task panes close too). */
const TASK_SOON_MS = 60 * MINUTE;

export type CloseoutSkip = "always-on" | "browser-held" | "busy" | "unknown" | "fresh" | "operator-test" | "keep-open" | "waiting-operator" | "card-check" | "task" | "managed" | "plan-open" | "board-waits" | "board-check";
/** A browser tab count above this shows on the pane's line, so Nous has the finished tabs closed (browser hygiene, operator 27/10). */
export const NOUS_TABS_SHOWN_ABOVE = 3;
const isNousCard = (item: SpaceNotification) => item.source === "NOUS" && Boolean(item.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX));

/**
 * A pane's live browser as the standing orders read it (the census's own records, no Browser Host call): its tabs, who holds it
 * (a control lease, a handoff, a Vault fence; "unknown" when a read failed: kept open) and when it last moved (the tab-list polls
 * of an open browser pane and its frames stamp it every few seconds while it is on screen).
 */
export interface CloseoutBrowser { tabs: number; held: "control" | "handoff" | "vault" | "unknown" | null; activeAt: string | null }

export interface CloseoutContext {
  /** When the pane's current state began (agents-dashboard `since`). */
  since(paneId: string): string | null;
  /** Live pane browsers by pane id; null when they could not be read (then no pane without a CLI is listed). */
  browsers?: ReadonlyMap<string, CloseoutBrowser> | null;
  /** Other recorded use by pane id (a YouTube pane's playback). */
  usedAt?: ReadonlyMap<string, string>;
  tasks: TaskItem[];
  executions: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>;
  summaries: NousPaneSummaryRow[];
  now: number;
  finishedAfterMs: number;
  /** Settings standingOrders.closeOperatorPanes: false keeps OPERATOR_TEST panes open. */
  closeOperatorPanes?: boolean;
}

/** A pane with an AI CLI saves to memory before it closes; every other pane (a browser, a plain shell, ...) has nothing to save. */
export function savesToMemory(pane: Pick<Pane, "mode" | "terminalRuntimeId">): boolean {
  return isCliPane(pane) && (cliToggleRuntimeIds as readonly string[]).includes(pane.terminalRuntimeId ?? "");
}

/**
 * When the pane last did or showed anything: an AI CLI's own state; for any other pane the newest of its state, its record, its
 * browser and its playback, so a browser on screen or a video playing is never finished.
 */
export function closeoutSince(input: Pick<BoardPaneInput, "pane">, ctx: CloseoutContext): string | null {
  const { pane } = input;
  if (savesToMemory(pane)) return ctx.since(pane.id);
  const times = [ctx.since(pane.id), pane.updatedAt, ctx.browsers?.get(pane.id)?.activeAt, ctx.usedAt?.get(pane.id)]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return times.length ? times.reduce((newest, value) => Date.parse(value) > Date.parse(newest) ? value : newest) : null;
}

/** Why a pane is not a finished pane to close, null when it is one. */
export function closeoutSkipReason(input: BoardPaneInput, ctx: CloseoutContext): CloseoutSkip | null {
  const { pane, state, check } = input;
  // The Mail Copilot works the mail as it arrives and sorts the inbox daily: it is never a finished pane (operator 2026-10-27).
  if (pane.mode === "MAIL_COPILOT") return "always-on";
  // Every pane type closes once finished (operator 27/10 «όλα του τύπου Panes»; copilot, Design, App Studio and Video panes since
  // 2026-10-24), but a browser someone holds is in use: a control lease, a handoff, a Vault fence.
  if (ctx.browsers?.get(pane.id)?.held) return "browser-held";
  if (ctx.browsers === null && !savesToMemory(pane)) return "unknown";
  if (state !== "done" && state !== "idle") return "busy";
  const since = closeoutSince(input, ctx);
  if (!since) return "unknown";
  if (check?.verdict === "OPERATOR_TEST" && ctx.closeOperatorPanes === false) return "operator-test";
  if (check?.verdict && KEEP_VERDICTS.has(check.verdict) && check.nextCheckAt && Date.parse(check.nextCheckAt) > ctx.now) return "keep-open";
  if (input.decisions.length || input.copilotItems.length || input.notifications.some((item) => !isNousCard(item))) return "waiting-operator";
  // Only Nous's own card waits, on a pane finished since: Nous re-checks it (stable 2026-10-22: cards of 10-17..10-19 kept panes and rooms "Needs attention").
  if (input.notifications.length) {
    const old = (iso: string) => ctx.now - Date.parse(iso) >= ctx.finishedAfterMs;
    return old(since) && input.notifications.every((card) => old(card.updatedAt)) ? "card-check" : "waiting-operator";
  }
  const task = keptOpenForTask(pane.id, ctx.tasks);
  if (task && Date.parse(task.schedule?.nextRunAt ?? "") - ctx.now < TASK_SOON_MS) return "task";
  if (ctx.executions.some((execution) => execution.paneId === pane.id)) return "managed";
  const plan = input.plan;
  if (plan && plan.progressPercentage < 100 && !OPEN_PLAN.has(plan.executionStatus) && plan.steps.some((step) => step.status !== "COMPLETED")) return "plan-open";
  const summary = latestSummary(pane.id, ctx.summaries);
  const fresh = ctx.now - Date.parse(since) < ctx.finishedAfterMs;
  // The board's wait is a model's reading of the last answer: once the pane is finished long enough Nous re-checks it (stable 2026-10-24: panes "waiting" 3 days, nothing open for the operator).
  if (summary && BOARD_WAITS.has(summary.waitsOn) && summary.generatedAt >= since) return fresh ? "board-waits" : "board-check";
  if (fresh) return "fresh";
  return null;
}

const latestSummary = (paneId: string, summaries: NousPaneSummaryRow[]) =>
  summaries.filter((row) => row.paneId === paneId).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];

/** The scheduled task bound to a pane, null when none; the scheduler reopens a closed pane when it falls due. */
export function keptOpenForTask(paneId: string, tasks: TaskItem[]): TaskItem | null {
  return tasks.find((task) => task.paneId === paneId && task.schedule) ?? null;
}

/** The memory id (or "saved") a pane's reports since the request carry, null when the save is not visible yet. */
export function verifyMemorySave(reports: PaneReport[], since: string, lastAnswer: string | null): string | null {
  const after = reports.filter((report) => report.at >= since);
  for (const report of after) {
    const id = MEMORY_ID.exec(`${report.summary}\n${report.body ?? ""}`);
    if (id) return id[0];
  }
  // The transcript's last answer only counts once a turn ended after the request (a report of its own), never an older answer.
  const id = after.length && lastAnswer ? MEMORY_ID.exec(lastAnswer) : null;
  if (id) return id[0];
  return after.some((report) => SAVED_WORDS.test(`${report.summary}\n${report.body ?? ""}`)) ? "saved" : null;
}

export type StandingResult = "STARTED" | "QUEUED" | "OFF" | "PAUSED" | "CAPPED";

export interface StandingOrdersDeps {
  closeouts: NousPaneCloseoutsRepository;
  marks: NousPlanMarksRepository;
  settings(owner: string): Promise<NousSettings>;
  lowToken?(owner: string): Promise<boolean>;
  owners(): Promise<string[]>;
  collect(owner: string): Promise<PaneBoardSnapshot & { tasks: TaskItem[]; executions: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>; summaries: NousPaneSummaryRow[];
    /** Live pane browsers and other recorded use (YouTube playback), by pane id. */
    browsers?: ReadonlyMap<string, CloseoutBrowser> | null; usedAt?: ReadonlyMap<string, string> }>;
  /** One pane's reports since a time (newest first is fine). */
  reportsSince(owner: string, paneId: string, since: string): Promise<PaneReport[]>;
  /** The plan map (plan-map.ts): a plan held on a date, another plan or the server is never nudged; the tick also fires its hold alerts. */
  planMap?(owner: string, plans: ClipboardItem[]): Promise<PlanMap>;
  lastAnswer?(pane: Pane): Promise<string | null>;
  /** Starts the STANDING turn (or the Away HEARTBEAT round, or the daily REVIEW) with this text (service.standing). */
  standing(owner: string, reason: "STANDING" | "HEARTBEAT" | "REVIEW", text: string): Promise<StandingResult>;
  /** The daily self-review's sources (operator decision 2026-10-24): the owner's turn facts and decisions, and their working time zone. */
  review?: {
    facts(owner: string, since: string): Promise<NousTurnFacts[]>;
    decisions(owner: string): Promise<NousDecision[]>;
    /** Nous's NOUS notifications (cards and focus requests), for the review's questions to the operator. */
    cards?(owner: string): Promise<SpaceNotification[]>;
    /** The operator's answers in every copilot rail (goal 7365014c-b); absent where Space has no database. */
    rails?(owner: string, since: string): Promise<RailDecisionCount[]>;
    /** Goal 7365014c-e: the decision ledger's rows since then. */
    ledger?(owner: string, since: string): Promise<NousLedgerRow[]>;
    timeZone(owner: string): Promise<string>;
  };
  /** The pane round's inbox line when panes are due (pane-watch.ts), every 30 minutes. */
  paneRound?(owner: string, rooms: PaneBoardSnapshot["rooms"]): Promise<string | null>;
  notice?(owner: string, key: string, line: string): Promise<void>;
  /** The operator is away (away.ts): the round runs every 30 minutes even with nothing due. */
  away?(owner: string): Promise<boolean>;
  serverLine?(): Promise<string | null>;
  log?: { warn(details: Record<string, unknown>, message: string): void };
  now?: () => number;
}

export interface StandingTickResult { paneLines: number; stalledPlans: number; turn: StandingResult | null }

const hhmm = (iso: string) => `${iso.slice(11, 16)} UTC`;
/** What a pane without an AI CLI is, for its line. */
const closeKind = (pane: Pane) => pane.mode === "TERMINAL" ? "shell (no AI CLI)" : `${pane.mode.toLowerCase().replace(/_/g, " ")} pane`;
/** Space records use of browsers, YouTube and chats; a shell or another kind gets a look before the close. */
const lookFirst = (pane: Pane) => pane.mode === "TERMINAL" ? " after a look (space_read_pane: a command still running keeps it open)"
  : ["BROWSER", "YOUTUBE", "CHAT"].includes(pane.mode) ? "" : " after a look (space_inspect: Space records no use of this kind)";
const dayHhmm = (iso: string) => `${iso.slice(0, 10)} ${hhmm(iso)}`;
const where = (input: BoardPaneInput) => `${input.room.name}/${paneLabel(input.pane)}`;

export function createStandingOrders(deps: StandingOrdersDeps) {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();
  const lastTick = new Map<string, number>();
  const lastRound = new Map<string, number>();
  const lastAway = new Map<string, number>();
  /** What each pane was last listed as, and when, so an unhandled line repeats only every 30 minutes. */
  const listed = new Map<string, { key: string; at: number }>();
  /** The local day a review turn was asked for (started or queued), so a running review is not asked again by the next tick. */
  const reviewed = new Map<string, string>();
  const warn = (details: Record<string, unknown>, message: string) => deps.log?.warn(details, message);

  /** Starts today's review turn when it is due and none ran today (the facts rows say, so a restart asks nothing twice). */
  async function dailyReviewTurn(owner: string, hour: number, at: number): Promise<StandingResult | null> {
    const zone = await deps.review!.timeZone(owner).catch(() => "UTC");
    const local = localDayHour(at, zone);
    if (local.hour < hour || reviewed.get(owner) === local.day) return null;
    const since = new Date(at - NOUS_REVIEW_WINDOW_MS).toISOString();
    const facts = await deps.review!.facts(owner, since);
    if (facts.some((turn) => turn.reason === "REVIEW" && localDayHour(Date.parse(turn.startedAt), zone).day === local.day)) { reviewed.set(owner, local.day); return null; }
    const text = renderDailyReview({ facts, decisions: await deps.review!.decisions(owner).catch(() => []),
      cards: await deps.review!.cards?.(owner).catch(() => []) ?? [], ...(deps.review!.rails ? { rails: await deps.review!.rails(owner, since).catch(() => null) } : {}),
      ...(deps.review!.ledger ? { ledger: await deps.review!.ledger(owner, since).catch(() => []) } : {}), since, day: local.day, hour });
    const result = await deps.standing(owner, "REVIEW", text);
    if (result === "STARTED" || result === "QUEUED") reviewed.set(owner, local.day);
    return result;
  }

  async function tickOwner(owner: string, settings: NousSettings): Promise<StandingTickResult> {
    const at = now();
    const conserving = await deps.lowToken?.(owner) ?? false;
    const snapshot = await deps.collect(owner);
    const orders = settings.standingOrders;
    const panes = boardPanes(snapshot, { showClosed: false });
    const since = (paneId: string) => { for (const { sample } of snapshot.rooms) { const detail = sample?.details[paneId]; if (detail) return detail.since ?? null; } return null; };
    const ctx: CloseoutContext = { since, tasks: snapshot.tasks, executions: snapshot.executions, summaries: snapshot.summaries, now: at, finishedAfterMs: orders.finishedAfterMinutes * MINUTE, closeOperatorPanes: orders.closeOperatorPanes,
      ...(snapshot.browsers !== undefined ? { browsers: snapshot.browsers } : {}), ...(snapshot.usedAt ? { usedAt: snapshot.usedAt } : {}) };
    // A listed pane's browser with many tabs: the finished ones close (browser hygiene); a pane without a CLI closes them with itself.
    const tabs = (input: BoardPaneInput) => {
      const count = snapshot.browsers?.get(input.pane.id)?.tabs ?? 0;
      return count > NOUS_TABS_SHOWN_ABOVE ? ` · browser: ${count} tabs${savesToMemory(input.pane) ? " (kept open: have it close the finished ones, browser hygiene)" : " (they close with it)"}` : "";
    };
    const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
    const save = async (row: NousPaneCloseout) => { rows.set(row.paneId, row); await deps.closeouts.save(owner, row); };
    const stamp = new Date(at).toISOString();

    // Rows in flight: a pane that is gone was closed elsewhere; a save asked long enough ago is verified from the pane's reports.
    for (const row of [...rows.values()]) {
      if (row.state === "CLOSED") continue;
      const input = panes.find((entry) => entry.pane.id === row.paneId);
      if (!input) {
        // A room whose activity could not be read hides its panes for this tick only: they are not closed.
        if (snapshot.rooms.some(({ room, sample }) => room.id === row.roomId && !sample)) continue;
        await save({ ...row, state: "CLOSED", closedAt: stamp, reason: "closed elsewhere", updatedAt: stamp }); continue;
      }
      if (input.state === "working" || input.state === "waiting" || row.state === "VERIFIED") continue;
      const askedAt = row.retriedAt ?? row.requestedAt;
      if (at - Date.parse(askedAt) < SETTLE_MS) continue;
      const reports = await deps.reportsSince(owner, row.paneId, askedAt).catch(() => []);
      const answer = deps.lastAnswer && reports.some((report) => report.at >= askedAt) ? await deps.lastAnswer(input.pane).catch(() => null) : null;
      const id = verifyMemorySave(reports, askedAt, answer);
      if (id) await save({ ...row, state: "VERIFIED", verifiedMemoryId: id, reason: null, updatedAt: stamp });
    }

    const lines: string[] = [];
    const kept: string[] = [];
    const cardLines: string[] = [];
    const list = (input: BoardPaneInput, key: string, text: string, into = lines) => {
      const entry = listed.get(`${owner}\u0000${input.pane.id}`);
      if (entry && entry.key === key && at - entry.at < RELIST_MS) return;
      listed.set(`${owner}\u0000${input.pane.id}`, { key, at });
      into.push(text);
    };
    for (const input of panes) {
      if (closeoutSkipReason(input, ctx) !== "card-check") continue;
      const cards = input.notifications.map((card) => `"${card.title}" [${card.id}] since ${dayHhmm(card.updatedAt)}`).join(", ");
      list(input, `card:${input.notifications.map((card) => `${card.id}:${card.updatedAt}`).join(",")}`, `- ${where(input)} · ${input.state} ${durationText(at - Date.parse(closeoutSince(input, ctx)!))} · your card ${cards} still open`
        + " → read the pane (space_pane_reports); nothing left for the operator: resolve it (space_resolve_notification); still theirs: space_pane_checked WAITING_OPERATOR with nextCheckInMinutes", cardLines);
    }
    if (orders.closeFinishedPanes) {
      for (const input of panes) {
        const skip = closeoutSkipReason(input, ctx);
        if (skip === "card-check") continue;
        const task = keptOpenForTask(input.pane.id, snapshot.tasks);
        if (skip === "task") { kept.push(`- ${where(input)} · ${input.state} · its task "${task?.title ?? ""}" runs within the hour: kept open (no action)`); continue; }
        const row = rows.get(input.pane.id);
        const paneSince = closeoutSince(input, ctx);
        const inFlight = row && row.state !== "CLOSED";
        if (skip && skip !== "fresh" && skip !== "board-check") continue;
        const idle = `${input.state} ${durationText(at - Date.parse(paneSince!))}${tabs(input)}`;
        if (inFlight) {
          if (row.state === "VERIFIED") list(input, `verified:${row.verifiedMemoryId}`, `- ${where(input)} · ${idle} · save asked ${hhmm(row.requestedAt)}, verified ${row.verifiedMemoryId} → close it now (space_close_pane)`);
          else {
            const askedAt = row.retriedAt ?? row.requestedAt;
            const waited = at - Date.parse(askedAt);
            if (waited >= NOUS_SAVE_WAIT_MS) list(input, `decide:${askedAt}`, `- ${where(input)} · ${idle} · save asked ${hhmm(askedAt)}, not verified after ${Math.round(waited / MINUTE)} min → read its reports (space_pane_reports); `
              + `${row.state === "SAVE_REQUESTED" ? `ask once more with exactly "${NOUS_SAVE_RETRY_TEXT}"` : "if the save is there, close it (space_close_pane)"}, or record KEEP_OPEN with the reason and the next check`);
          }
        } else if (skip === "board-check" && (!row || !row.closedAt || row.closedAt < paneSince!)) {
          const board = latestSummary(input.pane.id, snapshot.summaries)!;
          list(input, `board:${board.waitsOn}`, `- ${where(input)} · ${idle} · the board says it waits on ${board.waitsOn.toLowerCase().replace("_", " ")} ("${(board.detail ?? board.line).slice(0, 140)}"), nothing is open for the operator`
            + ` → read it (space_pane_reports); its task done: ${savesToMemory(input.pane) ? `send it exactly "${NOUS_SAVE_TEXT}" (space_send_to_pane, when now)` : "close it (space_close_pane, nothing to save)"}; still waiting: space_pane_checked WAITING_OPERATOR or WAITING_DATE with nextCheckInMinutes (space_notify_operator when it needs their hands)`);
        } else if (!skip && !savesToMemory(input.pane)) {
          // Nothing to save (operator 27/10: browsers, plain shells and every other pane type close once nobody uses them).
          list(input, "close", `- ${where(input)} · ${closeKind(input.pane)} · unused ${durationText(at - Date.parse(paneSince!))}${tabs(input)}${task ? ` · task "${task.title}": Space reopens the pane when it runs` : ""}`
            + ` · no CLI, nothing to save → close it (space_close_pane)${lookFirst(input.pane)}; still in use: space_pane_checked KEEP_OPEN with the reason and nextCheckInMinutes`);
        } else if (!skip && (!row || !row.closedAt || row.closedAt < paneSince!)) {
          list(input, "ask", `- ${where(input)} · ${idle}${input.pane.mode === "TERMINAL" ? "" : ` · ${input.pane.mode} pane: close it only when its copilot has nothing scheduled`}`
            + `${task ? ` · task "${task.title}": Space reopens the pane when it runs` : ""} · save not asked yet → send it exactly "${NOUS_SAVE_TEXT}" (space_send_to_pane, when now)`);
        }
      }
    }

    // Stalled plans: one nudge per plan per stalled window; CAPPED, PAUSED or OFF leave the mark, so the next tick tries again.
    const map = deps.planMap ? await deps.planMap(owner, snapshot.plans).catch((error) => { warn({ err: error, owner }, "Nous plan map failed."); return null; }) : null;
    const activity = conserving ? [] : await nousPlanActivity({ owner, plans: snapshot.plans, samples: snapshot.rooms, marks: deps.marks, reports: snapshot.reports, executions: snapshot.executions,
      ...(map ? { held: (planId: string) => stalledHold(map, planId) } : {}), stalledHours: orders.stalledAfterHours, now: new Date(at) })
      .catch((error) => { warn({ err: error, owner }, "Nous plan activity failed."); return []; });
    const due = activity.filter((item) => item.stalled && (!item.lastNudgedAt || at - Date.parse(item.lastNudgedAt) >= orders.stalledAfterHours * 3_600_000));

    let turn: StandingResult | null = null;
    // The daily self-review (operator decision 2026-10-24): once per local day at or after the chosen hour, as a turn of its own.
    if (orders.dailyReview && deps.review) {
      const review = await dailyReviewTurn(owner, orders.dailyReviewHour, at).catch((error) => { warn({ err: error, owner }, "Nous daily review failed."); return null; });
      if (review && review !== "STARTED" && review !== "QUEUED") warn({ owner, review }, "Nous daily review left to the next tick.");
    }
    if (lines.length || cardLines.length || due.length) {
      const text = ["# Standing orders (from Space, not the operator; they repeat every tick until each line is handled)",
        lines.length ? ["## Finished panes (operator rule: a pane with an AI CLI saves to memory, then closes; every other pane closes at once; keep one open only with KEEP_OPEN and a reason)", ...lines, ...kept].join("\n") : "",
        cardLines.length ? ["## Your cards on finished panes (a card the operator no longer needs keeps their room \"Needs attention\")", ...cardLines].join("\n") : "",
        renderStandingPlansPrompt(due)].filter(Boolean).join("\n\n");
      turn = await deps.standing(owner, "STANDING", text);
      if ((turn === "STARTED" || turn === "QUEUED") && due.length) await deps.marks.nudged(owner, due.map((item) => item.planId), new Date(at)).catch((error) => warn({ err: error, owner }, "Nous plan nudge mark failed."));
      // A turn that did not start (capped, paused, off) must not count as a listing.
      if (turn !== "STARTED" && turn !== "QUEUED") for (const input of panes) { const entry = listed.get(`${owner}\u0000${input.pane.id}`); if (entry?.at === at) listed.delete(`${owner}\u0000${input.pane.id}`); }
    }

    // Kept cadences: the pane round's line every 30 minutes while panes are due; the Away round every 30 minutes with nothing due.
    if (deps.paneRound && deps.notice && at - (lastRound.get(owner) ?? 0) >= RELIST_MS) {
      lastRound.set(owner, at);
      const line = await deps.paneRound(owner, snapshot.rooms).catch(() => null);
      if (line) await deps.notice(owner, "pane-round", line);
    }
    if (deps.away && at - (lastAway.get(owner) ?? 0) >= RELIST_MS && await deps.away(owner).catch(() => false)) {
      lastAway.set(owner, at);
      const load = deps.serverLine ? await deps.serverLine().catch(() => null) : null;
      await deps.standing(owner, "HEARTBEAT", `Away round: ${snapshot.plans.length} open plan${snapshot.plans.length === 1 ? "" : "s"}; ${conserving ? "low-spend mode: handle urgent work and finished-pane save/close only; leave stalled-plan nudges until NORMAL" : "look over the plans and the panes, move on what stalled"}.${load ? ` ${load}` : ""}`);
    }
    return { paneLines: lines.length + cardLines.length, stalledPlans: due.length, turn };
  }

  return {
    /** Every minute from the wiring: each owner runs when its tick interval passed; an overlapping run is skipped. */
    async tick(): Promise<void> {
      for (const owner of await deps.owners()) {
        const settings = await deps.settings(owner).catch(() => null);
        if (!settings?.enabled || running.has(owner)) continue;
        const interval = settings.standingOrders.tickMinutes * MINUTE;
        if (now() - (lastTick.get(owner) ?? 0) < interval - 5_000) continue;
        lastTick.set(owner, now());
        running.add(owner);
        try { await tickOwner(owner, settings); }
        catch (error) { warn({ err: error, owner }, "Nous standing orders tick failed."); }
        finally { running.delete(owner); }
      }
    },
    /** One owner now (tests, and the API's startup tick). */
    async tickOwner(owner: string): Promise<StandingTickResult> {
      const settings = await deps.settings(owner);
      if (!settings.enabled) return { paneLines: 0, stalledPlans: 0, turn: "OFF" };
      lastTick.set(owner, now());
      return tickOwner(owner, settings);
    },
    /** From Nous's tool calls (tools.ts): "save to memory" sent to panes, and panes closed. */
    async saveRequested(owner: string, roomId: string, paneIds: string[]): Promise<void> {
      const stamp = new Date(now()).toISOString();
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      for (const paneId of paneIds) {
        const row = rows.get(paneId);
        const next: NousPaneCloseout = row && row.state === "SAVE_REQUESTED"
          ? { ...row, state: "SAVE_RETRIED", retriedAt: stamp, updatedAt: stamp }
          : { paneId, roomId, state: "SAVE_REQUESTED", requestedAt: stamp, retriedAt: null, verifiedMemoryId: null, closedAt: null, reason: null, updatedAt: stamp };
        await deps.closeouts.save(owner, next);
        listed.delete(`${owner}\u0000${paneId}`);
      }
    },
    async closed(owner: string, paneIds: string[]): Promise<void> {
      const stamp = new Date(now()).toISOString();
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      for (const paneId of paneIds) {
        const row = rows.get(paneId);
        if (row && row.state !== "CLOSED") await deps.closeouts.save(owner, { ...row, state: "CLOSED", closedAt: stamp, reason: row.verifiedMemoryId ? "closed by Nous after its memory save" : "closed by Nous", updatedAt: stamp });
        listed.delete(`${owner}\u0000${paneId}`);
      }
    }
  };
}
export type NousStandingOrders = ReturnType<typeof createStandingOrders>;
