export const WARM_ROOM_MRU_STORAGE_KEY = "space.warmRoom.mru.v1";
export const WARM_ROOM_MRU_LIMIT = 6;
export const WARM_ROOM_HYDRATION_WINDOW_MS = 2_000;
export const STARTUP_REQUEST_CONCURRENCY = 4;

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
}): string[] {
  const capacity = Math.max(0, Math.min(2, input.maxWarmRooms - 1));
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

export async function hydrateWarmRoomsWithinWindow(
  roomIds: readonly string[],
  hydrate: (roomId: string) => Promise<void>,
  windowMs = WARM_ROOM_HYDRATION_WINDOW_MS
): Promise<string[]> {
  const completed: string[] = [];
  const deadline = Date.now() + Math.max(0, windowMs);
  for (const roomId of roomIds) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let timeout: number | null = null;
    const finished = await Promise.race([
      hydrate(roomId).then(
        () => true,
        () => true
      ),
      new Promise<false>((resolve) => {
        timeout = window.setTimeout(() => resolve(false), remainingMs);
      })
    ]);
    if (timeout !== null) window.clearTimeout(timeout);
    if (!finished) break;
    completed.push(roomId);
  }
  return completed;
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
