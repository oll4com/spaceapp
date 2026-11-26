// 13/11 09:12 BKK (operator «παλι εχει πεσει η πιεση σου και ειναι στο 66% το load !! γιατι δεν πιεζεις τα πραγματα??»; 14 of 31 CLI panes working):
// a pane that finishes with a plan step or a task to run is pushed at once, and a finished pane whose plan has only BLOCKED steps saves and closes.
import { describe, expect, it, vi } from "vitest";
import { nousSettingsSchema, type ClipboardItem, type Pane, type Room, type TaskItem } from "@space/contracts";
import { InMemoryNousPaneCloseoutsRepository, InMemoryNousPlanMarksRepository } from "@space/db";
import type { DashboardAgentsSample } from "../src/room-routes.js";
import { createStandingOrders, isCleanSweepReport, NOUS_SWEEP_PANE_TITLE, SWEEP_CLEAN_TTL_MS, type CleanSweepMark, type StandingOrdersDeps } from "../src/nous/standing-orders.js";
import { itemActed, type NousTurnItem } from "../src/nous/turn-items.js";
import { sweepAreaTouched, sweepPieces } from "../src/nous/utilization.js";
import { sendWorkKeys } from "../src/nous/tools.js";
import { noteOperatorPromoteLine } from "../src/queue-operator-grants.js";
import { noteSpacePrompt } from "../src/space-prompts.js";

const owner = "user:operator";
const T0 = Date.parse("2026-11-13T02:00:00.000Z");
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const room = { id: "room:main0001", name: "Main", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null, order: 1 } as unknown as Room;
const cli = (id: string, name: string) => ({ id, roomId: room.id, paneName: name, title: name, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false }) as unknown as Pane;
const andy = cli("pane:andy0001", "Andy"), bob = cli("pane:bob00001", "Bob"), cody = cli("pane:cody0001", "Cody");
// Every plan moved 20 minutes ago: none is stalled, so only the push carries them.
const plan = (id: string, paneId: string, steps: string[], extra: Record<string, unknown> = {}) => ({ id, title: `Plan ${id.slice(-1)}`, text: "", progressPercentage: 50, paneId,
  lastProgressAt: iso(T0 - 20 * MIN), createdAt: iso(T0 - 20 * MIN), executionStatus: "IN_PROGRESS", ...extra,
  steps: steps.map((status, index) => ({ id: `step-${index + 1}`, order: index + 1, title: `Step ${index + 1}`, status, progress: 0, agent: null, notes: null, proof: null, startedAt: null, completedAt: null })) }) as unknown as ClipboardItem;
const task = (id: string, paneId: string, schedule: Record<string, unknown> | null, status = "OPEN") => ({ id, title: `Task ${id.slice(-1)}`, paneId, roomId: room.id, status,
  schedule: schedule && { recurrence: { kind: "ONCE" }, timeZone: "UTC", nextRunAt: null, lastRunAt: null, lastOutcome: null, ...schedule } }) as unknown as TaskItem;

function fixture(panes: Array<{ pane: Pane; state: string; since: string; modelId?: string }>, plans: ClipboardItem[], tasks: TaskItem[] = [], deps: Partial<StandingOrdersDeps> = {}, summaries: unknown[] = [], notifications: unknown[] = [], reports: unknown[] = []) {
  let clock = T0;
  const notice = vi.fn<NonNullable<StandingOrdersDeps["notice"]>>(async () => {});
  const standing = vi.fn<StandingOrdersDeps["standing"]>(async () => "STARTED");
  const sample = (): DashboardAgentsSample => ({ data: panes.map((entry) => entry.pane), sampledAt: iso(clock),
    activity: Object.fromEntries(panes.map((entry) => [entry.pane.id, entry.state])) as never,
    details: Object.fromEntries(panes.map((entry) => [entry.pane.id, { status: entry.state, since: entry.since, source: "native", modelId: entry.modelId }])) as never });
  const orders = createStandingOrders({ closeouts: new InMemoryNousPaneCloseoutsRepository(), marks: new InMemoryNousPlanMarksRepository(),
    settings: async () => nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false } }), owners: async () => [owner],
    collect: async () => ({ rooms: [{ room, sample: sample() }], reports: reports as never, notifications: notifications as never, decisions: [], copilotItems: [], plans, checks: [], tasks, executions: [], summaries: summaries as never }),
    reportsSince: async () => [], standing, notice, now: () => clock, utilizationLow: async () => "Utilization stayed under the 90% target for 15 min.",
    review: { facts: async () => [], decisions: async () => [], timeZone: async () => "Asia/Bangkok" }, sweep: () => [], ...deps });
  const pushes = () => notice.mock.calls.filter((call) => call[1] === "utilization-low").map((call) => call[3] as NousTurnItem[]);
  return { orders, panes, standing, notice, pushes, advance: (ms: number) => { clock += ms; } };
}

