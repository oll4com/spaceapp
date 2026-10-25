/**
 * Format detection, level classification and summary-line detection for build/test logs. TypeScript port of
 * Headroom `crates/headroom-core/src/transforms/log_compressor.rs` (Apache-2.0, Headroom Contributors).
 */
import { isAsciiDigit, isWhiteSpace, leadingDigits } from "./rust-text.js";

export type LogFormat = "pytest" | "npm" | "cargo" | "jest" | "make" | "generic";

/** ERROR and FAIL score the same; the split is cosmetic (kept for upstream parity). */
export type LogLevel = "error" | "fail" | "warn" | "info" | "debug" | "trace" | "unknown";

const formatMarkers: [LogFormat, string[]][] = [
  ["pytest", ["=== FAILURES", "=== ERRORS", "=== test session", "=== short test summary", "PASSED [", "FAILED [", "ERROR [", "SKIPPED [", "collected "]],
  ["npm", ["npm ERR!", "npm WARN", "npm info", "npm http"]],
  ["cargo", ["Compiling ", "Finished ", "Running ", "warning: ", "error[E"]],
  ["jest", ["PASS ", "FAIL ", "Test Suites:"]],
  ["make", ["make[", "make:", "gcc ", "g++ ", "clang "]]
];

/** Scores each format by how many of the first 100 lines carry one of its markers; the first strict maximum wins. */
export function detectLogFormat(lines: readonly string[]): LogFormat {
  const sample = lines.slice(0, 100);
  let best: LogFormat = "generic";
  let bestScore = 0;
  for (const [format, markers] of formatMarkers) {
    const score = sample.filter((line) => markers.some((marker) => line.includes(marker))).length;
    if (score > bestScore) {
      best = format;
      bestScore = score;
    }
  }
  return best;
}

const levelWords: [LogLevel, string[]][] = [
  ["error", ["ERROR", "error", "Error", "FATAL", "fatal", "Fatal", "CRITICAL", "critical"]],
  ["fail", ["FAIL", "FAILED", "fail", "failed", "Fail", "Failed"]],
  ["warn", ["WARN", "WARNING", "warn", "warning", "Warn", "Warning"]],
  ["info", ["INFO", "info", "Info"]],
  ["debug", ["DEBUG", "debug", "Debug"]],
  ["trace", ["TRACE", "trace", "Trace"]]
];
const levelByWord = new Map(levelWords.flatMap(([level, words]) => words.map((word) => [word, level] as const)));
/**
 * Leftmost whole-word keyword (ASCII word boundaries). Upstream runs a leftmost-longest Aho-Corasick scan with a
 * boundary post-filter; every keyword is all letters, so a rejected match can never hide a valid one and the
 * leftmost bounded match is the same.
 */
const levelPattern = new RegExp(`\\b(?:${[...levelByWord.keys()].join("|")})\\b`);

export function classifyLevel(line: string): LogLevel {
  const match = levelPattern.exec(line);
  return match ? levelByWord.get(match[0])! : "unknown";
}

/** Separators, `N passed|failed|...`, `Tests: N`, totals, and `Build|Compile|Test ... succeeded|failed|complete`. */
export function isSummaryLine(line: string): boolean {
  if (line.startsWith("===") || line.startsWith("---")) return true;
  const digits = leadingDigits(line);
  if (digits > 0 && line.startsWith(" ", digits)) {
    const rest = line.slice(digits + 1);
    if (["passed", "failed", "skipped", "error", "warning"].some((keyword) => rest.startsWith(keyword))) return true;
  }
  for (const prefix of ["Test ", "Tests ", "Tests:", "Test:", "Suite ", "Suites ", "Suites:", "Suite:"]) {
    if (!line.startsWith(prefix)) continue;
    // Upstream returns here either way: a counted prefix must be followed by a number.
    const first = [...line.slice(prefix.length)].find((char) => !isWhiteSpace(char));
    return isAsciiDigit(first);
  }
  if (["TOTAL", "Total", "Summary"].some((prefix) => line.startsWith(prefix))) return true;
  return ["Build", "Compile", "Test"].some((prefix) => line.startsWith(prefix))
    && ["succeeded", "failed", "complete"].some((outcome) => line.includes(outcome));
}
