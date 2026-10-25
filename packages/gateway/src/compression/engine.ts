import { createHash } from "node:crypto";
import { detectContentType, type ContentType } from "./content-detector.js";
import { extractHtml } from "./html-extractor.js";
import { bestLosslessFold, compactLossless, looksLikeDiff, type LosslessKind } from "./lossless/index.js";
import { isMixedContent, splitIntoSections, type ContentSection } from "./mixed-content.js";
import { isObject, parseJson, toJson, type JsonValue } from "./smart-crusher/json.js";
import { codeModeCommands, isReadCommand, READ_TOOL_NAMES, toolCallCommand } from "./read-protection.js";
import { ERROR_PROTECTION_MAX_BYTES, hasStrongErrorIndicators, hasTestFailureReport, missingProtectedLines } from "./test-output.js";
import type { TokenizerKind } from "./tokenizer.js";
import { detectWasteSignals, REREAD_ADJACENT_GAP, REREAD_MIN_TOKENS, type WasteSignals } from "./waste-signals.js";

/**
 * Live-zone compression of a request body, after Headroom `live_zone.rs` (Apache-2.0, Headroom Contributors):
 * tool outputs are detected, routed to a compressor and kept only when they really need fewer tokens.
 * Compression is deterministic, so a tool output compressed in one turn is byte-identical in the next and the
 * provider prompt cache keeps hitting. Source code and plain text pass through, as in Headroom 0.37's live zone, unless
 * code and prose compression is on (Headroom's content router: lossless folds, CodeAware, mixed content, and
 * TextCrusher where Headroom runs its Kompress model). HTML passes through: Headroom extracts it with trafilatura.
 */
export type Strategy = "smart_crusher" | "log_compressor" | "search_compressor" | "diff_compressor" | "lossless_fold" | "code_aware" | "text_crusher" | "mixed"
  | "html_extractor" | "json_fields";

/** Each returns the compressed text, or null when it left the content unchanged. */
export interface Compressors {
  smartCrusher?: (text: string) => string | null;
  logCompressor?: (text: string) => string | null;
  searchCompressor?: (text: string) => string | null;
  diffCompressor?: (text: string) => string | null;
  /** Source code with function bodies shortened (CodeAware); `language` comes from a code fence. */
  codeAware?: (text: string, language?: string | null) => string | null;
  /** Prose reduced to its most salient sentences (TextCrusher). */
  textCrusher?: (text: string) => string | null;
}

/** Code and prose compression: OFF (pass through) or ON. */
export type CodeTextMode = "OFF" | "ON";

export interface BlockOptions {
  codeText?: CodeTextMode;
  /** Lossy code and prose transforms are allowed (Token profile, not a file read); otherwise only lossless folds. */
  lossy?: boolean;
  /** A file read: only folds whose exact inverse gives back every byte, whatever the content type. */
  exact?: boolean;
}

export interface TokenCounter {
  count(text: string): number;
}

export type BlockAction =
  | { kind: "compressed"; strategy: Strategy; contentType: ContentType; originalBytes: number; compressedBytes: number; originalTokens: number; compressedTokens: number }
  | { kind: "below_threshold"; contentType: ContentType | "output_item"; bytes: number; thresholdBytes: number }
  | { kind: "no_compression"; contentType: ContentType }
  | { kind: "rejected_not_smaller"; strategy: Strategy; originalTokens: number; compressedTokens: number }
  /** A failing test run, text with strong error indicators, or a tool error result, small enough to reach the model whole. */
  | { kind: "protected"; reason: "test_failures" | "error_output" | "tool_error"; contentType: ContentType; bytes: number }
  /** The compressor dropped `lines` protected test lines; the original is sent. */
  | { kind: "rejected_protected_lines"; strategy: Strategy; lines: number }
  /** The block was JSON and the compressed text no longer parses; the original is sent. */
  | { kind: "rejected_invalid_json"; strategy: Strategy }
  /** This conversation already received the block raw; compressing it now would bust the provider's prompt cache. */
  | { kind: "kept_raw"; bytes: number }
  | { kind: "error"; strategy: Strategy; error: string };

/** Waste signals of a block and how long each stage took (ms), measured where the block was compressed. */
export interface BlockAnalysis { waste: WasteSignals; stageMs: Record<string, number> }

export interface BlockResult { replacement: string | null; action: BlockAction; analysis?: BlockAnalysis }

export interface BlockOutcome { itemIndex: number; blockType: string; action: BlockAction }

export interface CompressionOutcome {
  /** The body to send: the compressed copy, or the original object when nothing changed. */
  body: Record<string, unknown>;
  modified: boolean;
  blocks: BlockOutcome[];
  tokensBefore: number;
  tokensAfter: number;
  durationMs: number;
  /** The time budget ran out; the original body is used. */
  timedOut: boolean;
  /** Waste signal tokens over the evaluated blocks (Headroom "What was removed"), re-reads included. */
  waste: Record<string, number>;
  /** Milliseconds per pipeline stage, summed over blocks compressed for this request (cache hits cost none). */
  stageMs: Record<string, number>;
  cacheHits: number;
}

const BLOCK_THRESHOLD_BYTES = 512;
const OUTPUT_ITEM_MIN_BYTES = 512;
const RETRIEVE_TOOL = "headroom_retrieve";
/**
 * Tool results in a Responses body. Headroom 0.37 covers the first three; current Codex sends its exec and patch
 * results as `custom_tool_call_output`, often as an array of text parts, so Space Gateway covers those too.
 */
const RESPONSES_OUTPUT_TYPES = new Set(["function_call_output", "local_shell_call_output", "apply_patch_call_output", "custom_tool_call_output"]);

const byteLength = (text: string) => Buffer.byteLength(text, "utf8");

function dispatch(text: string, contentType: ContentType, compressors: Compressors): { strategy: Strategy; compressed: string | null } | null {
  switch (contentType) {
    case "json_array": return compressors.smartCrusher ? { strategy: "smart_crusher", compressed: compressors.smartCrusher(text) } : null;
    case "build": return compressors.logCompressor ? { strategy: "log_compressor", compressed: compressors.logCompressor(text) } : null;
    case "search": return compressors.searchCompressor ? { strategy: "search_compressor", compressed: compressors.searchCompressor(text) } : null;
    case "diff": return compressors.diffCompressor ? { strategy: "diff_compressor", compressed: compressors.diffCompressor(text) } : null;
    default: return null;
  }
}

