import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** Token audit 21/11: input forms Nous used that were refused and retried are read as what they mean on the first call. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t21", callId: "toolu_21", traceId: "trace:21" };
const work = { id: "room:work00001", name: "Work", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const home = { id: "room:home00001", name: "Home", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const kate = { id: "pane:kate00001", roomId: work.id, paneName: "Kate", title: "Kate", mode: "DESIGN", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const kateHome = { ...kate, id: "pane:kate00002", roomId: home.id } as unknown as Pane;

const tools = (overrides: Partial<NousToolDeps> = {}) => createNousTools({
  world: async () => "world", rooms: async () => [work, home], listPanes: async (roomId: string) => roomId === work.id ? [kate] : [kateHome],
  roomTool: vi.fn(async () => ({ ok: true, display: "ran", result: "ran" })),
  inspectPane: async () => ({ text: "", state: "UNKNOWN", sessionId: "session:1", tasks: [] }),
  allowances: async () => ({ promote: false, warm: false }), notifications: { list: async () => [], resolve: async () => true }, paneNotices: {},
  ...overrides
} as unknown as NousToolDeps);

describe("token audit 21/11: first calls that used to be refused", () => {
  it("reads a follow-up's missing or reworded op", async () => {
    const run = vi.fn(async () => ({ ok: true, display: "done", result: "done" }));
    const nous = tools({ followups: { run } } as never);
    for (const [args, op] of [
      [{ note: "Check the deploy", inMinutes: 30 }, "add"],
      [{ op: "Schedule", note: "Check the deploy", inMinutes: 30 }, "add"],
      [{ followup: "nous_followup:abcdef12" }, "cancel"],
      [{ op: "remove", followup: "nous_followup:abcdef12" }, "cancel"],
      [{}, "list"],
      [{ op: "show" }, "list"]
    ] as const) {
      expect((await nous.execute("space_nous_followup", args, ctx)).refused, JSON.stringify(args)).toBeFalsy();
      expect(run).toHaveBeenLastCalledWith(owner, expect.objectContaining({ op }), null);
    }
    expect(await nous.execute("space_nous_followup", { op: "snooze" }, ctx)).toMatchObject({ ok: false });
    for (const followup of ["abcdef12", "followup:abcdef12"]) {
      await nous.execute("space_nous_followup", { op: "cancel", followup }, ctx);
      expect(run).toHaveBeenLastCalledWith(owner, expect.objectContaining({ followup: "nous_followup:abcdef12" }), null);
    }
  });

  it("reads an outcome written in the close words (note, messageId) and a bare pane id", async () => {
    const real = { id: "nous_msg:real0001", kind: "OPERATOR", ownerUserId: owner, meta: { person: true }, content: "Fix the export" };
    const nous = createNousTools({ listConversation: async () => [real] } as unknown as NousToolDeps);
    const turn = { ...ctx, turn: { reason: "STANDING", operatorMessage: null, replyTo: [] } } as never;
    const result = await nous.execute("space_nous_outcome", { requests: [{ messageId: real.id, note: "Export fix sent to Kate", outcome: "PENDING", pane: "kate00001abc" }] }, turn);
    expect(result).toMatchObject({ ok: true });
    expect((result as { outcomes?: unknown[] }).outcomes?.[0]).toMatchObject({ summary: "Export fix sent to Kate" });
  });

  it("reads a pane written Room/Pane with no room as that pane in that room, and one pane in a list as that pane", async () => {
    const state = vi.fn(async () => "state");
    const nous = tools({ copilots: { state } } as never);
    for (const pane of ["Work/Kate", "Work / Kate", ["Work/Kate"]]) {
      expect(await nous.execute("space_copilot_state", { pane }, ctx), JSON.stringify(pane)).toMatchObject({ ok: true });
      expect(state).toHaveBeenLastCalledWith(owner, expect.objectContaining({ id: kate.id }), undefined);
    }
    // Kate is open in two rooms: with no room named the answer still asks which.
    expect(await nous.execute("space_copilot_state", { pane: "Kate" }, ctx)).toMatchObject({ ok: false, result: expect.stringContaining("room is required") });
    // An unknown room before the slash is left as written.
    expect((await nous.execute("space_copilot_state", { pane: "Nowhere/Kate" }, ctx)).ok).toBe(false);
  });
});
