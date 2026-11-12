import { cpus, loadavg } from "node:os";
import type { Event, NotificationRaiseInput } from "@space/contracts";
import { makeSpaceId, type SpaceEventBus } from "@space/runtime";
import { reportLateDelivery, type LateControlOutcome } from "./nous/delivery-truth.js";

/**
 * Room watchdog alerts (2/11 10:02 BKK, operator «τι ειναι ολα αυτα τα λαθη!!!!»: six red banners stacked over one pane while the server ran at
 * load 45 on 24 cores). A room-lock timeout or a slow CLI command recovers by itself (the caller hears the error, the lock is free again), so it
 * is the journal's (each producer logs its facts) and, once a room-hour, one inbox line for Nous with the counts: no banner, no card, no room
 * event. Only a room whose alerts keep coming for ROOM_FROZEN_MS, never ROOM_ALERT_GAP_MS apart, is broken: then ONE live ROOM_WATCHDOG_ALERT
 * (needsOperator) goes out, which the web shows as the banner and the notification bridge as the URGENT card.
 */
export const ROOM_FROZEN_MS = 10 * 60_000;
export const ROOM_ALERT_GAP_MS = 2 * 60_000;

export interface RoomWatchdogNoticeDeps {
  room(roomId: string): Promise<{ name: string; ownerUserId?: string | null } | null>;
  pane?(paneId: string): Promise<{ id: string; title: string; paneName?: string | null } | null>;
  /** Nous's inbox line; one per key, a newer line replaces the older. soonMs: an urgent line (not the inbox batch). */
  notice(owner: string, key: string, line: string, soonMs?: number): Promise<void>;
  /** The live event stream (banner and URGENT card). */
  publish(event: Event): void;
  warn(meta: Record<string, unknown>, message: string): void;
  now?: () => number;
  setTimer?: (run: () => void, ms: number) => void;
}

interface RoomHour { start: number; count: number; locks: Map<string, number>; commands: Map<string, number>; maxLoad: number; flushed?: boolean }

const HOUR_MS = 3_600_000;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);
const tally = (counts: Map<string, number>) => [...counts].sort((a, b) => b[1] - a[1]).map(([name, n]) => `${name} ×${n}`).join(", ");