/**
 * Folds whose result is checked against its exact inverse. The log fold also drops ANSI color and the diff fold
 * drops `index` lines, so neither is exact.
 */
const EXACT_FOLDS: LosslessKind[] = ["search", "paths", "text", "config"];

/** The exact fold that shrinks a file read the most, or null. */
function exactFold(text: string): string | null {
  let best = text;
  for (const kind of EXACT_FOLDS) {
    const candidate = compactLossless(text, kind);
    if (candidate.length < best.length) best = candidate;
  }
  return best === text ? null : best;
}

/** Headroom `_lossy_min_extra_savings`: a lossy pass after a fold must save 5% more than the fold. */
const LOSSY_MIN_EXTRA_SAVINGS = 0.05;
/** Headroom trusts its detector over the mixed-content heuristics only at this confidence. */
const CODE_CONFIDENCE = 0.8;

const FENCE_LANGUAGES: Record<string, string> = {
  py: "python", python: "python", js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", javascript: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", mts: "typescript", typescript: "typescript", go: "go", golang: "go", rs: "rust", rust: "rust", java: "java",
  c: "c", h: "c", cpp: "cpp", "c++": "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp"
};

/** Prose: the lossless fold, then TextCrusher when lossy is allowed and it saves 5% more than the fold. */
function compressProse(text: string, compressors: Compressors, tokens: TokenCounter, lossy: boolean): { strategy: Strategy; compressed: string | null } {
  const fold = bestLosslessFold(text);
  const base = fold?.text ?? text;
  if (lossy && compressors.textCrusher && !looksLikeDiff(text)) {
    const crushed = compressors.textCrusher(base);
    if (crushed !== null && crushed !== base && (!fold || tokens.count(crushed) <= tokens.count(base) * (1 - LOSSY_MIN_EXTRA_SAVINGS))) {
      return { strategy: "text_crusher", compressed: crushed };
    }
  }
  return { strategy: "lossless_fold", compressed: fold?.text ?? null };
}

/**
 * Source code: the lossless fold, or CodeAware when lossy is allowed and it saves 5% more than the fold. CodeAware
 * reads the original (a folded file no longer parses); Headroom returns the fold without trying CodeAware.
 */
function compressSource(text: string, compressors: Compressors, tokens: TokenCounter, lossy: boolean, language: string | null = null): { strategy: Strategy; compressed: string | null } {
  const fold = bestLosslessFold(text);
  if (lossy && compressors.codeAware) {
    const compressed = compressors.codeAware(text, language);
    if (compressed !== null && compressed !== text && (!fold || tokens.count(compressed) <= tokens.count(fold.text) * (1 - LOSSY_MIN_EXTRA_SAVINGS))) {
      return { strategy: "code_aware", compressed };
    }
  }
  return { strategy: "lossless_fold", compressed: fold?.text ?? null };
}

/** One section of mixed content, by its type; lossy compressors only see sections above the block threshold. */
function compressSection(section: ContentSection, compressors: Compressors, tokens: TokenCounter, lossy: boolean): string | null {
  const big = byteLength(section.content) >= BLOCK_THRESHOLD_BYTES;
  switch (section.type) {
    case "json_array": return big && compressors.smartCrusher ? compressors.smartCrusher(section.content) : null;
    case "search": {
      if (big && compressors.searchCompressor) {
        const compressed = compressors.searchCompressor(section.content);
        if (compressed !== null) return compressed;
      }
      return bestLosslessFold(section.content, "search")?.text ?? null;
    }
    case "source_code": {
      const language = section.language && section.language !== "unknown" ? FENCE_LANGUAGES[section.language.toLowerCase()] ?? null : null;
      return compressSource(section.content, compressors, tokens, lossy && big, language).compressed;
    }
    case "text": return compressProse(section.content, compressors, tokens, lossy && big).compressed;
  }
}

/**
 * Mixed content (Headroom `_compress_mixed`): each section is compressed by its own type and put back in place of
 * its lines, so lines between sections and code fence markers stay byte-identical.
 */
function compressMixed(text: string, compressors: Compressors, tokens: TokenCounter, lossy: boolean): string | null {
  const lines = text.split("\n");
  const sections = splitIntoSections(text);
  for (const section of [...sections].reverse()) {
    const replacement = compressSection(section, compressors, tokens, lossy);
    if (replacement === null || replacement === section.content) continue;
    const start = section.isCodeFence ? section.startLine + 1 : section.startLine;
    const end = section.isCodeFence ? Math.min(section.endLine, lines.length) - 1 : section.endLine;
    lines.splice(start, end - start + 1, ...replacement.split("\n"));
  }
  const result = lines.join("\n");
  return result === text ? null : result;
}

/** Code and prose routing: mixed content by section, then source code and prose. */
function dispatchCodeText(text: string, detection: { contentType: ContentType; confidence: number }, compressors: Compressors, tokens: TokenCounter,
  lossy: boolean): { strategy: Strategy; compressed: string | null } {
  // Headroom's content router sends web pages to its HTML extractor; extraction drops markup, so it needs lossy.
  if (detection.contentType === "html") return { strategy: "html_extractor", compressed: lossy ? extractHtml(text) : null };
  if (!(detection.contentType === "source_code" && detection.confidence >= CODE_CONFIDENCE) && isMixedContent(text)) {
    return { strategy: "mixed", compressed: compressMixed(text, compressors, tokens, lossy) };
  }
  return detection.contentType === "source_code" ? compressSource(text, compressors, tokens, lossy) : compressProse(text, compressors, tokens, lossy);
}

const CODE_TEXT_TYPES = new Set<ContentType>(["source_code", "text", "html"]);

/** JSON nesting followed into a JSON object's fields. */
const JSON_FIELD_MAX_DEPTH = 8;

/**
 * JSON objects (Codex `exec` results such as `{chunk_id, wall_time_seconds, exit_code, …, output}`, MCP responses).
 * Headroom's content detector knows only JSON arrays, so objects went to the prose path, which cannot keep them
 * JSON. Here SmartCrusher shortens their structure, then every string field of a block's size is compressed as a
 * block of its own, by its content type and with the request's options (file reads stay lossless, error output and
 * test lines are protected), and the object is written back compactly with keys in order and numbers as written.
 * Returns null when the text is not a JSON object.
 */
