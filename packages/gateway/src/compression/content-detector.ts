/**
 * Content type detection for routing tool output to a compressor. TypeScript port of Headroom
 * `crates/headroom-core/src/transforms/content_detector.rs` (Apache-2.0, Headroom Contributors): regex-based,
 * same dispatch order, confidence formulas and line caps; checked against Headroom's parity fixtures.
 */
export type ContentType = "json_array" | "source_code" | "search" | "build" | "diff" | "html" | "text";

export interface DetectionResult {
  contentType: ContentType;
  confidence: number;
  metadata: Record<string, unknown>;
}

const searchResult = /^[^\s:]+:\d+:/;
const diffHeader = /^(diff --git|diff --combined |diff --cc |--- a\/|@@\s+-\d+,\d+\s+\+\d+,\d+\s+@@|@@@+\s+-\d+(?:,\d+)?\s+(?:-\d+(?:,\d+)?\s+)+\+\d+(?:,\d+)?\s+@@@+)/;
const diffChange = /^[+-][^+-]/;

const codePatterns: { name: string; patterns: RegExp[] }[] = [
  { name: "python", patterns: [/^\s*(def|class|import|from|async def)\s+\w+/, /^\s*@\w+/, /^\s*"""/, /^\s*if __name__\s*==/] },
  { name: "javascript", patterns: [/^\s*(function|const|let|var|class|import|export)\s+/, /^\s*(async\s+function|=>\s*\{)/, /^\s*module\.exports/] },
  { name: "typescript", patterns: [/^\s*(interface|type|enum|namespace)\s+\w+/, /^:\s*(string|number|boolean|any|void)\b/] },
  { name: "go", patterns: [/^\s*(func|type|package|import)\s+/, /^\s*func\s+\([^)]+\)\s+\w+/] },
  { name: "rust", patterns: [/^\s*(fn|struct|enum|impl|mod|use|pub)\s+/, /^\s*#\[/] },
  { name: "java", patterns: [/^\s*(public|private|protected)\s+(class|interface|enum)/, /^\s*@\w+/, /^\s*package\s+[\w.]+;/] }
];

/**
 * Indices 0-2 (error, warning and test-failure families) also count as error matches. Space Gateway adds the
 * test-runner lines (TAP, node's spec reporter, jest/vitest, mocha, go test, cargo test); Headroom's detector has
 * only pytest's, so a `node --test` run was prose to it.
 */
const logPatterns = [
  /\b(ERROR|FAIL|FAILED|FATAL|CRITICAL)\b/i,
  /\b(WARN|WARNING)\b/i,
  /^\s*not ok \d+\b|^[#ℹ] fail [1-9]|^\s*[✖✗×] |^test result: FAILED|^\s*\d+ failing\b/u,
  /\b(INFO|DEBUG|TRACE)\b/i,
  /^\s*\d{4}-\d{2}-\d{2}/,
  /^\s*\[\d{2}:\d{2}:\d{2}\]/,
  /^={3,}|^-{3,}/,
  /^\s*PASSED|^\s*FAILED|^\s*SKIPPED/,
  /^npm ERR!|^yarn error|^cargo error/,
  /Traceback \(most recent call last\)/,
  /^\s*at\s+[\w.$]+\(/,
  /^\s*ok \d+\b|^[#ℹ] (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d|^\s*# Subtest:|^\s*\d+\.\.\d+$/u,
  /^\s*[✓✔] |^\s*(Tests|Test Suites|Test Files|Snapshots):?\s+\d/u,
  /^(--- PASS|=== RUN)|^(ok|FAIL)\s+\S+\s+[\d.]+s$/,
  /^test \S+ \.\.\. (ok|FAILED|ignored)$|^test result: |^\s*\d+ (passing|pending)\b/
];

const htmlDoctype = /^\s*<!doctype\s+html/i;
const htmlTag = /<html[\s>]/i;
const htmlHead = /<head[\s>]/i;
const htmlBody = /<body[\s>]/i;
const htmlStructural = /<(div|span|script|style|link|meta|nav|header|footer|aside|article|section|main)[\s>]/gi;

const plainText = (confidence: number): DetectionResult => ({ contentType: "text", confidence, metadata: {} });
const nonEmpty = (lines: string[]) => lines.filter((line) => line.trim() !== "").length;

/** Dispatch order: empty, JSON array, diff (>= 0.7), HTML (>= 0.7), search (>= 0.6), build log (>= 0.5), code (>= 0.5), text. */
export function detectContentType(content: string): DetectionResult {
  if (content.trim() === "") return plainText(0);
  const json = detectJson(content);
  if (json) return json;
  const diff = detectDiff(content);
  if (diff && diff.confidence >= 0.7) return diff;
  const html = detectHtml(content);
  if (html && html.confidence >= 0.7) return html;
  const search = detectSearch(content);
  if (search && search.confidence >= 0.6) return search;
  const log = detectLog(content);
  if (log && log.confidence >= 0.5) return log;
  const code = detectCode(content);
  if (code && code.confidence >= 0.5) return code;
  return plainText(0.5);
}

export function isJsonArrayOfDicts(content: string): boolean {
  const result = detectContentType(content);
  return result.contentType === "json_array" && result.metadata.is_dict_array === true;
}

function detectJson(content: string): DetectionResult | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  const isDictArray = parsed.length > 0 && parsed.every((item) => item !== null && typeof item === "object" && !Array.isArray(item));
  return { contentType: "json_array", confidence: isDictArray ? 1 : 0.8, metadata: { item_count: parsed.length, is_dict_array: isDictArray } };
}

function detectDiff(content: string): DetectionResult | null {
  let headers = 0;
  let changes = 0;
  for (const line of content.split("\n").slice(0, 500)) {
    if (diffHeader.test(line)) headers += 1;
    if (diffChange.test(line)) changes += 1;
  }
  if (headers === 0) return null;
  return { contentType: "diff", confidence: Math.min(1, 0.5 + headers * 0.2 + changes * 0.05), metadata: { header_matches: headers, change_lines: changes } };
}

/** The first 3000 bytes, cut on a character boundary (Rust slices bytes). */
function byteSample(content: string, limit: number): string {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.length <= limit) return content;
  let cutoff = limit;
  while (cutoff > 0 && (bytes[cutoff]! & 0xc0) === 0x80) cutoff -= 1;
  return bytes.subarray(0, cutoff).toString("utf8");
}

function detectHtml(content: string): DetectionResult | null {
  const sample = byteSample(content, 3000);
  const hasDoctype = htmlDoctype.test(sample);
  const hasHtmlTag = htmlTag.test(sample);
  const hasHead = htmlHead.test(sample);
  const hasBody = htmlBody.test(sample);
  const structural = sample.match(htmlStructural)?.length ?? 0;
  if (!hasDoctype && !hasHtmlTag && structural < 3) return null;
  let confidence = 0;
  if (hasDoctype) confidence += 0.5;
  if (hasHtmlTag) confidence += 0.3;
  if (hasHead) confidence += 0.1;
  if (hasBody) confidence += 0.1;
  confidence += Math.min(structural * 0.03, 0.3);
  confidence = Math.min(confidence, 1);
  if (confidence < 0.5) return null;
  return { contentType: "html", confidence, metadata: { has_doctype: hasDoctype, has_html_tag: hasHtmlTag, structural_tags: structural } };
}

function detectSearch(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 100);
  const matching = lines.filter((line) => line.trim() !== "" && searchResult.test(line)).length;
  if (matching === 0) return null;
  const total = nonEmpty(lines);
  if (total === 0) return null;
  const ratio = matching / total;
  if (ratio < 0.3) return null;
  return { contentType: "search", confidence: Math.min(1, 0.4 + ratio * 0.6), metadata: { matching_lines: matching, total_lines: total } };
}

function detectLog(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 200);
  let matches = 0;
  let errors = 0;
  for (const line of lines) {
    const index = logPatterns.findIndex((pattern) => pattern.test(line));
    if (index < 0) continue;
    matches += 1;
    if (index < 3) errors += 1;
  }
  if (matches === 0) return null;
  const total = nonEmpty(lines);
  if (total === 0) return null;
  const ratio = matches / total;
  if (ratio < 0.1) return null;
  return { contentType: "build", confidence: Math.min(1, 0.3 + ratio * 0.5 + errors * 0.05), metadata: { pattern_matches: matches, error_matches: errors, total_lines: total } };
}

function detectCode(content: string): DetectionResult | null {
  const lines = content.split("\n").slice(0, 100);
  // First-match insertion order with first-on-tie, like Python's dict + max().
  const scores: [string, number][] = [];
  for (const line of lines) {
    for (const language of codePatterns) {
      if (!language.patterns.some((pattern) => pattern.test(line))) continue;
      const entry = scores.find(([name]) => name === language.name);
      if (entry) entry[1] += 1;
      else scores.push([language.name, 1]);
    }
  }
  if (scores.length === 0) return null;
  const max = Math.max(...scores.map(([, score]) => score));
  const [language, score] = scores.find(([, value]) => value === max)!;
  if (score < 3) return null;
  const ratio = score / Math.max(nonEmpty(lines), 1);
  return { contentType: "source_code", confidence: Math.min(1, 0.4 + ratio * 0.4 + score * 0.02), metadata: { language, pattern_matches: score } };
}
