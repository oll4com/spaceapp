import { describe, expect, it, vi } from "vitest";
import type { RoomAgentEvent, RoomAgentSession } from "@space/contracts";
import { InMemorySpaceNotificationsRepository } from "@space/db";
import { createNotificationService } from "../src/notifications/service.js";
import { createPaneReports } from "../src/pane-reports.js";
import { createRoomAgentEventRouting, handsCountsIn, hasWaitingEvents, markSentToNous, roomsSentToNous, withoutNousRooms } from "../src/room-agent-event-routing.js";

const at = "2026-10-17T13:00:00.000Z";
const event = (patch: Partial<RoomAgentEvent> = {}): RoomAgentEvent => ({
  eventId: "room_agent_event:ev000001", roomId: "room:nous000001", paneId: "pane:nous000001", paneName: "Bob", kind: "WAITING", severity: "ATTENTION",
  title: "Bob is waiting", detail: "Approve the deploy?", status: "OPEN", decision: null, createdAt: at, updatedAt: at, ...patch
});

function setup(nous: { active: boolean; offRoom?: string }, stored: RoomAgentEvent[] = [], question: (event: RoomAgentEvent) => Promise<string | null> = async () => "Ship it?") {
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
    nousActive: async (_owner, roomId) => nous.active && roomId !== nous.offRoom,
    notifications: { raise, resolve, list }, telegram: { enqueueTelegramNotice }, log: { warn: vi.fn() }, question,
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

  it("on, but the room keeps Nous out (DEV3D-007): its question reaches the operator at once, never held for Nous", async () => {
    const { routing, raise } = setup({ active: true, offRoom: "room:off000001" });
    await routing.route(event({ roomId: "room:off000001", kind: "QUESTION", title: "Bob has a question for you", createdAt: minutesAgo(1) }));
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(await routing.sentToNous("room:off000001")).toBe(false);
    expect(await routing.sentToNous("room:nous000001")).toBe(true);
  });

  it("on: a CLI's question goes to Nous first and reaches the operator only after 10 minutes unanswered (goal ee5a573e)", async () => {
    const question = event({ kind: "QUESTION", title: "Bob has a question for you", status: "ESCALATED", decision: "Needs you: Answer its question in the pane.", createdAt: minutesAgo(1) });
    const stored = [question];
    const { routing, raise, enqueueTelegramNotice, updateEvent } = setup({ active: true }, stored, async () => "Ship it?\n1. Yes (Recommended) — Now.\n2. No — Later.");
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
    // Operator 21/11 18:06 BKK: the card carries the question and its options, to be answered from the phone.
    expect(raise.mock.calls[0]![0]).toMatchObject({ body: expect.stringMatching(/in the pane\.\n\nShip it\?\n1\. Yes \(Recommended\) — Now\.\n2\. No — Later\.$/) });
    expect(enqueueTelegramNotice).toHaveBeenCalledTimes(1);
    expect(hasWaitingEvents({ messages: [meta(stored[0]!.createdAt)] } as unknown as RoomAgentSession)).toBe(false);
    expect(await handsCountsIn(new Set(["room:nous000001"]), async () => stored)).toEqual({ "room:nous000001": 1 });
    expect(withoutNousRooms({ "room:nous000001": 1 }, stored, new Set(["room:nous000001"]))).toMatchObject({ latest: [stored[0]] });
  });

  it("off: a CLI's question reaches the operator at once, and the sweep after the hold does not raise it again", async () => {
    const question = event({ kind: "QUESTION", title: "Bob has a question for you", createdAt: minutesAgo(1) });
    const stored = [question];
    const { routing, raise } = setup({ active: false }, stored, async () => "Ship it?");
    await routing.route(question);
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
    stored[0] = { ...question, createdAt: minutesAgo(11) };
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it("never raises a question card without the question; one whose question is gone closes with its card (operator 21/11 22:32)", async () => {
    const stored = [event({ kind: "QUESTION", title: "Emma has a question for you", createdAt: minutesAgo(11) })];
    const screen: { text: string | null | Error } = { text: null };
    const { routing, raise, resolve, enqueueTelegramNotice, updateEvent } = setup({ active: false }, stored,
      async () => { if (screen.text instanceof Error) throw screen.text; return screen.text; });
    // (a) No question on the pane (a browser pane, closed, answered): no card at once nor after the hold; the event closes.
    await routing.route(stored[0]!);
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(raise).not.toHaveBeenCalled();
    expect(enqueueTelegramNotice).not.toHaveBeenCalled();
    expect(stored[0]).toMatchObject({ status: "RESOLVED", decision: expect.stringContaining("no question") });

    // An unreadable screen is not an answer: nothing raised, nothing closed, the next sweep looks again.
    stored[0] = event({ kind: "QUESTION", eventId: "room_agent_event:ev000002", createdAt: minutesAgo(11) });
    screen.text = new Error("pane host restarting");
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(stored[0]).toMatchObject({ status: "OPEN" });
    expect(raise).not.toHaveBeenCalled();

    // (b) The question is on screen: one card carrying it.
    screen.text = "Ship it?\n1. Yes\n2. No";
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise.mock.calls[0]![0]).toMatchObject({ kind: "QUESTION", body: expect.stringMatching(/\n\nShip it\?\n1\. Yes\n2\. No$/) });

    // (c) The question is gone after the card: the event closes and its card is resolved.
    screen.text = "   ";
    await routing.sweep(["room:nous000001"]);
    await settle();
    expect(stored[0]).toMatchObject({ status: "RESOLVED" });
    expect(resolve).toHaveBeenCalledWith("user:operator", "room-agent-event:room_agent_event:ev000002");
    expect(raise).toHaveBeenCalledTimes(1);
    expect(updateEvent).toHaveBeenCalledTimes(3);
  });

  describe("no question card without the question (operator 21/11 nous_msg:69c1d2ce673f4bf0b36d7899)", () => {
    // The real lookup app.ts wires (paneReports.questionText): a TERMINAL pane's screen, else nothing.
    const lookup = (pane: { mode: string; isClosed?: boolean }, screen: string) => {
      const reports = createPaneReports({ repository: {} as never, lastAnswer: async () => null, screen: async () => screen,
        store: { getRoom: async (id: string) => ({ id }), getPane: async (id: string) => ({ id, roomId: "room:nous000001", isClosed: false, ...pane }), getArtifact: async () => null } as never });
      return (event: RoomAgentEvent) => reports.questionText(event);
    };
    const asking = "Bob\nDeploy to dev now?\n❯ 1. Yes (Recommended)\n  2. No\n";

    it("sweep: a null question lookup (no pane, no question) closes the event with no card nor Telegram notice; a failing lookup leaves it for the next sweep", async () => {
      const stored = [event({ kind: "QUESTION", title: "Bob has a question for you", createdAt: minutesAgo(11) }),
        event({ eventId: "room_agent_event:nopane01", paneId: null, kind: "QUESTION", title: "A pane has a question for you", createdAt: minutesAgo(11) })];
      let fail = true;
      const { routing, raise, enqueueTelegramNotice, updateEvent } = setup({ active: true }, stored, async () => {
        if (fail) throw new Error("inspect failed");
        return null;
      });
      await routing.sweep(["room:nous000001"]);
      await settle();
      expect(updateEvent).not.toHaveBeenCalled();
      fail = false;
      await routing.sweep(["room:nous000001"]);
      await settle();
      expect(stored.map((item) => item.status)).toEqual(["RESOLVED", "RESOLVED"]);
      expect(raise).not.toHaveBeenCalled();
      expect(enqueueTelegramNotice).not.toHaveBeenCalled();
    });

    it("a browser pane: no screen question, so no card and no Telegram notice, at once or after the hold", async () => {
      const browser = event({ kind: "QUESTION", title: "Docs has a question for you", status: "ESCALATED", decision: "Needs you", createdAt: minutesAgo(11) });
      const stored = [browser];
      const { routing, raise, enqueueTelegramNotice, updateEvent } = setup({ active: false }, stored, lookup({ mode: "BROWSER" }, asking));
      await routing.route(browser);
      await settle();
      expect(updateEvent).not.toHaveBeenCalled();
      await routing.sweep(["room:nous000001"]);
      await settle();
      expect(raise).not.toHaveBeenCalled();
      expect(enqueueTelegramNotice).not.toHaveBeenCalled();
      expect(stored[0]).toMatchObject({ status: "RESOLVED" });
    });

    it("a completed turn: the screen asks nothing any more, so no card; the same pane asking raises one carrying the question", async () => {
      const done = event({ kind: "QUESTION", title: "Bob has a question for you", status: "ESCALATED", decision: "Needs you", createdAt: minutesAgo(11) });
      const finished = setup({ active: false }, [done], lookup({ mode: "TERMINAL" }, "Bob\nDeployed to dev. Tests pass.\n> \n"));
      await finished.routing.route(done);
      await finished.routing.sweep(["room:nous000001"]);
      await settle();
      expect(finished.raise).not.toHaveBeenCalled();
      expect(finished.enqueueTelegramNotice).not.toHaveBeenCalled();
      expect(finished.updateEvent).toHaveBeenCalledWith(done.eventId, expect.objectContaining({ status: "RESOLVED" }), ["OPEN", "ESCALATED"]);
      // A closed pane is no question either.
      const closed = setup({ active: false }, [done], lookup({ mode: "TERMINAL", isClosed: true }, asking));
      await closed.routing.route(done);
      await settle();
      expect(closed.raise).not.toHaveBeenCalled();

      const open = setup({ active: false }, [done], lookup({ mode: "TERMINAL" }, asking));
      await open.routing.route(done);
      await settle();
      expect(open.raise).toHaveBeenCalledTimes(1);
      expect(open.raise.mock.calls[0]![0]).toMatchObject({ body: "Needs you\n\nDeploy to dev now?\n1. Yes (Recommended)\n2. No" });
      expect(open.enqueueTelegramNotice).toHaveBeenCalledTimes(1);
    });
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
