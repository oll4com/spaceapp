import { emitAppDiagnosticsPerformance } from "../../app-diagnostics/app-diagnostics-performance.js";

export const TERMINAL_HIDDEN_PANE_BUFFER_LIMIT_BYTES = 128 * 1024;
export const TERMINAL_HIDDEN_TOTAL_BUFFER_LIMIT_BYTES = 1024 * 1024;
const TERMINAL_REVEAL_BATCH_LIMIT_BYTES = 1024 * 1024;
const ESCAPE = "\u001b";
const OSC_66_PREFIX = `${ESCAPE}]66;`;
const OSC_STRING_TERMINATOR = `${ESCAPE}\\`;
const OSC_BELL_TERMINATOR = "\u0007";
const OSC_66_MAX_PENDING_CHARS = 16 * 1024;

export type TerminalOutputWriteMode = "VISIBLE" | "PREFILL";

function osc66PrefixSuffixLength(data: string): number {
  const maximum = Math.min(data.length, OSC_66_PREFIX.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    if (OSC_66_PREFIX.startsWith(data.slice(-length))) return length;
  }
  return 0;
}

function osc66Terminator(data: string, fromIndex: number): { index: number; length: number } | null {
  const bellIndex = data.indexOf(OSC_BELL_TERMINATOR, fromIndex);
  const stringTerminatorIndex = data.indexOf(OSC_STRING_TERMINATOR, fromIndex);
  if (bellIndex < 0 && stringTerminatorIndex < 0) return null;
  if (bellIndex >= 0 && (stringTerminatorIndex < 0 || bellIndex < stringTerminatorIndex)) {
    return { index: bellIndex, length: 1 };
  }
  return { index: stringTerminatorIndex, length: OSC_STRING_TERMINATOR.length };
}

function osc66Payload(body: string): string | null {
  const separator = body.indexOf(";");
  if (separator <= 0) return null;
  const parameters = body.slice(0, separator);
  const payload = body.slice(separator + 1);
  if (!/^[a-z][a-z0-9_-]*=[1-9]\d{0,2}(?::[a-z][a-z0-9_-]*=[1-9]\d{0,2})*$/i.test(parameters)) {
    return null;
  }
  if (/[\u0000-\u001f\u007f-\u009f]/.test(payload)) return null;
  return payload;
}

/**
 * Some TUI renderers (observed with OpenCode/opentui run-length emission)
 * drop the CSI introducer at run boundaries, e.g. layered backgrounds
 * `ESC[48;2;10;10;10m48;2;20;20;20mESC[0m`, a cursor move after colors
 * `ESC[48;2;10;10;10m10;1HESC[0m`, or a color after a cursor move
 * `ESC[10;1H38;2;255;255;255m`. xterm.js then draws the bare params as
 * visible text. Repair the missing `ESC[` only when a complete SGR or CUP
 * immediately precedes the dangling run, so ordinary prose (which never
 * contains `ESC[...m` or `ESC[...H` directly before such params) passes
 * through byte-for-byte. The stream may also split exactly at the run
 * boundary (`...m` | `38;2;...m`), so the parser remembers a trailing
 * SGR/CUP across pushes; chained runs (`ESC[m ESC[H 38;2;...`) are repaired
 * iteratively. At narrow widths the TUI may also wrap a style run across a
 * newline (`...m38;2;25\n5;255;255m`); a newline is joined only when the
 * pieces on both sides are incomplete on their own and together form a
 * valid run, so prose such as `ESC[0m\n10;1H` still passes through.
 */
