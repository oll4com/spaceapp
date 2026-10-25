/**
 * Statistical analysis deciding whether and how to crush a dict array. TypeScript port of Headroom
 * `smart_crusher/analyzer.rs` (Apache-2.0, Headroom Contributors). Fields are visited in sorted key
 * order, as upstream's `BTreeMap`, because several decisions short-circuit on the first match.
 */
import type { SmartCrusherConfig } from "./config.js";
import { detectIdField, detectScoreField, type FieldStats, type FieldType } from "./fields.js";
import { asF64, charCount, compareCodePoints, isObject, JsonNumber, pythonStr, type JsonValue } from "./json.js";
import { detectErrorItems, detectStructuralOutliers } from "./outliers.js";
import { mean, sampleStdev, sampleVariance, toFixedExact } from "./stats.js";

export type CompressionStrategy = "none" | "skip" | "time_series" | "cluster" | "top_n" | "smart_sample";

export interface CrushabilityAnalysis {
  crushable: boolean;
  confidence: number;
  reason: string;
  signalsPresent: string[];
  signalsAbsent: string[];
}

export interface ArrayAnalysis {
  itemCount: number;
  /** Sorted by field name (code point order). */
  fieldStats: Map<string, FieldStats>;
  detectedPattern: "time_series" | "logs" | "search_results" | "generic";
  recommendedStrategy: CompressionStrategy;
  /** Sorted by field name. */
  constantFields: Map<string, JsonValue>;
  crushability?: CrushabilityAnalysis;
}

/** `itemStrings`, when given, must be each item's compact JSON (`toJson`). */
export function analyzeArray(items: readonly JsonValue[], config: SmartCrusherConfig, itemStrings?: readonly string[]): ArrayAnalysis {
  if (!isObject(items[0])) {
    return { itemCount: items.length, fieldStats: new Map(), detectedPattern: "generic", recommendedStrategy: "none", constantFields: new Map() };
  }
  const keys = new Set<string>();
  for (const item of items) if (isObject(item)) for (const key of item.keys()) keys.add(key);
  // Per field: its value in every dict item, missing keys read as null (upstream's `item.get(key)`).
  const columns = new Map<string, JsonValue[]>();
  const fieldStats = new Map<string, FieldStats>();
  for (const key of [...keys].sort(compareCodePoints)) {
    const column: JsonValue[] = [];
    for (const item of items) if (isObject(item)) column.push(item.get(key) ?? null);
    columns.set(key, column);
    fieldStats.set(key, analyzeField(key, column, config));
  }

  const detectedPattern = detectPattern(fieldStats, items);
  const constantFields = new Map<string, JsonValue>();
  for (const [key, stats] of fieldStats) if (stats.isConstant && stats.constantValue !== undefined) constantFields.set(key, stats.constantValue);
  const crushability = analyzeCrushability(items, fieldStats, columns, config, itemStrings);
  const recommendedStrategy = selectStrategy(fieldStats, detectedPattern, items.length, crushability, config);
  return { itemCount: items.length, fieldStats, detectedPattern, recommendedStrategy, constantFields, crushability };
}

function analyzeField(key: string, values: readonly JsonValue[], config: SmartCrusherConfig): FieldStats {
  const nonNull = values.filter((value) => value !== null);
  const base = { name: key, count: values.length, changePoints: [] as number[] };
  const first = nonNull[0];
  if (first === undefined) return { ...base, fieldType: "null", uniqueCount: 0, uniqueRatio: 0, isConstant: true };

  const fieldType: FieldType =
    typeof first === "boolean" ? "boolean" : first instanceof JsonNumber ? "numeric" : typeof first === "string" ? "string" : Array.isArray(first) ? "array" : "object";
  const unique = new Set<string>();
  for (const value of values) unique.add(pythonStr(value));
  const uniqueCount = unique.size;
  const stats: FieldStats = {
    ...base,
    fieldType,
    uniqueCount,
    uniqueRatio: values.length === 0 ? 0 : uniqueCount / values.length,
    isConstant: uniqueCount === 1
  };
  if (stats.isConstant) stats.constantValue = first;

  if (fieldType === "numeric") {
    const nums: number[] = [];
    for (const value of nonNull) {
      const parsed = asF64(value);
      if (parsed !== undefined) nums.push(parsed);
    }
    if (nums.length > 0) {
      const minVal = nums.reduce((a, b) => Math.min(a, b));
      const maxVal = nums.reduce((a, b) => Math.max(a, b));
      const meanVal = mean(nums);
      const variance = nums.length > 1 ? sampleVariance(nums) : 0;
      // Upstream mirrors Python's try/except: any non-finite stat drops the block (variance pinned to 0).
      if (meanVal !== undefined && variance !== undefined && Number.isFinite(minVal) && Number.isFinite(maxVal)) {
        Object.assign(stats, { minVal, maxVal, meanVal, variance, changePoints: detectChangePoints(nums, 5, config) });
      } else {
        stats.variance = 0;
      }
    }
  } else if (fieldType === "string") {
    // Upstream also records the top-5 values; nothing reads them, so they are not computed here.
    const lengths: number[] = [];
    for (const value of nonNull) if (typeof value === "string") lengths.push(charCount(value));
    if (lengths.length > 0) stats.avgLength = mean(lengths);
  }
  return stats;
}

