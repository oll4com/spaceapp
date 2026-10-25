/**
 * Crushers for string arrays, number arrays and wide objects. TypeScript port of Headroom
 * `smart_crusher/crushers.rs` (Apache-2.0, Headroom Contributors), including the upstream k-split clamp
 * (`k_first + k_last <= k_total`) and linear-interpolation percentiles.
 */
import { computeOptimalK } from "./adaptive-sizer.js";
import type { SmartCrusherConfig } from "./config.js";
import { asF64, charCount, toJson, utf8Length, type JsonObject, type JsonValue } from "./json.js";
import { containsErrorKeyword } from "./outliers.js";
import { formatG, mean, median, percentileLinear, roundHalfEven, rustDisplayF64, sampleStdev, sortNumbers, toUsize } from "./stats.js";

const maxK = (config: SmartCrusherConfig) => (config.maxItemsAfterCrush > 0 ? config.maxItemsAfterCrush : undefined);

/** Split the adaptive budget into `[total, first, last, importance]`. */
export function computeKSplit(items: readonly string[], config: SmartCrusherConfig, bias: number): [number, number, number, number] {
  const total = computeOptimalK(items, bias, 3, maxK(config));
  const first = Math.min(Math.max(1, toUsize(roundHalfEven(total * config.firstFraction))), total);
  const last = Math.min(Math.max(1, toUsize(roundHalfEven(total * config.lastFraction))), Math.max(0, total - first));
  return [total, first, last, Math.max(0, total - (first + last))];
}

const range = (start: number, end: number) => Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i);
const ascending = (set: Set<number>) => [...set].sort((a, b) => a - b);

/** Keeps error-keyword and length-anomaly strings, the boundaries, then a deduplicated stride sample. */
export function crushStringArray(items: readonly string[], config: SmartCrusherConfig, bias: number): [string[], string] {
  const n = items.length;
  if (n <= 8) return [[...items], "string:passthrough"];
  const [kTotal, kFirst, kLast] = computeKSplit(items, config, bias);

  const errors = new Set<number>();
  items.forEach((s, i) => {
    if (containsErrorKeyword(s.toLowerCase())) errors.add(i);
  });
  const anomalies = new Set<number>();
  const lengths = items.map(charCount);
  const meanLength = mean(lengths) ?? 0;
  const stdLength = sampleStdev(lengths) ?? 0;
  if (stdLength > 0) {
    lengths.forEach((length, i) => {
      if (Math.abs(length - meanLength) > config.varianceThreshold * stdLength) anomalies.add(i);
    });
  }

  const keep = new Set([...errors, ...anomalies, ...range(0, Math.min(kFirst, n)), ...range(Math.max(0, n - kLast), n)]);
  const seen = new Set([...keep].map((i) => items[i]!));
  let dedupCount = 0;
  const remainingBudget = Math.max(0, kTotal - keep.size);
  if (remainingBudget > 0) {
    const stride = Math.max(1, Math.floor((n - 1) / (remainingBudget + 1)));
    const cap = kTotal + errors.size + anomalies.size;
    for (let i = 0; i < n && keep.size < cap; i += stride) {
      if (keep.has(i)) continue;
      if (seen.has(items[i]!)) dedupCount++;
      else {
        keep.add(i);
        seen.add(items[i]!);
      }
    }
  }

  const result = ascending(keep).map((i) => items[i]!);
  let strategy = `string:adaptive(${n}->${result.length}`;
  if (dedupCount > 0) strategy += `,dedup=${dedupCount}`;
  if (errors.size > 0) strategy += `,errors=${errors.size}`;
  return [result, `${strategy})`];
}

/** Rust's `format_number_repr`: integral values below 1e16 print as integers, others via `Display`. */
const formatNumberRepr = (x: number) => (Number.isInteger(x) && Math.abs(x) < 1e16 ? String(x) : rustDisplayF64(x));

