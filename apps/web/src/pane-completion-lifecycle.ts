import type { Event as SpaceEvent } from "@space/contracts";

export interface PaneCompletionEntry {
  activeRunKey: string | null;
  activeRunAllowsCompletion: boolean;
  pendingCompletionEventId: string | null;
  latestCompletionEventId: string | null;
}

export interface PaneCompletionLifecycleState {
  hydratedRoomIds: ReadonlySet<string>;
  seenEventIds: ReadonlySet<string>;
  panes: Readonly<Record<string, PaneCompletionEntry>>;
}

export function createPaneCompletionLifecycleState(): PaneCompletionLifecycleState {
  return {
    hydratedRoomIds: new Set(),
    seenEventIds: new Set(),
    panes: {}
  };
}

function payloadString(event: SpaceEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === "string" && value ? value : null;
}

export function paneRunKeyForEvent(event: SpaceEvent): string | null {
  if (event.turnId) return `turn:${event.turnId}`;
  const clientTurnMarker = payloadString(event, "clientTurnMarker");
  if (clientTurnMarker) return `client-marker:${clientTurnMarker}`;
  const runId = payloadString(event, "runId");
  if (runId) return `run:${runId}`;
  if (event.workflowId) return `workflow:${event.workflowId}`;
  const markerId = payloadString(event, "markerId");
  if (markerId) return `marker:${markerId}`;
  return null;
}

function applyLifecycleEvent(
  panes: Record<string, PaneCompletionEntry>,
  event: SpaceEvent,
  allowPendingCompletion: boolean
): void {
  if (!event.paneId) return;
  if (event.type !== "TURN_STARTED" && event.type !== "TURN_COMPLETED" && event.type !== "TURN_FAILED") return;
  const runKey = paneRunKeyForEvent(event);
  if (!runKey) return;
  const current = panes[event.paneId] ?? {
    activeRunKey: null,
    activeRunAllowsCompletion: false,
    pendingCompletionEventId: null,
    latestCompletionEventId: null
  };

  if (event.type === "TURN_STARTED") {
    panes[event.paneId] = {
      ...current,
      activeRunKey: runKey,
      activeRunAllowsCompletion: allowPendingCompletion,
      pendingCompletionEventId: null
    };
    return;
  }

  if (current.activeRunKey !== runKey) return;
  if (event.type === "TURN_FAILED") {
    panes[event.paneId] = {
      ...current,
      activeRunKey: null,
      activeRunAllowsCompletion: false,
      pendingCompletionEventId: null
    };
    return;
  }

  panes[event.paneId] = {
    activeRunKey: null,
    activeRunAllowsCompletion: false,
    pendingCompletionEventId:
      allowPendingCompletion && current.activeRunAllowsCompletion ? event.id : null,
    latestCompletionEventId: event.id
  };
}

function orderedEvents(events: readonly SpaceEvent[]): SpaceEvent[] {
  return [...events].sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

export function hydratePaneCompletionRoom(
  state: PaneCompletionLifecycleState,
  roomId: string,
  events: readonly SpaceEvent[]
): PaneCompletionLifecycleState {
  if (state.hydratedRoomIds.has(roomId)) {
    return applyPaneCompletionEvents(state, events);
  }
  return hydratePaneCompletionBaseline(state, roomId, events);
}

function hydratePaneCompletionBaseline(
  state: PaneCompletionLifecycleState,
  roomId: string,
  events: readonly SpaceEvent[]
): PaneCompletionLifecycleState {
  const hydratedRoomIds = new Set(state.hydratedRoomIds);
  hydratedRoomIds.add(roomId);
  const seenEventIds = new Set(state.seenEventIds);
  const panes = { ...state.panes };
  const liveEntries = new Map<string, PaneCompletionEntry>();
  for (const event of events) {
    if (!event.paneId) continue;
    const liveEntry = state.panes[event.paneId];
    if (liveEntry) liveEntries.set(event.paneId, liveEntry);
  }
  for (const event of orderedEvents(events)) {
    if (seenEventIds.has(event.id)) continue;
    seenEventIds.add(event.id);
    applyLifecycleEvent(panes, event, false);
  }
  for (const [paneId, entry] of liveEntries) panes[paneId] = entry;
  return { hydratedRoomIds, seenEventIds, panes };
}

export function hydratePaneCompletionReplay(
  state: PaneCompletionLifecycleState,
  roomId: string,
  events: readonly SpaceEvent[]
): PaneCompletionLifecycleState {
  return hydratePaneCompletionBaseline(state, roomId, events);
}

export function applyPaneCompletionEvents(
  state: PaneCompletionLifecycleState,
  events: readonly SpaceEvent[]
): PaneCompletionLifecycleState {
  let changed = false;
  const seenEventIds = new Set(state.seenEventIds);
  const panes = { ...state.panes };
  for (const event of orderedEvents(events)) {
    if (seenEventIds.has(event.id)) continue;
    changed = true;
    seenEventIds.add(event.id);
    applyLifecycleEvent(panes, event, true);
  }
  return changed ? { ...state, seenEventIds, panes } : state;
}

export function acknowledgePaneCompletion(
  state: PaneCompletionLifecycleState,
  paneId: string
): PaneCompletionLifecycleState {
  const current = state.panes[paneId];
  if (!current?.pendingCompletionEventId) return state;
  return {
    ...state,
    panes: {
      ...state.panes,
      [paneId]: { ...current, pendingCompletionEventId: null }
    }
  };
}

export function pendingPaneCompletionEventId(
  state: PaneCompletionLifecycleState,
  paneId: string
): string | null {
  return state.panes[paneId]?.pendingCompletionEventId ?? null;
}
