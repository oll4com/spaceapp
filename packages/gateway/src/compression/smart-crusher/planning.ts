/**
 * Strategy-specific keep-index planning and budget prioritization. TypeScript port of Headroom
 * `smart_crusher/{planning,orchestration}.rs` (Apache-2.0, Headroom Contributors). TOIN learned
 * preserve-fields are not ported (upstream passes none either), so that branch is omitted.
 */
import { numericAnomalies, type ArrayAnalysis, type CompressionStrategy } from "./analyzer.js";
import { computeItemHash, md5Hex, selectAnchors, type DataPattern } from "./anchor-selector.js";
import type { SmartCrusherConfig } from "./config.js";
import { detectScoreField } from "./fields.js";
import { asF64, isObject, JsonNumber, toJson, type JsonValue } from "./json.js";
import { detectErrorItems, detectStructuralOutliers, type Constraint } from "./outliers.js";
import { extractQueryAnchors, itemMatchesAnchors, type RelevanceScorer } from "./relevance.js";

export interface PlanContext {
  config: SmartCrusherConfig;
  constraints: readonly Constraint[];
  scorer: RelevanceScorer;
}

const ANCHOR_PATTERN: Partial<Record<CompressionStrategy, DataPattern>> = { time_series: "time_series", top_n: "search_results", cluster: "logs" };

const sortedIndices = (set: Set<number>) => [...set].sort((a, b) => a - b);

/** Returns the kept indices in ascending order. */
export function createPlan(ctx: PlanContext, analysis: ArrayAnalysis, items: readonly JsonValue[], query: string, maxItems: number, itemStrings: readonly string[]): number[] {
  switch (analysis.recommendedStrategy) {
    case "skip":
      return [...items.keys()];
    case "time_series":
      return planTimeSeries(ctx, analysis, items, query, maxItems, itemStrings);
    case "cluster":
      return planClusterSample(ctx, analysis, items, query, maxItems, itemStrings);
    case "top_n":
      return planTopN(ctx, analysis, items, query, maxItems, itemStrings);
    default:
      return planSmartSample(ctx, analysis, items, query, maxItems, itemStrings);
  }
}

function anchorsAndConstraints(ctx: PlanContext, strategy: CompressionStrategy, items: readonly JsonValue[], query: string, maxItems: number, itemStrings: readonly string[]): Set<number> {
  const keep = selectAnchors(items, maxItems, ANCHOR_PATTERN[strategy] ?? "generic", query || undefined, itemStrings);
  for (const constraint of ctx.constraints) for (const index of constraint(items, itemStrings)) keep.add(index);
  return keep;
}

function keepAroundChangePoints(analysis: ArrayAnalysis, n: number, radius: number, keep: Set<number>): void {
  for (const stats of analysis.fieldStats.values()) {
    for (const point of stats.changePoints) {
      for (let idx = point - radius; idx <= point + radius; idx++) if (idx >= 0 && idx < n) keep.add(idx);
    }
  }
}

function planSmartSample(ctx: PlanContext, analysis: ArrayAnalysis, items: readonly JsonValue[], query: string, maxItems: number, itemStrings: readonly string[]): number[] {
  const keep = anchorsAndConstraints(ctx, "smart_sample", items, query, maxItems, itemStrings);
  numericAnomalies(analysis.fieldStats, items, ctx.config.varianceThreshold, keep);
  if (ctx.config.preserveChangePoints) keepAroundChangePoints(analysis, items.length, 1, keep);
  applyQuerySignals(ctx, items, query, itemStrings, keep);
  return prioritizeIndices(ctx.config, keep, items, analysis, maxItems);
}

function planTimeSeries(ctx: PlanContext, analysis: ArrayAnalysis, items: readonly JsonValue[], query: string, maxItems: number, itemStrings: readonly string[]): number[] {
  const keep = anchorsAndConstraints(ctx, "time_series", items, query, maxItems, itemStrings);
  keepAroundChangePoints(analysis, items.length, 2, keep);
  applyQuerySignals(ctx, items, query, itemStrings, keep);
  return prioritizeIndices(ctx.config, keep, items, analysis, maxItems);
}

/** Log-style data: anchors plus up to two representatives per message cluster (md5 of the first 50 chars). */
function planClusterSample(ctx: PlanContext, analysis: ArrayAnalysis, items: readonly JsonValue[], query: string, maxItems: number, itemStrings: readonly string[]): number[] {
  const keep = anchorsAndConstraints(ctx, "cluster", items, query, maxItems, itemStrings);
  let messageField: string | undefined;
  let maxUniqueness = 0;
  for (const [name, stats] of analysis.fieldStats) {
    if (stats.fieldType === "string" && stats.uniqueRatio > maxUniqueness && stats.uniqueRatio > 0.3) {
      messageField = name;
      maxUniqueness = stats.uniqueRatio;
    }
  }
  if (messageField !== undefined) {
    const clusters = new Map<string, number[]>();
    items.forEach((item, i) => {
      const message = isObject(item) ? item.get(messageField) : undefined;
      const hash = md5Hex(Array.from(typeof message === "string" ? message : "").slice(0, 50).join("")).slice(0, 8);
      const members = clusters.get(hash);
      if (members) members.push(i);
      else clusters.set(hash, [i]);
    });
    // Cluster order only matters for set membership, which is order-free.
    for (const indices of clusters.values()) for (const idx of indices.slice(0, 2)) keep.add(idx);
  }
  applyQuerySignals(ctx, items, query, itemStrings, keep);
  return prioritizeIndices(ctx.config, keep, items, analysis, maxItems);
}

