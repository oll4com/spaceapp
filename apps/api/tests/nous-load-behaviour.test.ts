import { describe, expect, it, vi } from "vitest";
import { InMemoryControlRepository } from "@space/db";
import type { Pane } from "@space/contracts";
import { createHeldDispatch, type NousLoadLevel } from "../src/nous/held-dispatch.js";
import { renderServerLoad, type NousLoadState } from "../src/nous/server-load.js";
import { NOUS_PERSONA } from "../src/nous/service.js";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

/** Plan clipboard:VZEewZRaodZR R4: Nous sends new work with when "calm" while the server is busy; answers, stops and closes go at once. */

const ctx = { owner: "user:operator", turnId: "nous_turn:t1", callId: "toolu_1", traceId: "trace:1" };
const andy = { id: "pane:andy0001", roomId: "room:dino0001", paneName: "Andy", title: "Andy", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const busy: NousLoadState = { level: "BUSY", reasons: ["CPU 80%"], cpuPercent: 80, load1: 15, load5: 14, cores: 20, memAvailableBytes: 17 * 1024 ** 3,
  memTotalBytes: 40 * 1024 ** 3, swapPercent: 37, samples: 30, topCpu: [], topMemory: [], sampledAt: "2026-10-17T13:30:00.000Z" };

describe("Nous under load", () => {
  it("is told, in its persona and on the world's server line, to send new work with when \"calm\" and to answer, stop and close at once", () => {
    expect(NOUS_PERSONA).toMatch(/While it is BUSY or OVERLOADED, open no new panes and send new work \(plan steps, next tasks\) with when "calm"/);
    expect(NOUS_PERSONA).toContain("Answers to a waiting prompt, stops and closes go at once");
    for (const level of ["BUSY", "OVERLOADED"] as const) {
      expect(renderServerLoad({ ...busy, level }), level).toMatch(/with when "calm".*answers, stops and closes go at once\./);
    }
    expect(renderServerLoad({ ...busy, level: "CALM", reasons: [] })).not.toContain("calm\"");
  });

  it("holds new work while BUSY and delivers it once CALM, while an answer, a stop and a close go at once", async () => {
    const state = { level: "BUSY" as NousLoadLevel };
    const roomTool = vi.fn(async (name: string, _args?: Record<string, unknown>) => ({ ok: true, display: `ran ${name}`, result: `ran ${name}` }));
    const notices: string[] = [];
    const held = createHeldDispatch({ repository: new InMemoryControlRepository(), level: async () => state.level,
      deliver: (item) => roomTool("send_to_pane", { panes: [item.paneId], text: item.text, when: "after_turn" }),
      notice: async (_owner, _key, line) => { notices.push(line); } });
    const tools = createNousTools({
      rooms: async () => [{ id: "room:dino0001", name: "Dino" }], listPanes: async () => [andy], roomTool,
      inspectPane: async () => ({ text: "Edit apps/web/src/App.tsx?\n❯ 1. Yes  2. No", state: "WAITING_FOR_INPUT", sessionId: "cli_session:a", promptFingerprint: "fp", tasks: [] }),
      allowances: async () => ({ promote: false, warm: false }), held: { level: async () => state.level, hold: held.hold }
    } as unknown as NousToolDeps);

    const sent = await tools.execute("space_send_to_pane", { room: "Dino", panes: ["Andy"], text: "Implement step 3 of the plan.", when: "calm" }, ctx);
    expect(sent).toMatchObject({ ok: true, display: "Held for a calm server: Andy" });
    await tools.execute("space_answer_pane", { room: "Dino", pane: "Andy", answer: "1" }, ctx);
    await tools.execute("space_stop_pane", { room: "Dino", pane: "Andy" }, ctx);
    await tools.execute("space_close_pane", { room: "Dino", panes: ["Andy"] }, ctx);
    expect(roomTool.mock.calls.map(([name]) => name)).toEqual(["answer_pane_prompt", "stop_pane", "close_pane"]);

    await held.tick();
    expect(roomTool).toHaveBeenCalledTimes(3);
    state.level = "CALM";
    await held.tick();
    expect(roomTool).toHaveBeenLastCalledWith("send_to_pane", { panes: ["pane:andy0001"], text: "Implement step 3 of the plan.", when: "after_turn" });
    expect(notices).toEqual(["The server is CALM: delivered 1 held text to Dino/Andy."]);
  });
});
