import { describe, expect, it, vi } from "vitest";
import { nousSettingsSchema, type ClipboardItem, type NousDecision, type NousGlobalHold, type Pane, type Room, type SpaceNotification, type TaskItem } from "@space/contracts";
import { InMemoryNousFollowupsRepository, InMemoryNousPaneCloseoutsRepository, InMemoryNousPlanMarksRepository, type NousPaneCheck, type NousPaneSummaryRow, type PaneReport } from "@space/db";
import type { DashboardAgentsSample } from "../src/room-routes.js";
import type { BoardPaneInput } from "../src/nous/pane-board.js";
import { closeoutSince, closeoutSkipReason, createStandingOrders, keptOpenForTask, NOUS_SAVE_RETRY_TEXT, planWaitsFor, NOUS_SAVE_TEXT, savesToMemory, verifyMemorySave, type CloseoutBrowser, type StandingOrdersDeps, type SweepRequest } from "../src/nous/standing-orders.js";
import { itemActed, type NousTurnItem } from "../src/nous/turn-items.js";
import { deferralLines, localDayHour, renderDailyReview, type NousDeferral } from "../src/nous/daily-review.js";
import { createNousFollowups } from "../src/nous/followups.js";
import { promptsComing } from "../src/nous/requests-waiting.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { awaitsOperator } from "../src/nous/save-request.js";
import { noteOperatorPaneInput, operatorPromptedLast } from "../src/queue-operator-grants.js";
import { noteSpacePrompt } from "../src/space-prompts.js";
import { decisionPrediction } from "../src/nous/predictions.js";
import { buildPlanMap } from "../src/nous/plan-map.js";
import type { NousTurnFacts, RoomAgentEvent } from "@space/contracts";

// Standing orders (operator orders 2026-10-21): Space brings finished panes and stalled plans to Nous every tick, in code.
const owner = "user:operator";
const T0 = Date.parse("2026-10-21T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const MIN = 60_000;
const room = { id: "room:main0001", name: "Main", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null, order: 1 } as unknown as Room;
const cli = (id: string, name: string, extra: Partial<Pane> = {}) => ({ id, roomId: room.id, paneName: name, title: name, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false, ...extra }) as unknown as Pane;
const andy = cli("pane:andy0001", "Andy");
const plan = (id: string, paneId: string | null, percent: number, lastProgressAt: string, steps: string[] = ["PENDING"]) => ({
  id, title: `Plan ${id.slice(-1)}`, text: "", progressPercentage: percent, paneId, lastProgressAt, createdAt: lastProgressAt, executionStatus: "IN_PROGRESS",
  steps: steps.map((status, index) => ({ id: `step-${index + 1}`, order: index + 1, title: `Step ${index + 1}`, status, progress: 0, agent: null, notes: null, proof: null, startedAt: null, completedAt: null }))
}) as unknown as ClipboardItem;
const report = (paneId: string, at: string, summary: string, body: string | null = null): PaneReport =>
  ({ id: `report:${at}`, roomId: room.id, paneId, at, source: "AUTO", status: "TURN_END", summary, body, planId: null, step: null, percent: null, ticket: null, next: null, needs: null });

type PaneState = { pane: Pane; state: string; since: string | null };
const sample = (panes: PaneState[]): DashboardAgentsSample => ({
  data: panes.map((entry) => entry.pane), sampledAt: iso(T0),
  activity: Object.fromEntries(panes.map((entry) => [entry.pane.id, entry.state])) as never,
  details: Object.fromEntries(panes.map((entry) => [entry.pane.id, { status: entry.state, since: entry.since, source: "native" }])) as never
});
const input = (pane: Pane, state: string, extra: Partial<BoardPaneInput> = {}): BoardPaneInput =>
  ({ room, pane, state, model: null, report: null, plan: null, check: null, notifications: [], decisions: [], copilotItems: [], ...extra });
const check = (verdict: NousPaneCheck["verdict"], nextCheckAt: string | null = null): NousPaneCheck => ({ paneId: andy.id, roomId: room.id, checkedAt: iso(T0 - 10 * MIN), verdict, note: null, nextCheckAt });
const task = (paneId: string | null, schedule: unknown = { kind: "DAILY" }): TaskItem => ({ id: "task:digest001", title: "Daily digest", paneId, roomId: room.id, schedule, status: "OPEN" }) as unknown as TaskItem;
const card = (updatedAt: string) => ({ id: "notification:card0001", source: "NOUS", kind: "NEEDS_HANDS", severity: "ATTENTION", status: "OPEN", paneId: andy.id, roomId: room.id,
  dedupeKey: `nous:pane:${andy.id}`, title: "Sign in to GitLab", payload: {}, updatedAt }) as unknown as SpaceNotification;
const summary = (waitsOn: NousPaneSummaryRow["waitsOn"], generatedAt: string): NousPaneSummaryRow =>
  ({ id: "1", paneId: andy.id, roomId: room.id, fingerprint: "f", line: "…", waitsOn, needsOperator: waitsOn === "OPERATOR", until: null, detail: null, model: null, source: "FALLBACK", batchId: null, generatedAt, inputReportId: null, tokensIn: null, tokensOut: null }) as never;

describe("finished panes (close-out candidates)", () => {
  it("lists every pane type once nobody used it 30 minutes: its record, its browser and its playback count as use; a held browser keeps its pane (operator 27/10)", () => {
    const web = cli("pane:web00001", "Web", { mode: "BROWSER", terminalRuntimeId: null, updatedAt: iso(T0 - 90 * MIN) } as Partial<Pane>);
    const shell = cli("pane:sh000001", "Shell", { terminalRuntimeId: "shell", updatedAt: iso(T0 - 90 * MIN) } as Partial<Pane>);
    const tube = cli("pane:tube0001", "Tube", { mode: "YOUTUBE", terminalRuntimeId: null, updatedAt: iso(T0 - 90 * MIN) } as Partial<Pane>);
    const browser = (patch: Partial<CloseoutBrowser> = {}): CloseoutBrowser => ({ tabs: 2, held: null, activeAt: iso(T0 - 40 * MIN), ...patch });
    const base = { since: () => null, tasks: [], executions: [], summaries: [], now: T0, finishedAfterMs: 30 * MIN };
    expect(savesToMemory(andy)).toBe(true);
    expect([web, shell, tube].map(savesToMemory)).toEqual([false, false, false]);
    expect(savesToMemory(cli("pane:job00001", "Jo", { mode: "JOB_APPLY", terminalRuntimeId: "cli:claude" } as Partial<Pane>))).toBe(true);
    // Unused 40 minutes: listed; its browser on screen 5 minutes ago (the tab polls and frames stamp it): fresh.
    expect(closeoutSkipReason(input(web, "idle"), { ...base, browsers: new Map([[web.id, browser()]]) })).toBeNull();
    expect(closeoutSince(input(web, "idle"), { ...base, browsers: new Map([[web.id, browser()]]) })).toBe(iso(T0 - 40 * MIN));
    expect(closeoutSkipReason(input(web, "idle"), { ...base, browsers: new Map([[web.id, browser({ activeAt: iso(T0 - 5 * MIN) })]]) })).toBe("fresh");
    // A browser someone holds stays open: a handoff, a control lease, a Vault fence, or a read that failed; an unreadable browser list lists no browser.
    for (const held of ["handoff", "control", "vault", "unknown"] as const) {
      expect(closeoutSkipReason(input(web, "idle"), { ...base, browsers: new Map([[web.id, browser({ held })]]) })).toBe("browser-held");
    }
    expect(closeoutSkipReason(input(web, "idle"), { ...base, browsers: null })).toBe("unknown");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, since: () => iso(T0 - 31 * MIN), browsers: null })).toBeNull();
    // A CLI pane whose browser is under a handoff is not finished either.
    expect(closeoutSkipReason(input(andy, "done"), { ...base, since: () => iso(T0 - 31 * MIN), browsers: new Map([[andy.id, browser({ held: "handoff" })]]) })).toBe("browser-held");
    // A video playing 2 minutes ago keeps its YouTube pane; a plain shell goes by its record; a pane changed 5 minutes ago is fresh.
    expect(closeoutSkipReason(input(tube, "idle"), { ...base, usedAt: new Map([[tube.id, iso(T0 - 2 * MIN)]]) })).toBe("fresh");
    expect(closeoutSkipReason(input(tube, "idle"), base)).toBeNull();
    expect(closeoutSkipReason(input(shell, "idle"), base)).toBeNull();
    expect(closeoutSkipReason(input(shell, "working"), base)).toBe("busy");
    expect(closeoutSkipReason(input({ ...web, updatedAt: iso(T0 - 5 * MIN) } as Pane, "idle"), base)).toBe("fresh");
    // The same keep-open rules hold: the Mail Copilot always runs, a KEEP_OPEN check and an open notification keep any pane.
    expect(closeoutSkipReason(input(web, "idle", { check: { ...check("KEEP_OPEN", iso(T0 + 60 * MIN)), paneId: web.id } }), base)).toBe("keep-open");
    expect(closeoutSkipReason(input(web, "idle", { notifications: [{ id: "n1" } as SpaceNotification] }), base)).toBe("waiting-operator");
  });

  it("names a CLI pane done or idle 30 minutes with nothing waiting on it, and why every other pane is skipped", () => {
    const base = { since: () => iso(T0 - 31 * MIN), tasks: [], executions: [], summaries: [], now: T0, finishedAfterMs: 30 * MIN };
    expect(closeoutSkipReason(input(andy, "done"), base)).toBeNull();
    expect(closeoutSkipReason(input(andy, "idle"), base)).toBeNull();
    expect(closeoutSkipReason(input(andy, "working"), base)).toBe("busy");
    expect(closeoutSkipReason(input(andy, "waiting"), base)).toBe("busy");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, since: () => iso(T0 - 10 * MIN) })).toBe("fresh");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, since: () => null })).toBe("unknown");
    // Every pane type is a candidate (operator 27/10 «όλα του τύπου Panes»): a browser and a plain shell unused 30 minutes too.
    expect(closeoutSkipReason(input(cli("pane:web00001", "Web", { mode: "BROWSER" } as Partial<Pane>), "idle"), base)).toBeNull();
    expect(closeoutSkipReason(input(cli("pane:sh000001", "Shell", { terminalRuntimeId: "shell" } as Partial<Pane>), "idle"), base)).toBeNull();
    // The operator's own pane is closed like any other once its task is done (operator order 2026-10-24).
    expect(closeoutSkipReason(input(andy, "done", { check: check("OPERATOR_TEST") }), base)).toBeNull();
    expect(closeoutSkipReason(input(andy, "done", { check: check("OPERATOR_TEST") }), { ...base, closeOperatorPanes: false })).toBe("operator-test");
    expect(closeoutSkipReason(input(andy, "done", { check: check("KEEP_OPEN", iso(T0 + 60 * MIN)) }), base)).toBe("keep-open");
    expect(closeoutSkipReason(input(andy, "done", { check: check("WAITING_DATE", iso(T0 + 60 * MIN)) }), base)).toBe("keep-open");
    // A kept pane whose next check passed is back on the list; OK_WORKING never keeps one.
    expect(closeoutSkipReason(input(andy, "done", { check: check("KEEP_OPEN", iso(T0 - MIN)) }), base)).toBeNull();
    expect(closeoutSkipReason(input(andy, "done", { check: check("OK_WORKING") }), base)).toBeNull();
    expect(closeoutSkipReason(input(andy, "done", { notifications: [{ id: "n1" } as SpaceNotification] }), base)).toBe("waiting-operator");
    expect(closeoutSkipReason(input(andy, "done", { decisions: [{ id: "d1" } as NousDecision] }), base)).toBe("waiting-operator");
    // Only Nous's own card waits: Nous re-checks it once pane and card are both 30 minutes old; another notification beside it still waits.
    expect(closeoutSkipReason(input(andy, "done", { notifications: [card(iso(T0 - 31 * MIN))] }), base)).toBe("card-check");
    expect(closeoutSkipReason(input(andy, "done", { notifications: [card(iso(T0 - 10 * MIN))] }), base)).toBe("waiting-operator");
    expect(closeoutSkipReason(input(andy, "done", { notifications: [card(iso(T0 - 31 * MIN))] }), { ...base, since: () => iso(T0 - 10 * MIN) })).toBe("waiting-operator");
    expect(closeoutSkipReason(input(andy, "done", { notifications: [card(iso(T0 - 31 * MIN)), { id: "n1" } as SpaceNotification] }), base)).toBe("waiting-operator");
    expect(closeoutSkipReason(input(andy, "done", { notifications: [card(iso(T0 - 31 * MIN))], check: check("WAITING_OPERATOR", iso(T0 + 60 * MIN)) }), base)).toBe("keep-open");
    // A task pane closes too (the scheduler reopens it), unless its task runs within the hour (operator order 2026-10-24).
    expect(closeoutSkipReason(input(andy, "done"), { ...base, tasks: [task(andy.id)] })).toBeNull();
    expect(closeoutSkipReason(input(andy, "done"), { ...base, tasks: [task(andy.id, { kind: "DAILY", nextRunAt: iso(T0 + 30 * MIN) })] })).toBe("task");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, tasks: [task(andy.id, { kind: "DAILY", nextRunAt: iso(T0 + 3 * 60 * MIN) })] })).toBeNull();
    // Copilot-style panes run a CLI and close the same way.
    expect(closeoutSkipReason(input(cli("pane:mkt00001", "Kate", { mode: "MARKETING_COPILOT" } as Partial<Pane>), "idle"), base)).toBeNull();
    // ...unless it still owns an approved post scheduled, or that could not be read (operator rule 9/11).
    expect(closeoutSkipReason(input(cli("pane:mkt00001", "Kate", { mode: "MARKETING_COPILOT" } as Partial<Pane>), "idle"), { ...base, scheduled: new Set(["pane:mkt00001"]) })).toBe("scheduled");
    expect(closeoutSkipReason(input(cli("pane:mkt00001", "Kate", { mode: "MARKETING_COPILOT" } as Partial<Pane>), "idle"), { ...base, scheduled: null })).toBe("scheduled");
    // The Mail Copilot always runs: never a finished pane, however long it idles (operator 2026-10-27).
    expect(closeoutSkipReason(input(cli("pane:mail0001", "Emma", { mode: "MAIL_COPILOT" } as Partial<Pane>), "idle"), { ...base, since: () => iso(T0 - 3 * 24 * 60 * MIN) })).toBe("always-on");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, tasks: [task(andy.id, null), task("pane:other001")] })).toBeNull();
    expect(closeoutSkipReason(input(andy, "done"), { ...base, executions: [{ planId: "clipboard:x", paneId: andy.id }] })).toBe("managed");
    expect(closeoutSkipReason(input(andy, "done", { plan: plan("clipboard:a", andy.id, 60, iso(T0 - 5 * 3_600_000), ["COMPLETED", "PENDING"]) }), base)).toBe("plan-open");
    expect(closeoutSkipReason(input(andy, "done", { plan: plan("clipboard:a", andy.id, 100, iso(T0 - 5 * 3_600_000), ["COMPLETED"]) }), base)).toBeNull();
    // The board's wait holds while the pane is fresh; a pane finished 30 minutes goes back to Nous to re-check it.
    expect(closeoutSkipReason(input(andy, "done"), { ...base, summaries: [summary("OPERATOR", iso(T0 - 5 * MIN))] })).toBe("board-check");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, since: () => iso(T0 - 10 * MIN), summaries: [summary("OPERATOR", iso(T0 - 5 * MIN))] })).toBe("board-waits");
    expect(closeoutSkipReason(input(andy, "done"), { ...base, summaries: [summary("OPERATOR", iso(T0 - 60 * MIN))] })).toBeNull();
    expect(closeoutSkipReason(input(andy, "done"), { ...base, summaries: [summary("NONE", iso(T0 - 5 * MIN))] })).toBeNull();
    expect(keptOpenForTask(andy.id, [task(andy.id)])?.title).toBe("Daily digest");
  });

  it("lists a done pane whose linked plan waits on a date, a promote, a third party or another plan, and says why (R10-3)", async () => {
    // Operator rule 264b98c3 (28/10): a pane whose plan step waits for a release train idled open for hours; it closes and reopens with the work.
    const base = { since: () => iso(T0 - 31 * MIN), tasks: [], executions: [], summaries: [], now: T0, finishedAfterMs: 30 * MIN };
    const open = plan("clipboard:a", andy.id, 60, iso(T0 - 5 * 3_600_000), ["COMPLETED", "PENDING"]);
    const waiting = (waitsOn: unknown) => input(andy, "done", { plan: { ...open, waitsOn } as ClipboardItem });
    const train = { kind: "THIRD_PARTY", what: "the run-spaceapp train after 1.1.9", until: null };
    expect(closeoutSkipReason(waiting(train), base)).toBeNull();
    expect(planWaitsFor(waiting(train), base)).toBe("third party: the run-spaceapp train after 1.1.9");
    expect(closeoutSkipReason(waiting({ kind: "PROMOTE", what: "the 18:15 promote", until: null }), base)).toBeNull();
    expect(closeoutSkipReason(waiting({ kind: "DATE", what: "Monday", until: iso(T0 + 60 * MIN) }), base)).toBeNull();
    // A date that passed, a wait on the operator or on Nous: the step can move now, the pane stays.
    expect(closeoutSkipReason(waiting({ kind: "DATE", what: "this morning", until: iso(T0 - MIN) }), base)).toBe("plan-open");
    expect(closeoutSkipReason(waiting({ kind: "OPERATOR", what: "an answer", until: null }), base)).toBe("plan-open");
    // A plan it depends on that is still open; a finished one (no longer listed) holds nothing.
    const dependent = input(andy, "done", { plan: { ...open, dependsOn: ["clipboard:b"] } as ClipboardItem });
    expect(planWaitsFor(dependent, { ...base, plans: [plan("clipboard:b", null, 40, iso(T0))] })).toBe('plan "Plan b" (clipboard:b)');
    expect(closeoutSkipReason(dependent, { ...base, plans: [plan("clipboard:b", null, 40, iso(T0))] })).toBeNull();
    expect(closeoutSkipReason(dependent, { ...base, plans: [] })).toBe("plan-open");
    // The pane's board wait on a promote lets it close; one on the operator holds it as before.
    expect(closeoutSkipReason(input(andy, "done", { plan: open }), { ...base, summaries: [summary("PROMOTE", iso(T0 - 5 * MIN))] })).toBeNull();
    expect(closeoutSkipReason(input(andy, "done", { plan: open }), { ...base, summaries: [summary("OPERATOR", iso(T0 - 5 * MIN))] })).toBe("plan-open");
    expect(closeoutSkipReason(waiting(train), { ...base, summaries: [summary("OPERATOR", iso(T0 - 5 * MIN))] })).toBe("board-check");
    // Still fresh: the 30-minute rule holds as for any pane.
    expect(closeoutSkipReason(waiting(train), { ...base, since: () => iso(T0 - 5 * MIN) })).toBe("fresh");
    // The standing turn lists it for save and close and says why.
    const f = fixture({ plans: [{ ...open, waitsOn: train } as ClipboardItem] });
    await f.orders.tick();
    expect(f.text()).toContain("- Main/Andy · done 31 min · plan step waits for third party: the run-spaceapp train after 1.1.9: its task or you reopen the pane when the work continues · save not asked yet");
  });

  it("verifies a save only from reports after the request: a memory id, the transcript's answer after a turn ended, or the word saved", () => {
    const since = iso(T0);
    expect(verifyMemorySave([report(andy.id, iso(T0 - MIN), "Saved space_memory:0ld0ld0ld0ld")], since, "space_memory:0ld0ld0ld0ld")).toBeNull();
    expect(verifyMemorySave([report(andy.id, iso(T0 + 2 * MIN), "Done.", "Wrote space_memory:ab12cd34ef56 with the lessons.")], since, null)).toBe("space_memory:ab12cd34ef56");
    expect(verifyMemorySave([report(andy.id, iso(T0 + 2 * MIN), "Turn ended.")], since, "Saved it: space_memory:ab12cd34ef56")).toBe("space_memory:ab12cd34ef56");
    expect(verifyMemorySave([report(andy.id, iso(T0 + 2 * MIN), "Memory saved (deduplicated).")], since, null)).toBe("saved");
    expect(verifyMemorySave([report(andy.id, iso(T0 + 2 * MIN), "Still working on the export.")], since, null)).toBeNull();
  });
});

