import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  clearLifecycleDebugEvents,
  LIFECYCLE_DEBUG_UPDATED_EVENT,
  readLifecycleDebugSnapshot,
  recordLifecycleDebugEvent
} from "../src/lifecycle-debug.js";

const KEY = "space.lifecycleDebug.events";
const settle = async () => { vi.runAllTimers(); };
const stored = () => JSON.parse(window.sessionStorage.getItem(KEY) ?? "[]") as Array<{ detail: string }>;

// PERF-001 C-3: a room switch records 32 pane visibility changes in one task; they reach sessionStorage in one write.
describe("lifecycle debug events", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.sessionStorage.clear();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  afterEach(() => {
    vi.runAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // W1: the write waits for idle time (it cost ~53 ms inside the room-switch frame); pagehide still writes at once.
  it("defers the write to idle time and writes pagehide records at once", async () => {
    const idle: Array<() => void> = [];
    vi.stubGlobal("requestIdleCallback", (callback: () => void, options: { timeout: number }) => {
      expect(options.timeout).toBe(1000);
      idle.push(callback);
      return idle.length;
    });
    recordLifecycleDebugEvent({ type: "room_switch", scope: "App", detail: "switch" });
    await Promise.resolve();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(readLifecycleDebugSnapshot().events.map((event) => event.detail)).toEqual(["switch"]);
    idle.shift()?.();
    expect(stored().map((event) => event.detail)).toEqual(["switch"]);

    recordLifecycleDebugEvent({ type: "room_switch", scope: "App", detail: "queued" });
    recordLifecycleDebugEvent({ type: "window_pagehide", scope: "App", detail: "leaving" });
    expect(stored().map((event) => event.detail)).toEqual(["switch", "queued", "leaving"]);
    const writes = vi.spyOn(Storage.prototype, "setItem");
    idle.shift()?.();
    expect(writes).not.toHaveBeenCalled();
  });

  it("writes the events of one task once, in order, and still announces each one at once", async () => {
    const writes = vi.spyOn(Storage.prototype, "setItem");
    const updates = vi.fn();
    window.addEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, updates);
    for (let index = 0; index < 32; index += 1) {
      recordLifecycleDebugEvent({ type: "pane_visibility_changed", scope: "PaneCard", detail: `pane ${index}` });
    }
    // Readers and listeners in the same task see every event before the write.
    expect(readLifecycleDebugSnapshot().events.map((event) => event.detail)).toHaveLength(32);
    expect(updates).toHaveBeenCalledTimes(32);
    await settle();
    window.removeEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, updates);
    expect(writes.mock.calls.filter(([key]) => key === KEY)).toHaveLength(1);
    expect(stored().map((event) => event.detail)).toEqual(Array.from({ length: 32 }, (_, index) => `pane ${index}`));
  });

  it("keeps the newest 200, announces nothing for silent records and follows storage changed elsewhere", async () => {
    const updates = vi.fn();
    window.addEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, updates);
    for (let index = 0; index < 250; index += 1) {
      recordLifecycleDebugEvent({ type: "probe", scope: "test", detail: String(index), notify: false });
    }
    await settle();
    window.removeEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, updates);
    expect(updates).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(200);
    expect(stored()[0]?.detail).toBe("50");
    expect(readLifecycleDebugSnapshot().events.at(-1)?.detail).toBe("249");

    window.sessionStorage.clear();
    expect(readLifecycleDebugSnapshot().events).toEqual([]);
    recordLifecycleDebugEvent({ type: "probe", scope: "test", detail: "after clear" });
    await settle();
    expect(stored().map((event) => event.detail)).toEqual(["after clear"]);

    clearLifecycleDebugEvents();
    await settle();
    expect(window.sessionStorage.getItem(KEY)).toBeNull();
    expect(readLifecycleDebugSnapshot().events).toEqual([]);
  });
});
