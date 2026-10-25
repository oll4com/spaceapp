/**
 * SmartCrusher: statistical, schema-preserving compression of JSON tool output. TypeScript port of
 * Headroom `smart_crusher/crusher.rs` (Apache-2.0, Headroom Contributors) as constructed by
 * `SmartCrusher::without_compaction` (the lossy path the parity fixtures pin): arrays are recursively
 * crushed by element type, dropped dict rows are announced by a `{"_ccr_dropped": "<<ccr:HASH N_rows_offloaded>>"}`
 * sentinel, and long opaque strings are replaced by `<<ccr:HASH,KIND,SIZE>>` markers. The lossless
 * table-compaction stage of `SmartCrusher::new` and the opt-in prose hook are not ported.
 */
import { createHash } from "node:crypto";
import { computeOptimalK } from "./adaptive-sizer.js";
import { analyzeArray } from "./analyzer.js";
import { DEFAULT_SMART_CRUSHER_CONFIG, type SmartCrusherConfig } from "./config.js";
import { computeKSplit, crushNumberArray, crushObject, crushStringArray } from "./crushers.js";
import {
  asF64, hasWhitespace, isObject, jsonEquals, JsonNumber, parseJson, pythonJsonDumps, rustTrim, rustTrimStart,
  swapRemove, toJson, utf8Length, type JsonObject, type JsonValue
} from "./json.js";
import { DEFAULT_CONSTRAINTS, type Constraint } from "./outliers.js";
import { createPlan, type PlanContext } from "./planning.js";
import { bm25HybridScorer, type RelevanceScorer } from "./relevance.js";
import { mean, sampleStdev, toFixedExact } from "./stats.js";

/** Receives the full original payload behind every emitted CCR marker, keyed by the marker hash. */
export interface CcrStore {
  put(hash: string, payload: string): void;
}

export interface SmartCrusherOptions {
  ccrStore?: CcrStore;
  /** Relevance scorer for non-empty queries; defaults to Headroom's lexical BM25 fallback. */
  scorer?: RelevanceScorer;
  /** Must-keep predicates; defaults to error-keyword items and structural outliers. */
  constraints?: readonly Constraint[];
}

export interface SmartCrushInput {
  content: string;
  /** User/task context used to pin matching items. Default "". */
  query?: string;
  /** Multiplier on the adaptive keep count (> 1 keeps more). Default 1. */
  bias?: number;
}

export interface SmartCrushResult {
  compressed: string;
  original: string;
  wasModified: boolean;
  strategy: string;
}

interface CrushArrayResult {
  items: JsonValue[];
  strategyInfo: string;
  droppedSummary: string;
}

type ArrayType = "dict" | "string" | "number" | "bool" | "nested" | "mixed" | "empty";
type OpaqueKind = "base64" | "html" | "string";

const MAX_PROCESS_DEPTH = 50;
const CCR_MARKER_PREFIX = "<<ccr:";
const OPAQUE_MIN_BYTES = 256;

const sha256Prefix = (text: string) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12);

function typeKey(item: JsonValue): "dict" | "str" | "bool" | "number" | "list" | "none" {
  if (item === null) return "none";
  if (typeof item === "boolean") return "bool";
  if (typeof item === "string") return "str";
  if (item instanceof JsonNumber) return "number";
  return Array.isArray(item) ? "list" : "dict";
}

function classifyArray(items: readonly JsonValue[]): ArrayType {
  if (items.length === 0) return "empty";
  const kinds = new Set(items.map(typeKey));
  if (kinds.size > 1) return "mixed";
  const only = { dict: "dict", str: "string", number: "number", bool: "bool", list: "nested", none: "mixed" } as const;
  return only[[...kinds][0]!];
}

/** Parse a string that looks like a JSON container (`{`/`[` after leading whitespace). */
function tryParseJsonContainer(s: string): JsonObject | JsonValue[] | undefined {
  const first = rustTrimStart(s)[0];
  if (first !== "{" && first !== "[") return undefined;
  const parsed = parseJson(s);
  return isObject(parsed) || Array.isArray(parsed) ? parsed : undefined;
}

function looksLikeBase64(s: string): boolean {
  const total = utf8Length(s);
  if (total < 64 || s.includes("<") || s.includes(">") || hasWhitespace(s)) return false;
  let alphabet = 0;
  const unique = new Set<string>();
  for (const c of s) {
    if (/^[A-Za-z0-9+/=_-]$/.test(c)) alphabet++;
    unique.add(c);
  }
  return alphabet / total >= 0.95 && unique.size >= 16;
}

function looksLikeHtml(s: string): boolean {
  if ((s.match(/</g)?.length ?? 0) < 3) return false;
  return (s.match(/<[A-Za-z/!]/g)?.length ?? 0) >= 3;
}

const humanize = (bytes: number) =>
  bytes < 1024 ? `${bytes}B` : bytes < 1024 * 1024 ? `${toFixedExact(bytes / 1024, 1)}KB` : `${toFixedExact(bytes / 1024 / 1024, 1)}MB`;

