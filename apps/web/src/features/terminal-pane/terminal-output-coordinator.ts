import { emitAppDiagnosticsPerformance } from "../../app-diagnostics/app-diagnostics-performance.js";

export const TERMINAL_HIDDEN_PANE_BUFFER_LIMIT_BYTES = 128 * 1024;
export const TERMINAL_HIDDEN_TOTAL_BUFFER_LIMIT_BYTES = 1024 * 1024;
const TERMINAL_REVEAL_BATCH_LIMIT_BYTES = 1024 * 1024;

export type TerminalOutputWriteMode = "VISIBLE" | "PREFILL";

export interface TerminalOutputPressure {
  roomId: string;
  paneId: string;
  bufferedBytes: number;
  bufferedEvents: number;
  totalBufferedBytes: number;
  reason: "PANE_LIMIT" | "TOTAL_LIMIT";
}

export interface TerminalOutputSnapshot {
  roomId: string;
  paneId: string;
  bufferedBytes: number;
  bufferedEvents: number;
  pendingPrefillBytes: number;
  pendingPrefillEvents: number;
  writtenBytes: number;
  writtenEvents: number;
  totalBufferedBytes: number;
}

export interface TerminalPendingPrefillSnapshot {
  pendingPrefillBytes: number;
  pendingPrefillEvents: number;
}

interface BufferedOutput {
  data: string;
  bytes: number;
  requestedMode: TerminalOutputWriteMode;
  afterWrite?: () => void;
}

interface BufferedOutputBatch {
  data: string;
  bytes: number;
  outputs: BufferedOutput[];
}

const bufferedBytesByPane = new Map<string, number>();
const reportedTotalPressureLimits = new Set<number>();
const textEncoder = new TextEncoder();

interface ActiveAgentStressProofCounters {
  version: 1;
  bufferedEvents: number;
  bufferedBytes: number;
  xtermWriteEvents: number;
  xtermWriteBytes: number;
  hiddenXtermWriteEvents: number;
  hiddenXtermWriteBytes: number;
  prefillXtermWriteEvents: number;
  prefillXtermWriteBytes: number;
  maintenanceXtermWriteEvents: number;
  maintenanceXtermWriteBytes: number;
  panes: Record<string, Omit<ActiveAgentStressProofCounters, "version" | "panes"> & {
    roomId: string;
    paneId: string;
  }>;
}

function activeAgentStressProofCounters(): ActiveAgentStressProofCounters | null {
  const candidate = (globalThis as typeof globalThis & {
    __spaceActiveAgentStressProof?: Partial<ActiveAgentStressProofCounters>;
  }).__spaceActiveAgentStressProof;
  if (
    candidate?.version !== 1 ||
    !Number.isFinite(candidate.bufferedEvents) ||
    !Number.isFinite(candidate.bufferedBytes) ||
    !Number.isFinite(candidate.xtermWriteEvents) ||
    !Number.isFinite(candidate.xtermWriteBytes) ||
    !Number.isFinite(candidate.hiddenXtermWriteEvents) ||
    !Number.isFinite(candidate.hiddenXtermWriteBytes) ||
    !Number.isFinite(candidate.prefillXtermWriteEvents) ||
    !Number.isFinite(candidate.prefillXtermWriteBytes) ||
    !Number.isFinite(candidate.maintenanceXtermWriteEvents) ||
    !Number.isFinite(candidate.maintenanceXtermWriteBytes) ||
    !candidate.panes ||
    typeof candidate.panes !== "object" ||
    Array.isArray(candidate.panes)
  ) return null;
  return candidate as ActiveAgentStressProofCounters;
}

function activeAgentStressPaneCounters(
  counters: ActiveAgentStressProofCounters,
  roomId: string,
  paneId: string
) {
  const key = `${roomId}\u0000${paneId}`;
  return counters.panes[key] ??= {
    roomId,
    paneId,
    bufferedEvents: 0,
    bufferedBytes: 0,
    xtermWriteEvents: 0,
    xtermWriteBytes: 0,
    hiddenXtermWriteEvents: 0,
    hiddenXtermWriteBytes: 0,
    prefillXtermWriteEvents: 0,
    prefillXtermWriteBytes: 0,
    maintenanceXtermWriteEvents: 0,
    maintenanceXtermWriteBytes: 0
  };
}

export function recordTerminalStressXtermWrite(
  roomId: string,
  paneId: string,
  data: string,
  hidden: boolean,
  mode: TerminalOutputWriteMode
): void {
  const counters = activeAgentStressProofCounters();
  if (!counters) return;
  const bytes = textEncoder.encode(data).byteLength;
  const pane = activeAgentStressPaneCounters(counters, roomId, paneId);
  counters.xtermWriteEvents += 1;
  counters.xtermWriteBytes += bytes;
  pane.xtermWriteEvents += 1;
  pane.xtermWriteBytes += bytes;
  if (!hidden) return;
  counters.hiddenXtermWriteEvents += 1;
  counters.hiddenXtermWriteBytes += bytes;
  pane.hiddenXtermWriteEvents += 1;
  pane.hiddenXtermWriteBytes += bytes;
  if (mode === "PREFILL") {
    counters.prefillXtermWriteEvents += 1;
    counters.prefillXtermWriteBytes += bytes;
    pane.prefillXtermWriteEvents += 1;
    pane.prefillXtermWriteBytes += bytes;
  } else {
    counters.maintenanceXtermWriteEvents += 1;
    counters.maintenanceXtermWriteBytes += bytes;
    pane.maintenanceXtermWriteEvents += 1;
    pane.maintenanceXtermWriteBytes += bytes;
  }
}

