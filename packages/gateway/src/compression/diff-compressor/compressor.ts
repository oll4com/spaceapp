/**
 * Unified-diff compressor. TypeScript port of Headroom `crates/headroom-core/src/transforms/diff_compressor.rs`
 * v0.37.0 (Apache-2.0, Headroom Contributors), itself the Rust port of `headroom.transforms.diff_compressor`.
 * Same parser, relevance scorer, hunk/file caps, context trim, output format and CCR marker; checked byte for
 * byte against Headroom's parity fixtures.
 *
 * 1. Split on `\n` and pass short inputs (`< min_lines_for_ccr`) and non-diffs through unchanged.
 * 2. Parse `diff --git` / `diff --combined` / `diff --cc` sections into files and `@@` / `@@@` / `@@@@` hunks,
 *    keeping pre-diff content (commit or email headers) and rename/copy markers verbatim.
 * 3. Above `max_files`, keep the files with the most changes. Above `max_hunks_per_file`, keep the first, the
 *    last and the best-scored middle hunks (change density, query-word overlap, error/security keywords).
 * 4. Keep `max_context_lines` of context around each change plus every `\ No newline` marker.
 * 5. Append a summary footer, and a CCR retrieval marker keyed by MD5(original)[:24] when the output has fewer
 *    than `min_compression_ratio_for_ccr` of the original lines.
 *
 * Public field names mirror Headroom's (`snake_case`), so a result equals a parity fixture's `output` and a
 * fixture `config` can be passed straight in.
 */
import { createHash } from "node:crypto";
import { compareUtf8, formatRustFixed, parseRustUsize, rustWordBounded, splitRustWhitespace, utf8ByteLength } from "./rust-compat.js";

/** Per-change weight of the change-density base score: `min(CAP, changes * WEIGHT)`. */
export const SCORE_CHANGE_DENSITY_WEIGHT = 0.03;
/** Cap on the change-density base score. */
export const SCORE_CHANGE_DENSITY_CAP = 0.3;
/** Boost per query word (or CJK bigram) found in the hunk, case-insensitively. */
export const SCORE_CONTEXT_WORD_WEIGHT = 0.2;
/** Query words of at most this many UTF-8 bytes are ignored. */
export const SCORE_CONTEXT_MIN_WORD_LEN = 2;
/** Boost when any priority pattern matches (once per hunk). */
export const SCORE_PRIORITY_PATTERN_BOOST = 0.3;
/** Cap on the total hunk score. */
export const SCORE_TOTAL_CAP = 1;

export interface DiffCompressorConfig {
  /** Context lines kept on either side of each `+`/`-` line. */
  max_context_lines: number;
  /** Hunks kept per file; above it, first + last + top-scored middle hunks survive. */
  max_hunks_per_file: number;
  /** Files kept; above it, the files with the most changes survive. */
  max_files: number;
  /** Reserved upstream (additions are always kept); accepted for config compatibility. */
  always_keep_additions: boolean;
  /** Reserved upstream (deletions are always kept); accepted for config compatibility. */
  always_keep_deletions: boolean;
  /** Append the CCR retrieval marker when compression clears the savings threshold. */
  enable_ccr: boolean;
  /** Minimum input line count before any compression runs (upstream name; it gates everything, not just CCR). */
  min_lines_for_ccr: number;
  /** CCR marker only when `compressed_lines < original_lines * ratio` (Rust-only knob, Python hardcodes 0.8). */
  min_compression_ratio_for_ccr: number;
}

export const DEFAULT_DIFF_COMPRESSOR_CONFIG: Readonly<DiffCompressorConfig> = Object.freeze({
  max_context_lines: 2,
  max_hunks_per_file: 10,
  max_files: 20,
  always_keep_additions: true,
  always_keep_deletions: true,
  enable_ccr: true,
  min_lines_for_ccr: 50,
  min_compression_ratio_for_ccr: 0.8
});

/** Same fields as Headroom's `DiffCompressionResult` (and a parity fixture's `output`). */
export interface DiffCompressionResult {
  compressed: string;
  original_line_count: number;
  /** Lines of `compressed` before the CCR marker was appended (upstream counts it that way). */
  compressed_line_count: number;
  files_affected: number;
  additions: number;
  deletions: number;
  hunks_kept: number;
  hunks_removed: number;
  cache_key: string | null;
}

