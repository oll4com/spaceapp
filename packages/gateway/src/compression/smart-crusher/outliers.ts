/**
 * Must-keep detectors: error-keyword items, rare fields and rare categorical values. TypeScript port of
 * Headroom `smart_crusher/{outliers,error_keywords,constraints}.rs` (Apache-2.0, Headroom Contributors),
 * including the upstream Pareto fix for rare-status detection (cardinality 2..=50, top-K <= 5 covers 80%).
 */
import { compareCodePoints, isObject, scalarText, toJson, type JsonValue } from "./json.js";

export const ERROR_KEYWORDS = ["error", "exception", "failed", "failure", "critical", "fatal", "crash", "panic", "abort", "timeout", "denied", "rejected"];

export const containsErrorKeyword = (lowercase: string) => ERROR_KEYWORDS.some((keyword) => lowercase.includes(keyword));

// Arrays are not mutated while being crushed, and the analyzer, the default constraints and the budget pass
// all ask the same questions of the same array, so results are memoized by array identity.
const errorItemsMemo = new WeakMap<readonly JsonValue[], readonly number[]>();
const outliersMemo = new WeakMap<readonly JsonValue[], readonly number[]>();

/**
 * Indices of dict items whose JSON contains an error keyword (case-insensitive). `itemStrings`, when given,
 * must be each item's compact JSON (`toJson`), so it never changes the result.
 */
export function detectErrorItems(items: readonly JsonValue[], itemStrings?: readonly string[]): readonly number[] {
  let indices = errorItemsMemo.get(items);
  if (indices) return indices;
  const found: number[] = [];
  items.forEach((item, i) => {
    if (!isObject(item)) return;
    const serialized = (itemStrings && i < itemStrings.length ? itemStrings[i]! : toJson(item)).toLowerCase();
    if (containsErrorKeyword(serialized)) found.push(i);
  });
  errorItemsMemo.set(items, (indices = found));
  return indices;
}

/** Items carrying a field present in < 20% of rows, or a rare value of a common (>= 80%) field. Ascending. */
export function detectStructuralOutliers(items: readonly JsonValue[]): readonly number[] {
  if (items.length < 5) return [];
  let result = outliersMemo.get(items);
  if (result) return result;
  const fieldCounts = new Map<string, number>();
  for (const item of items) if (isObject(item)) for (const key of item.keys()) fieldCounts.set(key, (fieldCounts.get(key) ?? 0) + 1);
  const n = items.length;
  const common = [...fieldCounts].filter(([, count]) => count >= n * 0.8).map(([key]) => key);
  const rare = new Set([...fieldCounts].filter(([, count]) => count < n * 0.2).map(([key]) => key));

  const outliers = new Set<number>();
  if (rare.size > 0) {
    items.forEach((item, i) => {
      if (isObject(item) && [...item.keys()].some((key) => rare.has(key))) outliers.add(i);
    });
  }
  for (const index of detectRareStatusValues(items, common)) outliers.add(index);
  outliersMemo.set(items, (result = [...outliers].sort((a, b) => a - b)));
  return result;
}

export function detectRareStatusValues(items: readonly JsonValue[], commonFields: readonly string[]): number[] {
  const outliers: number[] = [];
  for (const field of [...commonFields].sort(compareCodePoints)) {
    // Per item: undefined when the field is absent, else its frequency key (`__none__` for null).
    const keys: (string | undefined)[] = [];
    const unique = new Set<string>();
    let present = 0;
    for (const item of items) {
      const value = isObject(item) ? item.get(field) : undefined;
      if (value === undefined) {
        keys.push(undefined);
        continue;
      }
      present++;
      const key = value === null ? "__none__" : scalarText(value);
      if (value !== null) unique.add(key);
      keys.push(key);
      if (unique.size > 50) break; // too many distinct values to be a status field: skipped below anyway
    }
    if (unique.size < 2 || unique.size > 50) continue;

    const counts = new Map<string, number>();
    for (const key of keys) if (key !== undefined) counts.set(key, (counts.get(key) ?? 0) + 1);
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || compareCodePoints(a[0], b[0]));

    const threshold = Math.ceil(present * 0.8);
    const topValues = new Set<string>();
    let cumulative = 0;
    for (const [value, count] of sorted) {
      cumulative += count;
      topValues.add(value);
      if (cumulative >= threshold) break;
    }
    if (topValues.size > 5) continue;

    keys.forEach((key, i) => {
      if (key !== undefined && !topValues.has(key)) outliers.push(i);
    });
  }
  return outliers;
}

/** A must-keep predicate over an array; the OSS default stack keeps error items and structural outliers. */
export type Constraint = (items: readonly JsonValue[], itemStrings?: readonly string[]) => readonly number[];

export const DEFAULT_CONSTRAINTS: readonly Constraint[] = [detectErrorItems, (items) => detectStructuralOutliers(items)];
