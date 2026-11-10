import { afterEach, describe, expect, it, vi } from "vitest";
import { eventSchema, type Event } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { SpaceEventBus, makeSpaceId } from "@space/runtime";
import { createNotificationService } from "../src/notifications/service.js";
import { handoffTtlSeconds, isOwnerQuietTime, nextOwnerWakeTime, noteOperatorActive, ownerHandsAnswer, ownerQuietState, ownerTimeHeader, setOperatorActivityReader } from "../src/owner-clock.js";

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
    expect(ownerTimeHeader(night)).toBe("Operator's time: Tue 20 Oct 00:44 GMT+7 (night, quiet until 09:00 GMT+7: every alert but an urgent one waits for the morning batch; prepare decisions, ask none unless urgent)");
    expect(ownerTimeHeader(ownerQuietState(bangkok, at("2026-10-20T05:00:00Z")))).toBe("Operator's time: Tue 20 Oct 12:00 GMT+7 (day; quiet hours 23:00-09:00)");
    // A handoff asked at 00:44 lives until an hour after 09:00 (9h16m), by day 30 minutes.
    expect(handoffTtlSeconds(night, Date.parse("2026-10-19T17:44:00Z"))).toBe((8 * 60 + 16) * 60 + 3600);
    expect(handoffTtlSeconds(ownerQuietState(bangkok, at("2026-10-20T05:00:00Z")))).toBe(1800);
    expect(ownerHandsAnswer(night)).toEqual({ localTime: "Tue 20 Oct 00:44 GMT+7", quiet: true, heldUntil: "2026-10-20T02:00:00.000Z",
      note: "It is night for the operator (Tue 20 Oct 00:44 GMT+7): held until 09:00 GMT+7. Keep the work ready and continue other work." });
  });

  it("holds every non-URGENT notification at night without Telegram or push, lets only a person's URGENT through, and sends ONE morning batch", async () => {
    // Operator 31/10 09:50 BKK: 30 alerts in one night (decisions, reviews, Design questions, a P0 the Security Copilot fixed itself).
    let clock = "2026-10-19T17:44:00.000Z";
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const pushed: string[] = [];
    const direct: string[] = [];
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => bangkok, now: () => clock,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: clock }) as Event,
      push: { send: async (_token, data) => { pushed.push(data.notificationId!); return "SENT"; } } });
    await service.registerPushDevice("user:1", { token: `phone:${"d".repeat(40)}`, platform: "ANDROID", appVersion: null });
    const raise = (source: "BROWSER_HANDOFF" | "NOUS" | "MARKETING_COPILOT" | "DESIGN" | "SECURITY_COPILOT" | "SYSTEM", kind: string, severity: "INFO" | "ATTENTION" | "URGENT",
      key: string, title: string, payload: Record<string, unknown> = {}) =>
      service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source, kind, severity, title, body: "", link: {}, dedupeKey: key, payload, telegram: true },
        { telegramSend: async (text) => { direct.push(text); return true; } });

    const night = [
      await raise("BROWSER_HANDOFF", "BROWSER_HANDOFF_REQUESTED", "ATTENTION", "browser-handoff:pane:a", "Upwork: tick the box"),
      await raise("NOUS", "DECISION_EXTERNAL", "ATTENTION", "nous:decision:1", "Nous: Send the offer?"),
      await raise("MARKETING_COPILOT", "REVIEW_REQUESTED", "ATTENTION", "marketing:review:1", "Review the post"),
      await raise("DESIGN", "DESIGN_QUESTION", "ATTENTION", "design:question:1", "Which colour?"),
      await raise("SYSTEM", "GATEWAY_DOWN", "INFO", "gateway:down", "Gateway back"),
      await raise("SECURITY_COPILOT", "SECURITY_EXPLOITED", "URGENT", "security:finding:1", "P0 CVE-1 on host-a", { selfFixing: true })
    ];
    expect(night.map((item) => item.payload.heldUntil)).toEqual(Array(6).fill("2026-10-20T02:00:00.000Z"));
    expect(night[5]!.severity).toBe("ATTENTION"); // the copilot fixes it on its own: no person's job at night
    expect([repository.telegram, direct]).toEqual([[], []]);
    // A fix that failed needs a person now: it goes at once, by Telegram and push.
    const failed = await raise("SECURITY_COPILOT", "SECURITY_ACTION_FAILED", "URGENT", "security:action:1", "Security fix failed on host-a");
    expect([failed.severity, failed.payload.heldUntil]).toEqual(["URGENT", undefined]);
    await vi.waitFor(() => expect(pushed).toEqual([failed.id]));
    expect(direct).toHaveLength(1);
    // A phone paired at night alerts at once too, and the morning names it again (Nous Pro 1b).
    expect((await raise("SYSTEM", "MOBILE_PAIRED", "URGENT", "mobile:paired:appdev:x", "New device paired: Pixel")).payload.heldUntil).toBeUndefined();
    expect(await service.morningBatch("user:1")).toBeNull(); // still night

    clock = "2026-10-20T02:01:00.000Z"; // 09:01
    await service.setStatus("user:1", night[4]!.id, "READ"); // read overnight in the dock: not in the batch
    const batch = await service.morningBatch("user:1");
    expect(batch).toMatchObject({ source: "NOUS", kind: "MORNING_BATCH", severity: "ATTENTION", dedupeKey: "quiet:morning:2026-10-20T02:00:00.000Z",
      title: "Good morning: 5 held overnight (1 decision, 1 review, 1 question, 1 hands, 1 other, 1 phone paired)" });
    expect(batch!.body).toContain("- Security Copilot: P0 CVE-1 on host-a");
    expect(batch!.body).toContain("New device paired: Pixel");
    expect([direct.length, repository.telegram.length]).toEqual([2, 1]); // the batch alone, in the morning
    expect(await service.morningBatch("user:1")).toBeNull(); // once per wake time
  });

  it("pauses quiet hours while the operator is active: 30 minutes after their last message, day unaffected", async () => {
    // Operator 1/11 23:08 BKK: «όσο είμαι εδώ και σου μιλάω δεν θα μπαίνεις σε quiet mode -- μόνο όταν σταματήσω για πάνω από 30 λεπτά».
    const now = at("2026-10-19T17:44:00Z"); // 00:44 Bangkok
    const active = ownerQuietState(bangkok, now, "2026-10-19T17:34:00Z"); // wrote 10 minutes ago
    expect(active).toMatchObject({ quiet: false, night: true, wakeAt: null, activeUntil: "2026-10-19T18:04:00.000Z", activeLocal: "00:34 GMT+7", activeUntilLocal: "01:04 GMT+7" });
    expect(ownerTimeHeader(active)).toContain("night, but the operator is active (last message 00:34 GMT+7): quiet hours paused until 01:04 GMT+7");
    expect(handoffTtlSeconds(active, now.getTime())).toBe(1800);
    expect(ownerQuietState(bangkok, now, "2026-10-19T17:13:00Z")).toMatchObject({ quiet: true, night: true, activeUntil: null }); // 31 minutes ago
    expect(ownerQuietState(bangkok, at("2026-10-20T05:00:00Z"), "2026-10-20T04:55:00Z")).toMatchObject({ quiet: false, night: false, activeUntil: null }); // day

    // The notifications: held while away; the operator's message releases them and the next one goes at once.
    let clock = "2026-10-19T17:44:00.000Z";
    setOperatorActivityReader(async () => null);
    const repository = new InMemorySpaceNotificationsRepository(undefined, true);
    const service = createNotificationService({ repository, eventBus: new SpaceEventBus(), userSettings: async () => bangkok, now: () => clock,
      recordRoomEvent: async (input) => eventSchema.parse({ ...input, id: makeSpaceId("event"), workflowId: null, createdAt: clock }) as Event });
    const raise = (key: string) => service.raise({ ownerUserId: "user:1", roomId: null, paneId: null, source: "NOUS", kind: "DECISION_EXTERNAL", severity: "ATTENTION",
      title: key, body: "", link: {}, dedupeKey: key, payload: {}, telegram: true });
    const held = await raise("nous:decision:1");
    expect(held.payload.heldUntil).toBe("2026-10-20T02:00:00.000Z");
    noteOperatorActive("user:1", clock);
    expect(await service.releaseQuietHeld("user:1")).toBe(1);
    expect((await service.get("user:1", held.id))?.payload).toMatchObject({ heldUntil: null, alertAt: clock });
    expect((await raise("nous:decision:2")).payload.heldUntil).toBeUndefined();
    expect(repository.telegram).toHaveLength(1);
    clock = "2026-10-19T18:15:00.000Z"; // 31 minutes later: quiet again
    expect((await raise("nous:decision:3")).payload.heldUntil).toBe("2026-10-20T02:00:00.000Z");
    expect(await service.quiet("user:1")).toBe(true);
    setOperatorActivityReader(null);
  });
});