/** Observability sidecar (Headroom's Rust-only `DiffCompressorStats`); not part of the parity output. */
export interface DiffCompressorStats {
  input_lines: number;
  output_lines: number;
  /** `output_lines / input_lines`; 1 when nothing was compressed. */
  compression_ratio: number;
  files_total: number;
  files_kept: number;
  /** `old -> new` labels of files dropped by `max_files`. */
  files_dropped: string[];
  hunks_total: number;
  hunks_kept: number;
  hunks_dropped: number;
  /** Hunks dropped per `old -> new` label, keys in UTF-8 byte order (Rust `BTreeMap`). */
  hunks_dropped_per_file: Record<string, number>;
  context_lines_input: number;
  context_lines_kept: number;
  context_lines_trimmed: number;
  largest_hunk_kept_lines: number;
  largest_hunk_dropped_lines: number;
  /** `[label, original mode line]` for mode lines the output normalized to `100644`. */
  file_mode_normalizations: [string, string][];
  /** Original `Binary files ... differ` lines the output simplified to `Binary files differ`. */
  binary_files_simplified: string[];
  parse_warnings: string[];
  processing_duration_us: number;
  cache_key_emitted: boolean;
  ccr_skipped_reason: string | null;
}

/** Destination for the original payload under the emitted `cache_key` (Headroom's `CcrStore::put`). */
export interface CcrStore {
  put(hash: string, payload: string): void;
}

export interface DiffCompression {
  result: DiffCompressionResult;
  stats: DiffCompressorStats;
}

interface DiffHunk {
  header: string;
  lines: string[];
  additions: number;
  deletions: number;
  contextLines: number;
  score: number;
}

interface DiffFile {
  header: string;
  oldFile: string;
  newFile: string;
  hunks: DiffHunk[];
  isBinary: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  renameLines: string[];
  originalNewFileModeLine: string | null;
  originalDeletedFileModeLine: string | null;
  originalBinaryLine: string | null;
}

interface ParsedDiff {
  preDiffLines: string[];
  files: DiffFile[];
  parseWarnings: string[];
}

// Rust `regex` is Unicode-aware: `\d` is `\p{Nd}` and `.` matches everything but `\n` (hence the `s` flag).
const DIGITS = "\\p{Nd}+";
const RANGE = `${DIGITS}(?:,${DIGITS})?`;
/** `@@` hunks plus the combined-diff `@@@` (3-way) and `@@@@` (4-way) merge forms. */
const HUNK_HEADER = new RegExp(`^(?:@@ -${RANGE} \\+${RANGE} @@|@@@ -${RANGE} -${RANGE} \\+${RANGE} @@@|@@@@ -${RANGE} -${RANGE} -${RANGE} \\+${RANGE} @@@@)`, "u");
/** First `+N` in a hunk header: the new-file start line, used to restore hunk order. */
const HUNK_NEW_START = new RegExp(`\\+(${DIGITS})`, "u");
const DIFF_GIT = /^diff --git a\/.+ b\/.+$/su;
const DIFF_COMBINED = /^diff --combined .+$/su;
const DIFF_CC = /^diff --cc .+$/su;
const OLD_FILE = /^--- (?:a\/.+|\/dev\/null)$/su;
const NEW_FILE = /^\+\+\+ (?:b\/.+|\/dev\/null)$/su;
const BINARY = /^Binary files .+ differ$/su;

/** Headroom `PRIORITY_PATTERNS_DIFF`: error, importance and security keywords (Unicode `\b`, `(?i)`). */
const PRIORITY_PATTERNS = [
  "error|exception|fail(?:ed|ure)?|fatal|critical|crash|panic",
  "important|note|todo|fixme|hack|xxx|bug|fix",
  "security|auth|password|secret|token"
].map((alternation) => new RegExp(rustWordBounded(alternation), "iu"));

/** Compresses `content`; `context` is the user query used to rank hunks when `max_hunks_per_file` fires. */
export function compressDiff(content: string, context = "", config: Partial<DiffCompressorConfig> = {}): DiffCompressionResult {
  return compressDiffWithStats(content, context, config).result;
}

/**
 * Same as {@link compressDiff} plus the observability stats. When `store` is given and a CCR marker is
 * emitted, the original `content` is stored under the marker's `cache_key` so the marker resolves.
 */
