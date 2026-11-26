import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** 14/11 slice 24 (Daily Nous errors): 7 native_command "/resume …" failed "Native state is unknown." 20 s after panes.open opened the pane. */

const owner = "user:operator";
const room = { id: "room:cleo0001", name: "Cleo", kind: "WORKSPACE", ownerUserId: owner, archivedAt: null } as unknown as Room;
const bob = { id: "pane:bob00001", roomId: room.id, paneName: "Bob", title: "Bob", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const ctx = { owner, turnId: "nous_turn:s24", callId: "toolu_1", traceId: "trace:1", turn: { reason: "STANDING", operatorMessage: null, replyTo: [] } } as never;
const resume = (actions: object[] = []) => ({ room: "Cleo", actions: [...actions, { kind: "native_command", command: "/resume 1234", target: { paneIds: [bob.id] } }] });
const ready = { text: "", state: "IDLE", sessionId: "session:1", tasks: [] };
const starting = { text: "", state: "UNKNOWN", sessionId: null, tasks: [] };

const setup = (pane: Pane, inspect: () => Promise<unknown>) => {
  const roomTool = vi.fn(async () => ({ ok: true, display: "ran", result: "ran" }));
  const wait = vi.fn(async () => undefined);
  const tools = createNousTools({ rooms: async () => [room], listPanes: async () => [pane], roomTool, inspectPane: vi.fn(inspect), wait,
    quotaWaits: async () => [], allowances: async () => ({ promote: false, warm: false }) } as unknown as NousToolDeps);
  return { roomTool, wait, run: (args: object) => tools.execute("space_execute", args, ctx) as Promise<{ ok: boolean; refused?: boolean; result: string }> };
};

describe("space_execute native_command", () => {
  it("waits for a CLI that is still starting, then sends", async () => {
    let looks = 0;
    const { roomTool, wait, run } = setup(bob, async () => (++looks < 3 ? starting : ready));
    expect(await run(resume())).toMatchObject({ ok: true });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(roomTool).toHaveBeenCalledTimes(1);
  });

  it("holds a closed pane (the dispatcher), an exited CLI and one still not started after 30 s, sending nothing", async () => {
    for (const [pane, seen, said] of [[{ ...bob, isClosed: true } as Pane, ready, "is closed"], [bob, { ...starting, state: "EXITED" }, "not running"],
      [bob, starting, "no CLI session after 30 s"]] as const) {
      const { roomTool, run } = setup(pane, async () => seen);
      const held = await run(resume());
      expect(held).toMatchObject({ ok: false, refused: true });
      expect(held.result).toContain(said);
      expect(roomTool).not.toHaveBeenCalled();
    }
  });

  it("leaves a pane the same batch starts to Space Control", async () => {
    const { roomTool, run } = setup(bob, async () => ({ ...starting, state: "EXITED" }));
    expect(await run(resume([{ kind: "pane", operation: "start", target: { paneIds: [bob.id] } }]))).toMatchObject({ ok: true });
    expect(roomTool).toHaveBeenCalledTimes(1);
  });
});
