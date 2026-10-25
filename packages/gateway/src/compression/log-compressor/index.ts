/**
 * Log/build-output compressor (pytest, npm, cargo, jest, make, generic). TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/log_compressor.rs` (Apache-2.0, Headroom Contributors), the implementation
 * behind Headroom 0.37's Python `LogCompressor`; checked against Headroom's parity fixtures.
 *
 * Pipeline: detect the format, classify each line (level, stack-trace membership, summary), score it, size the
 * output adaptively, keep errors (first/last/top), fails, deduped warnings, stack traces (oversized ones with
 * runtime frames collapsed) and summaries plus context lines, cap by score, and append a CCR retrieval marker
 * when the result is under half the original size.
 */
import { createHash } from "node:crypto";
import { computeOptimalK } from "./adaptive-sizer.js";
import { classifyLevel, detectLogFormat, isSummaryLine, type LogFormat, type LogLevel } from "./classify.js";
import { byteLength } from "./rust-text.js";
import { collapseTraceFrames, traceFlavorFor, traceTerminates, type LogLine, type TraceFlavor } from "./stack-trace.js";

export { detectLogFormat, type LogFormat, type LogLevel } from "./classify.js";
export type { LogLine } from "./stack-trace.js";

export interface LogCompressorConfig {
  maxErrors: number;
  errorContextLines: number;
  keepFirstError: boolean;
  keepLastError: boolean;
  maxStackTraces: number;
  stackTraceMaxLines: number;
  maxWarnings: number;
  dedupeWarnings: boolean;
  keepSummaryLines: boolean;
  maxTotalLines: number;
  enableCcr: boolean;
  /** Logs with fewer lines are returned verbatim. */
  minLinesForCcr: number;
  /** The CCR marker is added only when `compressed / original` (UTF-8 bytes) is below this. */
  minCompressionRatioForCcr: number;
  /** Collapse runtime/stdlib frames of traces longer than `stackTraceMaxLines` instead of truncating the tail. */
  collapseRuntimeFrames: boolean;
  /** Frames always kept at the top of a collapsed trace. */
  traceHeadFrames: number;
  /** App-code frames kept beyond the head of a collapsed trace. */
  traceAppFrames: number;
}

export const DEFAULT_LOG_COMPRESSOR_CONFIG: Readonly<LogCompressorConfig> = Object.freeze({
  maxErrors: 10,
  errorContextLines: 3,
  keepFirstError: true,
  keepLastError: true,
  maxStackTraces: 3,
  stackTraceMaxLines: 20,
  maxWarnings: 5,
  dedupeWarnings: true,
  keepSummaryLines: true,
  maxTotalLines: 100,
  enableCcr: true,
  minLinesForCcr: 50,
  minCompressionRatioForCcr: 0.5,
  collapseRuntimeFrames: true,
  traceHeadFrames: 3,
  traceAppFrames: 5
});

/** Per-level counts over all lines; empty when the log was returned verbatim. */
export interface LogCompressionStats {
  errors?: number;
  fails?: number;
  info?: number;
  selected?: number;
  total?: number;
  warnings?: number;
}

/** Same fields as Headroom's `LogCompressionResult`, in camelCase. */
export interface LogCompressionResult {
  compressed: string;
  original: string;
  originalLineCount: number;
  compressedLineCount: number;
  formatDetected: LogFormat;
  /** UTF-8 byte length of the compressed body (before the CCR marker) over the original. */
  compressionRatio: number;
  /** `md5(original)[:24]` when a CCR marker was appended. */
  cacheKey: string | null;
  stats: LogCompressionStats;
}

/** Receives the original text under the cache key embedded in the CCR marker. */
export interface LogCcrStore {
  put(cacheKey: string, original: string): void;
}

export interface CompressLogOptions {
  config?: Partial<LogCompressorConfig>;
  /** Multiplier on the adaptive line budget (>1 keeps more). Default 1. */
  bias?: number;
  /** Optional sink for the original. The marker and `cacheKey` are emitted either way, as Headroom's Python API does. */
  store?: LogCcrStore;
  /** Lines kept whatever the caps say (Space Gateway: test failures, assertions and counts); upstream has no such hook. */
  protect?: (line: string) => boolean;
}