function fixture(options: { panes?: PaneState[]; plans?: ClipboardItem[]; tasks?: TaskItem[]; reports?: PaneReport[]; summaries?: NousPaneSummaryRow[]; checks?: NousPaneCheck[]; notifications?: SpaceNotification[]; standing?: StandingOrdersDeps["standing"]; away?: boolean; planMap?: StandingOrdersDeps["planMap"];
  browsers?: Map<string, CloseoutBrowser> | null; utilizationLow?: StandingOrdersDeps["utilizationLow"]; reviewLoad?: (owner: string) => Promise<string | null>;
  spend?: Awaited<ReturnType<NonNullable<StandingOrdersDeps["spend"]>>>; requests?: StandingOrdersDeps["requests"]; executions?: Array<{ planId: string; paneId: string }>;
  closePane?: StandingOrdersDeps["closePane"]; prompts?: ReadonlySet<string> | null } = {}) {
  let clock = T0;
  const closeouts = new InMemoryNousPaneCloseoutsRepository();
  const marks = new InMemoryNousPlanMarksRepository();
  const state = { panes: options.panes ?? [{ pane: andy, state: "done", since: iso(T0 - 31 * MIN) }], plans: options.plans ?? [], tasks: options.tasks ?? [], reports: options.reports ?? [],
    summaries: options.summaries ?? [], checks: options.checks ?? [], notifications: options.notifications ?? [], settings: nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false } }), away: options.away ?? false, unread: false, lowToken: false,
    facts: [] as NousTurnFacts[], decisions: [] as NousDecision[], timeZone: "Asia/Bangkok", browsers: options.browsers, reviewBusy: false, spend: options.spend };
  const standing = vi.fn<StandingOrdersDeps["standing"]>(options.standing ?? (async () => "STARTED"));
  const notice = vi.fn(async () => {});
  const collect = vi.fn<StandingOrdersDeps["collect"]>(async () => ({ rooms: [{ room, sample: state.unread ? null : sample(state.panes) }], reports: state.reports.filter((entry, index, all) => all.findIndex((other) => other.paneId === entry.paneId) === index),
    notifications: state.notifications, decisions: [], copilotItems: [], plans: state.plans, checks: state.checks, tasks: state.tasks, executions: (options.executions ?? []) as never, summaries: state.summaries,
    ...(state.browsers !== undefined ? { browsers: state.browsers } : {}), ...(options.prompts !== undefined ? { prompts: options.prompts } : {}) }));
  const orders = createStandingOrders({
    closeouts, marks, settings: async () => state.settings, owners: async () => [owner],
    collect,
    reportsSince: async (_owner, paneId, since) => state.reports.filter((entry) => entry.paneId === paneId && entry.at >= since),
    ...(options.planMap ? { planMap: options.planMap } : {}), ...(options.closePane ? { closePane: options.closePane } : {}),
    lowToken: async () => state.lowToken, standing, notice, paneRound: async () => null, away: async () => state.away, now: () => clock,
    ...(options.utilizationLow ? { utilizationLow: options.utilizationLow } : {}),
    ...(options.spend ? { spend: async () => state.spend! } : {}), ...(options.requests ? { requests: options.requests } : {}),
    review: { facts: async (_owner, since) => state.facts.filter((turn) => turn.startedAt >= since), decisions: async () => state.decisions, timeZone: async () => state.timeZone,
      busy: () => state.reviewBusy, ...(options.reviewLoad ? { load: options.reviewLoad } : {}) }
  });
  return { orders, closeouts, marks, standing, collect, notice, state, advance: (ms: number) => { clock += ms; }, text: (call = -1) => (standing.mock.calls.at(call) as unknown as [string, string, string])[2] };
}

