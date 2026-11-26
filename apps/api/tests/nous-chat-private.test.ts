// Operator 22/11: Chat panes and Nous share no data, so Nous never reads, sends to or answers a Chat pane.
import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const owner = "user:operator";
const ctx = { owner, turnId: "turn:1", callId: "call:1", traceId: "trace:1" };
const alpha = { id: "room:alpha", name: "Alpha", kind: "WORKSPACE", ownerUserId: owner } as Room;
const chat = { id: "pane:chat", roomId: alpha.id, title: "Andy", paneName: "Andy", mode: "CHAT", isClosed: false } as unknown as Pane;

describe("Nous and Chat panes", () => {
  it("refuses to read, send to or answer a Chat pane, and never reaches it", async () => {
    const roomTool = vi.fn(async () => ({ ok: true, display: "Read", result: "chat text" }));
    const nous = createNousTools({ rooms: async () => [alpha], listPanes: async () => [chat], roomTool } as unknown as NousToolDeps);
    for (const [tool, args] of [["space_read_pane", { room: "Alpha", pane: "Andy" }], ["space_send_to_pane", { room: "Alpha", panes: ["Andy"], text: "hello there" }],
      ["space_answer_pane", { room: "Alpha", pane: "Andy", answer: "yes" }]] as const) {
      expect(await nous.execute(tool, args, ctx)).toMatchObject({ ok: false, result: expect.stringContaining("private from Nous") });
    }
    expect(roomTool).not.toHaveBeenCalled();
  });

  it("DEV3D-025: Space Control neither reads nor prompts a Chat pane for Nous", async () => {
    const roomTool = vi.fn(async () => ({ ok: true, display: "Read", result: "chat text" }));
    const cli = { ...chat, id: "pane:cli", title: "Bob", paneName: "Bob", mode: "TERMINAL", terminalRuntimeId: "cli:claude" } as unknown as Pane;
    const nous = createNousTools({ rooms: async () => [alpha], listPanes: async () => [chat, cli], roomTool, allowances: async () => ({}) } as unknown as NousToolDeps);
    const refused = { ok: false, result: expect.stringContaining("private from Nous") };
    expect(await nous.execute("space_inspect", { room: "Alpha", arguments: { section: "CONTENT", paneId: chat.id } }, ctx)).toMatchObject(refused);
    expect(await nous.execute("space_inspect", { room: "Alpha", arguments: { section: "CONTENT" } }, ctx)).toMatchObject(refused);
    // DEV3D-053: MODELS carries a Chat pane's latest operator message as tasks[0].title.
    expect(await nous.execute("space_inspect", { room: "Alpha", arguments: { section: "MODELS", paneId: chat.id } }, ctx)).toMatchObject(refused);
    expect(await nous.execute("space_inspect", { room: "Alpha", arguments: { section: "MODELS" } }, ctx)).toMatchObject(refused);
    for (const target of [{ paneIds: [chat.id] }, { paneIds: ["chat"] }, { paneNames: ["Andy"] }, { state: "OPEN" }]) {
      expect(await nous.execute("space_execute", { room: "Alpha", actions: [{ kind: "pane", operation: "prompt", text: "hi", target }] }, ctx)).toMatchObject(refused);
    }
    expect(roomTool).not.toHaveBeenCalled();
    // A CLI pane's content still reads.
    expect(await nous.execute("space_inspect", { room: "Alpha", arguments: { section: "CONTENT", paneId: cli.id } }, ctx)).toMatchObject({ ok: true });
  });
});
