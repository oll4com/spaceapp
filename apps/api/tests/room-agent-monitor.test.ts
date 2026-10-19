import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { InMemoryRoomAgentMonitorRepository } from "@space/db";
import { SpaceNotFoundError } from "@space/runtime";
import type { DashboardActivityDetail } from "../src/agents-dashboard.js";
import {
  createRoomAgentMonitor, ROOM_MONITOR_ACTIVE_MS, ROOM_MONITOR_EMPTY_MS, ROOM_MONITOR_OVERLAP_MS, ROOM_MONITOR_QUIET_MS, roomMonitorEventText, roomMonitorTransition
} from "../src/room-agent-monitor.js";

const at = "2026-10-13T05:00:00.000Z";
const room = (id: string, extra: Partial<Room> = {}) => ({ id, name: id, kind: "WORKSPACE", archivedAt: null, ...extra }) as Room;
const pane = (id: string, name: string, extra: Partial<Pane> = {}) => ({
  id, roomId: "room:monitor1", title: `${name} pane`, titleSource: "auto", paneName: name, mode: "TERMINAL", status: "IDLE", providerId: null,
  modelId: null, terminalRuntimeId: "cli:codex", reasoningEffort: "medium", cwd: null, order: 0, columnSpan: 1, isMaximized: false,
  isMinimized: false, isClosed: false, split: "NONE", categoryColor: null, vncTarget: null, createdAt: at, updatedAt: at,
  taskMetadata: { taskKey: "k", version: 1, description: "", steps: [], earlierWork: "", source: "ai", generationStatus: "ready",
    nativeSyncStatus: "synced", providerId: null, modelId: null, updatedAt: at,
    topics: [{ title: `${name} task`, summary: `${name} summary`, source: "ai", at }] },
  ...extra
}) as Pane;

function setup() {
  let now = 1_000_000;
  const repository = new InMemoryRoomAgentMonitorRepository();
  const panes = [pane("pane:bob-term", "Bob"), pane("pane:dana-term", "Dana"), pane("pane:andy-brow", "Andy", { mode: "BROWSER", terminalRuntimeId: null })];
  let details: Record<string, DashboardActivityDetail> = {};
  const readActivity = vi.fn(async () => ({ data: panes, details }));
  const onEvent = vi.fn();
  const onActivity = vi.fn();
  const rooms = [room("room:monitor1")];
  const monitor = createRoomAgentMonitor({ repository, listRooms: async () => rooms, readActivity, onEvent, onActivity, now: () => now });
  return {
    repository, monitor, readActivity, onEvent, onActivity, rooms,
    set(next: Record<string, DashboardActivityDetail>) { details = next; },
    advance(ms: number) { now += ms; }
  };
}

