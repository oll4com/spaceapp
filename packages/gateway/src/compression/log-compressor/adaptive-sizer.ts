/**
 * Adaptive sizing via information saturation. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/adaptive_sizer.rs` (Apache-2.0, Headroom Contributors), kept private to the
 * log compressor until another transform needs it.
 *
 * Three tiers: trivial inputs and near-total redundancy (SimHash clusters), a Kneedle knee on the cumulative
 * unique-bigram curve, then a zlib level-1 ratio check that bumps `k` by 20% when the subset is far more
 * redundant than the whole. Node's zlib is the same library CPython uses; the Rust build uses miniz_oxide,
 * whose level-1 output length can differ by a few bytes (upstream relies on the 15% tolerance to absorb it).
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { byteLength, splitWhiteSpace } from "./rust-text.js";

/** A 64-bit fingerprint as two unsigned 32-bit halves. */
interface Fingerprint {
  high: number;
  low: number;
}

/**
 * Number of items to keep. `items` are in importance order, `bias` multiplies the knee, `minK` is a floor and
 * `maxK` a cap (`undefined` = no cap). Like Rust (and unlike Python), inputs of 8 or fewer items return `n`.
 */
export function computeOptimalK(items: readonly string[], bias: number, minK: number, maxK?: number): number {
  const n = items.length;
  const effectiveMax = maxK ?? n;
  if (n <= 8) return n;

  const uniqueCount = countUniqueSimhash(items, 3);
  if (uniqueCount <= 3) return Math.min(Math.max(minK, uniqueCount), effectiveMax);

  const diversityRatio = uniqueCount / n;
  let knee = findKnee(computeUniqueBigramCurve(items));
  if (knee === null) {
    knee = Math.max(minK, toUsize(n * (0.3 + 0.7 * diversityRatio)));
  } else if (diversityRatio > 0.7) {
    knee = Math.max(knee, Math.max(minK, toUsize(n * (0.3 + 0.7 * diversityRatio))));
  }

  let k = Math.max(minK, toUsize(knee * bias));
  k = Math.min(k, effectiveMax);
  k = validateWithZlib(items, k, effectiveMax, 0.15);
  return Math.max(minK, Math.min(k, effectiveMax));
}

/** Kneedle on a monotonically increasing curve; returns the 1-based keep count, or null without a clear knee. */
export function findKnee(curve: readonly number[]): number | null {
  const n = curve.length;
  if (n < 3) return null;
  const yMin = curve[0]!;
  const yMax = curve[n - 1]!;
  if (Math.abs(yMax - yMin) < Number.EPSILON) return 1;
  const xRange = n - 1;
  const yRange = yMax - yMin;
  let maxDiff = -1;
  let kneeIndex = -1;
  for (let index = 0; index < n; index += 1) {
    const diff = (curve[index]! - yMin) / yRange - index / xRange;
    if (diff > maxDiff) {
      maxDiff = diff;
      kneeIndex = index;
    }
  }
  if (maxDiff < 0.05 || kneeIndex < 0) return null;
  return kneeIndex + 1;
}

/** CJK ideographs, kana and Hangul (same code-point ranges as upstream). */
function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf) || (code >= 0x4e00 && code <= 0x9fff)
    || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff);
}

/** Running count of unique word bigrams; one-word items add `(word, "")`, spaceless CJK items add character bigrams. */
export function computeUniqueBigramCurve(items: readonly string[]): number[] {
  const seen = new Set<string>();
  // Length-prefixed so no pair of strings can collide.
  const add = (first: string, second: string) => seen.add(`${first.length}:${first}${second}`);
  const curve: number[] = [];
  for (const item of items) {
    const words = splitWhiteSpace(item.toLowerCase());
    if (words.length >= 2) {
      for (let index = 0; index + 1 < words.length; index += 1) add(words[index]!, words[index + 1]!);
    } else if (words.length === 1) {
      const word = words[0]!;
      const chars = Array.from(word);
      if (chars.length >= 2 && chars.some(isCjkChar)) {
        for (let index = 0; index + 1 < chars.length; index += 1) add(chars[index]!, chars[index + 1]!);
      } else {
        add(word, "");
      }
    } else {
      add("", "");
    }
    curve.push(seen.size);
  }
  return curve;
}

