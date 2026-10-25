import { beforeEach, describe, expect, it, vi } from "vitest";
const updateUserSettings = vi.hoisted(() => vi.fn(async (_input: unknown) => ({})));
vi.mock("../src/api.js", () => ({ api: { updateUserSettings } }));
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  DEFAULT_WARM_ROOM_ENABLED,
  DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT,
  WARM_ROOM_ENABLED_STORAGE_KEY,
  WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY,
  normalizeWarmRoomConnectedPaneLimit,
  applyServerWarmRoomEnabled,
  applyServerWarmRoomConnectedPaneLimit,
  readStoredWarmRoomEnabled,
  readStoredWarmRoomConnectedPaneLimit,
  writeStoredWarmRoomEnabled,
  writeStoredWarmRoomConnectedPaneLimit
} from "../src/warm-room-settings.js";

describe("warm room browser-local settings", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
    updateUserSettings.mockReset().mockResolvedValue({});
  });

  it("defaults invalid values to 96 and clamps integer values to the safe 6–96 range", () => {
    expect(DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT).toBe(96);
    expect(normalizeWarmRoomConnectedPaneLimit(undefined)).toBe(96);
    expect(normalizeWarmRoomConnectedPaneLimit(null)).toBe(96);
    expect(normalizeWarmRoomConnectedPaneLimit("")).toBe(96);
    expect(normalizeWarmRoomConnectedPaneLimit("invalid")).toBe(96);
    expect(normalizeWarmRoomConnectedPaneLimit(Number.POSITIVE_INFINITY)).toBe(96);
    expect(normalizeWarmRoomConnectedPaneLimit(5)).toBe(6);
    expect(normalizeWarmRoomConnectedPaneLimit("12.9")).toBe(12);
    expect(normalizeWarmRoomConnectedPaneLimit(97)).toBe(96);
  });

  it("reads and writes the effective normalized value in localStorage", () => {
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(96);

    window.localStorage.setItem(WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY, "18.8");
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(18);

    expect(writeStoredWarmRoomConnectedPaneLimit("999")).toBe(96);
    expect(window.localStorage.getItem(WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY)).toBe("96");

    window.localStorage.setItem(WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY, "not-a-limit");
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(96);
  });

  it("defaults the warm room cache on and persists explicit opt-outs", () => {
    expect(DEFAULT_WARM_ROOM_ENABLED).toBe(true);
    expect(readStoredWarmRoomEnabled()).toBe(true);

    expect(writeStoredWarmRoomEnabled(false)).toBe(false);
    expect(window.localStorage.getItem(WARM_ROOM_ENABLED_STORAGE_KEY)).toBe("false");
    expect(readStoredWarmRoomEnabled()).toBe(false);

    expect(writeStoredWarmRoomEnabled(true)).toBe(true);
    expect(window.localStorage.getItem(WARM_ROOM_ENABLED_STORAGE_KEY)).toBe("true");
    expect(readStoredWarmRoomEnabled()).toBe(true);
  });

  it("reads a local fallback then applies server preferences without writing them back", () => {
    window.localStorage.setItem(WARM_ROOM_ENABLED_STORAGE_KEY, "true");
    window.localStorage.setItem(WARM_ROOM_CONNECTED_PANE_LIMIT_STORAGE_KEY, "96");
    expect(readStoredWarmRoomEnabled()).toBe(true);
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(96);
    applyServerWarmRoomEnabled(false);
    applyServerWarmRoomConnectedPaneLimit(48);
    expect(readStoredWarmRoomEnabled()).toBe(false);
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(48);
    expect(updateUserSettings).not.toHaveBeenCalled();
  });

  it("sends one settings update per explicit choice and none when reading it again", () => {
    writeStoredWarmRoomEnabled(false);
    writeStoredWarmRoomConnectedPaneLimit(48);
    expect(updateUserSettings.mock.calls).toEqual([
      [{ warmRoomEnabled: false }], [{ warmRoomConnectedPaneLimit: 48 }]
    ]);
    expect(readStoredWarmRoomEnabled()).toBe(false);
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(48);
    expect(updateUserSettings).toHaveBeenCalledTimes(2);
  });

  it("keeps the local choice when an explicit save fails offline without retry writes", async () => {
    updateUserSettings.mockRejectedValue(new Error("offline"));
    writeStoredWarmRoomEnabled(false);
    writeStoredWarmRoomConnectedPaneLimit(48);
    await Promise.resolve();
    expect(readStoredWarmRoomEnabled()).toBe(false);
    expect(readStoredWarmRoomConnectedPaneLimit()).toBe(48);
    expect(updateUserSettings).toHaveBeenCalledTimes(2);
  });
});