function compressJsonObject(text: string, compressors: Compressors, tokens: TokenCounter, options: BlockOptions): { strategy: Strategy; compressed: string | null } | null {
  const parsed = parseJson(text);
  if (!isObject(parsed)) return null;
  // A file read keeps every item: its fields get exact folds only, and SmartCrusher does not run.
  const crushed = options.exact ? null : compressors.smartCrusher?.(text) ?? null;
  const structure = crushed === null ? undefined : parseJson(crushed);
  let fieldsChanged = false;
  const walk = (node: JsonValue, depth: number): JsonValue => {
    if (typeof node === "string") {
      if (byteLength(node) < BLOCK_THRESHOLD_BYTES) return node;
      const field = compressBlock(node, compressors, tokens, undefined, options).replacement;
      if (field === null) return node;
      fieldsChanged = true;
      return field;
    }
    if (depth >= JSON_FIELD_MAX_DEPTH) return node;
    if (Array.isArray(node)) return node.map((item) => walk(item, depth + 1));
    if (isObject(node)) return new Map([...node].map(([key, item]) => [key, walk(item, depth + 1)] as const));
    return node;
  };
  const compressed = toJson(walk(structure ?? parsed, 0));
  if (!fieldsChanged && structure === undefined) return { strategy: "json_fields", compressed: null };
  return { strategy: fieldsChanged ? "json_fields" : "smart_crusher", compressed };
}

/** Whether a text is a JSON object or array, the structured tool output agents and their tools parse. */
function isJsonText(text: string): boolean {
  const first = /\S/.exec(text)?.[0];
  if (first !== "{" && first !== "[") return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * Compresses one text block; returns the replacement text (or null), what happened, and the block's waste signals
 * with stage timings (content router, compressor, token count, waste detection).
 */
export function compressBlock(text: string, compressors: Compressors, tokens: TokenCounter, clock: () => number = () => performance.now(),
  options: BlockOptions = {}): BlockResult {
  const stageMs: Record<string, number> = {};
  const timed = <T>(stage: string, run: () => T): T => {
    const started = clock();
    try { return run(); } finally { stageMs[stage] = (stageMs[stage] ?? 0) + (clock() - started); }
  };
  const detection = timed("content_router", () => detectContentType(text));
  const contentType = detection.contentType;
  const codeText = options.codeText ?? "OFF";
  const extended = codeText !== "OFF" && CODE_TEXT_TYPES.has(contentType);
  const bytes = byteLength(text);
  if (text.length > 0 && bytes < BLOCK_THRESHOLD_BYTES) {
    return { replacement: null, action: { kind: "below_threshold", contentType, bytes, thresholdBytes: BLOCK_THRESHOLD_BYTES } };
  }
  const waste = timed("waste_signals", () => detectWasteSignals(text, tokens));
  const analysis = { waste, stageMs };
  // Headroom's content router keeps failed tool output verbatim up to `error_protection_max_chars`: a failing test run,
  // or text with strong error indicators (JSON arrays excepted: SmartCrusher keeps their error items itself). Larger
  // output goes to the compressors, which keep protected lines.
  if (bytes <= ERROR_PROTECTION_MAX_BYTES) {
    const reason = timed("error_protection", () => (hasTestFailureReport(text) ? "test_failures"
      : contentType !== "json_array" && hasStrongErrorIndicators(text) ? "error_output" : null));
    if (reason) return { replacement: null, action: { kind: "protected", reason, contentType, bytes }, analysis };
  }
  let routed: { strategy: Strategy; compressed: string | null } | null;
  const objectText = /^\s*\{/.test(text);
  try {
    // JSON objects take their own route (a file read's fields get exact folds only). Any other file read reaches the
    // model exact: an exact fold or nothing, for every content type (with code and prose off, code and prose pass
    // through as that setting says).
    routed = timed("compressor", () => (objectText ? compressJsonObject(text, compressors, tokens, options) : null)
      ?? (options.exact ? { strategy: "lossless_fold" as Strategy, compressed: codeText === "OFF" && CODE_TEXT_TYPES.has(contentType) ? null : exactFold(text) } : null)
      ?? (extended ? dispatchCodeText(text, detection, compressors, tokens, options.lossy ?? false) : dispatch(text, contentType, compressors)));
  } catch (error) {
    const strategy: Strategy = objectText && parseJson(text) !== undefined ? "json_fields"
      : extended ? (contentType === "source_code" ? "code_aware" : contentType === "html" ? "html_extractor" : "text_crusher")
      : contentType === "json_array" ? "smart_crusher" : contentType === "build" ? "log_compressor" : contentType === "search" ? "search_compressor" : "diff_compressor";
    return { replacement: null, action: { kind: "error", strategy, error: error instanceof Error ? error.message : String(error) }, analysis };
  }
  if (!routed || routed.compressed === null || routed.compressed === text) return { replacement: null, action: { kind: "no_compression", contentType }, analysis };
  // Headroom names the stage after the strategy that ran.
  stageMs[`compressor:${routed.strategy}`] = stageMs.compressor ?? 0;
  delete stageMs.compressor;
  const missing = timed("protected_lines", () => missingProtectedLines(text, routed!.compressed!));
  if (missing > 0) return { replacement: null, action: { kind: "rejected_protected_lines", strategy: routed.strategy, lines: missing }, analysis };
  // JSON that goes in must come out as JSON. Objects take the JSON path above; this guards every other route (before
  // it, TextCrusher turned Codex exec results into sentences without their exit code).
  if (timed("json_check", () => isJsonText(text) && !isJsonText(routed!.compressed!))) {
    return { replacement: null, action: { kind: "rejected_invalid_json", strategy: routed.strategy }, analysis };
  }
  const [originalTokens, compressedTokens] = timed("token_count", () => [tokens.count(text), tokens.count(routed!.compressed!)]);
  if (compressedTokens >= originalTokens) {
    return { replacement: null, action: { kind: "rejected_not_smaller", strategy: routed.strategy, originalTokens, compressedTokens }, analysis };
  }
  return {
    replacement: routed.compressed,
    action: { kind: "compressed", strategy: routed.strategy, contentType, originalBytes: bytes, compressedBytes: byteLength(routed.compressed), originalTokens, compressedTokens },
    analysis
  };
}

/** Sums block analyses; re-reads add the estimated tokens (Headroom: count + 4) of results served again later. */
function summarize(results: Array<{ analysis?: BlockAnalysis; cached: boolean }>, rereads: number) {
  const waste: Record<string, number> = {};
  const stageMs: Record<string, number> = {};
  let cacheHits = 0;
  for (const result of results) {
    if (result.cached) cacheHits += 1;
    for (const [name, tokens] of Object.entries(result.analysis?.waste ?? {})) if (tokens > 0) waste[name] = (waste[name] ?? 0) + tokens;
    if (!result.cached) for (const [stage, ms] of Object.entries(result.analysis?.stageMs ?? {})) stageMs[stage] = (stageMs[stage] ?? 0) + ms;
  }
  if (rereads > 0) waste.reread = rereads;
  return { waste, stageMs, cacheHits };
}

interface ServedResult { position: number; text: string; callId: string | null }
interface IssuedCall { position: number; callId: string; key: string }

/** JSON with sorted object keys, so the same arguments compare equal however they were serialized. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Json)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Headroom `_canonical_call_key`: the tool name and its arguments with key order normalized. */
function callKey(name: string, args: unknown): string {
  let parsed = args;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { /* compared as text */ } }
  const canonical = parsed && typeof parsed === "object" ? canonicalJson(parsed) : String(parsed);
  return createHash("sha256").update(`${name}\u0000${canonical}`, "utf8").digest("hex");
}

/**
 * Re-read tokens (Headroom `parse_messages`): a tool result of 50+ estimated tokens served again more than three
 * positions after its last serve, and the result of a call re-issued with the same tool and arguments (its bytes
 * may differ: timestamps, ordering). Nearer repeats are polling and only move the baseline; a result is counted once.
 */
function rereadTokens(served: ServedResult[], calls: IssuedCall[] = []): number {
  const tokensOf = (text: string) => Math.ceil(text.length / 4);
  const last = new Map<string, number>();
  const counted = new Set<ServedResult>();
  let total = 0;
  for (const entry of served) {
    const hash = createHash("sha256").update(entry.text, "utf8").digest("hex");
    const tokens = tokensOf(entry.text);
    const previous = last.get(hash);
    if (previous !== undefined && previous !== entry.position && tokens >= REREAD_MIN_TOKENS && entry.position - previous > REREAD_ADJACENT_GAP) {
      total += tokens + 4;
      counted.add(entry);
    }
    if (previous !== entry.position) last.set(hash, entry.position);
  }
  const resultByCall = new Map<string, ServedResult>();
  for (const entry of served) if (entry.callId && !resultByCall.has(entry.callId)) resultByCall.set(entry.callId, entry);
  const lastCall = new Map<string, number>();
  for (const call of calls) {
    const previous = lastCall.get(call.key);
    if (previous === undefined || previous === call.position) { lastCall.set(call.key, call.position); continue; }
    lastCall.set(call.key, call.position);
    if (call.position - previous <= REREAD_ADJACENT_GAP) continue;
    const result = resultByCall.get(call.callId);
    if (!result || counted.has(result) || tokensOf(result.text) < REREAD_MIN_TOKENS) continue;
    total += tokensOf(result.text) + 4;
    counted.add(result);
  }
  return total;
}

/** Tool calls of a Responses input with their identity, for re-issued call detection. */
function responsesCalls(items: unknown[]): IssuedCall[] {
  const out: IssuedCall[] = [];
  items.forEach((raw, position) => {
    const item = obj(raw);
    if (!item || typeof item.call_id !== "string") return;
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      out.push({ position, callId: item.call_id, key: callKey(String(item.name ?? ""), item.type === "function_call" ? item.arguments : item.input) });
    } else if (item.type === "local_shell_call") out.push({ position, callId: item.call_id, key: callKey("local_shell", obj(item.action)?.command ?? null) });
  });
  return out;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : null);

