import { bm25Scorer } from "../smart-crusher/relevance.js";

/**
 * TextCrusher, a TypeScript port of Headroom `transforms/text_crusher` (Apache-2.0, Headroom Contributors): an
 * extractive prose compressor. It splits text into sentence segments, scores each by recency, relevance to a query
 * (BM25) and salience (numbers, error words, ALLCAPS, dotted names), skips near-duplicates (85% of its word
 * 3-shingles already kept) and keeps the best segments, in their original order, up to a share of the characters.
 * Kept segments are verbatim. CJK text uses Unicode segmentation (`Intl.Segmenter`, as Headroom uses ICU).
 */
export interface TextCrusherConfig {
  targetRatio: number;
  wRecency: number;
  wRelevance: number;
  wSalience: number;
  minSegmentChars: number;
  nearDupThreshold: number;
  minSegmentsForCrush: number;
}

export const defaultTextCrusherConfig: TextCrusherConfig = {
  targetRatio: 0.5, wRecency: 1.0, wRelevance: 2.0, wSalience: 1.5, minSegmentChars: 12, nearDupThreshold: 0.85, minSegmentsForCrush: 6
};

export interface TextCrusherResult {
  compressed: string;
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  keptSegments: number;
  totalSegments: number;
}

export interface CrushTextOptions {
  /** Lines kept whole and always selected (Space Gateway: test failures, assertions and counts). */
  pin?: (line: string) => boolean;
}

interface Segmented { segments: string[]; pinned: Set<number> }

const KEYWORDS = new Set(["error", "exception", "failed", "failure", "fail", "warning", "traceback", "assert", "todo", "fixme"]);
/** Rust `char::is_whitespace` (Unicode White_Space). */
const WS = "\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const isWhitespace = (char: string) => new RegExp(`^[${WS}]$`, "u").test(char);
const SPLIT_WS = new RegExp(`[${WS}]+`, "u");
const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

/** Rust `str::trim`: Unicode White_Space only (JavaScript also trims U+FEFF). */
function trim(text: string): string {
  return text.replace(new RegExp(`^[${WS}]+|[${WS}]+$`, "gu"), "");
}

const words = (text: string) => trim(text).split(SPLIT_WS).filter(Boolean);

function isCjk(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 0x3000 && code <= 0x303f) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef) || (code >= 0x20000 && code <= 0x2fa1f);
}
const hasCjk = (text: string) => [...text].some(isCjk);

/** Tokens for the reported ratio: whitespace words, or Unicode word tokens when CJK is present. */
function countTokens(text: string): number {
  return hasCjk(text) ? tokens(text).length : words(text).length;
}

/** Segments on newlines and after `.`, `!` or `?` followed by whitespace; a pinned line stays one segment. */
function splitAscii(text: string, pin?: (line: string) => boolean): Segmented {
  const segments: string[] = [];
  const pinned = new Set<number>();
  for (const line of text.split("\n")) {
    const trimmed = trim(line);
    if (!trimmed) continue;
    if (pin?.(trimmed)) { pinned.add(segments.length); segments.push(trimmed); continue; }
    let current = "";
    let previousTerminator = false;
    for (const char of trimmed) {
      if (previousTerminator && isWhitespace(char)) {
        const segment = trim(current);
        if (segment) segments.push(segment);
        current = "";
        previousTerminator = false;
        continue;
      }
      current += char;
      previousTerminator = char === "." || char === "!" || char === "?";
    }
    const segment = trim(current);
    if (segment) segments.push(segment);
  }
  return { segments, pinned };
}

