import { cliToggleRuntimeIds, planIsParked, type ClipboardItem, type ManagedPlanExecution, type NousDecision, type NousSettings, type NousTurnFacts, type Pane, type RoomAgentEvent, type SpaceNotification, type TaskItem } from "@space/contracts";
import type { NousLedgerRow, NousPaneCloseout, RailDecisionCount, NousPaneCloseoutsRepository, NousPaneSummaryRow, NousPlanMarksRepository, PaneReport } from "@space/db";
import { isCliPane } from "../pane-guards.js";
import { lastPromptAt, operatorPromptedLast } from "../queue-operator-grants.js";
import { durationText, paneLabel } from "./digest.js";
import { parkedSince } from "./parked-plans.js";
import { boardPanes, type BoardPaneInput, type PaneBoardSnapshot } from "./pane-board.js";
import { NOUS_PANE_NOTICE_PREFIX } from "./pane-notices.js";
import { nousPlanActivity, openPlanStep, renderStandingPlansPrompt } from "./stalled-plans.js";
import { HARD_HOLDS, stalledHold, type PlanMap } from "./plan-map.js";

/**
 * Standing orders (operator orders 2026-10-21): Space itself, every `tickMinutes`, 24/7 and whatever the inbox does, finds
 * (a) the finished CLI panes (reported done at once, idle for `finishedAfterMinutes`, nothing waiting on them) and (b) the stalled plans, and
 * brings them to Nous in a STANDING turn of their own until each one is handled. Nous does the judgment and the actions per
 * pane with its tools: it sends "save to memory" (space_send_to_pane), Space verifies the save from the pane's reports, Nous
 * closes the pane (space_close_pane) or keeps it open (space_pane_checked KEEP_OPEN). The close-out's state per pane lives in
 * nous_pane_closeouts, written from Nous's own tool calls (tools.ts), so a restart loses nothing and nothing is asked twice.
 * Until 2026-10-20 the rule lived only in Space Memory and in a follow-up Nous re-armed hourly, and that chain broke.
 */
import { awaitsOperator, NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT } from "./save-request.js";
import { TASK_SOON_MS } from "./tools.js";
import type { NousTurnItem } from "./turn-items.js";
import { quote } from "./requests-waiting.js";
import { localDayHour, NOUS_REVIEW_WINDOW_MS, renderDailyReview, type NousDeferral } from "./daily-review.js";
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
/** Operator 5/11 20:44 BKK (nous_msg:ffec6f53f5674ba2a86a507b): Standing orders run on a change; a line that did not change comes back at most 3 times a day. */
const UNCHANGED_MS = 8 * 60 * MINUTE;
/** C (plan clipboard:ZWJJdBgHm64Z): the requests sweep's cadence and the operator's day it runs in (local hours, end exclusive). */
const SWEEP_MS = 30 * MINUTE;
const SWEEP_HOURS = { from: 9, to: 23 } as const;
/** The push (operator 3/11 23:11 BKK): runnable work comes to Nous every 10 minutes while capacity is free; a request joins once its pane rested 30 minutes. */
const PUSH_MS = 10 * MINUTE;
const PUSH_REQUEST_IDLE_MS = 30 * MINUTE;
/** The pool a pane's CLI draws on, as the Provider advice names it (tokens.ts POOLS); null: a CLI outside Space Gateway's pools. */
const RUNTIME_POOL: Record<string, string> = { "cli:claude": "claude", "cli:codex": "codex", "cli:gemini": "gemini" };

/** An open operator request for the sweep: its words, plan, pane (and its state), newest report and the evidence it is finished. */
export interface SweepRequest {
  key: string; messageId: string | null; words: string; plan?: string; pane?: string; paneName?: string;
  paneState?: string | null; paneSince?: string | null; report?: string | null; evidence?: string | null; openedAt: string;
}
const KEEP_VERDICTS = new Set(["KEEP_OPEN", "WAITING_OPERATOR", "WAITING_DATE", "BLOCKED"]);
const BOARD_WAITS = new Set(["OPERATOR", "DATE", "PROMOTE", "THIRD_PARTY"]);
const OPEN_PLAN = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** R10-19: the daily review's turns that may fail in one local day before it waits for the next (the first ask and 2 retries). */
export const NOUS_REVIEW_MAX_FAILED = 3;

export type CloseoutSkip = "always-on" | "browser-held" | "busy" | "unknown" | "fresh" | "operator-test" | "keep-open" | "waiting-operator" | "card-check" | "task" | "managed" | "plan-open" | "board-waits" | "board-check" | "awaits-operator" | "scheduled" | "prompted";
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
  /** Marketing Copilot panes that own an approved post still scheduled; null when the read failed (then no Marketing Copilot pane is listed). */
  scheduled?: ReadonlySet<string> | null;
  tasks: TaskItem[];
  executions: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>;
  summaries: NousPaneSummaryRow[];
  now: number;
  finishedAfterMs: number;
  /** Settings standingOrders.closeOperatorPanes: false keeps OPERATOR_TEST panes open. */
  closeOperatorPanes?: boolean;
  /** The owner's open plans, for a linked plan's dependencies (R10-3). */
  plans?: ClipboardItem[];
  /** Whether the operator in person sent the pane its newest prompt (queue-operator-grants `operatorPromptedLast`). */
  operatorPromptedLast?(paneId: string): boolean;
  /** When the pane last got a prompt from anyone, its own memory-save request excepted (queue-operator-grants `lastPromptAt`). */
  promptedAt?(paneId: string): number;
  /** Panes a prompt is still to reach (Nous's held queue, Space Control's schedules); null when the read failed (then no pane closes). */
  prompts?: ReadonlySet<string> | null;
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

/**
 * Operator 28/10 14:59 BKK («δεν θελω να ισχυει το οριο των 30 λεπτων θελω αμεσα»): a CLI pane whose newest report is its own done
 * or failed, or Space's turn-end report, is finished at once when it sits idle at its prompt; only a pane idle with no such report
 * waits `finishedAfterMinutes`.
 */
export function reportedFinished(input: Pick<BoardPaneInput, "pane" | "report">): boolean {
  const report = input.report;
  return savesToMemory(input.pane) && Boolean(report) && (report!.status === "DONE" || report!.status === "FAILED" || (report!.status === "TURN_END" && report!.source === "AUTO"));
}

const PLAN_WAITS = new Set(["DATE", "PROMOTE", "THIRD_PARTY"]);
const waitText = (kind: string, what: string) => `${kind.toLowerCase().replace("_", " ")}: ${what.replace(/\s+/g, " ")}`;
/**
 * R10-3 (operator rule 264b98c3, 28/10 10:43 BKK «panes that do not run and will not run right now are closed; reopened when their
 * work continues»): what a pane's open linked plan waits on that nobody can move now (its own date, promote or third-party wait, a plan
 * it depends on, or the pane's board wait of those kinds), null when it waits on nothing of the kind.
 */
export function planWaitsFor(input: Pick<BoardPaneInput, "pane" | "plan">, ctx: Pick<CloseoutContext, "summaries" | "now" | "plans">): string | null {
  const plan = input.plan;
  if (!plan) return null;
  const own = plan.waitsOn && !(plan.waitsOn.kind === "DATE" && plan.waitsOn.until && Date.parse(plan.waitsOn.until) <= ctx.now) ? plan.waitsOn : null;
  if (own) return PLAN_WAITS.has(own.kind) ? waitText(own.kind, own.what) : null;
  // Only open plans are listed: a dependency missing from them is finished.
  const dependency = (plan.dependsOn ?? []).map((id) => ctx.plans?.find((other) => other.id === id)).find((other) => other && other.progressPercentage < 100);
  if (dependency) return `plan "${(dependency.title ?? dependency.text).replace(/\s+/g, " ").slice(0, 80)}" (${dependency.id})`;
  const board = latestSummary(input.pane.id, ctx.summaries);
  return board && PLAN_WAITS.has(board.waitsOn) ? waitText(board.waitsOn, board.detail ?? board.line) : null;
}

