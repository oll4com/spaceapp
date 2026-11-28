import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { cliToggleRuntimeIds, planIsParked, type ClipboardItem, type ManagedPlanExecution, type NousDecision, type NousSettings, type NousTurnFacts, type Pane, type RoomAgentEvent, type SpaceNotification, type TaskItem } from "@space/contracts";
import type { NousLedgerRow, NousPaneCloseout, RailDecisionCount, NousPaneCloseoutsRepository, NousPaneSummaryRow, NousPlanMarksRepository, PaneReport } from "@space/db";
import { isCliPane } from "../pane-guards.js";
import { lastPromptAt, OPERATOR_TURN_GRACE_MS, operatorPaneReason, operatorPromptedLast } from "../queue-operator-grants.js";
import { execGit, WORKTREES_ROOT } from "../worktrees/worktree-service.js";
import { durationText, paneLabel } from "./digest.js";
import { parkedSince } from "./parked-plans.js";
import { boardPanes, type BoardPaneInput, type PaneBoardSnapshot } from "./pane-board.js";
import { NOUS_PANE_NOTICE_PREFIX } from "./pane-notices.js";
import { nousPlanActivity, openPlanStep, renderStandingPlansPrompt } from "./stalled-plans.js";
import { HARD_HOLDS, stalledHold, type PlanMap } from "./plan-map.js";

/** Standing orders (operator 2026-10-21): each tick Space brings finished CLI panes and stalled plans to Nous in a STANDING turn until handled; close-out state lives in nous_pane_closeouts so a restart loses nothing. */
import { awaitsOperator, CLOSEOUT_NEXT, type CloseoutSkip, NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT, NOUS_SAVE_YOURSELF, reportSettled, STALE_WAIT_MS, workOpen } from "./save-request.js";
import { taskHoldsPane } from "./tools.js";
import type { NousTurnItem } from "./turn-items.js";
import { quote } from "./requests-waiting.js";
import { NOUS_SWEEP_PANE_TITLE, sweepAreaTouched, sweepPane, sweepPieces } from "./utilization.js";

export { NOUS_SWEEP_PANE_TITLE, sweepPane };
import { localDayHour, NOUS_REVIEW_WINDOW_MS, renderDailyReview, requestKey, type NousDeferral } from "./daily-review.js";
import { quotaPool } from "./quota-handover.js";
import { COPILOT_SOURCES } from "./copilot-questions.js";
export { NOUS_SAVE_REQUEST, NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT } from "./save-request.js";
const MEMORY_ID = /space_memory:[a-f0-9]{6,}/i;
// "Nothing new to save" answers the ask too (27/11: a pane with nothing new left its save unverified for hours).
const SAVED_WORDS = /\b(?:saved|deduplicated|nothing (?:new )?to save)\b/i;
const MINUTE = 60_000;
/** A save request still settling: the pane's turn and its report take a moment. */
const SETTLE_MS = 2 * MINUTE;
/** After this without a verified save the pane is Nous's call: read it, ask once more, or keep it open. */
export const NOUS_SAVE_WAIT_MS = 20 * MINUTE;
/** The same pane line is not repeated to Nous more often than this unless its state changed. */
const RELIST_MS = 30 * MINUTE;
/** A line that did not change comes back at most 3 times a day (operator nous_msg:ffec6f53). */
const UNCHANGED_MS = 8 * 60 * MINUTE;
/** C (plan clipboard:ZWJJdBgHm64Z): the requests sweep's cadence and the operator's day it runs in (local hours, end exclusive). */
const SWEEP_MS = 30 * MINUTE;
const SWEEP_HOURS = { from: 9, to: 23 } as const;
/** The push: runnable work reaches Nous every 10 minutes while capacity is free; a request joins once its pane rested 30 minutes. */
const PUSH_MS = 10 * MINUTE;
const PUSH_REQUEST_IDLE_MS = 30 * MINUTE;
/** The pool a pane's CLI draws on, as the Provider advice names it (tokens.ts POOLS); null: a CLI outside Space Gateway's pools. */

/** An open operator request for the sweep: its words, plan, pane (and its state), newest report and the evidence it is finished. */
export interface SweepRequest {
  key: string; messageId: string | null; words: string; plan?: string; pane?: string; paneName?: string;
  paneState?: string | null; paneSince?: string | null; report?: string | null; evidence?: string | null; openedAt: string;
  /** The request's closed pane got request-done's durable "lost its pane" line (note paneGone === pane), so the 30-min sweep skips it. */
  goneTold?: boolean;
}
/** Goal 5acd171d: a request item's left shape, the same in the sweep and the push (their lines differ, so one key kept re-arming the other). */
const requestShape = (request: SweepRequest) => JSON.stringify([request.key, request.paneName ?? request.pane ?? null, request.paneState ?? null, request.paneSince ?? null, request.report ?? null, request.evidence ?? null]);
const KEEP_VERDICTS = new Set(["KEEP_OPEN", "WAITING_OPERATOR", "WAITING_DATE", "BLOCKED"]);
/** Skips a save verified after the pane's last prompt passes: its question, Nous's own keep-open check, a finish time Space could not read. */
const SAVED_PASSES = new Set<CloseoutSkip>(["awaits-operator", "keep-open", "unknown"]);
const BOARD_WAITS = new Set(["OPERATOR", "DATE", "PROMOTE", "THIRD_PARTY"]);
const OPEN_PLAN = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

/** R10-19: the daily review's turns that may fail in one local day before it waits for the next (the first ask and 2 retries). */
export const NOUS_REVIEW_MAX_FAILED = 3;

export type { CloseoutSkip };
/** A browser tab count above this shows on the pane's line, so Nous has the finished tabs closed (browser hygiene, operator 27/10). */
export const NOUS_TABS_SHOWN_ABOVE = 3;
const isNousCard = (item: SpaceNotification) => item.source === "NOUS" && Boolean(item.dedupeKey?.startsWith(NOUS_PANE_NOTICE_PREFIX));

/** A pane's live browser from the census records: tab count, who holds it ("unknown" on a failed read keeps it open) and when it last moved. */
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
  /** Why the pane is the operator's own (queue-operator-grants `operatorPaneReason`), null when it is not. */
  operatorPane?(pane: Pane): string | null;
  /** When the pane last got a prompt from anyone, its own memory-save request excepted (queue-operator-grants `lastPromptAt`). */
  promptedAt?(paneId: string): number;
  /** Panes a prompt is still to reach (Nous's held queue, Space Control's schedules); null when the read failed (then no pane closes). */
  prompts?: ReadonlySet<string> | null;
  /** Panes whose worktree holds pending deliverables (uncommitted changes or unmerged commits); null when the check failed (CLI panes stay open). */
  pendingWorktrees?: ReadonlySet<string> | null;
}

/** A pane with an AI CLI saves to memory before it closes; every other pane (a browser, a plain shell, ...) has nothing to save. */
export function savesToMemory(pane: Pick<Pane, "mode" | "terminalRuntimeId">): boolean {
  return isCliPane(pane) && (cliToggleRuntimeIds as readonly string[]).includes(pane.terminalRuntimeId ?? "");
}

/** When the pane last did or showed anything, so a browser on screen or a playing video is never finished. */
export function closeoutSince(input: Pick<BoardPaneInput, "pane">, ctx: CloseoutContext): string | null {
  const { pane } = input;
  if (savesToMemory(pane)) return ctx.since(pane.id);
  const times = [ctx.since(pane.id), pane.updatedAt, ctx.browsers?.get(pane.id)?.activeAt, ctx.usedAt?.get(pane.id)]
    .filter((value): value is string => typeof value === "string" && Number.isFinite(Date.parse(value)));
  return times.length ? times.reduce((newest, value) => Date.parse(value) > Date.parse(newest) ? value : newest) : null;
}

/** A CLI pane idle at its prompt with its own done/failed or Space's turn-end report is finished at once; otherwise it waits `finishedAfterMinutes`. */
export function reportedFinished(input: Pick<BoardPaneInput, "pane" | "report">): boolean {
  const report = input.report;
  return savesToMemory(input.pane) && Boolean(report) && (report!.status === "DONE" || report!.status === "FAILED" || (report!.status === "TURN_END" && report!.source === "AUTO"));
}

