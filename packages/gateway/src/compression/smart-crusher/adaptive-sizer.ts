/**
 * Adaptive "how many items to keep" via information saturation. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/adaptive_sizer.rs` (Apache-2.0, Headroom Contributors): SimHash
 * near-duplicate counting, Kneedle on the unique-bigram coverage curve, zlib level-1 ratio validation.
 */
import { deflateSync } from "node:zlib";
import { splitWhitespace } from "./json.js";
import { toUsize } from "./stats.js";

export function computeOptimalK(items: readonly string[], bias: number, minK: number, maxK?: number): number {
  const n = items.length;
  const effectiveMax = maxK ?? n;
  if (n <= 8) return n;

  const uniqueCount = countUniqueSimhash(items, 3);
  if (uniqueCount <= 3) return Math.min(Math.max(minK, uniqueCount), effectiveMax);

  let knee = findKnee(computeUniqueBigramCurve(items));
  const diversity = uniqueCount / n;
  if (knee === undefined) {
    // No saturation: keep 30% (all duplicates) .. 100% (all distinct).
    knee = Math.max(minK, toUsize(n * (0.3 + 0.7 * diversity)));
  } else if (diversity > 0.7) {
    knee = Math.max(knee, Math.max(minK, toUsize(n * (0.3 + 0.7 * diversity))));
  }

  let k = Math.min(Math.max(minK, toUsize(knee * bias)), effectiveMax);
  k = validateWithZlib(items, k, effectiveMax, 0.15);
  return Math.max(minK, Math.min(k, effectiveMax));
}

/** Kneedle: 1-based index of the largest gap above the diagonal, if it exceeds 0.05. */
export function findKnee(curve: readonly number[]): number | undefined {
  const n = curve.length;
  if (n < 3) return undefined;
  const yMin = curve[0]!;
  const yMax = curve[n - 1]!;
  if (Math.abs(yMax - yMin) < Number.EPSILON) return 1;
  let maxDiff = -1;
  let kneeIndex = 0;
  curve.forEach((y, i) => {
    const diff = (y - yMin) / (yMax - yMin) - i / (n - 1);
    if (diff > maxDiff) {
      maxDiff = diff;
      kneeIndex = i;
    }
  });
  return maxDiff < 0.05 ? undefined : kneeIndex + 1;
}

const isCjk = (cp: number) =>
  (cp >= 0x3040 && cp <= 0x30ff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) ||
  (cp >= 0xac00 && cp <= 0xd7af) || (cp >= 0xf900 && cp <= 0xfaff);

/** Running count of distinct word bigrams; spaceless CJK items contribute character bigrams. */
export function computeUniqueBigramCurve(items: readonly string[]): number[] {
  // Words never contain whitespace, so a space separator keeps pair keys unambiguous.
  const seen = new Set<string>();
  return items.map((item) => {
    const words = splitWhitespace(item.toLowerCase());
    if (words.length >= 2) {
      for (let j = 0; j < words.length - 1; j++) seen.add(`${words[j]} ${words[j + 1]}`);
    } else if (words.length === 1) {
      const chars = Array.from(words[0]!);
      if (chars.length >= 2 && chars.some((c) => isCjk(c.codePointAt(0)!))) {
        for (let j = 0; j < chars.length - 1; j++) seen.add(`${chars[j]} ${chars[j + 1]}`);
      } else {
        seen.add(`${words[0]} `);
      }
    } else {
      seen.add(" ");
    }
    return seen.size;
  });
}

// MD5 of each 4-gram, memoized: JSON rows repeat most grams (keys, punctuation), so hashing dominates otherwise.
// ASCII grams live in an open-addressing table keyed by their packed 7-bit codes (no substring per gram).
const GRAM_CACHE_LIMIT = 1 << 17;
const ASCII_TABLE_BITS = 18; // at most half full
const asciiKeys = new Int32Array(1 << ASCII_TABLE_BITS); // packed gram + 1; 0 marks an empty slot
const asciiSlots = new Int32Array(1 << ASCII_TABLE_BITS);
const otherGrams = new Map<string, number>();
const gramWords = new Int32Array(GRAM_CACHE_LIMIT * 2);
let gramCount = 0;

function hashGram(gram: string): number {
  if (gramCount >= GRAM_CACHE_LIMIT) {
    asciiKeys.fill(0);
    otherGrams.clear();
    gramCount = 0;
  }
  const slot = gramCount++;
  md5Head(gram, slot * 2);
  return slot;
}

