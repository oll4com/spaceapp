/**
 * Query signals for SmartCrusher planning. TypeScript port of Headroom `smart_crusher/anchors.rs` and the
 * lexical-only `relevance/{bm25,hybrid}.rs` path (Apache-2.0, Headroom Contributors): without the ONNX
 * embedding model the hybrid scorer is BM25 with a boost, which is the default here. Rust's `regex` is
 * Unicode-aware, so `\b` and `\d` are spelled out with Unicode classes.
 */
import { compareCodePoints, JsonNumber, rustTrim, type JsonValue } from "./json.js";

export interface RelevanceScorer {
  /** One score in [0, 1] per item; an empty context scores everything 0. */
  scoreBatch(items: readonly string[], context: string): number[];
}

const W = "[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\u200c\\u200d]";
const B = `(?:(?<=${W})(?!${W})|(?<!${W})(?=${W}))`;
const D = "\\p{Nd}";
const HEX = "[0-9a-fA-F]";
const UUID = `${HEX}{8}-${HEX}{4}-${HEX}{4}-${HEX}{4}-${HEX}{12}`;
const HOSTNAME = `${B}[a-zA-Z0-9][-a-zA-Z0-9]*\\.[a-zA-Z0-9][-a-zA-Z0-9]*(?:\\.[a-zA-Z]{2,})?${B}`;
// `[A-Z|a-z]` (literal pipe) is an upstream Python typo kept for parity.
const EMAIL = `${B}[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Z|a-z]{2,}${B}`;

const regex = (source: string) => new RegExp(source, "gu");
const matches = (source: string, text: string) => [...text.matchAll(regex(source))];

/** Deterministic exact-match anchors (UUIDs, numeric IDs, hostnames, quoted strings, emails), lowercased. */
export function extractQueryAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  if (!text) return anchors;
  for (const [m] of matches(`${B}${UUID}${B}`, text)) anchors.add(m.toLowerCase());
  for (const [m] of matches(`${B}${D}{4,}${B}`, text)) anchors.add(m);
  for (const [m] of matches(HOSTNAME, text)) {
    const lower = m.toLowerCase();
    if (!["e.g", "i.e", "etc."].includes(lower)) anchors.add(lower);
  }
  for (const m of matches(`['"]([^'"]{1,50})['"]`, text)) {
    const inner = m[1]!;
    if (Buffer.byteLength(rustTrim(inner), "utf8") >= 2) anchors.add(inner.toLowerCase());
  }
  for (const [m] of matches(EMAIL, text)) anchors.add(m.toLowerCase());
  return anchors;
}

/** Python `str(item)` as upstream renders it: single quotes, `True`/`None`, spaced separators. */
function pythonRepr(value: JsonValue): string {
  if (value === null) return "None";
  if (typeof value === "boolean") return value ? "True" : "False";
  if (value instanceof JsonNumber) return value.raw;
  if (typeof value === "string") return `'${value}'`;
  if (Array.isArray(value)) return `[${value.map(pythonRepr).join(", ")}]`;
  return `{${[...value].map(([key, item]) => `'${key}': ${pythonRepr(item)}`).join(", ")}}`;
}

export function itemMatchesAnchors(item: JsonValue, anchors: ReadonlySet<string>): boolean {
  if (anchors.size === 0) return false;
  const text = pythonRepr(item).toLowerCase();
  return [...anchors].some((anchor) => text.includes(anchor));
}

const TOKEN = regex(`${UUID}|${B}${D}{4,}${B}|[a-zA-Z0-9_]+`);
const tokenize = (text: string) => (text ? [...text.toLowerCase().matchAll(TOKEN)].map(([m]) => m) : []);

/**
 * Plain BM25 (Headroom `BM25Scorer`, without the hybrid boost): k1 1.5, b 0.75, idf ln 2, divided by 10 and capped at
 * 1, plus 0.3 when a matched term has 8+ bytes. TextCrusher scores sentences with it.
 */
export const bm25Scorer: RelevanceScorer = {
  scoreBatch(items, context) {
    const contextTokens = tokenize(context);
    if (contextTokens.length === 0) return items.map(() => 0);
    const queryFrequency = new Map<string, number>();
    for (const token of contextTokens) queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);
    const terms = [...queryFrequency.keys()].sort(compareCodePoints);
    const documents = items.map(tokenize);
    const avgLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(items.length, 1);
    return documents.map((tokens) => {
      const docLength = tokens.length;
      const avgdl = avgLength > 0 ? avgLength : docLength > 0 ? docLength : 1;
      const docFrequency = new Map<string, number>();
      for (const token of tokens) docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
      let raw = 0;
      let longMatch = false;
      for (const term of terms) {
        const f = docFrequency.get(term);
        if (f === undefined) continue;
        if (Buffer.byteLength(term, "utf8") >= 8) longMatch = true;
        raw += ((Math.LN2 * (f * 2.5)) / (f + 1.5 * (1 - 0.75 + (0.75 * docLength) / avgdl))) * queryFrequency.get(term)!;
      }
      const normalized = Math.min(raw / 10, 1);
      return longMatch ? Math.min(normalized + 0.3, 1) : normalized;
    });
  }
};

/** BM25 (k1 1.5, b 0.75, idf ln 2, /10 normalization, +0.3 for 8+ byte matches) with the hybrid boost. */
export const bm25HybridScorer: RelevanceScorer = {
  scoreBatch(items, context) {
    const contextTokens = tokenize(context);
    if (contextTokens.length === 0) return items.map(() => 0);
    const queryFrequency = new Map<string, number>();
    for (const token of contextTokens) queryFrequency.set(token, (queryFrequency.get(token) ?? 0) + 1);
    // Upstream sums terms in sorted order; keep it so floating-point totals agree.
    const terms = [...queryFrequency.keys()].sort(compareCodePoints);
    const documents = items.map(tokenize);
    const avgLength = documents.reduce((sum, tokens) => sum + tokens.length, 0) / Math.max(items.length, 1);
    return documents.map((tokens) => {
      if (tokens.length === 0) return 0;
      const docLength = tokens.length;
      const avgdl = avgLength > 0 ? avgLength : docLength;
      const docFrequency = new Map<string, number>();
      for (const token of tokens) docFrequency.set(token, (docFrequency.get(token) ?? 0) + 1);
      let raw = 0;
      const matched: string[] = [];
      for (const term of terms) {
        const f = docFrequency.get(term);
        const qf = queryFrequency.get(term)!;
        if (f === undefined) continue;
        matched.push(term);
        raw += ((Math.LN2 * (f * 2.5)) / (f + 1.5 * (1 - 0.75 + (0.75 * docLength) / avgdl))) * qf;
      }
      let score = Math.min(raw / 10, 1);
      if (matched.some((term) => Buffer.byteLength(term, "utf8") >= 8)) score = Math.min(score + 0.3, 1);
      if (matched.length > 0) {
        score = Math.max(score, 0.3);
        if (matched.length >= 2) score = Math.min(score + 0.2, 1);
      }
      return Math.min(Math.max(score, 0), 1);
    });
  }
};