const PLAN_WAITS = new Set(["DATE", "PROMOTE", "THIRD_PARTY"]);
const waitText = (kind: string, what: string) => `${kind.toLowerCase().replace("_", " ")}: ${what.replace(/\s+/g, " ")}`;
/** What a pane's open plan waits on that nobody can move now (date, promote, third party, a plan it depends on), or null (operator rule 264b98c3). */
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
  // Every pane type closes once finished, but a browser someone holds (control lease, handoff, Vault fence) is in use.
  if (ctx.browsers?.get(pane.id)?.held) return "browser-held";
  if (ctx.browsers === null && !savesToMemory(pane)) return "unknown";
  if (state !== "done" && state !== "idle") return "busy";
  // Operator 21/11 nous_msg:63896af5: a pane the operator opened or prompted is never finished nor idle for Nous's work.
  if (ctx.operatorPane?.(pane)) return "operator-pane";
  const promptedLast = ctx.operatorPromptedLast?.(pane.id) ?? false;
  const operatorWaits = input.decisions.length > 0 || input.copilotItems.length > 0 || input.notifications.some((item) => !isNousCard(item));
  // Operator 28/11 nous_msg:57f3908d: a waiting, needs-decision or blocked report idle 30+ min with nothing open for the operator is finished.
  const settled = !promptedLast && !operatorWaits && Boolean(input.report) && reportSettled(input.report!, input.report, ctx.since(pane.id), ctx.now);
  if (savesToMemory(pane) && !settled && awaitsOperator(input.report, promptedLast)) return "awaits-operator";
  const since = closeoutSince(input, ctx);
  if (!since) return "unknown";
  // 13/11 Eva/Andy: closed 18 s after Nous typed its plan step, the dashboard still read done. A prompt since it finished, or one to come, is work.
  if (ctx.prompts === null || ctx.prompts?.has(pane.id) || (ctx.promptedAt?.(pane.id) ?? -Infinity) > Date.parse(since)) return "prompted";
  if (check?.verdict === "OPERATOR_TEST" && ctx.closeOperatorPanes === false) return "operator-test";
  // Before keep-open: Nous's own mark passes its later save and close (operator 28/11), the operator's open card or decision never does.
  if (operatorWaits) return "waiting-operator";
  if (check?.verdict && KEEP_VERDICTS.has(check.verdict) && check.nextCheckAt && Date.parse(check.nextCheckAt) > ctx.now) return "keep-open";
  // Only Nous's own card waits on a finished pane: Nous re-checks it instead of keeping the pane.
  const wait = reportedFinished(input) ? 0 : ctx.finishedAfterMs;
  if (input.notifications.length) {
    const old = (iso: string) => ctx.now - Date.parse(iso) >= wait;
    return old(since) && input.notifications.every((card) => old(card.updatedAt)) ? "card-check" : "waiting-operator";
  }
  if (paneHasPendingTask(pane.id, ctx.tasks, ctx.now)) return "task";
  if (ctx.executions.some((execution) => execution.paneId === pane.id)) return "managed";
  // 2026-11-25 REVIEW: never close or hand out a pane whose worktree still holds uncommitted changes or unmerged commits.
  if (ctx.pendingWorktrees?.has(pane.id) || (ctx.pendingWorktrees === null && isCliPane(pane))) return "pending-deliverables";
  const plan = input.plan;
  // A plan that waits on a date, a promote, a third party or another plan does not keep its pane: it closes and reopens with the work (R10-3).
  const planOpen = plan && plan.progressPercentage < 100 && !OPEN_PLAN.has(plan.executionStatus) && plan.steps.some((step) => step.status !== "COMPLETED");
  const planWait = planOpen ? planWaitsFor(input, ctx) : null;
  // Only a runnable plan step or the operator's own answer keeps a finished pane; the rest save, close and reopen with the work.
  if (planOpen && !planWait && (openPlanStep(plan) || plan.waitsOn?.kind === "OPERATOR")) return "plan-open";
  const summary = latestSummary(pane.id, ctx.summaries);
  const fresh = ctx.now - Date.parse(since) < wait;
  // The board's wait is a model's reading: once the pane is finished long enough Nous re-checks it.
  if ((!planWait || summary?.waitsOn === "OPERATOR") && summary && BOARD_WAITS.has(summary.waitsOn) && summary.generatedAt >= since) return fresh ? "board-waits" : "board-check";
  if (fresh) return "fresh";
  return null;
}

/** A CLI pane's question is open (its answer, report, card or board wait asks the operator) and it gets no new work until answered (operator cli_session:SFmu0kLCt3yJ). */
export function questionOpen(input: BoardPaneInput, ctx: Pick<CloseoutContext, "since" | "summaries" | "now">): boolean {
  if (!savesToMemory(input.pane)) return false;
  // A blocked, waiting or needs-decision report idle 30+ min asks nothing; cards and decisions still hold it (nous_msg:57f3908d).
  const stale = Boolean(input.report) && reportSettled(input.report!, input.report, ctx.since(input.pane.id), ctx.now);
  // A copilot's review or question waits in its queue, so it holds no new work here; its save still waits.
  if ((!stale && awaitsOperator(input.report, false)) || input.decisions.length || input.notifications.some((item) => !isNousCard(item) && !COPILOT_SOURCES.has(item.source))) return true;
  const since = ctx.since(input.pane.id), board = latestSummary(input.pane.id, ctx.summaries);
  return Boolean(since && board?.waitsOn === "OPERATOR" && board.generatedAt >= since);
}

const latestSummary = (paneId: string, summaries: NousPaneSummaryRow[]) =>
  summaries.filter((row) => row.paneId === paneId).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0];

/** The scheduled task bound to a pane, null when none; the scheduler reopens a closed pane when it falls due. */
export function keptOpenForTask(paneId: string, tasks: TaskItem[]): TaskItem | null {
  return tasks.find((task) => task.paneId === paneId && task.schedule) ?? null;
}

/** Any task bound to the pane keeps it open: running, scheduled within TASK_SOON_MS, or a one-off that ran but is not DONE. */
export const paneHasPendingTask = (paneId: string, tasks: readonly TaskItem[], at: number): boolean => tasks.some((task) => task.paneId === paneId && taskHoldsPane(task, at));

/** A pane bound to any task, plan, managed run, open request or worktree with pending deliverables never gets a hygiene sweep. */
export function paneBoundToWork(
  paneId: string,
  work: {
    tasks?: readonly TaskItem[];
    plans?: readonly ClipboardItem[];
    executions?: ReadonlyArray<Pick<ManagedPlanExecution, "paneId">>;
    requests?: ReadonlyArray<Pick<SweepRequest, "pane">>;
    pendingWorktrees?: ReadonlySet<string> | null;
  }
): boolean {
  if (work.tasks?.some((task) => task.paneId === paneId && task.status !== "DONE" && task.status !== "ARCHIVED")) return true;
  if (work.plans?.some((plan) => plan.paneId === paneId && !plan.isCompleted && plan.progressPercentage < 100 && !OPEN_PLAN.has(plan.executionStatus))) return true;
  if (work.executions?.some((execution) => execution.paneId === paneId)) return true;
  if (work.requests?.some((request) => request.pane === paneId)) return true;
  return work.pendingWorktrees === null || Boolean(work.pendingWorktrees?.has(paneId));
}

/**
 * A pane held now (open question, a task running or due within TASK_SOON_MS, a managed run); Load leaves it out while idle. A date/promote/third-party
 * wait parks no pane. Operator 28/11 14:40 BKK (nous_msg:8277b302 «με 6 running να ειναι 100% ειναι λαθος»): any open task parked it, so 6 idle panes
 * whose recurring tasks ran next in hours to a month left the denominator and 6 working read 6 of 6.
 */
export const parkedPane = (input: BoardPaneInput, ctx: Pick<CloseoutContext, "since" | "summaries" | "now" | "tasks" | "executions">): boolean =>
  questionOpen(input, ctx) || paneHasPendingTask(input.pane.id, ctx.tasks, ctx.now) || ctx.executions.some((execution) => execution.paneId === input.pane.id);

/** True when a worktree has uncommitted/untracked files or unmerged commits; a failing git counts as pending (plan CTVaL1V3kAFM step 7). */
export async function worktreeHasPendingDeliverables(worktreePath: string): Promise<boolean> {
  if (!existsSync(worktreePath)) return false;
  const status = await execGit(worktreePath, ["status", "--porcelain"], 3_000);
  if (status.code !== 0) return !/not a git repository \(or any/i.test(status.stderr);
  if (status.stdout.trim().length > 0) return true;
  const refs = await execGit(worktreePath, ["for-each-ref", "--format=%(refname)", "refs/heads/dev", "refs/heads/main"], 3_000);
  if (refs.code !== 0) return true;
  const bases = refs.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!bases.length) return false;
  const ahead = await execGit(worktreePath, ["rev-list", "--count", "HEAD", "--not", ...bases], 3_000);
  return ahead.code !== 0 || ahead.stdout.trim() !== "0";
}

/** Panes whose managed worktree (via pane.cwd or .worktree-registry.json) holds uncommitted changes or unmerged commits. */
export const panePendingWorktrees = async (panes: readonly Pick<Pane, "id" | "cwd">[], options: { worktreesRoot?: string; registryPath?: string } = {}): Promise<Set<string>> =>
  new Set((await panePendingWorktreePaths(panes, options)).keys());