const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: "sentence" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** CJK: Unicode sentence boundaries per line, then long segments split at soft breaks (20+ chars) or 40 chars. */
function splitCjk(text: string, pin?: (line: string) => boolean): Segmented {
  const segments: Array<{ text: string; pinned: boolean }> = [];
  for (const line of text.split("\n")) {
    const trimmed = trim(line);
    if (!trimmed) continue;
    if (pin?.(trimmed)) { segments.push({ text: trimmed, pinned: true }); continue; }
    for (const { segment } of sentenceSegmenter.segment(trimmed)) {
      const piece = trim(segment);
      if (piece) segments.push({ text: piece, pinned: false });
    }
  }
  const out: string[] = [];
  const pinned = new Set<number>();
  for (const { text: segment, pinned: isPinned } of segments) {
    if (isPinned) { pinned.add(out.length); out.push(segment); continue; }
    const chars = [...segment];
    if (chars.length <= 60 || !hasCjk(segment)) { out.push(segment); continue; }
    let piece: string[] = [];
    for (const char of chars) {
      piece.push(char);
      const soft = isWhitespace(char) || ["、", "，", "；", "：", "·", "…"].includes(char);
      if ((soft && piece.length >= 20) || piece.length >= 40) {
        const text_ = trim(piece.join(""));
        if (text_) out.push(text_);
        piece = [];
      }
    }
    const rest = trim(piece.join(""));
    if (rest) out.push(rest);
  }
  return { segments: out, pinned };
}

const splitSegments = (text: string, pin?: (line: string) => boolean): Segmented => (hasCjk(text) ? splitCjk(text, pin) : splitAscii(text, pin));

/** Lowercased alphanumeric/underscore runs; CJK uses Unicode word segmentation with full-width folding. */
function tokens(text: string): string[] {
  if (hasCjk(text)) {
    const out: string[] = [];
    for (const { segment } of wordSegmenter.segment(text)) {
      const word = trim(segment);
      if (!word || !ALNUM.test(word)) continue;
      out.push([...word].map((char) => {
        const code = char.codePointAt(0)!;
        return code >= 0xff01 && code <= 0xff5e ? String.fromCodePoint(code - 0xfee0) : code === 0x3000 ? " " : char;
      }).join("").toLowerCase());
    }
    return out;
  }
  const out: string[] = [];
  let current = "";
  for (const char of text) {
    if (ALNUM.test(char) || char === "_") current += char.toLowerCase();
    else if (current) { out.push(current); current = ""; }
  }
  if (current) out.push(current);
  return out;
}

/** Textbook BM25 (k1 1.2, b 0.75) over Unicode word tokens, max-normalized; the shared scorer has no CJK terms. */
function relevanceCjk(segmentTokens: string[][], context: string): number[] {
  const n = segmentTokens.length;
  const query = new Set(tokens(context));
  if (n === 0 || query.size === 0) return new Array(n).fill(0);
  const df = new Map<string, number>();
  for (const list of segmentTokens) for (const token of new Set(list)) df.set(token, (df.get(token) ?? 0) + 1);
  const idf = (term: string) => Math.log((n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5) + 1);
  const avgdl = Math.max(segmentTokens.reduce((sum, list) => sum + list.length, 0) / n, 1);
  const scores = segmentTokens.map((list) => {
    const tf = new Map<string, number>();
    for (const token of list) tf.set(token, (tf.get(token) ?? 0) + 1);
    let score = 0;
    for (const term of query) {
      const f = tf.get(term);
      if (f !== undefined) score += (idf(term) * (f * 2.2)) / (f + 1.2 * (1 - 0.75 + (0.75 * list.length) / avgdl));
    }
    return score;
  });
  const max = Math.max(0, ...scores);
  return max > 0 ? scores.map((score) => score / max) : scores;
}

function shingles(list: string[], k: number): Set<string> {
  const set = new Set<string>();
  if (list.length === 0) return set;
  if (list.length < k) {
    for (let size = 1; size <= list.length; size += 1) for (let start = 0; start + size <= list.length; start += 1) set.add(list.slice(start, start + size).join("\u0001"));
    return set;
  }
  for (let start = 0; start + k <= list.length; start += 1) set.add(list.slice(start, start + k).join("\u0001"));
  return set;
}

