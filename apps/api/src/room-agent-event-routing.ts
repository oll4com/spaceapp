import { needsOperatorHands, type RoomAgentEvent, type RoomAgentSession } from "@space/contracts";
import type { NotificationService } from "./notifications/service.js";

/**
 * Where a Room Agent monitor event goes besides the room's feed (plan clipboard:xEQOrVRQgeAn). While the room owner's Nous
 * works on their behalf (its job runs on this instance, "Work on my behalf" is on, its model is not paused), every event is
 * Nous's alone: no Telegram notice, no notification, and the feed shows it as sent to Nous instead of new. Otherwise
 * events that need the operator raise an ATTENTION notification (badges, toast, desktop) and ESCALATED ones a Telegram notice.
 */
/** What reaches the operator whatever Nous does: a sign-in only they can do, and a CLI's question for them (operator decision 2026-10-24). */
const forOperator = (kind: string) => needsOperatorHands("ROOM_AGENT", kind) || kind === "QUESTION";

export function createRoomAgentEventRouting(deps: {
  roomOwner(roomId: string): Promise<string | null>;
  nousActive(owner: string): Promise<boolean>;
  notifications: Pick<NotificationService, "raise" | "resolve">;
  telegram: { enqueueTelegramNotice(event: RoomAgentEvent): Promise<unknown> };
  log: { warn(details: Record<string, unknown>, message: string): void };
}) {
  const toNous = async (owner: string | null) => Boolean(owner && await deps.nousActive(owner).catch(() => false));
  return {
    /** Whether the owner's Nous takes this room's monitor events right now; when it stops they surface again. */
    sentToNous: async (roomId: string) => toNous(await deps.roomOwner(roomId)),
    async route(event: RoomAgentEvent): Promise<void> {
      const owner = await deps.roomOwner(event.roomId);
      // A sign-in only the operator can do still reaches them at once, Nous or not.
      const nous = !forOperator(event.kind) && await toNous(owner);
      // What needs the operator also goes to Telegram when the integration is on (one message per event).
      if (event.status === "ESCALATED" && !nous) {
        await deps.telegram.enqueueTelegramNotice(event).catch((error) => deps.log.warn({ err: error, eventId: event.eventId }, "Room Agent Telegram notice failed."));
      }
      if (!owner) return;
      const dedupeKey = `room-agent-event:${event.eventId}`;
      void (async () => {
        if (event.severity === "ATTENTION" && (event.status === "OPEN" || event.status === "ESCALATED")) {
          if (nous) return;
          await deps.notifications.raise({ ownerUserId: owner, roomId: event.roomId, paneId: event.paneId, source: "ROOM_AGENT", kind: event.kind, severity: "ATTENTION",
            title: event.title, body: (event.decision ?? event.detail ?? "").slice(0, 2000), link: { roomId: event.roomId, surface: "room-agent", ...(event.paneId ? { paneId: event.paneId } : {}) },
            dedupeKey, payload: { eventId: event.eventId, status: event.status }, telegram: false });
        } else if (event.status !== "OPEN") {
          await deps.notifications.resolve(owner, dedupeKey);
        }
      })().catch((error: unknown) => deps.log.warn({ err: error, eventId: event.eventId }, "Room Agent notification failed."));
    }
  };
}
export type RoomAgentEventRouting = ReturnType<typeof createRoomAgentEventRouting>;

// Events still waiting are Nous's while it works on the owner's behalf: the feed shows them sent to Nous, not new.
const waiting = (meta: Record<string, unknown> | undefined) => meta?.type === "MONITOR_EVENT" && (meta.status === "OPEN" || meta.status === "ESCALATED")
  && !forOperator(String(meta.eventKind ?? ""));
export const hasWaitingEvents = (session: RoomAgentSession) => session.messages.some((message) => waiting(message.meta));
export function markSentToNous(session: RoomAgentSession): RoomAgentSession {
  return { ...session, messages: session.messages.map((message) => waiting(message.meta) ? { ...message, meta: { ...message.meta, sentToNous: true } } : message) };
}

export async function roomsSentToNous(roomIds: string[], sentToNous: ((roomId: string) => Promise<boolean>) | undefined): Promise<Set<string>> {
  if (!sentToNous) return new Set();
  return new Set((await Promise.all(roomIds.map(async (roomId) => (await sentToNous(roomId)) ? roomId : null))).filter((roomId): roomId is string => roomId !== null));
}

/** In rooms whose owner's Nous takes the events only what needs the operator's hands (a sign-in) still counts and is announced. */
export function withoutNousRooms(counts: Record<string, number>, latest: RoomAgentEvent[], toNous: Set<string>, handsCounts: Record<string, number> = {}) {
  return {
    counts: Object.fromEntries(Object.entries(counts).map(([roomId, count]): [string, number] => [roomId, toNous.has(roomId) ? handsCounts[roomId] ?? 0 : count]).filter(([, count]) => count > 0)),
    latest: latest.filter((event) => !toNous.has(event.roomId) || forOperator(event.kind))
  };
}

/** Waiting attention events that need the operator's hands, per room (a few rooms at most: only those sent to Nous). */
export async function handsCountsIn(rooms: Set<string>, listEvents: (roomId: string, options: { statuses: Array<"OPEN" | "ESCALATED">; limit: number }) => Promise<RoomAgentEvent[]>) {
  return Object.fromEntries(await Promise.all([...rooms].map(async (roomId): Promise<[string, number]> =>
    [roomId, (await listEvents(roomId, { statuses: ["OPEN", "ESCALATED"], limit: 200 })).filter((event) => event.severity === "ATTENTION" && forOperator(event.kind)).length])));
}
