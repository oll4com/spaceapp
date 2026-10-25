/**
 * Adaptive "how many items to keep" via information saturation. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/adaptive_sizer.rs` (Apache-2.0, Headroom Contributors), kept private to the
 * search compressor (the log compressor carries its own copy).
 *
 * Tiers: n <= 8 keeps all; at most 3 SimHash clusters keeps that many; otherwise Kneedle on the cumulative
 * unique-bigram curve with a diversity floor, times `bias`, then a zlib level-1 ratio check that bumps k by 20%
 * when the kept prefix compresses much better than the whole list.
 *
 * Follows Rust where Python differs: n <= 8 returns n even above `maxK` (Python returns min(n, maxK)). zlib streams
 * from Node (Chromium zlib), CPython and Rust (miniz_oxide) can differ by a few bytes; the 15% tolerance absorbs it.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { byteLength, isCjkChar, splitWhitespace } from "./rust-text.js";

/** Rust `as usize` on a float: truncates, saturating NaN and negatives to 0. */
const toUsize = (value: number): number => (value > 0 ? Math.floor(value) : 0);

export function computeOptimalK(items: readonly string[], bias: number, minK: number, maxK?: number | null): number {
  const n = items.length;
  const effectiveMax = maxK ?? n;
  if (n <= 8) return n;

  const uniqueCount = countUniqueSimhash(items, 3);
  if (uniqueCount <= 3) return Math.min(Math.max(minK, uniqueCount), effectiveMax);

  let knee = findKnee(computeUniqueBigramCurve(items));
  const diversityRatio = uniqueCount / n;
  if (knee === null) knee = Math.max(minK, toUsize(n * (0.3 + 0.7 * diversityRatio)));
  else if (diversityRatio > 0.7) knee = Math.max(knee, Math.max(minK, toUsize(n * (0.3 + 0.7 * diversityRatio))));

  let k = Math.max(minK, toUsize(knee * bias));
  k = Math.min(k, effectiveMax);
  k = validateWithZlib(items, k, effectiveMax, 0.15);
  return Math.max(minK, Math.min(k, effectiveMax));
}

/** Kneedle: 1-based index of the largest gap above the diagonal, null without a > 0.05 deviation. */
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
  for (let i = 0; i < n; i += 1) {
    const diff = (curve[i]! - yMin) / yRange - i / xRange;
    if (diff > maxDiff) {
      maxDiff = diff;
      kneeIndex = i;
    }
  }
  return maxDiff < 0.05 ? null : kneeIndex + 1;
}

/** Running count of unique word bigrams; one-word items count as `(word, "")`, spaceless CJK as char bigrams. */
export function computeUniqueBigramCurve(items: readonly string[]): number[] {
  const seen = new Set<string>();
  const add = (a: string, b: string) => seen.add(JSON.stringify([a, b]));
  return items.map((item) => {
    const words = splitWhitespace(item.toLowerCase());
    const [word] = words;
    if (words.length >= 2) {
      for (let j = 0; j < words.length - 1; j += 1) add(words[j]!, words[j + 1]!);
    } else if (word !== undefined) {
      const chars = Array.from(word);
      if (chars.length >= 2 && chars.some((char) => isCjkChar(char.codePointAt(0)!))) {
        for (let j = 0; j < chars.length - 1; j += 1) add(chars[j]!, chars[j + 1]!);
      } else add(word, "");
    } else add("", "");
    return seen.size;
  });
}

/** A 64-bit fingerprint as [high, low] unsigned 32-bit halves; bigint is far too slow for the clustering loop. */
type Fingerprint = [high: number, low: number];
/** MD5 prefix per 4-gram; grep lines repeat most of their grams, so one cache per sizing call saves most hashing. */
type GramCache = Map<string, Fingerprint>;

/** 64-bit SimHash over lowercased character 4-grams; each gram votes with the first 8 bytes of its MD5 (big-endian). */
export function simhash(text: string): bigint {
  const [high, low] = simhashHalves(text, new Map());
  return (BigInt(high) << 32n) | BigInt(low);
}

function simhashHalves(text: string, cache: GramCache): Fingerprint {
  const lower = text.toLowerCase();
  // UTF-16 offset of every code point (grams are 4 code points, as in Rust/Python), plus the end.
  const starts: number[] = [];
  for (let i = 0; i < lower.length; i += 1) {
    starts.push(i);
    if ((lower.charCodeAt(i) & 0xfc00) === 0xd800 && (lower.charCodeAt(i + 1) & 0xfc00) === 0xdc00) i += 1;
  }
  const length = starts.length;
  starts.push(lower.length);
  const grams = length <= 3 ? 1 : length - 3;
  // Bit j wins the vote when more than half of the grams set it.
  const setCounts = new Int32Array(64);
  for (let i = 0; i < grams; i += 1) {
    const gram = lower.slice(starts[i]!, starts[Math.min(i + 4, length)]!);
    let hash = cache.get(gram);
    if (!hash) {
      const digest = createHash("md5").update(gram, "utf8").digest();
      hash = [digest.readUInt32BE(0), digest.readUInt32BE(4)];
      cache.set(gram, hash);
    }
    const [high, low] = hash;
    for (let bit = 0; bit < 32; bit += 1) {
      setCounts[bit]! += (low >>> bit) & 1;
      setCounts[bit + 32]! += (high >>> bit) & 1;
    }
  }
  let high = 0;
  let low = 0;
  for (let bit = 0; bit < 32; bit += 1) {
    if (setCounts[bit]! * 2 > grams) low |= 1 << bit;
    if (setCounts[bit + 32]! * 2 > grams) high |= 1 << bit;
  }
  return [high >>> 0, low >>> 0];
}

export function hammingDistance(a: bigint, b: bigint): number {
  const mask = 0xffffffffn;
  return popcount32(Number((a ^ b) >> 32n)) + popcount32(Number((a ^ b) & mask));
}

function popcount32(value: number): number {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
}

/** Greedy clustering: an item joins the first cluster whose representative is within `threshold` bits. */
export function countUniqueSimhash(items: readonly string[], threshold: number): number {
  const cache: GramCache = new Map();
  const highs: number[] = [];
  const lows: number[] = [];
  for (const item of items) {
    const [high, low] = simhashHalves(item, cache);
    let matched = false;
    for (let i = 0; i < highs.length && !matched; i += 1) matched = popcount32(high ^ highs[i]!) + popcount32(low ^ lows[i]!) <= threshold;
    if (!matched) {
      highs.push(high);
      lows.push(low);
    }
  }
  return highs.length;
}

export function validateWithZlib(items: readonly string[], k: number, maxK: number, tolerance: number): number {
  if (k >= items.length || k >= maxK) return k;
  const fullText = items.join("\n");
  const subsetText = items.slice(0, k).join("\n");
  const fullBytes = byteLength(fullText);
  if (fullBytes < 200) return k;
  const subsetBytes = byteLength(subsetText);
  const fullRatio = fullBytes > 0 ? zlibLength(fullText) / fullBytes : 1;
  const subsetRatio = subsetBytes > 0 ? zlibLength(subsetText) / subsetBytes : 1;
  if (Math.abs(fullRatio - subsetRatio) > tolerance) return Math.min(toUsize(k * 1.2), maxK);
  return k;
}

const zlibLength = (text: string): number => deflateSync(Buffer.from(text, "utf8"), { level: 1 }).length;
