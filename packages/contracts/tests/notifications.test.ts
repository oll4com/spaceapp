import { describe, expect, it } from "vitest";
import {
  defaultNotificationSettings, needsOperatorHands, needsYou, notificationChannelEnabled, notificationRaiseInputSchema, notificationSettingsSchema, notificationStreamPayloadSchema,
  resolveNotificationSettings, spaceNotificationSchema, updateUserSettingsInputSchema, userSettingsSchema, type NotificationSource
} from "../src/index.js";

describe("Space notifications contracts", () => {
  // Needs you (operator request 2026-10-24): the one classifier of what brings the operator to a pane.
  it("names the notifications that need the operator at their pane: hands, questions, reviews and waiting CLI prompts, never INFO or without a pane", () => {
    const at = (source: NotificationSource, kind: string, severity: "INFO" | "ATTENTION" | "URGENT" = "ATTENTION", pane: string | null = "pane:1") =>
      needsYou({ source, kind, severity, paneId: pane, roomId: pane ? "room:1" : null });
    const yes: Array<[NotificationSource, string]> = [["AGENT", "NEEDS_YOU"], ["NOUS", "NEEDS_HANDS"], ["BROWSER_HANDOFF", "BROWSER_HANDOFF_REQUESTED"], ["JOB_COPILOT", "HANDOFF_REQUESTED"],
      ["JOB_COPILOT", "QUESTION"], ["JOB_COPILOT", "REVIEW_REQUESTED"], ["MAIL_COPILOT", "NEEDS_USER"], ["MARKETING_COPILOT", "RULE_PROPOSED"], ["MARKETING_COPILOT", "CAMPAIGN_PROPOSED"],
      ["FREELANCE_COPILOT", "CLIENT_READY"], ["ROOM_AGENT", "WAITING"], ["ROOM_AGENT", "QUESTION"], ["ROOM_AGENT", "SIGN_IN"], ["ROOM_AGENT", "USAGE_LIMIT"], ["ROOM_AGENT", "STUCK"],
      ["ROOM_AGENT", "OVERLAP"], ["DESIGN", "DESIGN_APPROVAL"], ["VIDEO", "VIDEO_QUESTION"], ["APP_STUDIO", "APP_STUDIO_QUESTION"], ["SECURITY_COPILOT", "SECURITY_REVIEW"]];
    for (const [source, kind] of yes) expect(at(source, kind), `${source} ${kind}`).toBe(true);
    const no: Array<[NotificationSource, string]> = [["MARKETING_COPILOT", "PUBLISH_FAILED"], ["MARKETING_COPILOT", "POSTS_DUE"], ["FREELANCE_COPILOT", "WORK_WAITING"], ["DESIGN", "DESIGN_READY"],
      ["DESIGN", "DESIGN_FAILED"], ["VIDEO", "VIDEO_DOWNLOADED"], ["MAIL_COPILOT", "MAIL_RECEIVED"], ["NOUS", "DECISION_OPEN"], ["ROOM_AGENT", "FINISHED"], ["SECURITY_COPILOT", "SECURITY_FINDING"]];
    for (const [source, kind] of no) expect(at(source, kind), `${source} ${kind}`).toBe(false);
    expect(at("JOB_COPILOT", "QUESTION", "INFO")).toBe(false);
    expect(at("JOB_COPILOT", "QUESTION", "ATTENTION", null)).toBe(false);
    expect(at("SECURITY_COPILOT", "SECURITY_REVIEW", "URGENT")).toBe(true);
    // A CLI's explicit needs-you is a hand request: at once in the app, held only for the operator's night.
    expect(needsOperatorHands("AGENT", "NEEDS_YOU")).toBe(true);
  });

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
