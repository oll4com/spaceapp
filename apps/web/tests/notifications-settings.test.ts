/* @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";
import { liveRuntime } from "../src/live/live-runtime.js";
import { installSpaceRuntime } from "../src/runtime/SpaceRuntime.js";
import {
  DEFAULT_SUPPRESS_NOTIFICATIONS,
  SUPPRESS_NOTIFICATIONS_STORAGE_KEY,
  readStoredSuppressNotifications,
  writeStoredSuppressNotifications,
} from "../src/notifications-settings.js";

describe("notification suppression browser-local settings", () => {
  beforeEach(() => {
    installSpaceRuntime(liveRuntime);
    window.localStorage.clear();
  });

  it("defaults notifications on and persists explicit opt-outs", () => {
    expect(DEFAULT_SUPPRESS_NOTIFICATIONS).toBe(false);
    expect(readStoredSuppressNotifications()).toBe(false);

    expect(writeStoredSuppressNotifications(true)).toBe(true);
    expect(window.localStorage.getItem(SUPPRESS_NOTIFICATIONS_STORAGE_KEY)).toBe("true");
    expect(readStoredSuppressNotifications()).toBe(true);

    expect(writeStoredSuppressNotifications(false)).toBe(false);
    expect(window.localStorage.getItem(SUPPRESS_NOTIFICATIONS_STORAGE_KEY)).toBe("false");
    expect(readStoredSuppressNotifications()).toBe(false);
  });
});
