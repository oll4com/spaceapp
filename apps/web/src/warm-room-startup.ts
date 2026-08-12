export const WARM_ROOM_MRU_STORAGE_KEY = "space.warmRoom.mru.v1";
export const WARM_ROOM_MRU_LIMIT = 6;
export const WARM_ROOM_HYDRATION_WINDOW_MS = 2_000;
export const WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY = 2;
/** Hard ceiling for rooms hydrated during the shared startup window (active room excluded). */
export const WARM_ROOM_STARTUP_HYDRATION_MAX = 4;
export const STARTUP_REQUEST_CONCURRENCY = 4;
/** Cool-down after output-pressure eviction before the same room may be auto-filled again. */
export const WARM_ROOM_EVICTION_COOLDOWN_MS = 30_000;

function parseRoomMru(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const roomIds: string[] = [];
    for (const value of parsed) {
      if (typeof value !== "string" || !value || seen.has(value)) continue;
      seen.add(value);
      roomIds.push(value);
      if (roomIds.length >= WARM_ROOM_MRU_LIMIT) break;
    }
    return roomIds;
  } catch {
    return [];
  }
}

export function readRoomMru(storage: Storage, validRoomIds?: ReadonlySet<string>): string[] {
  const roomIds = parseRoomMru(storage.getItem(WARM_ROOM_MRU_STORAGE_KEY));
  return validRoomIds ? roomIds.filter((roomId) => validRoomIds.has(roomId)) : roomIds;
}

export function recordRoomMru(storage: Storage, roomId: string): string[] {
  const next = [roomId, ...readRoomMru(storage).filter((candidate) => candidate !== roomId)]
    .slice(0, WARM_ROOM_MRU_LIMIT);
  try {
    storage.setItem(WARM_ROOM_MRU_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Tab continuity is best effort when storage is blocked or full.
  }
  return next;
}

export function selectWarmHydrationRoomIds(input: {
  roomIds: readonly string[];
  activeRoomId: string;
  mruRoomIds: readonly string[];
  maxWarmRooms: number;
  maxHydrationRooms?: number;
}): string[] {
  const hardCap = Math.max(
    0,
    Math.floor(input.maxHydrationRooms ?? WARM_ROOM_STARTUP_HYDRATION_MAX)
  );
  const capacity = Math.max(0, Math.min(hardCap, input.maxWarmRooms - 1));
  if (capacity === 0) return [];
  const validRoomIds = new Set(input.roomIds);
  const activeIndex = input.roomIds.indexOf(input.activeRoomId);
  const prioritized = [
    ...input.mruRoomIds,
    activeIndex >= 0 ? input.roomIds[activeIndex + 1] : undefined,
    activeIndex > 0 ? input.roomIds[activeIndex - 1] : undefined
  ];
  const selected: string[] = [];
  const seen = new Set([input.activeRoomId]);
  for (const roomId of prioritized) {
    if (!roomId || seen.has(roomId) || !validRoomIds.has(roomId)) continue;
    seen.add(roomId);
    selected.push(roomId);
    if (selected.length >= capacity) break;
  }
  return selected;
}

/**
 * Hydrate rooms inside a shared wall-clock window with bounded concurrency.
 * Rooms that do not finish before the deadline are omitted from the completed list.
 */
export async function hydrateWarmRoomsWithinWindow(
  roomIds: readonly string[],
  hydrate: (roomId: string) => Promise<void>,
  windowMs = WARM_ROOM_HYDRATION_WINDOW_MS,
  concurrency = WARM_ROOM_STARTUP_HYDRATION_CONCURRENCY
): Promise<string[]> {
  if (roomIds.length === 0) return [];
  const deadline = Date.now() + Math.max(0, windowMs);
  const completed: string[] = [];
  let nextIndex = 0;
  const workerCount = Math.min(
    roomIds.length,
    Math.max(1, Math.floor(concurrency))
  );

  const worker = async () => {
    while (nextIndex < roomIds.length) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return;
      const index = nextIndex;
      nextIndex += 1;
      const roomId = roomIds[index]!;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finished = await Promise.race([
        hydrate(roomId).then(
          () => true,
          () => true
        ),
        new Promise<false>((resolve) => {
          timeout = globalThis.setTimeout(() => resolve(false), remainingMs);
        })
      ]);
      if (timeout !== null) globalThis.clearTimeout(timeout);
      if (!finished) return;
      completed.push(roomId);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  // Preserve input order for deterministic diagnostics.
  const completedSet = new Set(completed);
  return roomIds.filter((roomId) => completedSet.has(roomId));
}

export async function runWithConcurrency<T extends readonly unknown[]>(
  tasks: { readonly [Index in keyof T]: () => Promise<T[Index]> },
  concurrency = STARTUP_REQUEST_CONCURRENCY
): Promise<T> {
  const results: unknown[] = new Array(tasks.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]!();
    }
  };
  const workerCount = Math.min(tasks.length, Math.max(1, Math.floor(concurrency)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results as unknown as T;
}

export function isRoomInEvictionCooldown(
  roomId: string,
  evictedAtByRoomId: ReadonlyMap<string, number>,
  nowMs: number,
  cooldownMs = WARM_ROOM_EVICTION_COOLDOWN_MS
): boolean {
  const evictedAt = evictedAtByRoomId.get(roomId);
  if (evictedAt === undefined) return false;
  return nowMs - evictedAt < Math.max(0, cooldownMs);
}

export function selectAutomaticWarmFillRoomIds(input: {
  roomIds: readonly string[];
  activeRoomId: string;
  preferredRoomIds: readonly string[];
  loadedRoomIds: ReadonlySet<string>;
  eligibleRoomIds: ReadonlySet<string>;
  blockedRoomIds?: ReadonlySet<string>;
  slots: number;
}): string[] {
  const slots = Math.max(0, Math.floor(input.slots));
  if (slots === 0) return [];
  const activeIndex = input.roomIds.indexOf(input.activeRoomId);
  const prioritized = [
    ...input.preferredRoomIds,
    activeIndex >= 0 ? input.roomIds[activeIndex + 1] : undefined,
    activeIndex > 0 ? input.roomIds[activeIndex - 1] : undefined,
    ...input.roomIds
  ];
  const selected: string[] = [];
  const seen = new Set<string>([input.activeRoomId, ...input.loadedRoomIds]);
  for (const roomId of prioritized) {
    if (!roomId || seen.has(roomId)) continue;
    if (!input.eligibleRoomIds.has(roomId)) continue;
    if (input.blockedRoomIds?.has(roomId)) continue;
    seen.add(roomId);
    selected.push(roomId);
    if (selected.length >= slots) break;
  }
  return selected;
}

export type RoomWarmPresentationState = "active" | "warm" | "warming" | "cold";

export function classifyRoomWarmPresentation(input: {
  roomId: string;
  activeRoomId: string | null;
  warmRoomIds: readonly string[];
  hydratingRoomIds: ReadonlySet<string>;
  loadedRoomIds: ReadonlySet<string>;
}): RoomWarmPresentationState {
  if (input.roomId === input.activeRoomId) return "active";
  if (input.warmRoomIds.includes(input.roomId) && input.loadedRoomIds.has(input.roomId)) {
    return "warm";
  }
  if (input.hydratingRoomIds.has(input.roomId)) return "warming";
  return "cold";
}
