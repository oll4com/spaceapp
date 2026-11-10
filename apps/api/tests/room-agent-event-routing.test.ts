import { describe, expect, it, vi } from "vitest";
import type { RoomAgentEvent, RoomAgentSession } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { createNotificationService } from "../src/notifications/service.js";
import { createRoomAgentEventRouting, handsCountsIn, hasWaitingEvents, markSentToNous, roomsSentToNous, withoutNousRooms } from "../src/room-agent-event-routing.js";

const at = "2026-10-17T13:00:00.000Z";
const event = (patch: Partial<RoomAgentEvent> = {}): RoomAgentEvent => ({
  eventId: "room_agent_event:ev000001", roomId: "room:nous000001", paneId: "pane:nous000001", paneName: "Bob", kind: "WAITING", severity: "ATTENTION",
  title: "Bob is waiting", detail: "Approve the deploy?", status: "OPEN", decision: null, createdAt: at, updatedAt: at, ...patch
});

function setup(nous: { active: boolean }, stored: RoomAgentEvent[] = []) {
  const raise = vi.fn<(input: { dedupeKey?: string | null }) => Promise<never>>(async () => ({}) as never);
  const resolve = vi.fn(async () => true as never);
  // Every raise is a record, whatever the operator did with it since (the sweep's "raised already").
  const list = vi.fn(async (_owner: string, query: { dedupeKey?: string }) => raise.mock.calls.filter(([input]) => input.dedupeKey === query.dedupeKey) as never);
  const enqueueTelegramNotice = vi.fn(async () => undefined);
  const updateEvent = vi.fn(async (eventId: string, patch: Partial<RoomAgentEvent>) => {
    const index = stored.findIndex((item) => item.eventId === eventId);
    return index < 0 ? null : (stored[index] = { ...stored[index]!, ...patch });
  });
  const routing = createRoomAgentEventRouting({
    roomOwner: async () => "user:operator",
    // false also when the Nous job does not run on this instance or its model is paused: Nous's own active() covers both.
    nousActive: async () => nous.active,
    notifications: { raise, resolve, list }, telegram: { enqueueTelegramNotice }, log: { warn: vi.fn() },
    events: { listEvents: async () => stored.filter((item) => item.status === "OPEN" || item.status === "ESCALATED"), updateEvent: updateEvent as never }
  });
  return { routing, raise, resolve, enqueueTelegramNotice, updateEvent };
}
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const settle = () => new Promise((done) => setTimeout(done, 0));

