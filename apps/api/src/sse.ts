import type { Event } from "@space/contracts";
import type { EventChange, SpaceStore } from "@space/runtime";

export interface DurableEventRelay {
  markSeen(event: Pick<Event, "id">): void;
  seed(afterSequence: string | null): void;
  poll(): Promise<Event[]>;
}

export interface DurableEventQuery {
  afterSequence: string | null;
  limit: number;
}

export function createDurableEventRelay(options: {
  listEvents: (query: DurableEventQuery) => EventChange[] | Promise<EventChange[]>;
  publish: (event: Event) => void;
}): DurableEventRelay {
  const batchSize = 500;
  const maxBatchesPerPoll = 4;
  const locallyPublishedEventIds = new Set<string>();
  let afterSequence: string | null = null;
  let pollInFlight = false;

  return {
    markSeen(event) {
      locallyPublishedEventIds.add(event.id);
    },
    seed(sequence) {
      afterSequence = sequence;
      locallyPublishedEventIds.clear();
    },
    async poll() {
      if (pollInFlight) return [];
      pollInFlight = true;
      try {
        const published: Event[] = [];
        for (let batchIndex = 0; batchIndex < maxBatchesPerPoll; batchIndex += 1) {
          const changes = await options.listEvents({ afterSequence, limit: batchSize });
          for (const change of changes) {
            if (afterSequence !== null && BigInt(change.sequence) <= BigInt(afterSequence)) {
              throw new Error("Durable event relay sequence did not advance.");
            }
            if (!locallyPublishedEventIds.has(change.event.id)) {
              options.publish(change.event);
              published.push(change.event);
            }
            locallyPublishedEventIds.delete(change.event.id);
            afterSequence = change.sequence;
          }
          if (changes.length < batchSize) break;
        }
        return published;
      } finally {
        pollInFlight = false;
      }
    }
  };
}

export function formatSseMessage(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatSseHeartbeat(): string {
  return ": heartbeat\n\n";
}

export function startSseHeartbeat(write: (frame: string) => void): () => void {
  const interval = setInterval(() => write(formatSseHeartbeat()), 30_000);
  return () => clearInterval(interval);
}

export function eventMatchesRoom(event: Event, roomId?: string): boolean {
  return !roomId || event.roomId === roomId;
}

export function collectUnseenEvents(events: Event[], seenEventIds: Set<string>, roomId?: string): Event[] {
  const unseen = events.filter((event) => eventMatchesRoom(event, roomId) && !seenEventIds.has(event.id));
  for (const event of unseen) {
    seenEventIds.add(event.id);
  }
  return unseen;
}

export function formatReplayEvents(events: Event[]): string {
  return events.map((event) => formatSseMessage(event.type, event)).join("");
}

export async function loadEventStreamReplay(
  store: Pick<SpaceStore, "listEvents" | "listEventsPage">,
  query: { roomId?: string; replayLimit?: number }
): Promise<Event[]> {
  if (query.replayLimit === undefined) {
    return store.listEvents(query.roomId);
  }
  const page = await store.listEventsPage({
    ...(query.roomId ? { roomId: query.roomId } : {}),
    page: 1,
    pageSize: query.replayLimit,
    sortOrder: "desc"
  });
  return [...page.items].reverse();
}
