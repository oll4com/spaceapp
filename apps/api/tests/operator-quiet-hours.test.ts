import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSchema, type Event, type Pane, type Room } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { handoffTtlSeconds, isOwnerQuietTime, nextOwnerWakeTime, ownerHandsAnswer, ownerQuietState, ownerTimeHeader } from "../src/owner-clock.js";

// Operator request 2026-10-20 (plan clipboard:9XSwTPyxXP1W): never expect the operator at a computer during their night.
const bangkok = { dateTime: { timeZone: "Asia/Bangkok" }, notifications: null } as never;
const at = (iso: string) => new Date(iso);
afterEach(() => { vi.useRealTimers(); });

describe("operator quiet hours", () => {
  it("knows the operator's night across midnight in their working zone, and when it ends", () => {
    // 00:44 Tue 20 Oct in Bangkok (UTC+7, no DST)
    expect(ownerQuietState(bangkok, at("2026-10-19T17:44:00Z"))).toMatchObject({ quiet: true, local: "Tue 20 Oct 00:44 GMT+7",
      wakeAt: "2026-10-20T02:00:00.000Z", wakeLocal: "09:00 GMT+7", timeZone: "Asia/Bangkok" });
    expect(isOwnerQuietTime(bangkok, at("2026-10-20T01:59:00Z"))).toBe(true); // 08:59
    expect(isOwnerQuietTime(bangkok, at("2026-10-20T02:00:00Z"))).toBe(false); // 09:00
    expect(isOwnerQuietTime(bangkok, at("2026-10-20T15:59:00Z"))).toBe(false); // 22:59
    expect(ownerQuietState(bangkok, at("2026-10-20T16:00:00Z")).wakeAt).toBe("2026-10-21T02:00:00.000Z"); // 23:00 -> next 09:00
    expect(nextOwnerWakeTime(bangkok, at("2026-10-20T05:00:00Z"))?.toISOString()).toBe("2026-10-21T02:00:00.000Z"); // noon -> tomorrow 09:00
    // A window within a day, quiet hours off, equal start and end, and no working zone: nothing is held.
    const window = { dateTime: { timeZone: "UTC" }, notifications: { quietHours: { enabled: true, start: "13:00", end: "15:00" } } } as never;
    expect([isOwnerQuietTime(window, at("2026-10-20T12:59:00Z")), isOwnerQuietTime(window, at("2026-10-20T13:00:00Z")), isOwnerQuietTime(window, at("2026-10-20T15:00:00Z"))]).toEqual([false, true, false]);
    expect(isOwnerQuietTime({ ...bangkok, notifications: { quietHours: { enabled: false } } } as never, at("2026-10-19T17:44:00Z"))).toBe(false);
    expect(isOwnerQuietTime({ ...bangkok, notifications: { quietHours: { start: "09:00", end: "09:00" } } } as never, at("2026-10-19T17:44:00Z"))).toBe(false);
    expect(ownerQuietState({ dateTime: { timeZone: "system" } } as never, at("2026-10-19T23:00:00Z"))).toMatchObject({ quiet: false, zoneSet: false });
    expect(nextOwnerWakeTime({ dateTime: { timeZone: "system" } } as never, at("2026-10-19T23:00:00Z"))).toBeNull();
  });

  it("puts the operator's time and night first in Nous's world, and tells agents until when a hand request is held", () => {
    const night = ownerQuietState(bangkok, at("2026-10-19T17:44:00Z"));
    expect(ownerTimeHeader(night)).toBe("Operator's time: Tue 20 Oct 00:44 GMT+7 (night, quiet until 09:00 GMT+7: hand requests wait for the morning batch)");
    expect(ownerTimeHeader(ownerQuietState(bangkok, at("2026-10-20T05:00:00Z")))).toBe("Operator's time: Tue 20 Oct 12:00 GMT+7 (day; quiet hours 23:00-09:00)");
    // A handoff asked at 00:44 lives until an hour after 09:00 (9h16m), by day 30 minutes.
    expect(handoffTtlSeconds(night, Date.parse("2026-10-19T17:44:00Z"))).toBe((8 * 60 + 16) * 60 + 3600);
    expect(handoffTtlSeconds(ownerQuietState(bangkok, at("2026-10-20T05:00:00Z")))).toBe(1800);
    expect(ownerHandsAnswer(night)).toEqual({ localTime: "Tue 20 Oct 00:44 GMT+7", quiet: true, heldUntil: "2026-10-20T02:00:00.000Z",
      note: "It is night for the operator (Tue 20 Oct 00:44 GMT+7): held until 09:00 GMT+7. Keep the work ready and continue other work." });
  });

  it("records hand requests at night without Telegram or push, lets URGENT and other notifications through, and sends ONE morning batch", async () => {
    let clock = "2026-10-19T17:44:00.000Z";
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const pushed: string[] = [];
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => bangkok, now: () => clock,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: clock }) as Event,
      push: { send: async (_token, data) => { pushed.push(data.notificationId!); return "SENT"; } } });
    await service.registerPushDevice("user:1", { token: `phone:${"d".repeat(40)}`, platform: "ANDROID", appVersion: null });
    const raise = (source: "BROWSER_HANDOFF" | "NOUS" | "JOB_COPILOT", kind: string, severity: "ATTENTION" | "URGENT", key: string, title: string) =>
      service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source, kind, severity, title, body: "", link: {}, dedupeKey: key, payload: {}, telegram: null });

    const captcha = await raise("BROWSER_HANDOFF", "BROWSER_HANDOFF_REQUESTED", "ATTENTION", "browser-handoff:pane:a", "Upwork: tick the box");
    const card = await raise("NOUS", "NEEDS_HANDS", "ATTENTION", "nous:pane:b", "Sign in to Fiverr");
    expect(captcha.payload.heldUntil).toBe("2026-10-20T02:00:00.000Z");
    expect(card.payload.heldUntil).toBe("2026-10-20T02:00:00.000Z");
    expect(repository.telegram).toEqual([]);
    expect(pushed).toEqual([]);
    // URGENT never waits; what is not a hand request (a copilot's review) is not held either.
    const urgent = await raise("BROWSER_HANDOFF", "BROWSER_HANDOFF_REQUESTED", "URGENT", "browser-handoff:pane:c", "Security check");
    const review = await raise("JOB_COPILOT", "REVIEW_REQUESTED", "ATTENTION", "job:review:1", "Review the application");
    expect([urgent.payload.heldUntil, review.payload.heldUntil]).toEqual([undefined, undefined]);
    await vi.waitFor(() => expect(pushed.sort()).toEqual([urgent.id, review.id].sort()));
    expect(repository.telegram).toHaveLength(2);
    expect(await service.morningBatch("user:1")).toBeNull(); // still night

    clock = "2026-10-20T02:01:00.000Z"; // 09:01
    const batch = await service.morningBatch("user:1");
    expect(batch).toMatchObject({ source: "NOUS", kind: "MORNING_BATCH", severity: "ATTENTION", title: "Good morning: 2 things wait for your hands",
      body: "- Nous: Sign in to Fiverr\n- Browser: Upwork: tick the box", dedupeKey: "quiet:morning:2026-10-20T02:00:00.000Z" });
    expect(repository.telegram).toHaveLength(3);
    expect(await service.morningBatch("user:1")).toBeNull(); // once per wake time
  });

});