export class SmartCrusher {
  readonly config: SmartCrusherConfig;
  private readonly plan: PlanContext;

  constructor(config: Partial<SmartCrusherConfig> = {}, private readonly options: SmartCrusherOptions = {}) {
    this.config = { ...DEFAULT_SMART_CRUSHER_CONFIG, ...config };
    this.plan = { config: this.config, constraints: options.constraints ?? DEFAULT_CONSTRAINTS, scorer: options.scorer ?? bm25HybridScorer };
  }

  /** Parse, crush every array/object/string in place, and re-serialize compactly. Non-JSON passes through. */
  crush(content: string, query = "", bias = 1.0): SmartCrushResult {
    const parsed = parseJson(content);
    if (parsed === undefined) return { compressed: content, original: content, wasModified: false, strategy: "passthrough" };
    const [crushed, info] = this.processValue(parsed, 0, query, bias);
    const compressed = toJson(crushed);
    return { compressed, original: content, wasModified: compressed !== rustTrim(content), strategy: info || "passthrough" };
  }

  private processValue(value: JsonValue, depth: number, query: string, bias: number): [JsonValue, string] {
    if (depth >= MAX_PROCESS_DEPTH) return [value, ""];
    const info: string[] = [];
    if (Array.isArray(value)) {
      const n = value.length;
      if (n >= this.config.minItemsToAnalyze) {
        switch (classifyArray(value)) {
          case "dict": {
            const result = this.crushArray(value, query, bias);
            const items = [...result.items];
            if (result.droppedSummary) items.push(new Map([["_ccr_dropped", result.droppedSummary]]));
            return [items, `${result.strategyInfo}(${n}->${result.items.length})`];
          }
          case "string": {
            const [crushed, strategy] = crushStringArray(value as string[], this.config, bias);
            return [crushed, `${strategy}(${n}->${crushed.length})`];
          }
          case "number": {
            const [crushed, strategy] = crushNumberArray(value, this.config, bias);
            return [crushed, `${strategy}(${n}->${crushed.length})`];
          }
          case "mixed": {
            const [crushed, strategy] = this.crushMixedArray(value, query, bias);
            return [crushed, `${strategy}(${n}->${crushed.length})`];
          }
          default:
            break;
        }
      }
      const processed = value.map((item) => {
        const [result, itemInfo] = this.processValue(item, depth + 1, query, bias);
        if (itemInfo) info.push(itemInfo);
        return result;
      });
      return [processed, info.join(",")];
    }
    if (isObject(value)) {
      const processed: JsonObject = new Map();
      for (const [key, item] of value) {
        const [result, itemInfo] = this.processValue(item, depth + 1, query, bias);
        processed.set(key, result);
        if (itemInfo) info.push(itemInfo);
      }
      if (processed.size >= this.config.minItemsToAnalyze) {
        const [crushed, strategy] = crushObject(processed, this.config, bias);
        if (strategy !== "object:passthrough") return [crushed, [...info, strategy].join(",")];
      }
      return [processed, info.join(",")];
    }
    if (typeof value === "string") return this.processString(value, depth, query, bias);
    return [value, ""];
  }

  /** Stringified JSON is crushed and re-embedded; long opaque strings become CCR markers. */
  private processString(s: string, depth: number, query: string, bias: number): [JsonValue, string] {
    const parsed = tryParseJsonContainer(s);
    if (parsed !== undefined) {
      const [processed, subInfo] = this.processValue(parsed, depth + 1, query, bias);
      if (!jsonEquals(processed, parsed)) return [toJson(processed), subInfo ? `string_json[${subInfo}]` : "string_json"];
      return [s, ""];
    }
    const kind = this.opaqueKind(s);
    if (kind === undefined) return [s, ""];
    const hash = sha256Prefix(s);
    this.options.ccrStore?.put(hash, s);
    return [`<<ccr:${hash},${kind},${humanize(utf8Length(s))}>>`, `string_ccr:${kind}`];
  }

  private opaqueKind(s: string): OpaqueKind | undefined {
    // Never re-offload a string that already carries a marker: its payload is in the store under that hash.
    if (s.includes(CCR_MARKER_PREFIX)) return undefined;
    if (utf8Length(s) <= OPAQUE_MIN_BYTES || !this.config.enableCcrMarker || this.config.losslessOnly) return undefined;
    if (looksLikeBase64(s)) return "base64";
    return looksLikeHtml(s) ? "html" : "string";
  }

