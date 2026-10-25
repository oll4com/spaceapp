/**
 * Search-results compressor for grep / ripgrep output. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/search_compressor.rs` (Apache-2.0, Headroom Contributors), which the
 * Python `headroom.transforms.search_compressor` delegates to. Ported with its unit tests.
 *
 * Pipeline: parse `file:line:content` / `file-line-content` lines and group them by file; score each match
 * (query-word and CJK-bigram overlap, error/warning/importance keywords, configured keywords; f32 like Rust);
 * rank files by total score and cap to `maxFiles`; size the global budget with the adaptive sizer and `bias`;
 * per file keep the first and last match and fill by score; print survivors in line order with an
 * `[... and N more matches in file]` summary; optionally store the original for CCR and append the marker.
 */
import { createHash } from "node:crypto";
import { computeOptimalK } from "./adaptive-sizer.js";
import { searchImportance, type SearchImportance } from "./keyword-importance.js";
import { parseMatchLine } from "./parse-line.js";
import { asciiLowercase, byteLength, compareCodePoints, isCjkChar, splitWhitespace, trim } from "./rust-text.js";

export { parseMatchLine, type ParsedMatchLine } from "./parse-line.js";

export interface SearchMatch {
  file: string;
  /** u64 in Headroom; bigint keeps huge line numbers exact. */
  lineNumber: bigint;
  content: string;
  /** Relevance in [0, 1], an f32 value; set by `scoreMatches`. */
  score: number;
}

export interface FileMatches {
  file: string;
  matches: SearchMatch[];
}

/** Matches by file path, iterated in code-point order of the path (Headroom's BTreeMap). */
export type FileMatchMap = Map<string, FileMatches>;

export interface SearchCompressorConfig {
  maxMatchesPerFile: number;
  alwaysKeepFirst: boolean;
  alwaysKeepLast: boolean;
  /** Upper bound for the adaptive global budget, which never drops below 5. */
  maxTotalMatches: number;
  maxFiles: number;
  contextKeywords: string[];
  boostErrors: boolean;
  enableCcr: boolean;
  minMatchesForCcr: number;
  /** CCR only when compressed/original bytes is below this. */
  minCompressionRatioForCcr: number;
  /** `rg --heading` style: path once per file, then `line:content` rows, blank line between files. */
  groupByFile: boolean;
}

export const defaultSearchCompressorConfig: Readonly<SearchCompressorConfig> = Object.freeze({
  maxMatchesPerFile: 5,
  alwaysKeepFirst: true,
  alwaysKeepLast: true,
  maxTotalMatches: 30,
  maxFiles: 15,
  contextKeywords: [],
  boostErrors: true,
  enableCcr: true,
  minMatchesForCcr: 10,
  minCompressionRatioForCcr: 0.8,
  groupByFile: false
});

export interface SearchCompressionResult {
  /** Formatted output, with the CCR marker appended when one was emitted. */
  compressed: string;
  original: string;
  originalMatchCount: number;
  compressedMatchCount: number;
  /** Files found in the input, before the `maxFiles` cap. */
  filesAffected: number;
  /** UTF-8 bytes of the output (without CCR marker) over the input's. */
  compressionRatio: number;
  cacheKey: string | null;
  /** File path to the `[... and N more matches ...]` line printed for it. */
  summaries: Map<string, string>;
}

export interface SearchCompressorStats {
  linesScanned: number;
  linesUnparsed: number;
  filesDropped: number;
  matchesDroppedByPerFileCap: number;
  matchesDroppedByGlobalCap: number;
  ccrEmitted: boolean;
  ccrSkipReason: "below min_matches_for_ccr" | "compression ratio too high" | "no store provided" | "ccr disabled in config" | null;
}

/** Where the original goes when a CCR marker is emitted; the key is MD5(original) hex, first 24 chars. */
export interface CcrStore {
  put(hash: string, payload: string): void;
}

export const emptySearchCompressorStats = (): SearchCompressorStats => ({
  linesScanned: 0, linesUnparsed: 0, filesDropped: 0, matchesDroppedByPerFileCap: 0, matchesDroppedByGlobalCap: 0, ccrEmitted: false, ccrSkipReason: null
});

const resolve = (config: Partial<SearchCompressorConfig>): SearchCompressorConfig => ({ ...defaultSearchCompressorConfig, ...config });

/**
 * Headroom `SearchCompressor::compress_with_store(content, context, bias, store)`; without a store this is
 * `compress(content, context, bias)` and no CCR marker is emitted. Python passes context "" and bias 1.0 by
 * default; Headroom's live zone uses context "" and bias 0.0.
 */