function finish(original: Json, copy: Json, blocks: BlockOutcome[], startedAt: number, now: () => number, timedOut: boolean,
  summary: { waste: Record<string, number>; stageMs: Record<string, number>; cacheHits: number } = { waste: {}, stageMs: {}, cacheHits: 0 }): CompressionOutcome {
  const compressed = blocks.filter((block) => block.action.kind === "compressed");
  const tokensBefore = compressed.reduce((sum, block) => sum + (block.action.kind === "compressed" ? block.action.originalTokens : 0), 0);
  const tokensAfter = compressed.reduce((sum, block) => sum + (block.action.kind === "compressed" ? block.action.compressedTokens : 0), 0);
  const modified = !timedOut && compressed.length > 0;
  return { body: modified ? copy : original, modified, blocks, tokensBefore, tokensAfter, durationMs: now() - startedAt, timedOut, ...summary };
}

/**
 * OpenAI Responses bodies (`input` items): every function/shell/patch call output of at least 512 bytes, except
 * outputs of Headroom's own retrieval tool, which must reach the model unchanged.
 */
export function compressResponsesBody(body: Json, options: { compressors: Compressors; tokens: TokenCounter; timeBudgetMs: number; now?: () => number }): CompressionOutcome {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const items = Array.isArray(body.input) ? body.input : null;
  if (!items || items.length === 0) return finish(body, body, [], startedAt, now, false);
  const retrieveCalls = new Set(items.map(obj).filter((item): item is Json => Boolean(item && item.type === "function_call"
    && typeof item.name === "string" && (item.name === RETRIEVE_TOOL || item.name.endsWith(`__${RETRIEVE_TOOL}`)))).map((item) => String(item.call_id)));
  const copy: Json = { ...body, input: [...items] };
  const blocks: BlockOutcome[] = [];
  const analyses: Array<{ analysis?: BlockAnalysis; cached: boolean }> = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = obj(items[index]);
    const type = typeof item?.type === "string" ? item.type : "";
    if (!item || !["function_call_output", "local_shell_call_output", "apply_patch_call_output"].includes(type)) continue;
    if (retrieveCalls.has(String(item.call_id))) continue;
    if (typeof item.output !== "string") continue;
    if (now() - startedAt > options.timeBudgetMs) return finish(body, copy, blocks, startedAt, now, true);
    const bytes = byteLength(item.output);
    if (bytes < OUTPUT_ITEM_MIN_BYTES) {
      blocks.push({ itemIndex: index, blockType: type, action: { kind: "below_threshold", contentType: "output_item", bytes, thresholdBytes: OUTPUT_ITEM_MIN_BYTES } });
      continue;
    }
    const { replacement, action, analysis } = compressBlock(item.output, options.compressors, options.tokens);
    blocks.push({ itemIndex: index, blockType: type, action });
    analyses.push({ analysis, cached: false });
    if (replacement !== null) (copy.input as unknown[])[index] = { ...item, output: replacement };
  }
  const summary = summarize(analyses, rereadTokens(served(items), responsesCalls(items)));
  if (now() - startedAt > options.timeBudgetMs) return finish(body, copy, blocks, startedAt, now, true, summary);
  return finish(body, copy, blocks, startedAt, now, false, summary);
}