export function compressDiffWithStats(content: string, context = "", config: Partial<DiffCompressorConfig> = {}, store?: CcrStore): DiffCompression {
  const settings = resolveConfig(config);
  const started = performance.now();
  const stats = emptyStats();
  const finish = (result: DiffCompressionResult): DiffCompression => {
    stats.processing_duration_us = Math.floor((performance.now() - started) * 1000);
    return { result, stats };
  };

  const lines = content.split("\n");
  const originalLineCount = lines.length;
  stats.input_lines = originalLineCount;

  if (originalLineCount < settings.min_lines_for_ccr) {
    stats.output_lines = originalLineCount;
    stats.compression_ratio = 1;
    stats.ccr_skipped_reason = "input below min_lines_for_ccr";
    return finish(passThrough(content, originalLineCount));
  }

  const parsed = parseDiff(lines);
  let files = parsed.files;
  stats.parse_warnings = parsed.parseWarnings;
  stats.files_total = files.length;
  stats.hunks_total = sum(files, (file) => file.hunks.length);
  stats.context_lines_input = sum(files, (file) => sum(file.hunks, (hunk) => hunk.contextLines));

  if (files.length === 0) {
    stats.output_lines = originalLineCount;
    stats.compression_ratio = 1;
    stats.ccr_skipped_reason = "no diff sections parsed";
    return finish(passThrough(content, originalLineCount));
  }

  scoreHunks(files, context ?? "");

  if (files.length > settings.max_files) {
    // Stable sort, most changes first, like Rust `sort_by`.
    files = [...files].sort((left, right) => totalChanges(right) - totalChanges(left));
    stats.files_dropped = files.slice(settings.max_files).map(fileLabel);
    files = files.slice(0, settings.max_files);
  }
  stats.files_kept = files.length;

  for (const file of files) {
    const label = fileLabel(file);
    if (file.originalNewFileModeLine !== null && file.originalNewFileModeLine !== "new file mode 100644") {
      stats.file_mode_normalizations.push([label, file.originalNewFileModeLine]);
    }
    if (file.originalDeletedFileModeLine !== null && file.originalDeletedFileModeLine !== "deleted file mode 100644") {
      stats.file_mode_normalizations.push([label, file.originalDeletedFileModeLine]);
    }
    if (file.originalBinaryLine !== null && file.originalBinaryLine !== "Binary files differ") {
      stats.binary_files_simplified.push(file.originalBinaryLine);
    }
  }

  const compressedFiles: DiffFile[] = [];
  const droppedPerFile = new Map<string, number>();
  let totalAdditions = 0;
  let totalDeletions = 0;
  let hunksKept = 0;
  let hunksRemoved = 0;
  let largestKept = 0;
  let largestDropped = 0;
  let contextKept = 0;

  for (const file of files) {
    totalAdditions += sum(file.hunks, (hunk) => hunk.additions);
    totalDeletions += sum(file.hunks, (hunk) => hunk.deletions);
    const { selected, dropped } = selectHunks(file.hunks, settings.max_hunks_per_file);
    if (dropped.length > 0) {
      droppedPerFile.set(fileLabel(file), dropped.length);
      for (const hunk of dropped) largestDropped = Math.max(largestDropped, hunk.lines.length);
    }
    const trimmed = selected.map((hunk) => reduceContext(hunk, settings.max_context_lines));
    for (const hunk of trimmed) {
      largestKept = Math.max(largestKept, hunk.lines.length);
      contextKept += hunk.contextLines;
    }
    hunksKept += trimmed.length;
    hunksRemoved += file.hunks.length - trimmed.length;
    compressedFiles.push({ ...file, hunks: trimmed });
  }

  stats.hunks_kept = hunksKept;
  stats.hunks_dropped = hunksRemoved;
  stats.hunks_dropped_per_file = Object.fromEntries([...droppedPerFile].sort(([left], [right]) => compareUtf8(left, right)));
  stats.context_lines_kept = contextKept;
  stats.context_lines_trimmed = Math.max(0, stats.context_lines_input - contextKept);
  stats.largest_hunk_kept_lines = largestKept;
  stats.largest_hunk_dropped_lines = largestDropped;

  const filesAffected = compressedFiles.length;
  let compressed = formatOutput(parsed.preDiffLines, compressedFiles, filesAffected, totalAdditions, totalDeletions, hunksRemoved);
  // Counted before the CCR marker is appended, for both the marker text and the result (upstream parity).
  const compressedLineCount = countSplitLines(compressed);
  const threshold = settings.min_compression_ratio_for_ccr;
  let cacheKey: string | null = null;
  if (settings.enable_ccr && compressedLineCount < originalLineCount * threshold) {
    cacheKey = md5Hex24(content);
    compressed += `\n[${originalLineCount} lines compressed to ${compressedLineCount}. Retrieve full diff: hash=${cacheKey}]`;
    store?.put(cacheKey, content);
    stats.cache_key_emitted = true;
  } else if (!settings.enable_ccr) {
    stats.ccr_skipped_reason = "ccr disabled";
  } else {
    const ratio = originalLineCount === 0 ? 1 : compressedLineCount / originalLineCount;
    stats.ccr_skipped_reason = `compression ratio ${formatRustFixed(ratio, 3)} above threshold ${formatRustFixed(threshold, 3)}`;
  }

  stats.output_lines = compressedLineCount;
  stats.compression_ratio = originalLineCount === 0 ? 1 : compressedLineCount / originalLineCount;
  return finish({
    compressed,
    original_line_count: originalLineCount,
    compressed_line_count: compressedLineCount,
    files_affected: filesAffected,
    additions: totalAdditions,
    deletions: totalDeletions,
    hunks_kept: hunksKept,
    hunks_removed: hunksRemoved,
    cache_key: cacheKey
  });
}

