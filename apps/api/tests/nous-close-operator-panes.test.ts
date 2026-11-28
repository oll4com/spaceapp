import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { closeoutSkipReason } from "../src/nous/standing-orders.js";
import type { BoardPaneInput } from "../src/nous/pane-board.js";
import { noteOperatorPaneInput, operatorPaneReason, operatorWorkHold } from "../src/queue-operator-grants.js";
import { noteSpacePrompt } from "../src/space-prompts.js";

/** Operator 21/11 23:27 BKK nous_msg:63896af5: Nous never closes nor lists as finished a pane the operator opened or prompted. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const dino = { id: "room:dino0001", name: "Dino", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const MIN = 60_000;
const pane = (id: string, paneName: string, ageMs: number) =>
  ({ id, roomId: dino.id, paneName, title: paneName, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false, createdAt: new Date(Date.now() - ageMs).toISOString() } as unknown as Pane);

function tools(panes: Pane[], states: Record<string, string> = {}, extra: Partial<NousToolDeps> = {}) {
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const deps: NousToolDeps = {
    world: async () => "world",
    rooms: async () => [dino],
    listPanes: async () => panes,
    inspectPane: async (p: Pane) => ({ text: "", state: states[p.id] ?? "IDLE", sessionId: "session:1", tasks: [] } as never),
    roomTool,
    plans: { list: async () => [], get: async () => null, update: vi.fn() as never },
    tasks: { list: async () => [], add: vi.fn() as never, update: vi.fn() as never, rebind: vi.fn() as never },
    clipboard: { list: async () => [], save: vi.fn() as never, complete: vi.fn() as never, remove: vi.fn(async () => {}) },
    memory: null,
    notifications: { list: async () => [], resolve: async () => true },
    releaseTrain: vi.fn(async () => ""),
    setNote: vi.fn(async () => {}),
    ask: vi.fn() as never,
    withdraw: vi.fn(async () => false),
    allowances: async () => ({ promote: false, warm: false }),
    answerPrompt: vi.fn(async () => ({})),
    paneNotices: {} as never,
    quotaWaits: async () => [],
    ...extra
  };
  return { tools: createNousTools(deps), roomTool };
}

const refused = { ok: false, refused: true, result: expect.stringContaining("the operator works there") };

describe("operator's panes close guard", () => {
  it("refuses an operator-opened fresh pane (space_close_pane and Space Control), unless the operator's own message asks for the close", async () => {
    const finn = pane("pane:finn0001", "Finn", 1 * MIN);
    const f = tools([finn]);
    expect(await f.tools.execute("space_close_pane", { room: "Dino", panes: ["Finn"], force: true }, ctx)).toMatchObject(refused);
    expect(await f.tools.execute("space_execute", { room: "Dino", actions: [{ kind: "pane", operation: "close", target: { paneIds: [finn.id] }, force: true }] }, ctx)).toMatchObject(refused);
    // DEV3D-020: a close named only by runtime and state reaches the same pane in Space Control, so it meets the same guard.
    expect(await f.tools.execute("space_execute", { room: "Dino", actions: [{ kind: "pane", operation: "close", target: { runtimeId: "cli:claude", state: "OPEN" }, force: true }] }, ctx)).toMatchObject(refused);
    // Their complaint is no close order.
    const complaint = { ...ctx, turn: { reason: "OPERATOR", operatorMessage: { person: true, content: "σταματα ν αμου κλεινεις πραθυρα" } } } as never;
    expect(await f.tools.execute("space_close_pane", { room: "Dino", panes: ["Finn"] }, complaint)).toMatchObject(refused);
    expect(f.roomTool).not.toHaveBeenCalled();
    const order = { ...ctx, turn: { reason: "OPERATOR", operatorMessage: { person: true, content: "Κλείσε το Finn" } } } as never;
    expect(await f.tools.execute("space_close_pane", { room: "Dino", panes: ["Finn"] }, order)).toMatchObject({ ok: true });
  });

  it("plan clipboard:CTVaL1V3kAFM step 5: their close order from an earlier turn closes their pane with force, when it names the pane or its room", async () => {
    const finn = pane("pane:finn0005", "Finn", MIN), kate = pane("pane:kate0005", "Kate", MIN);
    const said = (id: string, content: string, kind = "OPERATOR") => ({ id: `nous_msg:${id}`, ownerUserId: owner, kind, meta: kind === "OPERATOR" ? { person: true } : {}, content });
    const conversation = [said("closefinn", "Κλείσε το Finn όταν τελειώσει"), said("closeroom", "close every pane in Dino"), said("closeother", "close the other panes, dino's too"),
      said("nousnote", "close Finn", "NOUS"), said("keepfinn", "do not close Finn")];
    const f = tools([finn, kate], {}, { listConversation: async () => conversation as never });
    const close = (panes: string[], id: string, force = true) => f.tools.execute("space_close_pane", { room: "Dino", panes, force, operatorMessageId: `nous_msg:${id}` }, ctx);
    const viaExecute = (paneId: string, id: string) => f.tools.execute("space_execute", { room: "Dino", actions: [{ kind: "pane", operation: "close", target: { paneIds: [paneId] }, force: true, operatorMessageId: `nous_msg:${id}` }] }, ctx);
    // A Nous note, their "do not close", an order that names neither (the match is as written: "dino" is not the room), another pane's order, or no force: refused.
    for (const id of ["nousnote", "keepfinn", "closeother"]) expect(await close(["Finn"], id)).toMatchObject(refused);
    expect(await close(["Kate"], "closefinn")).toMatchObject({ ...refused, result: expect.stringMatching(/^Kate \(.*names the pane or its room as written, passed as operatorMessageId with force/) });
    expect(await close(["Finn"], "closefinn", false)).toMatchObject(refused);
    expect(await viaExecute(kate.id, "closefinn")).toMatchObject(refused);
    expect(await viaExecute(finn.id, "keepfinn")).toMatchObject(refused);
    expect(f.roomTool).not.toHaveBeenCalled();
    expect(await viaExecute(finn.id, "closefinn")).not.toMatchObject({ refused: true });
    expect(JSON.stringify(f.roomTool.mock.calls)).toContain(finn.id);
    expect(JSON.stringify(f.roomTool.mock.calls)).not.toContain("operatorMessageId");
    expect(await close(["Finn"], "closefinn")).toMatchObject({ ok: true });
    expect(await close(["Finn", "Kate"], "closeroom")).toMatchObject({ ok: true });
  });

  it("refuses a pane the operator prompted last, or gave its first prompt, however old", async () => {
    const bob = pane("pane:bob00002", "Bob", 5 * 60 * MIN);
    const ada = pane("pane:ada00002", "Ada", 5 * 60 * MIN);
    noteSpacePrompt(bob.id, Date.now() - 10 * MIN);
    noteOperatorPaneInput(bob.id, "fix it\r", Date.now() - 5 * MIN);
    noteOperatorPaneInput(ada.id, "start\r", Date.now() - 20 * MIN);
    noteSpacePrompt(ada.id, Date.now() - 10 * MIN);
    const f = tools([bob, ada]);
    expect(await f.tools.execute("space_close_pane", { room: "Dino", panes: ["Bob"] }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("prompted it last") });
    expect(await f.tools.execute("space_close_pane", { room: "Dino", panes: ["Ada"] }, ctx)).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("first prompt") });
    expect(f.roomTool).not.toHaveBeenCalled();
    // The load hand-out (nous_msg:694ff0a9) may give work to a prompted pane after the operator's grace; a fresh pane they opened stays theirs.
    expect([operatorPaneReason(bob, Date.now(), true), operatorPaneReason(ada, Date.now(), true)]).toEqual([null, null]);
    expect(operatorPaneReason(pane("pane:new00002", "New", MIN), Date.now(), true)).toContain("Space never prompted it");
  });

  it("plan clipboard:CTVaL1V3kAFM decision A: Nous's work stays out of a pane the operator prompted, while its turn runs and 5 min after", async () => {
    const eve = pane("pane:eve0000a", "Eve", 5 * 60 * MIN), ian = pane("pane:ian0000a", "Ian", 5 * 60 * MIN), ned = pane("pane:ned0000a", "Ned", MIN);
    noteOperatorPaneInput(eve.id, "fix it\r", Date.now() - 40 * MIN);
    noteSpacePrompt(ian.id, Date.now() - 50 * MIN);
    const since: Record<string, number> = { [eve.id]: 2 * MIN, [ian.id]: 45 * MIN, [ned.id]: MIN };
    const states: Record<string, string> = {};
    const f = tools([eve, ian, ned], states, { paneSince: async (_room, id) => new Date(Date.now() - since[id]!).toISOString() });
    const send = (panes: string[], turn: object = ctx) => f.tools.execute("space_send_to_pane", { room: "Dino", panes, text: "Run the next step of the plan now" }, turn as never);
    const viaExecute = (target: object) => f.tools.execute("space_execute", { room: "Dino", actions: [{ kind: "pane", operation: "prompt", target, text: "Run the next step of the plan now" }] }, ctx);
    const theirs = { ok: false, refused: true, result: expect.stringMatching(/^Not sent to Eve \(the operator prompted it last\): the operator works there.*open a new pane for it with space_open_panes\. Nothing was (sent|done)\.$/) };
    // Settled 2 min ago: refused through either tool, by id or by runtime; the pane Nous prompted and the fresh one it opened take the work.
    expect(await send(["Eve"])).toMatchObject(theirs);
    expect(await viaExecute({ paneIds: [eve.id] })).toMatchObject(theirs);
    expect(await viaExecute({ runtimeId: "cli:claude" })).toMatchObject(theirs);
    expect(f.roomTool).not.toHaveBeenCalled();
    const mixed = await send(["Eve", "Ian", "Ned"]);
    expect(mixed).toMatchObject({ ok: true, result: expect.stringMatching(/^Not sent to Eve \(/) });
    expect(JSON.stringify(f.roomTool.mock.calls)).not.toContain(eve.id);
    // Their own message's turn sends there, and so does the answer to its open question.
    const calls = f.roomTool.mock.calls.length;
    expect(await send(["Eve"], { ...ctx, turn: { reason: "OPERATOR", operatorMessage: { person: true, content: "πες στο Eve να συνεχίσει" } } })).toMatchObject({ ok: true });
    expect(await send(["Eve"], { ...ctx, answering: true })).toMatchObject({ ok: true });
    expect(f.roomTool.mock.calls.length).toBe(calls + 2);
    // Space's prompt is now its newest (the real submit marks it), yet their first prompt keeps it theirs: its turn runs, however long ago it started.
    noteSpacePrompt(eve.id);
    since[eve.id] = 20 * MIN; states[eve.id] = "RUNNING";
    expect(await send(["Eve"])).toMatchObject({ ok: false, refused: true, result: expect.stringContaining("Eve (the operator gave it its first prompt)") });
    // Idle past the grace: free capacity, as the load hand-out reads it (nous_msg:694ff0a9).
    states[eve.id] = "IDLE";
    expect(await send(["Eve"])).toMatchObject({ ok: true });
    // The clock is the later of the pane settling and their last line; a pane they never prompted is never held.
    const now = Date.now();
    noteOperatorPaneInput(eve.id, "and this\r", now - MIN);
    expect([operatorWorkHold(eve.id, false, new Date(now - 60 * MIN).toISOString(), now), operatorWorkHold(eve.id, false, null, now + 6 * MIN), operatorWorkHold(ned.id, true, null, now)])
      .toEqual(["the operator gave it its first prompt", null, null]);
  });

  it("still closes a finished pane Nous opened and prompted, and standing orders list only that one", async () => {
    const zed = pane("pane:zed00003", "Zed", 2 * MIN);
    const finn = pane("pane:finn0003", "Finn", 2 * MIN);
    noteSpacePrompt(zed.id, Date.now() - MIN);
    const f = tools([zed, finn]);
    expect(await f.tools.execute("space_close_pane", { room: "Dino", panes: ["Zed"] }, ctx)).toMatchObject({ ok: true });
    expect(f.roomTool).toHaveBeenCalledTimes(1);
    const now = Date.now();
    const base = { since: () => new Date(now - 31 * MIN).toISOString(), tasks: [], executions: [], summaries: [], now, finishedAfterMs: 30 * MIN, operatorPane: (p: Pane) => operatorPaneReason(p, now) };
    const input = (p: Pane): BoardPaneInput => ({ room: dino, pane: p, state: "done", model: null, report: null, plan: null, check: null, notifications: [], decisions: [], copilotItems: [] }) as BoardPaneInput;
    expect(closeoutSkipReason(input(finn), base as never)).toBe("operator-pane");
    expect(closeoutSkipReason(input(zed), base as never)).toBeNull();
  });

  it("closes the stopped panes by state while another pane still works (DEV3D-045)", async () => {
    const zed = pane("pane:zed00004", "Zed", 20 * MIN), ann = pane("pane:ann00004", "Ann", 20 * MIN);
    noteSpacePrompt(zed.id, Date.now() - 10 * MIN);
    noteSpacePrompt(ann.id, Date.now() - 10 * MIN);
    const f = tools([zed, ann], { [ann.id]: "RUNNING" });
    expect(await f.tools.execute("space_execute", { room: "Dino", actions: [{ kind: "pane", operation: "close", target: { runtimeId: "cli:claude", state: "STOPPED" } }] }, ctx)).toMatchObject({ ok: true });
    expect(JSON.stringify(f.roomTool.mock.calls)).toContain(zed.id);
    expect(JSON.stringify(f.roomTool.mock.calls)).not.toContain(ann.id);
  });
});