/** The same, with the first such worktree of each pane (a close note names it: plan clipboard:CTVaL1V3kAFM step 4). */
export async function panePendingWorktreePaths(
  panes: readonly Pick<Pane, "id" | "cwd">[],
  options: { worktreesRoot?: string; registryPath?: string } = {}
): Promise<Map<string, string>> {
  const root = resolve(options.worktreesRoot ?? WORKTREES_ROOT);
  const inside = (path: string | null | undefined): string | null => {
    if (!path) return null;
    const resolved = resolve(path);
    return resolved.startsWith(`${root}${sep}`) ? resolved : null;
  };
  const byPane = new Map<string, Set<string>>();
  const add = (paneId: string, path: string | null) => {
    if (!path) return;
    let set = byPane.get(paneId);
    if (!set) { set = new Set(); byPane.set(paneId, set); }
    set.add(path);
  };
  const openIds = new Set(panes.map((pane) => pane.id));
  for (const pane of panes) add(pane.id, inside(pane.cwd));
  const registryPath = options.registryPath ?? join(root, ".worktree-registry.json");
  if (existsSync(registryPath)) {
    const raw = await readFile(registryPath, "utf8").catch(() => "");
    try {
      const parsed = JSON.parse(raw) as { worktrees?: Record<string, { paneId?: string | null; worktreePath?: string }> };
      for (const record of Object.values(parsed?.worktrees ?? {})) {
        if (record?.paneId && openIds.has(record.paneId)) add(record.paneId, inside(record.worktreePath));
      }
    } catch { /* ignore unreadable registry: cwd checks still apply */ }
  }
  const cache = new Map<string, Promise<boolean>>();
  const check = (path: string) => {
    let pending = cache.get(path);
    if (!pending) { pending = worktreeHasPendingDeliverables(path).catch(() => true); cache.set(path, pending); }
    return pending;
  };
  const pending = new Map<string, string>();
  await Promise.all([...byPane.entries()].map(async ([paneId, paths]) => {
    for (const path of paths) {
      if (await check(path)) { pending.set(paneId, path); return; }
    }
  }));
  return pending;
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
  /** Spend mode and the pools to avoid (plan ZWJJdBgHm64Z): LOW nudges unless the pane's pool is avoided, CRITICAL skips nudges. */
  spend?(owner: string): Promise<{ mode: "NORMAL" | "LOW" | "CRITICAL"; avoid: string[]; refused?: string[] }>;
  /** C and D (plan clipboard:ZWJJdBgHm64Z): the open requests for the sweep, the operator's zone, and the In progress count to keep. */
  requests?: {
    zone(owner: string): Promise<string>;
    open(owner: string): Promise<SweepRequest[]>;
    /** Keeps the Requests tab's In progress count at the operator's 09:00 or 21:00 (once per day and slot, durable). */
    progress(owner: string, day: string, slot: "09:00" | "21:00"): Promise<void>;
  };
  /** 17/11 REVIEW (follow-up churn): the requests and plans (requestKey) and "utilization" an open dated follow-up holds (followups.ts datedHolds). */
  datedHolds?(owner: string): Promise<ReadonlySet<string>>;
  owners(): Promise<string[]>;
  collect(owner: string): Promise<PaneBoardSnapshot & { tasks: TaskItem[]; executions: Array<Pick<ManagedPlanExecution, "planId" | "paneId">>; summaries: NousPaneSummaryRow[];
    /** Live pane browsers and other recorded use (YouTube playback), by pane id. */
    browsers?: ReadonlyMap<string, CloseoutBrowser> | null; usedAt?: ReadonlyMap<string, string>; scheduled?: ReadonlySet<string> | null;
    /** Panes a prompt is still to reach (held or scheduled); null when the read failed. */
    prompts?: ReadonlySet<string> | null;
    /** Panes whose managed worktree has pending deliverables; null when the check failed. */
    pendingWorktrees?: ReadonlySet<string> | null }>;
  /** One pane's reports since a time (newest first is fine). */
  reportsSince(owner: string, paneId: string, since: string): Promise<PaneReport[]>;
  /** The plan map (plan-map.ts): a plan held on a date, another plan or the server is never nudged; the tick also fires its hold alerts. */
  planMap?(owner: string, plans: ClipboardItem[]): Promise<PlanMap>;
  /** The plans parked now, open and closed (operator 13/11 nous_msg:4080b166): their NOUS and AGENT conditions are Nous's to do. */
  parked?(owner: string): Promise<ClipboardItem[]>;
  lastAnswer?(pane: Pane): Promise<string | null>;
  /** The id of a Space Memory save since `since` whose provenance names this pane, or null (plan u78xLyqRp6kD). */
  paneSaves?(paneId: string, since: string, names?: { pane: string; room: string }): Promise<string | null>;
  /** The answer of the pane's own completed save turn ended at or after `since` ("" when silent), null when none ran. */
  saveTurn?(pane: Pane, since: string): Promise<string | null>;
  /** Closes a finished pane whose save Space verified; without it each close costs Nous a STANDING turn (plan qH5emwVaV6yO). */
  closePane?(owner: string, roomId: string, paneId: string): Promise<boolean>;
  /** Plan clipboard:CTVaL1V3kAFM step 8: whether the pane's turn runs now, read right before closePane (the tick's snapshot is older). */
  paneWorking?(pane: Pane): Promise<boolean>;
  /** Space's own Space Memory save for a pane that cannot run one (its pool has no room); the memory id. */
  saveMemory?(owner: string, title: string, body: string): Promise<string>;
  /** The pane's newest own work report (space_close_pane's open-work guard reads the same one); null when none. */
  lastWorkReport?(owner: string, paneId: string): Promise<{ status: string; at: string; summary: string } | null>;
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
  utilizationLow?(owner: string, runnablePlans: number, freed?: boolean): Promise<string | null>;
  /** Sends a text to a pane as Space through Nous's space_send_to_pane and its guards; true when it went. */
  dispatch?(owner: string, roomId: string, paneId: string, text: string): Promise<boolean>;
  /** Runnable work no plan or pane holds (the daily-improvement queue's OPEN fixes), each under a stable key and as the text a pane gets. */
  backlog?(owner: string): Promise<Array<{ key: string; text: string; strong?: boolean }>>;
  /** Where the backlog hand-outs (owner + key → pane) outlive an API restart; in memory only without it. */
  givenStore?: { read(): Promise<Record<string, string>>; write(entries: Record<string, string>): Promise<void> };
  /** The hygiene sweep pieces after the backlog (utilization.ts sweepPieces of the API's checkout by default). */
  sweep?(): Array<{ key: string; text: string }>;
  /** Where clean sweep marks (owner + sweep key → { at, head }) outlive an API restart; in memory only without it. */
  cleanSweepStore?: { read(): Promise<Record<string, CleanSweepMark>>; write(entries: Record<string, CleanSweepMark>): Promise<void> };
  /** Current dev HEAD and files changed between two heads, so a clean sweep area re-opens as soon as dev touches it. */
  sweepGit?: { head(): Promise<string | null>; changed(fromHead: string, toHead: string): Promise<string[] | null> };
  /** Opens a new Antigravity Gemini 4 Neon CLI pane titled NOUS_SWEEP_PANE_TITLE in a room with free slots for a sweep; null when none opened. */
  openSweepPane?(owner: string): Promise<{ roomId: string; paneId: string } | null>;
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
/** Goal 5acd171d (24/11: 1,075/1,184 sweeps = 91% were "nothing to fix", 213.6M tokens / $87.5/day): skip clean areas until dev touches them or 24 h. */
export const SWEEP_CLEAN_TTL_MS = 24 * 60 * MINUTE;
/** A clean mark; with `pane` it is instead a sweep handed to that pane at `at` and not settled yet (kept so an API restart does not lose it). */
export interface CleanSweepMark { at: number; head: string | null; pane?: string }
/** A sweep that stopped on its provider or names a merge-queue ticket did not prove its area clean. */
const SWEEP_NOT_CLEAN = /\b(?:503|429|unavailable|rate[ -]?limit(?:ed)?|usage limit|quota (?:exceeded|exhausted)|resource[ _]?exhausted|overloaded|no accounts?)\b|q-\d{8}-|όριο|σταμάτησε λόγω/i;
/** A sweep's DONE without a ticket is clean unless it names a provider error or limit. */
export const isCleanSweepReport = (report: Pick<PaneReport, "status" | "summary" | "ticket">): boolean =>
  report.status === "DONE" && !report.ticket && !SWEEP_NOT_CLEAN.test(report.summary);

/** Git reader for clean-sweep invalidation: tracks refs/heads/dev (fallback origin/dev, HEAD) and lists files changed between two commits. */
export function createSweepGit(root: string): NonNullable<StandingOrdersDeps["sweepGit"]> {
  return {
    async head() {
      for (const ref of ["refs/heads/dev", "refs/remotes/origin/dev", "HEAD"]) {
        const out = await execGit(root, ["rev-parse", "--verify", ref], 3_000);
        if (out.code === 0 && out.stdout.trim()) return out.stdout.trim();
      }
      return null;
    },
    async changed(fromHead, toHead) {
      if (fromHead === toHead) return [];
      const out = await execGit(root, ["diff", "--name-only", `${fromHead}..${toHead}`], 5_000);
      return out.code === 0 ? out.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : null;
    }
  };
}
const where = (input: BoardPaneInput) => `${input.room.name}/${paneLabel(input.pane)}`;

export function createStandingOrders(deps: StandingOrdersDeps) {
  const now = deps.now ?? Date.now;
  const running = new Set<string>();
  const lastTick = new Map<string, number>();
  /** The one reading of "the save covers the pane's last work" for the tick, the close and the save guards (plan CTVaL1V3kAFM step 3). */
  const askAt = (row: NousPaneCloseout) => Date.parse(row.retriedAt ?? row.requestedAt);
  const standing = (row: NousPaneCloseout | null | undefined) => row && row.state !== "CLOSED" && lastPromptAt(row.paneId) <= askAt(row) ? row : undefined;
  const covers = (row: NousPaneCloseout | null | undefined, since: string | null) =>
    Boolean(row && standing(row)?.state === "VERIFIED" && (since === null || Date.parse(row.updatedAt) >= Date.parse(since)));
  /** Proof the pane saved since its first ask (memory save, report or save turn), unless it began new work before the latest ask; null when none. */
  const savedSince = async (owner: string, paneId: string, askedAt: string, pane?: Pane, lastAsk = askedAt, room?: string, unasked = false): Promise<string | null> => {
    const reports = await deps.reportsSince(owner, paneId, askedAt).catch(() => []);
    // shortcut: an own save followed by work that filed no started or progress report still counts; read the pane's turn ends too if one turns up.
    const work = unasked ? reports.filter((report) => report.status === "STARTED" || report.status === "PROGRESS").map((report) => Date.parse(report.at))
      : [lastPromptAt(paneId), ...reports.filter((report) => report.status === "STARTED").map((report) => Date.parse(report.at))].filter((at) => at < Date.parse(lastAsk));
    const since = new Date(Math.max(Date.parse(askedAt), ...work)).toISOString();
    const stamped = deps.paneSaves ? await deps.paneSaves(paneId, since, pane && room ? { pane: paneLabel(pane), room } : undefined).catch(() => null) : null;
    if (stamped) return stamped;
    const answer = pane && deps.lastAnswer && reports.some((report) => report.at >= since) ? await deps.lastAnswer(pane).catch(() => null) : null;
    const id = verifyMemorySave(reports, since, answer);
    // 27/11: a seconds-long save turn the monitor missed files no report; the pane's transcript shows it ran to its end.
    if (id || !pane || !deps.saveTurn) return id;
    const turn = await deps.saveTurn(pane, since).catch(() => null);
    return turn === null ? null : MEMORY_ID.exec(turn)?.[0] ?? "saved";
  };
  /** Verifies a finished pane's save now instead of next tick; an unasked pane counts when it saved after its last prompt (plan u78xLyqRp6kD). */
  const verifyNow = async (owner: string, input: BoardPaneInput, row: NousPaneCloseout | undefined, since: string | null): Promise<NousPaneCloseout | undefined> => {
    if (!savesToMemory(input.pane) || input.state === "working" || input.state === "waiting" || since === null) return row;
    const asked = standing(row);
    if (covers(asked, since)) return row;
    // An open ask is verified from the ask; otherwise the pane's own save counts from its last work prompt, or from when it finished.
    const unasked = !asked || asked.state === "VERIFIED";
    const prompted = lastPromptAt(input.pane.id);
    const from = !unasked ? Date.parse(asked.requestedAt) : asked || !Number.isFinite(prompted) ? Date.parse(since) : prompted;
    const id = await savedSince(owner, input.pane.id, new Date(from).toISOString(), input.pane, unasked ? undefined : asked.retriedAt ?? undefined, input.room.name, unasked);
    if (!id) return row;
    const stamp = new Date(now()).toISOString();
    const next: NousPaneCloseout = asked ? { ...asked, state: "VERIFIED", verifiedMemoryId: id, reason: null, updatedAt: stamp }
      : { paneId: input.pane.id, roomId: input.room.id, state: "VERIFIED", requestedAt: stamp, retriedAt: null, verifiedMemoryId: id, closedAt: null, reason: null, updatedAt: stamp };
    await deps.closeouts.save(owner, next);
    return next;
  };
  const lastRound = new Map<string, number>();
  /** R13-9: the pendings slot ("YYYY-MM-DD HH:MM" local) each owner's list was last handled for. */
  const pendingsSlot = new Map<string, string>();
  /** At each pendings time in the operator's day, one STANDING turn lists what waits for them; nothing waiting or a list under 3 h old brings none (goal ab5f85bd). */
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
  /** owner + pane → when its finish last made the push urgent (one urgent push per pane per PUSH_MS). */
  const urgentAt = new Map<string, number>();
  // shortcut: in memory, so after an API restart a pane that ended with the same step open gets it once more; a plan mark if repeats show.
  const dispatched = new Map<string, string>();
  /** owner + backlog piece key → the pane Space handed it to (the push's free-pane hand-out). */
  const given = new Map<string, string>();
  // shortcut: read at the standing tick (tickMinutes, at once after a pane's report), so a question asked or answered shows up to one tick late; read it per Load minute if that lag shows.
  const parkedBy = new Map<string, ReadonlySet<string>>();
  let givenLoaded = false;
  /** owner + sweep key → when it was last handed out: the least recently swept area goes first. */
  const sweptAt = new Map<string, number>();
  /** owner + sweep key → when it last reported "nothing to fix" and at which dev HEAD. */
  const cleanSweeps = new Map<string, CleanSweepMark>();
  let cleanSweepsLoaded = false;
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
    // A FAILED or STOPPED REVIEW is no review: the next tick asks again, at most 3 such rows a day.
    const today = facts.filter((turn) => turn.reason === "REVIEW" && localDayHour(Date.parse(turn.startedAt), zone).day === local.day);
    // A TIMEOUT counts as the day's review only when it wrote findings; else it is retried under the same cap.
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

  /** By day every 30 min the open requests come with their pane's state and evidence; any not visibly moving is a hold-A item (plan ZWJJdBgHm64Z). */
  // 17/11 REVIEW (16/11: a follow-up rewritten ×22 while it waited on the operator until 09:07 BKK): what an open dated follow-up holds is no push item.
  const heldBy = async (owner: string) => {
    const holds = deps.datedHolds ? await deps.datedHolds(owner).catch(() => new Set<string>()) : new Set<string>();
    return (...ids: Array<string | null | undefined>) => ids.some((id) => id && holds.has(id === "utilization" ? id : requestKey(id)));
  };
  async function requestsSweep(owner: string, at: number): Promise<{ text: string; items: NousTurnItem[]; state: string } | null> {
    if (!deps.requests) return null;
    const local = localDayHour(at, await deps.requests.zone(owner).catch(() => "UTC"));
    const slot = local.hour >= 21 ? "21:00" : local.hour >= 9 ? "09:00" : null;
    if (slot && progressKept.get(owner) !== `${local.day} ${slot}`) {
      progressKept.set(owner, `${local.day} ${slot}`);
      await deps.requests.progress(owner, local.day, slot).catch((error) => warn({ err: error, owner }, "Nous In progress count failed."));
    }
    if (local.hour < SWEEP_HOURS.from || local.hour >= SWEEP_HOURS.to || at - (lastSweep.get(owner) ?? 0) < SWEEP_MS) return null;
    // 21/11 REVIEW (521 INBOX turns/$168: closed-pane requests came back every 8 h): one request-done already told durably (paneGone) is not swept again.
    const open = (await deps.requests.open(owner)).filter((request) => !(request.pane && !request.paneName && request.goneTold));
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
    const held = await heldBy(owner);
    const items: NousTurnItem[] = rows.filter(({ request }) => (request.paneState !== "working" || request.evidence) && (request.evidence || !held(request.messageId, request.plan))).map(({ request, line }) => ({
      key: `request:${request.key}`, kind: "REQUEST", line, shape: requestShape(request), requestKey: request.key, ...(request.evidence ? { finished: true } : {}), ...(request.messageId ? { messageId: request.messageId } : {}),
      ...(request.plan ? { plan: request.plan } : {}), ...(request.pane ? { pane: request.pane } : {}), ...(request.paneName ? { paneName: request.paneName } : {}) }));
    return { items, state, text: [`## Open requests (requests sweep by day when one changes, unchanged every 8 hours; operator 31/10 22:19 BKK: they move on your own, not only when he asks)`,
      "Each one now, one at a time: checked finished in this turn on its real surface (its evidence, its report, its ticket live where he uses it) → Done with what that check showed "
        + "(space_request_done, or space_open_requests close of that one with verified); its pane idle, waiting, closed or gone → send its next step to a pane naming it (a new pane when its own is busy 3+ min) or record what it waits on "
        + "(space_plan_update waitsOn, space_pane_checked WAITING_*); working → nothing unless its report says it is stuck.",
      ...rows.map(({ line }) => line)].join("\n") };
  }

  function sampleSince(snapshot: Awaited<ReturnType<StandingOrdersDeps["collect"]>> | null, paneId: string): string | null {
    for (const { sample } of snapshot?.rooms ?? []) { const detail = sample?.details[paneId]; if (detail) return detail.since ?? null; }
    return null;
  }
  function closeoutContext(snapshot: Awaited<ReturnType<StandingOrdersDeps["collect"]>>, orders: NousSettings["standingOrders"], at: number, rows: ReadonlyMap<string, NousPaneCloseout>): CloseoutContext {
    const since = (paneId: string) => sampleSince(snapshot, paneId);
    // The save request's own text is typed just before its row is stamped: only a prompt after it is new work.
    const promptedAt = (paneId: string) => standing(rows.get(paneId)) ? -Infinity : lastPromptAt(paneId);
    return { since, tasks: snapshot.tasks, executions: snapshot.executions, summaries: snapshot.summaries, now: at, finishedAfterMs: orders.finishedAfterMinutes * MINUTE, closeOperatorPanes: orders.closeOperatorPanes, plans: snapshot.plans, operatorPromptedLast, operatorPane: (pane) => operatorPaneReason(pane, at), promptedAt,
      ...(snapshot.browsers !== undefined ? { browsers: snapshot.browsers } : {}), ...(snapshot.usedAt ? { usedAt: snapshot.usedAt } : {}), ...(snapshot.scheduled !== undefined ? { scheduled: snapshot.scheduled } : {}),
      ...(snapshot.prompts !== undefined ? { prompts: snapshot.prompts } : {}),
      ...(snapshot.pendingWorktrees !== undefined ? { pendingWorktrees: snapshot.pendingWorktrees } : {}) };
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
    parkedBy.set(owner, new Set(panes.filter((input) => parkedPane(input, ctx)).map((input) => input.pane.id)));
    // A listed pane's browser with many tabs: the finished ones close (browser hygiene); a pane without a CLI closes them with itself.
    const planNote = (input: BoardPaneInput) => { const what = planWaitsFor(input, ctx)
      ?? (input.plan && input.plan.progressPercentage < 100 && !openPlanStep(input.plan) && input.plan.steps.some((step) => step.status === "BLOCKED") ? "what its BLOCKED steps name" : null); return what ? ` · plan step waits for ${what}: its task or you reopen the pane when the work continues` : ""; };
    const tabs = (input: BoardPaneInput) => {
      const count = snapshot.browsers?.get(input.pane.id)?.tabs ?? 0;
      return count > NOUS_TABS_SHOWN_ABOVE ? ` · browser: ${count} tabs${savesToMemory(input.pane) ? " (kept open: have it close the finished ones, browser hygiene)" : " (they close with it)"}` : "";
    };
    const save = async (row: NousPaneCloseout) => { rows.set(row.paneId, row); await deps.closeouts.save(owner, row); };
    const stamp = new Date(at).toISOString();
    // Space's own close reads the pane again first: a new prompt or running turn keeps it for the next tick (plan CTVaL1V3kAFM step 8).
    const changed = async (input: BoardPaneInput): Promise<boolean> => lastPromptAt(input.pane.id) >= at || (await deps.paneWorking?.(input.pane).catch(() => true) ?? false);

    // Rows in flight: a pane that is gone was closed elsewhere; a save asked long enough ago is verified from the pane's reports.
    for (const row of [...rows.values()]) {
      if (row.state === "CLOSED") continue;
      const input = panes.find((entry) => entry.pane.id === row.paneId);
      if (!input) {
        // A room whose activity could not be read hides its panes for this tick only: they are not closed.
        if (snapshot.rooms.some(({ room, sample }) => room.id === row.roomId && !sample)) continue;
        await save({ ...row, state: "CLOSED", closedAt: stamp, reason: "closed elsewhere", updatedAt: stamp }); continue;
      }
      // An ask a later work prompt voided is not verified: a save from before that prompt would close the pane on unsaved work.
      if (input.state === "working" || input.state === "waiting" || row.state === "VERIFIED" || !standing(row)) continue;
      const askedAt = row.retriedAt ?? row.requestedAt;
      if (at - Date.parse(askedAt) < SETTLE_MS) continue;
      const id = await savedSince(owner, row.paneId, row.requestedAt, input.pane, askedAt, input.room.name);
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
        + ` → ${CLOSEOUT_NEXT["card-check"]}`, cardLines);
    }
    const poolOf = (paneId: string | null) => {
      for (const { sample } of snapshot.rooms) { const pane = sample?.data.find((entry) => entry.id === paneId); if (pane) {
        // 22/11: a gemini-CLI pane on claude-opus-5-5 draws on Antigravity's Claude pool, not Gemini's (the pool noRoomGuard and wiring read).
        return quotaPool(pane.terminalRuntimeId, (pane.terminalRuntimeId === "cli:gemini" ? sample!.details[pane.id]?.modelId : null) ?? pane.modelId);
      } }
      return null;
    };
    if (orders.closeFinishedPanes) {
      for (const input of panes) {
        const skip = closeoutSkipReason(input, ctx);
        if (skip === "card-check") continue;
        const task = keptOpenForTask(input.pane.id, snapshot.tasks);
        if (skip === "task") continue;
        const stored = rows.get(input.pane.id);
        const paneSince = closeoutSince(input, ctx);
        if (skip && skip !== "fresh" && skip !== "board-check") continue;
        // Plan clipboard:u78xLyqRp6kD: a finished pane that saved on its own since its last prompt is not asked to save again.
        const asked = standing(stored);
        const row = skip === null && (!asked || asked.state === "VERIFIED") ? await verifyNow(owner, input, stored, paneSince) : stored;
        if (row) rows.set(row.paneId, row);
        // In flight: an open ask, or a save that covers the pane's last work; a save or an ask the pane worked past asks a new one below.
        const live = standing(row);
        const inFlight = live && (live.state !== "VERIFIED" || covers(live, paneSince)) ? live : undefined;
        const idle = `${input.state} ${durationText(at - Date.parse(paneSince!))}${tabs(input)}`;
        // A pane whose newest report is not done/failed has open work: its line asks for the act that passes, and Space never closes it itself.
        const last = savesToMemory(input.pane) && (skip !== "fresh" || inFlight) && deps.lastWorkReport ? await deps.lastWorkReport(owner, input.pane.id).catch(() => null) : null;
        if (last && workOpen(last, input.report, paneSince, at)) {
          list(input, `open:${last.at}`, `- ${where(input)} · ${idle} · last reported ${last.status.toLowerCase()} at ${hhmm(last.at)} ("${last.summary.replace(/\s+/g, " ")}"), no done or failed report since: `
            + `its work is open, so no save or close until it reports done or failed, or sits unmoved ${STALE_WAIT_MS / MINUTE} min after a waiting, needs-decision or blocked report or its turn's end`
            + " → send its next step (space_send_to_pane), or record its wait (space_pane_checked WAITING_OPERATOR, WAITING_DATE or BLOCKED with nextCheckInMinutes)");
          continue;
        }
        // A finished CLI pane on a pool with no room cannot save, so Space saves its reports to Space Memory and closes it.
        const pool = poolOf(input.pane.id);
        if (!skip && input.pane.mode === "TERMINAL" && pool && spend?.refused?.includes(pool) && inFlight?.state !== "VERIFIED" && deps.saveMemory && deps.closePane
          && (!row?.closedAt || row.closedAt < paneSince!)) {
          const reports = await deps.reportsSince(owner, input.pane.id, "").catch(() => []);
          const body = [`Room "${input.room.name}" pane ${paneLabel(input.pane)} (${input.pane.title}) finished; its ${pool} pool had no room, so Space saved this and closed it.`,
            ...(input.pane.cwd ? [`Working directory: ${input.pane.cwd}`] : []), ...reports.map((report) => `- ${report.at} ${report.status}: ${report.summary.replace(/\s+/g, " ")}`)].join("\n");
          const id = await deps.saveMemory(owner, `${paneLabel(input.pane)} closed by Space: ${pool} had no room`.slice(0, 160), body).catch(() => null);
          if (id) {
            const base: NousPaneCloseout = { paneId: input.pane.id, roomId: input.room.id, state: "VERIFIED", requestedAt: stamp, retriedAt: null, verifiedMemoryId: id, closedAt: null, reason: null, updatedAt: stamp };
            await save(base);
            if (!(await changed(input)) && await deps.closePane(owner, input.room.id, input.pane.id).catch(() => false)) {
              await save({ ...base, state: "CLOSED", closedAt: stamp, reason: `saved and closed by Space: its ${pool} pool had no room` });
              listed.delete(`${owner}\u0000${input.pane.id}`);
            }
            continue;
          }
        }
        if (inFlight) {
          // A save verified after the pane last worked, nothing else keeping it: Space closes it without a Nous turn.
          if (inFlight.state === "VERIFIED" && deps.closePane && await changed(input)) continue;
          if (inFlight.state === "VERIFIED" && deps.closePane && await deps.closePane(owner, input.room.id, input.pane.id).catch(() => false)) {
            await save({ ...inFlight, state: "CLOSED", closedAt: stamp, reason: "closed by Space after its memory save", updatedAt: stamp });
            listed.delete(`${owner}\u0000${input.pane.id}`);
          } else if (inFlight.state === "VERIFIED") list(input, `verified:${inFlight.verifiedMemoryId}`, `- ${where(input)} · ${idle} · save asked ${hhmm(inFlight.requestedAt)}, verified ${inFlight.verifiedMemoryId} → close it now (space_close_pane)`);
          else {
            const askedAt = inFlight.retriedAt ?? inFlight.requestedAt;
            const waited = at - Date.parse(askedAt);
            if (waited >= NOUS_SAVE_WAIT_MS) list(input, `decide:${askedAt}`, `- ${where(input)} · ${idle} · save asked ${hhmm(askedAt)}, not verified after ${Math.round(waited / MINUTE)} min → read its reports (space_pane_reports); `
              + `${inFlight.state === "SAVE_REQUESTED" ? `ask once more with exactly "${NOUS_SAVE_RETRY_TEXT}"` : `asked twice and space_close_pane refuses it unverified: its work finished, ${NOUS_SAVE_YOURSELF} (space_close_pane)`}, or record KEEP_OPEN with the reason and the next check`);
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
          // Step 3: a save, or an ask, from before the pane's last work covers nothing: the line asks a new save, never "close it now".
          const older = !row || row.state === "CLOSED" ? null
            : row.state === "VERIFIED" ? `worked after its save ${row.verifiedMemoryId} (${hhmm(row.updatedAt)})` : `worked after its save was asked (${hhmm(row.retriedAt ?? row.requestedAt)})`;
          list(input, older ? `stale:${row!.updatedAt}` : "ask", `- ${where(input)} · ${idle}${input.pane.mode === "TERMINAL" ? "" : ` · ${input.pane.mode} pane: close it only when its copilot has nothing scheduled`}`
            + `${task ? ` · task "${task.title}": Space reopens the pane when it runs` : ""}${planNote(input)} · ${older ? `${older}, not saved since` : "save not asked yet"} → send it exactly "${NOUS_SAVE_TEXT}" (space_send_to_pane, when now)`);
        }
      }
    }

    // Stalled plans: one nudge per plan per stalled window; PAUSED or OFF leave the mark, so the next tick tries again.
    const map = deps.planMap ? await deps.planMap(owner, snapshot.plans).catch((error) => { warn({ err: error, owner }, "Nous plan map failed."); return null; }) : null;
    // Only CRITICAL (or LOW without pool advice) skips the nudges; LOW leaves out plans whose pane runs on an avoided pool.
    const nudging = !conserving || spend?.mode === "LOW";
    const activity = !nudging ? [] : await nousPlanActivity({ owner, plans: snapshot.plans, samples: snapshot.rooms, marks: deps.marks, reports: snapshot.reports, executions: snapshot.executions,
      ...(map ? { held: (planId: string) => stalledHold(map, planId), hardHold: map.holds.some((hold) => HARD_HOLDS.has(hold.kind)) } : {}), stalledHours: orders.stalledAfterHours, now: new Date(at) })
      .catch((error) => { warn({ err: error, owner }, "Nous plan activity failed."); return []; });
    const paneOf = (planId: string) => snapshot.plans.find((plan) => plan.id === planId)?.paneId ?? null;
    const avoided = (planId: string) => spend?.mode === "LOW" && spend.avoid.includes(poolOf(paneOf(planId)) ?? "\u0000");
    // A pane whose pool has no room refuses work, so its plan or request goes to a free pane with room (nous_msg:d2faedf0).
    const noRoom = (paneId: string | null | undefined) => Boolean(paneId && spend?.refused?.includes(poolOf(paneId) ?? "\u0000"));
    const due = activity.filter((item) => item.stalled && (!item.lastNudgedAt || at - Date.parse(item.lastNudgedAt) >= Math.max(orders.stalledAfterHours * 3_600_000, UNCHANGED_MS)) && !avoided(item.planId));
    // Hold A: each stalled plan is an item the turn must act on (Space does not take its NOTHING_NEW while one has no act).
    const planItems: NousTurnItem[] = due.map((item) => ({ key: `plan:${item.planId}`, kind: "PLAN", plan: item.planId, ...(paneOf(item.planId) ? { pane: paneOf(item.planId)! } : {}),
      ...(item.pane ? { paneName: item.pane.label } : {}), line: `Stalled plan [${item.planId}] "${item.title.replace(/\s+/g, " ")}" ${item.percent}%, unchanged ${durationText(item.hours * 3_600_000)}: one concrete action now (a next step to its pane, or its wait recorded).` }));
    // A parked plan whose NOUS/AGENT condition is open and stalled is a hold-A item: do it or record it MET (nous_msg:4080b166).
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
    // A recurring agent task with no pane or room only reminds: listed when a turn runs, never a reason for one.
    const paneless = snapshot.tasks.filter((task) => task.source === "AGENT" && task.schedule && task.schedule.recurrence.kind !== "ONCE" && !task.paneId && !task.roomId);
    // `soon` flushes the batch so a done/failed report reaches Nous within a minute (plan CDbnZ7FSj-ww item 7).
    for (const line of lines) await deps.notice?.(owner, `${NOUS_FINISHED_KEY}${line.paneId}`, `Finished pane ${line.text.replace(/^- /, "")}`, undefined, true);
    // Goal 5acd171d (22/11: ~27 sweeps/day, ~85k tokens each): a sweep with no item (every request working or held) is swept, never a turn of its own.
    if (sweep && !sweep.items.length) { lastSweep.set(owner, at); sweptState.set(owner, { state: sweep.state, at }); }
    if (cardLines.length || due.length || parkedItems.length || sweep?.items.length || stuck.length) {
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
      // A turn that did not start is no listing; the inbox lists again only the panes this turn listed.
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
    // Push: while utilization is under 90 %, calm and CLI panes have room, one line carries every runnable item until dispatched or its wait recorded; a newly finished pane is pushed at once.
    const pushedAt = lastUtilization.get(owner) ?? 0;
    const finishedTasks = snapshot.tasks.filter((task) => task.paneId && !task.schedule?.nextRunAt && (task.status === "RUNNING" || Boolean(task.schedule?.lastRunAt)))
      .flatMap((task) => { const input = panes.find((entry) => entry.pane.id === task.paneId); return input && savesToMemory(input.pane) && (input.state === "done" || input.state === "idle") && !questionOpen(input, ctx) ? [{ task, input }] : []; });
    const finishedSince = (since: string | null | undefined) => Boolean(since) && Date.parse(since!) > pushedAt;
    // A CLI pane done or idle since the last push with no plan is free capacity; one closing (until a new prompt or its save wait expires) gets no work.
    const closing = (paneId: string | null) => {
      const row = paneId ? rows.get(paneId) : undefined;
      if (row && row.state !== "CLOSED") return (ctx.promptedAt?.(paneId!) ?? -Infinity) === -Infinity && at - Date.parse(row.retriedAt ?? row.requestedAt) < NOUS_SAVE_WAIT_MS;
      const input = row && panes.find((entry) => entry.pane.id === paneId);
      const since = input ? closeoutSince(input, ctx) : null;
      return Boolean(row?.closedAt && (!since || row.closedAt >= since));
    };
    // The free-pane hand-out takes plain CLI panes only; copilot panes refused goal pieces.
    const freed = panes.filter((input) => input.pane.mode === "TERMINAL" && savesToMemory(input.pane) && (input.state === "done" || input.state === "idle") && finishedSince(closeoutSince(input, ctx))
      && !snapshot.plans.some((plan) => plan.paneId === input.pane.id) && !closing(input.pane.id));
    // A pane's finish makes the push urgent at most once per PUSH_MS, so no pane drives more than one INBOX turn in 10 minutes.
    const finishers = [...freed.map((input) => input.pane.id), ...activity.filter((item) => item.ready && !avoided(item.planId) && finishedSince(item.pane?.since)).map((item) => paneOf(item.planId) ?? item.planId)]
      .filter((id) => at - (urgentAt.get(`${owner}\u0000${id}`) ?? -Infinity) >= PUSH_MS);
    const newlyFinished = finishers.length > 0;
    if (deps.utilizationLow && deps.notice && (at - pushedAt >= PUSH_MS - MINUTE || newlyFinished)) {
      // A plan whose whole-plan wait is on someone still runs its other steps (stalled-plans.ts); one whose waiting steps are all BLOCKED does not.
      const asking = (paneId: string | null) => { const input = paneId ? panes.find((entry) => entry.pane.id === paneId) : undefined; return Boolean(input && questionOpen(input, ctx)); };
      const work = activity.filter((item) => (item.stalled || item.ready) && item.openStep && item.pane?.state !== "working" && !avoided(item.planId) && !closing(paneOf(item.planId)) && !asking(paneOf(item.planId)));
      // 21/11: runnable plans only; the count of open plans said "23 open plans" while all 23 were parked and nothing could run.
      const line = await deps.utilizationLow(owner, work.length, newlyFinished).catch(() => null);
      const runnable = line ? work : [];
      const roomOf = (planId: string) => { const roomId = snapshot.plans.find((plan) => plan.id === planId)?.roomId; return snapshot.rooms.find(({ room }) => room.id === roomId)?.room.name ?? null; };
      const planItem = (item: (typeof runnable)[number]): NousTurnItem => ({ key: `plan:${item.planId}`, kind: "PLAN", plan: item.planId, ...(paneOf(item.planId) ? { pane: paneOf(item.planId)! } : {}),
        ...(item.pane ? { paneName: item.pane.label } : {}), line: `Plan [${item.planId}] "${item.title.replace(/\s+/g, " ")}" ${item.percent}% · ${item.pane ? `${item.pane.label} ${item.pane.state ?? "state unknown"}`
          : `no open pane${roomOf(item.planId) ? ` (room ${roomOf(item.planId)})` : ""}`} · next: ${item.openStep!.replace(/\s+/g, " ")}${item.hold ? ` · plan ${item.hold.replace(/\s+/g, " ")}` : ""}`
          + `: ${item.pane && !noRoom(paneOf(item.planId)) ? `send it to ${item.pane.label} now (space_send_to_pane naming the plan)` : `${item.pane ? `${item.pane.label}'s pool has no room now; ` : ""}open a pane for it now at the plan's minimum model (space_open_panes) and send it "Implement the following plan. Plan ID: ${item.planId}"`}, or mark the steps that wait BLOCKED.` });
      const held = await heldBy(owner);
      const unpaned = runnable.filter((item) => (!item.pane || noRoom(paneOf(item.planId))) && !held(item.planId)).map(planItem);
      // A ready plan with no recorded wait gets its next step from Space at once, once per pane; `line` is the gate (under target, calm, not CRITICAL, pool not avoided).
      const sent: Array<(typeof runnable)[number]> = [];
      for (const item of runnable) {
        const paneId = paneOf(item.planId);
        const roomId = snapshot.rooms.find(({ sample }) => sample?.data.some((entry) => entry.id === paneId))?.room.id;
        const key = `${owner}\u0000${paneId}`;
        if (!deps.dispatch || !item.ready || item.hold || !paneId || !roomId || noRoom(paneId) || dispatched.get(key) === item.openStep) continue;
        dispatched.set(key, item.openStep!);
        if (await deps.dispatch(owner, roomId, paneId, `Continue plan ${item.planId} "${item.title.replace(/\s+/g, " ")}": its next step is ${item.openStep}. `
          + "Do it now, update the plan's steps and progress, and report when it is done.").catch(() => false)) sent.push(item);
      }
      const idle = runnable.filter((item) => item.pane && !noRoom(paneOf(item.planId)) && !sent.includes(item) && !held(item.planId)).map(planItem);
      // One item per pane: a pane that already has its plan's next step gets no task item.
      const taskPanes = new Set([...idle.map((item) => item.pane), ...sent.map((item) => paneOf(item.planId))]);
      const taskItems: NousTurnItem[] = !line ? [] : finishedTasks.filter(({ task }) => !taskPanes.has(task.paneId!) && taskPanes.add(task.paneId!)).map(({ task, input }) => ({ key: `task:${task.id}`, kind: "PLAN",
        pane: input.pane.id, paneName: paneLabel(input.pane), refs: [task.id], line: `Task [${task.id}] "${task.title.replace(/\s+/g, " ")}" · ${where(input)} ${input.state}, nothing scheduled next`
          + `: finished → mark it DONE (space_task_update); else send ${paneLabel(input.pane)} its next step now (space_send_to_pane naming the task).` }));
      const openRequests = line && deps.requests ? await deps.requests.open(owner).catch(() => [] as SweepRequest[]) : [];
      const requests = openRequests
        .filter((request) => request.paneState !== "working" && at - Date.parse(request.paneSince ?? request.openedAt) >= PUSH_REQUEST_IDLE_MS && !held(request.messageId, request.plan)
          // A request whose pane is closed or gone is request-done's own "lost its pane" line, never also a push item.
          && !(request.pane && !request.paneName));
      const requestItems: NousTurnItem[] = requests.map((request) => ({ key: `request:${request.key}`, kind: "REQUEST", shape: requestShape(request), requestKey: request.key, ...(request.messageId ? { messageId: request.messageId } : {}),
        ...(request.plan ? { plan: request.plan } : {}), ...(request.pane ? { pane: request.pane } : {}), ...(request.paneName ? { paneName: request.paneName } : {}),
        line: `[${request.messageId ?? request.key}] «${quote(request.words)}» · open ${durationText(Math.max(0, at - Date.parse(request.openedAt)))}${request.plan ? ` · ${request.plan}` : ""}`
          + ` · ${request.paneName ? `${request.paneName} ${request.paneState ?? "state unknown"}${request.paneSince ? ` since ${hhmm(request.paneSince)}` : ""}` : request.pane ? `${request.pane} closed or gone` : "no pane"}`
          + `${request.pane && noRoom(request.pane) ? " · its pane's pool has no room now" : ""}`
          + `: finished → Done (space_request_done); else send its next step to a pane naming it (a new pane when its own is gone${request.pane && noRoom(request.pane) ? " or its pool has no room: a free pane with room" : ""}).` }));
      const section = (title: string, items: NousTurnItem[]) => items.length ? [`${title}:`, ...items.map((item) => `- ${item.line}`)] : [];
      // Every free CLI pane is an item on every push until it gets work, records its wait or closes.
      const shut = [...(spend?.mode === "LOW" ? spend.avoid : []), ...(spend?.refused ?? [])];
      const handOutSkip = (input: BoardPaneInput) => { const reason = closeoutSkipReason(input, ctx);
        if ((reason !== "awaits-operator" && reason !== "operator-pane") || ctx.now - Date.parse(closeoutSince(input, ctx) ?? "") < OPERATOR_TURN_GRACE_MS) return reason;
        // The operator's-pane guard (nous_msg:63896af5) relaxes here as above for the panes they prompted; a fresh pane they opened stays theirs.
        return closeoutSkipReason(input, { ...ctx, operatorPromptedLast: () => false, operatorPane: (pane) => operatorPaneReason(pane, ctx.now, true) }); };
      const freeInputs = !line ? [] : panes.filter((input) => input.pane.mode === "TERMINAL" && savesToMemory(input.pane) && (input.state === "done" || input.state === "idle") && !taskPanes.has(input.pane.id)
        // A pane whose own plan cannot run, whose board waits on a date or third party, or that holds only Nous's card is free capacity; one with an open question is not.
        && !openRequests.some((item) => item.pane === input.pane.id && !held(item.messageId, item.plan)) && !work.some((item) => paneOf(item.planId) === input.pane.id) && !questionOpen(input, ctx)
        // A task-bound pane behind a card gets no hand-out; its own blocked plan still leaves it free capacity.
        && !paneBoundToWork(input.pane.id, { tasks: snapshot.tasks, executions: snapshot.executions, pendingWorktrees: snapshot.pendingWorktrees })
        // The operator's pane is free capacity once its answer asks nothing and their turn's grace has passed.
        && [null, "fresh", "board-waits", "board-check", "card-check", "waiting-operator"].includes(handOutSkip(input)) && !closing(input.pane.id)
        // 21/11 04:18Z: three free Codex panes were listed while the send guard refused Codex new work, so the turn could not act on them.
        && !shut.includes(poolOf(input.pane.id) ?? "\u0000"));
      // Space hands each free CLI pane one runnable piece itself: an unpaned plan first (same room first), then a daily-improvement fix on a code model (nous_msg:719620b3).
      const strong = (model: string | null | undefined) => /opus|fable/i.test(model ?? "") || (shut.includes("claude") && /gemini-\d+-neon/i.test(model ?? ""));
      // A Flash pane never gets plans, goals or sweeps, since they change code (operator nous_msg:d5216579).
      const flash = (model: string | null | undefined) => /flash/i.test(model ?? "");
      // A plan with a minimum on any code model stays a code piece; strong() drops Neon once Claude has room (DEV3D-046).
      const codePlan = (model: string | null | undefined) => strong(model) || /astra|gemini-\d+-neon/i.test(model ?? "");
      // A plan or goal whose pane closed goes back to the hand-out; backlog lines persist through givenStore so a restart gives none twice.
      // shortcut: a goal stays with the pane that got it until that pane closes; re-hand it on a timer if done panes sit holding goals.
      // A sweep area is held only while its pane works on it, so sweeps cycle.
      const holds = (key: string) => { const paneId = given.get(`${owner}\u0000${key}`);
        return Boolean(paneId && (key.startsWith("sweep:") ? panes.some((input) => input.pane.id === paneId && input.state === "working")
          : !/^(plan|goal):/.test(key) || panes.some((input) => input.pane.id === paneId))); };
      const backlog = line && deps.dispatch && deps.backlog ? await deps.backlog(owner).catch(() => []) : [];
      if (backlog.length && deps.givenStore && !givenLoaded) {
        givenLoaded = true;
        for (const [key, paneId] of Object.entries(await deps.givenStore.read().catch(() => ({})))) if (!given.has(key)) given.set(key, paneId);
      }
      const rawSweeps = line && deps.dispatch ? deps.sweep?.() ?? sweepPieces(process.cwd()) : [];
      let cleanDirty = false;
      const dirtySweeps: Array<{ key: string; text: string }> = [];
      if (rawSweeps.length) {
        if (deps.cleanSweepStore && !cleanSweepsLoaded) {
          cleanSweepsLoaded = true;
          for (const [key, mark] of Object.entries(await deps.cleanSweepStore.read().catch(() => ({})))) {
            if (!mark || !Number.isFinite(mark.at)) continue;
            if (typeof mark.pane === "string") { if (!given.has(key)) { given.set(key, mark.pane); sweptAt.set(key, mark.at); } continue; }
            if (!cleanSweeps.has(key)) cleanSweeps.set(key, { at: mark.at, head: typeof mark.head === "string" ? mark.head : null });
          }
        }
        const sweepHead = deps.sweepGit ? await deps.sweepGit.head().catch(() => null) : null;
        const ownerPrefix = `${owner}\u0000sweep:`;
        for (const [ownerKey, paneId] of [...given.entries()]) {
          if (!ownerKey.startsWith(ownerPrefix)) continue;
          const sentAt = sweptAt.get(ownerKey) ?? 0;
          // A sweep is settled only by its DONE/FAILED, its pane closing, or 24 h.
          if (!panes.some((entry) => entry.pane.id === paneId) || at - sentAt >= SWEEP_CLEAN_TTL_MS) { given.delete(ownerKey); cleanDirty = true; continue; }
          if (panes.some((entry) => entry.pane.id === paneId && entry.state === "working")) continue;
          const since = new Date(sentAt).toISOString();
          let reports = sentAt ? await deps.reportsSince(owner, paneId, since).catch(() => []) : [];
          if (!reports.length) {
            const latest = panes.find((entry) => entry.pane.id === paneId)?.report;
            if (latest && latest.at >= since) reports = [latest];
          }
          const done = reports.filter((report) => report.status === "DONE");
          if (done.length && !done.some((report) => Boolean(report.ticket)) && done.some(isCleanSweepReport)) {
            cleanSweeps.set(ownerKey, { at, head: sweepHead });
            cleanDirty = true;
          }
          if (reports.some((report) => report.status === "DONE" || report.status === "FAILED")) { given.delete(ownerKey); cleanDirty = true; }
        }
        const changedCache = new Map<string, string[] | null>();
        for (const entry of rawSweeps) {
          const ownerKey = `${owner}\u0000${entry.key}`;
          const mark = cleanSweeps.get(ownerKey);
          if (!mark) { dirtySweeps.push(entry); continue; }
          if (at - mark.at >= SWEEP_CLEAN_TTL_MS) {
            cleanSweeps.delete(ownerKey);
            cleanDirty = true;
            dirtySweeps.push(entry);
            continue;
          }
          if (deps.sweepGit && mark.head && sweepHead && mark.head !== sweepHead) {
            let files = changedCache.get(mark.head);
            if (files === undefined) {
              files = await deps.sweepGit.changed(mark.head, sweepHead).catch(() => null);
              changedCache.set(mark.head, files);
            }
            if (files === null || sweepAreaTouched(entry.key, files)) {
              cleanSweeps.delete(ownerKey);
              cleanDirty = true;
              dirtySweeps.push(entry);
              continue;
            }
            mark.head = sweepHead;
            cleanDirty = true;
          }
        }
      }
      const pieces = [...unpaned.map((item) => { const found = snapshot.plans.find((entry) => entry.id === item.plan);
        return { key: item.key, roomId: found?.roomId ?? null, strong: codePlan(found?.minimumModel), text: `Implement the following plan. Plan ID: ${item.plan}` }; }),
        ...backlog.map((entry) => ({ ...entry, roomId: null, strong: entry.strong ?? true })),
        ...dirtySweeps.map((entry) => ({ ...entry, roomId: null, strong: true }))
          .sort((left, right) => (sweptAt.get(`${owner}\u0000${left.key}`) ?? 0) - (sweptAt.get(`${owner}\u0000${right.key}`) ?? 0))].filter((piece) => !holds(piece.key));
      const handed: Array<{ input: BoardPaneInput; key: string }> = [];
      let open = deps.dispatch ? freeInputs : [];
      const refused = new Set<BoardPaneInput>();
      let sweepOpened = false;
      for (const piece of pieces) {
        const sweeping = piece.key.startsWith("sweep:");
        // A piece any model can take goes to a non-strong pane first; sweeps go only to sweep panes and sweep panes take only sweeps.
        const fits = open.filter((input) => sweepPane(input.pane) === sweeping
          && (!sweeping || !paneBoundToWork(input.pane.id, { tasks: snapshot.tasks, plans: snapshot.plans, executions: snapshot.executions, requests: openRequests, pendingWorktrees: snapshot.pendingWorktrees }))
          && !flash(input.model)
          && (!piece.strong || strong(input.model) || (sweeping && /gemini-\d+-neon/i.test(input.model ?? ""))))
          .sort((left, right) => piece.strong ? 0 : Number(strong(left.model)) - Number(strong(right.model)));
        let input = fits.find((entry) => entry.room.id === piece.roomId) ?? fits[0];
        // No free sweep pane: Space opens one (Gemini Neon), one per push, never while Gemini is shut.
        if (!input && sweeping && !sweepOpened && deps.openSweepPane && !shut.includes("gemini")) {
          sweepOpened = true;
          const fresh = await deps.openSweepPane(owner).catch(() => null);
          const room = fresh && (snapshot.rooms.find((entry) => entry.room.id === fresh.roomId)?.room ?? { id: fresh.roomId, name: fresh.roomId } as BoardPaneInput["room"]);
          if (fresh && room) input = { room, pane: { id: fresh.paneId, roomId: room.id, title: NOUS_SWEEP_PANE_TITLE, titleSource: "manual", mode: "TERMINAL" } as Pane, state: "idle", model: "gemini-4-neon" } as BoardPaneInput;
        }
        if (!input) continue;
        // 22/11 (stable 04:02-04:20Z): one refused piece (send guard) took the only free pane, so nothing went out; a pane leaves after its second refusal.
        const sent = await deps.dispatch!(owner, input.room.id, input.pane.id, piece.text).catch(() => false);
        if (sent || refused.has(input)) open = open.filter((entry) => entry !== input);
        else refused.add(input);
        if (sent) {
          // A pane's earlier unsettled sweep ends with this one, so the new sweep's DONE is never credited to the old area.
          if (sweeping) for (const [key, paneId] of given) if (paneId === input.pane.id && key.includes("\u0000sweep:")) given.delete(key);
          given.set(`${owner}\u0000${piece.key}`, input.pane.id);
          if (sweeping) { sweptAt.set(`${owner}\u0000${piece.key}`, at); cleanDirty = true; }
          handed.push({ input, key: piece.key });
        }
      }
      if (cleanDirty && deps.cleanSweepStore) {
        const liveMarks = Object.fromEntries([...cleanSweeps].filter(([, mark]) => at - mark.at < SWEEP_CLEAN_TTL_MS));
        const pending = [...given].filter(([key]) => key.includes("\u0000sweep:")).map(([key, pane]) => [key, { at: sweptAt.get(key) ?? at, head: null, pane }] as const);
        await deps.cleanSweepStore.write({ ...liveMarks, ...Object.fromEntries(pending) }).catch(() => undefined);
      }
      const backlogKeys = new Set(backlog.map((entry) => entry.key));
      // Every owner's hand-out of a line still open is kept (the queue is one file), so a line marked DONE leaves the store.
      if (deps.givenStore && handed.some(({ key }) => backlogKeys.has(key))) {
        await deps.givenStore.write(Object.fromEntries([...given].filter(([key]) => backlogKeys.has(key.slice(key.indexOf("\u0000") + 1))))).catch(() => undefined);
      }
      const unpanedLeft = unpaned.filter((item) => !holds(item.key));
      const freeItems: NousTurnItem[] = freeInputs.filter((input) => !handed.some((entry) => entry.input === input) && !sweepPane(input.pane))
        // DEV3D-067: the shape carries when this free spell began, so a pane left free once is an item again the next time it is free.
        .map((input) => ({ key: `free:${input.pane.id}`, kind: "PLAN", pane: input.pane.id, paneName: paneLabel(input.pane), shape: `free ${input.state} ${ctx.since(input.pane.id) ?? ""}`,
          line: `${where(input)} ${input.state}${closeoutSince(input, ctx) ? ` since ${hhmm(closeoutSince(input, ctx)!)}` : ""}${flash(input.model) ? " (a Flash model: no code work on it, operator 18/11)" : ""}: send it the next piece of work below now (space_send_to_pane naming it), or record why it stays free (space_pane_checked WAITING_*, a space_nous_followup naming it)` }));
      const text = line ? [line, ...section("Free CLI panes (each gets work before it closes)", freeItems), ...section("Plans not on a pane (open a pane for each now)", unpanedLeft), ...section("Plans whose pane is idle or done (send each its next step now)", idle),
        ...(sent.length ? [`Space sent the next step itself (nothing to send): ${sent.map((item) => `${item.pane!.label} [${item.planId}] ${item.openStep}`).join("; ")}`] : []),
        ...(handed.length ? [`Space handed free panes work itself (nothing to send): ${handed.map(({ input, key }) => `${where(input)} ← ${key}`).join("; ")}`] : []),
        ...section("Tasks whose run ended on a finished pane", taskItems), ...section("Open requests whose pane is done 30+ min", requestItems)].join("\n") : null;
      // Hold A: idle capacity is an item; words alone pass no item of it (turn-items.ts `always`).
      const quiet = held("utilization");
      if (text && (!quiet || unpanedLeft.length + idle.length + taskItems.length + requestItems.length + freeItems.length > 0)) {
        lastUtilization.set(owner, at);
        // Every CLI pane not working is capacity to fill: the item asks a dispatch for each (or helpers, or the block recorded), not one.
        const notWorking = panes.filter((input) => savesToMemory(input.pane) && input.state !== "working" && !closing(input.pane.id));
        const need = notWorking.filter((input) => !shut.includes(poolOf(input.pane.id) ?? "\u0000")).length;
        // When every idle CLI pane is on a pool with no room, quota is the cause and Utilization is no item.
        const quotaOut = notWorking.length > 0 && need === 0;
        const pools = [...new Set(notWorking.map((input) => poolOf(input.pane.id) ?? "unknown"))].join(", ");
        const shown = quotaOut ? `Cause: quota. Every CLI pane not working runs on a pool out of room (${pools}): nothing to dispatch to them until a pool has room; no act needed for this line.\n${text.replace(" and no pool is at its limit", "")}` : text;
        // A left push re-arms only when the runnable work it counts changes (goal 5acd171d).
        const runnable = /Runnable: [^.]*\./.exec(line!)?.[0];
        const utilization: NousTurnItem = { key: "utilization", kind: "UTILIZATION", ...(runnable ? { shape: runnable } : {}), line: need > 1 ? `${text}\n${need} CLI panes are not working: this item moves by ${need} dispatches (a pane each), helpers, or what blocks the rest recorded (space_nous_followup add naming utilization); "save to memory" is no dispatch.` : text, ...(need > 1 ? { need } : {}) };
        // Urgent only while Nous has a pane, plan or task to act on; else the line rides the inbox batch (goal 5acd171d).
        const forNous = freeItems.length + unpanedLeft.length + idle.length + taskItems.length > 0;
        if (newlyFinished && forNous) {
          for (const [key, when] of urgentAt) if (at - when >= PUSH_MS) urgentAt.delete(key);
          for (const id of finishers) urgentAt.set(`${owner}\u0000${id}`, at);
        }
        await deps.notice(owner, "utilization-low", shown, [...(quiet || quotaOut ? [] : [utilization]), ...freeItems, ...unpanedLeft, ...idle, ...taskItems, ...requestItems].map((item) => ({ ...item, always: true })), newlyFinished && forNous);
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
    /** The owner's panes parked at the last tick (parkedPane): Load counts those not working apart. */
    parked: (owner: string): ReadonlySet<string> => parkedBy.get(owner) ?? new Set(),
    /** One owner now (tests, and the API's startup tick). */
    async tickOwner(owner: string): Promise<StandingTickResult> {
      const settings = await deps.settings(owner);
      if (!settings.enabled) return { paneLines: 0, stalledPlans: 0, turn: "OFF" };
      lastTick.set(owner, now());
      return tickOwner(owner, settings);
    },
    /** A room's open panes, oldest finished first, with save state and whether each may close now (R43-1). */
    async roomCloseouts(owner: string, roomId: string): Promise<RoomCloseout[]> {
      const at = now();
      const settings = await deps.settings(owner);
      const snapshot = await deps.collect(owner);
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      const ctx = closeoutContext(snapshot, settings.standingOrders, at, rows);
      return (await Promise.all(boardPanes(snapshot, { showClosed: false }).filter((input) => input.pane.roomId === roomId).map(async (input): Promise<RoomCloseout> => {
        const since = closeoutSince(input, ctx);
        const skip = closeoutSkipReason(input, ctx);
        const passes = skip === null || skip === "fresh" || skip === "board-check";
        const row = passes || (skip && SAVED_PASSES.has(skip)) ? await verifyNow(owner, input, rows.get(input.pane.id), since) : rows.get(input.pane.id);
        const live = row && row.state !== "CLOSED" ? row : null;
        // 28/11 Dino/Cody, Copilots/Oscar: the save saveRepeats calls "saved already … close it" closes past the SAVED_PASSES skips too (step 3: one reading).
        const verified = savesToMemory(input.pane) && covers(live, since);
        const save = !savesToMemory(input.pane) ? "nothing to save" : verified ? `save verified ${live!.verifiedMemoryId}`
          : live?.state === "VERIFIED" ? `save ${live.verifiedMemoryId ?? "verified"} of ${hhmm(live.updatedAt)} predates its last work, not verified since`
          : live ? `save asked ${hhmm(live.retriedAt ?? live.requestedAt)}${standing(live) ? ", not verified" : " predates its last work, not asked since"}` : "save not asked";
        return { pane: input.pane, state: input.state, since, idleMinutes: since ? Math.max(0, Math.round((at - Date.parse(since)) / MINUTE)) : null, save,
          closable: passes ? !savesToMemory(input.pane) || verified : SAVED_PASSES.has(skip!) && verified, skip };
      }))).sort((left, right) => (left.since ?? "\uffff").localeCompare(right.since ?? "\uffff"));
    },
    /** With no new work since, a verified save is not asked again, nor an unverified one before NOUS_SAVE_WAIT_MS or a third time; returns each pane's refusal line. */
    async saveRepeats(owner: string, paneIds: readonly string[]): Promise<Map<string, string>> {
      const at = now();
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      const repeats = new Map<string, string>();
      let snapshot: Promise<Awaited<ReturnType<StandingOrdersDeps["collect"]>> | null> | undefined;
      for (const paneId of paneIds) {
        // New work typed since the ask frees the pane for a new one.
        let row = standing(rows.get(paneId));
        if (!row) continue;
        // Plan clipboard:u78xLyqRp6kD: a save that shows now counts now, not on the next tick.
        if (row.state !== "VERIFIED") {
          const id = await savedSince(owner, paneId, row.requestedAt, undefined, row.retriedAt ?? row.requestedAt);
          if (id) { row = { ...row, state: "VERIFIED", verifiedMemoryId: id, reason: null, updatedAt: new Date(now()).toISOString() }; await deps.closeouts.save(owner, row); }
        }
        // 21/11 15:06 BKK screenshot (Dana: "save to memory" ×6 after its 3 saves): a verified save is not asked again either; only new work earns a new one.
        if (row.state === "VERIFIED") {
          // Work after the save earns a new save, as roomCloseouts; an unread state keeps the old refusal.
          if (covers(row, sampleSince(await (snapshot ??= deps.collect(owner).catch(() => null)), paneId))) repeats.set(paneId, `saved already (${row.verifiedMemoryId ?? "verified"}, ${hhmm(row.updatedAt)}): close it (space_close_pane) or give it its next work`);
          continue;
        }
        const askedAt = askAt(row);
        if (row.state === "SAVE_RETRIED") repeats.set(paneId, `asked twice already (last ${hhmm(row.retriedAt!)}) and Space sees no save yet (no Space Memory save naming the pane, no report with a memory id, no finished save turn), so space_close_pane refuses it: read the pane (space_pane_reports); still busy or stuck: space_pane_checked KEEP_OPEN with the reason; its save failed: send it its next step; finished and it cannot save: ${NOUS_SAVE_YOURSELF}`);
        else if (at - askedAt < NOUS_SAVE_WAIT_MS) repeats.set(paneId, `asked ${hhmm(row.requestedAt)}, Space verifies it from the pane's Space Memory save, reports or save turn; ask once more only after ${Math.round(NOUS_SAVE_WAIT_MS / MINUTE)} min unverified (the board lists it then)`);
      }
      return repeats;
    },
    /** Panes whose save covers their last work (`covers`): their next work starts a fresh session (tools.ts space_send_to_pane). */
    async savedUnprompted(owner: string, paneIds: readonly string[]): Promise<Set<string>> {
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      const verified = paneIds.filter((paneId) => standing(rows.get(paneId))?.state === "VERIFIED");
      // A pane that worked past its save keeps its session: the work is not in memory yet. The states are read only when a verified save stands.
      const snapshot = verified.length ? await deps.collect(owner).catch(() => null) : null;
      return new Set(verified.filter((paneId) => covers(rows.get(paneId), sampleSince(snapshot, paneId))));
    },
    /** From Nous's tool calls (tools.ts): "save to memory" sent to panes, and panes closed. */
    async saveRequested(owner: string, roomId: string, paneIds: string[]): Promise<void> {
      const stamp = new Date(now()).toISOString();
      const rows = new Map((await deps.closeouts.list(owner)).map((row) => [row.paneId, row]));
      for (const paneId of paneIds) {
        // An ask a later work prompt voided starts over: its new save is a first ask, not "asked twice".
        const row = standing(rows.get(paneId));
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