export function createRoomWatchdogNotices(deps: RoomWatchdogNoticeDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((run, ms) => { setTimeout(run, ms).unref(); });
  const hours = new Map<string, RoomHour>();
  const streaks = new Map<string, { since: number; last: number; count: number; frozen: boolean }>();

  async function flush(roomId: string, hour: RoomHour): Promise<void> {
    // Once: the hour's timer and the next hour's first alert both end it.
    if (hour.flushed) return;
    hour.flushed = true;
    if (hours.get(roomId) === hour) hours.delete(roomId);
    const room = await deps.room(roomId);
    if (!room?.ownerUserId) return;
    const parts = [
      hour.locks.size ? `${[...hour.locks.values()].reduce((a, b) => a + b, 0)} room-lock timeouts (lock held by ${tally(hour.locks)})` : "",
      hour.commands.size ? `${[...hour.commands.values()].reduce((a, b) => a + b, 0)} CLI commands over 8 s (${tally(hour.commands)})` : ""
    ].filter(Boolean).join("; ");
    await deps.notice(room.ownerUserId, `room-watchdog:${roomId}:${new Date(hour.start).toISOString().slice(0, 13)}`,
      `Room watchdog, room "${room.name}" (${roomId}), ${hhmm(hour.start)}-${hhmm(hour.start + HOUR_MS)} UTC: ${hour.count} alerts, each recovered by itself: ${parts}. `
      + `1-minute load up to ${hour.maxLoad.toFixed(0)} on ${cpus().length} cores. Nothing reached the operator; look only if the room's work suffers.`);
  }

  async function freeze(roomId: string, streak: { since: number; count: number }): Promise<void> {
    const room = await deps.room(roomId);
    const at = new Date(now()).toISOString();
    deps.publish({ id: makeSpaceId("event"), roomId, paneId: null, turnId: null, workflowId: null, traceId: makeSpaceId("trace"), type: "ROOM_WATCHDOG_ALERT",
      message: `Room "${room?.name ?? roomId}" has been stuck for ${Math.round((now() - streak.since) / 60_000)} minutes: its controls kept timing out `
        + `(${streak.count} times since ${hhmm(streak.since)} UTC), so prompts and controls in it may fail. Nous is told.`,
      payload: { kind: "ROOM_FROZEN", needsOperator: true, roomId, since: new Date(streak.since).toISOString(), alerts: streak.count }, createdAt: at });
  }

  return {
    /** Delivery truth (nous/delivery-truth.ts): Space Control's settledLate, a Nous send that ended FAILED or BLOCKED after its answer. */
    lateDelivery(outcome: LateControlOutcome): Promise<void> {
      return reportLateDelivery(deps, outcome).catch((error: unknown) => deps.warn({ err: error, roomId: outcome.roomId }, "Late delivery notice failed."));
    },
    /** The URGENT card for every live ROOM_WATCHDOG_ALERT (a stuck room, the test alert route); returns the unsubscribe. */
    bridge(eventBus: Pick<SpaceEventBus, "subscribe">, raise: (input: NotificationRaiseInput) => Promise<unknown>): () => void {
      return eventBus.subscribe((event) => {
        const roomId = event.roomId;
        if (event.type !== "ROOM_WATCHDOG_ALERT" || !roomId) return;
        void (async () => {
          const owner = (await deps.room(roomId))?.ownerUserId;
          if (!owner) return;
          await raise({ ownerUserId: owner, roomId, paneId: event.paneId ?? null, source: "ROOM_WATCHDOG", kind: event.type, severity: "URGENT", title: "Room watchdog alert",
            body: event.message, link: { roomId, ...(event.paneId ? { paneId: event.paneId } : {}) }, dedupeKey: `event:${event.id}`, payload: {}, telegram: null });
        })().catch((error: unknown) => deps.warn({ err: error, eventId: event.id }, "Notification producer failed."));
      });
    },
    /** A self-recovering alert of a room (space-control's lock timeouts, room-cli-control's slow commands). */
    report(event: Event): void {
      const roomId = event.roomId;
      if (!roomId) return;
      const at = now();
      const start = Math.floor(at / HOUR_MS) * HOUR_MS;
      let hour = hours.get(roomId);
      if (!hour || hour.start !== start) {
        const ended = hour;
        if (ended) void flush(roomId, ended).catch((error: unknown) => deps.warn({ err: error, roomId }, "Room watchdog summary failed."));
        hour = { start, count: 0, locks: new Map(), commands: new Map(), maxLoad: 0 };
        hours.set(roomId, hour);
        const current = hour;
        setTimer(() => void flush(roomId, current).catch((error: unknown) => deps.warn({ err: error, roomId }, "Room watchdog summary failed.")), start + HOUR_MS - at);
      }
      hour.count += 1;
      hour.maxLoad = Math.max(hour.maxLoad, loadavg()[0] ?? 0);
      const payload = event.payload as { kind?: string; holder?: { source?: string } | null; paneTitle?: string };
      const [counts, name] = payload.kind === "ROOM_FREEZE_PREVENTED" ? [hour.commands, payload.paneTitle ?? event.paneId ?? "a pane"]
        : [hour.locks, payload.holder?.source ?? "another process"];
      counts.set(name, (counts.get(name) ?? 0) + 1);

      let streak = streaks.get(roomId);
      if (!streak || at - streak.last > ROOM_ALERT_GAP_MS) streak = { since: at, last: at, count: 0, frozen: false };
      streak.last = at;
      streak.count += 1;
      streaks.set(roomId, streak);
      if (!streak.frozen && at - streak.since >= ROOM_FROZEN_MS) {
        streak.frozen = true;
        void freeze(roomId, streak).catch((error: unknown) => deps.warn({ err: error, roomId }, "Room watchdog alert failed."));
      }
    }
  };
}
