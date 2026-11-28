import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { nousSettingsSchema, type Pane, type Room } from "@space/contracts";
import { InMemoryNousPaneCloseoutsRepository, InMemoryNousPlanMarksRepository, type NousPaneCloseout, type PaneReport } from "@space/db";
import { NOUS_SAVE_RETRY_TEXT, NOUS_SAVE_TEXT, NOUS_SAVE_YOURSELF } from "../src/nous/save-request.js";

/**
 * Plan clipboard:CTVaL1V3kAFM step 10: every state a pane can be in (the plan's § 2), by the five answers Nous gets about it: work sent to it,
 * "save to memory" sent to it, a close, a forced close with no operator order, and Space's own tick. The real tools and standing orders run,
 * wired to each other as wiring.ts wires them, over plain data that stands for the database and the prompt marks' state file, before and after an
 * API restart (a fresh module instance that reads only that data).
 *
 * Four things hold over the table: a state where every answer refuses names a step that passes; with no save that covers its last work, a close,
 * a forced close and Space's own close never pass open work, an open question, a card or an unsaved change (what such a save passes is the
 * `onceSaved` column); the tick's line and the tools agree; the answers are the same after a restart.
 */
const owner = "user:operator";
const MIN = 60_000;
const T = Date.now();
/** `minutes` ago (ahead when negative). */
const at = (minutes: number) => new Date(T - minutes * MIN).toISOString();
const room = { id: "room:main0001", name: "Main", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null, order: 1 } as unknown as Room;
const WORK = "Run the unit tests of the login form and report the result.";

/** The five answers of the table, and space_answer_pane (the step some refusals name). */
type Probe = "work" | "save" | "close" | "force" | "auto" | "answer";
type World = {
  /** The dashboard's state and how many minutes ago it began. */
  state: "working" | "done" | "idle"; since: number;
  /** Its turn runs now (what a read of the pane shows). */
  running?: boolean;
  /** Its reports, newest first: minutes ago, who wrote it, status, summary. */
  reports?: Array<[number, "AGENT" | "AUTO", PaneReport["status"], string]>;
  mode?: Pane["mode"];
  /** Minutes since Space last prompted it, and since the operator typed a line into it. */
  prompted?: number; operator?: number;
  /** Its close-out row: minutes since the ask, the second ask and the verified save. */
  row?: { state: NousPaneCloseout["state"]; asked: number; retried?: number; verified?: number };
  /** A save of its own in Space Memory since its last work. */
  saved?: boolean;
  card?: boolean; keepOpen?: boolean; taskInMinutes?: number; plan?: boolean; worktree?: boolean; managed?: boolean; scheduled?: boolean; noRoom?: boolean;
};
type State = World & {
  name: string;
  /** What keeps it from closing without the operator's order (invariant 2). */
  open?: "work" | "question" | "card" | "unsaved";
  /** With `open`: whether a close, a forced close and Space's own close pass once a save of the pane since its last work is found. */
  onceSaved?: string;
  /** The five answers, in the order work, save, close, force, auto. */
  answers: [string, string, string, string, string];
  /** The step its refusals name, and proof that it passes: the world after the step, or the call that is the step. */
  next?: { says: RegExp; then?: Partial<World>; probe: Probe; ctx?: Record<string, unknown> };
};