/** Every tool result text of a Responses input, with its position and call, for re-read detection. */
function served(items: unknown[]): ServedResult[] {
  const out: ServedResult[] = [];
  items.forEach((raw, position) => {
    const item = obj(raw);
    if (!item || !RESPONSES_OUTPUT_TYPES.has(String(item.type))) return;
    const callId = typeof item.call_id === "string" ? item.call_id : null;
    if (typeof item.output === "string") out.push({ position, text: item.output, callId });
    else if (Array.isArray(item.output)) {
      const text = item.output.map((part) => obj(part)?.text).filter((value): value is string => typeof value === "string").join("\n");
      if (text) out.push({ position, text, callId });
    }
  });
  return out;
}

export type AsyncBlockRunner = (text: string, deadline: number, options?: BlockOptions & {
  tokenizer?: TokenizerKind;
  onLate?: (result: BlockResult) => void;
}) => Promise<BlockResult | null>;

/** How a request's blocks are compressed: code and prose mode, and the profile (Token allows lossy transforms). */
export interface BodyCompressionOptions {
  run: AsyncBlockRunner;
  cache?: CompressionCache;
  timeBudgetMs: number;
  now?: () => number;
  codeText?: CodeTextMode;
  profile?: "CACHE" | "TOKEN";
  /** The conversation (a hashed session id) for the raw-block registry; without both, blocks are evaluated as before. */
  sessionKey?: string;
  rawBlocks?: RawBlockRegistry;
}

/** Block options for a tool result; file reads, which agents patch byte for byte, get lossless folds only. */
function blockOptions(options: BodyCompressionOptions, read: boolean): BlockOptions {
  const codeText = options.codeText ?? "OFF";
  const exact = read ? { exact: true } : {};
  return codeText === "OFF" ? exact : { codeText, lossy: options.profile !== "CACHE" && !read, ...exact };
}

const variant = (block: BlockOptions) =>
  [block.codeText ? `${block.codeText}:${block.lossy ? "lossy" : "lossless"}` : "", block.exact ? "exact" : ""].filter(Boolean).join(":");

/**
 * Blocks a conversation has already received raw because they missed the budget. A later turn keeps them raw even
 * once the late result is cached: rewriting a message the provider has cached would bust its prompt cache (Headroom's
 * Python handler keeps the same per-session state; its Rust proxy has none). Per process; most recently used
 * sessions, and the oldest keys of a session, are kept.
 */
export class RawBlockRegistry {
  private sessions = new Map<string, Set<string>>();
  constructor(private readonly sessionLimit = 500, private readonly keysPerSession = 5000) {}
  has(session: string, key: string): boolean {
    const keys = this.sessions.get(session);
    if (!keys) return false;
    this.sessions.delete(session);
    this.sessions.set(session, keys);
    return keys.has(key);
  }
  add(session: string, key: string): void {
    const keys = this.sessions.get(session) ?? new Set<string>();
    this.sessions.delete(session);
    this.sessions.set(session, keys);
    keys.add(key);
    if (keys.size > this.keysPerSession) keys.delete(keys.values().next().value!);
    if (this.sessions.size > this.sessionLimit) this.sessions.delete(this.sessions.keys().next().value!);
  }
  get size(): number { return this.sessions.size; }
}

