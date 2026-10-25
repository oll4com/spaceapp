/**
 * grep / ripgrep line parser. TypeScript port of `parse_match_line` in Headroom
 * `crates/headroom-core/src/transforms/search_compressor.rs` (Apache-2.0, Headroom Contributors).
 *
 * A line is `<path><sep><digits><sep><content>` where `<sep>` is `:` (match line) or `-` (ripgrep context
 * line). Three tiers run in order and the first hit wins:
 * 1. colon: leftmost `:\d+:` whose path part has no whitespace;
 * 2. dash: `-\d+-`, walking right past markers that sit inside the path (`logs/2026-05-03/app.log-12-...`)
 *    only on positive evidence, otherwise falling back to the leftmost marker;
 * 3. permissive: leftmost `<sep>\d+<sep>` with either separator.
 * A Windows drive prefix (`C:\` or `C:/`) is skipped, and a separator directly after another separator never
 * starts a marker, so `file.py:-1:x` is rejected rather than read as line 1.
 */
import { isAsciiAlpha, isAsciiAlphanumeric, isAsciiDigit, isAsciiWhitespace, isWhitespace } from "./rust-text.js";

export type ParsedMatchLine = [file: string, lineNumber: bigint, content: string];

type Tier = "colon" | "dash" | "permissive";
/** [pathEnd, digitsStart, digitsEnd] */
type Marker = [number, number, number];

const U64_MAX = 18446744073709551615n;

/** Parses one line into `[file, lineNumber, content]`, or null when it has no line-number marker. */
export function parseMatchLine(line: string): ParsedMatchLine | null {
  return scanMatchLine(line, "colon") ?? scanMatchLine(line, "dash") ?? scanMatchLine(line, "permissive");
}

/** A dot followed by 1-8 ASCII alphanumerics with at least one letter: `.md`, `.7z`, not `.3` in `v1.2.3`. */
export function hasExtensionDot(token: string): boolean {
  for (let i = 0; i < token.length - 1; i += 1) {
    if (token[i] !== ".") continue;
    let end = i + 1;
    let letter = false;
    while (end < token.length && isAsciiAlphanumeric(token.charCodeAt(end))) {
      if (isAsciiAlpha(token.charCodeAt(end))) letter = true;
      end += 1;
    }
    const length = end - i - 1;
    if (length >= 1 && length <= 8 && letter) return true;
  }
  return false;
}

function lastSegmentHasExtension(path: string): boolean {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return hasExtensionDot(path.slice(cut + 1));
}

/** The token after a marker (up to whitespace) still carries a directory separator or an extension dot. */
function pathContinues(rest: string): boolean {
  let start = 0;
  while (start < rest.length && isWhitespace(rest.charCodeAt(start))) start += 1;
  if (start === rest.length) return false;
  let end = start;
  while (end < rest.length && !isWhitespace(rest.charCodeAt(end))) end += 1;
  const token = rest.slice(start, end);
  return token.includes("/") || token.includes("\\") || hasExtensionDot(token);
}

function scanMatchLine(line: string, tier: Tier): ParsedMatchLine | null {
  const scanStart = line.length >= 3 && isAsciiAlpha(line.charCodeAt(0)) && line[1] === ":" && (line[2] === "\\" || line[2] === "/") ? 2 : 0;
  // The typed tiers only accept markers inside the leading whitespace-free run.
  let firstWhitespace = 0;
  while (firstWhitespace < line.length && !isAsciiWhitespace(line.charCodeAt(firstWhitespace))) firstWhitespace += 1;

  let first: Marker | null = null;
  let chosen: Marker | null = null;
  let i = scanStart;
  while (i < line.length) {
    const char = line[i];
    const tierSeparator = tier === "colon" ? char === ":" : tier === "dash" ? char === "-" : char === ":" || char === "-";
    if (tierSeparator) {
      const previous = i > 0 ? line[i - 1] : undefined;
      if (previous === ":" || previous === "-") {
        i += 1;
        continue;
      }
      if (tier !== "permissive" && firstWhitespace < i) break;
      const digitsStart = i + 1;
      let j = digitsStart;
      while (j < line.length && isAsciiDigit(line.charCodeAt(j))) j += 1;
      const closing = line[j];
      const closes = j > digitsStart && j < line.length
        && (tier === "permissive" ? closing === ":" || closing === "-" : closing === char);
      if (closes) {
        if (i === 0) return null;
        const marker: Marker = [i, digitsStart, j];
        first ??= marker;
        if (tier !== "dash" || lastSegmentHasExtension(line.slice(0, i)) || !pathContinues(line.slice(j + 1))) {
          chosen = marker;
          break;
        }
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }

  const marker = chosen ?? first;
  if (!marker) return null;
  const [pathEnd, digitsStart, digitsEnd] = marker;
  const lineNumber = BigInt(line.slice(digitsStart, digitsEnd));
  if (lineNumber > U64_MAX) return null;
  return [line.slice(0, pathEnd), lineNumber, line.slice(digitsEnd + 1)];
}
