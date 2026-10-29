import { describe, expect, it, vi } from "vitest";
import { nousSettingsSchema, type ClipboardItem, type NousDecision, type Pane, type Room, type SpaceNotification, type TaskItem } from "@space/contracts";
import { InMemoryNousPaneCloseoutsRepository, InMemoryNousPlanMarksRepository, type NousPaneCheck, type NousPaneSummaryRow, type PaneReport } from "@space/db";
import type { DashboardAgentsSample } from "../src/room-routes.js";
import type { BoardPaneInput } from "../src/nous/pane-board.js";
import { closeoutSince, closeoutSkipReason, createStandingOrders, keptOpenForTask, NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT, savesToMemory, verifyMemorySave, type CloseoutBrowser, type StandingOrdersDeps } from "../src/nous/standing-orders.js";
import { localDayHour, renderDailyReview } from "../src/nous/daily-review.js";
import { decisionPrediction } from "../src/nous/predictions.js";
import { buildPlanMap } from "../src/nous/plan-map.js";
import type { NousTurnFacts } from "@space/contracts";

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
  dedupeKey: `nous:pane:${andy.id}`, title: "Sign in to GitLab", updatedAt }) as unknown as SpaceNotification;
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
  browsers?: Map<string, CloseoutBrowser> | null } = {}) {
  let clock = T0;
  const closeouts = new InMemoryNousPaneCloseoutsRepository();
  const marks = new InMemoryNousPlanMarksRepository();
  const state = { panes: options.panes ?? [{ pane: andy, state: "done", since: iso(T0 - 31 * MIN) }], plans: options.plans ?? [], tasks: options.tasks ?? [], reports: options.reports ?? [],
    summaries: options.summaries ?? [], checks: options.checks ?? [], notifications: options.notifications ?? [], settings: nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false } }), away: options.away ?? false, unread: false, lowToken: false,
    facts: [] as NousTurnFacts[], decisions: [] as NousDecision[], timeZone: "Asia/Bangkok", browsers: options.browsers };
  const standing = vi.fn<StandingOrdersDeps["standing"]>(options.standing ?? (async () => "STARTED"));
  const notice = vi.fn(async () => {});
  const collect = vi.fn<StandingOrdersDeps["collect"]>(async () => ({ rooms: [{ room, sample: state.unread ? null : sample(state.panes) }], reports: state.reports.filter((entry, index, all) => all.findIndex((other) => other.paneId === entry.paneId) === index),
    notifications: state.notifications, decisions: [], copilotItems: [], plans: state.plans, checks: state.checks, tasks: state.tasks, executions: [], summaries: state.summaries,
    ...(state.browsers !== undefined ? { browsers: state.browsers } : {}) }));
  const orders = createStandingOrders({
    closeouts, marks, settings: async () => state.settings, owners: async () => [owner],
    collect,
    reportsSince: async (_owner, paneId, since) => state.reports.filter((entry) => entry.paneId === paneId && entry.at >= since),
    ...(options.planMap ? { planMap: options.planMap } : {}),
    lowToken: async () => state.lowToken, standing, notice, paneRound: async () => null, away: async () => state.away, now: () => clock,
    review: { facts: async (_owner, since) => state.facts.filter((turn) => turn.startedAt >= since), decisions: async () => state.decisions, timeZone: async () => state.timeZone }
  });
  return { orders, closeouts, marks, standing, collect, notice, state, advance: (ms: number) => { clock += ms; }, text: (call = -1) => (standing.mock.calls.at(call) as unknown as [string, string, string])[2] };
}

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
      { id: "nous_decision:c", title: "Delete the export", category: "DESTRUCTIVE", action: { type: "SPACE_CONTROL" }, status: "OPEN", createdAt: "2026-10-23T11:00:00.000Z", answeredAt: null } as unknown as NousDecision
    ], cards: [
      { dedupeKey: "nous:pane:pane:andy0001", createdAt: "2026-10-20T08:00:00.000Z", payload: { alertAt: "2026-10-23T08:00:00.000Z" } } as unknown as SpaceNotification,
      { dedupeKey: "nous:general", createdAt: "2026-10-23T09:00:00.000Z", payload: {} } as unknown as SpaceNotification,
      { dedupeKey: "nous:pane:pane:bob00001", createdAt: "2026-10-22T08:00:00.000Z", payload: { alertAt: "2026-10-22T08:00:00.000Z" } } as unknown as SpaceNotification,
      { dedupeKey: "nous:decision:nous_decision:c", createdAt: "2026-10-23T11:00:00.000Z", payload: {} } as unknown as SpaceNotification
    ], facts: [
      facts("t1", "OPERATOR", "2026-10-23T09:00:00.000Z", { tools: { space_send_to_pane: { calls: 4, failed: 3, refused: 1 }, space_world: { calls: 2, failed: 0, refused: 0 } }, outcomes: [{ summary: "Rename the room", outcome: "SELF", correction: true }] }),
      facts("t2", "INBOX", "2026-10-23T12:00:00.000Z", { status: "TIMEOUT", tools: { space_read_pane: { calls: 3, failed: 1, refused: 0 } } }),
      facts("t3", "INBOX", "2026-10-22T12:00:00.000Z", { tools: { space_git: { calls: 9, failed: 9, refused: 0 } } }),
      facts("t4", "REVIEW", "2026-10-23T03:05:00.000Z", { tools: { space_note: { calls: 1, failed: 1, refused: 0 } } })
    ] });
    expect(text).toContain("# Daily self-review (from Space, not the operator; once a day at 03:00 in the operator's zone; today 2026-10-24)");
    expect(text).toContain("- Turns: 2 (OPERATOR 1; INBOX 1, 1 failed); turns that failed, timed out or were stopped: 1");
    expect(text).toContain("- Tool calls: 9; mistakes (failed calls that were not a gate holding back): 3; held by a gate: 1");
    expect(text).toContain("- Tools that failed most: space_send_to_pane 2 of 4, space_read_pane 1 of 3");
    expect(text).toContain("- Decisions the operator answered: 1 (approved 1, declined 0, in words 0); \"you could have decided this\": 1");
    expect(text).toContain("- Corrections by the operator: 1: \"Rename the room\"");
    // Ask last (goal ee5a573e): the questions the operator got in the last 24 hours.
    expect(text).toContain("## Questions to the operator (ask last, goal ee5a573e)\n- Cards and focus requests raised: 2\n- Decisions asked: 2; questions among them (DIRECTION or without an action): 1\n- \"You could have decided this\": 1: \"Rename the room?\"");
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
    f.advance(31 * MIN);
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
    // Four hours on, plan a's window passed and plan b (unchanged 4.5 h by now) joins it.
    f.advance(2 * 3_600_000);
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 2, turn: "STARTED" });
    expect(f.text()).toContain("clipboard:b");
  });

  it("leaves a plan the plan map holds on a date, another plan or the server out of the stalled nudges (2026-10-25)", async () => {
    const stalled = plan("clipboard:a", andy.id, 40, iso(T0 - 4 * 3_600_000));
    const held = plan("clipboard:b", andy.id, 10, iso(T0 - 5 * 3_600_000));
    const f = fixture({ panes: [{ pane: andy, state: "idle", since: iso(T0 - 10 * MIN) }], plans: [stalled, held], standing: async () => "STARTED",
      planMap: async (_owner, plans) => buildPlanMap({ plans: plans.map((item) => item.id === "clipboard:b" ? { ...item, waitsOn: { kind: "DATE", what: "the launch window", until: iso(T0 + 86_400_000) } } : item),
        executions: [], summaries: [], reports: [], holds: [], now: new Date(T0) }) });
    expect(await f.orders.tickOwner(owner)).toMatchObject({ stalledPlans: 1, turn: "STARTED" });
    expect(f.text()).toContain("[clipboard:a]");
    expect(f.text()).not.toContain("[clipboard:b]");
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
