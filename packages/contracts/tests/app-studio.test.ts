import { describe, expect, it } from "vitest";
import {
  APP_STUDIO_DEFAULT_DEVICE_IDS, APP_STUDIO_DEVICES, appStudioDevice, appStudioDeviceIdSchema, appStudioEventSchema, appStudioPaneMetadataSchema,
  appStudioRouteSchema, defaultAppStudioPaneMetadata, paneModeSchema, resolveAppStudioPaneMetadata, roomPaneBatchItemSchema
} from "../src/index.js";

describe("App Studio contracts", () => {
  it("lists ten current phones, five per platform, each id matching its size and the id format", () => {
    expect(APP_STUDIO_DEVICES).toHaveLength(10);
    expect(APP_STUDIO_DEVICES.filter((device) => device.platform === "ANDROID")).toHaveLength(5);
    expect(new Set(APP_STUDIO_DEVICES.map((device) => device.id)).size).toBe(10);
    for (const device of APP_STUDIO_DEVICES) {
      expect(appStudioDeviceIdSchema.parse(device.id)).toBe(device.id);
      expect(device.id).toBe(`${device.platform === "IOS" ? "iphone" : "android"}-${device.width}x${device.height}`);
      expect(device.safeArea.top).toBeGreaterThan(0);
    }
    // The 2018-19 iPhone XR/11 viewport stays out (operator: no old phones).
    expect(appStudioDevice("iphone-414x896")).toBeNull();
    for (const id of APP_STUDIO_DEFAULT_DEVICE_IDS) expect(appStudioDevice(id)).not.toBeNull();
  });

  it("reads a pane without metadata as the defaults and refuses unknown fields", () => {
    const metadata = resolveAppStudioPaneMetadata(null);
    expect(metadata).toEqual(defaultAppStudioPaneMetadata());
    expect(metadata.settings).toEqual({ paused: false, devices: ["android-412x915", "iphone-402x874"], notifications: { needsYou: true, done: true, telegram: false } });
    expect(() => appStudioPaneMetadataSchema.parse({ version: 1, settings: { autonomy: "FULL" } })).toThrow();
    expect(() => appStudioPaneMetadataSchema.parse({ version: 1, settings: { devices: [] } })).toThrow();
  });

  it("accepts only app routes and well-formed feed rows", () => {
    expect(appStudioRouteSchema.parse("/settings/profile")).toBe("/settings/profile");
    for (const bad of ["settings", "/../etc", "https://example.com/", "/a b"]) expect(appStudioRouteSchema.safeParse(bad).success, bad).toBe(false);
    expect(appStudioEventSchema.parse({ id: "asevt:abcdef12", ownerUserId: "user:operator", paneId: "pane:abcdef12", type: "BRIEF", status: "PENDING",
      message: "Build a todo app", payload: {}, createdAt: "2026-10-19T09:00:00.000Z", updatedAt: "2026-10-19T09:00:00.000Z" }).type).toBe("BRIEF");
  });

  it("is a pane mode that carries a CLI runtime", () => {
    expect(paneModeSchema.options).toContain("APP_STUDIO");
    expect(roomPaneBatchItemSchema.parse({ mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" })).toEqual({ mode: "APP_STUDIO", terminalRuntimeId: "cli:claude" });
    expect(roomPaneBatchItemSchema.safeParse({ mode: "APP_STUDIO", cwd: "/etc" }).success).toBe(false);
  });
});
