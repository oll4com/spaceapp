import { describe, expect, it, vi } from "vitest";
import {
  classifyRoomWarmPresentation,
  hydrateWarmRoomsWithinWindow,
  isRoomInEvictionCooldown,
  readRoomMru,
  recordRoomMru,
  runWithConcurrency,
  selectAutomaticWarmFillRoomIds,
  selectWarmHydrationRoomIds,
  WARM_ROOM_EVICTION_COOLDOWN_MS
} from "../src/warm-room-startup.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    }
  };
}

describe("warm room startup", () => {
  it("keeps a tab-scoped six-room MRU and filters stale or malformed entries", () => {
    const storage = memoryStorage();
    for (const roomId of ["room:a", "room:b", "room:c", "room:d", "room:e", "room:f", "room:g"]) {
      recordRoomMru(storage, roomId);
    }
    expect(readRoomMru(storage)).toEqual([
      "room:g",
      "room:f",
      "room:e",
      "room:d",
      "room:c",
      "room:b"
    ]);

    storage.setItem("space.warmRoom.mru.v1", JSON.stringify(["room:g", 4, "room:g", "room:missing", "room:b"]));
    expect(readRoomMru(storage, new Set(["room:g", "room:b"]))).toEqual(["room:g", "room:b"]);
  });

  it("selects recent rooms first and fills missing capacity from adjacent rooms up to safe capacity", () => {
    expect(
      selectWarmHydrationRoomIds({
        roomIds: ["room:a", "room:b", "room:c", "room:d", "room:e"],
        activeRoomId: "room:c",
        mruRoomIds: ["room:c", "room:e", "room:gone"],
        maxWarmRooms: 3
      })
    ).toEqual(["room:e", "room:d"]);

    expect(
      selectWarmHydrationRoomIds({
        roomIds: ["room:a", "room:b", "room:c"],
        activeRoomId: "room:b",
        mruRoomIds: [],
        maxWarmRooms: 2
      })
    ).toEqual(["room:c"]);

    expect(
      selectWarmHydrationRoomIds({
        roomIds: ["room:a", "room:b", "room:c", "room:d", "room:e", "room:f"],
        activeRoomId: "room:a",
        mruRoomIds: ["room:f", "room:e", "room:d", "room:c", "room:b"],
        maxWarmRooms: 6
      })
    ).toEqual(["room:f", "room:e", "room:d", "room:c", "room:b"]);
  });

  it("fills the five background slots from the catalog when a fresh tab has no MRU", () => {
    expect(selectWarmHydrationRoomIds({
      roomIds: ["room:a", "room:b", "room:c", "room:d", "room:e", "room:f", "room:g", "room:h"],
      activeRoomId: "room:d",
      mruRoomIds: [],
      maxWarmRooms: 6
    })).toEqual(["room:e", "room:c", "room:a", "room:b", "room:f"]);
  });

  it("deduplicates recent and adjacent rooms before filling from the catalog", () => {
    expect(selectWarmHydrationRoomIds({
      roomIds: ["room:a", "room:b", "room:c", "room:d", "room:e", "room:f", "room:g", "room:h"],
      activeRoomId: "room:d",
      mruRoomIds: ["room:d", "room:g", "room:e", "room:g", "room:deleted"],
      maxWarmRooms: 20
    })).toEqual(["room:g", "room:e", "room:c", "room:a", "room:b"]);
  });

  it("leaves no background work when the active room uses the whole room budget", () => {
    expect(selectWarmHydrationRoomIds({
      roomIds: ["room:a", "room:b", "room:c"],
      activeRoomId: "room:a",
      mruRoomIds: ["room:c"],
      maxWarmRooms: 1
    })).toEqual([]);
  });

  it("hydrates rooms with bounded concurrency inside the shared two-second window", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const active = { count: 0, peak: 0 };
    const promise = hydrateWarmRoomsWithinWindow(
      ["room:b", "room:c", "room:d"],
      async (roomId) => {
        started.push(roomId);
        active.count += 1;
        active.peak = Math.max(active.peak, active.count);
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, 1_200);
        });
        active.count -= 1;
      },
      2_000,
      2
    );

    // Flush worker scheduling microtasks without advancing the hydration timers.
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["room:b", "room:c"]);
    expect(active.peak).toBe(2);

    await vi.advanceTimersByTimeAsync(1_200);
    await Promise.resolve();
    await Promise.resolve();
    // Third room starts after the first wave frees a slot, but cannot finish in the remaining 800ms.
    expect(started).toEqual(["room:b", "room:c", "room:d"]);
    await vi.advanceTimersByTimeAsync(800);
    await expect(promise).resolves.toEqual(["room:b", "room:c"]);
    vi.useRealTimers();
  });

  it("drops in-flight hydration that misses the shared window deadline", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const promise = hydrateWarmRoomsWithinWindow(
      ["room:b", "room:c"],
      async (roomId) => {
        started.push(roomId);
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, roomId === "room:b" ? 1_500 : 1_000);
        });
      },
      2_000,
      1
    );

    await Promise.resolve();
    expect(started).toEqual(["room:b"]);
    await vi.advanceTimersByTimeAsync(1_500);
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual(["room:b", "room:c"]);
    await vi.advanceTimersByTimeAsync(500);
    await expect(promise).resolves.toEqual(["room:b"]);
    vi.useRealTimers();
  });

  it("runs deferred admin requests with at most four concurrent operations", async () => {
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const tasks = Array.from({ length: 9 }, (_, index) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return index;
    });
    const result = runWithConcurrency(tasks, 4);
    await vi.waitFor(() => expect(active).toBe(4));
    while (releases.length > 0) {
      releases.shift()?.();
      await Promise.resolve();
    }
    await expect(result).resolves.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(peak).toBe(4);
  });

  it("selects multiple automatic warm-fill targets while skipping blocked and loaded rooms", () => {
    expect(
      selectAutomaticWarmFillRoomIds({
        roomIds: ["room:a", "room:b", "room:c", "room:d", "room:e"],
        activeRoomId: "room:c",
        preferredRoomIds: ["room:e", "room:a"],
        loadedRoomIds: new Set(["room:c", "room:a"]),
        eligibleRoomIds: new Set(["room:a", "room:b", "room:c", "room:d", "room:e"]),
        blockedRoomIds: new Set(["room:e"]),
        slots: 2
      })
    ).toEqual(["room:d", "room:b"]);
  });

  it("tracks eviction cool-down windows", () => {
    const map = new Map<string, number>([["room:x", 1_000]]);
    expect(isRoomInEvictionCooldown("room:x", map, 1_000 + WARM_ROOM_EVICTION_COOLDOWN_MS - 1)).toBe(true);
    expect(isRoomInEvictionCooldown("room:x", map, 1_000 + WARM_ROOM_EVICTION_COOLDOWN_MS)).toBe(false);
    expect(isRoomInEvictionCooldown("room:y", map, 50_000)).toBe(false);
  });

  it("classifies room warm presentation for the room list", () => {
    expect(
      classifyRoomWarmPresentation({
        roomId: "room:a",
        activeRoomId: "room:a",
        warmRoomIds: ["room:a", "room:b"],
        hydratingRoomIds: new Set(),
        loadedRoomIds: new Set(["room:a", "room:b"])
      })
    ).toBe("active");
    expect(
      classifyRoomWarmPresentation({
        roomId: "room:b",
        activeRoomId: "room:a",
        warmRoomIds: ["room:a", "room:b"],
        hydratingRoomIds: new Set(),
        loadedRoomIds: new Set(["room:a", "room:b"])
      })
    ).toBe("warm");
    expect(
      classifyRoomWarmPresentation({
        roomId: "room:c",
        activeRoomId: "room:a",
        warmRoomIds: ["room:a"],
        hydratingRoomIds: new Set(["room:c"]),
        loadedRoomIds: new Set(["room:a"])
      })
    ).toBe("warming");
    expect(
      classifyRoomWarmPresentation({
        roomId: "room:d",
        activeRoomId: "room:a",
        warmRoomIds: ["room:a"],
        hydratingRoomIds: new Set(),
        loadedRoomIds: new Set(["room:a"])
      })
    ).toBe("cold");
  });
});
