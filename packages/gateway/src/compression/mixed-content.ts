/**
 * Mixed-content parsing, a TypeScript port of Headroom `transforms/mixed_content.py` (Apache-2.0, Headroom
 * Contributors): a tool output that holds several kinds of content (prose around a JSON block, code fences, grep
 * rows) is split into typed sections, so each goes to its own compressor. Sections carry their line span; Space
 * Gateway puts each compressed section back in place of its lines (Headroom joins sections with blank lines).
 */
export type SectionType = "json_array" | "source_code" | "search" | "text";

export interface ContentSection {
  content: string;
  type: SectionType;
  /** Code fence language (`unknown` when the fence names none). */
  language: string | null;
  startLine: number;
  endLine: number;
  isCodeFence: boolean;
  /** Never merged into a neighbour (a bracket-balanced block that is not valid JSON). */
  atomic: boolean;
}

const CODE_FENCE = /^```([\p{L}\p{N}_]*)\s*$/u;
const CODE_FENCE_ANY = /^```[\p{L}\p{N}_]*\s*$/mu;
const JSON_BLOCK_START = /^\s*[[{]/m;
const SEARCH_RESULT = /^\S+:\p{Nd}+:/u;
const SEARCH_RESULT_ANY = /^\S+:\p{Nd}+:/mu;
const PROSE = /[A-Z][a-z]+\s+[\p{L}\p{N}_]+\s+[\p{L}\p{N}_]+/gu;

const opensJson = (line: string) => /^[[{]/.test(line.trim());
const isJson = (text: string) => { try { JSON.parse(text); return true; } catch { return false; } };

export function mixedContentIndicators(content: string) {
  return {
    hasCodeFences: CODE_FENCE_ANY.test(content),
    hasJsonBlocks: JSON_BLOCK_START.test(content),
    hasEmbeddedJsonWithText: hasValidJsonBlockWithText(content),
    hasProse: (content.match(PROSE)?.length ?? 0) > 5,
    hasSearchResults: SEARCH_RESULT_ANY.test(content)
  };
}

/** Two or more indicators. */
export function isMixedContent(content: string): boolean {
  return Object.values(mixedContentIndicators(content)).filter(Boolean).length >= 2;
}

type ScanStep = [bracket: number, brace: number, inString: boolean, escaped: boolean];

function scanLine(line: string, inString: boolean, escaped: boolean): ScanStep {
  let bracket = 0;
  let brace = 0;
  for (const char of line) {
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { if (inString) escaped = true; continue; }
    if (char === "\"") { inString = !inString; continue; }
    if (inString) continue;
    if (char === "[") bracket += 1;
    else if (char === "]") bracket -= 1;
    else if (char === "{") brace += 1;
    else if (char === "}") brace -= 1;
  }
  return [bracket, brace, inString, escaped];
}

/**
 * A bracket-balanced block from `start`, or null when it never balances. `cache` memoises per-line scans across
 * candidates once a scan has run to the end, so content that never balances is not re-walked quadratically.
 */
function extractJsonBlock(lines: string[], start: number, cache: Map<string, ScanStep> | null): { content: string | null; end: number } {
  let bracket = 0;
  let brace = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < lines.length; index += 1) {
    const key: string = `${index}:${inString ? 1 : 0}:${escaped ? 1 : 0}`;
    let step: ScanStep | undefined = cache?.get(key);
    if (!step) {
      step = scanLine(lines[index]!, inString, escaped);
      cache?.set(key, step);
    }
    bracket += step[0];
    brace += step[1];
    inString = step[2];
    escaped = step[3];
    if (bracket <= 0 && brace <= 0) return { content: lines.slice(start, index + 1).join("\n"), end: index };
  }
  return { content: null, end: start };
}

const anyNonBlank = (lines: string[], start: number, stop: number) => lines.slice(start, stop).some((line) => line.trim() !== "");

function hasValidJsonBlockWithText(content: string): boolean {
  const lines = content.split("\n");
  let cache: Map<string, ScanStep> | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!opensJson(lines[index]!)) continue;
    const block = extractJsonBlock(lines, index, cache);
    if (block.content === null) { cache ??= new Map(); continue; }
    if (!isJson(block.content)) continue;
    if (anyNonBlank(lines, 0, index) || anyNonBlank(lines, block.end + 1, lines.length)) return true;
  }
  return false;
}

/** Typed sections: code fences, JSON blocks (validated), runs of grep rows, and prose between them. */
export function splitIntoSections(content: string): ContentSection[] {
  const sections: ContentSection[] = [];
  const lines = content.split("\n");
  let cache: Map<string, ScanStep> | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = CODE_FENCE.exec(line);
    if (fence) {
      const start = index;
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index]!.startsWith("```")) { code.push(lines[index]!); index += 1; }
      sections.push({ content: code.join("\n"), type: "source_code", language: fence[1] || "unknown", startLine: start, endLine: index, isCodeFence: true, atomic: false });
      index += 1;
      continue;
    }
    if (opensJson(line)) {
      const block = extractJsonBlock(lines, index, cache);
      if (block.content === null && cache === null) cache = new Map();
      if (block.content !== null) {
        const valid = isJson(block.content);
        sections.push({ content: block.content, type: valid ? "json_array" : "text", language: null, startLine: index, endLine: block.end, isCodeFence: false, atomic: !valid });
        index = block.end + 1;
        continue;
      }
    }
    if (SEARCH_RESULT.test(line)) {
      const start = index;
      const rows: string[] = [];
      while (index < lines.length && SEARCH_RESULT.test(lines[index]!)) { rows.push(lines[index]!); index += 1; }
      sections.push({ content: rows.join("\n"), type: "search", language: null, startLine: start, endLine: index - 1, isCodeFence: false, atomic: false });
      continue;
    }
    const start = index;
    const text = [line];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (CODE_FENCE.test(next) || opensJson(next) || SEARCH_RESULT.test(next)) break;
      text.push(next);
      index += 1;
    }
    const joined = text.join("\n");
    if (joined.trim()) sections.push({ content: joined, type: "text", language: null, startLine: start, endLine: index - 1, isCodeFence: false, atomic: false });
  }
  return coalesce(sections);
}

/** Merges line-contiguous prose sections back into one. */
function coalesce(sections: ContentSection[]): ContentSection[] {
  const merged: ContentSection[] = [];
  for (const section of sections) {
    const previous = merged.at(-1);
    if (previous && previous.type === "text" && section.type === "text" && !previous.isCodeFence && !section.isCodeFence
      && !previous.atomic && !section.atomic && section.startLine === previous.endLine + 1) {
      previous.content = `${previous.content}\n${section.content}`;
      previous.endLine = section.endLine;
      continue;
    }
    merged.push({ ...section });
  }
  return merged;
}