/** 64-bit SimHash over lowercased character 4-grams, each hashed with MD5 (first 8 bytes, big-endian). */
function simhash(text: string, gramCache: Map<string, Fingerprint>): Fingerprint {
  const lower = text.toLowerCase();
  // UTF-16 offsets of each code point, so grams are code-point windows like upstream's `chars()`.
  const offsets: number[] = [];
  for (let index = 0; index < lower.length; index += 1) {
    offsets.push(index);
    const code = lower.charCodeAt(index);
    const next = lower.charCodeAt(index + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) index += 1;
  }
  const iterations = offsets.length <= 3 ? 1 : offsets.length - 3;
  const ones = new Int32Array(64);
  for (let start = 0; start < iterations; start += 1) {
    const gram = lower.slice(offsets[start] ?? 0, offsets[start + 4] ?? lower.length);
    let hash = gramCache.get(gram);
    if (!hash) {
      const digest = createHash("md5").update(gram, "utf8").digest();
      hash = { high: digest.readUInt32BE(0), low: digest.readUInt32BE(4) };
      gramCache.set(gram, hash);
    }
    const { high, low } = hash;
    for (let bit = 0; bit < 32; bit += 1) {
      ones[bit] = ones[bit]! + ((low >>> bit) & 1);
      ones[bit + 32] = ones[bit + 32]! + ((high >>> bit) & 1);
    }
  }
  // A bit is set when it won the vote: set in more grams than clear.
  let low = 0;
  let high = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (2 * ones[bit]! > iterations) low |= 1 << bit;
    if (2 * ones[bit + 32]! > iterations) high |= 1 << bit;
  }
  return { high: high >>> 0, low: low >>> 0 };
}

function popcount32(value: number): number {
  let bits = value - ((value >>> 1) & 0x55555555);
  bits = (bits & 0x33333333) + ((bits >>> 2) & 0x33333333);
  return (((bits + (bits >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

const hammingDistance = (a: Fingerprint, b: Fingerprint): number => popcount32(a.high ^ b.high) + popcount32(a.low ^ b.low);

/** The four 16-bit blocks of a fingerprint, tagged with their position. */
const blockKeys = (fingerprint: Fingerprint): number[] => [
  fingerprint.high >>> 16, 0x10000 | (fingerprint.high & 0xffff), 0x20000 | (fingerprint.low >>> 16), 0x30000 | (fingerprint.low & 0xffff)
];

/**
 * Greedy SimHash clustering: an item joins an existing cluster when any representative is within `threshold`
 * bits, else it starts a new one. Upstream scans every representative; for `threshold <= 3` this indexes them by
 * 16-bit block instead (pigeonhole: within 3 bits, one of four blocks is identical), which finds the same answer.
 */
export function countUniqueSimhash(items: readonly string[], threshold: number): number {
  const gramCache = new Map<string, Fingerprint>();
  const clusters: Fingerprint[] = [];
  const indexed = threshold <= 3;
  const byBlock = new Map<number, Fingerprint[]>();
  for (const item of items) {
    const fingerprint = simhash(item, gramCache);
    const keys = indexed ? blockKeys(fingerprint) : [];
    const candidates = indexed ? keys.flatMap((key) => byBlock.get(key) ?? []) : clusters;
    if (candidates.some((representative) => hammingDistance(fingerprint, representative) <= threshold)) continue;
    clusters.push(fingerprint);
    for (const key of keys) {
      const bucket = byBlock.get(key);
      if (bucket) bucket.push(fingerprint);
      else byBlock.set(key, [fingerprint]);
    }
  }
  return clusters.length;
}

/** If `items[..k]` compresses much better than the full list, the subset lacks diversity: bump `k` by 20%. */
export function validateWithZlib(items: readonly string[], k: number, maxK: number, tolerance: number): number {
  if (k >= items.length || k >= maxK) return k;
  const fullText = items.join("\n");
  const subsetText = items.slice(0, k).join("\n");
  const fullLength = byteLength(fullText);
  if (fullLength < 200) return k;
  const subsetLength = byteLength(subsetText);
  const fullRatio = fullLength > 0 ? zlibLength(fullText) / fullLength : 1;
  const subsetRatio = subsetLength > 0 ? zlibLength(subsetText) / subsetLength : 1;
  if (Math.abs(fullRatio - subsetRatio) > tolerance) return Math.min(toUsize(k * 1.2), maxK);
  return k;
}

const zlibLength = (text: string): number => deflateSync(Buffer.from(text, "utf8"), { level: 1 }).length;

/** Rust `f64 as usize`: truncates, saturates at 0, NaN becomes 0. */
const toUsize = (value: number): number => (Number.isNaN(value) || value <= 0 ? 0 : Math.floor(value));