const done = (minutes = 31): World["reports"] => [[minutes, "AGENT", "DONE", "Finished the export."]];
const ASK = 'send it exactly "save to memory" (space_send_to_pane, when now)';
const NOT_READY = "no: 1 of 1 pane is not ready to close";
const QUESTION = "no: Not sent: its question is open";
const NO_ROOM = "no: claude: no room now";
/** The operator's own message of the turn. */
const ordered = { turn: { reason: "OPERATOR", operatorMessage: { id: "nous_msg:order001", person: true, content: "close Andy" } } };
const states: State[] = [
  { name: "1 working, its turn runs", state: "working", since: 10, running: true, reports: [[10, "AGENT", "STARTED", "Started the export."]], open: "work", onceSaved: "no no no",
    answers: ["yes, after its turn", "no: Andy still works", "no: Andy still works", NOT_READY, "nothing"] },
  { name: "2 finished, no save asked", state: "done", since: 31, reports: done(), open: "unsaved", onceSaved: "yes yes yes", answers: ["yes", "yes", NOT_READY, NOT_READY, ASK] },
  { name: "3 progress report, fresh", state: "idle", since: 5, reports: [[5, "AGENT", "PROGRESS", "Half of the export is written."]], open: "work", onceSaved: "no yes no",
    answers: ["yes", "no: Andy has open work", "no: Andy has open work", NOT_READY, "nothing"] },
  { name: "4 progress report, its turn ended 30+ min ago", state: "done", since: 40, reports: [[40, "AUTO", "TURN_END", "The export is written."], [45, "AGENT", "PROGRESS", "Half of the export is written."]], open: "unsaved", onceSaved: "yes yes yes",
    answers: ["yes", "yes", NOT_READY, NOT_READY, ASK] },
  { name: "5 waiting report under 30 min", state: "idle", since: 10, reports: [[10, "AGENT", "WAITING", "Waiting for the staging deploy."]], open: "question", onceSaved: "no yes no",
    answers: [QUESTION, "no: Andy has open work", "no: Andy has open work", NOT_READY, "nothing"], next: { says: /answer it with space_answer_pane/, probe: "answer" } },
  { name: "6 waiting report over 30 min", state: "idle", since: 45, reports: [[45, "AGENT", "WAITING", "Waiting for the staging deploy."]], open: "unsaved", onceSaved: "yes yes yes", answers: ["yes", "yes", NOT_READY, NOT_READY, ASK] },
  { name: "7 its turn ended on a question", state: "idle", since: 45, reports: [[45, "AUTO", "TURN_END", "Which of the two layouts do you want?"]], open: "question", onceSaved: "yes yes no",
    answers: [QUESTION, "no: Andy is not ready to close", NOT_READY, NOT_READY, "nothing"], next: { says: /answer it \(space_answer_pane\)/, probe: "answer" } },
  { name: "8 an open Needs you item", state: "idle", since: 45, card: true, reports: [[45, "AGENT", "NEEDS_YOU", "Needs the bank's one-time code."]], open: "card", onceSaved: "no no no",
    answers: [QUESTION, "no: Andy has open work", "no: Left a pane the operator still has to answer open", "no: Left a pane the operator still has to answer open", "nothing"],
    next: { says: /stays open until they answer/, then: { card: false, since: 1, reports: done(1) }, probe: "save" } },
  { name: "9 kept open by Nous", state: "done", since: 31, keepOpen: true, reports: done(), open: "unsaved", onceSaved: "yes yes no", answers: ["yes", "yes", NOT_READY, NOT_READY, "nothing"] },
  { name: "10 save asked under 20 min ago", state: "done", since: 31, reports: done(), row: { state: "SAVE_REQUESTED", asked: 10 }, open: "unsaved", onceSaved: "yes yes yes",
    answers: ["yes", "no: Save already asked", NOT_READY, NOT_READY, "nothing"] },
  { name: "11 save asked over 20 min ago", state: "done", since: 31, reports: done(), row: { state: "SAVE_REQUESTED", asked: 25 }, open: "unsaved", onceSaved: "yes yes yes",
    answers: ["yes", "yes", NOT_READY, NOT_READY, `read its reports (space_pane_reports); ask once more with exactly "${NOUS_SAVE_RETRY_TEXT}", or record KEEP_OPEN with the reason and the next check`] },
  { name: "12 save asked twice", state: "done", since: 60, reports: done(60), row: { state: "SAVE_RETRIED", asked: 50, retried: 25 }, open: "unsaved", onceSaved: "yes yes yes",
    answers: ["yes", "no: Save already asked", NOT_READY, NOT_READY,
      `read its reports (space_pane_reports); asked twice and space_close_pane refuses it unverified: its work finished, ${NOUS_SAVE_YOURSELF} (space_close_pane), or record KEEP_OPEN with the reason and the next check`],
    next: { says: /save its state yourself \(space_memory_save/, then: { saved: true }, probe: "close" } },
  { name: "13 save verified after its last work", state: "done", since: 31, reports: done(), row: { state: "VERIFIED", asked: 10, verified: 8 }, answers: ["yes", "no: Save already asked", "yes", "yes", "closes"] },
  { name: "14 save verified before its last work", state: "done", since: 31, prompted: 50, reports: done(), row: { state: "VERIFIED", asked: 60, verified: 58 }, open: "unsaved", onceSaved: "yes yes yes", answers: ["yes", "yes", NOT_READY, NOT_READY, ASK] },
  { name: "15 the operator's pane", state: "done", since: 2, operator: 3, reports: [[2, "AUTO", "TURN_END", "Fixed the login form."]],
    answers: ["no: Not sent: the operator's pane", "no: Andy is not ready to close", "no: The operator's pane stays open", "no: The operator's pane stays open", "nothing"],
    next: { says: /asks you to in their own message: this turn's/, probe: "force", ctx: ordered } },
  { name: "16 a task due within the hour", state: "done", since: 31, taskInMinutes: 30, reports: done(),
    answers: ["yes", "no: Andy is not ready to close", "later: Set a close for after the task runs", "later: Set a close for after the task runs", "nothing"] },
  { name: "17 an open plan step", state: "done", since: 31, plan: true, reports: done(), answers: ["yes", "no: Andy is not ready to close", NOT_READY, NOT_READY, "nothing"] },
  { name: "17 a worktree with pending work", state: "done", since: 31, worktree: true, reports: done(), open: "unsaved", onceSaved: "no no no", answers: ["yes", "no: Andy is not ready to close", NOT_READY, NOT_READY, "nothing"] },
  { name: "17 a managed execution", state: "done", since: 31, managed: true, reports: done(), answers: ["yes", "no: Andy is not ready to close", NOT_READY, NOT_READY, "nothing"] },
  { name: "18 a pool with no room, finished", state: "done", since: 31, noRoom: true, reports: done(),
    answers: [NO_ROOM, NO_ROOM, "yes, its report saved by Space", "yes, its report saved by Space", "closes, its report saved by Space"] },
  { name: "18 a pool with no room, its turn runs", state: "working", since: 10, running: true, noRoom: true, reports: [[10, "AGENT", "STARTED", "Started the export."]], open: "work", onceSaved: "no no no",
    answers: [NO_ROOM, NO_ROOM, "no: Andy still works", NOT_READY, "nothing"], next: { says: /wait for the turn to end/, then: { state: "done", since: 1, running: false, reports: done(1) }, probe: "close" } },
  { name: "19 the Mail Copilot", state: "done", since: 31, mode: "MAIL_COPILOT", reports: done(), answers: ["yes", "no: Andy is not ready to close", NOT_READY, NOT_READY, "nothing"] },
  { name: "19 a Marketing Copilot with posts scheduled", state: "done", since: 31, mode: "MARKETING_COPILOT", scheduled: true, reports: done(),
    answers: ["yes, as a brief", "no: Andy is not ready to close", NOT_READY, NOT_READY, "nothing"] }
];

type Api = typeof import("../src/nous/standing-orders.js") & typeof import("../src/nous/tools.js");
const dir = mkdtempSync(join(tmpdir(), "pane-matrix-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const paneId = (index: number) => `pane:state${String(index).padStart(4, "0")}`;

/** A started API: the first one writes each pane's prompt marks, a restarted one has only what the state file kept. */
async function start(first: boolean): Promise<Api> {
  vi.resetModules();
  const grants = await import("../src/queue-operator-grants.js");
  const prompts = await import("../src/space-prompts.js");
  grants.configureQueueOperatorGrants("matrix-secret", join(dir, "queue-operator-grants.json"));
  if (first) states.forEach((state, index) => {
    prompts.noteSpacePrompt(paneId(index), T - (state.prompted ?? 120) * MIN);
    if (state.operator !== undefined) grants.noteOperatorPaneInput(paneId(index), "fix the login form\r", T - state.operator * MIN);
  });
  return { ...await import("../src/nous/standing-orders.js"), ...await import("../src/nous/tools.js") };
}

/** One answer: the world as the database holds it, then one call. */
async function answer(api: Api, id: string, world: World, probe: Probe, ctxExtra: Record<string, unknown> = {}, text = probe === "save" ? NOUS_SAVE_TEXT : WORK) {
  const pane = { id, roomId: room.id, paneName: "Andy", title: "Andy", mode: world.mode ?? "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false, createdAt: at(180), updatedAt: at(180) } as unknown as Pane;
  const reports = (world.reports ?? []).map(([minutes, source, status, summary], index) =>
    ({ id: `report:${index}`, roomId: room.id, paneId: id, at: at(minutes), source, status, summary, body: null, planId: null, step: null, percent: null, ticket: null, next: null, needs: null }) as PaneReport);
  // wiring.ts lastWorkReport: the pane's own newest report of work.
  const lastWork = async () => reports.find((report) => report.source === "AGENT" && !["TURN_END", "TODO", "HEARTBEAT"].includes(report.status)) ?? null;
  const cards = world.card ? [{ id: "notification:ask00001", source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", status: "OPEN", paneId: id, roomId: room.id, dedupeKey: null,
    title: "Which bank account?", body: "", payload: {}, createdAt: at(world.since), updatedAt: at(world.since) }] : [];
  const tasks = world.taskInMinutes ? [{ id: "task:digest001", title: "Daily digest", paneId: id, roomId: room.id, schedule: { kind: "DAILY", nextRunAt: at(-world.taskInMinutes) }, status: "OPEN" }] : [];
  const plans = world.plan ? [{ id: "clipboard:plan0001", title: "Plan export", text: "", progressPercentage: 40, paneId: id, lastProgressAt: at(60), createdAt: at(600), executionStatus: "IN_PROGRESS",
    steps: ["COMPLETED", "PENDING"].map((status, index) => ({ id: `step-${index + 1}`, order: index + 1, title: `Step ${index + 1}`, status, progress: 0, agent: null, notes: null, proof: null, startedAt: null, completedAt: null })) }] : [];
  const worktrees = new Map(world.worktree ? [[id, "/opt/spaceapp/var/worktrees/space/wt-andy"]] : []);
  const checks = world.keepOpen ? [{ paneId: id, roomId: room.id, checkedAt: at(10), verdict: "KEEP_OPEN", note: "waits for the nightly import", nextCheckAt: at(-60) }] : [];
  const sample = { data: [pane], sampledAt: at(0), activity: { [id]: world.state }, details: { [id]: { status: world.state, since: at(world.since), source: "native" } } };
  const closeouts = new InMemoryNousPaneCloseoutsRepository();
  if (world.row) await closeouts.save(owner, { paneId: id, roomId: room.id, state: world.row.state, requestedAt: at(world.row.asked), retriedAt: world.row.retried === undefined ? null : at(world.row.retried),
    verifiedMemoryId: world.row.verified === undefined ? null : "memory:save0001", closedAt: null, reason: null, updatedAt: at(world.row.verified ?? world.row.retried ?? world.row.asked) });
  // wiring.ts closePane: the close space_close_pane makes, behind its Needs you guard.
  const closePane = vi.fn(async () => !cards.length);
  const spaceSaves = vi.fn(async () => ({ id: "memory:space001" }));
  const notice = vi.fn<(owner: string, key: string, line: string) => Promise<void>>(async () => {});
  const orders = api.createStandingOrders({
    closeouts, marks: new InMemoryNousPlanMarksRepository(), settings: async () => nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false } }), owners: async () => [owner],
    collect: async () => ({ rooms: [{ room, sample }], reports: reports.slice(0, 1), notifications: cards, decisions: [], copilotItems: [], plans, checks, tasks, executions: world.managed ? [{ planId: "clipboard:plan0001", paneId: id }] : [],
      summaries: [], prompts: new Set<string>(), pendingWorktrees: worktrees, ...(world.scheduled ? { scheduled: new Set([id]) } : {}) }) as never,
    reportsSince: async (_owner, _pane, since) => reports.filter((report) => report.at >= since),
    paneSaves: async () => world.saved ? "memory:pane0001" : null,
    lastWorkReport: lastWork, paneWorking: async () => Boolean(world.running), closePane, saveMemory: async () => (await spaceSaves()).id,
    spend: async () => ({ mode: "NORMAL", avoid: [], refused: world.noRoom ? ["claude"] : [] }),
    lowToken: async () => false, standing: vi.fn(async () => "STARTED") as never, notice, paneRound: async () => null, away: async () => false,
    review: { facts: async () => [], decisions: async () => [], timeZone: async () => "Asia/Bangkok", busy: () => false }
  });
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const brief = vi.fn(async () => "brief queued");
  const pool = (key: string, nowLeft: number) => ({ key, name: key, provider: null, accounts: 1, nowLeft, atReset: null, pace: null });
  const tools = api.createNousTools({
    world: async () => "world", rooms: async () => [room], listPanes: async () => [pane],
    inspectPane: async () => ({ text: "", state: world.running ? "RUNNING" : "IDLE", sessionId: "session:1", tasks: [] }), roomTool,
    plans: { list: async () => plans, get: async () => null, update: vi.fn() }, tasks: { list: async () => tasks, add: vi.fn(), update: vi.fn(), rebind: vi.fn() },
    clipboard: { list: async () => [], save: vi.fn(), complete: vi.fn(), remove: vi.fn(async () => {}) }, memory: { recall: async () => [], save: spaceSaves },
    notifications: { list: async () => cards, resolve: async () => true }, releaseTrain: vi.fn(async () => ""), setNote: vi.fn(async () => {}), ask: vi.fn(), withdraw: vi.fn(async () => false),
    allowances: async () => ({ promote: false, warm: false }), answerPrompt: vi.fn(async () => ({})), paneNotices: {},
    providerRooms: async () => [pool("claude", world.noRoom ? 0 : 60), pool("codex", 60)], quotaWaits: async () => [], closeOperatorPanes: async () => true,
    paneLastReport: async () => reports[0] ?? null, paneLastWorkReport: lastWork, pendingWorktreePaths: async () => worktrees, paneSince: async () => at(world.since), paneNeeds: async () => cards,
    followups: { run: vi.fn(async () => ({ ok: true, display: "Follow-up set", result: "set" })) }, copilots: { brief },
    closeouts: { saveRequested: orders.saveRequested, closed: orders.closed, roomCloseouts: orders.roomCloseouts, saveRepeats: orders.saveRepeats, savedUnprompted: orders.savedUnprompted }
  } as never);
  const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1", ...ctxExtra } as never;
  const clock = (text: string) => text.replace(/\d{4}-\d{2}-\d{2} /g, "").replace(/\b\d{2}:\d{2}\b/g, "HH:MM");
  if (probe === "auto") {
    await orders.tickOwner(owner);
    const line = notice.mock.calls.find(([, key]) => key === `finished:${id}`)?.[2] ?? "";
    return { text: clock(line), answer: closePane.mock.calls.length ? `closes${spaceSaves.mock.calls.length ? ", its report saved by Space" : ""}` : line ? clock(line.split(" → ")[1] ?? line) : "nothing" };
  }
  const closing = probe === "close" || probe === "force";
  const outcome = closing ? await tools.execute("space_close_pane", { room: "Main", panes: ["Andy"], ...(probe === "force" ? { force: true } : {}) }, ctx)
    : probe === "answer" ? await tools.execute("space_answer_pane", { room: "Main", pane: "Andy", answer: "Go on with the first of the two and finish the export." }, ctx)
      : await tools.execute("space_send_to_pane", { room: "Main", panes: ["Andy"], text, when: "now" }, ctx);
  const ran = roomTool.mock.calls.find(([name]) => closing ? name === "close_pane" : name === "send_to_pane" || (probe === "answer" && name === "answer_pane_prompt"));
  return { text: clock(`${outcome.display}\n${outcome.result}`), answer: ran ? `yes${ran[1].when === "after_turn" ? ", after its turn" : ""}${spaceSaves.mock.calls.length ? ", its report saved by Space" : ""}`
    : brief.mock.calls.length ? "yes, as a brief" : `${outcome.ok ? "later" : "no"}: ${clock(outcome.display)}` };
}

const probes = ["work", "save", "close", "force", "auto"] as const;
const passes = /^(yes|closes)/;

describe.each([["before a restart", true], ["after a restart", false]] as const)("the pane state matrix %s", (_when, first) => {
  let api: Api;
  beforeAll(async () => { api = await start(first); });

  it.each(states)("$name", async (state) => {
    const id = paneId(states.indexOf(state));
    const got = await Promise.all(probes.map((probe) => answer(api, id, state, probe)));
    const [work, save, close, force, auto] = got.map((each) => each.answer);
    expect([work, save, close, force, auto]).toEqual(state.answers);

    // 1. Where every answer refuses, a refusal names a step, and that step passes.
    if (![work, save, close, force, auto].some((each) => passes.test(each) || each.startsWith("later"))) expect(state.next, "every answer refuses: name the step that passes").toBeDefined();
    if (state.next) {
      expect(got.map((each) => each.text).join("\n")).toMatch(state.next.says);
      expect((await answer(api, id, { ...state, ...state.next.then }, state.next.probe, state.next.ctx)).answer).toMatch(passes);
    }
    // 2. Open work, an open question, a card or an unsaved change: no close, forced close or close by Space; a card not even on the operator's order.
    if (state.open) for (const each of [close, force, auto]) expect(each).not.toMatch(passes);
    if (state.open === "card") expect((await answer(api, id, state, "force", ordered)).answer).toMatch(/^no/);
    // A save since its last work is what closes an unsaved pane. It also passes a question on Nous's own close and open work on its forced one
    // (operator 28/11: panes idle for hours, save and close both refused), never on Space's, and never a running turn, a card or a pending worktree.
    if (state.open) {
      const saved = (await Promise.all((["close", "force", "auto"] as const).map((probe) => answer(api, id, { ...state, saved: true }, probe)))).map((each) => passes.test(each.answer) ? "yes" : "no");
      expect(saved.join(" ")).toBe(state.onceSaved);
      if (state.open !== "unsaved") expect(saved[2]).toBe("no");
    }
    // 3. The tick's line and the tools agree: Space closes what a close closes, the text the line quotes is taken, and what it calls refused is refused.
    expect(auto.replace(/^closes/, "yes") === close).toBe(passes.test(auto) || passes.test(close));
    const quoted = /exactly "([^"]+)"/.exec(auto)?.[1];
    if (quoted) expect((await answer(api, id, state, "work", {}, quoted)).answer).toBe("yes");
    if (auto.includes("space_close_pane refuses it")) expect(close).toMatch(/^no/);
  });
});
