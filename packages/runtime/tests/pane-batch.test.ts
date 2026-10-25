import { describe, expect, it } from "vitest";
import { InMemorySpaceStore, SpaceConflictError } from "../src/index.js";

describe("InMemorySpaceStore pane batches", () => {
  it("keeps single-pane title behavior unchanged", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Single", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "Existing title", mode: "CHAT" });
    expect(pane.title).toBe("Existing title");
  });

  it("creates an ordered mixed batch with one event per pane", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Mixed", initialPaneCount: 1 }, "trace:room");
    const beforeEvents = store.listEvents(room.id).length;

    const panes = store.createPanes([
      { roomId: room.id, title: "Codex CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex", cwd: "/etc" },
      { roomId: room.id, title: "OpenCode CLI", mode: "TERMINAL", terminalRuntimeId: "cli:opencode", cwd: "/etc" },
      { roomId: room.id, title: "Chat", mode: "CHAT" }
    ], "trace:batch");

    expect(panes.map((pane) => ({ title: pane.title, order: pane.order, runtime: pane.terminalRuntimeId, cwd: pane.cwd }))).toEqual([
      { title: "Codex CLI 2", order: 1, runtime: "cli:codex", cwd: "/etc" },
      { title: "OpenCode CLI 3", order: 2, runtime: "cli:opencode", cwd: "/etc" },
      { title: "Chat 4", order: 3, runtime: null, cwd: null }
    ]);
    expect(store.listEvents(room.id).slice(beforeEvents)).toEqual(
      panes.map((pane) => expect.objectContaining({ paneId: pane.id, traceId: "trace:batch", type: "PANE_CREATED" }))
    );
  });

  it("preflights capacity and room identity without partial creation", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Capacity", initialPaneCount: 15 }, "trace:room");
    const other = store.createRoom({ name: "Other", initialPaneCount: 0 }, "trace:other");
    const before = store.listPanes(room.id);
    const beforeEvents = store.listEvents(room.id);

    expect(() => store.createPanes([
      { roomId: room.id, title: "Chat", mode: "CHAT" },
      { roomId: room.id, title: "Chat", mode: "CHAT" }
    ], "trace:overflow")).toThrow(SpaceConflictError);
    expect(() => store.createPanes([
      { roomId: room.id, title: "Chat", mode: "CHAT" },
      { roomId: other.id, title: "Chat", mode: "CHAT" }
    ], "trace:cross-room")).toThrow("one room");
    expect(store.listPanes(room.id)).toEqual(before);
    expect(store.listEvents(room.id)).toEqual(beforeEvents);
  });
});
