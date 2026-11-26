import { needsOperatorHands, type RoomAgentEvent, type RoomAgentSession } from "@space/contracts";
import type { RoomAgentMonitorRepository } from "@space/db";
import type { NotificationService } from "./notifications/service.js";

/**
 * Where a Room Agent monitor event goes besides the room's feed (plan clipboard:xEQOrVRQgeAn). While the room owner's Nous
 * works on their behalf (its job runs on this instance, "Work on my behalf" is on, its model is not paused), every event is
 * Nous's alone: no Telegram notice, no notification, and the feed shows it as sent to Nous instead of new. Otherwise
 * events that need the operator raise an ATTENTION notification (badges, toast, desktop) and ESCALATED ones a Telegram notice.
 */
/** How long a CLI's "Question for you" waits for Nous before it is the operator's (goal ee5a573e, plan clipboard:6HB4dTuxRUyr). */
export const ROOM_QUESTION_HOLD_MS = 10 * 60_000;
const NOUS_LATE = "Needs you: Nous did not answer it within 10 minutes. Answer its question in the pane.";
const NO_QUESTION = "The pane shows no question any more (answered, closed, or no longer a CLI).";
/**
 * What reaches the operator whatever Nous does: a sign-in only they can do, and a CLI's question Nous left unanswered for 10 minutes
 * (the 24/10 rule sent every question to the operator at once; the operator's goal of 27/10 has Nous look first).
 */
const forOperator = (kind: string, createdAt?: string | null, now = Date.now()) => needsOperatorHands("ROOM_AGENT", kind)
  || (kind === "QUESTION" && now - Date.parse(createdAt ?? "") >= ROOM_QUESTION_HOLD_MS);

export function createRoomAgentEventRouting(deps: {
  roomOwner(roomId: string): Promise<string | null>;
  /** DEV3D-007: false for a room the operator keeps Nous out of, so its events reach them at once. */
  nousActive(owner: string, roomId: string): Promise<boolean>;
  notifications: Pick<NotificationService, "raise" | "resolve" | "list"> & Partial<Pick<NotificationService, "quiet">>;
  telegram: { enqueueTelegramNotice(event: RoomAgentEvent): Promise<unknown> };
  events: Pick<RoomAgentMonitorRepository, "listEvents" | "updateEvent">;
  /** A waiting pane's question and its options as its screen shows them (operator 21/11: the card must carry the question to answer it from the phone); null when it shows none, throws when unreadable. */
  question(event: RoomAgentEvent): Promise<string | null>;
  log: { warn(details: Record<string, unknown>, message: string): void };
}) {
  const toNous = async (owner: string | null, roomId: string) => Boolean(owner && await deps.nousActive(owner, roomId).catch(() => false));
  const dedupeKeyOf = (event: RoomAgentEvent) => `room-agent-event:${event.eventId}`;
  const raising = (event: RoomAgentEvent, nous: boolean) => !nous && event.severity === "ATTENTION" && (event.status === "OPEN" || event.status === "ESCALATED");
  /** The pane's question as its screen shows it; null for a browser pane, a closed pane, a turn that ended or an unreadable screen (nothing to answer). */
  const questionOf = async (event: RoomAgentEvent) => (await deps.question(event).catch(() => null))?.trim() || null;
  async function deliver(event: RoomAgentEvent, owner: string | null, nous: boolean, asked?: string | null) {
    if (raising(event, nous) && event.kind === "QUESTION") {
      asked = asked === undefined ? await questionOf(event) : asked;
      // Operator 21/11 (nous_msg:69c1d2ce): no question card, nor its Telegram notice, without the question to answer.
      if (!asked) return deps.log.warn({ eventId: event.eventId, paneId: event.paneId }, "Room Agent question not raised: the pane shows no question.");
    }
    // What needs the operator also goes to Telegram when the integration is on (one message per event).
    // The owner's night (operator 31/10): no Telegram notice; the notification below waits for the morning batch.
    if (event.status === "ESCALATED" && !nous && !(owner && await deps.notifications.quiet?.(owner).catch(() => false))) {
      await deps.telegram.enqueueTelegramNotice(event).catch((error) => deps.log.warn({ err: error, eventId: event.eventId }, "Room Agent Telegram notice failed."));
    }
    if (!owner) return;
    const dedupeKey = dedupeKeyOf(event);
    void (async () => {
      if (event.severity === "ATTENTION" && (event.status === "OPEN" || event.status === "ESCALATED")) {
        if (nous) return;
        await deps.notifications.raise({ ownerUserId: owner, roomId: event.roomId, paneId: event.paneId, source: "ROOM_AGENT", kind: event.kind, severity: "ATTENTION",
          title: event.title, body: [event.decision ?? event.detail, asked].filter(Boolean).join("\n\n"), link: { roomId: event.roomId, surface: "room-agent", ...(event.paneId ? { paneId: event.paneId } : {}) },
          dedupeKey, payload: { eventId: event.eventId, status: event.status }, telegram: false });
      } else if (event.status !== "OPEN") {
        await deps.notifications.resolve(owner, dedupeKey);
      }
    })().catch((error: unknown) => deps.log.warn({ err: error, eventId: event.eventId }, "Room Agent notification failed."));
  }
  return {
    /** Whether the owner's Nous takes this room's monitor events right now; when it stops they surface again. */
    sentToNous: async (roomId: string) => toNous(await deps.roomOwner(roomId), roomId),
    async route(event: RoomAgentEvent): Promise<void> {
      const owner = await deps.roomOwner(event.roomId);
      // A sign-in only the operator can do still reaches them at once, Nous or not.
      await deliver(event, owner, !forOperator(event.kind, event.createdAt) && await toNous(owner, event.roomId));
    },
    /** The monitor's 30 s attention sweep: a question still waiting after its hold reaches the operator once, Nous on or off since. */
    async sweep(roomIds: string[]): Promise<void> {
      for (const roomId of roomIds) {
        for (const event of await deps.events.listEvents(roomId, { statuses: ["OPEN", "ESCALATED"] })) {
          if (event.severity !== "ATTENTION" || event.kind !== "QUESTION" || !forOperator(event.kind, event.createdAt)) continue;
          const owner = await deps.roomOwner(roomId);
          if (!owner) continue;
          // A failed read is not an answer: the event waits for the next sweep.
          const asked = await deps.question(event).catch(() => undefined);
          if (asked === undefined) continue;
          // The pane shows no question any more (answered, closed, turned into a browser pane: the monitor skips those): close the event and its card.
          if (!asked?.trim()) {
            const gone = await deps.events.updateEvent(event.eventId, { status: "RESOLVED", decision: NO_QUESTION }, ["OPEN", "ESCALATED"]);
            if (gone) await deliver(gone, owner, false);
            continue;
          }
          // Raised already (at once while Nous was off, or by an earlier sweep), whatever the operator did with it since.
          if ((await deps.notifications.list(owner, { status: "ALL", dedupeKey: dedupeKeyOf(event), limit: 1 })).length) continue;
          const late = await deps.events.updateEvent(event.eventId, { status: "ESCALATED", decision: NOUS_LATE }, ["OPEN", "ESCALATED"]);
          if (late) await deliver(late, owner, false, asked);
        }
      }
    }
  };
}
export type RoomAgentEventRouting = ReturnType<typeof createRoomAgentEventRouting>;