describe("a pane that reports it finished comes at once (operator 28/10 14:59 BKK «θελω αμεσα»)", () => {
  const done = (status: PaneReport["status"], source: PaneReport["source"] = "AGENT", paneId = andy.id): PaneReport =>
    ({ ...report(paneId, iso(T0 - MIN), "Finished the task."), source, status, id: `report:${status}` });
  const base = { since: () => iso(T0 - MIN), tasks: [], executions: [], summaries: [], now: T0, finishedAfterMs: 30 * MIN };

  it("skips the 30-minute wait for its own done or failed report, or Space's turn end with the pane idle; any other report keeps it", () => {
    for (const status of ["DONE", "FAILED"] as const) expect(closeoutSkipReason(input(andy, "idle", { report: done(status) }), base), status).toBeNull();
    expect(closeoutSkipReason(input(andy, "done", { report: done("TURN_END", "AUTO") }), base)).toBeNull();
    expect(closeoutSkipReason(input(andy, "idle", { report: done("PROGRESS") }), base)).toBe("fresh");
    expect(closeoutSkipReason(input(andy, "idle"), base)).toBe("fresh");
    // Still working, or something waits on it: not finished.
    expect(closeoutSkipReason(input(andy, "working", { report: done("DONE") }), base)).toBe("busy");
    expect(closeoutSkipReason(input(andy, "idle", { report: done("DONE"), decisions: [{ id: "d" } as NousDecision] }), base)).toBe("waiting-operator");
    expect(closeoutSkipReason(input(andy, "idle", { report: done("DONE"), check: check("KEEP_OPEN", iso(T0 + 60 * MIN)) }), base)).toBe("keep-open");
    // A pane without an AI CLI keeps the idle rule.
    const web = cli("pane:web00001", "Web", { mode: "BROWSER", terminalRuntimeId: null, updatedAt: iso(T0 - MIN) } as Partial<Pane>);
    expect(closeoutSkipReason(input(web, "idle", { report: done("DONE", "AGENT", web.id) }), base)).toBe("fresh");
  });

  // Operator 8/11 20:08 BKK: Bob ended its turn with a choice for the operator and Nous asked it to save to memory.
  const BOB_TAIL = "Πρόταση: Α) κρατάμε το σημερινό όριο, Β) το βγάζουμε εντελώς.\nΠείτε μου ποιο από τα δύο θέλετε";
  it("keeps a pane whose last answer asks the operator, reports blocked or needs a decision, or the operator prompted last (operator 8/11 «σταματα να ζητας save»)", () => {
    const bob = cli("pane:bob00001", "Bob");
    const turnEnd = (body: string) => ({ ...report(bob.id, iso(T0 - MIN), body.split("\n")[0]!, body), id: "report:bob" });
    expect(closeoutSkipReason(input(bob, "idle", { report: turnEnd(BOB_TAIL) }), base)).toBe("awaits-operator");
    expect(closeoutSkipReason(input(bob, "idle", { report: turnEnd("Deployed on dev, tests green.\nDone.") }), base)).toBeNull();
    for (const status of ["BLOCKED", "NEEDS_DECISION"] as const)
      expect(closeoutSkipReason(input(bob, "idle", { report: { ...turnEnd("Which route?"), source: "AGENT", status } }), base), status).toBe("awaits-operator");
    const operatorLast = { ...base, operatorPromptedLast: (paneId: string) => paneId === bob.id };
    expect(closeoutSkipReason(input(bob, "idle", { report: turnEnd("Deployed on dev, tests green.") }), operatorLast)).toBe("awaits-operator");
    expect(closeoutSkipReason(input(andy, "idle", { report: done("DONE") }), operatorLast)).toBeNull();
  });

  it("reads a question or a choice at the end of an answer, never a code line ending in ';'", () => {
    const turn = (body: string) => ({ status: "TURN_END", summary: body, body });
    expect(awaitsOperator(turn(BOB_TAIL), false)).toContain("asks the operator");
    expect(awaitsOperator(turn("Θέλετε να το ανεβάσω στο dev;"), false)).toContain("asks the operator");
    expect(awaitsOperator(turn("Ready. Want me to submit it to the queue?"), false)).toContain("asks the operator");
    expect(awaitsOperator(turn("Fixed it:\nconst x = 1;"), false)).toBeNull();
    expect(awaitsOperator(turn("All done, tests green."), false)).toBeNull();
    expect(awaitsOperator(null, true)).toBe("the operator prompted it last and has not written since its answer");
  });

  it("tells whose prompt a pane answered last: Space's or the operator's", () => {
    const pane = "pane:who00001";
    expect(operatorPromptedLast(pane)).toBe(false);
    noteOperatorPaneInput(pane, "κάνε το\r", T0);
    expect(operatorPromptedLast(pane)).toBe(true);
    noteSpacePrompt(pane, T0 + MIN);
    expect(operatorPromptedLast(pane)).toBe(false);
  });

  it("ends an OK_WORKING verdict on a done report, and space_pane_checked refuses OK_WORKING on a pane idle after its done report", async () => {
    const { InMemoryNousPaneChecksRepository } = await import("@space/db");
    const { createNousPaneWatch } = await import("../src/nous/pane-watch.js");
    const { createNousTools } = await import("../src/nous/tools.js");
    const repository = new InMemoryNousPaneChecksRepository();
    const watch = createNousPaneWatch({ repository, now: () => T0 });
    await watch.checked(owner, room, andy, { room: "Main", pane: "Andy", verdict: "OK_WORKING" });
    expect(await watch.clearWorking(owner, room.id, andy.id)).toBe(true);
    expect((await repository.list(owner))[0]).toMatchObject({ verdict: null, nextCheckAt: null });
    await watch.checked(owner, room, andy, { room: "Main", pane: "Andy", verdict: "KEEP_OPEN", nextCheckInMinutes: 30, note: "a deploy" });
    expect(await watch.clearWorking(owner, room.id, andy.id)).toBe(false);
    let state = "IDLE";
    const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], paneWatch: watch, inspectPane: async () => ({ state }),
      paneLastReport: async () => ({ status: "DONE", source: "AGENT", at: iso(T0 - MIN), summary: "Finished the task." }) } as never);
    const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
    const refused = await tools.execute("space_pane_checked", { room: "Main", pane: "Andy", verdict: "OK_WORKING" }, ctx);
    expect(refused).toMatchObject({ ok: false, refused: true, result: expect.stringMatching(/^Andy reported done at 09:59 UTC \("Finished the task\."\) and sits idle at its prompt \(IDLE\), so OK_WORKING would hide a finished pane\./) });
    state = "RUNNING";
    expect((await tools.execute("space_pane_checked", { room: "Main", pane: "Andy", verdict: "OK_WORKING" }, ctx)).ok).toBe(true);
    // R21-appstudio-kick (c): a brief-taking pane idle with briefs waiting is not working either.
    let briefState = "IDLE";
    const briefTools = createNousTools({ rooms: async () => [room], listPanes: async () => [andy], paneWatch: watch, inspectPane: async () => ({ state: briefState }),
      briefsWaiting: (paneId: string) => paneId === andy.id ? "3 briefs waiting since 17:38 UTC" : null } as never);
    const held = await briefTools.execute("space_pane_checked", { room: "Main", pane: "Andy", verdict: "OK_WORKING" }, ctx);
    expect(held).toMatchObject({ ok: false, refused: true,
      result: expect.stringMatching(/^Andy sits idle at its prompt with 3 briefs waiting since 17:38 UTC, so OK_WORKING would hide it\./) });
    // 5/11: the hold names the calls that work when the run already reads RUNNING; a pane RUNNING now (just kicked off) is working.
    expect(held.result).toContain("space_send_to_pane (the next brief) or space_restart_pane; space_copilot_control start only when its run is off");
    briefState = "RUNNING";
    expect((await briefTools.execute("space_pane_checked", { room: "Main", pane: "Andy", verdict: "OK_WORKING" }, ctx)).ok).toBe(true);
    briefState = "IDLE";
    expect((await briefTools.execute("space_pane_checked", { room: "Main", pane: "Andy", verdict: "KEEP_OPEN", nextCheckInMinutes: 30, note: "briefs wait for the next batch" }, ctx)).ok).toBe(true);
  });

  it("lists a recurring agent task Space knows no pane or room for in the Standing orders turn, never as a reason for one (R44-3)", async () => {
    const lost = { id: "task:VeYqNEXNFozx", title: "Nous daily upgrade round", source: "AGENT", paneId: null, roomId: null, status: "OPEN",
      schedule: { recurrence: { kind: "DAILY", time: "03:40" }, timeZone: "Asia/Bangkok", nextRunAt: iso(T0 + 60 * MIN) } } as unknown as TaskItem;
    const reminder = { ...lost, id: "task:accountant1", title: "Call the accountant", source: "MANUAL" } as TaskItem;
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - MIN) }], reports: [done("DONE")], tasks: [lost, reminder] });
    await f.orders.tick();
    expect(f.text()).toContain("## Scheduled agent tasks with no pane");
    expect(f.text()).toContain('- [task:VeYqNEXNFozx] "Nous daily upgrade round" · next run');
    expect(f.text()).not.toContain("task:accountant1");
    // Alone it starts no turn.
    const quiet = fixture({ panes: [], tasks: [lost] });
    await quiet.orders.tick();
    expect(quiet.standing).not.toHaveBeenCalled();
  });

  it("lists it in the next standing turn a minute after the report (soon), and with no hourly count (31/10)", async () => {
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - MIN) }], reports: [done("DONE")] });
    await f.orders.tick();
    expect(f.text()).toContain("- Main/Andy · idle 1 min · save not asked yet → send it exactly \"save to memory\"");
    expect(f.standing.mock.calls.at(-1)).toHaveLength(3);
    // The next done report brings the tick back within a minute instead of after tickMinutes (10).
    const calls = f.collect.mock.calls.length;
    f.advance(MIN);
    await f.orders.tick();
    expect(f.collect.mock.calls.length).toBe(calls);
    f.orders.soon(owner);
    await f.orders.tick();
    expect(f.collect.mock.calls.length).toBe(calls + 1);
  });
});