/** Results by content hash, so a tool output compressed once is reused byte-for-byte in later turns. */
export class CompressionCache {
  private entries = new Map<string, BlockResult>();
  hits = 0;
  misses = 0;
  constructor(private readonly limit = 2000) {}
  /** Token counts differ per tokenizer and results per block options, so both are part of the key. */
  key(text: string, tokenizer: TokenizerKind = "o200k", options = "") {
    return `${tokenizer}:${options ? `${options}:` : ""}${createHash("sha256").update(text, "utf8").digest("hex")}`;
  }
  get(key: string) {
    const value = this.entries.get(key);
    if (value) { this.entries.delete(key); this.entries.set(key, value); this.hits += 1; } else this.misses += 1;
    return value;
  }
  set(key: string, value: BlockResult) {
    this.entries.set(key, value);
    if (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}

/**
 * The same live zone as `compressResponsesBody`, with blocks compressed concurrently off the event loop and
 * cached by content. Blocks that miss the deadline keep their original text.
 */
export async function compressResponsesBodyAsync(body: Json, options: BodyCompressionOptions): Promise<CompressionOutcome> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const deadline = Date.now() + options.timeBudgetMs;
  const items = Array.isArray(body.input) ? body.input : null;
  if (!items || items.length === 0) return finish(body, body, [], startedAt, now, false);
  const retrieveCalls = new Set(items.map(obj).filter((item): item is Json => Boolean(item && (item.type === "function_call" || item.type === "custom_tool_call")
    && typeof item.name === "string" && (item.name === RETRIEVE_TOOL || item.name.endsWith(`__${RETRIEVE_TOOL}`)))).map((item) => String(item.call_id)));
  const reads = responsesReadCalls(items);
  const copy: Json = { ...body, input: [...items] };
  const evaluator = createBlockEvaluator(options, "o200k", deadline, { bytes: OUTPUT_ITEM_MIN_BYTES, contentType: () => "output_item" });
  /** The item's copy in the outgoing body, made once so several parts of one output can be replaced. */
  const outgoingItem = (index: number, item: Json): Json => {
    const current = (copy.input as unknown[])[index];
    if (current !== item) return current as Json;
    const fresh: Json = { ...item, ...(Array.isArray(item.output) ? { output: [...item.output] } : {}) };
    (copy.input as unknown[])[index] = fresh;
    return fresh;
  };
  for (let index = 0; index < items.length; index += 1) {
    const item = obj(items[index]);
    const type = typeof item?.type === "string" ? item.type : "";
    if (!item || !RESPONSES_OUTPUT_TYPES.has(type) || retrieveCalls.has(String(item.call_id))) continue;
    const block = blockOptions(options, reads.has(String(item.call_id)));
    if (typeof item.output === "string") {
      evaluator.evaluate(index, type, item.output, block, (replacement) => { outgoingItem(index, item).output = replacement; });
    } else if (Array.isArray(item.output)) {
      // Current Codex sends tool results as content parts ({ type: "input_text", text }); each text part is a block.
      item.output.forEach((raw, part) => {
        const piece = obj(raw);
        if (!piece || (piece.type !== "input_text" && piece.type !== "output_text") || typeof piece.text !== "string") return;
        evaluator.evaluate(index, `${type}#${part}`, piece.text, block, (replacement) => {
          (outgoingItem(index, item).output as unknown[])[part] = { ...piece, text: replacement };
        });
      });
    }
  }
  const timedOut = await evaluator.settle();
  const outcome = finish(body, copy, evaluator.blocks, startedAt, now, false, summarize(evaluator.analyses, rereadTokens(served(items), responsesCalls(items))));
  return { ...outcome, timedOut };
}

const byItemThenBlock = (a: BlockOutcome, b: BlockOutcome) => a.itemIndex - b.itemIndex || a.blockType.localeCompare(b.blockType, "en", { numeric: true });

/**
 * Evaluates the tool-output blocks of one request: below the threshold nothing happens; a block this conversation
 * already received raw stays raw; a cached result is applied; otherwise the block runs off the event loop against the
 * request's deadline, and a block that misses it goes out raw and is remembered as such for the conversation (the
 * late result still reaches the cache, for other conversations).
 */
function createBlockEvaluator(options: BodyCompressionOptions, tokenizer: TokenizerKind, deadline: number,
  threshold: { bytes: number; contentType: (text: string) => ContentType | "output_item" }) {
  const blocks: BlockOutcome[] = [];
  const analyses: Array<{ analysis?: BlockAnalysis; cached: boolean }> = [];
  const pending: Promise<void>[] = [];
  let timedOut = false;
  const evaluate = (itemIndex: number, blockType: string, text: string, block: BlockOptions, write: (replacement: string) => void) => {
    const bytes = byteLength(text);
    if (bytes < threshold.bytes) {
      blocks.push({ itemIndex, blockType, action: { kind: "below_threshold", contentType: threshold.contentType(text), bytes, thresholdBytes: threshold.bytes } });
      return;
    }
    const key = options.cache?.key(text, tokenizer, variant(block));
    if (key && options.sessionKey && options.rawBlocks?.has(options.sessionKey, key)) {
      blocks.push({ itemIndex, blockType, action: { kind: "kept_raw", bytes } });
      return;
    }
    const cached = key ? options.cache!.get(key) : undefined;
    const apply = (result: BlockResult, fromCache: boolean) => {
      blocks.push({ itemIndex, blockType, action: result.action });
      analyses.push({ analysis: result.analysis, cached: fromCache });
      if (result.replacement !== null) write(result.replacement);
    };
    if (cached) { apply(cached, true); return; }
    pending.push(options.run(text, deadline, { ...block, tokenizer, onLate: key ? (late) => options.cache!.set(key, late) : undefined }).then((result) => {
      if (!result) {
        timedOut = true;
        if (key && options.sessionKey) options.rawBlocks?.add(options.sessionKey, key);
        return;
      }
      if (key) options.cache!.set(key, result);
      apply(result, false);
    }));
  };
  /** Waits for the workers; the outcomes come out ordered by item, then block. */
  const settle = async () => {
    await Promise.all(pending);
    blocks.sort(byItemThenBlock);
    return timedOut;
  };
  return { blocks, analyses, evaluate, settle };
}

/**
 * Call ids of Responses tool calls that read a file (`cat`, `sed -n`, … through a shell tool). A Codex code-mode
 * `exec` call is a read when any command its JavaScript runs is one: its output may hold that file's text.
 */
function responsesReadCalls(items: unknown[]): Set<string> {
  const reads = new Set<string>();
  for (const raw of items) {
    const item = obj(raw);
    if (!item || typeof item.call_id !== "string") continue;
    const command = item.type === "function_call" ? toolCallCommand(item.arguments)
      : item.type === "custom_tool_call" ? toolCallCommand(item.input)
        : item.type === "local_shell_call" ? toolCallCommand(obj(item.action) ?? {}) : null;
    if (command === null) continue;
    if ((typeof item.name === "string" && READ_TOOL_NAMES.has(item.name)) || isReadCommand(command)) reads.add(item.call_id);
    else if (item.type === "custom_tool_call" && command === "" && typeof item.input === "string" && codeModeCommands(item.input).some(isReadCommand)) {
      reads.add(item.call_id);
    }
  }
  return reads;
}

/**
 * Anthropic Messages bodies: every `tool_result` of every message is compressed, deterministically, so the bytes of
 * one turn are the bytes of the next and the provider's prompt cache keeps hitting (the same live zone as
 * `compressResponsesBodyAsync`). Headroom's frozen floor (`compute_frozen_count`) is not used: Claude Code marks its
 * trailing system message with `cache_control`, which froze every message. The user's own text, tool_use, thinking
 * and compaction blocks are never rewritten; file reads get lossless folds only; a tool error up to 8000 bytes passes
 * through whole (Headroom `protect_error_outputs`).
 */
export async function compressAnthropicBodyAsync(body: Json, options: BodyCompressionOptions): Promise<CompressionOutcome> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const deadline = Date.now() + options.timeBudgetMs;
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) return finish(body, body, [], startedAt, now, false);
  const reads = anthropicReadCalls(messages);
  const copy: Json = { ...body, messages: [...messages] };
  const evaluator = createBlockEvaluator(options, "claude", deadline, { bytes: BLOCK_THRESHOLD_BYTES, contentType: (text) => detectContentType(text).contentType });
  /** The message's copy in the outgoing body, made once so several blocks of one message can be replaced. */
  const outgoingMessage = (index: number, message: Json): Json => {
    const current = (copy.messages as unknown[])[index];
    if (current !== message) return current as Json;
    const fresh: Json = { ...message, content: [...(message.content as unknown[])] };
    (copy.messages as unknown[])[index] = fresh;
    return fresh;
  };
  /** The block's copy with its content parts copied, so several parts of one tool result can be replaced. */
  const outgoingBlock = (index: number, message: Json, blockIndex: number, block: Json): Json => {
    const content = outgoingMessage(index, message).content as unknown[];
    const current = content[blockIndex];
    if (current !== block) return current as Json;
    const fresh: Json = { ...block, content: [...(block.content as unknown[])] };
    content[blockIndex] = fresh;
    return fresh;
  };
  messages.forEach((raw, index) => {
    const message = obj(raw);
    if (!message || message.role !== "user" || !Array.isArray(message.content)) return;
    message.content.forEach((rawBlock, blockIndex) => {
      const block = obj(rawBlock);
      if (block?.type !== "tool_result") return;
      const blockOptions_ = blockOptions(options, reads.has(String(block.tool_use_id)));
      const evaluate = (blockType: string, text: string, write: (replacement: string) => void) => {
        if (text.length === 0) return;
        const bytes = byteLength(text);
        if (block.is_error === true && bytes <= ERROR_PROTECTION_MAX_BYTES) {
          evaluator.blocks.push({ itemIndex: index, blockType, action: { kind: "protected", reason: "tool_error", contentType: detectContentType(text).contentType, bytes } });
          return;
        }
        evaluator.evaluate(index, blockType, text, blockOptions_, write);
      };
      if (typeof block.content === "string") {
        evaluate(`tool_result#${blockIndex}`, block.content, (replacement) => {
          (outgoingMessage(index, message).content as unknown[])[blockIndex] = { ...block, content: replacement };
        });
      } else if (Array.isArray(block.content)) {
        // Current Claude Code sends tool results as content parts ({ type: "text", text }); each text part is a block.
        block.content.forEach((rawPart, part) => {
          const piece = obj(rawPart);
          if (!piece || piece.type !== "text" || typeof piece.text !== "string") return;
          evaluate(`tool_result#${blockIndex}#${part}`, piece.text, (replacement) => {
            (outgoingBlock(index, message, blockIndex, block).content as unknown[])[part] = { ...piece, text: replacement };
          });
        });
      }
    });
  });
  const timedOut = await evaluator.settle();
  const outcome = finish(body, copy, evaluator.blocks, startedAt, now, false, summarize(evaluator.analyses, rereadTokens(anthropicServed(messages), anthropicCalls(messages))));
  return { ...outcome, timedOut };
}