describe("Load push (13/11)", () => {
  it("pushes a pane that finished since the last push at once, not at the next 10-minute push", async () => {
    const f = fixture([{ pane: andy, state: "done", since: iso(T0 - 15 * MIN) }, { pane: bob, state: "working", since: iso(T0 - 5 * MIN) }],
      [plan("clipboard:a", andy.id, ["COMPLETED", "PENDING"]), plan("clipboard:b", bob.id, ["COMPLETED", "PENDING"])]);
    await f.orders.tickOwner(owner);
    expect(f.pushes().map((items) => items.map((item) => item.key))).toEqual([["utilization", "plan:clipboard:a"]]);
    // A minute later nothing new finished: no push until the 10 minutes pass.
    f.advance(MIN);
    await f.orders.tickOwner(owner);
    expect(f.pushes()).toHaveLength(1);
    // Bob finishes two minutes after the push: his next step goes out on this tick.
    f.advance(2 * MIN);
    f.panes[1] = { pane: bob, state: "done", since: iso(T0 + 2 * MIN) };
    await f.orders.tickOwner(owner);
    expect(f.pushes().at(-1)!.map((item) => item.key)).toEqual(["utilization", "plan:clipboard:a", "plan:clipboard:b"]);
  });

  // 13/11 23:03 BKK: at 22:41 BKK seven CLI panes finished with no plan step or task of their own and waited for the 10-minute push.
  it("queues a dispatch turn at once when a CLI pane finishes with nothing waiting on it", async () => {
    const f = fixture([{ pane: andy, state: "working", since: iso(T0 - 5 * MIN) }], [plan("clipboard:z", "pane:gone0001", ["COMPLETED", "PENDING"])]);
    await f.orders.tickOwner(owner);
    expect(f.notice.mock.calls.filter((call) => call[1] === "utilization-low").map((call) => call[4])).toEqual([false]);
    f.advance(2 * MIN);
    f.panes[0] = { pane: andy, state: "done", since: iso(T0 + MIN) };
    await f.orders.tickOwner(owner);
    const call = f.notice.mock.calls.filter((entry) => entry[1] === "utilization-low").at(-1)!;
    expect(call[4]).toBe(true);
    expect(call[2]).toContain("Free CLI panes (each gets work before it closes):\n- Main/Andy done since 02:01 UTC: send it the next piece of work");
    expect(call[2]).toContain("Plans not on a pane");
  });

  // Score row 19 (14/11 14:54 "Dana is closed and did not reopen"): a closing or closed pane is no free pane and gets no plan step.
  it("leaves out of the push a pane whose closeout is in flight or that closed after it finished, and keeps one reopened since", async () => {
    const closeouts = new InMemoryNousPaneCloseoutsRepository();
    const row = (paneId: string, state: "SAVE_REQUESTED" | "VERIFIED" | "CLOSED", closedAt: string | null, askedAt = T0 - 12 * MIN) => ({ paneId, roomId: room.id, state, requestedAt: iso(askedAt), retriedAt: null,
      verifiedMemoryId: null, closedAt, reason: null, updatedAt: iso(T0 - 5 * MIN) });
    const dana = cli("pane:dana0001", "Dana"), eve = cli("pane:eve00001", "Eve"), finn = cli("pane:finn0001", "Finn");
    await closeouts.save(owner, row(andy.id, "SAVE_REQUESTED", null));
    await closeouts.save(owner, row(bob.id, "CLOSED", iso(T0 - 5 * MIN)));
    await closeouts.save(owner, row(cody.id, "CLOSED", iso(T0 - 30 * MIN)));
    // 22/11 04:30Z (Jack and Hugo asked to save, left open, hidden from the free list): a save unverified past the save wait, or a pane
    // prompted again after its save ask, is capacity again.
    await closeouts.save(owner, row(eve.id, "SAVE_REQUESTED", null, T0 - 25 * MIN));
    await closeouts.save(owner, row(finn.id, "VERIFIED", null));
    noteSpacePrompt(finn.id, T0 - 11 * MIN);
    const done = { state: "done", since: iso(T0 - 10 * MIN) };
    const f = fixture([{ pane: andy, ...done }, { pane: bob, ...done }, { pane: cody, ...done }, { pane: dana, ...done }, { pane: eve, ...done }, { pane: finn, ...done }],
      [plan("clipboard:b", bob.id, ["COMPLETED", "PENDING"]), plan("clipboard:d", dana.id, ["COMPLETED", "PENDING"])], [], { closeouts });
    await f.orders.tickOwner(owner);
    const call = f.notice.mock.calls.filter((entry) => entry[1] === "utilization-low").at(-1)!;
    expect(call[2]).toContain("Free CLI panes (each gets work before it closes):\n- Main/Cody done since 01:50 UTC");
    expect((call[3] as NousTurnItem[]).map((item) => item.key)).toEqual(["utilization", "free:pane:cody0001", "free:pane:eve00001", "free:pane:finn0001", "plan:clipboard:d"]);
  });

  // 17/11 REVIEW (16/11: a follow-up rewritten ×22 while its request waited on the operator until 09:07 BKK): an open dated follow-up's request,
  // plan or Utilization is no push item until it fires; the line comes only with work of its own.
  it("leaves out what an open dated follow-up holds, and raises no Utilization line with nothing else in it", async () => {
    let holds = new Set(["clipboard:held0001", "nous_msg:b3744e80"]);
    const done = { state: "done", since: iso(T0 - 15 * MIN) };
    const request = { key: "nous_msg:b3744e80aaaa", messageId: "nous_msg:b3744e80aaaa", words: "Do X", openedAt: iso(T0 - 90 * MIN), paneState: "done", paneSince: iso(T0 - 60 * MIN) };
    const f = fixture([{ pane: andy, ...done }, { pane: bob, ...done }], [plan("clipboard:held0001", andy.id, ["COMPLETED", "PENDING"]), plan("clipboard:free0001", bob.id, ["COMPLETED", "PENDING"])], [],
      { datedHolds: async () => holds, requests: { zone: async () => "UTC", open: async () => [request], progress: async () => {} } });
    await f.orders.tickOwner(owner);
    expect(f.pushes().at(-1)!.map((item) => item.key)).toEqual(["utilization", "plan:clipboard:free0001"]);
    holds = new Set([...holds, "utilization"]);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.pushes().at(-1)!.map((item) => item.key)).toEqual(["plan:clipboard:free0001"]);
    holds = new Set([...holds, "clipboard:free0001"]);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.pushes()).toHaveLength(2);
    // The follow-up fired (no hold): the request comes back.
    holds = new Set();
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(f.pushes().at(-1)!.map((item) => item.key)).toEqual(["utilization", "plan:clipboard:held0001", "plan:clipboard:free0001", "request:nous_msg:b3744e80aaaa"]);
  });

  it("gives a finished pane whose task run ended one item, and a task update naming it moves it", async () => {
    const ran = task("task:ran00001", andy.id, { lastRunAt: iso(T0 - 30 * MIN) });
    const f = fixture([{ pane: andy, state: "done", since: iso(T0 - 15 * MIN) }, { pane: bob, state: "idle", since: iso(T0 - 15 * MIN) }, { pane: cody, state: "idle", since: iso(T0 - 15 * MIN) }],
      [plan("clipboard:b", bob.id, ["PENDING"])],
      // Bob's plan step already is his item; Cody's task runs again tomorrow; an unscheduled saved task is no work in itself.
      [ran, task("task:ran00002", andy.id, null, "RUNNING"), task("task:bob00003", bob.id, null, "RUNNING"), task("task:daily004", cody.id, { recurrence: { kind: "DAILY" }, nextRunAt: iso(T0 + 20 * 60 * MIN) }),
        task("task:saved005", cody.id, null)]);
    await f.orders.tickOwner(owner);
    const items = f.pushes()[0]!;
    // Cody owns open tasks (2026-11-25 REVIEW / cee65d2bb1): task-bound panes stay out of free-pane hand-outs.
    expect(items.map((item) => item.key)).toEqual(["utilization", "plan:clipboard:b", "task:task:ran00001"]);
    const item = items[2]!;
    expect(item).toMatchObject({ kind: "PLAN", pane: andy.id, paneName: "Andy", refs: [ran.id], always: true, line: expect.stringContaining("Main/Andy done, nothing scheduled next: finished → mark it DONE (space_task_update)") });
    expect(items[0]!.line).toContain("Tasks whose run ended on a finished pane:\n- Task [task:ran00001]");
    expect(itemActed(item, [{ name: "space_task_update", ok: true, subjects: [], args: { task: ran.id, status: "DONE" } }])).toBe(true);
    expect(itemActed(item, [{ name: "space_send_to_pane", ok: true, subjects: [`pane ${andy.id}`], args: { panes: [andy.id], text: "Next step of the task" } }])).toBe(true);
  });

  // 13/11 (operator: utilization at 80 % until morning; memory 60ca649d): under LOW the push waited up to an hour behind the inbox cap.
  it("sends a finished pane its plan's next step itself, once per step, and only with the push's gate open", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    let line: string | null = null;
    const done = { state: "done", since: iso(T0 - 15 * MIN) };
    const plans = [plan("clipboard:a", andy.id, ["COMPLETED", "PENDING"]), plan("clipboard:b", bob.id, ["COMPLETED", "PENDING"]), plan("clipboard:c", cody.id, ["PENDING"])];
    const f = fixture([{ pane: andy, ...done }, { pane: bob, ...done }, { pane: cody, ...done }], plans, [], { dispatch, utilizationLow: async () => line,
      // Bob's plan waits on another plan (Nous decides which step runs); Cody runs on Codex, which the Provider advice avoids under LOW.
      planMap: async () => ({ nodes: new Map([["clipboard:b", { hold: { kind: "PLAN", what: "clipboard:x", until: null } }]]), holds: [] }) as never,
      spend: async () => ({ mode: "LOW", avoid: ["codex"] }) });
    f.panes[2] = { pane: { ...cody, terminalRuntimeId: "cli:codex" } as Pane, ...done };
    // Gate closed (over target, a limit, CRITICAL, or the server busy): nothing goes.
    await f.orders.tickOwner(owner);
    expect(dispatch).not.toHaveBeenCalled();
    line = "Utilization stayed under the 80% target for 15 min.";
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls).toEqual([[owner, room.id, andy.id, expect.stringContaining("Continue plan clipboard:a \"Plan a\": its next step is 2. Step 2 (PENDING).")]]);
    const push = f.notice.mock.calls.filter((call) => call[1] === "utilization-low").at(-1)!;
    expect((push[3] as NousTurnItem[]).map((item) => item.key)).toEqual(["utilization", "plan:clipboard:b"]);
    expect(push[2]).toContain("Space sent the next step itself (nothing to send): Andy [clipboard:a] 2. Step 2 (PENDING)");
    // Andy ends again with the same step open: it stays with Nous, not sent twice.
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((f.notice.mock.calls.at(-1)![3] as NousTurnItem[]).map((item) => item.key)).toEqual(["utilization", "plan:clipboard:a", "plan:clipboard:b"]);
  });

  it("asks a finished pane whose plan has only BLOCKED steps left to save, and keeps one with a step to run or an operator wait", async () => {
    const f = fixture([{ pane: andy, state: "done", since: iso(T0 - 45 * MIN) }, { pane: bob, state: "done", since: iso(T0 - 45 * MIN) }, { pane: cody, state: "done", since: iso(T0 - 45 * MIN) }],
      [plan("clipboard:a", andy.id, ["COMPLETED", "BLOCKED"]), plan("clipboard:b", bob.id, ["BLOCKED", "PENDING"]),
        plan("clipboard:c", cody.id, ["COMPLETED", "BLOCKED"], { waitsOn: { kind: "OPERATOR", what: "his sign-in", until: null } })]);
    await f.orders.tickOwner(owner);
    // Item 7 A (round 14/11): finished panes come as inbox lines.
    const text = f.notice.mock.calls.filter(([, key]) => key.startsWith("finished:")).map(([, , line]) => line).join("\n");
    expect(text).toContain("Finished pane Main/Andy · done 45 min · plan step waits for what its BLOCKED steps name: its task or you reopen the pane when the work continues · save not asked yet");
    expect(text).not.toContain("Main/Bob ·");
    expect(text).not.toContain("Main/Cody ·");
  });

  // 21/11 (operator 10:40 BKK «Σου ζήτησα να τρέξεις load 90%»): 12 panes finished side steps in 5-20 min and none got work; a pane free since
  // before the last push was named once as text and never again.
  it("lists a CLI pane free since before the last push as an item on every push until an act names it", async () => {
    // Cody is free on Codex, which the send guard refuses new work in any mode (21/11 04:18Z): no item Nous could not act on.
    const f = fixture([{ pane: andy, state: "idle", since: iso(T0 - 20 * MIN) }, { pane: bob, state: "working", since: iso(T0 - 5 * MIN) },
      { pane: { ...cody, terminalRuntimeId: "cli:codex" } as Pane, state: "idle", since: iso(T0 - 20 * MIN) }], [], [],
      { spend: async () => ({ mode: "NORMAL", avoid: [], refused: ["codex"] }) });
    await f.orders.tickOwner(owner);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    const pushes = f.pushes();
    expect(pushes).toHaveLength(2);
    const item = pushes[1]!.find((entry) => entry.key === `free:${andy.id}`)!;
    expect(item).toMatchObject({ kind: "PLAN", pane: andy.id, paneName: "Andy", always: true });
    expect(pushes[1]!.some((entry) => entry.key === `free:${cody.id}`)).toBe(false);
    expect(itemActed(item, [{ name: "space_nous_followup", ok: true, subjects: [], args: { op: "add", note: "later" } }])).toBe(false);
    expect(itemActed(item, [{ name: "space_send_to_pane", ok: true, subjects: [`pane ${andy.id}`], args: { panes: [andy.id], text: "Fix X" } }])).toBe(true);
  });

  // DEV3D-067 (review of 5e70e31ff5): a free item Nous left is filtered while its shape holds; a new free spell of the same pane must read as new.
  it("gives a free pane's item a shape of its free spell: the same while it stays free, new when it is free again", async () => {
    const shape = (item: NousTurnItem) => item.shape ?? item.line.replace(/\d+(?:[.,]\d+)?/g, "#").replace(/\s+/g, " ").trim();
    const f = fixture([{ pane: andy, state: "idle", since: iso(T0 - 20 * MIN) }, { pane: bob, state: "working", since: iso(T0 - 5 * MIN) }], []);
    const free = () => f.pushes().at(-1)!.find((entry) => entry.key === `free:${andy.id}`)!;
    await f.orders.tickOwner(owner);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    const first = shape(free());
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(shape(free())).toBe(first);
    f.panes[0] = { pane: andy, state: "idle", since: iso(T0 + 21 * MIN) };
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(shape(free())).not.toBe(first);
  });

  // 22/11 07:15Z: ~25 gemini-CLI panes on claude-opus-5-5 got work while Antigravity's Claude pool had no room and all hit "Individual quota reached".
  it("reads a gemini-CLI pane's pool from its live model, so a pane on Antigravity Claude gets no work while that pool has no room", async () => {
    const gemini = (pane: Pane) => ({ ...pane, terminalRuntimeId: "cli:gemini" }) as Pane;
    const f = fixture([{ pane: gemini(andy), state: "idle", since: iso(T0 - 20 * MIN), modelId: "gemini-3.8-flash" }, { pane: bob, state: "working", since: iso(T0 - 5 * MIN) },
      { pane: gemini(cody), state: "idle", since: iso(T0 - 20 * MIN), modelId: "claude-opus-5-5" }], [], [],
      { spend: async () => ({ mode: "NORMAL", avoid: [], refused: ["antigravity-claude"] }) });
    await f.orders.tickOwner(owner);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    const pushes = f.pushes();
    expect(pushes[1]!.some((entry) => entry.key === `free:${andy.id}`)).toBe(true);
    expect(pushes[1]!.some((entry) => entry.key === `free:${cody.id}`)).toBe(false);
  });

  // 21/11 10:55Z (load 36 %, 3 of 21 working, 0-1 free items a push): idle panes whose board read a wait or whose plan had only BLOCKED steps were no item.
  // Operator 23/11: a board wait on the operator is an open question, so that pane is no free item either.
  it("lists an idle pane whose plan cannot run as free; a pane with its plan's next step or whose board waits on the operator is no free item", async () => {
    const dana = cli("pane:dana0001", "Dana");
    const f = fixture([{ pane: andy, state: "idle", since: iso(T0 - 20 * MIN) }, { pane: bob, state: "done", since: iso(T0 - 20 * MIN) },
      { pane: cody, state: "idle", since: iso(T0 - 20 * MIN) }, { pane: dana, state: "working", since: iso(T0 - 5 * MIN) }],
      [plan("clipboard:b", bob.id, ["COMPLETED", "BLOCKED"]), plan("clipboard:c", cody.id, ["COMPLETED", "PENDING"])], [], {},
      [{ id: "s1", paneId: andy.id, roomId: room.id, fingerprint: "f", line: "asks the operator", waitsOn: "OPERATOR", needsOperator: true, until: null, detail: null,
        model: null, source: "FALLBACK", batchId: null, generatedAt: iso(T0 - 10 * MIN), inputReportId: null }]);
    await f.orders.tickOwner(owner);
    const keys = f.pushes().at(-1)!.map((item) => item.key);
    expect(keys).toEqual(expect.arrayContaining([`free:${bob.id}`, "plan:clipboard:c"]));
    expect(keys).not.toContain(`free:${andy.id}`);
    expect(keys).not.toContain(`free:${cody.id}`);
    expect(keys).not.toContain(`free:${dana.id}`);
  });

  // Operator 23/11 (supersedes 21/11 12:48Z «Ακόμα 34% γιατί;;»): a pane behind its own open Needs you card takes no new prompt; its question would be lost.
  it("never lists a done pane whose own Needs you card waits on the operator as free", async () => {
    const card = { id: "notif:dana", paneId: andy.id, roomId: room.id, source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", status: "OPEN", title: "Andy needs you",
      createdAt: iso(T0 - 60 * MIN), updatedAt: iso(T0 - 60 * MIN), dismissedAt: null, resolvedAt: null, dedupeKey: null, payload: {} };
    const f = fixture([{ pane: andy, state: "done", since: iso(T0 - 90 * MIN) }, { pane: bob, state: "working", since: iso(T0 - 5 * MIN) }], [], [], {}, [], [card]);
    await f.orders.tickOwner(owner);
    expect((f.pushes().at(-1) ?? []).some((entry) => entry.key === `free:${andy.id}`)).toBe(false);
  });
  // 21/11 22:26 BKK (operator «load 90% τωρα και να το κρατησεις εως το πρωι»; 31 %): free panes were only listed for Nous; Space now hands each one
  // a piece of runnable work itself, a plan with no pane first, then a daily-improvement fix on an Opus/Fable pane, each piece to one pane.
  it("hands free CLI panes runnable backlog itself, each piece once, a code fix only to a strong model (the live one), nothing with the gate closed", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    let line: string | null = null;
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    // 21/11 16:02Z (stable): Cleo/Andy ran Opus with no model on its pane record and got no fix; the strong check reads the CLI's live model.
    const f = fixture([{ pane: bob, ...idle }, { pane: andy, ...idle, modelId: "claude-opus-5-5" }, { pane: cody, ...idle, modelId: "claude-sonnet-5-5" }],
      [plan("clipboard:u", null as never, ["PENDING"], { roomId: room.id, minimumModel: "claude-sonnet-5-5" })], [],
      { dispatch, utilizationLow: async () => line, backlog: async () => [{ key: "upgrade:cause x", text: "Fix cause x" }] });
    await f.orders.tickOwner(owner);
    expect(dispatch).not.toHaveBeenCalled();
    line = "Utilization stayed under the 90% target for 15 min.";
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls).toEqual([[owner, room.id, bob.id, "Implement the following plan. Plan ID: clipboard:u"], [owner, room.id, andy.id, "Fix cause x"]]);
    const push = f.notice.mock.calls.filter((call) => call[1] === "utilization-low").at(-1)!;
    expect(push[2]).toContain("Space handed free panes work itself (nothing to send): Main/Bob ← plan:clipboard:u; Main/Andy ← upgrade:cause x");
    expect((push[3] as NousTurnItem[]).map((item) => item.key)).toEqual(["utilization", `free:${cody.id}`]);
    // Next push: the plan still waits for Bob to take it and the fix is given; nothing goes twice.
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  // 23/11: queue line 1191 (panes.move) went to Jack, then Emma twice, across the 08:38/11:43/12:51Z promotes: the hand-out was in memory only.
  it("hands a backlog line to no second pane after an API restart, and drops a line marked DONE from the store", async () => {
    let stored: Record<string, string> = {};
    const givenStore = { read: async () => stored, write: vi.fn(async (entries: Record<string, string>) => { stored = entries; }) };
    let backlog = [{ key: "upgrade:cause x", text: "Fix cause x" }, { key: "upgrade:cause y", text: "Fix cause y" }];
    const deps = (dispatch: NonNullable<StandingOrdersDeps["dispatch"]>) => ({ dispatch, givenStore, backlog: async () => backlog });
    const first = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    await fixture([{ pane: andy, state: "idle", since: iso(T0 - 20 * MIN), modelId: "claude-opus-5-5" }], [], [], deps(first)).orders.tickOwner(owner);
    expect(first.mock.calls.map((call) => call[3])).toEqual(["Fix cause x"]);
    expect(stored).toEqual({ [`${owner}\u0000upgrade:cause x`]: andy.id });
    // The restart: new orders, same store, x still open. Bob is free: he gets y, never x again.
    const second = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    await fixture([{ pane: bob, state: "idle", since: iso(T0 - 20 * MIN), modelId: "claude-opus-5-5" }], [], [], deps(second)).orders.tickOwner(owner);
    expect(second.mock.calls.map((call) => call[3])).toEqual(["Fix cause y"]);
    // Another restart after Nous marked x DONE: Cody gets the new z, and x left the store.
    const third = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    backlog = [backlog[1]!, { key: "upgrade:cause z", text: "Fix cause z" }];
    await fixture([{ pane: cody, state: "idle", since: iso(T0 - 20 * MIN), modelId: "claude-opus-5-5" }], [], [], deps(third)).orders.tickOwner(owner);
    expect(third.mock.calls.map((call) => call[3])).toEqual(["Fix cause z"]);
    expect(stored).toEqual({ [`${owner}\u0000upgrade:cause y`]: bob.id, [`${owner}\u0000upgrade:cause z`]: cody.id });
  });

  // Goal 5acd171d (23/11: 135 of 633 INBOX turns in 24 h were this push after Space had handed the finished pane its work itself).
  it("starts the finished pane's push turn at once only while a pane, plan or task is left for Nous", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const f = fixture([{ pane: andy, state: "working", since: iso(T0 - 5 * MIN), modelId: "claude-opus-5-5" }, { pane: bob, state: "working", since: iso(T0 - 5 * MIN), modelId: "claude-opus-5-5" }], [], [],
      { dispatch, backlog: async () => [{ key: "upgrade:cause x", text: "Fix cause x" }] });
    await f.orders.tickOwner(owner);
    const soon = () => f.notice.mock.calls.filter((call) => call[1] === "utilization-low").at(-1)![4];
    // Andy finishes and Space hands it the fix itself: nothing is left for Nous, so the line waits for the inbox batch.
    f.advance(2 * MIN);
    f.panes[0] = { pane: andy, state: "done", since: iso(T0 + MIN), modelId: "claude-opus-5-5" };
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((call) => call[2])).toEqual([andy.id]);
    expect(soon()).toBe(false);
    // Bob finishes with nothing left to hand out: he is Nous's free item, so the turn starts at once.
    f.advance(2 * MIN);
    f.panes[1] = { pane: bob, state: "done", since: iso(T0 + 3 * MIN), modelId: "claude-opus-5-5" };
    await f.orders.tickOwner(owner);
    expect(f.pushes().at(-1)!.map((item) => item.key)).toContain(`free:${bob.id}`);
    expect(soon()).toBe(true);
  });

  // 22/11 (nous_msg:0e499daa, load 14-42 % all night with 0 plans to run and the queue dry): an ACTIVE goal is a piece for any free CLI pane,
  // held while the pane that got it is open, back in the hand-out once that pane closes.
  it("hands an active goal to a free pane of any model, once while its pane is open, again after that pane closes", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const f = fixture([{ pane: cody, ...idle, modelId: "claude-sonnet-5-5" }], [], [],
      { dispatch, backlog: async () => [{ key: "goal:nous_goal:g1", text: "Work on goal g1", strong: false }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls).toEqual([[owner, room.id, cody.id, "Work on goal g1"]]);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch).toHaveBeenCalledTimes(1);
    f.panes.splice(0, 1, { pane: andy, ...idle, modelId: "claude-opus-5-5" });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.at(-1)).toEqual([owner, room.id, andy.id, "Work on goal g1"]);
  });

  // 23/11 13:09 BKK (operator «εμφανιζει errors δες γιατι!!»): goal pieces went to the Design pane, which failed each as "not a graphic request".
  it("hands out work only to plain CLI panes, never to an idle copilot pane such as Design", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const design = { ...cli("pane:dino0001", "Dino"), mode: "DESIGN" } as Pane;
    const f = fixture([{ pane: design, ...idle }, { pane: cody, ...idle }], [], [],
      { dispatch, backlog: async () => [{ key: "goal:nous_goal:g1", text: "Work on goal g1", strong: false }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls).toEqual([[owner, room.id, cody.id, "Work on goal g1"]]);
    expect(f.pushes().flat().some((item) => item.pane === design.id)).toBe(false);
  });

  // 22/11 05:42Z (operator nous_msg:37276cdc «90%»): a goal went to a free Opus pane while a Gemini pane sat free; the sweep after it was strong-only.
  it("hands an any-model piece to a free non-strong pane first, keeping the strong pane for the strong piece", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const f = fixture([{ pane: andy, ...idle, modelId: "claude-opus-5-5" }, { pane: cody, ...idle, modelId: "gemini-4-argon-high" }], [], [],
      { dispatch, backlog: async () => [{ key: "goal:nous_goal:g1", text: "Work on goal g1", strong: false }, { key: "upgrade:x", text: "Fix x" }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((call) => [call[2], call[3]])).toEqual([[cody.id, "Work on goal g1"], [andy.id, "Fix x"]]);
  });

  // Operator 18/11 nous_msg:d52165794bee «αυστηρα δεν θα βαζεις κανενα flash Μοντελο να αλλαζει κώδικα!!»: the hand-out above gave goals to Gemini Flash.
  it("hands no piece to a free Flash pane; the any-model piece goes to the next free pane", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const f = fixture([{ pane: andy, ...idle, modelId: "claude-opus-5-5" }, { pane: cody, ...idle, modelId: "gemini-3.8-flash" }], [], [],
      { dispatch, backlog: async () => [{ key: "goal:nous_goal:g1", text: "Work on goal g1", strong: false }], sweep: () => [{ key: "sweep:a", text: "Sweep a" }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((call) => [call[2], call[3]])).toEqual([[andy.id, "Work on goal g1"]]);
  });

  // Operator 22/11 (nous_msg:719620b3a7bb46fd8d85f717): when Claude has no room, Antigravity Gemini 4 Neon takes strong code work too.
  it("hands strong code work to a free Gemini 4 Neon pane when Claude is refused", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const neon = { ...cody, terminalRuntimeId: "cli:gemini" } as Pane;
    const f = fixture([{ pane: neon, ...idle, modelId: "gemini-4-neon-high" }], [], [],
      { dispatch, spend: async () => ({ mode: "NORMAL", avoid: [], refused: ["claude"] }), backlog: async () => [{ key: "upgrade:cause x", text: "Fix cause x" }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls).toEqual([[owner, room.id, neon.id, "Fix cause x"]]);
  });

  // DEV3D-046: a code plan whose minimum is Neon (set while Claude had no room) or Astra stays code work once Claude has room: never to a Sol pane.
  it("hands a plan whose minimum model is Gemini 4 Neon or GPT-6 Astra only to a code pane, never to a free Sol pane", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const f = fixture([{ pane: cody, ...idle, modelId: "gpt-6-sol" }, { pane: andy, ...idle, modelId: "claude-opus-5-5" }],
      [plan("clipboard:n", null as never, ["PENDING"], { roomId: room.id, minimumModel: "gemini-4-neon" }),
        plan("clipboard:a", null as never, ["PENDING"], { roomId: room.id, minimumModel: "gpt-6-astra" })], [], { dispatch });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((call) => call[2])).toEqual([andy.id]);
  });

  // 22/11 (operator nous_msg:37276cdc, no push to 90 % all night): with the backlog all given, a free strong pane gets a hygiene sweep of one
  // area, least recently swept first, held only while its pane works, so the hand-out never runs dry.
  it("falls back to hygiene sweeps once the backlog is given, cycling areas and never running dry", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const idle = { state: "idle", since: iso(T0 - 20 * MIN) };
    const sweep = sweepPieces(process.cwd().replace(/\/apps\/api$/, ""));
    expect(sweep.map((piece) => piece.key)).toEqual(expect.arrayContaining(["sweep:apps/api/src/nous", "sweep:apps/api/src/*.ts(x)", "sweep:packages/contracts/src/*.ts(x)", "sweep:scripts"]));
    // A folder with no code file (images only) is no sweep area.
    expect(sweep.map((piece) => piece.key)).not.toContain("sweep:apps/web/src/assets");
    expect(sweep[0]!.text).toContain("GitHub issue without a label");
    // 22/11 CONFLICT storm: only the one lint-ceiling piece edits --max-warnings; area sweeps leave it alone.
    expect(sweep[0]!.text).toContain("do not change --max-warnings in package.json");
    expect(sweep.filter((piece) => piece.text.includes("set --max-warnings")).map((piece) => piece.key)).toEqual(["sweep:lint-ceiling"]);
    // Operator 24/11 (memory 258fedce): sweeps go only to Space's own sweep pane (Sam); Andy, a pane with its own work, never gets one.
    // Sam runs Gemini 4 Neon and gets sweeps although Claude has room (24/11 19:27 BKK correction).
    const sam = { ...cli("pane:sam00001", "Sam"), title: NOUS_SWEEP_PANE_TITLE, titleSource: "manual" } as Pane;
    const openSweepPane = vi.fn(async () => null);
    const f = fixture([{ pane: andy, ...idle, modelId: "claude-opus-5-5" }, { pane: cody, ...idle, modelId: "claude-sonnet-5-5" }, { pane: sam, ...idle, modelId: "gemini-4-neon-high" }], [], [],
      { dispatch, openSweepPane, backlog: async () => [{ key: "registry:F1", text: "Fix F1" }],
        sweep: () => [{ key: "sweep:a", text: "Sweep a" }, { key: "sweep:b", text: "Sweep b" }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    // F1 goes to Andy (a sweep pane takes only sweeps); Sam gets the first sweep. Cody (Sonnet) gets no code sweep.
    expect(dispatch.mock.calls).toEqual([[owner, room.id, andy.id, "Fix F1"], [owner, room.id, sam.id, "Sweep a"]]);
    // While Sam works area a, Andy stays free and gets no sweep; b waits for a free sweep pane (none opens: the open returns null).
    f.panes[2] = { pane: sam, state: "working", since: iso(T0) };
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch).toHaveBeenCalledTimes(2);
    // Free again, Sam gets b (least recently swept), then a again.
    f.panes[2] = { pane: sam, ...idle, modelId: "gemini-4-neon-high" };
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.slice(2).map((call) => call[3])).toEqual(["Sweep b", "Sweep a"]);
    expect(dispatch.mock.calls.slice(1).every((call) => call[2] === sam.id)).toBe(true);
    // Sam is Space's: it is no "free pane" item for Nous to hand other work.
    expect(f.pushes().flat().some((item) => item.pane === sam.id)).toBe(false);
  });

  // Operator 24/11 13:07 BKK (nous_msg:be8aea8592914e98b55cf568): 25 panes with their own work got sweeps when idle and closed half done.
  it("opens a dedicated sweep pane instead of handing a sweep to a done pane with its own task, one per push, on Gemini 4 Neon while Claude is refused, none while Gemini is shut", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const openSweepPane = vi.fn(async () => ({ roomId: room.id, paneId: "pane:new00001" }));
    let refused: string[] = [];
    const f = fixture([{ pane: andy, state: "done", since: iso(T0 - 20 * MIN), modelId: "claude-opus-5-5" }], [], [],
      { dispatch, openSweepPane, spend: async () => ({ mode: "NORMAL", avoid: [], refused }), sweep: () => [{ key: "sweep:a", text: "Sweep a" }, { key: "sweep:b", text: "Sweep b" }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(openSweepPane).toHaveBeenCalledTimes(1);
    // Andy (its own work done, free) gets no sweep and stays a free pane for Nous.
    expect(dispatch.mock.calls).toEqual([[owner, room.id, "pane:new00001", "Sweep a"]]);
    expect(f.pushes().at(-1)!.map((item) => item.key)).toContain(`free:${andy.id}`);
    refused = ["claude"];
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(openSweepPane).toHaveBeenCalledTimes(2);
    refused = ["gemini"];
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(openSweepPane).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls.some((call) => call[2] === andy.id)).toBe(false);
  });

  // 22/11 stable 04:02-04:20Z: the send guard refused registry:F1 (another pane had it), and that refusal took the only free pane every push.
  it("keeps a pane free after a refused piece and gives it the next one; a pane refused twice leaves", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async (_owner, _room, paneId, text) => paneId === andy.id && text !== "Fix F1");
    const idle = { state: "idle", since: iso(T0 - 20 * MIN), modelId: "claude-opus-5-5" };
    const f = fixture([{ pane: andy, ...idle }, { pane: cody, ...idle }], [], [],
      { dispatch, backlog: async () => [{ key: "registry:F1", text: "Fix F1" }, { key: "registry:F2", text: "Fix F2" }, { key: "registry:F3", text: "Fix F3" }, { key: "registry:F4", text: "Fix F4" }] });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    // Andy: F1 refused, F2 sent. Cody: F3 and F4 refused, then it leaves.
    expect(dispatch.mock.calls.map((call) => `${call[2] === andy.id ? "Andy" : "Cody"} ${call[3]}`)).toEqual(["Andy Fix F1", "Andy Fix F2", "Cody Fix F3", "Cody Fix F4"]);
    // wiring.ts names the ledger without its path, so one finding's send never holds another's as the same work.
    expect(sendWorkKeys("Quality-registry finding SEC-014 (P2) in the quality registry (review-findings.json under docs/quality) (resolution open or partial).")).toEqual([]);
  });

  // 21/11 (nous_msg:694ff0a9): Alex/Finn, idle Opus, got no backlog because the operator had typed there last ("awaits-operator").
  it("hands backlog to a pane the operator prompted last once its answer asks nothing and his turn's grace has passed", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const alex = cli("pane:alex0001", "Alex"), finn = cli("pane:finn0001", "Finn"), gus = cli("pane:gus00001", "Gus");
    for (const pane of [alex, finn]) noteOperatorPromoteLine(pane.id, "look at the load", "pane-prompt", T0 - 30 * MIN);
    noteOperatorPromoteLine(gus.id, "look at the load", "pane-prompt", T0 + 8 * MIN);
    const opus = { state: "idle", modelId: "claude-opus-5-5" };
    const report = (paneId: string, summary: string) => ({ id: `report:${paneId}`, paneId, status: "TURN_END", source: "AUTO", summary, body: null, createdAt: iso(T0 - 20 * MIN) });
    const f = fixture([{ pane: alex, ...opus, since: iso(T0 - 20 * MIN) }, { pane: finn, ...opus, since: iso(T0 - 20 * MIN) }, { pane: gus, ...opus, since: iso(T0 + 8 * MIN) }], [], [],
      { dispatch, backlog: async () => [{ key: "upgrade:a", text: "Fix a" }, { key: "upgrade:b", text: "Fix b" }, { key: "upgrade:c", text: "Fix c" }] }, [], [],
      [report(alex.id, "Load fixed, ticket q-1 deployed."), report(finn.id, "Shall I deploy it to stable?"), report(gus.id, "Done.")]);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    // Finn's answer asks him a question and Gus finished 2 minutes ago, inside the operator's turn: neither gets work.
    expect(dispatch.mock.calls).toEqual([[owner, room.id, alex.id, "Fix a"]]);
  });

  // Operator 23/11 (supersedes 22/11 nous_msg:f7088455): a pane whose question is open, in a card or not, gets no backlog until it is answered.
  // 23/11 02:36Z Cody got a sweep over «…merge queue;» followed by "---" and a «Δεν έλεγξα …» caveat.
  it("hands no backlog to a pane whose question is open, with or without its card, nor to one whose question sits above a rule and a caveat", async () => {
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    const dana = cli("pane:dana0001", "Dana"), eli = cli("pane:eli00001", "Eli");
    const opus = { state: "idle", modelId: "claude-opus-5-5", since: iso(T0 - 40 * MIN) };
    const report = (paneId: string) => ({ id: `report:${paneId}`, paneId, status: "NEEDS_YOU", source: "AGENT", summary: "Approve the stable promote?", body: null, createdAt: iso(T0 - 40 * MIN) });
    const card = { id: "notif:dana", paneId: dana.id, roomId: room.id, source: "AGENT", kind: "NEEDS_YOU", severity: "ATTENTION", status: "OPEN", title: "Dana needs you",
      createdAt: iso(T0 - 40 * MIN), updatedAt: iso(T0 - 40 * MIN), dismissedAt: null, resolvedAt: null, dedupeKey: null, payload: {} };
    const f = fixture([{ pane: dana, ...opus }, { pane: eli, ...opus }], [], [],
      { dispatch, backlog: async () => [{ key: "upgrade:a", text: "Fix a" }, { key: "upgrade:b", text: "Fix b" }] }, [], [card], [report(dana.id), report(eli.id)]);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch).not.toHaveBeenCalled();
    const cody2 = cli("pane:cody0002", "Cody"), body = "1. Fix the seed.\n\nΘες να τα υλοποιήσω, με tests, και να τα στείλω στο dev μέσω του merge queue;\n\n---\nΔεν έλεγξα τη βάση του spaceapp-hz.";
    const fay = cli("pane:fay00001", "Fay"), turnEnd = (paneId: string, text: string) => ({ ...report(paneId), status: "TURN_END", source: "AUTO", summary: text, body: text });
    const g = fixture([{ pane: cody2, ...opus }, { pane: fay, ...opus }], [], [], { dispatch, backlog: async () => [{ key: "upgrade:a", text: "Fix a" }] }, [], [],
      [turnEnd(cody2.id, body), turnEnd(fay.id, "Deployed.\n\n---\nΔεν έλεγξα τη βάση του spaceapp-hz.")]);
    g.advance(10 * MIN);
    await g.orders.tickOwner(owner);
    expect(dispatch.mock.calls).toEqual([[owner, room.id, fay.id, "Fix a"]]);
    // Operator 24/11 12:50 BKK: a copilot's review waits in its queue, not at the pane's prompt, so the pane still gets work.
    const hal = cli("pane:hal00001", "Hal"), review = { ...card, id: "notif:hal", paneId: hal.id, source: "MAIL_COPILOT", kind: "REVIEW_REQUESTED", title: "Mail review" };
    const h = fixture([{ pane: hal, ...opus }], [], [], { dispatch, backlog: async () => [{ key: "upgrade:c", text: "Fix c" }] }, [], [review], [turnEnd(hal.id, "Deployed.")]);
    h.advance(10 * MIN);
    await h.orders.tickOwner(owner);
    expect(dispatch.mock.calls.at(-1)).toEqual([owner, room.id, hal.id, "Fix c"]);
  });

  // Goal 5acd171d (25/11 audit of 24/11 BKK: 1,075/1,184 sweeps = 91% were "nothing to fix", 213.6M tokens / $87.5/day):
  // clean sweep areas skip re-sweeps until a dev commit touches them or 24 h pass, persisting across restarts.
  it("skips hygiene sweep areas that reported nothing to fix until dev touches them or 24 h pass, and keeps fixed areas eligible", async () => {
    expect(sweepAreaTouched("sweep:apps/api/src/computer", ["apps/api/src/computer/index.ts"])).toBe(true);
    expect(sweepAreaTouched("sweep:apps/api/src/computer", ["apps/api/src/computer-extra/index.ts"])).toBe(false);
    expect(sweepAreaTouched("sweep:apps/api/src/*.ts(x)", ["apps/api/src/app.ts"])).toBe(true);
    expect(sweepAreaTouched("sweep:apps/api/src/*.ts(x)", ["apps/api/src/nous/tools.ts", "apps/api/src/README.md"])).toBe(false);
    expect(sweepAreaTouched("sweep:lint-ceiling", [])).toBe(false);
    expect(sweepAreaTouched("sweep:lint-ceiling", ["apps/web/src/features/Foo.tsx"])).toBe(true);

    expect(isCleanSweepReport({ status: "DONE", summary: "Hygiene sweep apps/api/src/computer: nothing to fix.", ticket: null })).toBe(true);
    expect(isCleanSweepReport({ status: "DONE", summary: "Hygiene sweep apps/api/src/vault: τίποτα να διορθωθεί.", ticket: null })).toBe(true);
    expect(isCleanSweepReport({ status: "DONE", summary: "Lint ceiling: 1074 = current --max-warnings", ticket: null })).toBe(true);
    expect(isCleanSweepReport({ status: "DONE", summary: "Fixed warning (nothing left to fix).", ticket: "q-20261125-010000-abcd" })).toBe(false);
    expect(isCleanSweepReport({ status: "PROGRESS", summary: "nothing to fix so far", ticket: null })).toBe(false);
    // 26/11: wordings the old list missed count; provider stops and named tickets do not.
    expect(isCleanSweepReport({ status: "DONE", summary: "apps/api/src/vault sweep clean on dev; lint 0 warnings.", ticket: null })).toBe(true);
    expect(isCleanSweepReport({ status: "DONE", summary: "Η σάρωση σταμάτησε λόγω 503 του Gemini.", ticket: null })).toBe(false);
    expect(isCleanSweepReport({ status: "DONE", summary: "Gemini usage limit reached; sweep not run.", ticket: null })).toBe(false);
    expect(isCleanSweepReport({ status: "DONE", summary: "Fixed 2 warnings, submitted q-20261125-010000-abcd.", ticket: null })).toBe(false);

    const sam = { ...cli("pane:sam00002", "Sam"), title: NOUS_SWEEP_PANE_TITLE, titleSource: "manual" } as Pane;
    const idle = { state: "idle", since: iso(T0 - 20 * MIN), modelId: "gemini-4-neon-high" };
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    let allowOpen = false;
    const openSweepPane = vi.fn(async () => allowOpen ? { roomId: room.id, paneId: "pane:extra001" } : null);
    let head = "rev-1";
    let changedFiles: string[] = [];
    let persisted: Record<string, CleanSweepMark> = {};
    const cleanSweepStore = { read: async () => ({ ...persisted }), write: async (entries: Record<string, CleanSweepMark>) => { persisted = { ...entries }; } };
    const sweepGit = { head: async () => head, changed: async () => changedFiles };
    const paneReports: Array<{ id: string; paneId: string; status: string; source: string; summary: string; ticket: string | null; at: string }> = [];
    const reportsSince: StandingOrdersDeps["reportsSince"] = async (_o, paneId, since) =>
      paneReports.filter((r) => r.paneId === paneId && r.at >= since) as never;
    const areas = [
      { key: "sweep:apps/api/src/computer", text: "Sweep computer" },
      { key: "sweep:apps/web/src/features", text: "Sweep features" }
    ];

    const f = fixture([{ pane: sam, ...idle }], [], [], { dispatch, openSweepPane, reportsSince, cleanSweepStore, sweepGit, sweep: () => areas });
    // Tick 1: Sam gets computer (first area).
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((c) => c[3])).toEqual(["Sweep computer"]);

    // Sam finishes computer with "nothing to fix" (no ticket).
    paneReports.push({ id: "r1", paneId: sam.id, status: "DONE", source: "AGENT", summary: "Hygiene sweep apps/api/src/computer: nothing to fix.", ticket: null, at: iso(T0 + 12 * MIN) });
    // Tick 2: computer is marked clean & persisted; Sam gets features.
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((c) => c[3])).toEqual(["Sweep computer", "Sweep features"]);
    expect(persisted[`${owner}\u0000sweep:apps/api/src/computer`]).toEqual({ at: T0 + 20 * MIN, head: "rev-1" });

    // Sam fixes one file in features (DONE with ticket) -> features stays dirty and gets dispatched again; computer stays skipped.
    paneReports.push({ id: "r2", paneId: sam.id, status: "DONE", source: "AGENT", summary: "Cleared 3 eslint warnings.", ticket: "q-20261125-010000-1111", at: iso(T0 + 22 * MIN) });
    head = "rev-2";
    changedFiles = ["apps/web/src/features/Foo.tsx"];
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((c) => c[3])).toEqual(["Sweep computer", "Sweep features", "Sweep features"]);
    // Computer stayed clean and advanced its head to rev-2.
    expect(persisted[`${owner}\u0000sweep:apps/api/src/computer`]?.head).toBe("rev-2");

    // Sam now finishes features with "nothing to fix" too -> both clean, so nothing is dispatched and no extra sweep pane opens!
    openSweepPane.mockClear();
    allowOpen = true;
    paneReports.push({ id: "r3", paneId: sam.id, status: "DONE", source: "AGENT", summary: "Nothing to fix in apps/web/src/features.", ticket: null, at: iso(T0 + 32 * MIN) });
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(openSweepPane).not.toHaveBeenCalled();

    // Simulate API restart (new StandingOrders reading cleanSweepStore): still skipped at same head.
    const restarted = fixture([{ pane: sam, ...idle }], [], [], { dispatch, openSweepPane, reportsSince, cleanSweepStore, sweepGit, sweep: () => areas });
    restarted.advance(50 * MIN);
    await restarted.orders.tickOwner(owner);
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(openSweepPane).not.toHaveBeenCalled();

    // A commit on dev touches apps/api/src/computer -> computer immediately re-opens and gets swept.
    allowOpen = false;
    head = "rev-3";
    changedFiles = ["apps/api/src/computer/runner.ts"];
    restarted.advance(10 * MIN);
    await restarted.orders.tickOwner(owner);
    expect(dispatch.mock.calls.at(-1)?.[3]).toBe("Sweep computer");

    // After 24 h (SWEEP_CLEAN_TTL_MS), features' clean mark expires even with no git change.
    restarted.advance(SWEEP_CLEAN_TTL_MS);
    await restarted.orders.tickOwner(owner);
    expect(dispatch.mock.calls.at(-1)?.[3]).toBe("Sweep features");
  });

  // 26/11: council DONE at 03:41 after a late TURN_END and >2 min of work was never marked (re-swept 08:47), and restarts lost sweeps in flight.
  it("marks a sweep clean from its DONE after a TURN_END, a long run and an API restart, and drops a pane's older sweep on a new one", async () => {
    const sam = { ...cli("pane:sam00003", "Sam"), title: NOUS_SWEEP_PANE_TITLE, titleSource: "manual" } as Pane;
    const dispatch = vi.fn<NonNullable<StandingOrdersDeps["dispatch"]>>(async () => true);
    let persisted: Record<string, CleanSweepMark> = {};
    const cleanSweepStore = { read: async () => ({ ...persisted }), write: async (entries: Record<string, CleanSweepMark>) => { persisted = { ...entries }; } };
    const sweepGit = { head: async () => "rev-1", changed: async () => [] };
    const paneReports: Array<{ id: string; paneId: string; status: string; source: string; summary: string; ticket: string | null; at: string }> = [];
    const reportsSince: StandingOrdersDeps["reportsSince"] = async (_o, paneId, since) => paneReports.filter((r) => r.paneId === paneId && r.at >= since) as never;
    const areas = [{ key: "sweep:apps/api/src/council", text: "Sweep council" }, { key: "sweep:apps/api/src/mail", text: "Sweep mail" }, { key: "sweep:apps/api/src/vault", text: "Sweep vault" }];
    const deps = { dispatch, openSweepPane: async () => null, reportsSince, cleanSweepStore, sweepGit, sweep: () => areas };
    const councilKey = `${owner}\u0000sweep:apps/api/src/council`;

    const f = fixture([{ pane: sam, state: "idle", since: iso(T0 - 20 * MIN), modelId: "gemini-4-neon-high" }], [], [], deps);
    f.advance(10 * MIN);
    await f.orders.tickOwner(owner);
    expect(dispatch.mock.calls.map((c) => c[3])).toEqual(["Sweep council"]);
    expect(persisted[councilKey]).toEqual({ at: T0 + 10 * MIN, head: null, pane: sam.id });

    // A late TURN_END of the previous turn and 5 min of work: the sweep stays pending.
    paneReports.push({ id: "t1", paneId: sam.id, status: "TURN_END", source: "HOOK", summary: "turn ended", ticket: null, at: iso(T0 + 11 * MIN) });
    f.panes[0] = { pane: sam, state: "working", since: iso(T0 + 11 * MIN), modelId: "gemini-4-neon-high" };
    f.advance(5 * MIN);
    await f.orders.tickOwner(owner);
    expect(persisted[councilKey]?.pane).toBe(sam.id);

    // The API restarts; the DONE lands afterwards and the new process still marks council clean.
    paneReports.push({ id: "d1", paneId: sam.id, status: "DONE", source: "AGENT", summary: "apps/api/src/council sweep clean on dev.", ticket: null, at: iso(T0 + 17 * MIN) });
    const restarted = fixture([{ pane: sam, state: "done", since: iso(T0 + 17 * MIN), modelId: "gemini-4-neon-high" }], [], [], deps);
    restarted.advance(20 * MIN);
    await restarted.orders.tickOwner(owner);
    expect(persisted[councilKey]).toEqual({ at: T0 + 20 * MIN, head: "rev-1" });
    expect(dispatch.mock.calls.map((c) => c[3])).toEqual(["Sweep council", "Sweep mail"]);

    expect(persisted[`${owner}\u0000sweep:apps/api/src/mail`]?.pane).toBe(sam.id);

    // Mail stops without a DONE (a 503 ends its turn) and Sam gets vault: mail's pending entry ends, so vault's clean DONE is not credited to mail.
    restarted.advance(10 * MIN);
    await restarted.orders.tickOwner(owner);
    expect(dispatch.mock.calls.at(-1)?.[3]).toBe("Sweep vault");
    expect(persisted[`${owner}\u0000sweep:apps/api/src/mail`]).toBeUndefined();
    paneReports.push({ id: "d2", paneId: sam.id, status: "DONE", source: "AGENT", summary: "Nothing to fix in apps/api/src/vault.", ticket: null, at: iso(T0 + 35 * MIN) });
    restarted.advance(10 * MIN);
    await restarted.orders.tickOwner(owner);
    expect(persisted[`${owner}\u0000sweep:apps/api/src/vault`]).toEqual({ at: T0 + 40 * MIN, head: "rev-1" });
    expect(persisted[`${owner}\u0000sweep:apps/api/src/mail`]?.head).toBeNull();
    expect(dispatch.mock.calls.at(-1)?.[3]).toBe("Sweep mail");
  });
});