describe("the daily self-review (operator decision 2026-10-24)", () => {
  const facts = (turnId: string, reason: NousTurnFacts["reason"], startedAt: string, extra: Partial<NousTurnFacts> = {}): NousTurnFacts =>
    ({ turnId, ownerUserId: owner, reason, status: "DONE", tools: {}, planPoints: 0, outcomes: [], startedAt, endedAt: startedAt, model: null, effort: null, costUsd: null, tokens: null, ...extra });

  it("reads the operator's local day and hour, UTC for an unknown zone", () => {
    expect(localDayHour(Date.parse("2026-10-23T19:30:00.000Z"), "Asia/Bangkok")).toEqual({ day: "2026-10-24", hour: 2 });
    expect(localDayHour(Date.parse("2026-10-23T19:30:00.000Z"), "Mars/Olympus")).toEqual({ day: "2026-10-23", hour: 19 });
  });

  it("renders the last 24 hours of turn facts: turns by reason, the tools that failed most (gates left out), decisions, corrections, then the orders", () => {
    const since = "2026-10-23T03:00:00.000Z";
    const text = renderDailyReview({ since, day: "2026-10-24", hour: 3, decisions: [
      { id: "nous_decision:a", title: "Rename the room?", category: "DIRECTION", action: null, status: "APPROVED", createdAt: "2026-10-23T09:30:00.000Z", answeredAt: "2026-10-23T10:00:00.000Z", couldHaveDecided: true } as NousDecision,
      { id: "nous_decision:b", title: "Old", category: "DIRECTION", action: null, status: "ANSWERED", createdAt: "2026-10-22T09:00:00.000Z", answeredAt: "2026-10-22T10:00:00.000Z" } as NousDecision,
      { id: "nous_decision:c", title: "Delete the export", category: "DESTRUCTIVE", action: { type: "SPACE_CONTROL" }, status: "OPEN", createdAt: "2026-10-23T11:00:00.000Z", answeredAt: null,
        refs: { prediction: { answer: "yes", confidence: 80 } } } as unknown as NousDecision
    ], cards: [
      { dedupeKey: "nous:pane:pane:andy0001", createdAt: "2026-10-20T08:00:00.000Z", payload: { alertAt: "2026-10-23T08:00:00.000Z" } } as unknown as SpaceNotification,
      { dedupeKey: "nous:general", createdAt: "2026-10-23T09:00:00.000Z", payload: {} } as unknown as SpaceNotification,
      { dedupeKey: "nous:pane:pane:bob00001", createdAt: "2026-10-22T08:00:00.000Z", payload: { alertAt: "2026-10-22T08:00:00.000Z" } } as unknown as SpaceNotification,
      { dedupeKey: "nous:decision:nous_decision:c", createdAt: "2026-10-23T11:00:00.000Z", payload: {} } as unknown as SpaceNotification,
      // Evening audit 29/10: a done request and a low-spend notice ask nothing, so they are no question.
      { kind: "REQUEST_DONE", dedupeKey: "nous:done:clipboard:plan01", createdAt: "2026-10-23T12:00:00.000Z", payload: {} } as unknown as SpaceNotification,
      { kind: "LOW_SPEND_CRITICAL", dedupeKey: "nous:low-spend:critical", createdAt: "2026-10-23T13:00:00.000Z", payload: {} } as unknown as SpaceNotification
    ], facts: [
      facts("t1", "OPERATOR", "2026-10-23T09:00:00.000Z", { tools: { space_send_to_pane: { calls: 4, failed: 3, refused: 1, error: "Not sent: Andy: the room is busy" }, space_world: { calls: 2, failed: 0, refused: 0 } }, outcomes: [{ summary: "Rename the room", outcome: "SELF", correction: true }] }),
      facts("t2", "INBOX", "2026-10-23T12:00:00.000Z", { status: "TIMEOUT", tools: { space_read_pane: { calls: 3, failed: 1, refused: 0, error: "Could not find Zed" }, space_send_to_pane: { calls: 1, failed: 1, refused: 0, error: "Not sent: Andy: the room is busy" } } }),
      facts("t3", "INBOX", "2026-10-22T12:00:00.000Z", { tools: { space_git: { calls: 9, failed: 9, refused: 0 } } }),
      facts("t4", "REVIEW", "2026-10-23T03:05:00.000Z", { tools: { space_note: { calls: 1, failed: 1, refused: 0 } } })
    ] });
    expect(text).toContain("# Daily self-review (from Space, not the operator; once a day at 03:00 in the operator's zone; today 2026-10-24)");
    expect(text).toContain("- Turns: 2 (OPERATOR 1; INBOX 1, 1 failed); turns that failed, timed out or were stopped: 1");
    expect(text).toContain("- Tool calls: 10; mistakes (failed calls that were not a gate holding back): 4; held by a gate: 1");
    expect(text).toContain("- Tools that failed most: space_send_to_pane 3 of 5, space_read_pane 1 of 3");
    // 2/11 REVIEW: each tool's first error per turn, so the review names the cause.
    expect(text).toContain("- Error samples (up to 3 per tool per turn): space_send_to_pane: \"Not sent: Andy: the room is busy\" ×2; space_read_pane: \"Could not find Zed\"");
    expect(text).toContain("- Decisions the operator answered: 1 (approved 1, declined 0, in words 0); \"you could have decided this\": 1");
    expect(text).toContain("- Corrections by the operator: 1: \"Rename the room\"");
    // Ask last (goal ee5a573e): the questions the operator got in the last 24 hours.
    expect(text).toContain("## Questions to the operator (ask last, goal ee5a573e)\n- Cards and focus requests raised: 2\n- Cards that reached the operator by subject (R66): 2 subjects; on more than one card: none\n- Decisions asked: 2; questions among them (DIRECTION or without an action): 1\n- Decisions asked without a prediction: 1\n- \"You could have decided this\": 1: \"Rename the room?\"");
    expect(text).toContain('titled "Nous daily review 2026-10-24" tagged nous-review');
  });

  it("scores the operator's answers against Nous's predictions over 7 and 30 days (goal 7365014c-a)", () => {
    const since = "2026-10-27T03:00:00.000Z";
    const decision = (id: string, status: string, answeredAt: string, recommendation: string, answer: string | null = null) =>
      ({ id, title: id, category: "EXTERNAL", action: null, status, createdAt: answeredAt, answeredAt, recommendation, body: "", answer }) as unknown as NousDecision;
    const text = renderDailyReview({ since, day: "2026-10-28", hour: 3, facts: [], decisions: [
      decision("nous_decision:a", "APPROVED", "2026-10-27T10:00:00.000Z", "Ναι. Πρόβλεψη: ναι (90%)"),
      decision("nous_decision:b", "DECLINED", "2026-10-26T10:00:00.000Z", "Πρόβλεψη: ναι (60%)"),
      decision("nous_decision:c", "APPROVED", "2026-10-10T10:00:00.000Z", "Prediction: yes"),
      decision("nous_decision:d", "APPROVED", "2026-10-27T11:00:00.000Z", "Πρόβλεψη: ναι (95%)", 'Approved by your "Always approve" for: approve the marketing copilot\'s reviews'),
      decision("nous_decision:e", "APPROVED", "2026-10-27T12:00:00.000Z", "No line here")
    ], cards: [
      { dedupeKey: "nous:pane:pane:andy0001", createdAt: "2026-10-27T08:00:00.000Z", updatedAt: "2026-10-27T09:00:00.000Z",
        payload: { ask: { question: "Postal code?", options: ["10260", "10110"], recommended: "10260" }, answer: { text: "10260", at: "2026-10-27T09:00:00.000Z" } } } as unknown as SpaceNotification
    ] });
    expect(text).toContain("- Predictions (goal 7365014c): decisions 1 of 2 as predicted (50%) over 7 days, 2 of 3 as predicted (67%) over 30; cards 1 of 1 as predicted (100%) over 7 days, 1 of 1 as predicted (100%) over 30.");
    expect(decisionPrediction({ recommendation: "Όχι. Πρόβλεψη: όχι (80%)", body: "" })).toBe("DECLINE");
  });

  it("lists the cards answered against Nous's recommendation and orders the day's causes into the upgrade queue (items 30 and 13)", () => {
    const since = "2026-10-27T03:00:00.000Z";
    const card = (title: string, text: string, by?: string) => ({ title, dedupeKey: "nous:pane:pane:a", createdAt: since, updatedAt: since,
      payload: { ask: { question: title, options: ["Keep", "Close"], recommended: "Close" }, answer: { text, at: "2026-10-27T09:00:00.000Z", ...(by ? { by } : {}) } } }) as unknown as SpaceNotification;
    const text = renderDailyReview({ since, day: "2026-10-28", hour: 3, facts: [], decisions: [], cards: [card("Close Bob?", "Keep"), card("Close Cody?", "Close"), card("Close Dana?", "Keep", "ALWAYS")] });
    expect(text).toContain('- Cards answered against your recommendation: 1: "Close Bob?" recommended "Close", answered "Keep"');
    expect(text).toContain('4. Append to nous/upgrades/queue.md (space_files_write, mode append) a "## 2026-10-28 REVIEW" block');
    expect(text).toMatch(/\n5\. End with five lines/);
  });

  it("names each wait of the day and who ended it, flickers left out (queue item 21)", async () => {
    const since = "2026-10-27T03:00:00.000Z";
    const wait = (paneName: string, status: string, createdAt: string, updatedAt: string, kind = "WAITING", decision: string | null = null) =>
      ({ eventId: `room_agent_event:${paneName}`, roomId: "room:a", paneId: `pane:${paneName}`, paneName, kind, title: `${paneName} is waiting: Permission prompt`, status, createdAt, updatedAt, decision }) as unknown as RoomAgentEvent;
    const { waitLines } = await import("../src/nous/daily-review.js");
    expect(waitLines([
      wait("Cody", "RESOLVED", "2026-10-27T18:05:43.000Z", "2026-10-27T18:07:48.000Z", "WAITING", "The pane moved on."),
      wait("Hugo", "HANDLED", "2026-10-27T09:06:39.000Z", "2026-10-27T09:07:09.000Z", "WAITING", 'Nous answered "1" for you.'),
      wait("Emma", "RESOLVED", "2026-10-27T13:42:38.000Z", "2026-10-27T13:42:44.000Z"), wait("Dana", "RESOLVED", "2026-10-26T17:35:47.000Z", "2026-10-26T17:38:25.000Z"),
      wait("Bob", "FINISHED", "2026-10-27T10:00:00.000Z", "2026-10-27T10:00:00.000Z", "FINISHED")
    ], since)).toEqual(['- 09:06 UTC Hugo WAITING "Permission prompt": answered (0.5 min): closed by Nous (a send or an answer)',
      '- 18:05 UTC Cody WAITING "Permission prompt": UNANSWERED (2.1 min): closed by the pane itself (it moved on) (closed by its CLI within 3 min: out of the adjusted score)']);
    const text = renderDailyReview({ since, day: "2026-10-28", hour: 3, facts: [], decisions: [], waits: [] });
    expect(text).toContain("## Waits on panes (the scorecard's unblocking, queue item 21)\n- No pane waited (flickers under 30 s left out).");
    expect(text).toContain("every UNANSWERED wait above");
  });

  it("counts the cards held because Space already had the answer, and their lessons, beside the cards raised (R65)", () => {
    const since = "2026-11-03T03:00:00.000Z";
    const text = renderDailyReview({ since, day: "2026-11-04", hour: 3, facts: [], decisions: [], cardHolds: { rule: 2, memory: 1, lessons: ["lessons-2026-11-03"] } });
    expect(text).toContain("- Cards and focus requests raised: 0\n- Cards held because Space already had the answer (R65, R66): 3 (a rule or earlier answer 2, a memory 1, "
      + "a stored sign-in 0, Space's records 0, an open card on the same subject 0); lessons of this kind: 1 (lessons-2026-11-03)");
    expect(renderDailyReview({ since, day: "2026-11-04", hour: 3, facts: [], decisions: [] })).not.toContain("(R65");
  });

  // R66 (4/11: 33 questions reached the operator, five subjects on two cards from two panes): the refusals by kind, and the cards by subject.
  it("counts R66's refusals by kind and the cards that reached the operator by subject (R66)", () => {
    const since = "2026-11-04T03:00:00.000Z";
    const card = (id: string, pane: string, text: string) => ({ id, ownerUserId: "user:operator", roomId: "room:a", paneId: pane, source: "NOUS", kind: "NEEDS_HANDS",
      severity: "ATTENTION", status: "OPEN", title: "needs you", body: text, link: { roomId: "room:a" }, dedupeKey: `nous:pane:${pane}`, createdAt: "2026-11-04T06:00:00.000Z",
      updatedAt: "2026-11-04T06:00:00.000Z", payload: { items: [{ text }], alertAt: "2026-11-04T06:00:00.000Z" } }) as unknown as SpaceNotification;
    const text = renderDailyReview({ since, day: "2026-11-05", hour: 3, facts: [], decisions: [], cards: [
      card("notification:a1", "pane:a", "DeepInfra sign-up: solve the Cloudflare Turnstile"), card("notification:b1", "pane:b", "DeepInfra Turnstile blocks the sign-up: solve it"),
      card("notification:c1", "pane:c", "Skroutz return: print the label")],
      cardHolds: { rule: 1, memory: 2, signin: 3, records: 1, duplicate: 4, lessons: [] } });
    expect(text).toContain("- Cards held because Space already had the answer (R65, R66): 11 (a rule or earlier answer 1, a memory 2, a stored sign-in 3, Space's records 1, "
      + "an open card on the same subject 4); lessons of this kind: 0");
    expect(text).toContain("- Cards that reached the operator by subject (R66): 2 subjects; on more than one card: \"DeepInfra sign-up: solve the Cloudflare Turnstile\" 2");
  });

  it("counts the operator's answers in every rail, one line per source, then Nous's decisions (goal 7365014c-b)", async () => {
    const since = "2026-10-27T03:00:00.000Z";
    const rails = [
      { source: "Mail Copilot", type: "REVIEW_DECIDED", decision: "approve", count: 3 }, { source: "Mail Copilot", type: "REVIEW_DECIDED", decision: "edit", count: 1 },
      { source: "Mail Copilot", type: "RULE_DECIDED", decision: "approve", count: 1 }, { source: "Marketing Copilot", type: "REVIEW_DECIDED", decision: "approve", count: 4 },
      { source: "Job Copilot", type: "ANSWERED", decision: "Nous", count: 2 }, { source: "Needs you", type: "AGENT", decision: "answered", count: 1 }
    ];
    // Answered an hour ago: space_nous_decisions {summary} counts the last day from now, so a fixed date falls out of it a day later.
    const decisions = [{ id: "nous_decision:a", status: "APPROVED", answeredAt: new Date(Date.now() - 3_600_000).toISOString(), createdAt: since } as unknown as NousDecision];
    const text = renderDailyReview({ since, day: "2026-10-28", hour: 3, facts: [], decisions, rails });
    expect(text).toContain(["## The operator's answers in every rail (goal 7365014c-b)", "- Mail Copilot: reviews approve 3, edit 1; rules approve 1",
      "- Marketing Copilot: reviews approve 4", "- Job Copilot: questions Nous 2", "- Needs you: agent answered 1", "- Nous decisions: approved 1, declined 0, in words 0", "## Orders"].join("\n"));
    expect(renderDailyReview({ since, day: "2026-10-28", hour: 3, facts: [], decisions, rails: null })).toContain("- The rails could not be read here.");
    expect(renderDailyReview({ since, day: "2026-10-28", hour: 3, facts: [], decisions })).not.toContain("every rail");
    const { createNousTools } = await import("../src/nous/tools.js");
    const railDecisions = vi.fn(async (_owner: string, _since: string) => rails);
    const tools = createNousTools({ rooms: async () => [], listPanes: async () => [], decisions: async () => decisions, railDecisions } as never);
    const summary = await tools.execute("space_nous_decisions", { summary: true }, { owner: "user:operator", turnId: "turn:1", callId: "call:1", traceId: "trace:1" });
    expect(summary.result).toContain("- Mail Copilot: reviews approve 3, edit 1; rules approve 1");
    expect(summary.result).toContain("- Nous decisions: approved 1");
    expect(Date.now() - Date.parse(railDecisions.mock.calls[0]![1])).toBeGreaterThan(86_000_000);
  });

  it("brings the utilization-low line every 10 minutes while it stays low (the push, operator 3/11 23:11 BKK), and the REVIEW names the day's average (Load, plan clipboard:f4SH36t3fJ6c)", async () => {
    const low = vi.fn(async (_owner: string, plans: number) => plans ? `Utilization stayed under the 90% target for 15 min. Waiting: ${plans} open plan` : null);
    const f = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }], plans: [plan("clipboard:a", andy.id, 40, iso(T0 - 5 * MIN)) as ClipboardItem],
      utilizationLow: low, reviewLoad: async () => "## Utilization\n2026-10-20: average 41% of capacity in use" });
    f.state.settings = nousSettingsSchema.parse({ enabled: true });
    await f.orders.tickOwner(owner);
    expect(low).toHaveBeenCalledWith(owner, 1);
    // Hold A (plan clipboard:ZWJJdBgHm64Z): idle capacity is an item the turn acts on before it may answer NOTHING_NEW.
    const idle = "Utilization stayed under the 90% target for 15 min. Waiting: 1 open plan";
    expect(f.notice).toHaveBeenCalledWith(owner, "utilization-low", idle, [{ key: "utilization", kind: "UTILIZATION", line: idle, always: true }]);
    expect(f.standing.mock.calls.find((call) => call[1] === "REVIEW")?.[2]).toContain("## Utilization\n2026-10-20: average 41% of capacity in use");
    f.advance(5 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.notice.mock.calls.filter((call) => (call as unknown[])[1] === "utilization-low")).toHaveLength(1);
    // The next tick (10 minutes, a few seconds early as the minute tick runs it) brings it again.
    f.advance(5 * MIN - 5_000);
    await f.orders.tickOwner(owner);
    expect(f.notice.mock.calls.filter((call) => (call as unknown[])[1] === "utilization-low")).toHaveLength(2);
  });

  it("R21-4 (REVIEW 1/11: 61 % with 4 of 23 CLI panes working; operator 1/11 23:05 BKK): the utilization line carries every stalled plan with no working pane and a step that can run, whatever its whole-plan wait", async () => {
    const low = vi.fn(async () => "Utilization stayed under the 90% target for 15 min.");
    const bob = cli("pane:bob00001", "Bob"), cody = cli("pane:cody0001", "Cody"), dana = cli("pane:dana0001", "Dana");
    const ready = plan("clipboard:r", andy.id, 40, iso(T0 - 4 * 60 * MIN));
    // A wait on the operator recorded on the whole plan no longer hides its other steps (13 of 31 plans sat unlisted on 1/11).
    const operator = { ...plan("clipboard:o", bob.id, 40, iso(T0 - 4 * 60 * MIN)), waitsOn: { kind: "OPERATOR", what: "his sign-in", until: null } } as ClipboardItem;
    const working = plan("clipboard:w", cody.id, 40, iso(T0 - 4 * 60 * MIN));
    const fresh = plan("clipboard:f", dana.id, 40, iso(T0 - 10 * MIN));
    const paneless = plan("clipboard:n", null, 40, iso(T0 - 4 * 60 * MIN), ["COMPLETED", "PENDING"]);
    const blocked = plan("clipboard:b", null, 40, iso(T0 - 4 * 60 * MIN), ["COMPLETED", "BLOCKED"]);
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - 60 * MIN) }, { pane: bob, state: "idle", since: iso(T0 - 60 * MIN) },
      { pane: cody, state: "working", since: iso(T0 - 5 * MIN) }, { pane: dana, state: "idle", since: iso(T0 - 5 * MIN) }], plans: [ready, operator, working, fresh, paneless, blocked], utilizationLow: low });
    f.state.settings = nousSettingsSchema.parse({ enabled: true });
    await f.orders.tickOwner(owner);
    const [, , text, items] = f.notice.mock.calls.find((call) => (call as unknown[])[1] === "utilization-low") as unknown as [string, string, string, Array<Record<string, unknown>>];
    expect(text).toBe(["Utilization stayed under the 90% target for 15 min.", "Plans not on a pane (open a pane for each now):", `- ${items[1]!.line}`,
      "Plans whose pane is idle or done (send each its next step now):", `- ${items[2]!.line}`, `- ${items[3]!.line}`, `- ${items[4]!.line}`].join("\n"));
    expect(items).toEqual([{ key: "utilization", kind: "UTILIZATION", line: text, always: true },
      expect.objectContaining({ key: "plan:clipboard:n", line: expect.stringContaining("no open pane · next: 2. Step 2 (PENDING): open a pane for it now at the plan's minimum model (space_open_panes) and send it \"Implement the following plan. Plan ID: clipboard:n\"") }),
      expect.objectContaining({ key: "plan:clipboard:r", kind: "PLAN", plan: "clipboard:r", pane: andy.id, line: expect.stringContaining("Andy idle · next: 1. Step 1 (PENDING): send it to Andy now") }),
      expect.objectContaining({ key: "plan:clipboard:o", pane: bob.id, line: expect.stringContaining("Bob idle · next: 1. Step 1 (PENDING): send it to Bob now") }),
      // R57: an idle pane gets its plan's next step before the plan stalls.
      expect.objectContaining({ key: "plan:clipboard:f", pane: dana.id, line: expect.stringContaining("Dana idle · next: 1. Step 1 (PENDING): send it to Dana now") })]);
    // The item is moved only by a step sent naming the plan or its pane (or its wait recorded).
    const item = items[2] as unknown as NousTurnItem;
    expect(itemActed(item, [{ name: "space_send_to_pane", ok: true, subjects: [`pane ${andy.id}`], args: { room: "Main", panes: [andy.id], text: "Next step of clipboard:r" } }])).toBe(true);
    expect(itemActed(item, [{ name: "space_send_to_pane", ok: true, subjects: [`pane ${cody.id}`], args: { room: "Main", panes: [cody.id], text: "Something else" } }])).toBe(false);
  });

  it("R57 (REVIEW 4/11: 60 % while 14 CLI panes sat idle or done; operator 3/11 «πιεζει τα παντα στο 90% συνεχομενα»): the push hands an idle or done pane its open plan's next step before the plan stalls; never a working or waiting pane, a managed plan or one whose open steps are BLOCKED", async () => {
    const low = vi.fn(async () => "Utilization stayed under the 90% target for 15 min.");
    const bob = cli("pane:bob00001", "Bob"), cody = cli("pane:cody0001", "Cody"), dana = cli("pane:dana0001", "Dana"), eve = cli("pane:eve00001", "Eve"), finn = cli("pane:finn0001", "Finn");
    // Every plan moved 20 minutes ago: none is stalled yet.
    const moved = iso(T0 - 20 * MIN);
    const done = plan("clipboard:d", andy.id, 50, moved, ["COMPLETED", "PENDING"]), idle = plan("clipboard:i", bob.id, 50, moved, ["COMPLETED", "IN_PROGRESS"]);
    const asks = plan("clipboard:a", cody.id, 50, moved), blocked = plan("clipboard:b", dana.id, 50, moved, ["COMPLETED", "BLOCKED"]);
    const managed = plan("clipboard:m", eve.id, 50, moved), working = plan("clipboard:w", finn.id, 50, moved);
    const f = fixture({ panes: [{ pane: andy, state: "done", since: iso(T0 - 15 * MIN) }, { pane: bob, state: "idle", since: iso(T0 - 15 * MIN) },
      { pane: cody, state: "waiting", since: iso(T0 - 15 * MIN) }, { pane: dana, state: "idle", since: iso(T0 - 15 * MIN) }, { pane: eve, state: "idle", since: iso(T0 - 15 * MIN) },
      { pane: finn, state: "working", since: iso(T0 - 5 * MIN) }], plans: [done, idle, asks, blocked, managed, working], utilizationLow: low, executions: [{ planId: managed.id, paneId: eve.id }] });
    f.state.settings = nousSettingsSchema.parse({ enabled: true });
    await f.orders.tickOwner(owner);
    const [, , text, items] = f.notice.mock.calls.find((call) => (call as unknown[])[1] === "utilization-low") as unknown as [string, string, string, Array<Record<string, unknown>>];
    // The line names each pane→step pair, and each is an item: Nous cannot answer NOTHING_NEW while one waits.
    expect(text).toBe(["Utilization stayed under the 90% target for 15 min.", "Plans whose pane is idle or done (send each its next step now):", `- ${items[1]!.line}`, `- ${items[2]!.line}`].join("\n"));
    expect(items).toEqual([{ key: "utilization", kind: "UTILIZATION", line: text, always: true },
      expect.objectContaining({ key: "plan:clipboard:d", kind: "PLAN", plan: "clipboard:d", pane: andy.id, line: expect.stringContaining("Andy done · next: 2. Step 2 (PENDING): send it to Andy now") }),
      expect.objectContaining({ key: "plan:clipboard:i", kind: "PLAN", plan: "clipboard:i", pane: bob.id, line: expect.stringContaining("Bob idle · next: 2. Step 2 (IN_PROGRESS): send it to Bob now") })]);
    // Not stalled: the stalled nudges stay as they were.
    expect(f.standing.mock.calls.filter((call) => (call as unknown[])[1] === "STANDING")).toHaveLength(0);
  });

  it("asks the review again after a FAILED or STOPPED review turn, never while one runs or waits, never after a review that ran, at most 3 failed turns a day (R10-19)", async () => {
    // 29/10 Bangkok: the REVIEW failed at 22:38 UTC during the Space Gateway outage and nothing asked again; the day was measured by hand.
    const on = nousSettingsSchema.parse({ enabled: true });
    const f = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] });
    f.state.settings = on;
    const failedAt = (id: string, at: number, status: NousTurnFacts["status"] = "FAILED") => facts(id, "REVIEW", iso(at), { status, endedAt: iso(at + 2 * MIN) });
    f.state.facts = [facts("yesterday", "REVIEW", iso(T0 - 26 * 3_600_000))];
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(1);
    // The turn failed, and the service's own retry waits in its queue: nothing is asked meanwhile.
    f.state.facts.push(failedAt("r1", T0));
    f.state.reviewBusy = true;
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(1);
    // The retry failed too (STOPPED counts the same) and nothing runs: the next tick asks again.
    f.state.facts.push(failedAt("r2", T0 + 11 * MIN, "STOPPED"));
    f.state.reviewBusy = false;
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(2);
    expect(f.standing.mock.calls[1]![1]).toBe("REVIEW");
    // Asked and not ended yet: the next tick waits.
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(2);
    // A third failed turn that day: no more retries until tomorrow.
    f.state.facts.push(failedAt("r3", T0 + 31 * MIN));
    for (let tick = 0; tick < 3; tick += 1) { f.advance(10 * MIN); await f.orders.tickOwner(owner); }
    expect(f.standing).toHaveBeenCalledTimes(2);
    // After a restart: a FAILED row of today alone is asked again; one that ran (DONE) is the day's review; a running one waits.
    const restarted = (rows: NousTurnFacts[], busy = false) => { const g = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] });
      g.state.settings = on; g.state.facts = rows; g.state.reviewBusy = busy; return g; };
    const retry = restarted([failedAt("f1", T0 - 3 * 3_600_000)]);
    await retry.orders.tickOwner(owner);
    expect(retry.standing).toHaveBeenCalledTimes(1);
    const ran = restarted([failedAt("f1", T0 - 3 * 3_600_000), facts("d1", "REVIEW", iso(T0 - 2 * 3_600_000))]);
    await ran.orders.tickOwner(owner);
    expect(ran.standing).not.toHaveBeenCalled();
    const running = restarted([failedAt("f1", T0 - 3 * 3_600_000)], true);
    await running.orders.tickOwner(owner);
    expect(running.standing).not.toHaveBeenCalled();
  });

  it("counts a TIMEOUT review only when it wrote its findings; a bare one is retried once (R11-7)", async () => {
    const on = nousSettingsSchema.parse({ enabled: true });
    const restarted = (rows: NousTurnFacts[]) => { const g = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] }); g.state.settings = on; g.state.facts = rows; return g; };
    const timeout = (id: string, at: number, tools: NousTurnFacts["tools"] = {}) => facts(id, "REVIEW", iso(at), { status: "TIMEOUT", endedAt: iso(at + 20 * MIN), tools });
    // It wrote its note (or appended to queue.md): the day's review.
    const wroteNote = restarted([timeout("t1", T0 - 3 * 3_600_000, { space_note: { calls: 1, failed: 0, refused: 0 } })]);
    await wroteNote.orders.tickOwner(owner);
    expect(wroteNote.standing).not.toHaveBeenCalled();
    // A timeout that wrote nothing is asked again once; a second bare timeout ends the day's retries.
    const bare = restarted([timeout("t1", T0 - 3 * 3_600_000, { space_world: { calls: 4, failed: 0, refused: 0 }, space_note: { calls: 1, failed: 1, refused: 0 } })]);
    await bare.orders.tickOwner(owner);
    expect(bare.standing).toHaveBeenCalledTimes(1);
    const twice = restarted([timeout("t1", T0 - 3 * 3_600_000), timeout("t2", T0 - 2 * 3_600_000)]);
    await twice.orders.tickOwner(owner);
    expect(twice.standing).not.toHaveBeenCalled();
  });

  it("starts the review once per local day at or after the chosen hour, never twice while it runs, and not on a day a REVIEW turn already ran", async () => {
    // T0 is 10:00 UTC = 17:00 Bangkok; the review hour is 3, so today's review is due and no REVIEW turn ran today.
    const on = nousSettingsSchema.parse({ enabled: true });
    const f = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] });
    f.state.settings = on;
    f.state.facts = [facts("old", "REVIEW", iso(T0 - 26 * 3_600_000)), facts("t1", "OPERATOR", iso(T0 - 2 * 3_600_000), { tools: { space_git: { calls: 1, failed: 1, refused: 0 } } })];
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(1);
    expect(f.standing.mock.calls[0]![1]).toBe("REVIEW");
    expect(f.text()).toContain("- Tools that failed most: space_git 1 of 1");
    // The next tick of the same day asks nothing more (the review runs or ran), even before its facts row exists.
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(1);
    // A restart forgets the day, but a REVIEW facts row of today says it ran.
    const again = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] });
    again.state.settings = on;
    again.state.facts = [facts("today", "REVIEW", iso(T0 - 3 * 3_600_000))];
    await again.orders.tickOwner(owner);
    expect(again.standing).not.toHaveBeenCalled();
    // Before the hour nothing starts: 19:30 UTC the day before is 02:30 Bangkok.
    const early = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] });
    early.state.settings = on;
    early.advance(Date.parse("2026-10-21T19:30:00.000Z") - T0);
    await early.orders.tickOwner(owner);
    expect(early.standing).not.toHaveBeenCalled();
    // Off in Settings: nothing, whatever the hour.
    const off = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }] });
    await off.orders.tickOwner(owner);
    expect(off.standing).not.toHaveBeenCalled();
  });
});

