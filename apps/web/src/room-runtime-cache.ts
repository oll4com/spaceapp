import {
  DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT,
  normalizeWarmRoomConnectedPaneLimit
} from "./warm-room-settings.js";

export interface WarmRoomLimits {
  maxRooms: number;
  maxAttachedPanes: number;
}

export const WARM_ROOM_RUNTIME_POLL_INTERVAL_MS = 30_000;
export const HIDDEN_WARM_ROOM_RUNTIME_POLL_INTERVAL_MS = 30_000;

export interface WarmRoomCandidate {
  roomId: string;
  attachedPaneCount: number;
  lastAccessedAt: number;
}

export interface SelectWarmRoomIdsInput {
  enabled?: boolean;
  roomIds: string[];
  activeRoomId: string;
  previousRoomId?: string | null;
  deviceMemory?: number;
  maxAttachedPanes: number;
  candidates: WarmRoomCandidate[];
}

export interface ConnectionBearingPane {
  id: string;
  mode: string;
  isMinimized: boolean;
}

export interface SelectRoomRuntimePollIdsInput {
  warmRoomIds: readonly string[];
  activeRoomId: string | null;
  lastPolledAtByRoomId: ReadonlyMap<string, number>;
  now: number;
}

export function warmRoomLimits(
  deviceMemory?: number,
  maxAttachedPanes = DEFAULT_WARM_ROOM_CONNECTED_PANE_LIMIT
): WarmRoomLimits {
  return {
    maxRooms: deviceMemory !== undefined && deviceMemory <= 4 ? 2 : 3,
    maxAttachedPanes: normalizeWarmRoomConnectedPaneLimit(maxAttachedPanes)
  };
}

export function connectedPaneCount(
  panes: readonly ConnectionBearingPane[],
  bootstrappedTerminalPaneIds: readonly string[]
): number {
  const bootstrappedTerminals = new Set(bootstrappedTerminalPaneIds);
  return panes.filter((pane) => {
    if (pane.mode === "TERMINAL") {
      return !pane.isMinimized || bootstrappedTerminals.has(pane.id);
    }
    // Mounted Browser panes own an independent browser session/frame stream.
    return pane.mode === "BROWSER";
  }).length;
}

export function selectRoomRuntimePollIds(input: SelectRoomRuntimePollIdsInput): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const roomId of input.warmRoomIds) {
    if (seen.has(roomId)) continue;
    seen.add(roomId);
    if (roomId === input.activeRoomId) continue;
    const lastPolledAt = input.lastPolledAtByRoomId.get(roomId);
    if (
      lastPolledAt === undefined ||
      input.now - lastPolledAt >= HIDDEN_WARM_ROOM_RUNTIME_POLL_INTERVAL_MS
    ) {
      selected.push(roomId);
    }
  }
  return selected;
}

export function selectWarmRoomIds(input: SelectWarmRoomIdsInput): string[] {
  if (input.enabled === false) {
    return input.roomIds.includes(input.activeRoomId) ? [input.activeRoomId] : [];
  }
  const limits = warmRoomLimits(input.deviceMemory, input.maxAttachedPanes);
  const candidatesById = new Map(input.candidates.map((candidate) => [candidate.roomId, candidate]));
  const activeIndex = input.roomIds.indexOf(input.activeRoomId);
  const prioritizedRoomIds = [
    input.activeRoomId,
    input.previousRoomId,
    activeIndex >= 0 ? input.roomIds[activeIndex + 1] : undefined,
    activeIndex > 0 ? input.roomIds[activeIndex - 1] : undefined,
    ...input.candidates
      .filter((candidate) => candidate.roomId !== input.activeRoomId)
      .sort((left, right) => right.lastAccessedAt - left.lastAccessedAt)
      .map((candidate) => candidate.roomId)
  ];

  const selected: string[] = [];
  const seen = new Set<string>();
  let attachedPaneCount = 0;

  for (const roomId of prioritizedRoomIds) {
    if (!roomId || seen.has(roomId) || !input.roomIds.includes(roomId)) {
      continue;
    }
    seen.add(roomId);

    if (roomId !== input.activeRoomId && !candidatesById.has(roomId)) {
      continue;
    }
    const candidatePaneCount = Math.max(0, candidatesById.get(roomId)?.attachedPaneCount ?? 0);
    if (roomId !== input.activeRoomId && attachedPaneCount + candidatePaneCount > limits.maxAttachedPanes) {
      continue;
    }

    selected.push(roomId);
    attachedPaneCount += candidatePaneCount;
    if (selected.length >= limits.maxRooms) {
      break;
    }
  }

  return selected;
}
