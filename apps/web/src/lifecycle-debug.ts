import { getSpaceRuntime } from "./runtime/SpaceRuntime.js";

export interface LifecycleDebugEvent {
  id: string;
  at: string;
  type: string;
  scope: string;
  detail: string;
  paneId: string | null;
  paneMode: string | null;
  shellMode: string | null;
  roomSwitch?: RoomSwitchDebugDetail;
}

export type RoomSwitchTemperature = "warm" | "cold";
export type RoomSwitchPhase = "started" | "activated" | "loaded" | "failed";

export interface RoomSwitchDebugDetail {
  id: string;
  fromRoomId: string | null;
  toRoomId: string;
  temperature: RoomSwitchTemperature;
  phase: RoomSwitchPhase;
  durationMs: number;
}

export interface RoomSwitchMeasurement {
  id: string;
  fromRoomId: string | null;
  toRoomId: string;
  temperature: RoomSwitchTemperature;
  startedAt: number;
  startMark: string;
}

export interface LifecycleDebugSnapshot {
  events: LifecycleDebugEvent[];
  pageLoadCount: number;
  pageShowCount: number;
  pageHideCount: number;
  beforeUnloadCount: number;
  visibilityHiddenCount: number;
  componentMountCount: number;
  componentUnmountCount: number;
  shellModeChangeCount: number;
  selectionChangeCount: number;
  suspectRefreshCount: number;
  lastAppBoot: LifecycleDebugEvent | null;
}

interface RecordLifecycleDebugEventInput {
  type: string;
  scope: string;
  detail?: string;
  paneId?: string | null;
  paneMode?: string | null;
  shellMode?: string | null;
  roomSwitch?: RoomSwitchDebugDetail;
  notify?: boolean;
}

const LIFECYCLE_DEBUG_STORAGE_KEY = "space.lifecycleDebug.events";
const LIFECYCLE_DEBUG_MAX_EVENTS = 200;
export const LIFECYCLE_DEBUG_UPDATED_EVENT = "space:lifecycle-debug-updated";

function safeSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return getSpaceRuntime().platform.sessionStorage;
  } catch {
    return null;
  }
}

function readLifecycleDebugEventsInternal(): LifecycleDebugEvent[] {
  const storage = safeSessionStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(LIFECYCLE_DEBUG_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is LifecycleDebugEvent => {
      if (typeof value !== "object" || value === null) return false;
      const event = value as Partial<LifecycleDebugEvent>;
      return typeof event.id === "string" && typeof event.at === "string" && typeof event.type === "string" && typeof event.scope === "string";
    });
  } catch {
    return [];
  }
}

function writeLifecycleDebugEventsInternal(events: LifecycleDebugEvent[]) {
  const storage = safeSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(LIFECYCLE_DEBUG_STORAGE_KEY, JSON.stringify(events.slice(-LIFECYCLE_DEBUG_MAX_EVENTS)));
  } catch {
    // Best effort only.
  }
}

function countEvents(events: LifecycleDebugEvent[], type: string): number {
  return events.reduce((total, event) => total + (event.type === type ? 1 : 0), 0);
}

function readMonotonicTime(): number {
  if (typeof window !== "undefined" && typeof window.performance?.now === "function") {
    return window.performance.now();
  }
  return Date.now();
}

function markPerformance(name: string) {
  if (typeof window === "undefined" || typeof window.performance?.mark !== "function") return;
  try {
    window.performance.mark(name);
  } catch {
    // Lifecycle storage remains authoritative when User Timing is unavailable.
  }
}

function measurePerformance(startMark: string, endMark: string, measureName: string, terminal: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.performance?.measure?.(measureName, startMark, endMark);
  } catch {
    // The monotonic duration is still recorded below.
  } finally {
    window.performance?.clearMeasures?.(measureName);
    window.performance?.clearMarks?.(endMark);
    if (terminal) window.performance?.clearMarks?.(startMark);
  }
}

function roundDuration(durationMs: number): number {
  return Math.round(Math.max(0, durationMs) * 10) / 10;
}

function recordRoomSwitchDebugDetail(detail: RoomSwitchDebugDetail) {
  recordLifecycleDebugEvent({
    type: `room_switch_${detail.phase}`,
    scope: "App",
    detail: `switchId=${detail.id} from=${detail.fromRoomId ?? "none"} to=${detail.toRoomId} temperature=${detail.temperature} durationMs=${detail.durationMs.toFixed(1)}`,
    roomSwitch: detail,
    notify: detail.phase === "loaded" || detail.phase === "failed"
  });
}

