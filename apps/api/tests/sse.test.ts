import { describe, expect, it, vi } from "vitest";
import type { Event } from "@space/contracts";
import {
  collectUnseenEvents,
  createDurableEventRelay,
  eventMatchesRoom,
  formatReplayEvents,
  formatSseHeartbeat,
  formatSseMessage,
  loadEventStreamReplay,
  startSseHeartbeat,
  trackSeenEventId,
  type DurableEventQuery
} from "../src/sse.js";
import type { EventChange, SpaceStore } from "@space/runtime";

const event: Event = {
  id: "event:test-1",
  roomId: "room:test-1",
  paneId: "pane:test-1",
  turnId: null,
  workflowId: null,
  traceId: "trace:test-1",
  type: "PANE_CREATED",
  message: "Pane created.",
  payload: { mode: "CHAT" },
  createdAt: "2026-06-25T00:00:00.000Z"
};

function eventPage(changes: EventChange[], query: DurableEventQuery): EventChange[] {
  const afterSequence = query.afterSequence === null ? 0n : BigInt(query.afterSequence);
  return changes
    .filter((change) => BigInt(change.sequence) > afterSequence)
    .sort((left, right) => (BigInt(left.sequence) < BigInt(right.sequence) ? -1 : 1))
    .slice(0, query.limit);
}