/** Sliding-window mean shifts beyond `variance_threshold` standard deviations, greedily spaced by `window`. */
function detectChangePoints(values: readonly number[], window: number, config: SmartCrusherConfig): number[] {
  if (values.length < window * 2) return [];
  const std = sampleStdev(values);
  if (std === undefined || !(std > 0)) return [];
  const threshold = config.varianceThreshold * std;
  const points: number[] = [];
  // Each window is summed afresh, in order, exactly like `mean(&values[a..b])` upstream.
  const windowMean = (start: number) => {
    let sum = 0;
    for (let k = start; k < start + window; k++) sum += values[k]!;
    const result = sum / window;
    return Number.isFinite(result) ? result : 0;
  };
  for (let i = window; i < values.length - window; i++) {
    if (Math.abs(windowMean(i) - windowMean(i - window)) > threshold) points.push(i);
  }
  const deduped: number[] = [];
  for (const point of points) if (deduped.length === 0 || point - deduped[deduped.length - 1]! > window) deduped.push(point);
  return deduped;
}

function detectPattern(fieldStats: Map<string, FieldStats>, items: readonly JsonValue[]): ArrayAnalysis["detectedPattern"] {
  const stats = [...fieldStats.values()];
  const hasNumericVariance = stats.some((s) => s.fieldType === "numeric" && (s.variance ?? 0) > 0);
  if (detectTemporalField(fieldStats, items) && hasNumericVariance) return "time_series";

  let messageLike = false;
  let levelLike = false;
  for (const s of stats) {
    if (s.fieldType !== "string") continue;
    if (s.uniqueRatio > 0.5 && (s.avgLength ?? 0) > 20) messageLike = true;
    else if (s.uniqueRatio < 0.1 && s.uniqueCount >= 2 && s.uniqueCount <= 10) levelLike = true;
  }
  if (messageLike && levelLike) return "logs";

  for (const s of stats) {
    const [isScore, confidence] = detectScoreField(s, items);
    if (isScore && confidence >= 0.5) return "search_results";
  }
  return "generic";
}

const isoDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

function detectTemporalField(fieldStats: Map<string, FieldStats>, items: readonly JsonValue[]): boolean {
  for (const [name, stats] of fieldStats) {
    if (stats.fieldType === "string") {
      const sample = items.slice(0, 10).flatMap((item) => {
        const value = isObject(item) ? item.get(name) : undefined;
        return typeof value === "string" ? [value] : [];
      });
      if (sample.length === 0) continue;
      if (sample.filter((s) => isoDateTime.test(s) || isoDate.test(s)).length / sample.length > 0.5) return true;
    } else if (stats.fieldType === "numeric" && stats.minVal !== undefined && stats.maxVal !== undefined) {
      const min = stats.minVal;
      if ((min >= 1e9 && min <= 2e9) || (min >= 1e12 && min <= 2e12)) return true;
    }
  }
  return false;
}

// The analyzer, the smart-sample plan and the budget pass all need this for the same analysis.
const anomalyMemo = new WeakMap<Map<string, FieldStats>, readonly number[]>();

/**
 * Indices of items whose numeric field lies beyond `variance_threshold` sigma of that field's mean, added to
 * `into`. Memoized per `fieldStats`, which always belongs to one `items` array and config.
 */
export function numericAnomalies(fieldStats: Map<string, FieldStats>, items: readonly JsonValue[], varianceThreshold: number, into = new Set<number>()): Set<number> {
  let found = anomalyMemo.get(fieldStats);
  if (!found) anomalyMemo.set(fieldStats, (found = [...computeNumericAnomalies(fieldStats, items, varianceThreshold)]));
  for (const index of found) into.add(index);
  return into;
}

function computeNumericAnomalies(fieldStats: Map<string, FieldStats>, items: readonly JsonValue[], varianceThreshold: number): Set<number> {
  const into = new Set<number>();
  for (const [name, stats] of fieldStats) {
    if (stats.fieldType !== "numeric" || stats.meanVal === undefined || stats.variance === undefined || !(stats.variance > 0)) continue;
    const std = Math.sqrt(stats.variance);
    if (!(std > 0)) continue;
    const threshold = varianceThreshold * std;
    items.forEach((item, i) => {
      const value = asF64(isObject(item) ? item.get(name) : undefined);
      if (value !== undefined && Math.abs(value - stats.meanVal!) > threshold) into.add(i);
    });
  }
  return into;
}