describe("the standing orders tick", () => {
  it("lists a browser pane and a plain shell unused 30 minutes to close without a save, leaves a held browser alone, and shows a crowded browser's tabs (operator 27/10)", async () => {
    const web = cli("pane:web00001", "Web", { mode: "BROWSER", terminalRuntimeId: null, updatedAt: iso(T0 - 90 * MIN) } as Partial<Pane>);
    const held = cli("pane:held0001", "Held", { mode: "BROWSER", terminalRuntimeId: null, updatedAt: iso(T0 - 90 * MIN) } as Partial<Pane>);
    const shell = cli("pane:sh000001", "Shell", { terminalRuntimeId: "shell", updatedAt: iso(T0 - 90 * MIN) } as Partial<Pane>);
    const browsers = new Map<string, CloseoutBrowser>([[web.id, { tabs: 7, held: null, activeAt: iso(T0 - 40 * MIN) }], [held.id, { tabs: 1, held: "handoff", activeAt: iso(T0 - 50 * MIN) }],
      [andy.id, { tabs: 5, held: null, activeAt: iso(T0 - 2 * MIN) }]]);
    const f = fixture({ panes: [{ pane: andy, state: "done", since: iso(T0 - 31 * MIN) }, { pane: web, state: "idle", since: null }, { pane: held, state: "idle", since: null }, { pane: shell, state: "idle", since: null }], browsers });
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 3, stalledPlans: 0, turn: "STARTED" });
    const text = f.text();
    expect(text).toContain("## Finished panes (operator rule: a pane with an AI CLI saves to memory, then closes; every other pane closes at once; keep one open only with KEEP_OPEN and a reason)");
    // The AI CLI pane still saves first; its crowded browser shows so its finished tabs close if it stays open.
    expect(text).toContain(`- Main/Andy · done 31 min · browser: 5 tabs (kept open: have it close the finished ones, browser hygiene) · save not asked yet → send it exactly "${NOUS_SAVE_TEXT}"`);
    expect(text).toContain("- Main/Web · browser pane · unused 40 min · browser: 7 tabs (they close with it) · no CLI, nothing to save → close it (space_close_pane); still in use: space_pane_checked KEEP_OPEN with the reason and nextCheckInMinutes");
    expect(text).toContain("- Main/Shell · shell (no AI CLI) · unused 1.5 h · no CLI, nothing to save → close it (space_close_pane) after a look (space_read_pane: a command still running keeps it open); still in use:");
    expect(text).not.toContain("Main/Held");
    // Nous closed the browser pane (space_close_pane): no row is needed, and a closed pane leaves the board.
    await f.orders.closed(owner, [web.id]);
    expect(await f.closeouts.list(owner)).toEqual([]);
    f.state.panes = f.state.panes.filter((entry) => entry.pane.id !== web.id);
    f.advance(8 * 60 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.text()).not.toContain("Main/Web");
    // An unreadable browser list lists no pane without a CLI this tick; the CLI pane's line still comes.
    const blind = fixture({ panes: [{ pane: andy, state: "done", since: iso(T0 - 31 * MIN) }, { pane: web, state: "idle", since: null }], browsers: null });
    expect(await blind.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect(blind.text()).not.toContain("Main/Web");
  });

  it("asks Nous to re-check its own old card on a finished pane, and stays quiet once Nous records that the operator still owes it", async () => {
    const f = fixture({ notifications: [card("2026-10-19T13:32:00.000Z")] });
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 1, stalledPlans: 0, turn: "STARTED" });
    expect(f.text()).toContain("## Your cards on finished panes");
    expect(f.text()).toContain(`- Main/Andy · done 31 min · your card "Sign in to GitLab" [notification:card0001] since 2026-10-19 13:32 UTC still open → read the pane (space_pane_reports); `
      + "nothing left for the operator: resolve it (space_resolve_notification); still theirs: space_pane_checked WAITING_OPERATOR with nextCheckInMinutes");
    expect(f.text()).not.toContain("save not asked yet");
    f.state.checks = [check("WAITING_OPERATOR", iso(T0 + 24 * 60 * MIN))];
    f.advance(31 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 0, turn: null });
    // Resolved: the pane is an ordinary finished pane again.
    f.state.checks = [];
    f.state.notifications = [];
    f.advance(31 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.text()).toContain("save not asked yet");
  });

  it("asks Nous to send the save, verifies it from the pane's reports, asks for the close, and stops once Nous closed the pane", async () => {
    const f = fixture();
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 1, stalledPlans: 0, turn: "STARTED" });
    expect(f.standing).toHaveBeenCalledWith(owner, "STANDING", expect.stringContaining("# Standing orders (from Space, not the operator"));
    expect(f.text()).toContain(`- Main/Andy · done 31 min · save not asked yet → send it exactly "${NOUS_SAVE_TEXT}" (space_send_to_pane, when now)`);
    // The same unhandled line is not repeated within 30 minutes.
    f.advance(10 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 0, turn: null });
    // Nous sent "save to memory" (tools.ts): the pane works, then its turn ends with the memory id in its report.
    await f.orders.saveRequested(owner, room.id, [andy.id]);
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ paneId: andy.id, state: "SAVE_REQUESTED", requestedAt: iso(T0 + 10 * MIN) });
    f.state.panes = [{ pane: andy, state: "working", since: iso(T0 + 10 * MIN) }];
    f.advance(MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 0, turn: null });
    f.state.panes = [{ pane: andy, state: "done", since: iso(T0 + 12 * MIN) }];
    f.state.reports = [report(andy.id, iso(T0 + 12 * MIN), "Saved what I learned: space_memory:ab12cd34ef56.")];
    f.advance(3 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "VERIFIED", verifiedMemoryId: "space_memory:ab12cd34ef56" });
    expect(f.text()).toContain("- Main/Andy · done 2 min · save asked 10:10 UTC, verified space_memory:ab12cd34ef56 → close it now (space_close_pane)");
    // Nous closed it (tools.ts): the row is closed and the pane is gone from the board.
    await f.orders.closed(owner, [andy.id]);
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "CLOSED", reason: "closed by Nous after its memory save" });
    f.state.panes = [];
    f.advance(10 * MIN);
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 0, stalledPlans: 0, turn: null });
    expect(f.standing).toHaveBeenCalledTimes(2);
  });

  it("closes a pane whose save it verified itself, with no turn; a refused close, or work after the save, goes back to Nous (plan qH5emwVaV6yO step 10)", async () => {
    const closePane = vi.fn<NonNullable<StandingOrdersDeps["closePane"]>>(async () => true);
    const f = fixture({ closePane });
    await f.orders.saveRequested(owner, room.id, [andy.id]);
    f.state.panes = [{ pane: andy, state: "done", since: iso(T0 + 2 * MIN) }];
    f.state.reports = [report(andy.id, iso(T0 + 2 * MIN), "Saved what I learned: space_memory:ab12cd34ef56.")];
    f.advance(5 * MIN);
    // Verified this tick, the pane fresh from its save turn: closed at once, no STANDING turn.
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 0, stalledPlans: 0, turn: null });
    expect(closePane).toHaveBeenCalledWith(owner, room.id, andy.id);
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "CLOSED", reason: "closed by Space after its memory save" });
    expect(f.standing).not.toHaveBeenCalled();
    // The close refused (a needs-you card came, the room tool said no): Nous gets the line as before.
    const refused = fixture({ closePane: async () => false });
    await refused.orders.saveRequested(owner, room.id, [andy.id]);
    refused.state.panes = [{ pane: andy, state: "done", since: iso(T0 + 2 * MIN) }];
    refused.state.reports = f.state.reports;
    refused.advance(5 * MIN);
    expect(await refused.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect(refused.text()).toContain("verified space_memory:ab12cd34ef56 → close it now (space_close_pane)");
    // A needs-you on the pane keeps it open whatever the save; once answered, a pane that worked again since the save goes to Nous.
    closePane.mockClear();
    const waiting = fixture({ closePane });
    await waiting.orders.saveRequested(owner, room.id, [andy.id]);
    waiting.state.panes = [{ pane: andy, state: "done", since: iso(T0 + 2 * MIN) }];
    waiting.state.reports = f.state.reports;
    waiting.state.notifications = [{ id: "n1", paneId: andy.id, roomId: room.id, source: "AGENT", kind: "NEEDS_YOU", status: "OPEN", severity: "ATTENTION", payload: {}, updatedAt: iso(T0) } as unknown as SpaceNotification];
    waiting.advance(5 * MIN);
    await waiting.orders.tickOwner(owner);
    expect(closePane).not.toHaveBeenCalled();
    waiting.state.notifications = [];
    waiting.state.panes = [{ pane: andy, state: "done", since: iso(T0 + 40 * MIN) }];
    waiting.advance(40 * MIN);
    expect(await waiting.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect(waiting.text()).toContain("→ close it now (space_close_pane)");
    expect(closePane).not.toHaveBeenCalled();
    expect((await waiting.closeouts.list(owner))[0]).toMatchObject({ state: "VERIFIED" });
  });

  it("never closes a pane prompted since it finished, or with a prompt held or scheduled for it (13/11 Eva/Andy: closed 18 s after Nous typed its plan step)", async () => {
    const closePane = vi.fn<NonNullable<StandingOrdersDeps["closePane"]>>(async () => true);
    const eva = cli("pane:eva00001", "Eva");
    const verified = async (options: { prompts?: ReadonlySet<string> | null } = {}) => {
      const f = fixture({ closePane, panes: [{ pane: eva, state: "done", since: iso(T0 + 2 * MIN) }], ...options });
      noteSpacePrompt(eva.id, T0); // the save's own text, typed just before its row: not new work
      await f.orders.saveRequested(owner, room.id, [eva.id]);
      f.state.reports = [report(eva.id, iso(T0 + 2 * MIN), "Saved what I learned: space_memory:ab12cd34ef56.")];
      f.advance(5 * MIN);
      return f;
    };
    await (await verified()).orders.tickOwner(owner);
    expect(closePane).toHaveBeenCalledWith(owner, room.id, eva.id);
    closePane.mockClear();
    // Nous types the next plan step at +4 min; the dashboard still reads done since +2: kept, and no "close it now" line.
    const f = await verified();
    noteSpacePrompt(eva.id, T0 + 4 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 0, turn: null });
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "VERIFIED" });
    // Its turn ended after the prompt: no longer new, but it worked after the save, so Nous decides.
    f.state.panes = [{ pane: eva, state: "done", since: iso(T0 + 20 * MIN) }];
    f.advance(40 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.text()).toContain("Main/Eva · done 25 min · save asked 10:00 UTC, verified space_memory:ab12cd34ef56 → close it now");
    // A prompt held or scheduled for it, or a failed read of them, keeps it too.
    for (const prompts of [new Set([eva.id]), null]) await (await verified({ prompts })).orders.tickOwner(owner);
    // The operator's own line after it finished counts like Space's.
    const typed = await verified();
    noteOperatorPaneInput(eva.id, "και το επόμενο\r", T0 + 4 * MIN);
    await typed.orders.tickOwner(owner);
    expect(closePane).not.toHaveBeenCalled();
    expect([...promptsComing([
      { kind: "nous_held", actorId: owner, key: "pane:a", value: { status: "HELD" } },
      { kind: "schedule", actorId: owner, key: "s1", value: { status: "SCHEDULED", condition: "AT_TIME", command: { actions: [{ kind: "pane", operation: "continue", target: { paneIds: ["pane:b"] } }] } } },
      { kind: "schedule", actorId: owner, key: "s2", value: { status: "COMPLETED", command: { actions: [{ target: { paneIds: ["pane:c"] } }] } } },
      { kind: "schedule", actorId: "user:other", key: "s3", value: { status: "SCHEDULED", command: { actions: [{ target: { paneIds: ["pane:d"] } }] } } }
    ], owner)]).toEqual(["pane:a", "pane:b"]);
  });

  it("hands an unverified save back to Nous after 20 minutes: ask once more, then close or keep open", async () => {
    const f = fixture();
    await f.orders.saveRequested(owner, room.id, [andy.id]);
    f.advance(21 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect(f.text()).toContain(`save asked 10:00 UTC, not verified after 21 min → read its reports (space_pane_reports); ask once more with exactly "${NOUS_SAVE_RETRY_TEXT}", or record KEEP_OPEN`);
    await f.orders.saveRequested(owner, room.id, [andy.id]);
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "SAVE_RETRIED", retriedAt: iso(T0 + 21 * MIN) });
    f.advance(21 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect(f.text()).toContain("save asked 10:21 UTC, not verified after 21 min → read its reports (space_pane_reports); if the save is there, close it (space_close_pane), or record KEEP_OPEN");
    // KEEP_OPEN with a next check takes the pane off the list until then; a pane closed elsewhere ends its row.
    f.state.checks = [check("KEEP_OPEN", iso(T0 + 3 * 3_600_000))];
    f.advance(31 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 0, turn: null });
    // A room whose activity could not be read closes nothing.
    f.state.unread = true;
    await f.orders.tickOwner(owner);
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "SAVE_RETRIED" });
    f.state.unread = false;
    f.state.panes = [];
    await f.orders.tickOwner(owner);
    expect((await f.closeouts.list(owner))[0]).toMatchObject({ state: "CLOSED", reason: "closed elsewhere" });
  });

  it("brings a pane the board says waits on the operator back to Nous once it is finished 30 minutes, until Nous records the wait", async () => {
    const f = fixture({ summaries: [summary("OPERATOR", iso(T0 - 5 * MIN))] });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, turn: "STARTED" });
    expect(f.text()).toContain(`- Main/Andy · done 31 min · the board says it waits on operator ("…"), nothing is open for the operator → read it (space_pane_reports); its task done: send it exactly "${NOUS_SAVE_TEXT}"`);
    f.state.checks = [check("WAITING_OPERATOR", iso(T0 + 24 * 60 * MIN))];
    f.advance(31 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 0, turn: null });
  });

  it("keeps a pane whose task runs within the hour open, closes other task panes with a note, and brings nothing when the orders are off", async () => {
    const bob = cli("pane:bob00001", "Bob");
    const f = fixture({ panes: [{ pane: andy, state: "done", since: iso(T0 - 2 * 3_600_000) }, { pane: bob, state: "done", since: iso(T0 - 31 * MIN) }],
      tasks: [task(andy.id, { kind: "DAILY", nextRunAt: iso(T0 + 20 * MIN) }), { ...task(bob.id), id: "task:weekly001", title: "Weekly report" }] });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 1 });
    expect(f.text()).toContain('- Main/Andy · done · its task "Daily digest" runs within the hour: kept open (no action)');
    expect(f.text()).toContain('- Main/Bob · done 31 min · task "Weekly report": Space reopens the pane when it runs · save not asked yet');
    f.state.settings = nousSettingsSchema.parse({ enabled: true, standingOrders: { closeFinishedPanes: false, dailyReview: false } });
    f.advance(31 * MIN);
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 0, stalledPlans: 0, turn: null });
    expect(f.standing).toHaveBeenCalledTimes(1);
  });

  it("brings every stalled plan once per stalled window, and again when the turn could not start", async () => {
    const stalled = plan("clipboard:a", andy.id, 40, iso(T0 - 4 * 3_600_000));
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - 10 * MIN) }], plans: [stalled, plan("clipboard:b", andy.id, 10, iso(T0 - 30 * MIN))],
      standing: async () => "CAPPED" });
    expect(await f.orders.tickOwner(owner)).toEqual({ paneLines: 0, stalledPlans: 1, turn: "CAPPED" });
    expect(f.text()).toContain("## Stalled plans (operator rule: every open plan moves to 100%; take exactly one concrete action per plan now)");
    expect(f.text()).toContain('- [clipboard:a] "Plan a" IN_PROGRESS 40% · unchanged 4 h');
    expect(f.text()).not.toContain("clipboard:b");
    // Capped: not marked as nudged, so the next tick brings it again; started: marked, and quiet for the stalled window.
    f.standing.mockImplementation(async () => "STARTED");
    f.advance(10 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 1, turn: "STARTED" });
    f.advance(2 * 3_600_000);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 0, turn: null });
    // Eight hours on (the window is at least 8 h, operator 5/11 20:44 BKK), plan a comes again and plan b joins it.
    f.advance(6 * 3_600_000);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 2, turn: "STARTED" });
    expect(f.text()).toContain("clipboard:b");
  });

  it("leaves a plan the plan map holds on a date, another plan or the server out of the stalled nudges once its waiting steps are BLOCKED (2026-10-25; operator 3/11 23:11 BKK)", async () => {
    const stalled = plan("clipboard:a", andy.id, 40, iso(T0 - 4 * 3_600_000));
    const held = plan("clipboard:b", andy.id, 10, iso(T0 - 5 * 3_600_000), ["COMPLETED", "BLOCKED"]);
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - 10 * MIN) }], plans: [stalled, held], standing: async () => "STARTED",
      planMap: async (_owner, plans) => buildPlanMap({ plans: plans.map((item) => item.id === "clipboard:b" ? { ...item, waitsOn: { kind: "DATE", what: "the launch window", until: iso(T0 + 86_400_000) } } : item),
        executions: [], summaries: [], reports: [], holds: [], now: new Date(T0) }) });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 1, turn: "STARTED" });
    expect(f.text()).toContain("[clipboard:a]");
    expect(f.text()).not.toContain("[clipboard:b]");
  });

  it("operator 3/11 23:11 BKK: a plan behind another plan or a closed pane's wait, with a step that can run, is nudged; a hard server hold keeps every held plan out", async () => {
    // 3/11: 10 plans sat "Not on a pane" for hours; 6 had a dependsOn on an open plan, and the plan map's PLAN hold hid every step they could run.
    const root = plan("clipboard:r", andy.id, 40, iso(T0 - 10 * MIN));
    const leaf = { ...plan("clipboard:l", "pane:gone0001", 60, iso(T0 - 10 * MIN)), dependsOn: ["clipboard:r"] } as ClipboardItem;
    const holds: NousGlobalHold[] = [];
    const f = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - 5 * MIN) }], plans: [root, leaf], standing: async () => "STARTED",
      planMap: async (_owner, plans) => buildPlanMap({ plans, executions: [], summaries: [], reports: [], holds, now: new Date(T0) }) });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 1, turn: "STARTED" });
    expect(f.text()).toContain("- [clipboard:l] \"Plan l\" IN_PROGRESS 60% · unchanged 0.2 h");
    expect(f.text()).toContain("no open pane · STALLED: no open pane · its plan waits on another plan: Plan r: that wait covers only the steps it names");
    // The merge queue paused: nothing that waits is nudged until it clears.
    holds.push({ kind: "QUEUE_PAUSED", text: "The dev merge queue is paused.", since: iso(T0) });
    f.advance(4 * 3_600_000);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 0 });
  });

  it("the push: open requests whose pane is done or gone 30+ min come with the plans as items, never one whose pane works or rested less (operator 3/11 23:11 BKK)", async () => {
    const low = vi.fn(async () => "Utilization stayed under the 90% target for 15 min.");
    const request = (key: string, extra: Partial<SweepRequest>): SweepRequest => ({ key, messageId: `nous_msg:${key}`, words: `request ${key}`, openedAt: iso(T0 - 3 * 60 * MIN), ...extra });
    const open = [request("gone", { pane: "pane:gone0001" }), request("idle", { pane: andy.id, paneName: "Andy", paneState: "idle", paneSince: iso(T0 - 40 * MIN) }),
      request("fresh", { pane: andy.id, paneName: "Andy", paneState: "idle", paneSince: iso(T0 - 10 * MIN) }), request("busy", { pane: andy.id, paneName: "Andy", paneState: "working", paneSince: iso(T0 - 90 * MIN) })];
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - 40 * MIN) }], utilizationLow: low,
      requests: { zone: async () => "UTC", open: async () => open, progress: async () => {} } });
    f.state.settings = nousSettingsSchema.parse({ enabled: true });
    await f.orders.tickOwner(owner);
    const [, , text, items] = f.notice.mock.calls.find((call) => (call as unknown[])[1] === "utilization-low") as unknown as [string, string, string, Array<Record<string, unknown>>];
    expect(text).toContain("Open requests whose pane is done or gone 30+ min:");
    expect(items.slice(1)).toEqual([expect.objectContaining({ key: "request:gone", kind: "REQUEST", requestKey: "gone", messageId: "nous_msg:gone", line: expect.stringContaining("pane:gone0001 closed or gone") }),
      expect.objectContaining({ key: "request:idle", paneName: "Andy", line: expect.stringContaining("Andy idle since") })]);
  });

  it("runs each owner on its own interval from the minute tick, and the Away round every 30 minutes while the operator is away", async () => {
    const f = fixture({ panes: [], away: true });
    await f.orders.tick();
    expect(f.standing).toHaveBeenCalledWith(owner, "HEARTBEAT", expect.stringMatching(/^Away round: 0 open plans; look over the plans and the panes/));
    f.advance(5 * MIN);
    await f.orders.tick();
    expect(f.standing).toHaveBeenCalledTimes(1);
    f.advance(6 * MIN);
    await f.orders.tick();
    expect(f.standing).toHaveBeenCalledTimes(1);
    f.advance(20 * MIN);
    await f.orders.tick();
    expect(f.standing).toHaveBeenCalledTimes(2);
    f.state.settings = nousSettingsSchema.parse({ enabled: false });
    f.advance(31 * MIN);
    await f.orders.tick();
    expect(f.standing).toHaveBeenCalledTimes(2);
  });
});

