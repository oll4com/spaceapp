/**
 * Position-based anchor selection for array compression. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/anchor_selector.rs` (Apache-2.0, Headroom Contributors) with the
 * default `AnchorConfig`. Item identity is `md5(json.dumps(item, sort_keys=True))[:16]`, Python-formatted.
 */
import { createHash } from "node:crypto";
import { isObject, pythonJsonDumps, toJson, utf8Length, type JsonObject, type JsonValue } from "./json.js";
import { toUsize } from "./stats.js";

export type DataPattern = "search_results" | "logs" | "time_series" | "generic";

interface Weights {
  front: number;
  middle: number;
  back: number;
}

const ANCHOR_BUDGET_PCT = 0.25;
const MIN_ANCHOR_SLOTS = 3;
const MAX_ANCHOR_SLOTS = 12;
const CANDIDATE_MULTIPLIER = 3;
const RECENCY_KEYWORDS = ["latest", "recent", "last", "newest", "current", "now"];
const HISTORICAL_KEYWORDS = ["first", "oldest", "earliest", "original", "initial", "beginning"];

const BASE_WEIGHTS: Record<DataPattern, Weights> = {
  search_results: { front: 0.75, middle: 1 - 0.75 - 0.15, back: 0.15 },
  logs: { front: 0.15, middle: 1 - 0.15 - 0.75, back: 0.75 },
  time_series: { front: 0.45, middle: 0.1, back: 0.45 },
  generic: { front: 0.5, middle: 0.1, back: 0.4 }
};

export const md5Hex = (text: string) => createHash("md5").update(text, "utf8").digest("hex");

// Containers are never mutated once parsed or built, so their content hash is memoized by identity.
const itemHashes = new WeakMap<object, string>();

export function computeItemHash(item: JsonValue): string {
  if (item === null || typeof item !== "object") return md5Hex(pythonJsonDumps(item, true)).slice(0, 16);
  let hash = itemHashes.get(item);
  if (hash === undefined) itemHashes.set(item, (hash = md5Hex(pythonJsonDumps(item, true)).slice(0, 16)));
  return hash;
}

function normalize(weights: Weights): Weights {
  const total = weights.front + weights.middle + weights.back;
  if (total === 0) return BASE_WEIGHTS.generic;
  return { front: weights.front / total, middle: weights.middle / total, back: weights.back / total };
}

function adjustWeightsForQuery(base: Weights, query: string | undefined): Weights {
  if (!query) return base;
  const lower = query.toLowerCase();
  const recency = RECENCY_KEYWORDS.some((keyword) => lower.includes(keyword));
  const historical = HISTORICAL_KEYWORDS.some((keyword) => lower.includes(keyword));
  if (recency && !historical) {
    return normalize({ front: Math.max(0.1, base.front - 0.15), middle: base.middle, back: Math.min(0.8, base.back + 0.15) });
  }
  if (historical && !recency) {
    return normalize({ front: Math.min(0.8, base.front + 0.15), middle: base.middle, back: Math.max(0.1, base.back - 0.15) });
  }
  return base;
}

/**
 * Select anchor indices for an array of `items` compressed to at most `maxItems`. `itemStrings`, when
 * given, must be each item's compact JSON (`toJson`); it saves re-serializing for length scoring.
 */
export function selectAnchors(items: readonly JsonValue[], maxItems: number, pattern: DataPattern, query?: string, itemStrings?: readonly string[]): Set<number> {
  const itemLength = (idx: number) => utf8Length(itemStrings?.[idx] ?? toJson(items[idx]!));
  const size = items.length;
  if (size === 0) return new Set();
  if (size <= maxItems) return new Set(items.keys());

  const budget = Math.min(Math.min(MAX_ANCHOR_SLOTS, Math.max(MIN_ANCHOR_SLOTS, toUsize(maxItems * ANCHOR_BUDGET_PCT))), size);
  if (budget === 0) return new Set();
  const weights = normalize(adjustWeightsForQuery(BASE_WEIGHTS[pattern], query));

  const frontSlots = Math.max(1, toUsize(budget * weights.front));
  let backSlots = Math.max(1, toUsize(budget * weights.back));
  let middleSlots = Math.max(0, budget - (frontSlots + backSlots));
  const total = frontSlots + middleSlots + backSlots;
  if (total > budget) {
    let excess = total - budget;
    const middleReduction = Math.min(middleSlots, excess);
    middleSlots -= middleReduction;
    excess -= middleReduction;
    if (excess > 0) backSlots = Math.max(1, Math.max(0, backSlots - excess));
  }

  const anchors = new Set<number>();
  const seen = new Set<string>();
  const front = selectRegion(items, 0, Math.min(frontSlots * 2, Math.floor(size / 3)), frontSlots, seen);
  front.forEach((i) => anchors.add(i));
  const backStart = Math.max(Math.max(0, size - backSlots * 2), Math.floor((2 * size) / 3));
  const back = selectRegion(items, backStart, size, backSlots, seen);
  back.forEach((i) => anchors.add(i));
  // The middle region is bounded by the deduplicated front/back counts, not the slot allocation.
  if (middleSlots > 0) {
    const middleStart = front.size;
    const middleEnd = Math.max(0, size - back.size);
    if (middleEnd > middleStart) selectByDensity(items, middleStart, middleEnd, middleSlots, seen, itemLength).forEach((i) => anchors.add(i));
  }
  return anchors;
}

