// Operator 28/11 09:40 BKK (nous_msg:57f3908d69dd4398a16e20fe «διορθωσε τον κώδικα σου!!»): 11 finished panes Nous tried to close were all
// refused because their last report said waiting / needs a decision or Nous had marked them keep-open itself.
import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { createNousTools, type NousToolDeps } from "../src/nous/tools.js";

const room = { id: "room:dev", name: "Dev", ownerUserId: "user:operator" } as Room;
const pane = { id: "pane:hugo", roomId: room.id, title: "Hugo", paneName: "Hugo", mode: "TERMINAL", terminalRuntimeId: "cli:claude", isClosed: false } as unknown as Pane;
const ctx = { owner: "user:operator", turnId: "turn:1", callId: "call:1", traceId: "trace:1", toolCalls: 0 };
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const closeouts = (...entries: Array<ReturnType<typeof entry>>) => ({ roomCloseouts: async () => entries, saveRequested: async () => undefined, closed: async () => undefined }) as never;
const entry = (patch: Record<string, unknown> = {}) => ({ pane, state: "idle", since: ago(45), idleMinutes: 45, save: "save not asked", closable: false, skip: null, ...patch });

function tools(report: { status: string; at: string }, overrides: Partial<NousToolDeps> = {}) {
  const roomTool = vi.fn(async () => ({ ok: true, display: "done", result: "done" }));
  const deps: NousToolDeps = {
    rooms: async () => [room], listPanes: async () => [pane], allowances: async () => ({ promote: false, warm: false }),
    inspectPane: async () => ({ state: "IDLE", sessionId: "sess:1" } as never), roomTool: roomTool as never,
    paneLastWorkReport: async () => ({ ...report, summary: "Waiting for the operator's pick" } as never),
    paneLastReport: async () => ({ ...report, source: "AGENT", summary: "Waiting for the operator's pick", body: null }),
    closeouts: closeouts(entry()),
    ...overrides
  };
  return { run: createNousTools(deps), roomTool };
}
const save = (run: ReturnType<typeof createNousTools>) => run.execute("space_send_to_pane", { room: room.id, panes: ["Hugo"], text: "save to memory" }, ctx as never);
const close = (run: ReturnType<typeof createNousTools>) => run.execute("space_close_pane", { room: room.id, panes: ["Hugo"] }, ctx as never);

describe("a stale waiting / needs-decision / blocked pane is finished (operator 28/11 nous_msg:57f3908d)", () => {
  it.each(["WAITING", "NEEDS_DECISION", "BLOCKED"])("%s idle 10 min: save refused; 45 min with nothing open for the operator: save accepted", async (status) => {
    const fresh = tools({ status, at: ago(10) });
    expect((await save(fresh.run)).ok).toBe(false);
    expect(fresh.roomTool).not.toHaveBeenCalled();
    const stale = tools({ status, at: ago(45) });
    const res = await save(stale.run);
    expect(res.ok, res.result).toBe(true);
    expect(stale.roomTool).toHaveBeenCalled();
  });

  it("the close goes through after the verified save, and stays refused before it", async () => {
    const unsaved = tools({ status: "NEEDS_DECISION", at: ago(45) });
    const refused = await close(unsaved.run);
    expect(refused.ok).toBe(false);
    expect(refused.result).toMatch(/save not asked/);
    const saved = tools({ status: "NEEDS_DECISION", at: ago(45) }, { closeouts: closeouts(entry({ save: "save verified mem:1", closable: true })) });
    const res = await close(saved.run);
    expect(res.ok, res.result).toBe(true);
    expect(saved.roomTool).toHaveBeenCalledWith("close_pane", { panes: [pane.id] }, expect.anything());
  });

  it("Nous's own keep-open mark does not hold its later save, and its close passes once the save is verified", async () => {
    const marked = tools({ status: "DONE", at: ago(5) }, { closeouts: closeouts(entry({ skip: "keep-open" })) });
    expect((await save(marked.run)).ok).toBe(true);
    const saved = tools({ status: "DONE", at: ago(5) }, { closeouts: closeouts(entry({ skip: "keep-open", save: "save verified mem:1", closable: true })) });
    expect((await close(saved.run)).ok).toBe(true);
  });

  it("a real open operator question, card or browser handoff still keeps it open", async () => {
    const needsYou = tools({ status: "WAITING", at: ago(45) }, { paneNeeds: async () => [{ id: "n1", paneId: pane.id, title: "Pick a route" }] as never,
      closeouts: closeouts(entry({ save: "save verified mem:1", closable: true })) });
    expect((await close(needsYou.run)).result).toMatch(/needs-you requests wait/);
    for (const skip of ["awaits-operator", "waiting-operator", "browser-held"]) {
      const held = tools({ status: "WAITING", at: ago(45) }, { closeouts: closeouts(entry({ skip })) });
      expect((await save(held.run)).result, skip).toMatch(/kept open/);
      expect(held.roomTool).not.toHaveBeenCalled();
    }
  });
});