describe("standing orders with low Claude quota", () => {
  it("skips stalled-plan nudges while conserving, keeps save/close checks, and nudges after recovery", async () => {
    const stalled = plan("clipboard:stalled", null, 40, iso(T0 - 4 * 3_600_000));
    const f = fixture({ plans: [stalled] });
    f.state.lowToken = true;
    expect(await f.orders.tickOwner(owner)).toMatchObject({ paneLines: 1, stalledPlans: 0, turn: "STARTED" });
    expect(f.text()).toContain("save not asked yet");
    expect(f.text()).not.toContain("clipboard:stalled");
    const marks = await f.marks.observe(owner, [{ planId: stalled.id, percent: 40, since: iso(T0 - 4 * 3_600_000) }]);
    expect(marks.get(stalled.id)?.lastNudgedAt).toBeNull();
    f.state.lowToken = false;
    f.advance(11 * MIN);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 1, turn: "STARTED" });
    expect(f.text()).toContain("clipboard:stalled");
  });
});

describe("standing orders move work on their own (plan clipboard:ZWJJdBgHm64Z, operator 31/10 22:19 BKK)", () => {
  const H = 3_600_000;
  it("B: in LOW nudges the stalled plans whose pane runs on a pool the Provider advice does not avoid; CRITICAL skips them all", async () => {
    // 31/10 from 22:18 BKK: LOW while Claude Max still had 79 % of its week and Codex was the pool short of room, and every plan stopped.
    const cody = cli("pane:cody0001", "Cody", { terminalRuntimeId: "cli:codex" });
    const panes: PaneState[] = [{ pane: andy, state: "working", since: iso(T0 - MIN) }, { pane: cody, state: "working", since: iso(T0 - MIN) }];
    const plans = [plan("clipboard:onclaude", andy.id, 40, iso(T0 - 4 * H)), plan("clipboard:oncodex", cody.id, 40, iso(T0 - 4 * H)), plan("clipboard:nopane", null, 40, iso(T0 - 4 * H))];
    const f = fixture({ panes, plans, spend: { mode: "LOW", avoid: ["codex"] } });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 2, turn: "STARTED" });
    expect(f.text()).toContain("clipboard:onclaude");
    expect(f.text()).toContain("clipboard:nopane");
    expect(f.text()).not.toContain("clipboard:oncodex");
    // Hold A: each nudged plan is an item of that turn.
    expect((f.standing.mock.calls.at(-1)![3] as { items: Array<{ key: string; kind: string; pane?: string }> }).items).toEqual([
      expect.objectContaining({ key: "plan:clipboard:onclaude", kind: "PLAN", plan: "clipboard:onclaude", pane: andy.id }),
      expect.objectContaining({ key: "plan:clipboard:nopane", kind: "PLAN", plan: "clipboard:nopane" })]);
    const critical = fixture({ panes, plans, spend: { mode: "CRITICAL", avoid: [] } });
    expect(await critical.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 0 });
  });

  it("C: by day, when one changes (at most every 30 minutes; unchanged every 8 hours), lists every open request with its pane, report and evidence; the ones not moving are items; D keeps the 09:00 count", async () => {
    // T0 is 17:00 in Bangkok. Request a looks finished (its pane idle); request b's pane works: listed, no item.
    const open: SweepRequest[] = [
      { key: "request-done:open:a", messageId: "nous_msg:aaaaaaaaaaaaaaaaaaaaaaaa", words: "Quotas tab: share left at reset", plan: "clipboard:quota1", pane: andy.id, paneName: "Main/Andy",
        paneState: "idle", paneSince: iso(T0 - 2 * H), report: "08:00 UTC done: live on dev", evidence: "plan clipboard:quota1 is 100% (completed)", openedAt: iso(T0 - 5 * H) },
      { key: "request-done:open:b", messageId: "nous_msg:bbbbbbbbbbbbbbbbbbbbbbbb", words: "Write the brief", pane: "pane:cody0001", paneName: "Main/Cody", paneState: "working",
        paneSince: iso(T0 - 10 * MIN), report: null, evidence: null, openedAt: iso(T0 - H) }];
    let requests = open;
    const progress = vi.fn(async () => {});
    const f = fixture({ panes: [{ pane: andy, state: "working", since: iso(T0 - MIN) }], requests: { zone: async () => "Asia/Bangkok", open: async () => requests, progress } });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ turn: "STARTED" });
    expect(progress).toHaveBeenCalledWith(owner, "2026-10-21", "09:00");
    expect(f.text()).toContain("## Open requests (requests sweep by day when one changes, unchanged every 8 hours;");
    expect(f.text()).toContain("- [nous_msg:aaaaaaaaaaaaaaaaaaaaaaaa] «Quotas tab: share left at reset» · open 5 h · clipboard:quota1 · Main/Andy idle since 08:00 UTC · newest report 08:00 UTC done: live on dev · looks finished: plan clipboard:quota1 is 100% (completed)");
    expect(f.text()).toContain("«Write the brief» · open 1 h · Main/Cody working since 09:50 UTC · no report");
    expect((f.standing.mock.calls.at(-1)![3] as { items: Array<{ key: string }> }).items.map((item) => item.key)).toEqual(["request:request-done:open:a"]);
    // At most every 30 minutes, and only on a change (operator 5/11 20:44 BKK): the same requests in the same states wait 8 hours.
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(1);
    f.advance(21 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(1);
    requests = [open[0]!, { ...open[1]!, paneState: "idle", report: "10:20 UTC brief written" }];
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(2);
    expect(f.text()).toContain("Main/Cody idle since 09:50 UTC · newest report 10:20 UTC brief written");
    expect(progress).toHaveBeenCalledTimes(1);
    // Nothing open: no turn. At night (00:00 in Bangkok): no sweep.
    requests = [];
    f.advance(31 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(2);
    requests = open;
    f.advance(6 * H);
    await f.orders.tickOwner(owner);
    expect(f.standing).toHaveBeenCalledTimes(2);
  });

  it("D: the REVIEW reports the In progress counts kept at 09:00 and 21:00 and the requests with no act for 6 hours", () => {
    const text = renderDailyReview({ facts: [], decisions: [], since: "2026-10-30T20:00:00.000Z", day: "2026-11-01", hour: 3,
      requests: { progress: [{ day: "2026-10-31", slot: "09:00", count: 35 }, { day: "2026-10-31", slot: "21:00", count: 12 }], open: 19, quiet: 4 } });
    expect(text).toContain("## Operator requests (they move on your own, plan clipboard:ZWJJdBgHm64Z)");
    expect(text).toContain("- In progress (the Requests tab): 2026-10-31 09:00 35, 2026-10-31 21:00 12; open now: 19; open more than 6 h with no act: 4 (each one is a miss");
    expect(renderDailyReview({ facts: [], decisions: [], since: "2026-10-30T20:00:00.000Z", day: "2026-11-01", hour: 3 })).not.toContain("## Operator requests");
  });

  it("R22-5 (goal 35813e48 «Μην αφήνεις για αύριο ότι μπορείς να κάνεις σήμερα τώρα!!»): the REVIEW lists the day's deferrals, justified or not, and counts the misses", async () => {
    // The tools record each deferral on their row: a plan's or goal's DATE wait, a follow-up on a time.
    const plan = { id: "clipboard:plan0001", source: "PLAN", title: "S6 push proof", executionStatus: "IN_PROGRESS", progressPercentage: 40, steps: [],
      waitsOn: { kind: "DATE", what: "Push proof held by quiet hours", until: "2026-11-01T02:00:00.000Z" } } as unknown as ClipboardItem;
    const followups = createNousFollowups({ repository: new InMemoryNousFollowupsRepository(), notice: async () => {} });
    const tools = createNousTools({ plans: { get: async () => plan, update: async () => plan }, followups } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r225", callId: "call:1", traceId: "trace:1" };
    expect((await tools.execute("space_plan_update", { plan: plan.id, waitsOn: { kind: "DATE", what: "Push proof held by quiet hours", until: "2026-11-01T09:00:00+07:00" } }, ctx)).meta)
      .toEqual({ deferral: { kind: "PLAN", id: plan.id, until: "2026-11-01T02:00:00.000Z", what: "Push proof held by quiet hours" } });
    expect((await tools.execute("space_plan_update", { plan: plan.id, progressPercentage: 50 }, ctx)).meta).toBeUndefined();
    // Queue items 846 + 915: a time follow-up over an hour that names no real hold needs its reason, which the record keeps.
    expect((await tools.execute("space_nous_followup", { op: "add", note: "Check Bob's merge", inMinutes: 180, reason: "Bob's CI run needs 3 h" }, ctx)).meta)
      .toMatchObject({ deferral: { kind: "FOLLOWUP", id: expect.stringMatching(/^nous_followup:/), what: "Check Bob's merge (wait reason: Bob's CI run needs 3 h)" } });

    const since = "2026-10-31T20:00:00.000Z";
    const deferral = (at: string, kind: NousDeferral["kind"], id: string, until: string, what: string): NousDeferral => ({ at, kind, id, until, what });
    const text = renderDailyReview({ facts: [], decisions: [], since, day: "2026-11-01", hour: 3, deferrals: [
      deferral("2026-10-31T21:39:00.000Z", "PLAN", "clipboard:plan0001", "2026-11-01T02:00:00.000Z", "Push proof held by quiet hours"),
      deferral("2026-10-31T22:10:00.000Z", "GOAL", "nous_goal:35813e48", "2026-11-01T03:00:00.000Z", "Retry the Job CV gaps in the morning"),
      deferral("2026-10-31T22:20:00.000Z", "FOLLOWUP", "nous_followup:aaaaaa", "2026-11-01T01:20:00.000Z", "Check Bob's merge"),
      deferral("2026-10-31T22:30:00.000Z", "PLAN", "clipboard:plan0002", "2026-11-03T09:00:00.000Z", "NVIDIA sign-in needs the operator's 2FA code"),
      deferral("2026-10-31T22:40:00.000Z", "GOAL", "nous_goal:ee5a573e", "2026-11-02T09:00:00.000Z", "Waits for Telnyx support's reply"),
      deferral("2026-10-31T22:50:00.000Z", "PLAN", "clipboard:plan0003", "2026-11-01T00:00:00.000Z", "Codex weekly limit resets at 00:00 UTC"),
      deferral("2026-10-31T23:00:00.000Z", "PLAN", "clipboard:plan0004", "2026-11-05T09:00:00.000Z", "The interview is on 2026-11-05"),
      // A follow-up an hour or less ahead is a check, and a deferral before the window is yesterday's.
      deferral("2026-10-31T23:10:00.000Z", "FOLLOWUP", "nous_followup:bbbbbb", "2026-11-01T00:00:00.000Z", "Read Andy's report"),
      deferral("2026-10-31T19:00:00.000Z", "PLAN", "clipboard:old00001", "2026-11-01T09:00:00.000Z", "Old")] });
    const section = text.slice(text.indexOf("## Deferrals today"), text.indexOf("## Orders"));
    expect(section.split("\n").filter(Boolean)).toEqual([
      "## Deferrals today (goal 35813e48: nothing left for tomorrow that can run today; DATE waits on plans and goals, follow-ups over an hour ahead)",
      '- 2026-10-31 21:39 UTC plan clipboard:plan0001 until 2026-11-01T02:00:00.000Z: "Push proof held by quiet hours" → justified (quiet hours)',
      '- 2026-10-31 22:10 UTC goal nous_goal:35813e48 until 2026-11-01T03:00:00.000Z: "Retry the Job CV gaps in the morning" → COULD HAVE RUN TODAY',
      '- 2026-10-31 22:20 UTC followup nous_followup:aaaaaa until 2026-11-01T01:20:00.000Z: "Check Bob\'s merge" → COULD HAVE RUN TODAY',
      '- 2026-10-31 22:30 UTC plan clipboard:plan0002 until 2026-11-03T09:00:00.000Z: "NVIDIA sign-in needs the operator\'s 2FA code" → justified (the operator\'s hands)',
      '- 2026-10-31 22:40 UTC goal nous_goal:ee5a573e until 2026-11-02T09:00:00.000Z: "Waits for Telnyx support\'s reply" → justified (a third party)',
      '- 2026-10-31 22:50 UTC plan clipboard:plan0003 until 2026-11-01T00:00:00.000Z: "Codex weekly limit resets at 00:00 UTC" → justified (a cap or quota reset)',
      '- 2026-10-31 23:00 UTC plan clipboard:plan0004 until 2026-11-05T09:00:00.000Z: "The interview is on 2026-11-05" → justified (a real date)',
      "- Could have run today: 2 of 7 (each one is a miss: run it in this turn, or record what really holds it)"]);
    expect(text).toContain("every deferral that could have run today");
    expect(renderDailyReview({ facts: [], decisions: [], since, day: "2026-11-01", hour: 3, deferrals: [] })).toContain("## Deferrals today (goal 35813e48: nothing left for tomorrow that can run today; DATE waits on plans and goals, follow-ups over an hour ahead)\n- none\n- Could have run today: 0 of 0");
    expect(renderDailyReview({ facts: [], decisions: [], since, day: "2026-11-01", hour: 3 })).not.toContain("## Deferrals today");
  });

  it("2026-11-02 REVIEW: a wait on the batched promote, a ticket or low-spend is justified, and a plan wait names its open steps when no pane works on them", async () => {
    const at = "2026-11-01T21:00:00.000Z";
    const lines = deferralLines([
      { at, kind: "FOLLOWUP", id: "nous_followup:cccccc", until: "2026-11-01T23:00:00.000Z", what: "Promote dev once the 23:55 BKK batch is due (rule 04c051fe)" },
      { at, kind: "FOLLOWUP", id: "nous_followup:dddddd", until: "2026-11-01T23:00:00.000Z", what: "Read q-20261101-203918-36f6 once it is DEPLOYED" },
      { at, kind: "PLAN", id: "clipboard:plan0005", until: "2026-11-02T01:00:00.000Z", what: "Low-spend LOW: Claude windows full" }], "2026-11-01T20:00:00.000Z");
    expect(lines.slice(0, 3).map((line) => line.split("→ ")[1])).toEqual(["justified (the promote cadence or a ticket)", "justified (the promote cadence or a ticket)", "justified (a cap or quota reset)"]);
    // Daily self-upgrade 5/11: a wait the run-now gate let through on Nous's reason is Nous's judgment, not a miss for a code item.
    const reasoned = deferralLines([
      { at, kind: "FOLLOWUP", id: "nous_followup:eeeeee", until: "2026-11-01T23:00:00.000Z", what: "Check the Reddit post (wait reason: the subreddit's posting slot)" },
      { at, kind: "GOAL", id: "nous_goal:35813e48", until: "2026-11-02T01:00:00.000Z", what: "Goal reminder (reason: the operator asked for the evening)" },
      { at, kind: "PLAN", id: "clipboard:plan0007", until: "2026-11-02T01:00:00.000Z", what: "Measure tomorrow" }], "2026-11-01T20:00:00.000Z");
    expect(reasoned.map((line) => line.split("→ ")[1] ?? line)).toEqual(["HELD ONLY BY YOUR REASON", "justified (the operator's hands)", "COULD HAVE RUN TODAY",
      "- Could have run today: 1 of 3 (each one is a miss: run it in this turn, or record what really holds it)",
      "- Held only by the reason you gave: 1 (judge each: a reason that holds nothing is a lesson and the work runs now; no code item)"]);
    const plan = { id: "clipboard:plan0006", source: "PLAN", title: "Proof", executionStatus: "IN_PROGRESS", progressPercentage: 40, roomId: "room:main0001", paneId: "pane:andy0001",
      steps: [{ order: 1, title: "Build", status: "COMPLETED" }, { order: 2, title: "Measure", status: "PENDING" }],
      waitsOn: { kind: "DATE", what: "Measure tomorrow", until: "2026-11-02T02:00:00.000Z" } } as unknown as ClipboardItem;
    const andy = { id: "pane:andy0001", roomId: "room:main0001", isClosed: false } as unknown as Pane;
    let state = "IDLE";
    const tools = createNousTools({ plans: { get: async () => plan, update: async () => plan }, listPanes: async () => [andy],
      inspectPane: async () => ({ state }) } as unknown as NousToolDeps);
    const ctx = { owner: "user:operator", turnId: "nous_turn:r31", callId: "call:1", traceId: "trace:1" };
    const wait = () => tools.execute("space_plan_update", { plan: plan.id, waitsOn: { kind: "DATE", what: "Measure tomorrow", until: "2026-11-02T02:00:00.000Z" } }, ctx);
    expect((await wait()).result).toContain('This wait holds the whole plan and no pane works on it now; still open: step 2 "Measure".');
    state = "RUNNING";
    expect((await wait()).result).not.toContain("This wait holds the whole plan");
  });
});

