import { describe, expect, it, vi } from "vitest";
import type { Pane, Room } from "@space/contracts";
import { InMemoryRoomAgentMonitorRepository } from "@space/db";
import { SpaceNotFoundError } from "@space/runtime";
import type { DashboardActivityDetail } from "../src/agents-dashboard.js";
import {
  createRoomAgentMonitor, notePanePrompted, notePaneReached, notePaneSent, OVERLAP_COORDINATED, ROOM_MONITOR_ACTIVE_MS, ROOM_MONITOR_PROMPTED_MS, ROOM_MONITOR_EMPTY_MS, ROOM_MONITOR_OVERLAP_MS, ROOM_MONITOR_OVERLAP_REPEAT_MS, ROOM_MONITOR_QUIET_MS, roomMonitorEventText, roomMonitorTransition
} from "../src/room-agent-monitor.js";
import { waitCloser } from "../src/nous/progress.js";
import { roomMonitorEventText, roomMonitorTransition } from "../src/room-agent-monitor.js";

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
    advance(ms: number) { now += ms; },
    now: () => now
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
    // A CLI's question for the operator is its own kind (operator decision 2026-10-24): it reaches them while Nous works.
    expect(roomMonitorTransition({ activity: "WORKING", reason: null }, { activity: "WAITING", reason: "Question for you" })).toEqual({ kind: "QUESTION", severity: "ATTENTION" });
    expect(roomMonitorEventText("STUCK", "Cody", "API error", { title: null, summary: null }).title).toBe("Cody stopped on an API error");
    expect(roomMonitorEventText("QUESTION", "Cody", "Question for you", { title: null, summary: null }).title).toBe("Cody has a question for you");
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

  it("records HANDLED when a text Space typed for Nous reached the pane during the wait or up to 30 s before it (item 29a)", async () => {
    const c = setup();
    try {
      c.set({ "pane:bob-term": { status: "working", source: "native" }, "pane:dana-term": { status: "working", source: "native" } });
      await c.monitor.tick();
      // Bob got Nous's answer 10 s before his wait showed; Dana's last text is a minute older than hers.
      notePaneReached("pane:bob-term", Date.now() - 10_000);
      notePaneReached("pane:dana-term", Date.now() - 60_000);
      c.advance(ROOM_MONITOR_ACTIVE_MS);
      c.set({ "pane:bob-term": { status: "waiting", reason: "Permission prompt", source: "native" }, "pane:dana-term": { status: "waiting", reason: "Permission prompt", source: "native" } });
      await c.monitor.tick();
      c.advance(ROOM_MONITOR_ACTIVE_MS);
      c.set({ "pane:bob-term": { status: "working", source: "native" }, "pane:dana-term": { status: "working", source: "native" } });
      await c.monitor.tick();
      const waits = (await c.repository.listEvents("room:monitor1")).filter((event) => event.kind === "WAITING");
      expect(Object.fromEntries(waits.map((event) => [event.paneName, event.status]))).toEqual({ Bob: "HANDLED", Dana: "RESOLVED" });
      expect(waits.find((event) => event.paneName === "Bob")?.decision).toMatch(/reached the pane/);
    } finally {
      notePaneReached("pane:bob-term", 0);
      notePaneReached("pane:dana-term", 0);
    }
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
    // W45 step 1: a handled overlap keeps who handled it and when; only an unanswered one resolves when it is gone.
    expect(await repository.getEvent(event!.eventId)).toMatchObject({ status: "HANDLED" });
    overlaps = [{ title: "Bob and Erin change the same files", detail: "Shared files: b.ts." }];
    now += ROOM_MONITOR_OVERLAP_MS;
    await monitor.tick();
    const second = (await repository.listEvents("room:monitor1")).find((entry) => entry.title === "Bob and Erin change the same files");
    overlaps = [];
    now += ROOM_MONITOR_OVERLAP_MS;
    await monitor.tick();
    expect(await repository.getEvent(second!.eventId)).toMatchObject({ status: "RESOLVED", decision: "The overlap is gone." });
  });

  it("records an overlap HANDLED once Nous's text goes to one of its panes, queued after its turn too (W45 step 1)", async () => {
    // 27/10-3/11: 97 OVERLAP notices, none answered by an agent, each open until the overlap went away (median 5.1 min).
    let now = 1_000_000;
    const repository = new InMemoryRoomAgentMonitorRepository();
    const overlaps = [{ title: "Ivy and Kim change the same files", detail: "Shared files: a.ts.", files: ["a.ts"], paneIds: ["pane:ivy-w45", "pane:kim-w45"] }];
    const onEvent = vi.fn();
    const monitor = createRoomAgentMonitor({ repository, listRooms: async () => [room("room:monitor-w45")], readOverlaps: async () => overlaps, onEvent, now: () => now,
      readActivity: async () => ({ data: [pane("pane:ivy-w45", "Ivy"), pane("pane:kim-w45", "Kim")], details: {} }) });
    notePaneSent("pane:kim-w45", Date.now() - 60_000);
    await monitor.tick();
    const [event] = await repository.listEvents("room:monitor-w45");
    // A text sent before the overlap was recorded is no coordination of it.
    now += ROOM_MONITOR_EMPTY_MS;
    await monitor.tick();
    expect(await repository.getEvent(event!.eventId)).toMatchObject({ status: "OPEN" });
    notePaneSent("pane:kim-w45");
    now += ROOM_MONITOR_EMPTY_MS;
    await monitor.tick();
    const handled = await repository.getEvent(event!.eventId);
    expect(handled).toMatchObject({ status: "HANDLED", decision: OVERLAP_COORDINATED });
    expect(waitCloser(handled!)).toEqual({ who: "a coordination text Space sent for Nous or the Room Agent", byAgent: true });
    expect(onEvent).toHaveBeenLastCalledWith(expect.objectContaining({ eventId: event!.eventId, status: "HANDLED" }));
  });

  it("records an overlap that comes back on the same files once an hour; a new file or a merge conflict at once (R10-6)", async () => {
    // 28/10: "Dana and Emma change the same files" was recorded 5 times in 2 hours (09:02-10:59 UTC), each gone a few minutes later.
    let now = 1_000_000;
    const repository = new InMemoryRoomAgentMonitorRepository();
    const pair = (files: string[]) => ({ title: "Dana and Emma change the same files", detail: `Shared files: ${files.join(", ")}.`, files });
    let overlaps: Array<{ title: string; detail: string; files?: string[] }> = [pair(["docs/quality/KNOWN_LIMITATIONS.md", "review-findings.json"])];
    const monitor = createRoomAgentMonitor({ repository, listRooms: async () => [room("room:monitor2")], readOverlaps: async () => overlaps, now: () => now,
      readActivity: async () => ({ data: [pane("pane:dana-term", "Dana"), pane("pane:emma-term", "Emma")], details: {} }) });
    const step = async (next: typeof overlaps) => { overlaps = next; now += ROOM_MONITOR_OVERLAP_MS; await monitor.tick(); };
    const recorded = async () => (await repository.listEvents("room:monitor2")).filter((event) => event.kind === "OVERLAP").length;
    await monitor.tick();
    expect(await recorded()).toBe(1);
    // Gone, then back on the same files 4 minutes later: not recorded again within the hour.
    await step([]);
    await step([pair(["review-findings.json"])]);
    now += 2 * ROOM_MONITOR_OVERLAP_MS;
    await step([]);
    await step([pair(["docs/quality/KNOWN_LIMITATIONS.md", "review-findings.json"])]);
    expect(await recorded()).toBe(1);
    // A new shared file is recorded at once, and so is a merge conflict.
    await step([pair(["docs/quality/KNOWN_LIMITATIONS.md", "review-findings.json", "apps/api/src/app.ts"])]);
    expect(await recorded()).toBe(2);
    await step([{ title: "Dana's queue ticket q-1 hit a merge conflict", detail: "Conflicting files: a.ts.", files: ["a.ts"] }]);
    await step([]);
    await step([{ title: "Dana's queue ticket q-1 hit a merge conflict", detail: "Conflicting files: a.ts.", files: ["a.ts"] }]);
    expect(await recorded()).toBe(4);
    // After the hour the same files are recorded again.
    await step([]);
    now += ROOM_MONITOR_OVERLAP_REPEAT_MS;
    await step([pair(["review-findings.json"])]);
    expect(await recorded()).toBe(5);
  });

  it("reads a room at once and on every tick after Space types a prompt, so a 4 s turn files FINISHED (c11 lab N4 5/11)", async () => {
    const c = setup();
    const idle: Record<string, DashboardActivityDetail> = { "pane:bob-term": { status: "idle", source: "screen" }, "pane:dana-term": { status: "idle", source: "native" } };
    // Bob works 1.5-5.5 s after the prompt, inside one quiet-room interval; one tick a second for 12 s.
    const turn = async () => {
      const start = c.now();
      for (let second = 1; second <= 12; second++) {
        c.advance(1_000);
        const elapsed = c.now() - start;
        c.set(elapsed >= 1_500 && elapsed < 5_500 ? { ...idle, "pane:bob-term": { status: "working", source: "screen" } } : idle);
        await c.monitor.tick();
      }
    };
    c.set(idle);
    await c.monitor.tick();
    await turn();
    expect(await c.repository.listEvents("room:monitor1")).toEqual([]);

    notePanePrompted("room:monitor1", c.now());
    await turn();
    expect((await c.repository.listEvents("room:monitor1")).map((event) => [event.paneName, event.kind])).toEqual([["Bob", "FINISHED"]]);
    expect(c.readActivity).toHaveBeenCalledWith("room:monitor1", true);

    // Past the window the room is read at its quiet pace again, through the shared cache.
    c.advance(ROOM_MONITOR_PROMPTED_MS);
    await c.monitor.tick();
    expect(c.readActivity).toHaveBeenLastCalledWith("room:monitor1", false);
    const reads = c.readActivity.mock.calls.length;
    c.advance(1_000);
    await c.monitor.tick();
    expect(c.readActivity.mock.calls.length).toBe(reads);
  });
});

describe("pace cap hold (operator 6/11, plan clipboard:DotwYXVD2N3n)", () => {
  it("files one line that the pane is held by the pace cap until the pace day, never a finish and never a call for help", () => {
    const held = { activity: "WAITING" as const, reason: "Pace cap until 21:00 UTC" };
    expect(roomMonitorTransition({ activity: "WORKING", reason: null }, held)).toEqual({ kind: "USAGE_LIMIT", severity: "INFO" });
    expect(roomMonitorTransition(held, held)).toBeNull();
    expect(roomMonitorEventText("USAGE_LIMIT", "Finn", held.reason, { title: null, summary: null }).title).toBe("Finn held by pace cap until 21:00 UTC");
    expect(roomMonitorEventText("USAGE_LIMIT", "Finn", "Usage limit", { title: null, summary: null }).title).toBe("Finn hit a usage limit");
  });
});