const DANGLING_TRUECOLOR_SGR_PATTERN = /(?<prefix>\x1b\[[0-9;]*[mH])(?<run>(?<tc>(?<color38>38|48|58);2;(?<r>\d{1,3});(?<g>\d{1,3});(?<b>\d{1,3})m)|(?<pal>(?:38|48|58);5;(?<n>\d{1,3})m)|(?<cup>(?<row>\d{1,4});(?<col>\d{1,4})H))/g;
const DANGLING_SGR_NEWLINE_JOIN_PATTERN = /(?<prefix>\x1b\[[0-9;]*[mH])(?<head>[0-9;]{1,20}?)\r?\n(?<tail>[0-9;]{0,20}?[mH])/g;
const DANGLING_SGR_OPEN_PATTERN = /^\x1b\[[0-9;]*$/;
const DANGLING_SGR_PREFIX_PATTERN = /^\x1b\[[0-9;]*[mH](?:(?:38|48|58)(?:;[25](?:;\d{1,3}){0,2})?;?\d{0,3}|\d{1,4}(?:;\d{0,4})?)\r?\n?$/;
// A wrapped run whose newline already arrived but whose tail params are
// still split across pushes (`...m38;2;25\n5` | `;255;255m`): hold from the
// SGR so the join stays contiguous. The head requires at least one param
// char, so a bare `SGR\nCOMPLETE-RUN` (ordinary prose layout) never holds.
const DANGLING_SGR_PREFIX_NEWLINE_PATTERN = /^\x1b\[[0-9;]*[mH][0-9;]{1,20}\r?\n[0-9;]{0,20}$/;
const DANGLING_SGR_MAX_HOLD_CHARS = 64;
const DANGLING_LEADING_TRUECOLOR_PATTERN = /^(38|48|58);2;(\d{1,3});(\d{1,3});(\d{1,3})m/;
const DANGLING_LEADING_PALETTE_PATTERN = /^(38|48|58);5;(\d{1,3})m/;
const DANGLING_LEADING_CUP_PATTERN = /^(\d{1,4});(\d{1,4})H/;
const DANGLING_LEADING_PARTIAL_PATTERN = /^(?:(?:38|48|58)(?:;[25](?:;\d{1,3}){0,2})?;?\d{0,3}|\d{1,4}(?:;\d{0,4})?)$/;
const DANGLING_LEADING_PARTIAL_NEWLINE_PATTERN = /^((?:38|48|58)(?:;[25](?:;\d{1,3}){0,2})?;?\d{0,3}|\d{1,4}(?:;\d{0,4})?)(\r?\n)$/;
const DANGLING_LEADING_MAX_HOLD_CHARS = 16;
const DANGLING_TRAILING_SGR_PATTERN = /\x1b\[[0-9;]*[mH]$/;

function inTruecolorRange(value: string): boolean {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 255;
}

function isCompleteDanglingRun(params: string): boolean {
  const truecolor = /^(38|48|58);2;(\d{1,3});(\d{1,3});(\d{1,3})m$/.exec(params);
  if (truecolor) {
    return (
      inTruecolorRange(truecolor[2] ?? "") &&
      inTruecolorRange(truecolor[3] ?? "") &&
      inTruecolorRange(truecolor[4] ?? "")
    );
  }
  const palette = /^(38|48|58);5;(\d{1,3})m$/.exec(params);
  if (palette) return inTruecolorRange(palette[2] ?? "");
  return /^\d{1,4};\d{1,4}H$/.test(params);
}

/**
 * Leading run prefix with trailing text preserved: returns the run when
 * `text` starts with a valid dangling run, so wrapped reassembly keeps
 * whatever follows the run (prose, newlines) byte-for-byte.
 */
function matchLeadingRunPrefix(text: string): string | null {
  const run = /^(?:(?:38|48|58);2;\d{1,3};\d{1,3};\d{1,3}m|(?:38|48|58);5;\d{1,3}m|\d{1,4};\d{1,4}H)/.exec(text)?.[0];
  if (!run) return null;
  if (run.endsWith("m") && !isCompleteDanglingRun(run)) return null;
  return run;
}

/**
 * Rejoin a leading run split across newline(s) (`38;2;25\n5;255;255m`).
 * Removes only newlines strictly inside the run span — at least one run
 * char must precede the newline — and preserves everything after the run,
 * so a newline before a complete run (`\n10;1H`, ordinary prose layout
 * after a reset) never repairs.
 */
function repairLeadingWrappedRun(input: string): string | null {
  let candidate = input;
  for (let step = 0; step < 2; step += 1) {
    const nl = candidate.indexOf("\n");
    if (nl < 0) break;
    const cut = candidate[nl - 1] === "\r" ? 2 : 1;
    if (nl - cut + 1 <= 0) break;
    const without = candidate.slice(0, nl - cut + 1) + candidate.slice(nl + 1);
    const run = matchLeadingRunPrefix(without);
    if (run !== null && nl - cut + 1 < run.length) {
      candidate = without;
    } else {
      break;
    }
  }
  if (candidate === input) return null;
  return matchLeadingRunPrefix(candidate) !== null ? `\x1b[${candidate}` : null;
}

export function repairDanglingSgrSequences(data: string): string {
  let current = data;
  for (let pass = 0; pass < 5; pass += 1) {
    DANGLING_SGR_NEWLINE_JOIN_PATTERN.lastIndex = 0;
    const joined = current.replace(
      DANGLING_SGR_NEWLINE_JOIN_PATTERN,
      (match: string, prefix: string, head: string, tail: string) => {
        if (isCompleteDanglingRun(tail)) return match;
        const run = `${head}${tail}`;
        return isCompleteDanglingRun(run) ? `${prefix}${run}` : match;
      }
    );
    DANGLING_SGR_NEWLINE_JOIN_PATTERN.lastIndex = 0;
    DANGLING_TRUECOLOR_SGR_PATTERN.lastIndex = 0;
    const repaired = joined.replace(
      DANGLING_TRUECOLOR_SGR_PATTERN,
      (...args: Array<string | Record<string, string | undefined>>) => {
        const groups = (args.at(-1) ?? {}) as Record<string, string | undefined>;
        const match = args[0] as string;
        const prefix = groups["prefix"] ?? "";
        const params = groups["run"] ?? "";
        const r = groups["r"];
        if (r !== undefined) {
          return inTruecolorRange(r) &&
            inTruecolorRange(groups["g"] ?? "") &&
            inTruecolorRange(groups["b"] ?? "")
            ? `${prefix}\x1b[${params}`
            : match;
        }
        const n = groups["n"];
        if (n !== undefined) return inTruecolorRange(n) ? `${prefix}\x1b[${params}` : match;
        return `${prefix}\x1b[${params}`;
      }
    );
    DANGLING_TRUECOLOR_SGR_PATTERN.lastIndex = 0;
    if (repaired === current) return repaired;
    current = repaired;
  }
  return current;
}

export function createDanglingSgrRepairParser() {
  let pending = "";
  let pendingNeedsIntroducer = false;
  let prevEndsWithSgr = false;

  const repairLeadingDangling = (input: string): string | null => {
    const truecolor = DANGLING_LEADING_TRUECOLOR_PATTERN.exec(input);
    if (truecolor) {
      if (!inTruecolorRange(truecolor[2] ?? "") || !inTruecolorRange(truecolor[3] ?? "") || !inTruecolorRange(truecolor[4] ?? "")) {
        return null;
      }
      return `\x1b[${input}`;
    }
    const palette = DANGLING_LEADING_PALETTE_PATTERN.exec(input);
    if (palette) {
      if (!inTruecolorRange(palette[2] ?? "")) return null;
      return `\x1b[${input}`;
    }
    if (DANGLING_LEADING_CUP_PATTERN.test(input)) {
      return `\x1b[${input}`;
    }
    return null;
  };

  return {
    push(data: string): string {
      let input = pending + data;
      const heldNeedsIntroducer = pendingNeedsIntroducer;
      const heldAfterSgr = prevEndsWithSgr && pending === "";
      pending = "";
      pendingNeedsIntroducer = false;
      if ((heldNeedsIntroducer || heldAfterSgr) && input.length > 0 && !input.startsWith("\x1b")) {
        const repairedLeading = repairLeadingDangling(input);
        if (repairedLeading !== null) {
          input = repairedLeading;
        } else if (input.includes("\n")) {
          // A style run wrapped across newline(s) (`38;2;25\n5;255;255m`):
          // rejoin only newlines strictly inside the run span, so ordinary
          // prose after a reset still passes through untouched.
          const repairedWrapped = repairLeadingWrappedRun(input);
          if (repairedWrapped !== null) {
            input = repairedWrapped;
          } else {
            // Hold a partial head plus its newline (`...m38;2;25\n`) so the
            // next push can complete the run instead of leaking both halves.
            const wrapped = DANGLING_LEADING_PARTIAL_NEWLINE_PATTERN.exec(input);
            if (
              wrapped &&
              input.length <= DANGLING_LEADING_MAX_HOLD_CHARS + 2 &&
              !isCompleteDanglingRun(wrapped[1] ?? "")
            ) {
              pending = input;
              pendingNeedsIntroducer = true;
              prevEndsWithSgr = false;
              return "";
            }
          }
        } else if (
          input.length <= DANGLING_LEADING_MAX_HOLD_CHARS &&
          DANGLING_LEADING_PARTIAL_PATTERN.test(input)
        ) {
          pending = input;
          pendingNeedsIntroducer = true;
          prevEndsWithSgr = false;
          return "";
        }
      }
      const repaired = repairDanglingSgrSequences(input);
      // Hold back only a tail that can still grow into a repair: a partial
      // SGR open, a complete SGR followed by a partial dangling prefix, or
      // a wrapped run whose newline arrived before its tail params.
      // The hold stays anchored at the SGR open so the preceding SGR and the
      // dangling params remain contiguous for the next push.
      const escIndex = repaired.lastIndexOf("\x1b[");
      if (escIndex >= 0) {
        const tail = repaired.slice(escIndex);
        if (
          tail.length <= DANGLING_SGR_MAX_HOLD_CHARS &&
          (DANGLING_SGR_OPEN_PATTERN.test(tail) ||
            DANGLING_SGR_PREFIX_PATTERN.test(tail) ||
            DANGLING_SGR_PREFIX_NEWLINE_PATTERN.test(tail))
        ) {
          pending = tail;
          const emitted = repaired.slice(0, escIndex);
          prevEndsWithSgr = DANGLING_TRAILING_SGR_PATTERN.test(emitted);
          return emitted;
        }
      }
      if (repaired.endsWith("\x1b")) {
        pending = "\x1b";
        const emitted = repaired.slice(0, -1);
        prevEndsWithSgr = DANGLING_TRAILING_SGR_PATTERN.test(emitted);
        return emitted;
      }
      prevEndsWithSgr = DANGLING_TRAILING_SGR_PATTERN.test(repaired);
      return repaired;
    },
    flush(): string {
      const remainder = pending;
      pending = "";
      pendingNeedsIntroducer = false;
      prevEndsWithSgr = false;
      return remainder;
    }
  };
}

/**
 * Newer OpenCode TUIs wrap explicit-width Unicode glyphs in OSC 66. xterm.js
 * consumes unsupported OSC payloads without drawing them, so unwrap valid text
 * while preserving every unrelated control sequence byte-for-byte.
 */
export function createTerminalOutputCompatibilityParser(
  options: { maxPendingChars?: number } = {}
) {
  const maxPendingChars = Math.max(256, options.maxPendingChars ?? OSC_66_MAX_PENDING_CHARS);
  let pending = "";

  return {
    push(data: string): string {
      const input = pending + data;
      pending = "";
      let output = "";
      let cursor = 0;
      while (cursor < input.length) {
        const start = input.indexOf(OSC_66_PREFIX, cursor);
        if (start < 0) {
          const remainder = input.slice(cursor);
          const retainedLength = osc66PrefixSuffixLength(remainder);
          output += retainedLength > 0 ? remainder.slice(0, -retainedLength) : remainder;
          if (retainedLength > 0) pending = remainder.slice(-retainedLength);
          break;
        }
        output += input.slice(cursor, start);
        const bodyStart = start + OSC_66_PREFIX.length;
        const terminator = osc66Terminator(input, bodyStart);
        if (!terminator) {
          pending = input.slice(start);
          if (pending.length > maxPendingChars) {
            output += pending;
            pending = "";
          }
          break;
        }
        const end = terminator.index + terminator.length;
        const payload = osc66Payload(input.slice(bodyStart, terminator.index));
        output += payload ?? input.slice(start, end);
        cursor = end;
      }
      return output;
    },
    flush(): string {
      const remainder = pending;
      pending = "";
      return remainder;
    }
  };
}

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
  const outputCompatibilityParser = createTerminalOutputCompatibilityParser();
  const danglingSgrRepairParser = createDanglingSgrRepairParser();
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
        const compatibleData = outputCompatibilityParser.push(next.data);
        const repairedData = danglingSgrRepairParser.push(compatibleData);
        const returned = repairedData ? options.write(repairedData, done, mode) : undefined;
        if (!repairedData) done();
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
