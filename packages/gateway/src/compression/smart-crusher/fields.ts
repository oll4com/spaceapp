/**
 * Field characterization: ID-like and score-like detection plus their statistical helpers. TypeScript
 * port of Headroom `smart_crusher/{field_detect,statistics}.rs` (Apache-2.0, Headroom Contributors),
 * including the upstream fix that refuses to call all-string numerics (zero-padded codes) sequential.
 */
import { asF64, charCount, isObject, JsonNumber, rustTrim, type JsonValue } from "./json.js";
import { sortNumbers } from "./stats.js";

export type FieldType = "numeric" | "string" | "boolean" | "object" | "array" | "null";

export interface FieldStats {
  name: string;
  fieldType: FieldType;
  count: number;
  uniqueCount: number;
  uniqueRatio: number;
  isConstant: boolean;
  constantValue?: JsonValue;
  minVal?: number;
  maxVal?: number;
  meanVal?: number;
  variance?: number;
  changePoints: number[];
  avgLength?: number;
}

export function isUuidFormat(value: string): boolean {
  return value.length === 36 && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value);
}

/** Shannon entropy normalized by log2(min(distinct chars, length)); 0 for strings under 2 chars. */
export function calculateStringEntropy(s: string): number {
  const length = charCount(s);
  if (length < 2) return 0;
  const frequencies = new Map<string, number>();
  for (const c of s) frequencies.set(c, (frequencies.get(c) ?? 0) + 1);
  let entropy = 0;
  for (const count of frequencies.values()) {
    const p = count / length;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  const maxEntropy = Math.log2(Math.min(frequencies.size, length));
  return maxEntropy > 0 ? entropy / maxEntropy : 0;
}

/** Python `int(s)` for default-base literals: trimmed, optional sign, PEP 515 underscores, i64 range. */
function pythonIntParse(s: string): number | undefined {
  let trimmed = rustTrim(s);
  if (trimmed === "") return undefined;
  if (trimmed.includes("_")) {
    if (trimmed.startsWith("_") || trimmed.endsWith("_") || trimmed.includes("__")) return undefined;
    trimmed = trimmed.replaceAll("_", "");
  }
  if (!/^[+-]?[0-9]+$/.test(trimmed)) return undefined;
  const value = BigInt(trimmed);
  return value > 9223372036854775807n || value < -9223372036854775808n ? undefined : Number(value);
}

/** Sequential IDs: >= 5 numbers, average and >80% of sorted gaps within [0.5, 2], optionally ascending. */
export function detectSequentialPattern(values: readonly JsonValue[], checkOrder: boolean): boolean {
  if (values.length < 5) return false;
  const nums: number[] = [];
  let hadRealNumber = false;
  for (const value of values) {
    if (value instanceof JsonNumber) {
      const parsed = asF64(value);
      if (parsed !== undefined) {
        nums.push(parsed);
        hadRealNumber = true;
      }
    } else if (typeof value === "string") {
      const parsed = pythonIntParse(value);
      if (parsed !== undefined) nums.push(parsed);
    }
  }
  if (nums.length < 5 || !hadRealNumber) return false;

  const sorted = sortNumbers(nums);
  const diffs = sorted.slice(1).map((value, i) => value - sorted[i]!);
  const inRange = (d: number) => d >= 0.5 && d <= 2;
  const avgDiff = diffs.reduce((sum, d) => sum + d, 0) / diffs.length;
  if (!inRange(avgDiff)) return false;
  if (diffs.filter(inRange).length / diffs.length <= 0.8) return false;
  if (!checkOrder) return true;
  let ascending = 0;
  for (let i = 1; i < nums.length; i++) if (nums[i - 1]! <= nums[i]!) ascending++;
  return ascending / (nums.length - 1) > 0.7;
}

/** `(isId, confidence)` for high-uniqueness columns that carry no ranking signal. */
export function detectIdField(stats: FieldStats, values: readonly JsonValue[]): [boolean, number] {
  if (stats.uniqueRatio < 0.9) return [false, 0];
  if (stats.fieldType === "string") {
    const sample = values.slice(0, 20).filter((value): value is string => typeof value === "string");
    if (sample.length > 0) {
      if (sample.filter(isUuidFormat).length / sample.length > 0.8) return [true, 0.95];
      const avgEntropy = sample.reduce((sum, s) => sum + calculateStringEntropy(s), 0) / sample.length;
      if (avgEntropy > 0.7 && stats.uniqueRatio > 0.95) return [true, 0.8];
    }
  }
  if (stats.fieldType === "numeric") {
    if (detectSequentialPattern(values, true) && stats.uniqueRatio > 0.95) return [true, 0.9];
    if (stats.minVal !== undefined && stats.maxVal !== undefined && stats.maxVal - stats.minVal > 0 && stats.uniqueRatio > 0.95) {
      return [true, 0.85];
    }
  }
  return stats.uniqueRatio > 0.98 ? [true, 0.7] : [false, 0];
}

const fieldValue = (item: JsonValue, name: string) => (isObject(item) ? item.get(name) : undefined);

/** `(isScore, confidence)` for bounded, non-sequential numerics, boosted when sorted descending. */
export function detectScoreField(stats: FieldStats, items: readonly JsonValue[]): [boolean, number] {
  if (stats.fieldType !== "numeric" || stats.minVal === undefined || stats.maxVal === undefined) return [false, 0];
  const { minVal: min, maxVal: max } = stats;
  const within = (lo: number, hi: number) => min >= lo && min <= hi && max >= lo && max <= hi;
  let confidence: number;
  if (within(0, 1)) confidence = 0.4;
  else if (within(0, 10)) confidence = 0.3;
  else if (within(0, 100)) confidence = 0.25;
  else if (min >= -1 && max <= 1) confidence = 0.35;
  else return [false, 0];

  const sample = items.slice(0, 50).flatMap((item) => {
    const value = fieldValue(item, stats.name);
    return value === undefined ? [] : [value];
  });
  if (detectSequentialPattern(sample, true)) return [false, 0];

  const ordered = items.flatMap((item) => {
    const value = asF64(fieldValue(item, stats.name));
    return value === undefined ? [] : [value];
  });
  if (ordered.length >= 5) {
    let descending = 0;
    for (let i = 1; i < ordered.length; i++) if (ordered[i - 1]! >= ordered[i]!) descending++;
    if (descending / (ordered.length - 1) > 0.7) confidence += 0.3;
  }
  const first20 = ordered.slice(0, 20);
  const floats = first20.filter((v) => v !== Math.trunc(v)).length;
  if (first20.length > 0 && floats > first20.length * 0.3) confidence += 0.1;
  return [confidence >= 0.4, Math.min(confidence, 0.95)];
}