export function compressLog(content: string, options: CompressLogOptions = {}): LogCompressionResult {
  const config: LogCompressorConfig = { ...DEFAULT_LOG_COMPRESSOR_CONFIG, ...options.config };
  const lines = content.split("\n");
  const originalLineCount = lines.length;

  if (originalLineCount < config.minLinesForCcr) {
    return { compressed: content, original: content, originalLineCount, compressedLineCount: originalLineCount, formatDetected: "generic", compressionRatio: 1, cacheKey: null, stats: {} };
  }

  const formatDetected = detectLogFormat(lines);
  const logLines = parseLogLines(lines, config);
  const selected = selectLines(logLines, options.bias ?? 1, config, options.protect);
  const { text, stats } = formatOutput(selected, logLines);
  const compressionRatio = byteLength(text) / Math.max(byteLength(content), 1);

  let compressed = text;
  let cacheKey: string | null = null;
  if (config.enableCcr && compressionRatio < config.minCompressionRatioForCcr) {
    const key = createHash("md5").update(content, "utf8").digest("hex").slice(0, 24);
    options.store?.put(key, content);
    compressed += `\n[${originalLineCount} lines compressed to ${selected.length}. Retrieve more: hash=${key}]`;
    cacheKey = key;
  }

  return { compressed, original: content, originalLineCount, compressedLineCount: selected.length, formatDetected, compressionRatio, cacheKey, stats };
}

// ─── Parsing ───────────────────────────────────────────────────────────

const levelScores: Record<LogLevel, number> = { error: 1, fail: 1, warn: 0.5, info: 0.1, unknown: 0.1, debug: 0.05, trace: 0.02 };

/** Level base + 0.3 for stack-trace lines + 0.4 for summaries, capped at 1, in f32 arithmetic like upstream. */
function scoreLine(line: LogLine): number {
  const f32 = Math.fround;
  const withStack = f32(f32(levelScores[line.level]) + (line.isStackTrace ? f32(0.3) : 0));
  return Math.min(f32(withStack + (line.isSummary ? f32(0.4) : 0)), 1);
}

/**
 * Classify every line. The stack-trace state machine opens on a flavor's opener and marks lines until that
 * flavor terminates or `stackTraceMaxLines` is reached; at the cap, a line that still continues the trace
 * reopens it so the selection stage sees one contiguous trace.
 */
export function parseLogLines(lines: readonly string[], config: LogCompressorConfig): LogLine[] {
  let active: TraceFlavor | null = null;
  let traceLines = 0;
  return lines.map((content, lineNumber) => {
    const entry: LogLine = { lineNumber, content, level: classifyLevel(content), isStackTrace: false, isSummary: isSummaryLine(content), score: 0 };
    if (active !== null) {
      const capHit = traceLines >= config.stackTraceMaxLines;
      if (capHit || traceTerminates(active, content, traceLines)) {
        const previous: TraceFlavor = active;
        active = traceFlavorFor(content);
        traceLines = 0;
        if (active !== null) {
          // Chained traces open a new flavor on the line that ended the previous one.
          traceLines = 1;
          entry.isStackTrace = true;
        } else if (capHit && !traceTerminates(previous, content, 2)) {
          active = previous;
          traceLines = 1;
          entry.isStackTrace = true;
        }
      } else {
        entry.isStackTrace = true;
        traceLines += 1;
      }
    } else {
      active = traceFlavorFor(content);
      if (active !== null) {
        traceLines = 1;
        entry.isStackTrace = true;
      }
    }
    entry.score = scoreLine(entry);
    return entry;
  });
}

// ─── Selection ─────────────────────────────────────────────────────────

const byScoreThenLine = (a: LogLine, b: LogLine): number => b.score - a.score || a.lineNumber - b.lineNumber;
const byLine = (a: LogLine, b: LogLine): number => a.lineNumber - b.lineNumber;

