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

function setup(nous: { active: boolean }) {
  const raise = vi.fn(async () => ({}) as never);
  const resolve = vi.fn(async () => true as never);
  const enqueueTelegramNotice = vi.fn(async () => undefined);
  const routing = createRoomAgentEventRouting({
    roomOwner: async () => "user:operator",
    // false also when the Nous job does not run on this instance or its model is paused: Nous's own active() covers both.
    nousActive: async () => nous.active,
    notifications: { raise, resolve }, telegram: { enqueueTelegramNotice }, log: { warn: vi.fn() }
  });
  return { routing, raise, resolve, enqueueTelegramNotice };
}
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

  it("on: a CLI's question for the operator (kind QUESTION) still reaches them at once, like a sign-in (operator decision 2026-10-24)", async () => {
    const { routing, raise } = setup({ active: true });
    await routing.route(event({ kind: "QUESTION", title: "Bob has a question for you" }));
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0]).toMatchObject({ source: "ROOM_AGENT", kind: "QUESTION", severity: "ATTENTION", paneId: "pane:nous000001" });
    expect(hasWaitingEvents({ messages: [{ kind: "SYSTEM", meta: { type: "MONITOR_EVENT", status: "OPEN", eventKind: "QUESTION" } }] } as unknown as RoomAgentSession)).toBe(false);
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