  /** Dict arrays: adaptive K, crushability gate, strategy plan, CCR sentinel for dropped rows. */
  private crushArray(items: readonly JsonValue[], query: string, bias: number): CrushArrayResult {
    const unchanged = (strategyInfo: string): CrushArrayResult => ({ items: [...items], strategyInfo, droppedSummary: "" });
    const itemStrings = items.map(toJson);
    const adaptiveK = computeOptimalK(itemStrings, bias, 3, this.config.maxItemsAfterCrush > 0 ? this.config.maxItemsAfterCrush : undefined);
    if (items.length <= adaptiveK) return unchanged("none:adaptive_at_limit");
    // Strict lossless mode may not drop rows: that would need a marker.
    if (this.config.losslessOnly) return unchanged("lossless_only:uncompacted");

    const analysis = analyzeArray(items, this.config, itemStrings);
    if (analysis.recommendedStrategy === "skip") return unchanged(analysis.crushability ? `skip:${analysis.crushability.reason}` : "");

    const keep = createPlan(this.plan, analysis, items, query, adaptiveK, itemStrings);
    const kept = keep.filter((i) => i < items.length).map((i) => items[i]!);
    const result = this.config.factorOutConstants ? factorOutConstants(kept, analysis.constantFields) : kept;

    const dropped = Math.max(0, items.length - result.length);
    let droppedSummary = "";
    if (dropped > 0 && this.config.enableCcrMarker) {
      const canonical = toJson([...items]);
      const hash = sha256Prefix(canonical);
      this.options.ccrStore?.put(hash, canonical);
      droppedSummary = `<<ccr:${hash} ${dropped}_rows_offloaded>>`;
    }
    return { items: result, strategyInfo: analysis.recommendedStrategy, droppedSummary };
  }

  /** Heterogeneous arrays: crush each type group of >= `minItemsToAnalyze` items, keep the rest, preserve order. */
  private crushMixedArray(items: readonly JsonValue[], query: string, bias: number): [JsonValue[], string] {
    const n = items.length;
    if (n <= 8) return [[...items], "mixed:passthrough"];
    const groups = new Map<string, number[]>();
    items.forEach((item, i) => {
      const key = typeKey(item);
      const members = groups.get(key);
      if (members) members.push(i);
      else groups.set(key, [i]);
    });

    const keep = new Set<number>();
    const parts: string[] = [];
    for (const [key, indices] of groups) {
      const values = indices.map((i) => items[i]!);
      if (values.length < this.config.minItemsToAnalyze || !["dict", "str", "number"].includes(key)) {
        indices.forEach((i) => keep.add(i));
        continue;
      }
      if (key === "dict") {
        const crushed = this.crushArray(values, query, bias).items;
        const survivors = new Set(crushed.map((item) => pythonJsonDumps(item, true)));
        indices.forEach((idx, i) => {
          if (survivors.has(pythonJsonDumps(values[i]!, true))) keep.add(idx);
        });
        parts.push(`dict:${values.length}->${crushed.length}`);
      } else if (key === "str") {
        const [crushed] = crushStringArray(values as string[], this.config, bias);
        const survivors = new Set(crushed);
        indices.forEach((idx, i) => {
          if (survivors.has(values[i] as string)) keep.add(idx);
        });
        parts.push(`str:${values.length}->${crushed.length}`);
      } else {
        const [, kFirstRaw, kLastRaw] = computeKSplit(values.map(toJson), this.config, bias);
        const kFirst = Math.min(kFirstRaw, values.length);
        const kLast = Math.min(kLastRaw, values.length - kFirst);
        indices.slice(0, kFirst).forEach((i) => keep.add(i));
        indices.slice(indices.length - kLast).forEach((i) => keep.add(i));
        const numbers = values.map(asF64);
        const finite = numbers.filter((value): value is number => value !== undefined);
        const meanValue = mean(finite);
        const std = finite.length > 1 ? sampleStdev(finite) : undefined;
        if (meanValue !== undefined && std !== undefined && std > 0) {
          numbers.forEach((value, i) => {
            if (value !== undefined && Math.abs(value - meanValue) > this.config.varianceThreshold * std) keep.add(indices[i]!);
          });
        }
        parts.push(`num:${values.length}`);
      }
    }
    const result = [...keep].sort((a, b) => a - b).map((i) => items[i]!);
    return [result, `mixed:adaptive(${n}->${result.length},${parts.join(",")})`];
  }
}

/**
 * Optional (`factorOutConstants`): strip fields constant across ALL rows from kept objects and emit them
 * once in a leading `{"_constant_fields": {...}}` sentinel. Only exact-value matches are stripped.
 */
function factorOutConstants(kept: JsonValue[], constants: Map<string, JsonValue>): JsonValue[] {
  if (constants.size === 0 || kept.length < 2) return kept;
  let stripped = false;
  const slim = kept.map((item) => {
    if (!isObject(item)) return item;
    const copy: JsonObject = new Map(item);
    for (const [key, constant] of constants) {
      if (copy.has(key) && jsonEquals(copy.get(key), constant)) {
        swapRemove(copy, key);
        stripped = true;
      }
    }
    return copy;
  });
  return stripped ? [new Map([["_constant_fields", new Map(constants)]]), ...slim] : kept;
}

/** Crush one tool output. `config` overrides the Headroom defaults field by field. */
export function smartCrush(input: SmartCrushInput, config: Partial<SmartCrusherConfig> = {}, options: SmartCrusherOptions = {}): SmartCrushResult {
  return new SmartCrusher(config, options).crush(input.content, input.query ?? "", input.bias ?? 1.0);
}
