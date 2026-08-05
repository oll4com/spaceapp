export const BYTES_PER_MIB = 1024 ** 2;
export const BYTES_PER_GIB = 1024 ** 3;
export const WARM_ROOM_FULL_PANE_COUNT = 16;
export const DEFAULT_ESTIMATED_ROOM_BYTES = 256 * BYTES_PER_MIB;
export const WARM_ROOM_HYDRATION_SAMPLE_LIMIT = 8;
export const WARM_ROOM_PRESSURE_WINDOW_MS = 10_000;
export const WARM_ROOM_GROWTH_INTERVAL_MS = 30_000;
export const WARM_ROOM_HEALTHY_SAMPLES_FOR_GROWTH = 3;

export type WarmRoomMemorySource =
  | "user-agent-specific"
  | "performance-memory"
  | "device-memory"
  | "fallback";

export type WarmRoomPressureReason =
  | "MEMORY"
  | "TERMINAL_OUTPUT"
  | "LONG_TASKS"
  | "LONG_TASK"
  | "EVENT_LOOP_DRIFT";

export interface WarmRoomMemoryTelemetry {
  source: WarmRoomMemorySource;
  usedBytes: number | null;
  heapLimitBytes: number | null;
  deviceMemoryBytes: number | null;
}

export interface WarmRoomHydrationSample {
  deltaBytes: number;
  paneCount: number;
}

export interface WarmRoomCapacityUsage {
  warmRoomCount: number;
  connectedPaneCount: number;
}

export interface WarmRoomCapacitySnapshot {
  memorySource: WarmRoomMemorySource;
  usedBytes: number | null;
  heapLimitBytes: number | null;
  deviceMemoryBytes: number | null;
  safeCeilingBytes: number | null;
  hardCeilingBytes: number | null;
  estimatedRoomBytes: number;
  reserveBytes: number;
  nonWarmUsedBytes: number;
  safeRoomCapacity: number;
  hardRoomCapacity: number;
  effectiveSafeRoomCapacity: number;
  safePaneCapacity: number;
  hardPaneCapacity: number;
  warmRoomCount: number;
  connectedPaneCount: number;
  pressureReasons: WarmRoomPressureReason[];
  longTaskCount: number;
  driftCount: number;
  overcommitInUse: boolean;
  revokeHiddenRoomCount: number;
}

export interface SelectWarmRoomMemoryTelemetryInput {
  userAgentSpecificBytes?: unknown;
  performanceMemory?: {
    usedJSHeapSize?: unknown;
    jsHeapSizeLimit?: unknown;
  } | null;
  deviceMemoryGiB?: unknown;
}

export interface SnapshotWarmRoomCapacityInput {
  memory: WarmRoomMemoryTelemetry;
  hydrationSamples: readonly WarmRoomHydrationSample[];
  warmRoomCount: number;
  connectedPaneCount: number;
  hardwareConcurrency?: number;
  pressureReasons: readonly WarmRoomPressureReason[];
  overcommitInUse: boolean;
}

interface WarmRoomCapacityControllerOptions {
  nowMs?: number;
}

interface BrowserMemoryPerformance extends Performance {
  memory?: {
    usedJSHeapSize?: unknown;
    jsHeapSizeLimit?: unknown;
  };
  measureUserAgentSpecificMemory?: () => Promise<{ bytes?: unknown }>;
}

interface BrowserMemoryNavigator extends Navigator {
  deviceMemory?: unknown;
}

function positiveFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function finiteNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function minimumAvailable(values: readonly (number | null)[]): number | null {
  const available = values.filter((value): value is number => value !== null);
  return available.length > 0 ? Math.min(...available) : null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function selectWarmRoomMemoryTelemetry(
  input: SelectWarmRoomMemoryTelemetryInput
): WarmRoomMemoryTelemetry {
  const userAgentSpecificBytes = positiveFinite(input.userAgentSpecificBytes);
  const usedJSHeapSize = positiveFinite(input.performanceMemory?.usedJSHeapSize);
  const jsHeapSizeLimit = positiveFinite(input.performanceMemory?.jsHeapSizeLimit);
  const performanceMemoryValid = usedJSHeapSize !== null &&
    jsHeapSizeLimit !== null &&
    usedJSHeapSize <= jsHeapSizeLimit;
  const deviceMemoryGiB = positiveFinite(input.deviceMemoryGiB);
  const deviceMemoryBytes = deviceMemoryGiB === null
    ? null
    : Math.floor(deviceMemoryGiB * BYTES_PER_GIB);

  if (userAgentSpecificBytes !== null) {
    return {
      source: "user-agent-specific",
      usedBytes: Math.floor(userAgentSpecificBytes),
      heapLimitBytes: performanceMemoryValid ? Math.floor(jsHeapSizeLimit) : null,
      deviceMemoryBytes
    };
  }
  if (performanceMemoryValid) {
    return {
      source: "performance-memory",
      usedBytes: Math.floor(usedJSHeapSize),
      heapLimitBytes: Math.floor(jsHeapSizeLimit),
      deviceMemoryBytes
    };
  }
  if (deviceMemoryBytes !== null) {
    return {
      source: "device-memory",
      usedBytes: null,
      heapLimitBytes: null,
      deviceMemoryBytes
    };
  }
  return {
    source: "fallback",
    usedBytes: null,
    heapLimitBytes: null,
    deviceMemoryBytes: null
  };
}

export async function readBrowserWarmRoomMemoryTelemetry(): Promise<WarmRoomMemoryTelemetry> {
  const browserPerformance = performance as BrowserMemoryPerformance;
  const browserNavigator = navigator as BrowserMemoryNavigator;
  let userAgentSpecificBytes: unknown;
  if (typeof browserPerformance.measureUserAgentSpecificMemory === "function") {
    try {
      userAgentSpecificBytes = (await browserPerformance.measureUserAgentSpecificMemory()).bytes;
    } catch {
      userAgentSpecificBytes = undefined;
    }
  }
  return selectWarmRoomMemoryTelemetry({
    userAgentSpecificBytes,
    performanceMemory: browserPerformance.memory,
    deviceMemoryGiB: browserNavigator.deviceMemory
  });
}

export function estimateWarmRoomBytes(
  samples: readonly WarmRoomHydrationSample[]
): number {
  const normalized = samples
    .filter((sample) => (
      positiveFinite(sample.deltaBytes) !== null &&
      positiveFinite(sample.paneCount) !== null
    ))
    .slice(-WARM_ROOM_HYDRATION_SAMPLE_LIMIT)
    .map((sample) => sample.deltaBytes * WARM_ROOM_FULL_PANE_COUNT / sample.paneCount)
    .sort((left, right) => left - right);
  if (normalized.length === 0) return DEFAULT_ESTIMATED_ROOM_BYTES;
  const nearestRankIndex = Math.max(0, Math.ceil(normalized.length * 0.9) - 1);
  return Math.max(
    DEFAULT_ESTIMATED_ROOM_BYTES,
    Math.ceil(normalized[nearestRankIndex]! * 1.25)
  );
}

export function snapshotWarmRoomCapacity(
  input: SnapshotWarmRoomCapacityInput
): WarmRoomCapacitySnapshot {
  const estimatedRoomBytes = estimateWarmRoomBytes(input.hydrationSamples);
  const reserveBytes = estimatedRoomBytes;
  const warmRoomCount = finiteNonNegativeInteger(input.warmRoomCount);
  const connectedPaneCount = finiteNonNegativeInteger(input.connectedPaneCount);
  const hardwareConcurrency = positiveFinite(input.hardwareConcurrency);
  const safePaneCapacity = hardwareConcurrency === null
    ? 32
    : clamp(Math.floor(hardwareConcurrency * 8), 16, 96);
  const hardPaneCapacity = Math.min(112, safePaneCapacity + WARM_ROOM_FULL_PANE_COUNT);
  const safeCpuRoomCapacity = Math.max(1, Math.floor(safePaneCapacity / WARM_ROOM_FULL_PANE_COUNT));
  const hardCpuRoomCapacity = Math.max(1, Math.floor(hardPaneCapacity / WARM_ROOM_FULL_PANE_COUNT));

  const safeCeilingBytes = minimumAvailable([
    input.memory.heapLimitBytes === null ? null : input.memory.heapLimitBytes * 0.6,
    input.memory.deviceMemoryBytes === null ? null : input.memory.deviceMemoryBytes * 0.4
  ]);
  const hardCeilingBytes = minimumAvailable([
    input.memory.heapLimitBytes === null ? null : input.memory.heapLimitBytes * 0.72,
    input.memory.deviceMemoryBytes === null ? null : input.memory.deviceMemoryBytes * 0.5
  ]);
  const admittedWarmBytes = warmRoomCount * estimatedRoomBytes;
  const nonWarmUsedBytes = input.memory.usedBytes === null
    ? 0
    : Math.max(0, input.memory.usedBytes - admittedWarmBytes);
  const safeMemoryRoomCapacity = safeCeilingBytes === null
    ? 2
    : Math.max(1, Math.floor(
        Math.max(0, safeCeilingBytes - nonWarmUsedBytes - reserveBytes) /
        estimatedRoomBytes
      ));
  const hardMemoryRoomCapacity = hardCeilingBytes === null
    ? 2
    : Math.max(1, Math.floor(
        Math.max(0, hardCeilingBytes - nonWarmUsedBytes - reserveBytes) /
        estimatedRoomBytes
      ));
  const safeRoomCapacity = Math.min(safeMemoryRoomCapacity, safeCpuRoomCapacity);
  const hardRoomCapacity = Math.max(
    safeRoomCapacity,
    Math.min(hardMemoryRoomCapacity, hardCpuRoomCapacity)
  );
  const pressureReasons = Array.from(new Set<WarmRoomPressureReason>([
    ...input.pressureReasons,
    ...(safeCeilingBytes !== null &&
      input.memory.usedBytes !== null &&
      input.memory.usedBytes >= safeCeilingBytes
      ? ["MEMORY" as const]
      : [])
  ]));

  return {
    memorySource: input.memory.source,
    usedBytes: input.memory.usedBytes,
    heapLimitBytes: input.memory.heapLimitBytes,
    deviceMemoryBytes: input.memory.deviceMemoryBytes,
    safeCeilingBytes,
    hardCeilingBytes,
    estimatedRoomBytes,
    reserveBytes,
    nonWarmUsedBytes,
    safeRoomCapacity,
    hardRoomCapacity,
    effectiveSafeRoomCapacity: safeRoomCapacity,
    safePaneCapacity,
    hardPaneCapacity,
    warmRoomCount,
    connectedPaneCount,
    pressureReasons,
    longTaskCount: 0,
    driftCount: 0,
    overcommitInUse: input.overcommitInUse,
    revokeHiddenRoomCount: 0
  };
}

export function canUseWarmRoomOvercommit(
  snapshot: WarmRoomCapacitySnapshot,
  nextRoomPaneCount = WARM_ROOM_FULL_PANE_COUNT
): boolean {
  const nextPaneCount = finiteNonNegativeInteger(nextRoomPaneCount);
  return !snapshot.overcommitInUse &&
    snapshot.pressureReasons.length === 0 &&
    snapshot.warmRoomCount < snapshot.hardRoomCapacity &&
    snapshot.connectedPaneCount + nextPaneCount <= snapshot.hardPaneCapacity;
}

export function createWarmRoomCapacityController(
  options: WarmRoomCapacityControllerOptions = {}
) {
  let visible = true;
  let lastWallMs = options.nowMs ?? 0;
  let activeElapsedMs = 0;
  let lastIncreaseActiveMs = 0;
  let healthySamples = 0;
  let longTasks: Array<{ at: number; durationMs: number }> = [];
  let eventLoopDrifts: Array<{ at: number; durationMs: number }> = [];
  let terminalPressureAt: number | null = null;
  let hasSampled = false;
  let current = snapshotWarmRoomCapacity({
    memory: selectWarmRoomMemoryTelemetry({}),
    hydrationSamples: [],
    warmRoomCount: 0,
    connectedPaneCount: 0,
    hardwareConcurrency: undefined,
    pressureReasons: [],
    overcommitInUse: false
  });
  current = { ...current, effectiveSafeRoomCapacity: 2 };

  const advanceClock = (nowMs: number) => {
    const safeNow = Number.isFinite(nowMs) ? Math.max(lastWallMs, nowMs) : lastWallMs;
    if (visible) activeElapsedMs += safeNow - lastWallMs;
    lastWallMs = safeNow;
  };

  const pruneSignals = (nowMs: number) => {
    const cutoff = nowMs - WARM_ROOM_PRESSURE_WINDOW_MS;
    longTasks = longTasks.filter((entry) => entry.at >= cutoff);
    eventLoopDrifts = eventLoopDrifts.filter((entry) => entry.at >= cutoff);
    if (terminalPressureAt !== null && terminalPressureAt < cutoff) terminalPressureAt = null;
  };

  const signalPressureReasons = (nowMs: number): WarmRoomPressureReason[] => {
    pruneSignals(nowMs);
    if (!visible) return [];
    const reasons: WarmRoomPressureReason[] = [];
    if (terminalPressureAt !== null) reasons.push("TERMINAL_OUTPUT");
    if (longTasks.some((entry) => entry.durationMs >= 500)) reasons.push("LONG_TASK");
    if (longTasks.filter((entry) => entry.durationMs >= 100).length >= 3) reasons.push("LONG_TASKS");
    if (eventLoopDrifts.filter((entry) => entry.durationMs >= 250).length >= 2) {
      reasons.push("EVENT_LOOP_DRIFT");
    }
    return reasons;
  };

  const withFreshUsage = (
    base: WarmRoomCapacitySnapshot,
    usage?: WarmRoomCapacityUsage
  ): WarmRoomCapacitySnapshot => usage
    ? {
        ...base,
        warmRoomCount: finiteNonNegativeInteger(usage.warmRoomCount),
        connectedPaneCount: finiteNonNegativeInteger(usage.connectedPaneCount)
      }
    : base;

  const apply = (
    base: WarmRoomCapacitySnapshot,
    nowMs: number,
    countHealthySample: boolean
  ): WarmRoomCapacitySnapshot => {
    advanceClock(nowMs);
    const pressureReasons = Array.from(new Set([
      ...base.pressureReasons,
      ...signalPressureReasons(lastWallMs)
    ]));
    const pressured = pressureReasons.length > 0;
    let effectiveSafeRoomCapacity = Math.min(
      current.effectiveSafeRoomCapacity,
      base.safeRoomCapacity
    );
    let revokeHiddenRoomCount = 0;
    let overcommitInUse = base.overcommitInUse;

    if (!hasSampled && !pressured) {
      effectiveSafeRoomCapacity = Math.min(base.safeRoomCapacity, 3);
    } else if (pressured) {
      healthySamples = 0;
      overcommitInUse = false;
      const pressureTarget = Math.max(
        1,
        Math.min(
          base.safeRoomCapacity,
          current.effectiveSafeRoomCapacity - 1,
          Math.max(1, base.warmRoomCount - 1)
        )
      );
      effectiveSafeRoomCapacity = pressureTarget;
      revokeHiddenRoomCount = Math.max(0, base.warmRoomCount - pressureTarget);
    } else if (visible && countHealthySample) {
      healthySamples += 1;
      if (
        base.safeRoomCapacity > effectiveSafeRoomCapacity &&
        healthySamples >= WARM_ROOM_HEALTHY_SAMPLES_FOR_GROWTH &&
        activeElapsedMs - lastIncreaseActiveMs >= WARM_ROOM_GROWTH_INTERVAL_MS
      ) {
        effectiveSafeRoomCapacity += 1;
        healthySamples = 0;
        lastIncreaseActiveMs = activeElapsedMs;
      }
    }

    current = {
      ...base,
      pressureReasons,
      longTaskCount: longTasks.filter((entry) => entry.durationMs >= 100).length,
      driftCount: eventLoopDrifts.filter((entry) => entry.durationMs >= 250).length,
      overcommitInUse,
      effectiveSafeRoomCapacity,
      revokeHiddenRoomCount
    };
    hasSampled = true;
    return current;
  };

  return {
    sample(base: WarmRoomCapacitySnapshot, nowMs = Date.now()): WarmRoomCapacitySnapshot {
      return apply(base, nowMs, true);
    },
    recordLongTask(
      durationMs: number,
      nowMs = Date.now(),
      usage?: WarmRoomCapacityUsage
    ): WarmRoomCapacitySnapshot {
      advanceClock(nowMs);
      if (visible && Number.isFinite(durationMs) && durationMs >= 100) {
        longTasks.push({ at: lastWallMs, durationMs });
      }
      return apply(withFreshUsage(current, usage), lastWallMs, false);
    },
    recordEventLoopDrift(
      durationMs: number,
      nowMs = Date.now(),
      usage?: WarmRoomCapacityUsage
    ): WarmRoomCapacitySnapshot {
      advanceClock(nowMs);
      if (visible && Number.isFinite(durationMs) && durationMs >= 250) {
        eventLoopDrifts.push({ at: lastWallMs, durationMs });
      }
      return apply(withFreshUsage(current, usage), lastWallMs, false);
    },
    recordTerminalOutputPressure(
      nowMs = Date.now(),
      usage?: WarmRoomCapacityUsage
    ): WarmRoomCapacitySnapshot {
      advanceClock(nowMs);
      if (visible) terminalPressureAt = lastWallMs;
      return apply(withFreshUsage(current, usage), lastWallMs, false);
    },
    resolveTerminalOutputPressureLocally(
      usage?: WarmRoomCapacityUsage
    ): WarmRoomCapacitySnapshot {
      current = {
        ...withFreshUsage(current, usage),
        overcommitInUse: false,
        revokeHiddenRoomCount: 0
      };
      return current;
    },
    clearPressure(nowMs = Date.now()): WarmRoomCapacitySnapshot {
      advanceClock(nowMs);
      longTasks = [];
      eventLoopDrifts = [];
      terminalPressureAt = null;
      current = { ...current, pressureReasons: [], revokeHiddenRoomCount: 0 };
      return current;
    },
    setVisibility(nextVisible: boolean, nowMs = Date.now()): WarmRoomCapacitySnapshot {
      advanceClock(nowMs);
      visible = nextVisible;
      longTasks = [];
      eventLoopDrifts = [];
      terminalPressureAt = null;
      healthySamples = 0;
      lastIncreaseActiveMs = activeElapsedMs;
      current = { ...current, pressureReasons: [], revokeHiddenRoomCount: 0 };
      return current;
    },
    setOvercommitInUse(overcommitInUse: boolean): WarmRoomCapacitySnapshot {
      current = { ...current, overcommitInUse };
      return current;
    },
    current(): WarmRoomCapacitySnapshot {
      return current;
    }
  };
}