function totalBufferedBytes(): number {
  let total = 0;
  for (const bytes of bufferedBytesByPane.values()) total += bytes;
  return total;
}

function clearResolvedTotalPressureLimits(): void {
  const total = totalBufferedBytes();
  for (const limit of reportedTotalPressureLimits) {
    if (total <= limit) reportedTotalPressureLimits.delete(limit);
  }
}

export function resetTerminalOutputBudgetForTests(): void {
  bufferedBytesByPane.clear();
  reportedTotalPressureLimits.clear();
}

export function createTerminalOutputCoordinator(options: {
  roomId: string;
  paneId: string;
  isWritable: () => boolean;
  isPrefillWritable?: () => boolean;
  write: (
    data: string,
    done: (error?: unknown) => void,
    mode: TerminalOutputWriteMode
  ) => void | Promise<void>;
  onPrefillDrained?: () => void;
  onPendingPrefillChange?: (snapshot: TerminalPendingPrefillSnapshot) => void;
  onPressure?: (pressure: TerminalOutputPressure) => void;
  perPaneLimitBytes?: number;
  totalLimitBytes?: number;
}) {
  const key = `${options.roomId}\u0000${options.paneId}`;
  const perPaneLimitBytes = options.perPaneLimitBytes ?? TERMINAL_HIDDEN_PANE_BUFFER_LIMIT_BYTES;
  const totalLimitBytes = options.totalLimitBytes ?? TERMINAL_HIDDEN_TOTAL_BUFFER_LIMIT_BYTES;
  const buffer: BufferedOutput[] = [];
  let bufferedBytes = 0;
  let pendingPrefillBytes = 0;
  let pendingPrefillEvents = 0;
  let writtenBytes = 0;
  let writtenEvents = 0;
  let disposed = false;
  let writing = false;
  const drainWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = [];
  let panePressureReported = false;

  const reportPendingPrefill = () => {
    options.onPendingPrefillChange?.({
      pendingPrefillBytes,
      pendingPrefillEvents
    });
  };

  const updateBudget = () => {
    if (bufferedBytes > 0) bufferedBytesByPane.set(key, bufferedBytes);
    else bufferedBytesByPane.delete(key);
    clearResolvedTotalPressureLimits();
  };

  const reportPressure = (reassertUnresolved = false) => {
    const total = totalBufferedBytes();
    const panePressure = bufferedBytes > perPaneLimitBytes;
    const totalPressure = total > totalLimitBytes;
    if (!panePressure) panePressureReported = false;
    if (!totalPressure) reportedTotalPressureLimits.delete(totalLimitBytes);
    const reason =
      totalPressure && (reassertUnresolved || !reportedTotalPressureLimits.has(totalLimitBytes))
        ? "TOTAL_LIMIT"
        : panePressure && (reassertUnresolved || !panePressureReported)
          ? "PANE_LIMIT"
          : null;
    if (!reason) return;
    if (reason === "TOTAL_LIMIT") {
      reportedTotalPressureLimits.add(totalLimitBytes);
      panePressureReported ||= panePressure;
    } else {
      panePressureReported = true;
    }
    const pressure = {
      roomId: options.roomId,
      paneId: options.paneId,
      bufferedBytes,
      bufferedEvents: buffer.length,
      totalBufferedBytes: total,
      reason
    } satisfies TerminalOutputPressure;
    emitAppDiagnosticsPerformance({
      category: "PERFORMANCE",
      metric: "TERMINAL_OUTPUT_PRESSURE",
      roomId: pressure.roomId,
      paneId: pressure.paneId,
      phase: pressure.reason,
      bufferedBytes: pressure.bufferedBytes,
      bufferedEvents: pressure.bufferedEvents,
      totalBufferedBytes: pressure.totalBufferedBytes,
      writtenBytes,
      writtenEvents
    });
    options.onPressure?.(pressure);
  };

  const nextWriteMode = (): TerminalOutputWriteMode | null => {
    if (buffer[0]?.requestedMode === "PREFILL" && options.isPrefillWritable?.()) {
      return "PREFILL";
    }
    if (options.isWritable()) return "VISIBLE";
    return null;
  };

  const resolveDrainWaiters = () => {
    if (writing || (buffer.length > 0 && nextWriteMode() !== null)) return;
    for (const waiter of drainWaiters.splice(0)) waiter.resolve();
  };

  const rejectDrainWaiters = (error: unknown) => {
    for (const waiter of drainWaiters.splice(0)) waiter.reject(error);
  };

  const takeNextBatch = (mode: TerminalOutputWriteMode): BufferedOutputBatch => {
    const outputs: BufferedOutput[] = [];
    let bytes = 0;
    while (buffer.length > 0) {
      const candidate = buffer[0]!;
      if (mode === "PREFILL" && candidate.requestedMode !== "PREFILL") break;
      if (outputs.length > 0 && bytes + candidate.bytes > TERMINAL_REVEAL_BATCH_LIMIT_BYTES) break;
      outputs.push(buffer.shift()!);
      bytes += candidate.bytes;
      if (bytes >= TERMINAL_REVEAL_BATCH_LIMIT_BYTES) break;
    }
    return {
      data: outputs.length === 1 ? outputs[0]!.data : outputs.map((output) => output.data).join(""),
      bytes,
      outputs
    };
  };

  const pump = (): void => {
    if (disposed || writing) {
      resolveDrainWaiters();
      return;
    }
    while (!disposed && !writing && buffer.length > 0) {
      const mode = nextWriteMode();
      if (!mode) break;
      const next = takeNextBatch(mode);
      bufferedBytes -= next.bytes;
      updateBudget();
      writing = true;
      let synchronous = true;
      let completed = false;
      const done = (error?: unknown) => {
        if (completed) return;
        completed = true;
        writing = false;
        if (error !== undefined) {
          rejectDrainWaiters(error);
          return;
        }
        if (!disposed) {
          writtenBytes += next.bytes;
          writtenEvents += next.outputs.length;
          const hadPendingPrefill = pendingPrefillEvents > 0;
          for (const output of next.outputs) {
            if (output.requestedMode === "PREFILL") {
              pendingPrefillBytes -= output.bytes;
              pendingPrefillEvents -= 1;
            }
            output.afterWrite?.();
          }
          if (hadPendingPrefill && pendingPrefillEvents === 0) {
            options.onPrefillDrained?.();
          }
          if (hadPendingPrefill) reportPendingPrefill();
        }
        if (!synchronous) {
          reportPressure();
          pump();
        }
      };
      try {
        const returned = options.write(next.data, done, mode);
        if (returned && typeof returned.then === "function") {
          void returned.then(() => done(), done);
        }
      } catch (error) {
        done(error);
      }
      synchronous = false;
      if (!completed) return;
    }
    reportPressure();
    resolveDrainWaiters();
  };

  const drain = (): Promise<void> => {
    if (disposed || (!writing && buffer.length === 0)) return Promise.resolve();
    if (!writing && nextWriteMode() === null) {
      return Promise.resolve();
    }
    const promise = new Promise<void>((resolve, reject) => {
      drainWaiters.push({ resolve, reject });
    });
    pump();
    return promise;
  };

  const maintainPressure = async (): Promise<void> => {
    if (disposed || nextWriteMode() !== null) {
      await drain();
      return;
    }
    reportPressure();
    if (reportedTotalPressureLimits.has(totalLimitBytes)) return;
    // The controller/runtime listener may attach after the first threshold crossing during
    // hidden startup hydration, so reassert unresolved per-pane pressure once the full replay is
    // buffered. A reported total threshold is already global and must not trigger another LRU
    // eviction before the pressured pane unmounts.
    reportPressure(true);
  };

  return {
    async enqueue(
      data: string,
      afterWrite?: () => void,
      requestedMode: TerminalOutputWriteMode = "VISIBLE"
    ): Promise<void> {
      if (disposed || !data) return;
      const bytes = textEncoder.encode(data).byteLength;
      if (!options.isWritable()) {
        const counters = activeAgentStressProofCounters();
        if (counters) {
          const pane = activeAgentStressPaneCounters(counters, options.roomId, options.paneId);
          counters.bufferedEvents += 1;
          counters.bufferedBytes += bytes;
          pane.bufferedEvents += 1;
          pane.bufferedBytes += bytes;
        }
      }
      buffer.push({ data, bytes, requestedMode, afterWrite });
      bufferedBytes += bytes;
      if (requestedMode === "PREFILL") {
        pendingPrefillBytes += bytes;
        pendingPrefillEvents += 1;
        reportPendingPrefill();
      }
      updateBudget();
      if (nextWriteMode() !== null) {
        await drain();
      } else {
        reportPressure();
      }
    },
    maintainPressure,
    async reveal(): Promise<void> {
      await drain();
    },
    snapshot(): TerminalOutputSnapshot {
      return {
        roomId: options.roomId,
        paneId: options.paneId,
        bufferedBytes,
        bufferedEvents: buffer.length,
        pendingPrefillBytes,
        pendingPrefillEvents,
        writtenBytes,
        writtenEvents,
        totalBufferedBytes: totalBufferedBytes()
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const hadPendingPrefill = pendingPrefillEvents > 0;
      writing = false;
      buffer.length = 0;
      bufferedBytes = 0;
      pendingPrefillBytes = 0;
      pendingPrefillEvents = 0;
      if (hadPendingPrefill) reportPendingPrefill();
      bufferedBytesByPane.delete(key);
      clearResolvedTotalPressureLimits();
      resolveDrainWaiters();
    }
  };
}