// RFC 1321 MD5 for one short message (a gram is at most 16 UTF-8 bytes, so a single 64-byte block), inlined
// because `createHash` per gram costs microseconds. Writes digest bytes 0..7 as two big-endian words.
const MD5_K = new Int32Array([
  0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
  0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
  0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
  0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
  0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
  0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
  0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
  0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391
]);
const MD5_SHIFTS = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const md5Block = new Int32Array(16);

function md5Head(gram: string, offset: number): void {
  const block = md5Block;
  block.fill(0);
  let length = 0;
  const push = (byte: number) => {
    block[length >> 2]! |= byte << ((length & 3) << 3);
    length++;
  };
  for (let i = 0; i < gram.length; i++) {
    let c = gram.charCodeAt(i);
    if (c < 0x80) {
      push(c);
      continue;
    }
    if (c < 0x800) {
      push(0xc0 | (c >> 6));
      push(0x80 | (c & 0x3f));
      continue;
    }
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < gram.length) {
      const low = gram.charCodeAt(i + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
        i++;
        push(0xf0 | (c >> 18));
        push(0x80 | ((c >> 12) & 0x3f));
        push(0x80 | ((c >> 6) & 0x3f));
        push(0x80 | (c & 0x3f));
        continue;
      }
    }
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // lone surrogate, as Node's UTF-8 encoder
    push(0xe0 | (c >> 12));
    push(0x80 | ((c >> 6) & 0x3f));
    push(0x80 | (c & 0x3f));
  }
  const bits = length * 8;
  push(0x80);
  block[14] = bits;

  let a = 0x67452301;
  let b = 0xefcdab89 | 0;
  let c = 0x98badcfe | 0;
  let d = 0x10325476;
  for (let i = 0; i < 64; i++) {
    let f: number;
    let g: number;
    if (i < 16) {
      f = (b & c) | (~b & d);
      g = i;
    } else if (i < 32) {
      f = (d & b) | (~d & c);
      g = (5 * i + 1) & 15;
    } else if (i < 48) {
      f = b ^ c ^ d;
      g = (3 * i + 5) & 15;
    } else {
      f = c ^ (b | ~d);
      g = (7 * i) & 15;
    }
    const x = (a + f + MD5_K[i]! + block[g]!) | 0;
    const s = MD5_SHIFTS[((i >> 4) << 2) | (i & 3)]!;
    a = d;
    d = c;
    c = b;
    b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
  }
  const swap = (w: number) => ((w & 0xff) << 24) | ((w & 0xff00) << 8) | ((w >>> 8) & 0xff00) | (w >>> 24);
  gramWords[offset] = swap((a + 0x67452301) | 0);
  gramWords[offset + 1] = swap((b + (0xefcdab89 | 0)) | 0);
}

function gramSlot(gram: string): number {
  let slot = otherGrams.get(gram);
  if (slot === undefined) otherGrams.set(gram, (slot = hashGram(gram)));
  return slot;
}

// Bit-sliced vertical counters: plane k holds bit k of the per-position set-bit counts.
const planesHi = new Int32Array(32);
const planesLo = new Int32Array(32);
const hasSurrogate = /[\ud800-\udfff]/;
const nonAscii = /[^\u0000-\u007f]/;

/**
 * 64-bit SimHash over lowercase character 4-grams (MD5, first 8 bytes big-endian), as [hi, lo] words.
 * Bit j is set when more grams have it set than clear (`2 * count > grams`), as upstream's vote.
 */
