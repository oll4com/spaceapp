/**
 * Format-native, reversible lossless compaction, a TypeScript port of Headroom `transforms/lossless_compaction.py`
 * (Apache-2.0, Headroom Contributors). Output keeps looking like its own type (grep stays grep, logs stay logs) and
 * carries no retrieval marker. Every fold is checked against its exact inverse; when the round trip differs or the
 * result is not smaller, the content comes back unchanged. Nothing here throws.
 */
export type LosslessKind = "log" | "search" | "paths" | "diff" | "text" | "config";

const ANSI = /\x1b\[[0-9;]*m/g;
const RUN_MARKER = /^\.\.\. \(repeated (\d+) times\)$/;
const BLOCK_MARKER = /^\.\.\. \(repeats (\d+) lines from (\d+) lines back\)$/;
const FOLD_MIN_BLOCK = 3;
const FOLD_MAX_BLOCK = 64;
const FOLD_MAX_CANDIDATES = 8;
const FOLD_MAX_LINES = 20_000;
// Python's `\d` is any Unicode digit and `.` matches everything but a newline (lines hold none).
const GREP_ROW = /^([^\n:]+):(\p{Nd}+):(.*)$/su;
const HEADING_ROW = /^(\p{Nd}+):(.*)$/su;
const DIR_DATA = /^([^/\n:]+):(\p{Nd}+):(.*)$/su;
const DIFF_INDEX = /^index [0-9a-fA-F]+\.\.[0-9a-fA-F]+( [0-7]+)?$/;
const PATH_ROW = /^((?:\.{0,2}\/)?(?:[^/\s:]+\/)+)([^/\s:]+)$/u;

/** Python `len`: code points, not UTF-16 units. */
const length = (text: string) => text.length - (text.match(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g)?.length ?? 0);
const smaller = (candidate: string, original: string) => length(candidate) < length(original);

export const stripAnsi = (text: string) => text.replace(ANSI, "");

function split(text: string): { lines: string[]; trailing: boolean } {
  if (text === "") return { lines: [], trailing: false };
  const trailing = text.endsWith("\n");
  return { lines: (trailing ? text.slice(0, -1) : text).split("\n"), trailing };
}

const join = (lines: string[], trailing: boolean) => lines.join("\n") + (trailing ? "\n" : "");

/** A run of N >= 2 identical lines becomes the line once and `... (repeated N times)`. */
export function collapseRuns(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    let j = i;
    while (j + 1 < lines.length && lines[j + 1] === lines[i]) j += 1;
    out.push(lines[i]!);
    if (j > i) out.push(`... (repeated ${j - i + 1} times)`);
    i = j + 1;
  }
  return join(out, trailing);
}

export function expandRuns(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  for (let i = 0; i < lines.length;) {
    const marker = i + 1 < lines.length ? RUN_MARKER.exec(lines[i + 1]!) : null;
    if (marker) {
      for (let k = 0; k < Number(marker[1]); k += 1) out.push(lines[i]!);
      i += 2;
      continue;
    }
    out.push(lines[i]!);
    i += 1;
  }
  return join(out, trailing);
}

function remember(positions: Map<string, number[]>, line: string, index: number) {
  const bucket = positions.get(line) ?? [];
  bucket.push(index);
  if (bucket.length > FOLD_MAX_CANDIDATES) bucket.shift();
  positions.set(line, bucket);
}

/** K >= 3 lines that repeat K lines seen D lines earlier (K <= D) become `... (repeats K lines from D lines back)`. */
export function foldRepeatedBlocks(text: string): string {
  const { lines, trailing } = split(text);
  const n = lines.length;
  if (n < FOLD_MIN_BLOCK * 2 || n > FOLD_MAX_LINES) return text;
  const positions = new Map<string, number[]>();
  const out: string[] = [];
  for (let i = 0; i < n;) {
    let bestLength = 0;
    let bestDistance = 0;
    for (const q of [...(positions.get(lines[i]!) ?? [])].reverse()) {
      const maxLength = Math.min(FOLD_MAX_BLOCK, n - i, i - q);
      let size = 0;
      while (size < maxLength && lines[q + size] === lines[i + size]) size += 1;
      if (size > bestLength) { bestLength = size; bestDistance = i - q; }
    }
    if (bestLength >= FOLD_MIN_BLOCK) {
      const marker = `... (repeats ${bestLength} lines from ${bestDistance} lines back)`;
      let blockChars = 0;
      for (let k = 0; k < bestLength; k += 1) blockChars += length(lines[i + k]!) + 1;
      if (blockChars > length(marker) + 1) {
        out.push(marker);
        for (let k = 0; k < bestLength; k += 1) remember(positions, lines[i + k]!, i + k);
        i += bestLength;
        continue;
      }
    }
    remember(positions, lines[i]!, i);
    out.push(lines[i]!);
    i += 1;
  }
  return join(out, trailing);
}

export function unfoldRepeatedBlocks(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  for (const line of lines) {
    const marker = BLOCK_MARKER.exec(line);
    if (marker) {
      const size = Number(marker[1]);
      const distance = Number(marker[2]);
      const start = out.length - distance;
      if (start >= 0 && size <= distance) { out.push(...out.slice(start, start + size)); continue; }
    }
    out.push(line);
  }
  return join(out, trailing);
}