/** Keeps outliers, window-mean change points, the boundaries, then a stride sample; reports summary stats. */
export function crushNumberArray(items: readonly JsonValue[], config: SmartCrusherConfig, bias: number): [JsonValue[], string] {
  const n = items.length;
  if (n <= 8) return [[...items], "number:passthrough"];
  const finiteAt = items.map(asF64);
  const finite = finiteAt.filter((value): value is number => value !== undefined);
  if (finite.length === 0) return [[...items], "number:no_finite"];

  const [kTotal, kFirst, kLast] = computeKSplit(items.map(toJson), config, bias);
  const meanValue = mean(finite) ?? 0;
  const medianValue = median(finite) ?? 0;
  const stdValue = finite.length > 1 ? (sampleStdev(finite) ?? 0) : 0;
  const sorted = sortNumbers(finite);
  const p25 = percentileLinear(sorted, 0.25);
  const p75 = percentileLinear(sorted, 0.75);

  const outliers = new Set<number>();
  if (stdValue > 0) {
    finiteAt.forEach((value, i) => {
      if (value !== undefined && Math.abs(value - meanValue) > config.varianceThreshold * stdValue) outliers.add(i);
    });
  }
  const changePoints = new Set<number>();
  if (config.preserveChangePoints && n > 10) {
    const window = 5;
    const finiteSlice = (start: number, end: number) => finiteAt.slice(start, end).filter((value): value is number => value !== undefined);
    for (let i = window; i < n - window; i++) {
      const left = finiteSlice(i - window, i);
      const right = finiteSlice(i, i + window);
      if (left.length === 0 || right.length === 0) continue;
      if (stdValue > 0 && Math.abs((mean(right) ?? 0) - (mean(left) ?? 0)) > config.varianceThreshold * stdValue) changePoints.add(i);
    }
  }

  const keep = new Set([...outliers, ...changePoints, ...range(0, Math.min(kFirst, n)), ...range(Math.max(0, n - kLast), n)]);
  const remainingBudget = Math.max(0, kTotal - keep.size);
  if (remainingBudget > 0) {
    const stride = Math.max(1, Math.floor((n - 1) / (remainingBudget + 1)));
    const cap = kTotal + outliers.size;
    for (let i = 0; i < n && keep.size < cap; i += stride) keep.add(i);
  }

  const kept = ascending(keep).map((i) => items[i]!);
  const min = finite.reduce((a, b) => Math.min(a, b));
  const max = finite.reduce((a, b) => Math.max(a, b));
  let strategy =
    `number:adaptive(${n}->${kept.length},min=${formatNumberRepr(min)},max=${formatNumberRepr(max)},mean=${formatG(meanValue)},` +
    `median=${formatG(medianValue)},stddev=${formatG(stdValue)},p25=${formatG(p25)},p75=${formatG(p75)}`;
  if (outliers.size > 0) strategy += `,outliers=${outliers.size}`;
  if (changePoints.size > 0) strategy += `,change_points=${changePoints.size}`;
  return [kept, `${strategy})`];
}

/** Treats key-value pairs as items: keeps error-bearing and cheap keys, boundaries, then a stride sample. */
export function crushObject(object: JsonObject, config: SmartCrusherConfig, bias: number): [JsonObject, string] {
  const n = object.size;
  const passthrough: [JsonObject, string] = [new Map(object), "object:passthrough"];
  if (n <= 8) return passthrough;
  const keys = [...object.keys()];
  const serialized = new Map(keys.map((key) => [key, toJson(object.get(key)!)]));
  const tokens = new Map(keys.map((key) => [key, Math.floor(utf8Length(serialized.get(key)!) / 4) + Math.floor(utf8Length(key) / 4) + 2]));
  let totalTokens = 0;
  for (const count of tokens.values()) totalTokens += count;
  if (totalTokens < config.minTokensToCrush) return passthrough;

  const kTotal = computeOptimalK(keys.map((key) => `${key}: ${serialized.get(key)!}`), bias, 3, maxK(config));
  if (kTotal >= n) return passthrough;

  const errorKeys = new Set(keys.filter((key) => containsErrorKeyword(serialized.get(key)!.toLowerCase())));
  const isError = (key: string) => errorKeys.has(key);
  const keep = new Set(keys.filter((key) => isError(key) || tokens.get(key)! <= 12));
  const kFirst = Math.max(1, toUsize(roundHalfEven(kTotal * config.firstFraction)));
  const kLast = Math.max(1, toUsize(roundHalfEven(kTotal * config.lastFraction)));
  keys.slice(0, kFirst).forEach((key) => keep.add(key));
  keys.slice(Math.max(0, n - kLast)).forEach((key) => keep.add(key));

  const remaining = Math.max(0, kTotal - keep.size);
  if (remaining > 0) {
    const stride = Math.max(1, Math.floor((n - 1) / (remaining + 1)));
    for (let i = 0; i < n; i += stride) {
      if (keep.size >= kTotal + [...keep].filter(isError).length) break;
      keep.add(keys[i]!);
    }
  }

  const result: JsonObject = new Map(keys.filter((key) => keep.has(key)).map((key) => [key, object.get(key)!]));
  return [result, `object:adaptive(${n}->${result.size} keys)`];
}
