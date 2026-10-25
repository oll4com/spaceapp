/**
 * Test-runner output protection, a Space Gateway addition on top of the Headroom port. A failing test run is what an
 * agent acts on, so its failure lines, assertion diagnostics and final counts must reach the model verbatim: the log
 * compressor and TextCrusher keep them whatever their caps say, small reports pass through whole, and a replacement
 * that lost one is rejected. `hasStrongErrorIndicators` follows Headroom `transforms/error_detection.py` (Apache-2.0,
 * Headroom Contributors).
 */

/** Headroom `error_protection_max_chars`, applied to UTF-8 bytes here. */
export const ERROR_PROTECTION_MAX_BYTES = 8000;

/** A failed test, suite or run: node --test TAP and spec reporter, jest, vitest, mocha, pytest, go test, cargo test. */
const FAILURE_LINES = [
  /^\s*not ok \d+\b/,
  /^[#ℹ] fail [1-9]/u,
  /^\s*[✖✗] /u,
  /^✖ failing tests:/u,
  /^\s*FAIL\s+\S/,
  /^\s*● /u,
  /^\s*× /u,
  /^\s*❯ .*\bfailed\b/u,
  /^\s*\d+\) /,
  /^\s*\d+ failing\b/,
  /^(FAILED|ERROR) \S+::/,
  /^E\s{3,}\S/,
  /^--- FAIL: /,
  /^FAIL\s*$/,
  /^FAIL\t\S/,
  /^panic: /,
  /^test \S+ \.\.\. FAILED$/,
  /^---- \S+ stdout ----$/,
  /^thread '.*' panicked at/,
  /^test result: FAILED\./
];

/** The counts a run ends with. */
const SUMMARY_LINES = [
  /^[#ℹ] (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) \d/u,
  /^\s*\d+\.\.\d+$/,
  /^\s*(Tests|Test Suites|Test Files|Snapshots|Time):?\s+\d/,
  /^\s*\d+ (passing|pending)\b/,
  /^=+ .*\b(passed|failed|errors?|skipped)\b.* =+$/,
  /^=+ (FAILURES|ERRORS|short test summary info) =+$/,
  /^(ok|FAIL)\s+\S+\s+[\d.]+s$/,
  /^PASS$/,
  /^test result: /,
  /^running \d+ tests?$/,
  /^Ran \d+ tests? in /
];

/** Why a test failed: assertion messages, expected/actual values and diffs. Anchored, so source and JSON lines stay out. */
const ASSERTION_LINES = [
  /^\s*\S*AssertionError\b/,
  /^\S+:\d+: \w*Error\b/,
  /^\s*(Expected|Received)\b.*:/,
  /^\s*[-+] (Expected|Received)$/,
  /^\s*\+ (actual|expected) - (expected|actual)\b/,
  /^\s*error: \|-?$/,
  /^\s*(expected|actual): /,
  /^\s*code: 'ERR_/,
  /^\s*\S+ !== \S+$/,
  /^\s*Missing expected exception\b/,
  /^\s*\S+_test\.go:\d+: /
];

const matchesAny = (patterns: RegExp[], line: string) => patterns.some((pattern) => pattern.test(line));

/** A line of a test report the model needs verbatim: a failure, an assertion or diff line, or the final counts. */
export function isProtectedLine(line: string): boolean {
  return matchesAny(FAILURE_LINES, line) || matchesAny(SUMMARY_LINES, line) || matchesAny(ASSERTION_LINES, line);
}

/** The text is a test run with at least one failure line. */
export function hasTestFailureReport(text: string): boolean {
  return text.split("\n").some((line) => matchesAny(FAILURE_LINES, line));
}

/** Protected lines of `original` (trimmed, non-empty) that `replacement` no longer contains. */
export function missingProtectedLines(original: string, replacement: string): number {
  const kept = new Set(replacement.split("\n").map((line) => line.trim()));
  let missing = 0;
  for (const line of original.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && isProtectedLine(line) && !kept.has(trimmed)) missing += 1;
  }
  return missing;
}

const ERROR_INDICATORS = ["error", "fail", "exception", "traceback", "fatal", "panic", "crash"];
/** Phrases that mention an indicator word to say there was none (Headroom's list, plus TAP's `# fail 0`). */
const ZERO_RESULTS = new RegExp("\\b0\\s+(errors?|failures?|failed|exceptions?|warnings?|problems?)\\b"
  + "|\\b(errors?|failures?|failed|exceptions?|warnings?|problems?)\\s*[:=]\\s*0\\b"
  + "|\\bno\\s+(errors?|failures?|exceptions?|problems?)\\b"
  + "|\\b(without|zero)\\s+(errors?|failures?|exceptions?)\\b"
  + "|^[#ℹ]\\s+fail\\s+0\\b", "gimu");

/** Headroom `content_has_strong_error_indicators`: two distinct indicator words once zero-count phrases are removed. */
export function hasStrongErrorIndicators(text: string): boolean {
  const scrubbed = text.toLowerCase().replace(ZERO_RESULTS, " ");
  return ERROR_INDICATORS.filter((word) => scrubbed.includes(word)).length >= 2;
}