export function classifyRoomSwitchTemperature(
  targetRoomId: string,
  mountedRoomIds: readonly string[]
): RoomSwitchTemperature {
  return mountedRoomIds.includes(targetRoomId) ? "warm" : "cold";
}

export function startRoomSwitchMeasurement(
  input: Pick<RoomSwitchMeasurement, "fromRoomId" | "toRoomId" | "temperature">,
  now = readMonotonicTime()
): RoomSwitchMeasurement {
  const id = `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
  const measurement: RoomSwitchMeasurement = {
    ...input,
    id,
    startedAt: now,
    startMark: `space:room-switch:${id}:started`
  };
  markPerformance(measurement.startMark);
  recordRoomSwitchDebugDetail({
    id,
    fromRoomId: input.fromRoomId,
    toRoomId: input.toRoomId,
    temperature: input.temperature,
    phase: "started",
    durationMs: 0
  });
  return measurement;
}

export function recordRoomSwitchMeasurementPhase(
  measurement: RoomSwitchMeasurement,
  phase: Exclude<RoomSwitchPhase, "started">,
  now = readMonotonicTime()
): number {
  const durationMs = roundDuration(now - measurement.startedAt);
  const endMark = `space:room-switch:${measurement.id}:${phase}`;
  const measureName = `space:room-switch:${phase}`;
  markPerformance(endMark);
  measurePerformance(measurement.startMark, endMark, measureName, phase === "loaded" || phase === "failed");
  recordRoomSwitchDebugDetail({
    id: measurement.id,
    fromRoomId: measurement.fromRoomId,
    toRoomId: measurement.toRoomId,
    temperature: measurement.temperature,
    phase,
    durationMs
  });
  return durationMs;
}

export function recordLifecycleDebugEvent(input: RecordLifecycleDebugEventInput) {
  if (typeof window === "undefined") return;
  const nextEvent: LifecycleDebugEvent = {
    id: `${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    type: input.type,
    scope: input.scope,
    detail: input.detail ?? "",
    paneId: input.paneId ?? null,
    paneMode: input.paneMode ?? null,
    shellMode: input.shellMode ?? null,
    ...(input.roomSwitch ? { roomSwitch: input.roomSwitch } : {})
  };
  const events = [...readLifecycleDebugEventsInternal(), nextEvent];
  writeLifecycleDebugEventsInternal(events);
  if (input.notify !== false) window.dispatchEvent(new CustomEvent(LIFECYCLE_DEBUG_UPDATED_EVENT));
}

export function clearLifecycleDebugEvents() {
  const storage = safeSessionStorage();
  if (!storage || typeof window === "undefined") return;
  try {
    storage.removeItem(LIFECYCLE_DEBUG_STORAGE_KEY);
  } catch {
    // Best effort only.
  }
  window.dispatchEvent(new CustomEvent(LIFECYCLE_DEBUG_UPDATED_EVENT));
}

export function readLifecycleDebugSnapshot(): LifecycleDebugSnapshot {
  const events = readLifecycleDebugEventsInternal();
  return {
    events,
    pageLoadCount: countEvents(events, "app_boot"),
    pageShowCount: countEvents(events, "window_pageshow"),
    pageHideCount: countEvents(events, "window_pagehide"),
    beforeUnloadCount: countEvents(events, "window_beforeunload"),
    visibilityHiddenCount: events.reduce(
      (total, event) => total + (event.type === "window_visibilitychange" && /state=hidden/.test(event.detail) ? 1 : 0),
      0
    ),
    componentMountCount: countEvents(events, "component_mounted"),
    componentUnmountCount: countEvents(events, "component_unmounted"),
    shellModeChangeCount: countEvents(events, "shell_mode_changed"),
    selectionChangeCount: countEvents(events, "pane_selection_changed") + countEvents(events, "room_selection_changed"),
    suspectRefreshCount: Math.max(0, countEvents(events, "app_boot") - 1) + countEvents(events, "window_pagehide") + countEvents(events, "window_beforeunload"),
    lastAppBoot: [...events].reverse().find((event) => event.type === "app_boot") ?? null
  };
}