// Events still waiting are Nous's while it works on the owner's behalf: the feed shows them sent to Nous, not new.
type FeedMessage = RoomAgentSession["messages"][number];
const waiting = ({ meta, createdAt }: FeedMessage) => meta?.type === "MONITOR_EVENT" && (meta.status === "OPEN" || meta.status === "ESCALATED")
  && !forOperator(String(meta.eventKind ?? ""), createdAt);
export const hasWaitingEvents = (session: RoomAgentSession) => session.messages.some(waiting);
export function markSentToNous(session: RoomAgentSession): RoomAgentSession {
  return { ...session, messages: session.messages.map((message) => waiting(message) ? { ...message, meta: { ...message.meta, sentToNous: true } } : message) };
}

export async function roomsSentToNous(roomIds: string[], sentToNous: ((roomId: string) => Promise<boolean>) | undefined): Promise<Set<string>> {
  if (!sentToNous) return new Set();
  return new Set((await Promise.all(roomIds.map(async (roomId) => (await sentToNous(roomId)) ? roomId : null))).filter((roomId): roomId is string => roomId !== null));
}

/** In rooms whose owner's Nous takes the events only what needs the operator (a sign-in, a question past its hold) still counts and is announced. */
export function withoutNousRooms(counts: Record<string, number>, latest: RoomAgentEvent[], toNous: Set<string>, handsCounts: Record<string, number> = {}) {
  return {
    counts: Object.fromEntries(Object.entries(counts).map(([roomId, count]): [string, number] => [roomId, toNous.has(roomId) ? handsCounts[roomId] ?? 0 : count]).filter(([, count]) => count > 0)),
    latest: latest.filter((event) => !toNous.has(event.roomId) || forOperator(event.kind, event.createdAt))
  };
}

/** Waiting attention events that need the operator, per room (a few rooms at most: only those sent to Nous). */
export async function handsCountsIn(rooms: Set<string>, listEvents: (roomId: string, options: { statuses: Array<"OPEN" | "ESCALATED"> }) => Promise<RoomAgentEvent[]>) {
  return Object.fromEntries(await Promise.all([...rooms].map(async (roomId): Promise<[string, number]> =>
    [roomId, (await listEvents(roomId, { statuses: ["OPEN", "ESCALATED"] })).filter((event) => event.severity === "ATTENTION" && forOperator(event.kind, event.createdAt)).length])));
}