describe("the pendings list at the operator's times (R13-9, goal ab5f85bd)", () => {
  it("brings ONE pendings turn per slot in the operator's day, only when something waits, never twice within 3 hours or in quiet hours", async () => {
    // Nous 29/10 13:15 BKK: the 3-hour pendings list was a chain of follow-ups that a lost turn broke.
    let clock = Date.parse("2026-10-29T03:00:00.000Z"); // 10:00 in Bangkok: slot 09:50
    let quiet = false;
    // R21-asklast-pendings: an item's account facts are listed under it.
    let waiting = [{ id: "nous_decision:abc", title: 'decision "Send the Upwork reply?"', since: "2026-10-29T01:00:00.000Z", where: null,
      facts: ["Vault login for upwork.com: an agent signs in (space_vault_fill); not the operator's"] }];
    const posted: string[] = [];
    const standing = vi.fn<StandingOrdersDeps["standing"]>(async (_owner, _reason, _text, options) => { posted.push(new Date(clock).toISOString()); void options; return "STARTED"; });
    const orders = createStandingOrders({ closeouts: new InMemoryNousPaneCloseoutsRepository(), marks: new InMemoryNousPlanMarksRepository(),
      settings: async () => nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false, closeFinishedPanes: false } }), owners: async () => [owner],
      collect: async () => ({ rooms: [], reports: [], notifications: [], decisions: [], copilotItems: [], plans: [], checks: [], tasks: [], executions: [], summaries: [] }),
      reportsSince: async () => [], lowToken: async () => false, standing, notice: vi.fn(async () => {}), now: () => clock,
      pendings: { waiting: async () => waiting, clock: async () => ({ zone: "Asia/Bangkok", quiet }), lastAt: async () => posted.at(-1) ?? null } });
    const tick = async (minutes: number) => { clock += minutes * 60_000; await orders.tick(); };
    await orders.tick();
    expect(standing).toHaveBeenCalledTimes(1);
    const [, reason, text, options] = standing.mock.calls[0]!;
    expect(reason).toBe("STANDING");
    expect(text).toContain("# Pendings list (from Space at the operator's 09:50");
    expect(text).toContain('- [nous_decision:abc] decision "Send the Upwork reply?" · 2 h\n  · Vault login for upwork.com: an agent signs in (space_vault_fill); not the operator\'s');
    expect(text).toContain("what they say an agent does (a Vault login, a Vault unlock) is not the operator's");
    expect(options).toEqual({ meta: { pendingsList: "2026-10-29 09:50" } });
    await tick(11);
    expect(standing).toHaveBeenCalledTimes(1);
    // 12:50 is 2 h 50 min after the list: under 3 hours, so none; 15:50 brings the next.
    await tick(2 * 60 + 40);
    expect(standing).toHaveBeenCalledTimes(1);
    await tick(3 * 60);
    expect(standing).toHaveBeenCalledTimes(2);
    // Nothing waiting, or quiet hours: no turn.
    waiting = [];
    await tick(3 * 60);
    quiet = true;
    waiting = [{ id: "nous_decision:def", title: "decision", since: null as never, where: null }];
    await tick(3 * 60);
    expect(standing).toHaveBeenCalledTimes(2);
  });
});

