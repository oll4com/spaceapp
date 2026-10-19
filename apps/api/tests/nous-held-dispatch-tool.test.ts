import { describe, expect, it, vi } from "vitest";
import { InMemoryControlRepository } from "@space/db";
import type { Pane } from "@space/contracts";
import { createHeldDispatch, type NousLoadLevel } from "../src/nous/held-dispatch.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const ctx = { owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const andy = { id: "pane:andy0001", roomId: "room:dino0001", paneName: "Andy", title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;

function fixture(level: NousLoadLevel) {
  const state = { level };
  const roomTool = vi.fn(async (name: string) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
  const dispatch = createHeldDispatch({ repository: new InMemoryControlRepository(), level: async () => state.level,
    deliver: async () => ({ ok: true, result: "sent" }), notice: async () => {} });
  const tools = createNousTools({
    rooms: async () => [{ id: "room:dino0001", name: "Dino" }], listPanes: async () => [andy], roomTool,
    allowances: async () => ({ promote: false, warm: false }), held: { level: async () => state.level, hold: dispatch.hold }
  } as unknown as NousToolDeps);
  return { tools, roomTool, dispatch, state };
}

describe("when \"calm\" in Nous's tools", () => {
  it("holds a send while the server is busy and sends it after the pane's turn once calm", async () => {
    const f = fixture("BUSY");
    expect(await f.tools.execute("space_send_to_pane", { room: "Dino", panes: ["Andy"], text: "Run step 3.", when: "calm" }, ctx))
      .toMatchObject({ ok: true, display: "Held for a calm server: Andy", result: expect.stringContaining("The server is BUSY: held for Andy (1 waiting)") });
    expect(f.roomTool).not.toHaveBeenCalled();
    expect(await f.dispatch.summary(ctx.owner)).toContain("Dino/Andy 1");
    f.state.level = "CALM";
    await f.tools.execute("space_send_to_pane", { room: "Dino", panes: ["Andy"], text: "Run step 4.", when: "calm" }, ctx);
    expect(f.roomTool).toHaveBeenCalledWith("send_to_pane", { panes: ["pane:andy0001"], text: "Run step 4.", when: "after_turn" }, expect.anything());
  });

  it("sends urgent work at once and still keeps critical text for the operator", async () => {
    const f = fixture("OVERLOADED");
    await f.tools.execute("space_send_to_pane", { room: "Dino", panes: ["Andy"], text: "Stop the build.", when: "calm", priority: "urgent" }, ctx);
    expect(f.roomTool).toHaveBeenCalledTimes(1);
    expect((await f.tools.execute("space_send_to_pane", { room: "Dino", panes: ["Andy"], text: "Run space-queue promote now", when: "calm" }, ctx)).ok).toBe(false);
    expect(await f.dispatch.summary(ctx.owner)).toBeNull();
  });

  it("holds space_execute's calm prompts and runs the rest of the batch", async () => {
    const f = fixture("OVERLOADED");
    const layout = { kind: "layout", operation: "sort" };
    const outcome = await f.tools.execute("space_execute", { room: "Dino", actions: [layout,
      { kind: "pane", operation: "prompt", target: { paneIds: ["pane:andy0001"] }, text: "Step 5.", when: "calm" }] }, ctx);
    expect(f.roomTool).toHaveBeenCalledWith("space_control", { tool: "space_execute", arguments: { actions: [expect.objectContaining(layout)] } }, expect.anything());
    expect(outcome.result).toContain("The server is OVERLOADED: held for Andy (1 waiting)");
  });
});