/** The main "is it SAFE to crush?" decision: without a signal identifying important rows, don't. */
function analyzeCrushability(
  items: readonly JsonValue[],
  fieldStats: Map<string, FieldStats>,
  columns: Map<string, JsonValue[]>,
  config: SmartCrusherConfig,
  itemStrings?: readonly string[]
): CrushabilityAnalysis {
  const signalsPresent: string[] = [];
  const signalsAbsent: string[] = [];

  let idField: string | undefined;
  let idUniqueness = 0;
  let idConfidence = 0;
  for (const [name, stats] of fieldStats) {
    const [isId, confidence] = detectIdField(stats, columns.get(name)!);
    if (isId && confidence > idConfidence) {
      idField = name;
      idUniqueness = stats.uniqueRatio;
      idConfidence = confidence;
    }
  }
  const hasIdField = idField !== undefined && idConfidence >= 0.7;

  let hasScoreField = false;
  for (const [name, stats] of fieldStats) {
    const [isScore, confidence] = detectScoreField(stats, items);
    if (isScore) {
      hasScoreField = true;
      signalsPresent.push(`score_field:${name}(conf=${toFixedExact(confidence, 2)})`);
      break;
    }
  }
  if (!hasScoreField) signalsAbsent.push("score_field");

  const structuralOutliers = detectStructuralOutliers(items).length;
  if (structuralOutliers > 0) signalsPresent.push(`structural_outliers:${structuralOutliers}`);
  else signalsAbsent.push("structural_outliers");
  const keywordErrors = detectErrorItems(items, itemStrings).length;
  if (keywordErrors > 0 && structuralOutliers === 0) signalsPresent.push(`error_keywords:${keywordErrors}`);

  const anomalies = numericAnomalies(fieldStats, items, config.varianceThreshold).size;
  if (anomalies > 0) signalsPresent.push(`anomalies:${anomalies}`);
  else signalsAbsent.push("anomalies");

  const stats = [...fieldStats.values()];
  const avgRatio = (type: FieldType) => mean(stats.filter((s) => s.fieldType === type && s.name !== idField).map((s) => s.uniqueRatio)) ?? 0;
  const avgStringUniqueness = avgRatio("string");
  const maxUniqueness = Math.max(avgStringUniqueness, idUniqueness, 0);
  const nonIdContentUniqueness = Math.max(avgStringUniqueness, avgRatio("numeric"));

  if (stats.some((s) => s.fieldType === "numeric" && s.changePoints.length > 0)) signalsPresent.push("change_points");
  const hasSignal = signalsPresent.length > 0;
  const verdict = (crushable: boolean, confidence: number, reason: string, present = signalsPresent): CrushabilityAnalysis =>
    ({ crushable, confidence, reason, signalsPresent: present, signalsAbsent });

  if (nonIdContentUniqueness < 0.1 && hasIdField) return verdict(true, 0.85, "repetitive_content_with_ids", [...signalsPresent, "repetitive_content"]);
  if (maxUniqueness < 0.3) return verdict(true, 0.9, "low_uniqueness_safe_to_sample");
  if (hasIdField && maxUniqueness > 0.8 && !hasSignal) return verdict(false, 0.85, "unique_entities_no_signal");
  if (maxUniqueness > 0.8 && hasSignal) return verdict(true, 0.7, "unique_entities_with_signal");
  if (!hasSignal) return verdict(false, 0.6, "medium_uniqueness_no_signal");
  return verdict(true, 0.5, "medium_uniqueness_with_signal");
}

function selectStrategy(
  fieldStats: Map<string, FieldStats>,
  pattern: ArrayAnalysis["detectedPattern"],
  itemCount: number,
  crushability: CrushabilityAnalysis,
  config: SmartCrusherConfig
): CompressionStrategy {
  if (itemCount < config.minItemsToAnalyze) return "none";
  if (!crushability.crushable) return "skip";
  const stats = [...fieldStats.values()];
  if (pattern === "time_series" && stats.some((s) => s.fieldType === "numeric" && s.changePoints.length > 0)) return "time_series";
  if (pattern === "logs") {
    const message = [...fieldStats].find(([key]) => key.toLowerCase().includes("message"))?.[1];
    if (message && message.uniqueRatio < 0.5) return "cluster";
  }
  return pattern === "search_results" ? "top_n" : "smart_sample";
}
