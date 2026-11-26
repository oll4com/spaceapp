import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";
import { closeoutSkipReason } from "../src/nous/standing-orders.js";
import type { BoardPaneInput } from "../src/nous/pane-board.js";
import { noteOperatorPaneInput, operatorPaneReason } from "../src/queue-operator-grants.js";
import { noteSpacePrompt } from "../src/space-prompts.js";

/** Operator 21/11 23:27 BKK nous_msg:63896af5: Nous never closes nor lists as finished a pane the operator opened or prompted. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const dino = { id: "room:dino0001", name: "Dino", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const MIN = 60_000;
const pane = (id: string, paneName: string, ageMs: number) =>
  ({ id, roomId: dino.id, paneName, title: paneName, mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false, createdAt: new Date(Date.now() - ageMs).toISOString() } as unknown as Pane);

function tools(panes: Pane[], states: Record<string, string> = {}) {
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
    quotaWaits: async () => []
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