describe("SSE helpers", () => {
  it("writes a comment heartbeat every thirty seconds and stops cleanly", async () => {
    vi.useFakeTimers();
    try {
      const write = vi.fn();
      const stop = startSseHeartbeat(write);

      await vi.advanceTimersByTimeAsync(29_999);
      expect(write).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(write).toHaveBeenCalledWith(formatSseHeartbeat());

      stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(write).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formats structured messages for EventSource clients", () => {
    expect(formatSseMessage("ready", { ok: true })).toBe('event: ready\ndata: {"ok":true}\n\n');
  });

  it("filters replay events by room", () => {
    expect(eventMatchesRoom(event, undefined)).toBe(true);
    expect(eventMatchesRoom(event, "room:test-1")).toBe(true);
    expect(eventMatchesRoom(event, "room:other")).toBe(false);
  });

  it("formats durable replay events with their original event types", () => {
    const output = formatReplayEvents([event]);

    expect(output).toContain("event: PANE_CREATED");
    expect(output).toContain('"id":"event:test-1"');
    expect(output).toContain('"traceId":"trace:test-1"');
  });

  it("preserves full legacy replay when no limit is requested", async () => {
    const legacyEvents = [event];
    const listEvents = vi.fn<SpaceStore["listEvents"]>(() => legacyEvents);
    const listEventsPage = vi.fn<SpaceStore["listEventsPage"]>();

    await expect(loadEventStreamReplay({ listEvents, listEventsPage }, { roomId: "room:test-1" }))
      .resolves.toBe(legacyEvents);
    expect(listEvents).toHaveBeenCalledWith("room:test-1");
    expect(listEventsPage).not.toHaveBeenCalled();
  });

  it("bounds stream replay and restores chronological delivery order", async () => {
    const newestFirst = Array.from({ length: 200 }, (_, index): Event => ({
      ...event,
      id: `event:${200 - index}`,
      createdAt: new Date(Date.parse(event.createdAt) + (200 - index) * 1_000).toISOString()
    }));
    const listEvents = vi.fn<SpaceStore["listEvents"]>();
    const listEventsPage = vi.fn<SpaceStore["listEventsPage"]>((query) => ({
      items: newestFirst.slice(0, query.pageSize),
      total: 20_000
    }));

    const globalReplay = await loadEventStreamReplay(
      { listEvents, listEventsPage },
      { replayLimit: 200 }
    );
    const roomReplay = await loadEventStreamReplay(
      { listEvents, listEventsPage },
      { roomId: "room:test-1", replayLimit: 50 }
    );

    expect(listEventsPage).toHaveBeenNthCalledWith(1, {
      page: 1,
      pageSize: 200,
      sortOrder: "desc"
    });
    expect(listEventsPage).toHaveBeenNthCalledWith(2, {
      roomId: "room:test-1",
      page: 1,
      pageSize: 50,
      sortOrder: "desc"
    });
    expect(globalReplay).toHaveLength(200);
    expect(globalReplay[0]?.id).toBe("event:1");
    expect(globalReplay.at(-1)?.id).toBe("event:200");
    expect(roomReplay).toHaveLength(50);
    expect(roomReplay[0]?.id).toBe("event:151");
    expect(roomReplay.at(-1)?.id).toBe("event:200");
    expect(listEvents).not.toHaveBeenCalled();
  });

  it("collects only matching unseen events and records them as seen", () => {
    const seen = new Set(["event:test-1"]);
    const nextEvent: Event = {
      ...event,
      id: "event:test-2",
      type: "TURN_COMPLETED",
      turnId: "turn:test-1",
      workflowId: "workflow:test-1"
    };
    const otherRoomEvent: Event = { ...nextEvent, id: "event:test-3", roomId: "room:other" };

    expect(collectUnseenEvents([event, nextEvent, otherRoomEvent], seen, "room:test-1")).toEqual([nextEvent]);
    expect(seen.has("event:test-2")).toBe(true);
    expect(seen.has("event:test-3")).toBe(false);
  });

  it("relays newly persisted events once without replaying existing history", async () => {
    const persistedChanges: EventChange[] = [{ sequence: "1", event }];
    const published: Event[] = [];
    const relay = createDurableEventRelay({
      listEvents: async (query) => eventPage(persistedChanges, query),
      publish: (nextEvent) => published.push(nextEvent)
    });
    relay.seed("1");
    const nextEvent: Event = {
      ...event,
      id: "event:test-2",
      type: "TURN_COMPLETED",
      turnId: "turn:test-1",
      workflowId: "workflow:test-1"
    };
    persistedChanges.push({ sequence: "2", event: nextEvent });

    await relay.poll();
    await relay.poll();

    expect(published).toEqual([nextEvent]);
  });

  it("relays a later commit even when its createdAt sorts behind the previous cursor", async () => {
    const seededEvent = { ...event, createdAt: "2026-06-25T12:00:30.000Z" };
    const nextEvent: Event = {
      ...event,
      id: "event:test-2",
      type: "TURN_COMPLETED",
      createdAt: "2026-06-25T12:00:31.000Z"
    };
    const lateEvent: Event = {
      ...event,
      id: "event:test-late",
      type: "PANE_UPDATED",
      createdAt: "2026-06-25T12:00:20.000Z"
    };
    const persistedChanges: EventChange[] = [
      { sequence: "40", event: seededEvent },
      { sequence: "41", event: nextEvent }
    ];
    const queries: DurableEventQuery[] = [];
    const published: Event[] = [];
    const relay = createDurableEventRelay({
      listEvents: async (query) => {
        queries.push(query);
        return eventPage(persistedChanges, query);
      },
      publish: (next) => published.push(next)
    });
    relay.seed("40");

    await relay.poll();
    persistedChanges.push({ sequence: "42", event: lateEvent });
    await relay.poll();

    expect(queries[0]).toEqual({
      afterSequence: "40",
      limit: 500
    });
    expect(queries[1]).toEqual({
      afterSequence: "41",
      limit: 500
    });
    expect(published).toEqual([nextEvent, lateEvent]);
  });

  it("deduplicates a local publication until the durable cursor consumes it", async () => {
    const localEvent = { ...event, id: "event:local", createdAt: "2026-06-25T12:00:30.000Z" };
    const remoteEvent = { ...event, id: "event:remote", createdAt: "2026-06-25T12:00:31.000Z" };
    const persistedChanges: EventChange[] = [
      { sequence: "11", event: localEvent },
      { sequence: "12", event: remoteEvent }
    ];
    const published: Event[] = [];
    const relay = createDurableEventRelay({
      listEvents: async (query) => eventPage(persistedChanges, query),
      publish: (next) => published.push(next)
    });
    relay.seed("10");
    relay.markSeen(localEvent);

    await relay.poll();
    await relay.poll();

    expect(published).toEqual([remoteEvent]);
  });

  it("paginates more than five hundred durable sequence rows within one bounded poll", async () => {
    const persistedChanges = Array.from({ length: 501 }, (_, index): EventChange => ({
      sequence: String(index + 1),
      event: {
        ...event,
        id: `event:sequence-${String(index + 1).padStart(4, "0")}`,
        createdAt: new Date(Date.parse("2026-06-25T12:00:00.000Z") + index).toISOString()
      }
    }));
    const published: Event[] = [];
    const queries: DurableEventQuery[] = [];
    const relay = createDurableEventRelay({
      listEvents: async (query) => {
        queries.push(query);
        return eventPage(persistedChanges, query);
      },
      publish: (next) => published.push(next)
    });
    relay.seed(null);

    await relay.poll();

    expect(queries).toHaveLength(2);
    expect(queries[1]?.afterSequence).toBe("500");
    expect(published).toEqual(persistedChanges.map((change) => change.event));
  });

  it("coalesces overlapping durable event polls", async () => {
    let releaseList: ((events: EventChange[]) => void) | null = null;
    let listCalls = 0;
    const relay = createDurableEventRelay({
      listEvents: () => {
        listCalls += 1;
        return new Promise<EventChange[]>((resolve) => {
          releaseList = resolve;
        });
      },
      publish: () => undefined
    });

    const firstPoll = relay.poll();
    const overlappingPoll = relay.poll();
    releaseList?.([]);
    await Promise.all([firstPoll, overlappingPoll]);

    expect(listCalls).toBe(1);
  });

  it("bounds the remembered event ids so long-lived connections cannot grow without limit", () => {
    const seenEventIds = new Set<string>();
    for (let index = 0; index < 25_000; index += 1) {
      trackSeenEventId(seenEventIds, `event:bulk-${index}`);
    }

    expect(seenEventIds.size).toBe(20_000);
    expect(seenEventIds.has("event:bulk-0")).toBe(false);
    expect(seenEventIds.has("event:bulk-24999")).toBe(true);
  });
});