export function compressSearchResults(
  content: string,
  context = "",
  bias = 1,
  config: Partial<SearchCompressorConfig> = {},
  store?: CcrStore
): { result: SearchCompressionResult; stats: SearchCompressorStats } {
  const settings = resolve(config);
  const stats = emptySearchCompressorStats();
  const parsed = parseSearchResults(content, stats);
  if (parsed.size === 0) {
    return {
      result: { compressed: content, original: content, originalMatchCount: 0, compressedMatchCount: 0, filesAffected: 0, compressionRatio: 1, cacheKey: null, summaries: new Map() },
      stats
    };
  }

  const originalCount = countMatches(parsed);
  scoreMatches(parsed, context, settings);
  const selected = selectMatches(parsed, bias, settings, stats);
  const { output, summaries } = formatOutput(selected, parsed, settings);
  const compressedCount = countMatches(selected);
  const ratio = byteLength(output) / Math.max(byteLength(content), 1);

  let compressed = output;
  let cacheKey: string | null = null;
  if (!settings.enableCcr) stats.ccrSkipReason = "ccr disabled in config";
  else if (originalCount < settings.minMatchesForCcr) stats.ccrSkipReason = "below min_matches_for_ccr";
  else if (ratio >= settings.minCompressionRatioForCcr) stats.ccrSkipReason = "compression ratio too high";
  else if (!store) stats.ccrSkipReason = "no store provided";
  else {
    cacheKey = createHash("md5").update(content, "utf8").digest("hex").slice(0, 24);
    store.put(cacheKey, content);
    compressed += `\n[${originalCount} matches compressed to ${compressedCount}. Retrieve more: hash=${cacheKey}]`;
    stats.ccrEmitted = true;
  }

  return {
    result: { compressed, original: content, originalMatchCount: originalCount, compressedMatchCount: compressedCount, filesAffected: parsed.size, compressionRatio: ratio, cacheKey, summaries },
    stats
  };
}

/** Live-zone dispatch as in Headroom `live_zone.rs`: default config, empty query, bias 0.0, no CCR store; null when unchanged. */
export function compressSearchForLiveZone(text: string): string | null {
  const { result } = compressSearchResults(text, "", 0);
  return result.compressed === result.original ? null : result.compressed;
}

/** Rough tokens saved (UTF-8 bytes / 4), as Headroom's `tokens_saved_estimate`. */
export const tokensSavedEstimate = (result: SearchCompressionResult): number =>
  Math.floor(Math.max(0, byteLength(result.original) - byteLength(result.compressed)) / 4);

export const matchesOmitted = (result: SearchCompressionResult): number => Math.max(0, result.originalMatchCount - result.compressedMatchCount);

export function parseSearchResults(content: string, stats: SearchCompressorStats = emptySearchCompressorStats()): FileMatchMap {
  const files: FileMatchMap = new Map();
  for (const raw of content.split("\n")) {
    const line = trim(raw);
    if (line === "") continue;
    stats.linesScanned += 1;
    const parsed = parseMatchLine(line);
    if (!parsed) {
      stats.linesUnparsed += 1;
      continue;
    }
    const [file, lineNumber, body] = parsed;
    let group = files.get(file);
    if (!group) files.set(file, (group = { file, matches: [] }));
    group.matches.push({ file, lineNumber, content: body, score: 0 });
  }
  return new Map(sortedEntries(files));
}

/** CJK character bigrams from the CJK runs of `text`, so a spaceless CJK query can match content. */
export function cjkBigrams(text: string): Set<string> {
  const bigrams = new Set<string>();
  let run: string[] = [];
  const flush = () => {
    for (let i = 0; i + 1 < run.length; i += 1) bigrams.add(run[i]! + run[i + 1]!);
    run = [];
  };
  for (const char of text) {
    if (isCjkChar(char.codePointAt(0)!)) run.push(char);
    else flush();
  }
  flush();
  return bigrams;
}

const f32 = Math.fround;
const contextWordBoost = f32(0.3);
const keywordBoost = f32(0.4);
const importanceBoost: Record<SearchImportance, number> = { error: f32(0.5), warning: f32(0.4), importance: f32(0.3) };

/** Sets every match's score: 0.3 per query word (> 2 chars) or CJK bigram found, the keyword boost, 0.4 per configured keyword; capped at 1. */
export function scoreMatches(files: FileMatchMap, context: string, config: Partial<SearchCompressorConfig> = {}): void {
  const settings = resolve(config);
  const contextLower = asciiLowercase(context);
  const contextWords = new Set(splitWhitespace(contextLower).filter((word) => Array.from(word).length > 2));
  for (const bigram of cjkBigrams(contextLower)) contextWords.add(bigram);
  const keywords = settings.contextKeywords.map(asciiLowercase);

  for (const group of files.values()) {
    for (const match of group.matches) {
      let score = 0;
      const contentLower = asciiLowercase(match.content);
      for (const word of contextWords) if (contentLower.includes(word)) score = f32(score + contextWordBoost);
      if (settings.boostErrors) {
        const importance = searchImportance(match.content);
        if (importance) score = f32(score + importanceBoost[importance]);
      }
      for (const keyword of keywords) if (contentLower.includes(keyword)) score = f32(score + keywordBoost);
      match.score = Math.min(score, 1);
    }
  }
}

