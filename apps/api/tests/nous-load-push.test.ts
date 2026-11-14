// 13/11 09:12 BKK (operator «παλι εχει πεσει η πιεση σου και ειναι στο 66% το load !! γιατι δεν πιεζεις τα πραγματα??»; 14 of 31 CLI panes working):
// a pane that finishes with a plan step or a task to run is pushed at once, and a finished pane whose plan has only BLOCKED steps saves and closes.
import { describe, expect, it, vi } from "vitest";
import { nousSettingsSchema, type ClipboardItem, type Pane, type Room, type TaskItem } from "@space/contracts";
import { InMemoryNousPaneCloseoutsRepository, InMemoryNousPlanMarksRepository } from "@space/db";
import type { DashboardAgentsSample } from "../src/room-routes.js";
import { createStandingOrders, type StandingOrdersDeps } from "../src/nous/standing-orders.js";
import { itemActed, type NousTurnItem } from "../src/nous/turn-items.js";

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

function fixture(panes: Array<{ pane: Pane; state: string; since: string }>, plans: ClipboardItem[], tasks: TaskItem[] = [], deps: Partial<StandingOrdersDeps> = {}) {
  let clock = T0;
  const notice = vi.fn<NonNullable<StandingOrdersDeps["notice"]>>(async () => {});
  const standing = vi.fn<StandingOrdersDeps["standing"]>(async () => "STARTED");
  const sample = (): DashboardAgentsSample => ({ data: panes.map((entry) => entry.pane), sampledAt: iso(clock),
    activity: Object.fromEntries(panes.map((entry) => [entry.pane.id, entry.state])) as never,
    details: Object.fromEntries(panes.map((entry) => [entry.pane.id, { status: entry.state, since: entry.since, source: "native" }])) as never });
  const orders = createStandingOrders({ closeouts: new InMemoryNousPaneCloseoutsRepository(), marks: new InMemoryNousPlanMarksRepository(),
    settings: async () => nousSettingsSchema.parse({ enabled: true, standingOrders: { dailyReview: false } }), owners: async () => [owner],
    collect: async () => ({ rooms: [{ room, sample: sample() }], reports: [], notifications: [], decisions: [], copilotItems: [], plans, checks: [], tasks, executions: [], summaries: [] }),
    reportsSince: async () => [], standing, notice, now: () => clock, utilizationLow: async () => "Utilization stayed under the 90% target for 15 min.",
    review: { facts: async () => [], decisions: async () => [], timeZone: async () => "Asia/Bangkok" }, ...deps });
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
    expect(call[2]).toContain("CLI panes free since the last push (hand each the next piece of work below now): Main/Andy done");
    expect(call[2]).toContain("Plans not on a pane");
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
});
