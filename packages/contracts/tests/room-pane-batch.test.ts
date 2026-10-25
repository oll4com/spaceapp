import {
  createRoomPanesInputSchema,
  createRoomPanesRequestSchema,
  roomPanesResultSchema
} from "@space/contracts";
import { describe, expect, it } from "vitest";

describe("room pane batch contracts", () => {
  it("accepts a mixed terminal and chat batch", () => {
    expect(createRoomPanesRequestSchema.parse({
      panes: [
        { mode: "TERMINAL", terminalRuntimeId: " cli:codex " },
        { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" },
        { mode: "CHAT" }
      ]
    })).toEqual({
      panes: [
        { mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
        { mode: "TERMINAL", terminalRuntimeId: "cli:opencode" },
        { mode: "CHAT" }
      ]
    });

    expect(createRoomPanesInputSchema.parse({
      roomId: "room:test",
      panes: [{ mode: "CHAT" }]
    })).toEqual({ roomId: "room:test", panes: [{ mode: "CHAT" }] });
  });

  it("rejects invalid mode and runtime combinations", () => {
    expect(() => createRoomPanesRequestSchema.parse({
      panes: [{ mode: "CHAT", terminalRuntimeId: "cli:codex" }]
    })).toThrow();
    expect(() => createRoomPanesRequestSchema.parse({
      panes: [{ mode: "TERMINAL" }]
    })).toThrow();
  });

  it("accepts a harness pane in a batch", () => {
    expect(createRoomPanesRequestSchema.parse({
      panes: [{ mode: "HARNESS" }]
    })).toEqual({ panes: [{ mode: "HARNESS" }] });
  });

  it("enforces a non-empty maximum batch of 16 and validates the response", () => {
    expect(() => createRoomPanesRequestSchema.parse({ panes: [] })).toThrow();
    expect(() => createRoomPanesRequestSchema.parse({
      panes: Array.from({ length: 17 }, () => ({ mode: "CHAT" }))
    })).toThrow();

    const pane = {
      id: "pane:test",
      roomId: "room:test",
      title: "Chat 1",
      mode: "CHAT",
      status: "IDLE",
      providerId: null,
      modelId: null,
      terminalRuntimeId: null,
      reasoningEffort: "medium",
      cwd: null,
      order: 0,
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null },
      createdAt: "2026-07-20T00:00:00.000Z",
      updatedAt: "2026-07-20T00:00:00.000Z"
    };
    expect(roomPanesResultSchema.parse({ roomId: "room:test", data: [pane] }).data).toHaveLength(1);
  });
});