/** `hashlib.md5(text.encode()).hexdigest()[:24]`, the CCR key format. */
export function md5Hex24(text: string): string {
  return createHash("md5").update(text, "utf8").digest("hex").slice(0, 24);
}

const usizeFields = ["max_context_lines", "max_hunks_per_file", "max_files", "min_lines_for_ccr"] as const;

function resolveConfig(config: Partial<DiffCompressorConfig>): DiffCompressorConfig {
  const settings = { ...DEFAULT_DIFF_COMPRESSOR_CONFIG };
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined && Object.hasOwn(settings, key)) (settings as Record<string, unknown>)[key] = value;
  }
  for (const field of usizeFields) {
    if (!Number.isSafeInteger(settings[field]) || settings[field] < 0) throw new RangeError(`${field} must be a non-negative integer`);
  }
  return settings;
}

function emptyStats(): DiffCompressorStats {
  return {
    input_lines: 0,
    output_lines: 0,
    compression_ratio: 0,
    files_total: 0,
    files_kept: 0,
    files_dropped: [],
    hunks_total: 0,
    hunks_kept: 0,
    hunks_dropped: 0,
    hunks_dropped_per_file: {},
    context_lines_input: 0,
    context_lines_kept: 0,
    context_lines_trimmed: 0,
    largest_hunk_kept_lines: 0,
    largest_hunk_dropped_lines: 0,
    file_mode_normalizations: [],
    binary_files_simplified: [],
    parse_warnings: [],
    processing_duration_us: 0,
    cache_key_emitted: false,
    ccr_skipped_reason: null
  };
}

function passThrough(content: string, lineCount: number): DiffCompressionResult {
  return {
    compressed: content,
    original_line_count: lineCount,
    compressed_line_count: lineCount,
    files_affected: 0,
    additions: 0,
    deletions: 0,
    hunks_kept: 0,
    hunks_removed: 0,
    cache_key: null
  };
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  let total = 0;
  for (const item of items) total += value(item);
  return total;
}

const totalChanges = (file: DiffFile) => sum(file.hunks, (hunk) => hunk.additions + hunk.deletions);
const fileLabel = (file: DiffFile) => `${file.oldFile} -> ${file.newFile}`;

/** `len(text.split("\n"))` without allocating the parts. */
function countSplitLines(text: string): number {
  let count = 1;
  for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count += 1;
  return count;
}

const isDiffHeader = (line: string) => DIFF_GIT.test(line) || DIFF_COMBINED.test(line) || DIFF_CC.test(line);