/** Ids of Anthropic tool_use blocks that read a file: the Read tool, or a shell command such as `cat` or `sed -n`. */
function anthropicReadCalls(messages: unknown[]): Set<string> {
  const reads = new Set<string>();
  for (const raw of messages) {
    const content = obj(raw)?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const block = obj(part);
      if (block?.type !== "tool_use" || typeof block.id !== "string") continue;
      if ((typeof block.name === "string" && READ_TOOL_NAMES.has(block.name)) || isReadCommand(toolCallCommand(block.input))) reads.add(block.id);
    }
  }
  return reads;
}

/** Every tool_result text of an Anthropic conversation, with its message position, for re-read detection. */
function anthropicServed(messages: unknown[]): ServedResult[] {
  const out: ServedResult[] = [];
  messages.forEach((raw, position) => {
    const content = obj(raw)?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const block = obj(part);
      if (block?.type !== "tool_result") continue;
      const text = typeof block.content === "string" ? block.content
        : Array.isArray(block.content) ? block.content.map((item) => obj(item)?.text).filter((value): value is string => typeof value === "string").join("\n") : "";
      if (text) out.push({ position, text, callId: typeof block.tool_use_id === "string" ? block.tool_use_id : null });
    }
  });
  return out;
}

/** tool_use blocks of an Anthropic conversation with their identity, for re-issued call detection. */
function anthropicCalls(messages: unknown[]): IssuedCall[] {
  const out: IssuedCall[] = [];
  messages.forEach((raw, position) => {
    const content = obj(raw)?.content;
    if (!Array.isArray(content)) return;
    for (const part of content) {
      const block = obj(part);
      if (block?.type === "tool_use" && typeof block.id === "string") out.push({ position, callId: block.id, key: callKey(String(block.name ?? ""), block.input ?? null) });
    }
  });
  return out;
}

type JsonPath = Array<string | number>;

/** A copy of `value` with the string at `path` replaced; everything off the path is shared. */
function replaceAt(value: unknown, path: JsonPath, text: string): unknown {
  if (path.length === 0) return text;
  const [head, ...rest] = path;
  if (Array.isArray(value)) {
    const copy = [...value];
    copy[head as number] = replaceAt(value[head as number], rest, text);
    return copy;
  }
  const record = value as Json;
  return { ...record, [head!]: replaceAt(record[head as string], rest, text) };
}

/** Every string inside a Gemini function response with its path, nested objects and arrays included. */
function stringLeaves(value: unknown, path: JsonPath = [], depth = 0, out: Array<{ path: JsonPath; text: string }> = []) {
  if (typeof value === "string") out.push({ path, text: value });
  else if (depth < 6 && Array.isArray(value)) value.forEach((item, index) => stringLeaves(item, [...path, index], depth + 1, out));
  else if (depth < 6 && obj(value)) for (const [key, item] of Object.entries(value as Json)) stringLeaves(item, [...path, key], depth + 1, out);
  return out;
}

/** `contents` of a Code Assist body (`{ request: { contents } }`, as Antigravity sends it) or of a Gemini API body. */
function geminiContents(body: Json): { contents: unknown[]; rebuild: (contents: unknown[]) => Json } | null {
  const inner = obj(body.request);
  if (inner && Array.isArray(inner.contents)) return { contents: inner.contents, rebuild: (contents) => ({ ...body, request: { ...inner, contents } }) };
  if (Array.isArray(body.contents)) return { contents: body.contents, rebuild: (contents) => ({ ...body, contents }) };
  return null;
}

/** Each part of a Gemini conversation with its content position, for function calls and responses. */
function geminiParts(contents: unknown[]): Array<{ position: number; index: number; part: Json }> {
  const out: Array<{ position: number; index: number; part: Json }> = [];
  contents.forEach((raw, position) => {
    const parts = obj(raw)?.parts;
    if (Array.isArray(parts)) parts.forEach((part, index) => { if (obj(part)) out.push({ position, index, part: part as Json }); });
  });
  return out;
}

/**
 * The call each function response answers: its `id` when the client sends one, otherwise the earliest unanswered
 * call of the same name (Gemini answers calls in order).
 */