function selectRegion(items: readonly JsonValue[], start: number, end: number, slots: number, seen: Set<string>): Set<number> {
  const selected = new Set<number>();
  if (slots === 0 || start >= end) return selected;
  const regionSize = end - start;
  if (slots >= regionSize) {
    for (let idx = start; idx < end; idx++) if (shouldInclude(items, idx, seen, false)) selected.add(idx);
    return selected;
  }
  const step = regionSize / (slots + 1);
  for (let i = 0; i < slots; i++) {
    const idx = Math.min(start + toUsize((i + 1) * step), end - 1);
    if (shouldInclude(items, idx, seen, false)) {
      selected.add(idx);
      continue;
    }
    for (const offset of [1, -1, 2, -2]) {
      const alternative = idx + offset;
      if (alternative < start || alternative >= end) continue;
      if (shouldInclude(items, alternative, seen, false)) {
        selected.add(alternative);
        break;
      }
    }
  }
  return selected;
}

function selectByDensity(items: readonly JsonValue[], start: number, end: number, slots: number, seen: Set<string>, itemLength: (idx: number) => number): Set<number> {
  const regionSize = end - start;
  const candidateCount = Math.min(slots * CANDIDATE_MULTIPLIER, regionSize);
  const step = candidateCount > 0 ? regionSize / (candidateCount + 1) : 1;
  let stats: RegionStats | undefined;
  const candidates: [number, number][] = [];
  for (let i = 0; i < candidateCount; i++) {
    const idx = Math.min(start + toUsize((i + 1) * step), end - 1);
    if (!shouldInclude(items, idx, seen, true)) continue;
    const item = items[idx]!;
    candidates.push([idx, isObject(item) ? informationScore(item, itemLength(idx), (stats ??= regionStats(items, start, end, itemLength))) : 0.5]);
  }
  candidates.sort((a, b) => b[1] - a[1]);
  const selected = new Set<number>();
  for (const [idx] of candidates.slice(0, slots)) if (shouldInclude(items, idx, seen, false)) selected.add(idx);
  return selected;
}

function shouldInclude(items: readonly JsonValue[], idx: number, seen: Set<string>, checkOnly: boolean): boolean {
  if (idx >= items.length) return false;
  const item = items[idx]!;
  if (!isObject(item)) return true;
  const hash = computeItemHash(item);
  if (seen.has(hash)) return false;
  if (!checkOnly) seen.add(hash);
  return true;
}

/** Region-wide counts behind upstream's per-candidate `calculate_information_score`, built once per region. */
interface RegionStats {
  size: number;
  valueCounts: Map<string, Map<string, number>>;
  objectCount: number;
  minLength: number;
  maxLength: number;
  common: string[];
  rare: string[];
}

const uniquenessKey = (value: JsonValue) => (typeof value === "string" ? value : pythonJsonDumps(value, true));

function regionStats(items: readonly JsonValue[], start: number, end: number, itemLength: (idx: number) => number): RegionStats {
  const valueCounts = new Map<string, Map<string, number>>();
  const keyCounts = new Map<string, number>();
  let objectCount = 0;
  let minLength = Infinity;
  let maxLength = -Infinity;
  for (let idx = start; idx < end; idx++) {
    const item = items[idx]!;
    if (!isObject(item)) continue;
    objectCount++;
    const length = itemLength(idx);
    minLength = Math.min(minLength, length);
    maxLength = Math.max(maxLength, length);
    for (const [key, value] of item) {
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
      let counts = valueCounts.get(key);
      if (!counts) valueCounts.set(key, (counts = new Map()));
      const valueKey = uniquenessKey(value);
      counts.set(valueKey, (counts.get(valueKey) ?? 0) + 1);
    }
  }
  const common = [...keyCounts].filter(([, count]) => count >= objectCount * 0.8).map(([key]) => key);
  const rare = [...keyCounts].filter(([, count]) => count < objectCount * 0.2).map(([key]) => key);
  return { size: end - start, valueCounts, objectCount, minLength, maxLength, common, rare };
}

/** Information density in [0, 1]: 0.4 value rareness + 0.3 relative length + 0.3 structural rareness. */
function informationScore(item: JsonObject, length: number, stats: RegionStats): number {
  if (stats.size === 0) return 0;
  const score = valueUniqueness(item, stats) * 0.4 + lengthScore(length, stats) * 0.3 + structuralUniqueness(item, stats) * 0.3;
  return Math.min(1, Math.max(0, score));
}

function valueUniqueness(item: JsonObject, stats: RegionStats): number {
  if (stats.size < 2) return 0.5;
  const rareness: number[] = [];
  for (const [key, value] of item) {
    const count = stats.valueCounts.get(key)?.get(uniquenessKey(value)) ?? 0;
    if (count > 0) rareness.push(1 - count / stats.size);
  }
  return rareness.length === 0 ? 0.5 : rareness.reduce((sum, r) => sum + r, 0) / rareness.length;
}

function lengthScore(length: number, stats: RegionStats): number {
  if (stats.size < 2 || stats.objectCount === 0 || stats.maxLength === stats.minLength) return 0.5;
  return (length - stats.minLength) / (stats.maxLength - stats.minLength);
}

function structuralUniqueness(item: JsonObject, stats: RegionStats): number {
  if (stats.objectCount < 2) return 0.5;
  let uniqueness = 0;
  if (stats.rare.length > 0) uniqueness += 0.5 * (stats.rare.filter((key) => item.has(key)).length / stats.rare.length);
  if (stats.common.length > 0) uniqueness += 0.5 * (stats.common.filter((key) => !item.has(key)).length / stats.common.length);
  return Math.min(uniqueness, 1);
}