describe("Room Agent monitor events while Nous works on the owner's behalf (plan clipboard:xEQOrVRQgeAn)", () => {
  it("off, or the Nous job not running: notifications and Telegram exactly as before", async () => {
    const { routing, raise, enqueueTelegramNotice } = setup({ active: false });
    await routing.route(event());
    await routing.route(event({ eventId: "room_agent_event:ev000002", status: "ESCALATED", decision: "Needs you" }));
    await settle();
    expect(raise).toHaveBeenCalledTimes(2);
    expect(raise.mock.calls[0]![0]).toMatchObject({ source: "ROOM_AGENT", severity: "ATTENTION", dedupeKey: "room-agent-event:room_agent_event:ev000001" });
    expect(enqueueTelegramNotice).toHaveBeenCalledTimes(1);
    expect(await routing.sentToNous("room:nous000001")).toBe(false);
  });

  it("on: a CLI's question goes to Nous first and reaches the operator only after 10 minutes unanswered (goal ee5a573e)", async () => {
    const question = event({ kind: "QUESTION", title: "Bob has a question for you", status: "ESCALATED", decision: "Needs you: Answer its question in the pane.", createdAt: minutesAgo(1) });
    const stored = [question];
    const { routing, raise, enqueueTelegramNotice, updateEvent } = setup({ active: true }, stored);
    await routing.route(question);
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(raise).not.toHaveBeenCalled();
    expect(enqueueTelegramNotice).not.toHaveBeenCalled();
    const meta = (createdAt: string) => ({ kind: "SYSTEM", createdAt, meta: { type: "MONITOR_EVENT", status: "ESCALATED", severity: "ATTENTION", eventKind: "QUESTION" } });
    expect(hasWaitingEvents({ messages: [meta(question.createdAt)] } as unknown as RoomAgentSession)).toBe(true);
    expect(await handsCountsIn(new Set(["room:nous000001"]), async () => stored)).toEqual({ "room:nous000001": 0 });

    // Still waiting after the hold: one card and one Telegram notice saying Nous did not answer it; later sweeps add nothing.
    stored[0] = { ...question, createdAt: minutesAgo(11) };
    await routing.sweep(["room:nous000001"]);
    await settle();
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(updateEvent).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0]).toMatchObject({ source: "ROOM_AGENT", kind: "QUESTION", severity: "ATTENTION", paneId: "pane:nous000001",
      dedupeKey: "room-agent-event:room_agent_event:ev000001", body: expect.stringContaining("Nous did not answer it within 10 minutes") });
    expect(enqueueTelegramNotice).toHaveBeenCalledTimes(1);
    expect(hasWaitingEvents({ messages: [meta(stored[0]!.createdAt)] } as unknown as RoomAgentSession)).toBe(false);
    expect(await handsCountsIn(new Set(["room:nous000001"]), async () => stored)).toEqual({ "room:nous000001": 1 });
    expect(withoutNousRooms({ "room:nous000001": 1 }, stored, new Set(["room:nous000001"]))).toMatchObject({ latest: [stored[0]] });
  });

  it("off: a CLI's question reaches the operator at once, and the sweep after the hold does not raise it again", async () => {
    const question = event({ kind: "QUESTION", title: "Bob has a question for you", createdAt: minutesAgo(1) });
    const stored = [question];
    const { routing, raise } = setup({ active: false }, stored);
    await routing.route(question);
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
    stored[0] = { ...question, createdAt: minutesAgo(11) };
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it("on: every event is Nous's alone, no notification row and no Telegram, the feed marks it sent to Nous", async () => {
    const { routing, raise, enqueueTelegramNotice } = setup({ active: true });
    for (const kind of ["FINISHED", "WAITING", "OVERLAP", "STUCK"] as const) await routing.route(event({ kind, eventId: `room_agent_event:${kind}0001` }));
    await routing.route(event({ eventId: "room_agent_event:esc000001", status: "ESCALATED" }));
    await settle();
    expect(raise).not.toHaveBeenCalled();
    expect(enqueueTelegramNotice).not.toHaveBeenCalled();
    expect(await routing.sentToNous("room:nous000001")).toBe(true);
  });

  it("still resolves notifications of events that end, and turning Nous off brings waiting events back", async () => {
    const nous = { active: true };
    const { routing, resolve } = setup(nous);
    await routing.route(event({ status: "RESOLVED" }));
    await settle();
    expect(resolve).toHaveBeenCalledWith("user:operator", "room-agent-event:room_agent_event:ev000001");

    const session = { roomId: "room:nous000001", messages: [
      { id: "m1", role: "system", kind: "SYSTEM", content: "Bob is waiting", status: "COMPLETED", createdAt: at, meta: { type: "MONITOR_EVENT", status: "OPEN", severity: "ATTENTION" } },
      { id: "m2", role: "system", kind: "SYSTEM", content: "Done", status: "COMPLETED", createdAt: at, meta: { type: "MONITOR_EVENT", status: "HANDLED", severity: "ATTENTION" } },
      { id: "m3", role: "assistant", kind: "ANSWER", content: "Hi", status: "COMPLETED", createdAt: at }
    ] } as unknown as RoomAgentSession;
    expect(hasWaitingEvents(session)).toBe(true);
    expect(markSentToNous(session).messages.map((message) => message.meta?.sentToNous ?? null)).toEqual([true, null, null]);

    const pending = { "room:nous000001": 2, "room:other00001": 1 };
    const latest = [event(), event({ eventId: "room_agent_event:other0001", roomId: "room:other00001" })];
    const owned = (roomId: string) => routing.sentToNous(roomId).then((sent) => sent && roomId === "room:nous000001");
    expect(withoutNousRooms(pending, latest, await roomsSentToNous(Object.keys(pending), owned))).toEqual({ counts: { "room:other00001": 1 }, latest: [latest[1]] });
    // Switched off: the same waiting events count again (nothing was changed in the monitor's store).
    nous.active = false;
    expect(withoutNousRooms(pending, latest, await roomsSentToNous(Object.keys(pending), owned))).toEqual({ counts: pending, latest });
    expect(await roomsSentToNous(["room:nous000001"], undefined)).toEqual(new Set());
  });

  it("never holds back what only the operator's hands can do: a sign-in, a CAPTCHA or handoff, a copilot's NEEDS_USER", async () => {
    const { routing, raise, enqueueTelegramNotice } = setup({ active: true });
    await routing.route(event({ kind: "SIGN_IN", status: "ESCALATED", eventId: "room_agent_event:sign0001" }));
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(enqueueTelegramNotice).toHaveBeenCalledTimes(1);

    const meta = (kind: string) => ({ type: "MONITOR_EVENT", status: "OPEN", severity: "ATTENTION", eventKind: kind });
    const session = { roomId: "room:nous000001", messages: [
      { id: "m1", role: "system", kind: "SYSTEM", content: "Sign in", status: "COMPLETED", createdAt: at, meta: meta("SIGN_IN") },
      { id: "m2", role: "system", kind: "SYSTEM", content: "Waiting", status: "COMPLETED", createdAt: at, meta: meta("WAITING") }
    ] } as unknown as RoomAgentSession;
    expect(markSentToNous(session).messages.map((message) => message.meta?.sentToNous ?? null)).toEqual([null, true]);
    const signIn = event({ kind: "SIGN_IN", eventId: "room_agent_event:sign0002" });
    const hands = await handsCountsIn(new Set(["room:nous000001"]), async () => [signIn, event(), event({ kind: "SIGN_IN", severity: "INFO" })]);
    expect(withoutNousRooms({ "room:nous000001": 3 }, [event(), signIn], new Set(["room:nous000001"]), hands)).toEqual({ counts: { "room:nous000001": 1 }, latest: [signIn] });

    // Notifications of other sources: Telegram still goes out for hands-only kinds while Nous holds the rest.
    const repository = new InMemorySpaceNotificationsRepository();
    const enqueue = vi.spyOn(repository, "enqueueTelegram");
    const service = createNotificationService({ repository, eventBus: { publish: () => {} }, userSettings: async () => ({ notifications: null }) as never,
      recordRoomEvent: async (input) => ({ ...input, id: "event:1", createdAt: at, workflowId: null }) as never, nous: { held: async () => true, raised: () => {} } });
    const base = { ownerUserId: "user:operator", roomId: null, paneId: null, title: "Fiverr Gig 1", body: "", link: {}, payload: {}, telegram: true, severity: "ATTENTION" as const };
    await service.raise({ ...base, source: "FREELANCE_COPILOT", kind: "QUESTION", dedupeKey: "q" });
    expect(enqueue).not.toHaveBeenCalled();
    await service.raise({ ...base, source: "FREELANCE_COPILOT", kind: "NEEDS_USER", dedupeKey: "n" });
    await service.raise({ ...base, source: "JOB_COPILOT", kind: "CAPTCHA", dedupeKey: "c" });
    await service.raise({ ...base, source: "BROWSER_HANDOFF", kind: "REQUESTED", dedupeKey: "h" });
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
});