/** Picks the surviving matches per file; files beyond `maxFiles` or past the adaptive budget are dropped. */
export function selectMatches(
  files: FileMatchMap,
  bias: number,
  config: Partial<SearchCompressorConfig> = {},
  stats: SearchCompressorStats = emptySearchCompressorStats()
): FileMatchMap {
  const settings = resolve(config);
  // Stable sort on code-point key order, as Headroom sorts its BTreeMap entries.
  const byScore = sortedEntries(files).map(([file, group]) => ({ file, group, total: totalScore(group) }));
  byScore.sort((a, b) => b.total - a.total || 0);
  if (byScore.length > settings.maxFiles) {
    stats.filesDropped += byScore.length - settings.maxFiles;
    byScore.length = settings.maxFiles;
  }

  const matchStrings = byScore.flatMap(({ file, group }) => group.matches.map((match) => `${file}:${match.lineNumber}:${match.content}`));
  const adaptiveTotal = computeOptimalK(matchStrings, bias, 5, settings.maxTotalMatches);

  const selected: FileMatchMap = new Map();
  let totalSelected = 0;
  for (const { file, group } of byScore) {
    if (totalSelected >= adaptiveTotal) {
      stats.matchesDroppedByGlobalCap += group.matches.length;
      continue;
    }
    const byRelevance = [...group.matches].sort((a, b) => b.score - a.score || compareBigints(a.lineNumber, b.lineNumber));
    const remainingCap = Math.min(settings.maxMatchesPerFile, Math.max(0, adaptiveTotal - totalSelected));
    const kept: SearchMatch[] = [];
    const seen = new Set<string>();
    const keep = (match: SearchMatch) => {
      const key = `${match.lineNumber}:${match.content}`;
      if (seen.has(key)) return;
      seen.add(key);
      kept.push({ ...match });
    };

    const first = group.matches[0];
    const last = group.matches[group.matches.length - 1];
    if (settings.alwaysKeepFirst && first && kept.length < remainingCap) keep(first);
    if (settings.alwaysKeepLast && group.matches.length > 1 && last && kept.length < remainingCap) keep(last);
    for (const match of byRelevance) {
      if (kept.length >= remainingCap) break;
      keep(match);
    }
    kept.sort((a, b) => compareBigints(a.lineNumber, b.lineNumber));

    stats.matchesDroppedByPerFileCap += Math.max(0, group.matches.length - kept.length);
    totalSelected += kept.length;
    selected.set(file, { file, matches: kept });
  }
  return new Map(sortedEntries(selected));
}

/** Prints the selection in path order with a summary line for every file that lost matches. */
export function formatOutput(
  selected: FileMatchMap,
  original: FileMatchMap,
  config: Partial<SearchCompressorConfig> = {}
): { output: string; summaries: Map<string, string> } {
  const grouped = resolve(config).groupByFile;
  const lines: string[] = [];
  const summaries = new Map<string, string>();
  for (const [file, group] of sortedEntries(selected)) {
    if (grouped) {
      if (lines.length > 0) lines.push("");
      lines.push(file);
      for (const match of group.matches) lines.push(`${match.lineNumber}:${match.content}`);
    } else {
      for (const match of group.matches) lines.push(`${match.file}:${match.lineNumber}:${match.content}`);
    }
    const originalCount = original.get(file)?.matches.length ?? 0;
    if (originalCount > group.matches.length) {
      const omitted = originalCount - group.matches.length;
      const summary = grouped ? `[... and ${omitted} more matches]` : `[... and ${omitted} more matches in ${file}]`;
      lines.push(summary);
      summaries.set(file, summary);
    }
  }
  return { output: lines.join("\n"), summaries };
}

export const totalScore = (group: FileMatches): number => group.matches.reduce((sum, match) => f32(sum + match.score), 0);

const countMatches = (files: FileMatchMap): number => {
  let count = 0;
  for (const group of files.values()) count += group.matches.length;
  return count;
};

const sortedEntries = <T>(map: Map<string, T>): [string, T][] => [...map].sort(([a], [b]) => compareCodePoints(a, b));
const compareBigints = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