export function simhash(text: string): [number, number] {
  const lower = text.toLowerCase();
  const chars = hasSurrogate.test(lower) ? Array.from(lower) : undefined;
  const length = chars ? chars.length : lower.length;
  const iterations = length <= 3 ? 1 : length - 3;
  const packed = length > 3 && !nonAscii.test(lower);
  let key = packed ? (lower.charCodeAt(0) << 14) | (lower.charCodeAt(1) << 7) | lower.charCodeAt(2) : 0;
  let depth = 0;
  for (let i = 0; i < iterations; i++) {
    let slot: number;
    if (packed) {
      key = ((key << 7) & 0x0fffffff) | lower.charCodeAt(i + 3);
      let h = Math.imul(key, 0x9e3779b1) >>> (32 - ASCII_TABLE_BITS);
      for (;;) {
        const stored = asciiKeys[h]!;
        if (stored === key + 1) {
          slot = asciiSlots[h]!;
          break;
        }
        if (stored === 0) {
          // If hashGram resets a full cache, this key may land off its home slot; a later miss just re-hashes it.
          slot = hashGram(lower.substring(i, i + 4));
          asciiKeys[h] = key + 1;
          asciiSlots[h] = slot;
          break;
        }
        h = (h + 1) & ((1 << ASCII_TABLE_BITS) - 1);
      }
    } else {
      slot = gramSlot(chars ? chars.slice(i, i + 4).join("") : lower.substring(i, i + 4));
    }
    let carryHi = gramWords[slot * 2]!;
    let carryLo = gramWords[slot * 2 + 1]!;
    for (let k = 0; (carryHi | carryLo) !== 0; k++) {
      const nextHi = planesHi[k]! & carryHi;
      const nextLo = planesLo[k]! & carryLo;
      planesHi[k]! ^= carryHi;
      planesLo[k]! ^= carryLo;
      carryHi = nextHi;
      carryLo = nextLo;
      if (k >= depth) depth = k + 1;
    }
  }
  let hi = 0;
  let lo = 0;
  for (let j = 0; j < 32; j++) {
    let countHi = 0;
    let countLo = 0;
    for (let k = 0; k < depth; k++) {
      countHi |= ((planesHi[k]! >>> j) & 1) << k;
      countLo |= ((planesLo[k]! >>> j) & 1) << k;
    }
    if (2 * countHi > iterations) hi |= 1 << j;
    if (2 * countLo > iterations) lo |= 1 << j;
  }
  planesHi.fill(0, 0, depth);
  planesLo.fill(0, 0, depth);
  return [hi >>> 0, lo >>> 0];
}

const popcount32 = (x: number) => {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
};

/**
 * Greedy clustering: an item starts a new cluster unless some representative is within `threshold`
 * Hamming distance. For thresholds up to 3, fingerprints that close agree exactly on at least one of their
 * four 16-bit blocks (pigeonhole), so only representatives sharing a block are compared.
 */
export function countUniqueSimhash(items: readonly string[], threshold: number): number {
  const repsHi: number[] = [];
  const repsLo: number[] = [];
  const buckets = new Map<number, number[]>();
  const keys = [0, 0, 0, 0];
  for (const item of items) {
    const [hi, lo] = simhash(item);
    let matched = false;
    if (threshold > 3) {
      for (let r = 0; r < repsHi.length && !matched; r++) matched = popcount32(hi ^ repsHi[r]!) + popcount32(lo ^ repsLo[r]!) <= threshold;
    } else {
      keys[0] = lo & 0xffff;
      keys[1] = 0x10000 | (lo >>> 16);
      keys[2] = 0x20000 | (hi & 0xffff);
      keys[3] = 0x30000 | (hi >>> 16);
      for (let k = 0; k < 4 && !matched; k++) {
        const bucket = buckets.get(keys[k]!);
        if (!bucket) continue;
        for (let x = 0; x < bucket.length && !matched; x++) {
          const r = bucket[x]!;
          matched = popcount32(hi ^ repsHi[r]!) + popcount32(lo ^ repsLo[r]!) <= threshold;
        }
      }
    }
    if (matched) continue;
    const r = repsHi.length;
    repsHi.push(hi);
    repsLo.push(lo);
    if (threshold > 3) continue;
    for (const key of keys) {
      const bucket = buckets.get(key);
      if (bucket) bucket.push(r);
      else buckets.set(key, [r]);
    }
  }
  return repsHi.length;
}

/** If the first `k` items compress much better than the whole list, they lack diversity: bump k by 20%. */
export function validateWithZlib(items: readonly string[], k: number, maxK: number, tolerance: number): number {
  if (k >= items.length || k >= maxK) return k;
  const full = Buffer.from(items.join("\n"), "utf8");
  if (full.length < 200) return k;
  const subset = Buffer.from(items.slice(0, k).join("\n"), "utf8");
  const ratio = (bytes: Buffer) => (bytes.length === 0 ? 1 : deflateSync(bytes, { level: 1 }).length / bytes.length);
  return Math.abs(ratio(full) - ratio(subset)) > tolerance ? Math.min(toUsize(k * 1.2), maxK) : k;
}
