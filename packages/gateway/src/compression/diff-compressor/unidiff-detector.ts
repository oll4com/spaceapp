/**
 * Parser-based unified-diff detection. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/unidiff_detector.rs` v0.37.0 (Apache-2.0, Headroom Contributors), the
 * Tier-2 check that catches diffs the Magika classifier misses, including the slice of the `unidiff` 0.4.1
 * crate's `PatchSet::parse` (MIT, messense; the version Headroom's Cargo.lock pins) that decides the outcome.
 *
 * `isDiff` is true only when the text has a real `--- ` / `+++ ` / `@@ -a,b +c,d @@` shape AND the whole text
 * parses (no `unidiff` error, no panic) into at least one file with at least one hunk. Upstream wraps the
 * parser in `catch_unwind`; the panics it can hit (target header before any source header, hunk numbers that
 * are non-ASCII digits or overflow `usize`) are modelled here as "not a diff". Release builds wrap on integer
 * overflow, so hunk line counters are 64-bit wrapping.
 */
import type { ContentType } from "../content-detector.js";
import { parseRustUsize, rustLines } from "./rust-compat.js";

const RE_SOURCE_FILENAME = /^--- [^\t\n]/u;
const RE_TARGET_FILENAME = /^\+\+\+ [^\t\n]/u;
/** `unidiff` hunk header; `\d` is Unicode in the Rust `regex` crate. */
const RE_HUNK_HEADER = /^@@ -(\p{Nd}+)(?:,(\p{Nd}+))? \+(\p{Nd}+)(?:,(\p{Nd}+))? @@/u;

const wrap = (value: bigint) => BigInt.asUintN(64, value);

/** Is `content` a unified diff with real change content (at least one parsed hunk)? */
export function isDiff(content: string): boolean {
  if (content === "") return false;
  const lines = rustLines(content);
  if (!looksLikeUnifiedDiff(lines)) return false;
  const files = parsePatchSet(lines);
  return files !== null && files.some((hunks) => hunks > 0);
}

/** `"diff"` (Headroom `ContentType::GitDiff`) when {@link isDiff}, otherwise `null`. */
export function detectDiff(content: string): ContentType | null {
  return isDiff(content) ? "diff" : null;
}

/** Cheap pre-filter: a `--- ` source, then `+++ ` target, then a strict `@@ -a[,b] +c[,d] @@` header. */
function looksLikeUnifiedDiff(lines: readonly string[]): boolean {
  let sawSource = false;
  let sawTarget = false;
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      sawSource = true;
      sawTarget = false;
      continue;
    }
    if (sawSource && line.startsWith("+++ ")) {
      sawTarget = true;
      continue;
    }
    if (sawTarget && isUnifiedHunkHeader(line)) return true;
  }
  return false;
}

function isUnifiedHunkHeader(line: string): boolean {
  if (!line.startsWith("@@ -")) return false;
  const rest = line.slice(4);
  const plus = rest.indexOf(" +");
  if (plus === -1) return false;
  const afterSource = rest.slice(plus + 2);
  const close = afterSource.indexOf(" @@");
  if (close === -1) return false;
  const suffix = afterSource.slice(close + 3);
  return isHunkRange(rest.slice(0, plus)) && isHunkRange(afterSource.slice(0, close)) && (suffix === "" || suffix.startsWith(" "));
}

function isHunkRange(range: string): boolean {
  const comma = range.indexOf(",");
  if (comma === -1) return /^[0-9]+$/.test(range);
  return /^[0-9]+$/.test(range.slice(0, comma)) && /^[0-9]+$/.test(range.slice(comma + 1));
}

/**
 * `unidiff::PatchSet::parse`, reduced to what `isDiff` observes: the hunk count of every parsed file, or
 * `null` when the Rust parser returns `Err` or panics.
 */
function parsePatchSet(lines: readonly string[]): number[] | null {
  const files: number[] = [];
  let current: number | null = null;
  let sawSource = false;
  let lineNo = 0;
  while (lineNo < lines.length) {
    const line = lines[lineNo]!;
    if (RE_SOURCE_FILENAME.test(line)) {
      sawSource = true;
      if (current !== null) files.push(current);
      current = null;
      lineNo += 1;
      continue;
    }
    if (RE_TARGET_FILENAME.test(line)) {
      if (current !== null) return null; // Error::TargetWithoutSource
      if (!sawSource) return null; // `source_file.unwrap()` on None panics
      current = 0;
      lineNo += 1;
      continue;
    }
    const header = RE_HUNK_HEADER.exec(line);
    if (header) {
      if (current === null) return null; // Error::UnexpectedHunk
      const consumed = parseHunk(header, lines, lineNo + 1);
      if (consumed === null) return null; // integer parse `unwrap()` panics
      current += 1;
      lineNo += consumed;
    }
    lineNo += 1;
  }
  if (current !== null) files.push(current);
  return files;
}

/** `PatchedFile::parse_hunk`: how many body lines the hunk consumes, or `null` where Rust panics. */
function parseHunk(header: RegExpExecArray, lines: readonly string[], start: number): number | null {
  const sourceStart = parseRustUsize(header[1]!);
  const sourceLength = parseRustUsize(header[2] ?? "1");
  const targetStart = parseRustUsize(header[3]!);
  const targetLength = parseRustUsize(header[4] ?? "1");
  if (sourceStart === null || sourceLength === null || targetStart === null || targetLength === null) return null;
  const sourceEnd = wrap(sourceStart + sourceLength);
  const targetEnd = wrap(targetStart + targetLength);
  let sourceLine = sourceStart;
  let targetLine = targetStart;
  let consumed = 0;
  for (let index = start; index < lines.length; index += 1) {
    consumed += 1;
    // `^(?P<line_type>[- \n\+\\]?)`: empty or unknown prefixes count as context.
    const type = lines[index]![0];
    if (type === "+") {
      targetLine = wrap(targetLine + 1n);
    } else if (type === "-") {
      sourceLine = wrap(sourceLine + 1n);
    } else if (type !== "\\") {
      targetLine = wrap(targetLine + 1n);
      sourceLine = wrap(sourceLine + 1n);
    }
    if (sourceLine >= sourceEnd && targetLine >= targetEnd) break;
  }
  return consumed;
}
