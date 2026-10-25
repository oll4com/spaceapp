/**
 * Line importance for grep output: the `ImportanceContext::Search` path of Headroom's
 * `crates/headroom-core/src/signals/keyword_detector.rs` (Apache-2.0, Headroom Contributors).
 *
 * Keywords match as whole words (ASCII `[A-Za-z0-9_]` boundaries), ASCII case-insensitively. The error and
 * importance sets are searched together and the leftmost whole-word hit decides between them; only when neither
 * fires is the warning set consulted. Security and markdown categories never fire in Search context.
 */
import { asciiLowercase } from "./rust-text.js";

export type SearchImportance = "error" | "warning" | "importance";

const errorKeywords = ["error", "exception", "fail", "failed", "failure", "fatal", "critical", "crash", "panic", "abort", "timeout", "denied", "rejected"];
const importanceKeywords = ["important", "note", "todo", "fixme", "hack", "xxx", "bug", "fix"];
const warningKeywords = ["warn", "warning"];

// At any start position at most one keyword can be a whole word (keywords are all letters), so regex alternation
// order cannot change the result versus Headroom's leftmost-longest automaton.
const universal = new RegExp(`\\b(${[...errorKeywords, ...importanceKeywords].join("|")})\\b`);
const warning = new RegExp(`\\b(?:${warningKeywords.join("|")})\\b`);
const errorSet = new Set(errorKeywords);

export function searchImportance(line: string): SearchImportance | null {
  const lower = asciiLowercase(line);
  const hit = universal.exec(lower)?.[1];
  if (hit !== undefined) return errorSet.has(hit) ? "error" : "importance";
  return warning.test(lower) ? "warning" : null;
}