function selectLines(logLines: readonly LogLine[], bias: number, config: LogCompressorConfig, protect?: (line: string) => boolean): LogLine[] {
  const adaptiveMax = computeOptimalK(logLines.map((line) => line.content), bias, 10, config.maxTotalLines);

  const errors: LogLine[] = [];
  const fails: LogLine[] = [];
  let warnings: LogLine[] = [];
  const summaries: LogLine[] = [];
  const stackTraces: LogLine[][] = [];
  let currentStack: LogLine[] = [];
  for (const line of logLines) {
    if (line.level === "error") errors.push(line);
    else if (line.level === "fail") fails.push(line);
    else if (line.level === "warn") warnings.push(line);
    if (line.isStackTrace) {
      currentStack.push(line);
    } else if (currentStack.length > 0) {
      stackTraces.push(currentStack);
      currentStack = [];
    }
    if (line.isSummary) summaries.push(line);
  }
  if (currentStack.length > 0) stackTraces.push(currentStack);

  // Keyed by line number; the first entry inserted for a line wins (upstream BTreeSet semantics).
  const selected = new Map<number, LogLine>();
  const insert = (line: LogLine) => {
    if (!selected.has(line.lineNumber)) selected.set(line.lineNumber, line);
  };

  selectWithFirstLast(errors, config.maxErrors, config).forEach(insert);
  selectWithFirstLast(fails, config.maxErrors, config).forEach(insert);
  // Protected test lines bypass the error cap here and the final cap below; they get context like any kept line.
  const protectedLines = protect ? logLines.filter((line) => protect(line.content)) : [];
  protectedLines.forEach(insert);
  if (config.dedupeWarnings) warnings = dedupeSimilar(warnings);
  warnings.slice(0, config.maxWarnings).forEach(insert);

  const collapsedFrames = new Set<number>();
  for (const stack of stackTraces.slice(0, config.maxStackTraces)) {
    if (config.collapseRuntimeFrames && stack.length > config.stackTraceMaxLines) {
      const collapsed = collapseTraceFrames(stack, config.traceHeadFrames, config.traceAppFrames);
      collapsed.droppedIndices.forEach((index) => collapsedFrames.add(index));
      collapsed.kept.slice(0, config.stackTraceMaxLines).forEach(insert);
    } else {
      stack.slice(0, config.stackTraceMaxLines).forEach(insert);
    }
  }

  if (config.keepSummaryLines) summaries.forEach(insert);

  // Context around every selected line; deliberately collapsed frames must not ride back in as context.
  const selectedIndices = new Set(selected.keys());
  const contextIndices = new Set<number>();
  for (const index of selectedIndices) {
    const low = Math.max(0, index - config.errorContextLines);
    const high = Math.min(index + config.errorContextLines + 1, logLines.length);
    for (let context = low; context < high; context += 1) {
      if (context !== index) contextIndices.add(context);
    }
  }
  for (const index of [...contextIndices].sort((a, b) => a - b)) {
    if (!selectedIndices.has(index) && index < logLines.length && !collapsedFrames.has(index)) insert(logLines[index]!);
  }

  let ordered = [...selected.values()].sort(byLine);
  if (ordered.length > adaptiveMax) {
    const pinned = new Set(protectedLines.map((line) => line.lineNumber));
    const rest = ordered.filter((line) => !pinned.has(line.lineNumber)).sort(byScoreThenLine).slice(0, Math.max(0, adaptiveMax - pinned.size));
    ordered = [...protectedLines, ...rest].sort(byLine);
  }
  return ordered;
}

/** All lines when they fit; otherwise first and last (per config), then the highest scores. */
function selectWithFirstLast(lines: readonly LogLine[], maxCount: number, config: LogCompressorConfig): LogLine[] {
  if (lines.length <= maxCount) return [...lines];
  const out: LogLine[] = [];
  const seen = new Set<number>();
  const push = (line: LogLine) => {
    if (seen.has(line.lineNumber)) return;
    seen.add(line.lineNumber);
    out.push(line);
  };
  if (config.keepFirstError) push(lines[0]!);
  if (config.keepLastError) push(lines[lines.length - 1]!);
  if (out.length < maxCount) {
    for (const line of [...lines].sort(byScoreThenLine)) {
      if (seen.has(line.lineNumber)) continue;
      push(line);
      if (out.length >= maxCount) break;
    }
  }
  return out;
}

/**
 * Drop warnings whose normalised text was already seen. Only the part from the first `:` or `=` on is
 * normalised (digits, then hex, then paths), so distinct messages that share a variable tail stay distinct.
 */
function dedupeSimilar(lines: readonly LogLine[]): LogLine[] {
  const seen = new Set<string>();
  return lines.filter((line) => {
    const key = normalizeForDedupe(line.content);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Rust's `\d` and `\w` are Unicode-aware.
const digitRun = /\p{Nd}+/gu;
const hexAddress = /0x[0-9a-fA-F]+/gu;
const pathRun = /\/[\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}\/]+\//gu;

function normalizeForDedupe(content: string): string {
  const split = content.search(/[:=]/);
  const at = split < 0 ? content.length : split;
  const suffix = content.slice(at).replace(digitRun, "N").replace(hexAddress, "ADDR").replace(pathRun, "/PATH/");
  return content.slice(0, at) + suffix;
}

// ─── Output ────────────────────────────────────────────────────────────

function formatOutput(selected: readonly LogLine[], allLines: readonly LogLine[]): { text: string; stats: LogCompressionStats } {
  const count = (level: LogLevel) => allLines.filter((line) => line.level === level).length;
  const stats = { errors: count("error"), fails: count("fail"), info: count("info"), selected: selected.length, total: allLines.length, warnings: count("warn") };
  const output = selected.map((line) => line.content);
  const omitted = Math.max(0, allLines.length - selected.length);
  if (omitted > 0) {
    const parts = ([["ERROR", stats.errors], ["FAIL", stats.fails], ["WARN", stats.warnings], ["INFO", stats.info]] as const)
      .filter(([, value]) => value > 0)
      .map(([label, value]) => `${value} ${label}`);
    if (parts.length > 0) output.push(`[${omitted} lines omitted: ${parts.join(", ")}]`);
  }
  return { text: output.join("\n"), stats };
}