describe("room agent monitor", () => {
  it("maps activity changes to feed events", () => {
    expect(roomMonitorTransition(undefined, { activity: "DONE", reason: null })).toBeNull();
    expect(roomMonitorTransition(undefined, { activity: "WAITING", reason: "Permission prompt" })).toEqual({ kind: "WAITING", severity: "ATTENTION" });
    expect(roomMonitorTransition({ activity: "WORKING", reason: null }, { activity: "DONE", reason: null })).toEqual({ kind: "FINISHED", severity: "INFO" });
    expect(roomMonitorTransition({ activity: "WORKING", reason: null }, { activity: "IDLE", reason: "Not running" })).toEqual({ kind: "ERROR", severity: "ATTENTION" });
    expect(roomMonitorTransition({ activity: "WORKING", reason: null }, { activity: "WAITING", reason: "Usage limit" })).toEqual({ kind: "USAGE_LIMIT", severity: "ATTENTION" });
    expect(roomMonitorTransition({ activity: "IDLE", reason: null }, { activity: "WAITING", reason: "Sign-in required" })).toEqual({ kind: "SIGN_IN", severity: "ATTENTION" });
    expect(roomMonitorTransition({ activity: "WORKING", reason: null }, { activity: "WAITING", reason: "API error" })).toEqual({ kind: "STUCK", severity: "ATTENTION" });
    expect(roomMonitorEventText("STUCK", "Cody", "API error", { title: null, summary: null }).title).toBe("Cody stopped on an API error");
    expect(roomMonitorTransition({ activity: "WAITING", reason: "Permission prompt" }, { activity: "WAITING", reason: "Permission prompt" })).toBeNull();
    expect(roomMonitorTransition({ activity: "IDLE", reason: null }, { activity: "WORKING", reason: null })).toBeNull();
  });

  it("records finished and waiting panes once, resolves a question answered in the pane and persists activity", async () => {
    const c = setup();
    c.set({ "pane:bob-term": { status: "working", source: "native" }, "pane:dana-term": { status: "idle", source: "native" } });
    await c.monitor.tick();
    expect(await c.repository.listEvents("room:monitor1")).toEqual([]);

    c.advance(ROOM_MONITOR_ACTIVE_MS);
    c.set({ "pane:bob-term": { status: "done", since: at, source: "screen" }, "pane:dana-term": { status: "waiting", reason: "Permission prompt", source: "native" } });
    await c.monitor.tick();
    let events = await c.repository.listEvents("room:monitor1");
    expect(events.map((event) => [event.paneName, event.kind, event.status, event.title])).toEqual(expect.arrayContaining([
      ["Bob", "FINISHED", "OPEN", "Bob finished"],
      ["Dana", "WAITING", "OPEN", "Dana is waiting: Permission prompt"]
    ]));
    expect(events.find((event) => event.paneName === "Bob")?.detail).toBe("Bob task — Bob summary");
    expect(c.onEvent).toHaveBeenCalledTimes(2);
    expect(await c.repository.pendingCounts(["room:monitor1"])).toEqual({ "room:monitor1": 1 });

    // Unchanged state: no new events.
    c.advance(ROOM_MONITOR_ACTIVE_MS);
    await c.monitor.tick();
    expect(await c.repository.listEvents("room:monitor1")).toHaveLength(2);

    // Dana was answered in the pane.
    c.advance(ROOM_MONITOR_ACTIVE_MS);
    c.set({ "pane:bob-term": { status: "done", since: at, source: "screen" }, "pane:dana-term": { status: "working", source: "native" } });
    await c.monitor.tick();
    events = await c.repository.listEvents("room:monitor1");
    expect(events.find((event) => event.kind === "WAITING")?.status).toBe("RESOLVED");
    expect(await c.repository.pendingCounts(["room:monitor1"])).toEqual({});
    expect((await c.repository.paneActivity("room:monitor1")).map((record) => [record.paneId, record.activity]).sort()).toEqual([
      ["pane:bob-term", "DONE"], ["pane:dana-term", "WORKING"]
    ]);
  });

  it("resolves a stopped pane once it runs again, so Live does not announce it again", async () => {
    const c = setup();
    c.set({ "pane:bob-term": { status: "working", source: "native" } });
    await c.monitor.tick();
    c.advance(ROOM_MONITOR_ACTIVE_MS);
    c.set({ "pane:bob-term": { status: "idle", reason: "Not running", source: "session" } });
    await c.monitor.tick();
    expect(await c.repository.latestPending(["room:monitor1"], 10)).toEqual([expect.objectContaining({ kind: "ERROR", title: "Bob stopped" })]);
    c.advance(ROOM_MONITOR_QUIET_MS);
    c.set({ "pane:bob-term": { status: "working", source: "native" } });
    await c.monitor.tick();
    expect(await c.repository.latestPending(["room:monitor1"], 10)).toEqual([]);
    expect((await c.repository.listEvents("room:monitor1")).find((event) => event.kind === "ERROR")?.status).toBe("RESOLVED");
  });

  it("does not repeat events after a restart and keeps the last state of an unreadable pane", async () => {
    const c = setup();
    c.set({ "pane:bob-term": { status: "working", source: "native" } });
    await c.monitor.tick();
    const restarted = createRoomAgentMonitor({ repository: c.repository, listRooms: async () => c.rooms,
      readActivity: async () => ({ data: (await c.readActivity()).data, details: {} }), now: () => 2_000_000 });
    await restarted.tick();
    expect(await c.repository.paneActivity("room:monitor1")).toEqual([expect.objectContaining({ paneId: "pane:bob-term", activity: "WORKING" })]);
    const again = createRoomAgentMonitor({ repository: c.repository, listRooms: async () => c.rooms,
      readActivity: async () => ({ data: (await c.readActivity()).data, details: { "pane:bob-term": { status: "working", source: "native" } } }), now: () => 3_000_000 });
    await again.tick();
    expect(await c.repository.listEvents("room:monitor1")).toEqual([]);
  });

  it("reads busy rooms often, quiet rooms less often and skips switched-off, archived and recovery rooms", async () => {
    const c = setup();
    c.set({ "pane:bob-term": { status: "working", source: "native" } });
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenCalledTimes(1);
    c.advance(ROOM_MONITOR_ACTIVE_MS - 1);
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenCalledTimes(1);
    c.advance(1);
    c.set({ "pane:bob-term": { status: "idle", source: "native" } });
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenCalledTimes(2);
    c.advance(ROOM_MONITOR_ACTIVE_MS);
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenCalledTimes(2);
    c.advance(ROOM_MONITOR_QUIET_MS);
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenCalledTimes(3);
    expect(ROOM_MONITOR_EMPTY_MS).toBeGreaterThan(ROOM_MONITOR_QUIET_MS);

    await c.repository.setMonitorEnabled("room:monitor1", false);
    c.rooms.push(room("room:archived", { archivedAt: at }), room("room:recovery", { kind: "CLI_RECOVERY" }));
    c.advance(ROOM_MONITOR_EMPTY_MS);
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenCalledTimes(3);
  });

  it("drops a room deleted while it is read without a warning and still warns on real failures", async () => {
    const warn = vi.fn();
    let rooms = [room("room:gone")];
    const readActivity = vi.fn(async (): Promise<{ data: Pane[]; details: Record<string, DashboardActivityDetail> }> => {
      throw new SpaceNotFoundError("Room room:gone was not found.");
    });
    const monitor = createRoomAgentMonitor({ repository: new InMemoryRoomAgentMonitorRepository(), listRooms: async () => rooms,
      readActivity, now: () => 1_000_000, log: { warn } });
    await monitor.tick();
    expect(warn).not.toHaveBeenCalled();
    rooms = [];
    await monitor.tick();
    // Its schedule went with it: listed again, the room is read at once instead of after the quiet delay.
    rooms = [room("room:gone")];
    readActivity.mockRejectedValueOnce(new Error("database down"));
    await monitor.tick();
    expect(readActivity).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("records one event per overlap, reads overlaps at most once a minute and resolves an overlap that is gone", async () => {
    let now = 1_000_000;
    const repository = new InMemoryRoomAgentMonitorRepository();
    let overlaps = [{ title: "Bob and Dana change the same files", detail: "Shared files: a.ts." }];
    const readOverlaps = vi.fn(async () => overlaps);
    const onAttention = vi.fn();
    const monitor = createRoomAgentMonitor({ repository, listRooms: async () => [room("room:monitor1")], readOverlaps, onAttention, now: () => now,
      readActivity: async () => ({ data: [pane("pane:bob-term", "Bob"), pane("pane:dana-term", "Dana")], details: { "pane:bob-term": { status: "working", source: "native" } } }) });
    await monitor.tick();
    now += ROOM_MONITOR_ACTIVE_MS;
    await monitor.tick();
    expect(readOverlaps).toHaveBeenCalledTimes(1);
    const [event] = await repository.listEvents("room:monitor1");
    expect(event).toMatchObject({ kind: "OVERLAP", severity: "ATTENTION", paneId: null, status: "OPEN", title: "Bob and Dana change the same files" });
    expect(onAttention).toHaveBeenCalledOnce();

    await repository.updateEvent(event!.eventId, { status: "HANDLED" });
    now += ROOM_MONITOR_OVERLAP_MS;
    await monitor.tick();
    expect(readOverlaps).toHaveBeenCalledTimes(2);
    expect(await repository.listEvents("room:monitor1")).toHaveLength(1);

    overlaps = [];
    now += ROOM_MONITOR_OVERLAP_MS;
    await monitor.tick();
    expect(await repository.getEvent(event!.eventId)).toMatchObject({ status: "RESOLVED", decision: "The overlap is gone." });
  });
});