/** Ranked data: top `maxItems - 3` by score, then constraints and capped high-confidence query matches. */
function planTopN(ctx: PlanContext, analysis: ArrayAnalysis, items: readonly JsonValue[], query: string, maxItems: number, itemStrings: readonly string[]): number[] {
  let scoreField: string | undefined;
  let maxConfidence = 0;
  for (const [name, stats] of analysis.fieldStats) {
    const [isScore, confidence] = detectScoreField(stats, items);
    if (isScore && confidence > maxConfidence) {
      scoreField = name;
      maxConfidence = confidence;
    }
  }
  if (scoreField === undefined) return planSmartSample(ctx, analysis, items, query, maxItems, itemStrings);

  const scored = items.map((item, i): [number, number] => [i, asF64(isObject(item) ? item.get(scoreField) : undefined) ?? 0]);
  scored.sort((a, b) => b[1] - a[1]);
  const keep = new Set(scored.slice(0, Math.max(0, maxItems - 3)).map(([i]) => i));
  for (const constraint of ctx.constraints) for (const index of constraint(items, itemStrings)) keep.add(index);
  if (query) {
    const anchors = extractQueryAnchors(query);
    items.forEach((item, i) => {
      if (!keep.has(i) && itemMatchesAnchors(item, anchors)) keep.add(i);
    });
    const threshold = Math.max(ctx.config.relevanceThreshold * 2, 0.5);
    let added = 0;
    const scores = ctx.scorer.scoreBatch(itemStrings, query);
    for (let i = 0; i < scores.length && added < 3; i++) {
      if (!keep.has(i) && scores[i]! >= threshold) {
        keep.add(i);
        added++;
      }
    }
  }
  return sortedIndices(keep);
}

function applyQuerySignals(ctx: PlanContext, items: readonly JsonValue[], query: string, itemStrings: readonly string[], keep: Set<number>): void {
  if (!query) return;
  const anchors = extractQueryAnchors(query);
  items.forEach((item, i) => {
    if (itemMatchesAnchors(item, anchors)) keep.add(i);
  });
  ctx.scorer.scoreBatch(itemStrings, query).forEach((score, i) => {
    if (score >= ctx.config.relevanceThreshold) keep.add(i);
  });
}

/** Content hash for dedup: Python-formatted JSON for containers, `str(item)` for scalars. */
function contentHash(item: JsonValue): string {
  if (isObject(item) || Array.isArray(item)) return computeItemHash(item);
  const text = typeof item === "string" ? item : item instanceof JsonNumber ? item.raw : item === null ? "None" : toJson(item);
  return md5Hex(text).slice(0, 16);
}

/** Collapse content-identical indices to their lowest representative. */
function deduplicateByContent(keep: Set<number>, items: readonly JsonValue[]): Set<number> {
  const seen = new Map<string, number>();
  for (const idx of sortedIndices(keep)) {
    if (idx >= items.length) continue;
    const hash = contentHash(items[idx]!);
    if (!seen.has(hash)) seen.set(hash, idx);
  }
  return new Set(seen.values());
}

/** Top up to `effectiveMax` with stride-sampled, content-unique items (interleaved stride scan). */
function fillRemainingSlots(keep: Set<number>, items: readonly JsonValue[], effectiveMax: number): Set<number> {
  const remaining = Math.max(0, effectiveMax - keep.size);
  if (remaining === 0) return keep;
  const seen = new Set<string>();
  for (const idx of keep) if (idx < items.length) seen.add(contentHash(items[idx]!));
  const candidates = [...items.keys()].filter((i) => !keep.has(i));
  if (candidates.length === 0) return keep;
  const result = new Set(keep);
  const step = Math.max(1, Math.floor(candidates.length / (remaining + 1)));
  let added = 0;
  for (let offset = 0; offset < step && added < remaining; offset++) {
    for (let i = offset; i < candidates.length && added < remaining; i += step) {
      const idx = candidates[i]!;
      const hash = contentHash(items[idx]!);
      if (seen.has(hash)) continue;
      result.add(idx);
      seen.add(hash);
      added++;
    }
  }
  return result;
}

/**
 * Dedup, fill, and if still over budget keep every critical item (errors, structural outliers, numeric
 * anomalies) plus first-3 / last-2, then the lowest remaining indices. May exceed the budget by design.
 */
export function prioritizeIndices(config: SmartCrusherConfig, keep: Set<number>, items: readonly JsonValue[], analysis: ArrayAnalysis | undefined, effectiveMax: number): number[] {
  const n = items.length;
  let current = config.dedupIdenticalItems ? deduplicateByContent(keep, items) : new Set(keep);
  if (current.size < effectiveMax && current.size < n) current = fillRemainingSlots(current, items, effectiveMax);
  if (current.size <= effectiveMax) return sortedIndices(current);

  const prioritized = new Set<number>([...detectErrorItems(items), ...detectStructuralOutliers(items)]);
  if (analysis) numericAnomalies(analysis.fieldStats, items, config.varianceThreshold, prioritized);
  let remaining = Math.max(0, effectiveMax - prioritized.size);
  const take = (i: number) => {
    if (remaining > 0 && !prioritized.has(i)) {
      prioritized.add(i);
      remaining--;
    }
  };
  if (remaining > 0) {
    for (let i = 0; i < Math.min(3, n); i++) take(i);
    for (let i = Math.max(0, n - 2); i < n; i++) take(i);
  }
  for (const i of sortedIndices(current)) take(i);
  return sortedIndices(prioritized);
}
