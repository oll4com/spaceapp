import { describe, expect, it } from "vitest";
import {
  defaultNotificationSettings, notificationChannelEnabled, notificationRaiseInputSchema, notificationSettingsSchema, notificationStreamPayloadSchema, resolveNotificationSettings,
  spaceNotificationSchema, updateUserSettingsInputSchema, userSettingsSchema
} from "../src/index.js";

describe("Space notifications contracts", () => {
  it("parses a notification record, a raise input with defaults, and the ids-only stream payload", () => {
    const record = spaceNotificationSchema.parse({ id: "notification:abc123def456", ownerUserId: "user:1", roomId: "room:1", paneId: null, source: "MAIL_COPILOT", kind: "MAIL_RECEIVED",
      severity: "INFO", title: "Anna", body: "Invoice", link: { roomId: "room:1", target: "thread:me@gmail.com:t1" }, dedupeKey: "mail:me@gmail.com:m1", status: "OPEN", payload: {},
      createdAt: "2026-10-13T10:00:00.000Z", updatedAt: "2026-10-13T10:00:00.000Z", readAt: null, ackedAt: null, resolvedAt: null });
    expect(record.link.target).toBe("thread:me@gmail.com:t1");
    expect(notificationRaiseInputSchema.parse({ ownerUserId: "user:1", source: "SYSTEM", kind: "TEST", title: "  Hello " })).toEqual({
      ownerUserId: "user:1", roomId: null, paneId: null, source: "SYSTEM", kind: "TEST", severity: "INFO", title: "Hello", body: "", link: {}, dedupeKey: null, payload: {}, telegram: null
    });
    expect(notificationStreamPayloadSchema.safeParse({ notificationId: record.id, ownerUserId: "user:1", source: "MAIL_COPILOT", kind: "MAIL_RECEIVED", severity: "INFO", status: "OPEN", roomId: "room:1", paneId: null, title: "leak" }).success).toBe(false);
    expect(spaceNotificationSchema.safeParse({ ...record, source: "SLACK" }).success).toBe(false);
  });

  it("defaults every channel on, lets a source turn its own down, and lives in the user settings", () => {
    expect(defaultNotificationSettings.channels).toEqual({ inApp: true, toast: true, sound: true, desktop: true, telegram: true, push: true });
    const settings = notificationSettingsSchema.parse({ channels: { desktop: false }, perSource: { MAIL_COPILOT: { telegram: false }, SYSTEM: { desktop: true } } });
    expect(notificationChannelEnabled(settings, "MAIL_COPILOT", "telegram")).toBe(false);
    expect(notificationChannelEnabled(settings, "JOB_COPILOT", "telegram")).toBe(true);
    expect(notificationChannelEnabled(settings, "JOB_COPILOT", "desktop")).toBe(false);
    expect(notificationChannelEnabled(settings, "SYSTEM", "desktop")).toBe(true);
    expect(resolveNotificationSettings(null)).toEqual(defaultNotificationSettings);
    expect(userSettingsSchema.parse({ notifications: { channels: { sound: false } } }).notifications?.channels.sound).toBe(false);
    expect(updateUserSettingsInputSchema.parse({ notifications: null }).notifications).toBeNull();
  });
});