/** Why a pane is not a finished pane to close, null when it is one. */
export function closeoutSkipReason(input: BoardPaneInput, ctx: CloseoutContext): CloseoutSkip | null {
  const { pane, state, check } = input;
  // The Mail Copilot works the mail as it arrives and sorts the inbox daily: it is never a finished pane (operator 2026-10-27).
  if (pane.mode === "MAIL_COPILOT") return "always-on";
  // A Marketing Copilot pane closes only once its copilot has nothing scheduled (operator rule 9/11; the close itself refuses too).
  if (pane.mode === "MARKETING_COPILOT" && (ctx.scheduled === null || ctx.scheduled?.has(pane.id))) return "scheduled";
  // Every pane type closes once finished (operator 27/10 «όλα του τύπου Panes»; copilot, Design, App Studio and Video panes since
  // 2026-10-24), but a browser someone holds is in use: a control lease, a handoff, a Vault fence.
  if (ctx.browsers?.get(pane.id)?.held) return "browser-held";
  if (ctx.browsers === null && !savesToMemory(pane)) return "unknown";
  if (state !== "done" && state !== "idle") return "busy";
  if (savesToMemory(pane) && awaitsOperator(input.report, ctx.operatorPromptedLast?.(pane.id) ?? false)) return "awaits-operator";
  const since = closeoutSince(input, ctx);
  if (!since) return "unknown";
  // 13/11 Eva/Andy: closed 18 s after Nous typed its plan step, the dashboard still read done. A prompt since it finished, or one to come, is work.
  if (ctx.prompts === null || ctx.prompts?.has(pane.id) || (ctx.promptedAt?.(pane.id) ?? -Infinity) > Date.parse(since)) return "prompted";
  if (check?.verdict === "OPERATOR_TEST" && ctx.closeOperatorPanes === false) return "operator-test";
  if (check?.verdict && KEEP_VERDICTS.has(check.verdict) && check.nextCheckAt && Date.parse(check.nextCheckAt) > ctx.now) return "keep-open";
  if (input.decisions.length || input.copilotItems.length || input.notifications.some((item) => !isNousCard(item))) return "waiting-operator";
  // Only Nous's own card waits, on a pane finished since: Nous re-checks it (stable 2026-10-22: cards of 10-17..10-19 kept panes and rooms "Needs attention").
  const wait = reportedFinished(input) ? 0 : ctx.finishedAfterMs;
  if (input.notifications.length) {
    const old = (iso: string) => ctx.now - Date.parse(iso) >= wait;
    return old(since) && input.notifications.every((card) => old(card.updatedAt)) ? "card-check" : "waiting-operator";
  }
  const task = keptOpenForTask(pane.id, ctx.tasks);
  if (task && Date.parse(task.schedule?.nextRunAt ?? "") - ctx.now < TASK_SOON_MS) return "task";
  if (ctx.executions.some((execution) => execution.paneId === pane.id)) return "managed";
  const plan = input.plan;
  // A plan that waits on a date, a promote, a third party or another plan does not keep its pane: it closes and reopens with the work (R10-3).
  const planOpen = plan && plan.progressPercentage < 100 && !OPEN_PLAN.has(plan.executionStatus) && plan.steps.some((step) => step.status !== "COMPLETED");
  const planWait = planOpen ? planWaitsFor(input, ctx) : null;
  // 13/11 (Load 66 %, 7 of 17 done CLI panes kept open by plans whose open steps were all BLOCKED): only a step that can run, or the
  // operator's own answer, keeps the pane; the rest save and close and reopen with the work.
  if (planOpen && !planWait && (openPlanStep(plan) || plan.waitsOn?.kind === "OPERATOR")) return "plan-open";
  const summary = latestSummary(pane.id, ctx.summaries);
  const fresh = ctx.now - Date.parse(since) < wait;
  // The board's wait is a model's reading of the last answer: once the pane is finished long enough Nous re-checks it (stable 2026-10-24: panes "waiting" 3 days, nothing open for the operator).
  if ((!planWait || summary?.waitsOn === "OPERATOR") && summary && BOARD_WAITS.has(summary.waitsOn) && summary.generatedAt >= since) return fresh ? "board-waits" : "board-check";
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

export type StandingResult = "STARTED" | "QUEUED" | "OFF" | "PAUSED";

export interface StandingOrdersDeps {
  closeouts: NousPaneCloseoutsRepository;
  marks: NousPlanMarksRepository;
  settings(owner: string): Promise<NousSettings>;
  lowToken?(owner: string): Promise<boolean>;
  /**
   * B (plan clipboard:ZWJJdBgHm64Z): the spend mode and the pools the Provider advice says to avoid. In LOW a stalled plan is still
   * nudged unless its pane runs on an avoided pool; CRITICAL skips the nudges. Without it `lowToken` decides as before.
   */
  spend?(owner: string): Promise<{ mode: "NORMAL" | "LOW" | "CRITICAL"; avoid: string[] }>;
  /** C and D (plan clipboard:ZWJJdBgHm64Z): the open requests for the sweep, the operator's zone, and the In progress count to keep. */
  requests?: {
    zone(owner: string): Promise<string>;
    open(owner: string): Promise<SweepRequest[]>;
    /** Keeps the Requests tab's In progress count at the operator's 09:00 or 21:00 (once per day and slot, durable). */
    progress(owner: string, day: string, slot: "09:00" | "21:00"): Promise<void>;
  };
  owners(): Promise<string[]>;
  collect(owner: string): Promise<PaneBoardSnapshot & { tasks: TaskItem[]; executions: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>; summaries: NousPaneSummaryRow[];
    /** Live pane browsers and other recorded use (YouTube playback), by pane id. */
    browsers?: ReadonlyMap<string, CloseoutBrowser> | null; usedAt?: ReadonlyMap<string, string>; scheduled?: ReadonlySet<string> | null;
    /** Panes a prompt is still to reach (held or scheduled); null when the read failed. */
    prompts?: ReadonlySet<string> | null }>;
  /** One pane's reports since a time (newest first is fine). */
  reportsSince(owner: string, paneId: string, since: string): Promise<PaneReport[]>;
  /** The plan map (plan-map.ts): a plan held on a date, another plan or the server is never nudged; the tick also fires its hold alerts. */
  planMap?(owner: string, plans: ClipboardItem[]): Promise<PlanMap>;
  /** The plans parked now, open and closed (operator 13/11 nous_msg:4080b166): their NOUS and AGENT conditions are Nous's to do. */
  parked?(owner: string): Promise<ClipboardItem[]>;
  lastAnswer?(pane: Pane): Promise<string | null>;
  /**
   * Plan clipboard:qH5emwVaV6yO step 10: closes a finished pane whose memory save Space verified (space_close_pane's close and needs-you
   * guard); true when it closed. Without it Nous gets the "close it now" line, one Opus STANDING turn per pane.
   */
  closePane?(owner: string, roomId: string, paneId: string): Promise<boolean>;
  /** Starts the STANDING turn (or the Away HEARTBEAT round, or the daily REVIEW) with this text (service.standing). */
  standing(owner: string, reason: "STANDING" | "HEARTBEAT" | "REVIEW", text: string, options?: { meta?: Record<string, unknown>; items?: NousTurnItem[] }): Promise<StandingResult>;
  /** R13-9: what waits for the operator (open decisions, needs-you cards, held copilot questions past their hour), their clock, the last list posted. */
  pendings?: {
    /** `facts`: Space's account facts about the item (R21-asklast-pendings): sign-ins, Vault logins, what an agent does itself. */
    waiting(owner: string): Promise<Array<{ id: string; title: string; since: string; where: string | null; facts?: string[] }>>;
    clock(owner: string): Promise<{ zone: string; quiet: boolean }>;
    lastAt(owner: string): Promise<string | null>;
  };
  /** The daily self-review's sources (operator decision 2026-10-24): the owner's turn facts and decisions, and their working time zone. */
  review?: {
    facts(owner: string, since: string): Promise<NousTurnFacts[]>;
    decisions(owner: string): Promise<NousDecision[]>;
    /** Nous's NOUS notifications (cards and focus requests), for the review's questions to the operator. */
    cards?(owner: string): Promise<SpaceNotification[]>;
    /** R20-asks-1: the owner's browser handoff notices. */
    handoffs?(owner: string): Promise<SpaceNotification[]>;
    /** 2/11 rule 6: the owner's notifications since then (every source). */
    needsYou?(owner: string, since: string): Promise<SpaceNotification[]>;
    /** Plan clipboard:7L5KyWp3kQsP step 5: the copilots' and the agents' cards (held copilot questions, needs-you without "Checked first"). */
    asks?(owner: string): Promise<SpaceNotification[]>;
    /** R65 (goal ee5a573e β): the window's cards held because Space had the answer, and the lessons of that kind. */
    cardHolds?(owner: string, since: string): Promise<{ rule: number; memory: number; lessons: string[] }>;
    /** The operator's answers in every copilot rail (goal 7365014c-b); absent where Space has no database. */
    rails?(owner: string, since: string): Promise<RailDecisionCount[]>;
    /** Goal 7365014c-e: the decision ledger's rows since then. */
    ledger?(owner: string, since: string): Promise<NousLedgerRow[]>;
    /** Queue item 21: the room monitor's events of the owner's rooms (the unblocking sample). */
    waits?(owner: string, since: string): Promise<RoomAgentEvent[]>;
    timeZone(owner: string): Promise<string>;
    /** R11-2 (5): the failed space_db_query tool rows since then (their PostgreSQL code and guessed name). */
    dbFailures?(owner: string, since: string): Promise<Array<{ dbCode: string; dbGuess?: string | null }>>;
    /** R17-6: the day's failed space_mail_read calls' mailCode. */
    mailFailures?(owner: string, since: string): Promise<string[]>;
    /** Sentry plan step 8: the review's Sentry lines (new issues per release deployed since then). */
    sentry?(since: string): Promise<string[]>;
    /** R11-7: whether the turn wrote its findings: a space_files_write to nous/upgrades/queue.md or a space_note that went through. */
    turnWrote?(owner: string, turnId: string): Promise<boolean>;
    /** R10-19: a REVIEW turn of the owner runs or waits in the queue now (the service's own retry included). */
    busy?(owner: string): boolean;
    /** Load (plan clipboard:f4SH36t3fJ6c): the reviewed day's average utilization against the day before. */
    load?(owner: string): Promise<string | null>;
    /** Plan clipboard:ctqx7SPqkWR2 step 6: the token table (Nous per turn kind and goal, the most expensive panes, 5-hour peaks). */
    tokens?(owner: string, since: string): Promise<string | null>;
    /** D (plan clipboard:ZWJJdBgHm64Z): the In progress counts kept at 09:00 and 21:00, and the open requests with no act for 6 hours. */
    requests?(owner: string, since: string): Promise<NonNullable<Parameters<typeof renderDailyReview>[0]["requests"]>>;
    /** R22-5: the DATE waits and time follow-ups Nous set since then (its tool rows' meta.deferral). */
    deferrals?(owner: string, since: string): Promise<NousDeferral[]>;
  };
  /** The pane round's inbox line when panes are due (pane-watch.ts), every 30 minutes. */
  paneRound?(owner: string, rooms: PaneBoardSnapshot["rooms"]): Promise<string | null>;
  /** `soon`: the line starts its turn within seconds, not after the inbox debounce (a pane that just finished). */
  notice?(owner: string, key: string, line: string, items?: NousTurnItem[], soon?: boolean): Promise<void>;
  /** The operator is away (away.ts): the round runs every 30 minutes even with nothing due. */
  away?(owner: string): Promise<boolean>;
  serverLine?(): Promise<string | null>;
  /** Load (plan clipboard:f4SH36t3fJ6c): the inbox line when capacity stayed idle 10 minutes while `plans` open plans (or requests) wait; null otherwise. */
  utilizationLow?(owner: string, plans: number, freed?: boolean): Promise<string | null>;
  /** Sends a text to a pane as Space through Nous's space_send_to_pane and its guards; true when it went. */
  dispatch?(owner: string, roomId: string, paneId: string, text: string): Promise<boolean>;
  /** R35-1 (stuck-panes.ts): the owner's CLI panes frozen on a spinner, or never taking a queued text, for 30 minutes. */
  stuck?(owner: string): Promise<Array<{ paneId: string; label: string; line: string }>>;
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
/** Item 7 A: the inbox key of a finished pane's line (`finished:<paneId>`); its line joins the INBOX batch that carries its FINISHED notice. */
export const NOUS_FINISHED_KEY = "finished:";
const where = (input: BoardPaneInput) => `${input.room.name}/${paneLabel(input.pane)}`;

export function createStandingOrders(deps: StandingOrdersDeps) {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();
  const lastTick = new Map<string, number>();
  const lastRound = new Map<string, number>();
  /** R13-9: the pendings slot ("YYYY-MM-DD HH:MM" local) each owner's list was last handled for. */
  const pendingsSlot = new Map<string, string>();
  /**
   * R13-9 (goal ab5f85bd, Nous 29/10 13:15 BKK: the 3-hour pendings list was a chain of follow-ups a lost turn broke): at each of the
   * operator's pendings times, in their day (never in quiet hours), a STANDING turn of its own lists what waits for them, so Nous writes
   * ONE list; nothing waiting, or a list posted under 3 hours ago, brings none.
   */
  async function pendingsTurn(owner: string, hours: string[], at: number, map: PlanMap | null): Promise<void> {
    const { zone, quiet } = await deps.pendings!.clock(owner);
    if (quiet) return;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(at)).map((part) => [part.type, part.value]));
    const now = `${parts.hour}:${parts.minute}`;
    const slot = [...hours].sort().filter((hour) => hour <= now).pop();
    if (!slot) return;
    const key = `${parts.year}-${parts.month}-${parts.day} ${slot}`;
    if (pendingsSlot.get(owner) === key) return;
    pendingsSlot.set(owner, key);
    const last = await deps.pendings!.lastAt(owner);
    if (last && at - Date.parse(last) < 3 * 3_600_000) return;
    const plans = map ? map.ordered.filter((plan) => plan.hold?.kind === "OPERATOR").map((plan) => ({ id: plan.id, title: `plan "${plan.title}": ${plan.hold!.what}`, since: null, where: null })) : [];
    const items: Array<{ id: string; title: string; since: string | null; where: string | null; facts?: string[] }> = [...await deps.pendings!.waiting(owner), ...plans];
    if (!items.length) return;
    const age = (since: string | null) => since ? ` · ${durationText(Math.max(0, at - Date.parse(since)))}` : "";
    const text = ["# Pendings list (from Space at the operator's " + slot + "; operator goal ab5f85bd)",
      "Write the operator ONE list, in their language, of everything below that still waits for them: each item with what they must do and where. Read an item first "
        + "(space_world, space_pane_reports) and leave out what no longer waits; answer NOTHING_NEW when nothing is left. Under an item are Space's account facts: "
        + "what they say an agent does (a Vault login, a Vault unlock) is not the operator's: have it done, never list it. They are for you: never copy "
        + "an account fact (sign-ins, Google accounts, Vault logins, addresses) into the list.",
      ...items.flatMap((item) => [`- [${item.id}] ${item.title}${item.where ? ` · ${item.where}` : ""}${age(item.since)}`, ...(item.facts ?? []).map((fact) => `  · ${fact}`)])].join("\n");
    const turn = await deps.standing(owner, "STANDING", text, { meta: { pendingsList: key } });
    if (turn !== "STARTED" && turn !== "QUEUED") pendingsSlot.delete(owner);
  }
  const lastAway = new Map<string, number>();
  const lastUtilization = new Map<string, number>();
  // shortcut: in memory, so after an API restart a pane that ended with the same step open gets it once more; a plan mark if repeats show.
  const dispatched = new Map<string, string>();
  /** C: when each owner's requests sweep last went out; D: the "day slot" whose In progress count was kept. */
  const lastSweep = new Map<string, number>();
  const sweptState = new Map<string, { state: string; at: number }>();
  const lastStuck = new Map<string, number>();
  const lastParked = new Map<string, number>();
  const progressKept = new Map<string, string>();
  /** What each pane was last listed as, and when, so an unhandled line repeats only every 8 hours unless it changed. */
  const listed = new Map<string, { key: string; at: number }>();
  /** The local day a review turn was asked for (started or queued), so a running review is not asked again by the next tick. */
  const reviewed = new Map<string, string>();
  /** R10-19: when the review was last asked, and the local day the review is settled (a turn that did not fail, or the retries spent). */
  const askedAt = new Map<string, number>();
  const settled = new Map<string, string>();
  const warn = (details: Record<string, unknown>, message: string) => deps.log?.warn(details, message);

  /** Starts today's review turn when it is due and none ran today (the facts rows say, so a restart asks nothing twice). */
  async function dailyReviewTurn(owner: string, hour: number, at: number): Promise<StandingResult | null> {
    const zone = await deps.review!.timeZone(owner).catch(() => "UTC");
    const local = localDayHour(at, zone);
    if (local.hour < hour || settled.get(owner) === local.day) return null;
    const since = new Date(at - NOUS_REVIEW_WINDOW_MS).toISOString();
    const facts = await deps.review!.facts(owner, since);
    // R10-19 (29/10 local day: the REVIEW failed at 22:38 UTC during the Space Gateway outage and nothing asked again): a REVIEW that
    // ended FAILED or STOPPED is no review; the next tick asks again, at most until 3 such rows that day. A review that ran is the day's.
    const today = facts.filter((turn) => turn.reason === "REVIEW" && localDayHour(Date.parse(turn.startedAt), zone).day === local.day);
    // R11-7 (Nous 29/10): a TIMEOUT counts as the day's review only when it wrote its findings (queue.md or a note); else it is retried once
    // like a failed one, under the same 3-a-day cap.
    const wrote = async (turn: NousTurnFacts) => deps.review!.turnWrote ? await deps.review!.turnWrote(owner, turn.turnId).catch(() => true)
      : ["space_note", "space_files_write"].some((name) => (turn.tools[name]?.calls ?? 0) > (turn.tools[name]?.failed ?? 0));
    const bareTimeouts: NousTurnFacts[] = [];
    for (const turn of today.filter((entry) => entry.status === "TIMEOUT")) if (!(await wrote(turn))) bareTimeouts.push(turn);
    const failed = [...today.filter((turn) => turn.status === "FAILED" || turn.status === "STOPPED"), ...bareTimeouts].sort((a, b) => a.endedAt.localeCompare(b.endedAt));
    if (today.length > failed.length) { settled.set(owner, local.day); reviewed.set(owner, local.day); return null; }
    if (failed.length >= NOUS_REVIEW_MAX_FAILED || bareTimeouts.length >= 2) {
      settled.set(owner, local.day);
      reviewed.set(owner, local.day);
      warn({ owner, day: local.day, failed: failed.length, timeouts: bareTimeouts.length }, "Nous daily review failed 3 times (or timed out twice without writing) today: no more retries until tomorrow.");
      return null;
    }
    // Asked already: only a failure that ended after the ask, with no REVIEW running or queued (its own retry), asks again.
    if (reviewed.get(owner) === local.day) {
      const newest = failed.at(-1);
      if (!newest || Date.parse(newest.endedAt) < (askedAt.get(owner) ?? 0)) return null;
      reviewed.delete(owner);
    }
    if (deps.review!.busy?.(owner)) return null;
    const load = await deps.review!.load?.(owner).catch(() => null);
    const tokenTable = await deps.review!.tokens?.(owner, since).catch(() => null);
    const text = [renderDailyReview({ facts, decisions: await deps.review!.decisions(owner).catch(() => []),
      cards: await deps.review!.cards?.(owner).catch(() => []) ?? [], ...(deps.review!.rails ? { rails: await deps.review!.rails(owner, since).catch(() => null) } : {}),
      ...(deps.review!.ledger ? { ledger: await deps.review!.ledger(owner, since).catch(() => []) } : {}),
      ...(deps.review!.waits ? { waits: await deps.review!.waits(owner, since).catch(() => []) } : {}),
      ...(deps.review!.dbFailures ? { dbFailures: await deps.review!.dbFailures(owner, since).catch(() => []) } : {}),
      ...(deps.review!.mailFailures ? { mailFailures: await deps.review!.mailFailures(owner, since).catch(() => []) } : {}),
      ...(deps.review!.sentry ? { sentry: await deps.review!.sentry(since).catch(() => ["- Not read: the Sentry reading failed."]) } : {}),
      ...(deps.review!.handoffs ? { handoffs: await deps.review!.handoffs(owner).catch(() => []) } : {}),
      ...(deps.review!.needsYou ? { needsYou: await deps.review!.needsYou(owner, since).catch(() => []) } : {}),
      ...(deps.review!.asks ? { asks: await deps.review!.asks(owner).catch(() => []) } : {}),
      ...(deps.review!.cardHolds ? { cardHolds: await deps.review!.cardHolds(owner, since).catch(() => undefined) } : {}),
      ...(deps.review!.requests ? { requests: await deps.review!.requests(owner, since).catch(() => undefined) } : {}),
      ...(deps.review!.deferrals ? { deferrals: await deps.review!.deferrals(owner, since).catch(() => []) } : {}), since, day: local.day, hour }), load, tokenTable].filter(Boolean).join("\n\n");
    const result = await deps.standing(owner, "REVIEW", text);
    if (result === "STARTED" || result === "QUEUED") { reviewed.set(owner, local.day); askedAt.set(owner, at); }
    return result;
  }

  /**
   * C (plan clipboard:ZWJJdBgHm64Z; 31/10 22:19 BKK his Requests tab read 35 In progress while 3 of 24 panes worked, and one operator turn
   * closed 11 of 19 at once, already finished): by day, every 30 minutes, the open requests come in the standing turn, each with its
   * pane's state, newest report and the evidence it is finished; every one not visibly moving (its pane not working, or evidence it is
   * done) is a hold-A item. Nothing open, nothing. D: the In progress count is kept at the operator's 09:00 and 21:00 for the REVIEW.
   */
  async function requestsSweep(owner: string, at: number): Promise<{ text: string; items: NousTurnItem[]; state: string } | null> {
    if (!deps.requests) return null;
    const local = localDayHour(at, await deps.requests.zone(owner).catch(() => "UTC"));
    const slot = local.hour >= 21 ? "21:00" : local.hour >= 9 ? "09:00" : null;
    if (slot && progressKept.get(owner) !== `${local.day} ${slot}`) {
      progressKept.set(owner, `${local.day} ${slot}`);
      await deps.requests.progress(owner, local.day, slot).catch((error) => warn({ err: error, owner }, "Nous In progress count failed."));
    }
    if (local.hour < SWEEP_HOURS.from || local.hour >= SWEEP_HOURS.to || at - (lastSweep.get(owner) ?? 0) < SWEEP_MS) return null;
    const open = await deps.requests.open(owner);
    if (!open.length) return null;
    // The operator's words are a quote beside the message id (space_open_requests reads each one whole); the pane's report and evidence are whole.
    const lineOf = (request: SweepRequest) => `- [${request.messageId ?? request.key}] «${quote(request.words)}» · open ${durationText(Math.max(0, at - Date.parse(request.openedAt)))}`
      + `${request.plan ? ` · ${request.plan}` : ""} · ${request.paneName ? `${request.paneName} ${request.paneState ?? "state unknown"}${request.paneSince ? ` since ${hhmm(request.paneSince)}` : ""}`
        : request.pane ? `${request.pane} closed or gone` : "no pane"}${request.report ? ` · newest report ${request.report.replace(/\s+/g, " ")}` : " · no report"}`
      + `${request.evidence ? ` · looks finished: ${request.evidence.replace(/\s+/g, " ")}` : ""}`;
    const rows = open.map((request) => ({ request, line: lineOf(request) }));
    // Only on a change (5/11): the same requests in the same states come back at most every UNCHANGED_MS.
    const state = JSON.stringify(open.map((request) => [request.key, request.paneState, request.paneSince, request.report, request.evidence]));
    const last = sweptState.get(owner);
    if (last?.state === state && at - last.at < UNCHANGED_MS) return null;
    const items: NousTurnItem[] = rows.filter(({ request }) => request.paneState !== "working" || request.evidence).map(({ request, line }) => ({
      key: `request:${request.key}`, kind: "REQUEST", line, requestKey: request.key, ...(request.messageId ? { messageId: request.messageId } : {}),
      ...(request.plan ? { plan: request.plan } : {}), ...(request.pane ? { pane: request.pane } : {}), ...(request.paneName ? { paneName: request.paneName } : {}) }));
    return { items, state, text: [`## Open requests (requests sweep by day when one changes, unchanged every 8 hours; operator 31/10 22:19 BKK: they move on your own, not only when he asks)`,
      "Each one now, one at a time: checked finished in this turn on its real surface (its evidence, its report, its ticket live where he uses it) → Done with what that check showed "
        + "(space_request_done, or space_open_requests close of that one with verified); its pane idle, waiting, closed or gone → send its next step to a pane naming it (a new pane when its own is busy 3+ min) or record what it waits on "
        + "(space_plan_update waitsOn, space_pane_checked WAITING_*); working → nothing unless its report says it is stuck.",
      ...rows.map(({ line }) => line)].join("\n") };
  }

  function closeoutContext(snapshot: Awaited<ReturnType<StandingOrdersDeps["collect"]>>, orders: NousSettings["standingOrders"], at: number, rows: ReadonlyMap<string, NousPaneCloseout>): CloseoutContext {
    const since = (paneId: string) => { for (const { sample } of snapshot.rooms) { const detail = sample?.details[paneId]; if (detail) return detail.since ?? null; } return null; };
    // The save request's own text is typed just before its row is stamped: only a prompt after it is new work.
    const promptedAt = (paneId: string) => {
      const row = rows.get(paneId);
      const last = lastPromptAt(paneId);
      return row && row.state !== "CLOSED" && last <= Date.parse(row.retriedAt ?? row.requestedAt) ? -Infinity : last;
    };
    return { since, tasks: snapshot.tasks, executions: snapshot.executions, summaries: snapshot.summaries, now: at, finishedAfterMs: orders.finishedAfterMinutes * MINUTE, closeOperatorPanes: orders.closeOperatorPanes, plans: snapshot.plans, operatorPromptedLast, promptedAt,
      ...(snapshot.browsers !== undefined ? { browsers: snapshot.browsers } : {}), ...(snapshot.usedAt ? { usedAt: snapshot.usedAt } : {}), ...(snapshot.scheduled !== undefined ? { scheduled: snapshot.scheduled } : {}),
      ...(snapshot.prompts !== undefined ? { prompts: snapshot.prompts } : {}) };
  }
  async function tickOwner(owner: string, settings: NousSettings): Promise<StandingTickResult> {
    const at = now();
    const spend = deps.spend ? await deps.spend(owner).catch(() => null) : null;
    const conserving = spend ? spend.mode !== "NORMAL" : await deps.lowToken?.(owner) ?? false;
    const snapshot = await deps.collect(owner);
    const orders = settings.standingOrders;
    const panes = boardPanes(snapshot, { showClosed: false });
    const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
    const ctx = closeoutContext(snapshot, orders, at, rows);
    // A listed pane's browser with many tabs: the finished ones close (browser hygiene); a pane without a CLI closes them with itself.
    const planNote = (input: BoardPaneInput) => { const what = planWaitsFor(input, ctx)
      ?? (input.plan && input.plan.progressPercentage < 100 && !openPlanStep(input.plan) && input.plan.steps.some((step) => step.status === "BLOCKED") ? "what its BLOCKED steps name" : null); return what ? ` · plan step waits for ${what}: its task or you reopen the pane when the work continues` : ""; };
    const tabs = (input: BoardPaneInput) => {
      const count = snapshot.browsers?.get(input.pane.id)?.tabs ?? 0;
      return count > NOUS_TABS_SHOWN_ABOVE ? ` · browser: ${count} tabs${savesToMemory(input.pane) ? " (kept open: have it close the finished ones, browser hygiene)" : " (they close with it)"}` : "";
    };
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

    // Item 7 A (round 14/11): each finished pane's line goes to the inbox beside its FINISHED notice (one turn per finish, no STANDING turn).
    const lines: Array<{ paneId: string; text: string }> = [];
    const cardLines: string[] = [];
    const list = (input: BoardPaneInput, key: string, text: string, into?: string[]) => {
      const entry = listed.get(`${owner}\u0000${input.pane.id}`);
      if (entry && entry.key === key && at - entry.at < UNCHANGED_MS) return;
      listed.set(`${owner}\u0000${input.pane.id}`, { key, at });
      if (into) into.push(text); else lines.push({ paneId: input.pane.id, text });
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
        if (skip === "task") continue;
        const row = rows.get(input.pane.id);
        const paneSince = closeoutSince(input, ctx);
        const inFlight = row && row.state !== "CLOSED";
        if (skip && skip !== "fresh" && skip !== "board-check") continue;
        const idle = `${input.state} ${durationText(at - Date.parse(paneSince!))}${tabs(input)}`;
        if (inFlight) {
          // Step 10: a save verified after the pane last worked, nothing else keeping it: Space closes it, no turn (~800k input each, 6/11).
          const closable = row.state === "VERIFIED" && (skip === null || skip === "fresh") && Date.parse(row.updatedAt) >= Date.parse(paneSince!);
          if (closable && deps.closePane && await deps.closePane(owner, input.room.id, input.pane.id).catch(() => false)) {
            await save({ ...row, state: "CLOSED", closedAt: stamp, reason: "closed by Space after its memory save", updatedAt: stamp });
            listed.delete(`${owner}\u0000${input.pane.id}`);
          } else if (row.state === "VERIFIED") list(input, `verified:${row.verifiedMemoryId}`, `- ${where(input)} · ${idle} · save asked ${hhmm(row.requestedAt)}, verified ${row.verifiedMemoryId} → close it now (space_close_pane)`);
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
            + `${task ? ` · task "${task.title}": Space reopens the pane when it runs` : ""}${planNote(input)} · save not asked yet → send it exactly "${NOUS_SAVE_TEXT}" (space_send_to_pane, when now)`);
        }
      }
    }

    // Stalled plans: one nudge per plan per stalled window; PAUSED or OFF leave the mark, so the next tick tries again.
    const map = deps.planMap ? await deps.planMap(owner, snapshot.plans).catch((error) => { warn({ err: error, owner }, "Nous plan map failed."); return null; }) : null;
    // B (plan clipboard:ZWJJdBgHm64Z; 31/10 from 22:18 BKK LOW stopped every plan while Claude Max still had 79 % of its week): only
    // CRITICAL (or LOW without the advice to tell pools apart) skips the nudges; LOW leaves out only plans whose pane runs on an avoided pool.
    const nudging = !conserving || spend?.mode === "LOW";
    const activity = !nudging ? [] : await nousPlanActivity({ owner, plans: snapshot.plans, samples: snapshot.rooms, marks: deps.marks, reports: snapshot.reports, executions: snapshot.executions,
      ...(map ? { held: (planId: string) => stalledHold(map, planId), hardHold: map.holds.some((hold) => HARD_HOLDS.has(hold.kind)) } : {}), stalledHours: orders.stalledAfterHours, now: new Date(at) })
      .catch((error) => { warn({ err: error, owner }, "Nous plan activity failed."); return []; });
    const paneOf = (planId: string) => snapshot.plans.find((plan) => plan.id === planId)?.paneId ?? null;
    const poolOf = (paneId: string | null) => {
      for (const { sample } of snapshot.rooms) { const pane = sample?.data.find((entry) => entry.id === paneId); if (pane) return RUNTIME_POOL[pane.terminalRuntimeId ?? ""] ?? null; }
      return null;
    };
    const avoided = (planId: string) => spend?.mode === "LOW" && spend.avoid.includes(poolOf(paneOf(planId)) ?? "\u0000");
    const due = activity.filter((item) => item.stalled && (!item.lastNudgedAt || at - Date.parse(item.lastNudgedAt) >= Math.max(orders.stalledAfterHours * 3_600_000, UNCHANGED_MS)) && !avoided(item.planId));
    // Hold A: each stalled plan is an item the turn must act on (Space does not take its NOTHING_NEW while one has no act).
    const planItems: NousTurnItem[] = due.map((item) => ({ key: `plan:${item.planId}`, kind: "PLAN", plan: item.planId, ...(paneOf(item.planId) ? { pane: paneOf(item.planId)! } : {}),
      ...(item.pane ? { paneName: item.pane.label } : {}), line: `Stalled plan [${item.planId}] "${item.title.replace(/\s+/g, " ")}" ${item.percent}%, unchanged ${durationText(item.hours * 3_600_000)}: one concrete action now (a next step to its pane, or its wait recorded).` }));
    // Parked plans (operator 13/11 nous_msg:4080b166): one whose NOUS or AGENT condition is still open and that has not moved for the stalled
    // window is a hold-A item: do the condition, or record it MET with its evidence (space_plan_update condition). Space checks the rest.
    const stalledMs = Math.max(orders.stalledAfterHours * 3_600_000, UNCHANGED_MS);
    const parkedDue = (nudging && deps.parked ? await deps.parked(owner).catch((error) => { warn({ err: error, owner }, "Nous parked plans failed."); return []; }) : [])
      .filter(planIsParked).filter((plan) => !due.some((item) => item.planId === plan.id)).flatMap((plan) => {
        const own = plan.parked.conditions.filter((entry) => entry.state === "OPEN" && (entry.who === "NOUS" || entry.who === "AGENT"));
        const moved = parkedSince(plan);
        return own.length && at - moved >= stalledMs && at - (lastParked.get(`${owner}\u0000${plan.id}`) ?? 0) >= stalledMs ? [{ plan, own, moved }] : [];
      });
    const parkedItems: NousTurnItem[] = parkedDue.map(({ plan, own, moved }) => ({ key: `parked:${plan.id}`, kind: "PLAN", plan: plan.id,
      line: `Parked plan [${plan.id}] "${(plan.title ?? plan.text.slice(0, 80)).replace(/\s+/g, " ")}" ${plan.isCompleted ? "closed" : "open"} at ${plan.progressPercentage}%, unmoved ${durationText(at - moved)} · `
        + `${own.map((entry) => `${entry.id} ${entry.who}: ${entry.what.replace(/\s+/g, " ")}`).join("; ")}: do it now (a pane for an AGENT one), or record it met with its evidence `
        + `(space_plan_update condition {id, met: true, evidence}); no longer wanted: re-park it with the real conditions or drop its steps.` }));
    const sweep = await requestsSweep(owner, at).catch((error) => { warn({ err: error, owner }, "Nous requests sweep failed."); return null; });
    // R35-1: each stuck pane once per UNCHANGED_MS while it stays stuck, as an item the turn must act on (read, restart, resend).
    const stuck = (deps.stuck ? await deps.stuck(owner).catch((error) => { warn({ err: error, owner }, "Nous stuck panes failed."); return []; }) : [])
      .filter((entry) => at - (lastStuck.get(`${owner}\u0000${entry.paneId}`) ?? 0) >= UNCHANGED_MS);
    const stuckItems: NousTurnItem[] = stuck.map((entry) => ({ key: `stuck:${entry.paneId}`, kind: "STUCK", pane: entry.paneId, paneName: entry.label, line: `${entry.label} (${entry.paneId}) · ${entry.line}` }));

    let turn: StandingResult | null = null;
    // The daily self-review (operator decision 2026-10-24): once per local day at or after the chosen hour, as a turn of its own.
    if (orders.dailyReview && deps.review) {
      const review = await dailyReviewTurn(owner, orders.dailyReviewHour, at).catch((error) => { warn({ err: error, owner }, "Nous daily review failed."); return null; });
      if (review && review !== "STARTED" && review !== "QUEUED") warn({ owner, review }, "Nous daily review left to the next tick.");
    }
    if (deps.pendings && orders.pendingsHours.length) {
      await pendingsTurn(owner, orders.pendingsHours, at, map).catch((error) => warn({ err: error, owner }, "Nous pendings list failed."));
    }
    // R44-3: a recurring agent task with no pane and no room only reminds (the scheduler told Nous once); listed whenever a turn runs, never a reason for one.
    const paneless = snapshot.tasks.filter((task) => task.source === "AGENT" && task.schedule && task.schedule.recurrence.kind !== "ONCE" && !task.paneId && !task.roomId);
    // The rule is in the INBOX turn prompt.
    // Plan clipboard:CDbnZ7FSj-ww item 7: `soon` flushes the batch now, so the done/failed report reaches Nous within a minute as one turn with this line.
    for (const line of lines) await deps.notice?.(owner, `${NOUS_FINISHED_KEY}${line.paneId}`, `Finished pane ${line.text.replace(/^- /, "")}`, undefined, true);
    if (cardLines.length || due.length || parkedItems.length || sweep || stuck.length) {
      const text = ["# Standing orders (from Space, not the operator; they repeat every tick until each line is handled)",
        cardLines.length ? ["## Your cards on finished panes (a card the operator no longer needs keeps their room \"Needs attention\")", ...cardLines].join("\n") : "",
        stuckItems.length ? ["## Stuck panes (screen and CLI state unchanged 30+ min on a spinner, or a text queued for it never typed; the world may call them idle)", ...stuckItems.map((item) => `- ${item.line}`)].join("\n") : "",
        renderStandingPlansPrompt(due), parkedItems.length ? ["## Parked plans waiting on you (a NOUS or AGENT resume condition is open; Space reopens the plan when every condition is met)",
          ...parkedItems.map((item) => `- ${item.line}`)].join("\n") : "", sweep?.text ?? "", paneless.length ? ["## Scheduled agent tasks with no pane (each run only reminds: Space knows no pane or room for it; bind it to a CLI pane with space_task_update bind)",
          ...paneless.map((task) => `- [${task.id}] "${task.title.replace(/\s+/g, " ")}" · next run ${task.schedule!.nextRunAt ?? "none"}`)].join("\n") : ""].filter(Boolean).join("\n\n");
      const items = [...stuckItems, ...planItems, ...parkedItems, ...(sweep?.items ?? [])];
      turn = items.length ? await deps.standing(owner, "STANDING", text, { items }) : await deps.standing(owner, "STANDING", text);
      if (sweep && (turn === "STARTED" || turn === "QUEUED")) { lastSweep.set(owner, at); sweptState.set(owner, { state: sweep.state, at }); }
      if (turn === "STARTED" || turn === "QUEUED") for (const entry of stuck) lastStuck.set(`${owner}\u0000${entry.paneId}`, at);
      if (turn === "STARTED" || turn === "QUEUED") for (const { plan } of parkedDue) lastParked.set(`${owner}\u0000${plan.id}`, at);
      if ((turn === "STARTED" || turn === "QUEUED") && due.length) await deps.marks.nudged(owner, due.map((item) => item.planId), new Date(at)).catch((error) => warn({ err: error, owner }, "Nous plan nudge mark failed."));
      // A turn that did not start (paused, off) must not count as a listing.
      // (The inbox keeps the finished lines whatever the turn: only the panes listed in this turn are listed again.)
      if (turn !== "STARTED" && turn !== "QUEUED") for (const input of panes) {
        const entry = listed.get(`${owner}\u0000${input.pane.id}`);
        if (entry?.at === at && !lines.some((line) => line.paneId === input.pane.id)) listed.delete(`${owner}\u0000${input.pane.id}`);
      }
    }

    // Kept cadences: the pane round's line every 30 minutes while panes are due; the Away round every 30 minutes with nothing due.
    if (deps.paneRound && deps.notice && at - (lastRound.get(owner) ?? 0) >= RELIST_MS) {
      lastRound.set(owner, at);
      const line = await deps.paneRound(owner, snapshot.rooms).catch(() => null);
      if (line) await deps.notice(owner, "pane-round", line);
    }
    // Push (operator 3/11 23:11 BKK «τρέξε τα πάντα … να πιέζει τα πάντα στο 90% συνεχόμενα»; until then one line an hour, 10 plans sat "Not on a
    // pane" for hours): every tick (10 min) while utilization stays under 90 %, the server is not OVERLOADED and CLI panes have room
    // (`utilizationLow`), one line carries every piece of runnable work as an item, so Space refuses NOTHING_NEW until each is dispatched or its
    // wait recorded: plans not on a pane, plans whose pane is idle or done (R57: before they stall, 4/11 REVIEW 60 % with 14 such panes), open
    // requests whose pane is done or gone 30+ minutes.
    // 13/11 (operator 09:12 BKK «γιατι δεν πιεζεις τα πραγματα»): a CLI pane that finished since the last push with a plan step to run or a task
    // whose run ended is pushed at once (`soon` runs this tick within a minute of its report), not at the next 10-minute push.
    const pushedAt = lastUtilization.get(owner) ?? 0;
    const finishedTasks = snapshot.tasks.filter((task) => task.paneId && !task.schedule?.nextRunAt && (task.status === "RUNNING" || Boolean(task.schedule?.lastRunAt)))
      .flatMap((task) => { const input = panes.find((entry) => entry.pane.id === task.paneId); return input && savesToMemory(input.pane) && (input.state === "done" || input.state === "idle") ? [{ task, input }] : []; });
    const finishedSince = (since: string | null | undefined) => Boolean(since) && Date.parse(since!) > pushedAt;
    // 13/11 23:03 BKK (operator «δωσε σε agent να το διορθωσει»): at 22:41 BKK seven CLI panes finished with no plan step or task of their own and
    // none got work until the 10-minute push. A CLI pane done or idle since the last push that holds no plan is free capacity: the push goes at once
    // (a pane with a plan is pushed by its ready step above, or waits on its BLOCKED steps).
    const freed = panes.filter((input) => savesToMemory(input.pane) && (input.state === "done" || input.state === "idle") && finishedSince(closeoutSince(input, ctx))
      && !snapshot.plans.some((plan) => plan.paneId === input.pane.id));
    const newlyFinished = freed.length > 0 || activity.some((item) => item.ready && !avoided(item.planId) && finishedSince(item.pane?.since));
    if (deps.utilizationLow && deps.notice && (at - pushedAt >= PUSH_MS - MINUTE || newlyFinished)) {
      const line = await deps.utilizationLow(owner, snapshot.plans.length, newlyFinished).catch(() => null);
      // A plan whose whole-plan wait is on someone still runs its other steps (stalled-plans.ts); one whose waiting steps are all BLOCKED does not.
      const runnable = line ? activity.filter((item) => (item.stalled || item.ready) && item.openStep && item.pane?.state !== "working" && !avoided(item.planId)) : [];
      const roomOf = (planId: string) => { const roomId = snapshot.plans.find((plan) => plan.id === planId)?.roomId; return snapshot.rooms.find(({ room }) => room.id === roomId)?.room.name ?? null; };
      const planItem = (item: (typeof runnable)[number]): NousTurnItem => ({ key: `plan:${item.planId}`, kind: "PLAN", plan: item.planId, ...(paneOf(item.planId) ? { pane: paneOf(item.planId)! } : {}),
        ...(item.pane ? { paneName: item.pane.label } : {}), line: `Plan [${item.planId}] "${item.title.replace(/\s+/g, " ")}" ${item.percent}% · ${item.pane ? `${item.pane.label} ${item.pane.state ?? "state unknown"}`
          : `no open pane${roomOf(item.planId) ? ` (room ${roomOf(item.planId)})` : ""}`} · next: ${item.openStep!.replace(/\s+/g, " ")}${item.hold ? ` · plan ${item.hold.replace(/\s+/g, " ")}` : ""}`
          + `: ${item.pane ? `send it to ${item.pane.label} now (space_send_to_pane naming the plan)` : `open a pane for it now at the plan's minimum model (space_open_panes) and send it "Implement the following plan. Plan ID: ${item.planId}"`}, or mark the steps that wait BLOCKED.` });
      const unpaned = runnable.filter((item) => !item.pane).map(planItem);
      // 13/11 (operator: utilization at 80 % until morning; memory 60ca649d: under LOW the push waited up to an hour behind the inbox cap, then
      // needed a Nous turn): a ready plan with no recorded wait gets its next step from Space at once, each step once per pane (one that
      // ends with the same step still open stays with Nous). `line` is the gate: under target, calm, no limit, not CRITICAL, its pool not avoided.
      const sent: Array<(typeof runnable)[number]> = [];
      for (const item of runnable) {
        const paneId = paneOf(item.planId);
        const roomId = snapshot.rooms.find(({ sample }) => sample?.data.some((entry) => entry.id === paneId))?.room.id;
        const key = `${owner}\u0000${paneId}`;
        if (!deps.dispatch || !item.ready || item.hold || !paneId || !roomId || dispatched.get(key) === item.openStep) continue;
        dispatched.set(key, item.openStep!);
        if (await deps.dispatch(owner, roomId, paneId, `Continue plan ${item.planId} "${item.title.replace(/\s+/g, " ")}": its next step is ${item.openStep}. `
          + "Do it now, update the plan's steps and progress, and report when it is done.").catch(() => false)) sent.push(item);
      }
      const idle = runnable.filter((item) => item.pane && !sent.includes(item)).map(planItem);
      // One item per pane: a pane that already has its plan's next step gets no task item.
      const taskPanes = new Set([...idle.map((item) => item.pane), ...sent.map((item) => paneOf(item.planId))]);
      const taskItems: NousTurnItem[] = !line ? [] : finishedTasks.filter(({ task }) => !taskPanes.has(task.paneId!) && taskPanes.add(task.paneId!)).map(({ task, input }) => ({ key: `task:${task.id}`, kind: "PLAN",
        pane: input.pane.id, paneName: paneLabel(input.pane), refs: [task.id], line: `Task [${task.id}] "${task.title.replace(/\s+/g, " ")}" · ${where(input)} ${input.state}, nothing scheduled next`
          + `: finished → mark it DONE (space_task_update); else send ${paneLabel(input.pane)} its next step now (space_send_to_pane naming the task).` }));
      const requests = line && deps.requests ? (await deps.requests.open(owner).catch(() => [] as SweepRequest[]))
        .filter((request) => request.paneState !== "working" && at - Date.parse(request.paneSince ?? request.openedAt) >= PUSH_REQUEST_IDLE_MS) : [];
      const requestItems: NousTurnItem[] = requests.map((request) => ({ key: `request:${request.key}`, kind: "REQUEST", requestKey: request.key, ...(request.messageId ? { messageId: request.messageId } : {}),
        ...(request.plan ? { plan: request.plan } : {}), ...(request.pane ? { pane: request.pane } : {}), ...(request.paneName ? { paneName: request.paneName } : {}),
        line: `[${request.messageId ?? request.key}] «${quote(request.words)}» · open ${durationText(Math.max(0, at - Date.parse(request.openedAt)))}${request.plan ? ` · ${request.plan}` : ""}`
          + ` · ${request.paneName ? `${request.paneName} ${request.paneState ?? "state unknown"}${request.paneSince ? ` since ${hhmm(request.paneSince)}` : ""}` : request.pane ? `${request.pane} closed or gone` : "no pane"}`
          + `: finished → Done (space_request_done); else send its next step to a pane naming it (a new pane when its own is gone).` }));
      const section = (title: string, items: NousTurnItem[]) => items.length ? [`${title}:`, ...items.map((item) => `- ${item.line}`)] : [];
      const others = freed.filter((input) => !taskPanes.has(input.pane.id));
      const free = others.length ? [`CLI panes free since the last push (hand each the next piece of work below now): ${others.map((input) => `${where(input)} ${input.state}`).join(", ")}`] : [];
      const text = line ? [line, ...free, ...section("Plans not on a pane (open a pane for each now)", unpaned), ...section("Plans whose pane is idle or done (send each its next step now)", idle),
        ...(sent.length ? [`Space sent the next step itself (nothing to send): ${sent.map((item) => `${item.pane!.label} [${item.planId}] ${item.openStep}`).join("; ")}`] : []),
        ...section("Tasks whose run ended on a finished pane", taskItems), ...section("Open requests whose pane is done or gone 30+ min", requestItems)].join("\n") : null;
      // Hold A: idle capacity is an item too: the turn that carries this line starts parallel work or records what blocks it. 13/11: words alone no
      // longer pass any item of it (turn-items.ts `always`): 121 of 224 pushes got an answer in words and no tool call.
      if (text) {
        lastUtilization.set(owner, at);
        const utilization: NousTurnItem = { key: "utilization", kind: "UTILIZATION", line: text };
        await deps.notice(owner, "utilization-low", text, [utilization, ...unpaned, ...idle, ...taskItems, ...requestItems].map((item) => ({ ...item, always: true })), newlyFinished);
      }
    }
    if (deps.away && at - (lastAway.get(owner) ?? 0) >= RELIST_MS && await deps.away(owner).catch(() => false)) {
      lastAway.set(owner, at);
      const load = deps.serverLine ? await deps.serverLine().catch(() => null) : null;
      await deps.standing(owner, "HEARTBEAT", `Away round: ${snapshot.plans.length} open plan${snapshot.plans.length === 1 ? "" : "s"}; ${conserving ? spend?.mode === "LOW" ? "low-spend mode: move stalled plans only on pools the Provider advice does not avoid; finished-pane save/close as usual" : "low-spend mode: handle urgent work and finished-pane save/close only; leave stalled-plan nudges until the quota returns" : "look over the plans and the panes, move on what stalled"}.${load ? ` ${load}` : ""}`);
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
    /** A pane reported done (or ended its turn): this owner's next minute tick runs at once instead of after `tickMinutes`. */
    soon(owner: string): void { lastTick.delete(owner); },
    /** One owner now (tests, and the API's startup tick). */
    async tickOwner(owner: string): Promise<StandingTickResult> {
      const settings = await deps.settings(owner);
      if (!settings.enabled) return { paneLines: 0, stalledPlans: 0, turn: "OFF" };
      lastTick.set(owner, now());
      return tickOwner(owner, settings);
    },
    /**
     * R43-1 (R42-4: 12 space_open_panes refused "Room … is capped at 16" in 48 h, Alex and Bruno full of finished idle panes): a room's open
     * panes, oldest finished first, each with its save state and whether it may close now: a finished pane (`closeoutSkipReason` null: never a
     * working pane, the Mail Copilot, one with an open card or decision, a KEEP_OPEN check, a task due within the hour, an OPERATOR_TEST pane
     * while "Close your own panes too" is off) with nothing to save, or whose memory save was verified after it last worked.
     */
    async roomCloseouts(owner: string, roomId: string): Promise<RoomCloseout[]> {
      const at = now();
      const settings = await deps.settings(owner);
      const snapshot = await deps.collect(owner);
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      const ctx = closeoutContext(snapshot, settings.standingOrders, at, rows);
      return boardPanes(snapshot, { showClosed: false }).filter((input) => input.pane.roomId === roomId).map((input): RoomCloseout => {
        const since = closeoutSince(input, ctx);
        const row = rows.get(input.pane.id);
        const live = row && row.state !== "CLOSED" ? row : null;
        const verified = live?.state === "VERIFIED" && since !== null && Date.parse(live.updatedAt) >= Date.parse(since);
        const save = !savesToMemory(input.pane) ? "nothing to save" : verified ? `save verified ${live!.verifiedMemoryId}`
          : live ? `save asked ${hhmm(live.retriedAt ?? live.requestedAt)}, not verified` : "save not asked";
        const skip = closeoutSkipReason(input, ctx);
        return { pane: input.pane, state: input.state, since, idleMinutes: since ? Math.max(0, Math.round((at - Date.parse(since)) / MINUTE)) : null, save,
          closable: skip === null && (!savesToMemory(input.pane) || verified), skip };
      }).sort((left, right) => (left.since ?? "\uffff").localeCompare(right.since ?? "\uffff"));
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
/** R43-1: one open pane of a room as the standing orders read it (`roomCloseouts`). */
export interface RoomCloseout { pane: Pane; state: string; since: string | null; idleMinutes: number | null; save: string; closable: boolean; skip: CloseoutSkip | null }
