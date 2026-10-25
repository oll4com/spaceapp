import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  classifyRoomSwitchTemperature,
  LIFECYCLE_DEBUG_UPDATED_EVENT,
  readLifecycleDebugSnapshot,
  recordRoomSwitchMeasurementPhase,
  startRoomSwitchMeasurement
} from "../src/lifecycle-debug.js";

describe("room switch performance measurements", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("classifies only an already-mounted room runtime as warm", () => {
    expect(classifyRoomSwitchTemperature("room:beta", ["room:alpha", "room:beta"])).toBe("warm");
    expect(classifyRoomSwitchTemperature("room:cached-but-evicted", ["room:alpha", "room:beta"])).toBe("cold");
  });

  it("records structured warm switch activation and load durations", () => {
    const mark = vi.spyOn(window.performance, "mark");
    const measure = vi.spyOn(window.performance, "measure");
    const clearMarks = vi.spyOn(window.performance, "clearMarks");
    const clearMeasures = vi.spyOn(window.performance, "clearMeasures");
    let debugUpdateCount = 0;
    const countDebugUpdate = () => { debugUpdateCount += 1; };
    window.addEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, countDebugUpdate);
    try {
      const measurement = startRoomSwitchMeasurement({
        fromRoomId: "room:alpha",
        toRoomId: "room:beta",
        temperature: "warm"
      }, 100);
      const activatedMark = `space:room-switch:${measurement.id}:activated`;
      const loadedMark = `space:room-switch:${measurement.id}:loaded`;

      recordRoomSwitchMeasurementPhase(measurement, "activated", 112.34);
      recordRoomSwitchMeasurementPhase(measurement, "loaded", 148.91);

      const events = readLifecycleDebugSnapshot().events.filter((event) => event.roomSwitch?.id === measurement.id);
      expect(events.map((event) => event.type)).toEqual([
        "room_switch_started",
        "room_switch_activated",
        "room_switch_loaded"
      ]);
      expect(events.map((event) => event.roomSwitch?.durationMs)).toEqual([0, 12.3, 48.9]);
      expect(events.at(-1)?.roomSwitch).toMatchObject({
        fromRoomId: "room:alpha",
        toRoomId: "room:beta",
        temperature: "warm",
        phase: "loaded"
      });
      expect(events.at(-1)?.detail).toContain("temperature=warm durationMs=48.9");
      expect(mark).toHaveBeenNthCalledWith(1, measurement.startMark);
      expect(mark).toHaveBeenNthCalledWith(2, activatedMark);
      expect(mark).toHaveBeenNthCalledWith(3, loadedMark);
      expect(measure).toHaveBeenNthCalledWith(1, "space:room-switch:activated", measurement.startMark, activatedMark);
      expect(measure).toHaveBeenNthCalledWith(2, "space:room-switch:loaded", measurement.startMark, loadedMark);
      expect(clearMeasures).toHaveBeenNthCalledWith(1, "space:room-switch:activated");
      expect(clearMeasures).toHaveBeenNthCalledWith(2, "space:room-switch:loaded");
      expect(clearMarks).toHaveBeenCalledWith(activatedMark);
      expect(clearMarks).toHaveBeenCalledWith(loadedMark);
      expect(clearMarks).toHaveBeenCalledWith(measurement.startMark);
      expect(debugUpdateCount).toBe(1);
    } finally {
      window.removeEventListener(LIFECYCLE_DEBUG_UPDATED_EVENT, countDebugUpdate);
    }
  });
});