function parseDiff(lines: readonly string[]): ParsedDiff {
  const files: DiffFile[] = [];
  const preDiffLines: string[] = [];
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of lines) {
    if (isDiffHeader(line)) {
      if (currentFile) {
        if (currentHunk) currentFile.hunks.push(currentHunk);
        files.push(currentFile);
      }
      currentHunk = null;
      currentFile = {
        header: line,
        oldFile: "",
        newFile: "",
        hunks: [],
        isBinary: false,
        isNewFile: false,
        isDeletedFile: false,
        renameLines: [],
        originalNewFileModeLine: null,
        originalDeletedFileModeLine: null,
        originalBinaryLine: null
      };
      continue;
    }

    // Commit or email headers before the first file section are re-emitted verbatim.
    if (!currentFile) {
      preDiffLines.push(line);
      continue;
    }

    // File-level markers are checked on every line (hunk bodies included), exactly like upstream.
    if (line.startsWith("new file mode")) {
      currentFile.isNewFile = true;
      currentFile.originalNewFileModeLine = line;
    } else if (line.startsWith("deleted file mode")) {
      currentFile.isDeletedFile = true;
      currentFile.originalDeletedFileModeLine = line;
    } else if (line.startsWith("rename ") || line.startsWith("similarity ") || line.startsWith("copy ") || line.startsWith("dissimilarity ")) {
      currentFile.renameLines.push(line);
    } else if (BINARY.test(line)) {
      currentFile.isBinary = true;
      currentFile.originalBinaryLine = line;
    }

    if (OLD_FILE.test(line)) {
      currentFile.oldFile = line;
      continue;
    }
    if (NEW_FILE.test(line)) {
      currentFile.newFile = line;
      continue;
    }
    if (HUNK_HEADER.test(line)) {
      if (currentHunk) currentFile.hunks.push(currentHunk);
      currentHunk = { header: line, lines: [], additions: 0, deletions: 0, contextLines: 0, score: 0 };
      continue;
    }

    if (currentHunk) {
      if (line.startsWith("+") && !line.startsWith("+++")) currentHunk.additions += 1;
      else if (line.startsWith("-") && !line.startsWith("---")) currentHunk.deletions += 1;
      else if (line.startsWith(" ") || line === "") currentHunk.contextLines += 1;
      // Anything else (`\ No newline at end of file`, `+++x`, junk) is kept as-is; the context trim decides.
      currentHunk.lines.push(line);
    }
  }

  if (currentFile) {
    if (currentHunk) currentFile.hunks.push(currentHunk);
    files.push(currentFile);
  }
  return { preDiffLines, files, parseWarnings: [] };
}

/** CJK ideographs, kana and Hangul. */
function isCjk(codePoint: number): boolean {
  return (codePoint >= 0x3040 && codePoint <= 0x30ff)
    || (codePoint >= 0x3400 && codePoint <= 0x4dbf)
    || (codePoint >= 0x4e00 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff);
}

/** Character bigrams of the CJK runs in `text`, so a spaceless CJK query can still boost overlapping hunks. */
export function cjkBigrams(text: string): Set<string> {
  const bigrams = new Set<string>();
  let previous: string | null = null;
  for (const char of text) {
    if (isCjk(char.codePointAt(0)!)) {
      if (previous !== null) bigrams.add(previous + char);
      previous = char;
    } else {
      previous = null;
    }
  }
  return bigrams;
}

function scoreHunks(files: readonly DiffFile[], context: string): void {
  const contextLower = context.toLowerCase();
  const contextWords = splitRustWhitespace(contextLower).filter((word) => utf8ByteLength(word) > SCORE_CONTEXT_MIN_WORD_LEN);
  const bigrams = [...cjkBigrams(contextLower)];

  for (const file of files) {
    for (const hunk of file.hunks) {
      let score = (hunk.additions + hunk.deletions) * SCORE_CHANGE_DENSITY_WEIGHT;
      if (score > SCORE_CHANGE_DENSITY_CAP) score = SCORE_CHANGE_DENSITY_CAP;
      const contentLower = hunk.lines.join("\n").toLowerCase();
      // Duplicate query words each count, like upstream's `Vec` of words.
      for (const word of contextWords) if (contentLower.includes(word)) score += SCORE_CONTEXT_WORD_WEIGHT;
      for (const bigram of bigrams) if (contentLower.includes(bigram)) score += SCORE_CONTEXT_WORD_WEIGHT;
      if (PRIORITY_PATTERNS.some((pattern) => pattern.test(contentLower))) score += SCORE_PRIORITY_PATTERN_BOOST;
      if (score > SCORE_TOTAL_CAP) score = SCORE_TOTAL_CAP;
      hunk.score = score;
    }
  }
}