describe("R43-1: roomCloseouts lists a room's finished panes, oldest finished first, closable only with a verified save", () => {
  it("closes a pane whose save was verified after its last work; never a stale save, a Mail Copilot or a KEEP_OPEN pane", async () => {
    const bob = cli("pane:bob00001", "Bob"); const cody = cli("pane:cody0001", "Cody"); const dana = cli("pane:dana0001", "Dana");
    const emma = cli("pane:mail0001", "Emma", { mode: "MAIL_COPILOT" } as Partial<Pane>);
    const f = fixture({
      panes: [{ pane: andy, state: "done", since: iso(T0 - 40 * MIN) }, { pane: bob, state: "done", since: iso(T0 - 50 * MIN) },
        { pane: cody, state: "done", since: iso(T0 - 60 * MIN) }, { pane: dana, state: "done", since: iso(T0 - 70 * MIN) },
        { pane: emma, state: "idle", since: iso(T0 - 3 * 24 * 60 * MIN) }],
      checks: [{ ...check("KEEP_OPEN", iso(T0 + 60 * MIN)), paneId: dana.id }]
    });
    const row = (paneId: string, at: number) => ({ paneId, roomId: room.id, state: "VERIFIED" as const, requestedAt: iso(at - MIN), retriedAt: null,
      verifiedMemoryId: `space_memory:${paneId.slice(5, 9)}`, closedAt: null, reason: null, updatedAt: iso(at) });
    await f.closeouts.save(owner, row(andy.id, T0 - 30 * MIN));
    await f.closeouts.save(owner, row(bob.id, T0 - 55 * MIN)); // verified before Bob's last work ended
    await f.closeouts.save(owner, row(dana.id, T0 - 60 * MIN));
    const list = await f.orders.roomCloseouts(owner, room.id);
    expect(list.map((entry) => entry.pane.paneName)).toEqual(["Emma", "Dana", "Cody", "Bob", "Andy"]);
    const by = Object.fromEntries(list.map((entry) => [entry.pane.paneName, entry]));
    expect(by.Andy).toMatchObject({ closable: true, idleMinutes: 40, save: "save verified space_memory:andy" });
    expect(by.Bob).toMatchObject({ closable: false, save: expect.stringContaining("not verified") });
    expect(by.Cody).toMatchObject({ closable: false, save: "save not asked" });
    expect(by.Dana).toMatchObject({ closable: false, skip: "keep-open" });
    expect(by.Emma).toMatchObject({ closable: false, skip: "always-on" });
  });
});