/** A word with a digit, an error word, ALLCAPS (2+ letters) or a dotted name (`foo.bar`). */
function isSalient(word: string): boolean {
  if (/[0-9]/.test(word)) return true;
  const chars = [...word];
  let start = 0;
  let end = chars.length;
  while (start < end && !ALNUM.test(chars[start]!)) start += 1;
  while (end > start && !ALNUM.test(chars[end - 1]!)) end -= 1;
  if (KEYWORDS.has(chars.slice(start, end).join("").toLowerCase())) return true;
  const alpha = chars.filter((char) => /\p{Alphabetic}/u.test(char));
  if (alpha.length >= 2 && alpha.every((char) => /\p{Uppercase}/u.test(char))) return true;
  const dot = word.indexOf(".");
  if (dot >= 0) {
    const before = word.slice(0, dot);
    const after = word.slice(dot + 1);
    const startsName = (text: string) => { const first = [...text][0]; return first !== undefined && (/\p{Alphabetic}/u.test(first) || first === "_"); };
    if (before && after && startsName(before) && startsName(after)) return true;
  }
  return false;
}

export function crushText(content: string, context = "", targetRatio: number | null = null, config: TextCrusherConfig = defaultTextCrusherConfig,
  options: CrushTextOptions = {}): TextCrusherResult {
  const passthrough = (segments: number): TextCrusherResult => {
    const count = countTokens(content);
    return { compressed: content, originalTokens: count, compressedTokens: count, compressionRatio: 1, keptSegments: segments, totalSegments: segments };
  };
  const ratio = Math.min(1, Math.max(0.05, targetRatio ?? config.targetRatio));
  const { segments, pinned } = splitSegments(content, options.pin);
  if (segments.length < config.minSegmentsForCrush) return passthrough(segments.length);
  const n = segments.length;
  const totalChars = segments.reduce((sum, segment) => sum + byteLength(segment), 0);
  const targetChars = Math.max(1, Math.floor(totalChars * ratio));
  const segmentTokens = segments.map(tokens);
  const relevance = segments.some(hasCjk) ? relevanceCjk(segmentTokens, context) : bm25Scorer.scoreBatch(segments, context);
  const scores = segments.map((segment, index) => {
    const recency = (index + 1) / n;
    const rel = relevance[index] ?? 0;
    let salient: number;
    let wordCount: number;
    if (hasCjk(segment)) {
      salient = segmentTokens[index]!.filter(isSalient).length;
      wordCount = segmentTokens[index]!.length;
    } else {
      const list = words(segment);
      salient = list.filter(isSalient).length;
      wordCount = list.length;
    }
    const salience = salient / (wordCount + 1);
    let score = config.wRecency * recency + config.wRelevance * rel + config.wSalience * salience;
    if (byteLength(segment) < config.minSegmentChars) score *= 0.25;
    return score;
  });
  const order = [...segments.keys()].sort((a, b) => (scores[b]! - scores[a]!) || a - b);
  const kept = new Array<boolean>(n).fill(false);
  const seen = new Set<string>();
  let keptChars = 0;
  let keptCount = 0;
  // Pinned segments come first, whatever their score, and count toward the budget.
  for (const index of pinned) {
    kept[index] = true;
    keptCount += 1;
    for (const shingle of shingles(segmentTokens[index]!, 3)) seen.add(shingle);
    keptChars += byteLength(segments[index]!);
  }
  for (const index of order) {
    if (kept[index]) continue;
    if (keptChars >= targetChars) break;
    const set = shingles(segmentTokens[index]!, 3);
    if (set.size > 0) {
      let covered = 0;
      for (const shingle of set) if (seen.has(shingle)) covered += 1;
      if (covered / set.size >= config.nearDupThreshold) continue;
    }
    kept[index] = true;
    keptCount += 1;
    for (const shingle of set) seen.add(shingle);
    keptChars += byteLength(segments[index]!);
  }
  if (keptCount === 0) return passthrough(n);
  const compressed = segments.filter((_, index) => kept[index]).join("\n");
  const originalTokens = countTokens(content);
  const compressedTokens = countTokens(compressed);
  return { compressed, originalTokens, compressedTokens, compressionRatio: originalTokens > 0 ? compressedTokens / originalTokens : 1, keptSegments: keptCount, totalSegments: n };
}
