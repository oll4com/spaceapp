import { describe, expect, it, vi } from "vitest";
import { buildLiveRoomContext } from "../src/live-room-context.js";
import type { Pane, Room } from "@space/contracts";
const room = { id: "room:context", name: "Build", description: "Release tools" } as Room;
const pane = { id: "pane:one", title: "Assistant", mode: "TERMINAL", status: "IDLE", modelId: "configured", reasoningEffort: "high", terminalRuntimeId: "cli:codex", isClosed: false } as Pane;
describe("authenticated Live room context projection", () => {
  it("separates configured models from verified observations and revisions actual facts", async () => {
    const read = (effectiveModelId?: string) => buildLiveRoomContext({ room, panes: [pane], objective: "Publish", inspect: async () => ({ state: "BUSY", ...(effectiveModelId ? { effectiveModelId, modelVerificationStatus: "VERIFIED" } : {}), tasks: [{ taskId: "task:actual", title: "Work", status: "RUNNING" }] }) });
    const a = await read(), b = await read(), c = await read("observed");
    expect(a.panes[0]).toMatchObject({ configuredModelId: "configured", effectiveModelId: null, modelVerification: "UNKNOWN", task: { id: "task:actual", status: "RUNNING" } });
    expect(a.revision).toBe(b.revision); expect(c.revision).not.toBe(a.revision);
    expect(c.panes[0]?.effectiveModelId).toBe("observed");
  });
  it("bounds inspections and does not turn timeout into successful task evidence", async () => {
    vi.useFakeTimers();
    try {
      const inspect = vi.fn(() => new Promise<never>(() => {}));
      const pending = buildLiveRoomContext({ room, panes: Array.from({ length: 30 }, (_, i) => ({ ...pane, status: "RUNNING", id: `pane:${i}`, isClosed: i === 0 })), inspect });
      await vi.advanceTimersByTimeAsync(2001); const result = await pending;
      expect(inspect).toHaveBeenCalledTimes(16); expect(result.panes).toHaveLength(16);
      expect(result.panes[0]).toMatchObject({ status: "UNKNOWN", activity: "UNKNOWN", task: null, effectiveModelId: null });
      expect(result.activitySummary).toMatchObject({ running: 0, unknown: 16 });
    } finally { vi.useRealTimers(); }
  });
  it("reports a pane as working when the Agents Dashboard does, though its last task completed (sub-agents)", async () => {
    // Live told the operator that Dana was idle while she ran six sub-agents (2026-10-15).
    const inspect = async () => ({ state: "RUNNING", tasks: [{ taskId: "main", title: "Plan", status: "COMPLETED", timing: { source: "NATIVE" } }] });
    const panes = [pane, { ...pane, id: "pane:two" }, { ...pane, id: "pane:three" }];
    const context = await buildLiveRoomContext({ room, panes, inspect, dashboard: { "pane:one": "working", "pane:two": "waiting" } });
    expect(context.panes.map(p => p.activity)).toEqual(["RUNNING", "WAITING_FOR_INPUT", "IDLE"]);
    expect(context.activitySummary).toMatchObject({ running: 1, waitingForInput: 1, idle: 1 });
  });
  it("counts native running work separately from live sessions, idle agents and browser panes", async () => {
    const fixtures = [
      { state: "RUNNING", tasks: [{ taskId: "active", title: "Work", status: "RUNNING", timing: { source: "NATIVE" } }] },
      { state: "IDLE", tasks: [{ taskId: "done", title: "Done", status: "COMPLETED", timing: { source: "NATIVE" } }] },
      { state: "RUNNING", tasks: [] },
      { state: "RUNNING", tasks: [{ taskId: "guess", title: "Not native", status: "RUNNING", timing: { source: "OBSERVED" } }] },
      { state: "WAITING_FOR_INPUT", tasks: [] },
      { state: "EXITED", tasks: [] },
      { state: "RUNNING", tasks: [] }
    ];
    const result = await buildLiveRoomContext({ room, panes: fixtures.map((_, index) => ({ ...pane, id: String(index), mode: index === 6 ? "BROWSER" : "TERMINAL", status: "RUNNING" })),
      inspect: async pane => fixtures[Number(pane.id)]! });
    expect(result.activitySummary).toEqual({ totalAgentPanes: 6, running: 1, idle: 1, waitingForInput: 1, stopped: 1, unknown: 2 });
  });
});