/** grep `path:line:content` rows in ripgrep --heading form: the path once, then `line:content` rows. */
export function searchHeading(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const row = GREP_ROW.exec(line);
    if (row) {
      if (row[1] !== current) { out.push(row[1]!); current = row[1]!; }
      out.push(`${row[2]}:${row[3]}`);
    } else { out.push(line); current = null; }
  }
  return join(out, trailing);
}

export function searchUnheading(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const data = HEADING_ROW.exec(line);
    if (current !== null && data) { out.push(`${current}:${data[1]}:${data[2]}`); continue; }
    if (!data && i + 1 < lines.length && HEADING_ROW.test(lines[i + 1]!)) { current = line; continue; }
    current = null;
    out.push(line);
  }
  return join(out, trailing);
}

/** grep rows grouped by directory: `dir/` once, then `base:line:content` rows. */
export function searchDirHeading(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const row = GREP_ROW.exec(line);
    if (row && row[1]!.includes("/")) {
      const cut = row[1]!.lastIndexOf("/") + 1;
      const directory = row[1]!.slice(0, cut);
      if (directory !== current) { out.push(directory); current = directory; }
      out.push(`${row[1]!.slice(cut)}:${row[2]}:${row[3]}`);
    } else { out.push(line); current = null; }
  }
  return join(out, trailing);
}

export function searchDirUnheading(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const data = DIR_DATA.test(line);
    if (current !== null && data) { out.push(`${current}${line}`); continue; }
    if (line.endsWith("/") && i + 1 < lines.length && DIR_DATA.test(lines[i + 1]!)) { current = line; continue; }
    current = null;
    out.push(line);
  }
  return join(out, trailing);
}

/** Unified diff without its `index <sha>..<sha>` lines (still applies). */
export function diffStripIndex(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  return join(lines.filter((line) => !DIFF_INDEX.test(line)), trailing);
}

/** A pure path listing (`find`, `ls -1`, `rg -l`): each directory once (ending in `/`), then bare names. */
export function pathHeading(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.filter((line) => PATH_ROW.test(line)).length < 2) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const row = PATH_ROW.exec(line);
    if (row) {
      if (row[1] !== current) { out.push(row[1]!); current = row[1]!; }
      out.push(row[2]!);
    } else { out.push(line); current = null; }
  }
  return join(out, trailing);
}

export function pathUnheading(text: string): string {
  const { lines, trailing } = split(text);
  if (lines.length === 0) return text;
  const out: string[] = [];
  let current: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const isBase = line !== "" && !line.includes("/");
    if (current !== null && isBase) { out.push(current + line); continue; }
    if (line.endsWith("/") && i + 1 < lines.length && lines[i + 1] !== "" && !lines[i + 1]!.includes("/")) { current = line; continue; }
    current = null;
    out.push(line);
  }
  return join(out, trailing);
}

/** Headroom `compact_lossless`: the fold for `kind`, or the content unchanged. */
export function compactLossless(content: string, kind: LosslessKind): string {
  if (!content) return content;
  try {
    switch (kind) {
      case "log": {
        // ANSI color is the one non-semantic part a log fold drops.
        const baseline = stripAnsi(content);
        const candidate = collapseRuns(baseline);
        if (expandRuns(candidate) !== baseline) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      case "search": {
        let best = content;
        for (const [candidate, inverse] of [[searchHeading(content), searchUnheading], [searchDirHeading(content), searchDirUnheading]] as const) {
          if (inverse(candidate) === content && smaller(candidate, best)) best = candidate;
        }
        return best;
      }
      case "paths": {
        const candidate = pathHeading(content);
        if (pathUnheading(candidate) !== content) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      case "diff": {
        const candidate = diffStripIndex(content);
        return smaller(candidate, content) ? candidate : content;
      }
      case "text": {
        const candidate = collapseRuns(content);
        if (expandRuns(candidate) !== content) return content;
        return smaller(candidate, content) ? candidate : content;
      }
      case "config": {
        const candidate = foldRepeatedBlocks(collapseRuns(content));
        if (expandRuns(unfoldRepeatedBlocks(candidate)) !== content) return content;
        return smaller(candidate, content) ? candidate : content;
      }
    }
  } catch {
    return content;
  }
  return content;
}

/** Headroom `_looks_like_diff`. */
export const looksLikeDiff = (content: string) =>
  content.includes("diff --git ") || content.includes("\n@@ ") || content.startsWith("@@ ") || content.startsWith("--- ");

/**
 * Headroom's stage-0 fold (`_lossless_first`): the primary kind first, then search, paths, log and text, keeping
 * the single fold that shrinks the most. The diff fold drops lines without an inverse check, so it only runs on
 * content shaped like a diff.
 */
export function bestLosslessFold(content: string, primary: LosslessKind | null = null): { text: string; kind: LosslessKind } | null {
  let order: LosslessKind[] = [...(primary ? [primary] : []), ...(["search", "paths", "log", "diff", "text"] as const).filter((kind) => kind !== primary)];
  if (primary !== "diff" && !looksLikeDiff(content)) order = order.filter((kind) => kind !== "diff");
  let best = content;
  let label: LosslessKind | null = null;
  for (const kind of order) {
    const candidate = compactLossless(content, kind);
    if (length(candidate) < length(best)) { best = candidate; label = kind; }
  }
  return label ? { text: best, kind: label } : null;
}
