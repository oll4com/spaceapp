import { describe, expect, it } from "vitest";
import {
  connectedPaneCount,
  HIDDEN_WARM_ROOM_RUNTIME_POLL_INTERVAL_MS,
  selectRoomRuntimePollIds,
  selectWarmRoomIds,
  WARM_ROOM_RUNTIME_POLL_INTERVAL_MS,
  warmRoomLimits
} from "../src/room-runtime-cache.js";

describe("warm room runtime policy", () => {
  it("uses the fixed six-room budget with a user-configurable pane limit", () => {
    expect(warmRoomLimits(undefined)).toEqual({ maxRooms: 6, maxAttachedPanes: 96 });
    expect(warmRoomLimits(24)).toEqual({ maxRooms: 6, maxAttachedPanes: 24 });
  });

  it("counts enabled terminal panes and live browser panes without charging chat or review panes", () => {
    expect(
      connectedPaneCount(
        [
          { id: "pane:terminal-visible", mode: "TERMINAL", isMinimized: false },
          { id: "pane:terminal-warm", mode: "TERMINAL", isMinimized: true },
          { id: "pane:terminal-cold", mode: "TERMINAL", isMinimized: true },
          { id: "pane:browser", mode: "BROWSER", isMinimized: false },
          { id: "pane:chat", mode: "CHAT", isMinimized: false },
          { id: "pane:review", mode: "REVIEW", isMinimized: false }
        ],
        ["pane:terminal-warm"]
      )
    ).toBe(3);
  });

  it("prioritizes the active room, previous room, ordered neighbours, then recent inactive rooms", () => {
    expect(
      selectWarmRoomIds({
        roomIds: ["room:a", "room:b", "room:c", "room:d", "room:e"],
        activeRoomId: "room:c",
        previousRoomId: "room:a",
        maxAttachedPanes: 12,
        candidates: [
          { roomId: "room:a", attachedPaneCount: 2, lastAccessedAt: 20 },
          { roomId: "room:b", attachedPaneCount: 2, lastAccessedAt: 100 },
          { roomId: "room:c", attachedPaneCount: 3, lastAccessedAt: 30 },
          { roomId: "room:d", attachedPaneCount: 2, lastAccessedAt: 10 },
          { roomId: "room:e", attachedPaneCount: 1, lastAccessedAt: 200 }
        ]
      })
    ).toEqual(["room:c", "room:a", "room:d", "room:b", "room:e"]);
  });

  it("never evicts the active room and admits every room while the pane budget is disabled", () => {
    expect(
      selectWarmRoomIds({
        roomIds: ["room:a", "room:b", "room:c"],
        activeRoomId: "room:a",
        previousRoomId: "room:b",
        maxAttachedPanes: 12,
        candidates: [
          { roomId: "room:a", attachedPaneCount: 10, lastAccessedAt: 30 },
          { roomId: "room:b", attachedPaneCount: 3, lastAccessedAt: 20 },
          { roomId: "room:c", attachedPaneCount: 2, lastAccessedAt: 10 }
        ]
      })
    ).toEqual(["room:a", "room:b", "room:c"]);

    expect(
      selectWarmRoomIds({
        roomIds: ["room:a", "room:b"],
        activeRoomId: "room:a",
        previousRoomId: "room:b",
        maxAttachedPanes: 6,
        candidates: [
          { roomId: "room:a", attachedPaneCount: 9, lastAccessedAt: 20 },
          { roomId: "room:b", attachedPaneCount: 1, lastAccessedAt: 10 }
        ]
      })
    ).toEqual(["room:a", "room:b"]);
  });

  it("keeps two 16-pane rooms warm at the exact 32-pane limit", () => {
    expect(
      selectWarmRoomIds({
        roomIds: ["room:a", "room:b"],
        activeRoomId: "room:b",
        previousRoomId: "room:a",
        maxAttachedPanes: 32,
        candidates: [
          { roomId: "room:a", attachedPaneCount: 16, lastAccessedAt: 10 },
          { roomId: "room:b", attachedPaneCount: 16, lastAccessedAt: 20 }
        ]
      })
    ).toEqual(["room:b", "room:a"]);
  });

  it("keeps only the active room when the warm room cache is disabled", () => {
    expect(
      selectWarmRoomIds({
        enabled: false,
        roomIds: ["room:a", "room:b", "room:c"],
        activeRoomId: "room:b",
        previousRoomId: "room:a",
        maxAttachedPanes: 32,
        candidates: [
          { roomId: "room:a", attachedPaneCount: 8, lastAccessedAt: 20 },
          { roomId: "room:b", attachedPaneCount: 8, lastAccessedAt: 30 },
          { roomId: "room:c", attachedPaneCount: 8, lastAccessedAt: 10 }
        ]
      })
    ).toEqual(["room:b"]);
  });

  it("does not spend the warm budget on inactive rooms that have not loaded yet", () => {
    expect(
      selectWarmRoomIds({
        roomIds: ["room:a", "room:b", "room:c"],
        activeRoomId: "room:a",
        previousRoomId: null,
        maxAttachedPanes: 32,
        candidates: [{ roomId: "room:a", attachedPaneCount: 1, lastAccessedAt: 10 }]
      })
    ).toEqual(["room:a"]);
  });

  it("never polls the active room and checks hidden warm rooms on a thirty-second interval", () => {
    expect(WARM_ROOM_RUNTIME_POLL_INTERVAL_MS).toBe(30_000);
    expect(HIDDEN_WARM_ROOM_RUNTIME_POLL_INTERVAL_MS).toBe(30_000);

    const lastPolledAtByRoomId = new Map([
      ["room:active", 27_000],
      ["room:hidden-fresh", 1],
      ["room:hidden-due", 0]
    ]);

    expect(
      selectRoomRuntimePollIds({
        warmRoomIds: ["room:active", "room:hidden-fresh", "room:hidden-due"],
        activeRoomId: "room:active",
        lastPolledAtByRoomId,
        now: 29_999
      })
    ).toEqual([]);

    expect(
      selectRoomRuntimePollIds({
        warmRoomIds: ["room:active", "room:hidden-fresh", "room:hidden-due"],
        activeRoomId: "room:active",
        lastPolledAtByRoomId,
        now: 30_000
      })
    ).toEqual(["room:hidden-due"]);
  });

  it("schedules no runtime polling when warm mode retains only the active room", () => {
    expect(
      selectRoomRuntimePollIds({
        warmRoomIds: ["room:active"],
        activeRoomId: "room:active",
        lastPolledAtByRoomId: new Map(),
        now: 60_000
      })
    ).toEqual([]);
  });

  it("polls a newly warm hidden room once and de-duplicates scheduling input", () => {
    expect(
      selectRoomRuntimePollIds({
        warmRoomIds: ["room:active", "room:hidden", "room:hidden"],
        activeRoomId: "room:active",
        lastPolledAtByRoomId: new Map([["room:active", 10_000]]),
        now: 10_000
      })
    ).toEqual(["room:hidden"]);
  });
});