function geminiCallOf(contents: unknown[]): Map<Json, { name: string; args: unknown; id: string | null; position: number }> {
  const calls: Array<{ name: string; args: unknown; id: string | null; position: number; answered: boolean }> = [];
  const callOf = new Map<Json, { name: string; args: unknown; id: string | null; position: number }>();
  for (const { position, part } of geminiParts(contents)) {
    const call = obj(part.functionCall);
    if (call) calls.push({ name: String(call.name ?? ""), args: call.args ?? null, id: typeof call.id === "string" ? call.id : null, position, answered: false });
    const response = obj(part.functionResponse);
    if (!response) continue;
    const id = typeof response.id === "string" ? response.id : null;
    const match = calls.find((entry) => !entry.answered && (id ? entry.id === id : entry.name === String(response.name ?? "")));
    if (!match) continue;
    match.answered = true;
    callOf.set(response, match);
  }
  return callOf;
}

/** Metadata lines that may open a tool result before its `Output:` line, and their total length. */
const OUTPUT_PREAMBLE_MAX_LINES = 12;
const OUTPUT_PREAMBLE_MAX_CHARS = 1024;

/**
 * Antigravity's `run_command` result opens with metadata (`Created At`, `Completed At`, `The command exited with
 * code N.`) and an `Output:` line. That preamble is kept as sent and only the output after it is compressed: the log
 * compressor would drop the exit code with the log lines, and the content router reads the output alone.
 */
export function splitOutputPreamble(text: string): { preamble: string; output: string } {
  let end = 0;
  for (let line = 0; line < OUTPUT_PREAMBLE_MAX_LINES; line += 1) {
    const next = text.indexOf("\n", end);
    if (next < 0 || next >= OUTPUT_PREAMBLE_MAX_CHARS) break;
    if (text.slice(end, next) === "Output:") return { preamble: text.slice(0, next + 1), output: text.slice(next + 1) };
    end = next + 1;
  }
  return { preamble: "", output: text };
}

/**
 * Code Assist bodies (Antigravity) and Gemini API bodies: the string values of every `functionResponse`, in every
 * turn, are compressed. Antigravity sends tool results in `model` turns and names their key per model
 * (`toolResponseKey`, `output` by default), so neither the role nor the key is assumed. As in Responses bodies, every
 * turn is compressed and compression is deterministic, so earlier turns are byte-identical from one request to the
 * next and Gemini's implicit prefix cache keeps hitting; a block the conversation received raw stays raw. The user's
 * text, function calls and thoughts are never rewritten, file reads (`view_file`, `cat` through `run_command`) get
 * lossless folds only, and a result's preamble up to its `Output:` line (exit code included) is kept as sent.
 */
export async function compressGeminiBodyAsync(body: Json, options: BodyCompressionOptions & { tokenizer?: TokenizerKind }): Promise<CompressionOutcome> {
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const deadline = Date.now() + options.timeBudgetMs;
  const located = geminiContents(body);
  if (!located || located.contents.length === 0) return finish(body, body, [], startedAt, now, false);
  const { contents } = located;
  const callOf = geminiCallOf(contents);
  const evaluator = createBlockEvaluator(options, options.tokenizer ?? "gemini", deadline, { bytes: OUTPUT_ITEM_MIN_BYTES, contentType: () => "output_item" });
  const replacements: Array<{ position: number; path: JsonPath; text: string }> = [];
  for (const { position, index, part } of geminiParts(contents)) {
    const response = obj(part.functionResponse);
    if (!response) continue;
    const name = String(response.name ?? "");
    if (name === RETRIEVE_TOOL || name.endsWith(`__${RETRIEVE_TOOL}`)) continue;
    const call = callOf.get(response);
    const read = READ_TOOL_NAMES.has(name) || (call !== undefined && isReadCommand(toolCallCommand(call.args)));
    const block = blockOptions(options, read);
    const leaves = stringLeaves(response.response);
    const large = leaves.filter((leaf) => byteLength(leaf.text) >= OUTPUT_ITEM_MIN_BYTES);
    if (large.length === 0) {
      // One below-threshold entry per response, not one per small value (ids, flags, types).
      const bytes = leaves.reduce((sum, leaf) => sum + byteLength(leaf.text), 0);
      if (bytes > 0) {
        evaluator.blocks.push({ itemIndex: position, blockType: `functionResponse#${index}`, action: { kind: "below_threshold", contentType: "output_item", bytes,
          thresholdBytes: OUTPUT_ITEM_MIN_BYTES } });
      }
      continue;
    }
    for (const leaf of large) {
      const { preamble, output } = splitOutputPreamble(leaf.text);
      evaluator.evaluate(position, `functionResponse#${index}${leaf.path.length > 0 ? `.${leaf.path.join(".")}` : ""}`, output, block, (replacement) => {
        replacements.push({ position, path: ["parts", index, "functionResponse", "response", ...leaf.path], text: preamble + replacement });
      });
    }
  }
  const timedOut = await evaluator.settle();
  const next = [...contents];
  for (const replacement of replacements) next[replacement.position] = replaceAt(next[replacement.position], replacement.path, replacement.text);
  const outcome = finish(body, located.rebuild(next), evaluator.blocks, startedAt, now, false,
    summarize(evaluator.analyses, rereadTokens(geminiServed(contents), geminiCalls(contents))));
  return { ...outcome, timedOut };
}

/** Every function response text of a Gemini conversation, with its content position, for re-read detection. */
function geminiServed(contents: unknown[]): ServedResult[] {
  const out: ServedResult[] = [];
  for (const { position, part } of geminiParts(contents)) {
    const response = obj(part.functionResponse);
    if (!response) continue;
    const text = stringLeaves(response.response).map((leaf) => leaf.text).join("\n");
    if (text) out.push({ position, text, callId: typeof response.id === "string" ? response.id : null });
  }
  return out;
}

/** Function calls of a Gemini conversation with their identity, for re-issued call detection. */
function geminiCalls(contents: unknown[]): IssuedCall[] {
  const out: IssuedCall[] = [];
  for (const { position, part } of geminiParts(contents)) {
    const call = obj(part.functionCall);
    if (call && typeof call.id === "string") out.push({ position, callId: call.id, key: callKey(String(call.name ?? ""), call.args ?? null) });
  }
  return out;
}