/** New-file start line of a hunk header; 0 when absent or not a valid `usize` (upstream fallback). */
function extractLineNumber(header: string): bigint {
  const digits = HUNK_NEW_START.exec(header)?.[1];
  return (digits === undefined ? null : parseRustUsize(digits)) ?? 0n;
}

/**
 * Keeps first + last + the top-scored middle hunks, restored to header order. Middle ties keep their original
 * order (stable sort), and equal start lines keep the kept order `[first, ...middle by score, last]`.
 */
function selectHunks(hunks: DiffHunk[], maxPerFile: number): { selected: DiffHunk[]; dropped: DiffHunk[] } {
  if (hunks.length <= maxPerFile) return { selected: hunks, dropped: [] };
  const first = hunks[0]!;
  const last = hunks.length > 1 ? hunks[hunks.length - 1]! : null;
  const middle = hunks.slice(1, last ? -1 : undefined);
  const slots = Math.max(0, maxPerFile - (last ? 2 : 1));
  const ranked = [...middle].sort((left, right) => (left.score < right.score ? 1 : left.score > right.score ? -1 : 0));
  const kept = [first, ...ranked.slice(0, slots), ...(last ? [last] : [])].map((hunk) => ({ hunk, line: extractLineNumber(hunk.header) }));
  kept.sort((left, right) => (left.line < right.line ? -1 : left.line > right.line ? 1 : 0));
  return { selected: kept.map(({ hunk }) => hunk), dropped: ranked.slice(slots) };
}

/** Keeps every change, `maxContext` lines either side of it and every `\`-prefixed patch marker. */
function reduceContext(hunk: DiffHunk, maxContext: number): DiffHunk {
  const lineCount = hunk.lines.length;
  const changes: number[] = [];
  hunk.lines.forEach((line, index) => {
    if (line.startsWith("+") || line.startsWith("-")) changes.push(index);
  });

  if (changes.length === 0) {
    const take = Math.min(maxContext, lineCount);
    return { header: hunk.header, lines: hunk.lines.slice(0, take), additions: 0, deletions: 0, contextLines: take, score: hunk.score };
  }

  // Range marks via a difference array; equivalent to upstream's per-index BTreeSet inserts.
  const coverage = new Int32Array(lineCount + 1);
  for (const position of changes) {
    coverage[Math.max(0, position - maxContext)]! += 1;
    coverage[Math.min(lineCount, position + maxContext + 1)]! -= 1;
  }
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  let contextLines = 0;
  let active = 0;
  for (let index = 0; index < lineCount; index += 1) {
    active += coverage[index]!;
    const line = hunk.lines[index]!;
    if (active <= 0 && !line.startsWith("\\")) continue;
    lines.push(line);
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
    else contextLines += 1;
  }
  return { header: hunk.header, lines, additions, deletions, contextLines, score: hunk.score };
}

function formatOutput(preDiffLines: readonly string[], files: readonly DiffFile[], filesAffected: number, additions: number, deletions: number, hunksRemoved: number): string {
  // Plain loops rather than `push(...lines)`: hunks can exceed the engine's argument-count limit.
  const out = [...preDiffLines];
  for (const file of files) {
    out.push(file.header);
    for (const line of file.renameLines) out.push(line);
    // Upstream normalizes mode lines to 100644 and binary lines to the bare form (surfaced in stats).
    if (file.isNewFile) out.push("new file mode 100644");
    else if (file.isDeletedFile) out.push("deleted file mode 100644");
    if (file.isBinary) {
      out.push("Binary files differ");
      continue;
    }
    if (file.oldFile !== "") out.push(file.oldFile);
    if (file.newFile !== "") out.push(file.newFile);
    for (const hunk of file.hunks) {
      out.push(hunk.header);
      for (const line of hunk.lines) out.push(line);
    }
  }
  if (hunksRemoved > 0 || filesAffected > 0) {
    const parts = [`${filesAffected} files changed`, `+${additions} -${deletions} lines`];
    if (hunksRemoved > 0) parts.push(`${hunksRemoved} hunks omitted`);
    out.push(`[${parts.join(", ")}]`);
  }
  return out.join("\n");
}
