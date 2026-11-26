import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { historicalToolHold } from "../src/nous/tool-holds.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** Nous errors 24/11: a reopen whose CLI readiness Space Control could not confirm is read again and answered from the read. */

const owner = "user:operator";
const ctx = { owner, turnId: "nous_turn:t24", callId: "toolu_24", traceId: "trace:24" };
const room = { id: "room:felix001", name: "Felix", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const pane = { id: "pane:andy0001", roomId: room.id, paneName: "Andy", title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const receipt = JSON.stringify({ status: "UNKNOWN", results: [{ index: 0, paneId: pane.id, status: "UNKNOWN", detail: "CLI readiness has not been confirmed." }] });

const reopen = (states: string[]) => {
  const inspectPane = vi.fn(async () => ({ text: "", state: states.shift() ?? "UNKNOWN", sessionId: "session:1", tasks: [] }));
  return createNousTools({
    world: async () => "world", rooms: async () => [room], listPanes: async () => [pane],
    roomTool: vi.fn(async () => ({ ok: false, display: "not confirmed", result: receipt })), inspectPane, wait: async () => undefined,
    allowances: async () => ({ promote: false, warm: false }), notifications: { list: async () => [], resolve: async () => true }, paneNotices: {}
  } as unknown as NousToolDeps).execute("space_execute", { room: "Felix", actions: [{ kind: "pane", operation: "reopen", target: { paneIds: [pane.id] }, when: "NOW" }] }, ctx);
};

describe("Nous errors 24/11: reopen readiness", () => {
  it("answers a reopened CLI at its prompt as done, one that exited as failed, and one still loading as starting", async () => {
    expect(await reopen(["UNKNOWN", "IDLE"])).toMatchObject({ ok: true, result: expect.stringMatching(/^Andy: the CLI is at its prompt after the reopen\./) });
    expect(await reopen(["EXITED"])).toMatchObject({ ok: false, result: expect.stringMatching(/^FAILED Andy: its CLI is EXITED after the reopen\./) });
    const late = await reopen([]);
    expect(late).toMatchObject({ ok: true, result: expect.stringMatching(/^STARTING Andy: reopened/) });
    expect(late.result).not.toContain("NOT CONFIRMED");
  });

  it("reads the counted samples as the holds they are now", () => {
    expect(historicalToolHold("space_execute", "NOT CONFIRMED reopen pane:ytcyv03WEvR9: CLI readiness has not been confirmed. "
      + "(it may have run: read the pane with space_read_pane before repeating it)\n{\"status\":\"UNKNOWN\"}")).toBe(true);
    expect(historicalToolHold("space_execute", "NOT CONFIRMED reopen pane:ytcyv03WEvR9: Pane is closed.")).toBe(false);
  });
});
