import { describe, expect, it, vi } from "vitest";
import { parseRoomQuickCommand } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomQuickActions } from "../src/room-quick-actions.js";
import { createRoomAgentService } from "../src/room-agent.js";

it.each([
  ["άνοιξε 2 codex pane", { type: "OPEN_PANES", count: 2, mode: "TERMINAL", runtimeId: "cli:codex" }],
  ["θέλω να ανοίξεις δύο codex panes!", { type: "OPEN_PANES", count: 2, mode: "TERMINAL", runtimeId: "cli:codex" }],
  ["Open one browser pane", { type: "OPEN_PANES", count: 1, mode: "BROWSER" }],
  ["άνοιξε 2 qwen panes", { type: "OPEN_PANES", count: 2, mode: "TERMINAL", runtimeId: "cli:qwen" }],
  ["open one autohand cli pane", { type: "OPEN_PANES", count: 1, mode: "TERMINAL", runtimeId: "cli:autohand" }],
  ["ξεκίνησε μουσική!!!", { type: "MUSIC", action: "PLAY", target: "AUTO" }],
  ["επόμενο τραγούδι στο youtube", { type: "MUSIC", action: "NEXT", target: "YOUTUBE" }],
  ["κάνε αναζήτηση στο browser: Ελληνικά βιβλία", { type: "SEARCH", query: "Ελληνικά βιβλία", engine: "GOOGLE" }],
  ["open browser and search for Space APP", { type: "SEARCH", query: "Space APP", engine: "GOOGLE" }],
  ["search on youtube: jazz music", { type: "SEARCH", query: "jazz music", engine: "YOUTUBE" }]
])("routes the complete command %s without inference", (text, expected) => expect(parseRoomQuickCommand(text as string)).toEqual(expected));
it.each(["μην ανοίξεις 2 codex pane", "open 17 codex panes", "open 2 codex panes and fix the project", "Explain how to open 2 codex panes", "open root cli", "search", "open claude chat", "pause", "open 2 codex panes\nthen delete files"])("does not partially execute %s", text => expect(parseRoomQuickCommand(text)).toBeNull());
function fixture() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Quick commands", initialPaneCount: 0 });
  const enqueue = vi.fn();
  const navigate = vi.fn(async () => {});
  const execute = createRoomQuickActions({ store, assertRuntimeEnabled: async () => {}, navigate, publish: async () => {} });
  const start = vi.fn();
  const chat = { begin: vi.fn(() => ({ start, release: vi.fn() })), isRunning: () => false, activeTurn: () => null, abort: async () => false };
  const service = createRoomAgentService({ store, workflow: { enqueue, stop: async () => {} },
    missionStopper: { pauseMission: async () => {}, resumeMission: async () => {}, stopMission: async () => {} },
    roomPlanInventoryProvider: { inspect: async () => ({ totalPanes: store.listPanes(room.id).length, plannedPanes: 0,
      pendingPlans: 0, readyPlans: 0, pausedPlans: 0, runningPlans: 0, checkedAt: new Date().toISOString(), plans: [] }) }, executeQuickCommand: execute,
    chat: chat as never });
  return { store, room, enqueue, service, navigate, start };
}
describe("direct Room Agent execution", () => {
  it("creates an atomic batch once across concurrent sends and later retries, without a model workflow", async () => {
    const c = fixture();
    const results = await Promise.all([1,2].map(() => c.service.send(c.room.id, "open 2 codex panes", "quick:twice", "trace:quick")));
    expect(c.store.listPanes(c.room.id).filter(p=>!p.isClosed)).toHaveLength(2);
    expect(results.map(r=>r.directCommand?.status).sort()).toEqual(["COMPLETED", "REPLAYED"]);
    expect(c.enqueue).not.toHaveBeenCalled();
    const retry = await c.service.send(c.room.id, "open 2 codex panes", "quick:twice", "trace:retry");
    expect(retry.directCommand?.status).toBe("REPLAYED");
    expect(c.store.listRoomAgentMissions(c.room.id)).toHaveLength(0);
  });
  it("opens a browser for a search and reuses it for the next encoded query", async () => {
    const c = fixture();
    await c.service.send(c.room.id, "search on browser: Cats & Dogs", "search:first", "trace:search");
    await c.service.send(c.room.id, "search on youtube: jazz", "search:second", "trace:search");
    expect(c.store.listPanes(c.room.id).filter(p=>!p.isClosed)).toHaveLength(1);
    expect(c.navigate.mock.calls).toHaveLength(2);
    expect(c.navigate.mock.calls[0]?.[1]).toBe("https://www.google.com/search?q=Cats+%26+Dogs");
    expect(c.navigate.mock.calls[1]?.[1]).toBe("https://www.youtube.com/results?search_query=jazz");
    expect(c.enqueue).not.toHaveBeenCalled();
  });
  it("waits for the playback client, never redelivers next, and records a failed acknowledgement", async () => {
    const c = fixture();
    const first = await c.service.send(c.room.id, "next song on youtube", "music:next", "trace:music");
    expect(first.directCommand).toMatchObject({ status: "CLIENT_PENDING", music: { action: "NEXT", target: "YOUTUBE" } });
    const retry = await c.service.send(c.room.id, "next song on youtube", "music:next", "trace:music");
    expect(retry.directCommand?.music).toBeUndefined();
    const result = await c.service.acknowledgeCommand(c.room.id, "music:next", false);
    expect(result.messages.at(-1)).toMatchObject({ status: "FAILED" });
    expect(c.enqueue).not.toHaveBeenCalled();
  });
  it("sends compound work to the conversation, never to a mission or a partial batch", async () => {
    const c = fixture();
    await c.service.send(c.room.id, "open 2 codex panes and review the architecture", "advanced:test", "trace:advanced");
    expect(c.start).toHaveBeenCalledWith(expect.objectContaining({ roomId: c.room.id, requestId: "advanced:test", content: "open 2 codex panes and review the architecture" }));
    expect(c.enqueue).not.toHaveBeenCalled();
    expect(c.store.listPanes(c.room.id).filter(p=>!p.isClosed)).toHaveLength(0);
  });
});
