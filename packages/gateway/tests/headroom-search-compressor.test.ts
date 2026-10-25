import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeOptimalK, computeUniqueBigramCurve, countUniqueSimhash, findKnee, hammingDistance, simhash, validateWithZlib
} from "../src/compression/search-compressor/adaptive-sizer.js";
import {
  cjkBigrams, compressSearchForLiveZone, compressSearchResults, emptySearchCompressorStats, formatOutput, matchesOmitted, parseMatchLine,
  parseSearchResults, scoreMatches, selectMatches, tokensSavedEstimate,
  type CcrStore, type FileMatchMap, type SearchCompressionResult, type SearchCompressorConfig, type SearchMatch
} from "../src/compression/search-compressor/index.js";
import { searchImportance } from "../src/compression/search-compressor/keyword-importance.js";

class MemoryStore implements CcrStore {
  readonly entries = new Map<string, string>();
  put(hash: string, payload: string) { this.entries.set(hash, payload); }
}

const match = (file: string, lineNumber: number, content: string): SearchMatch => ({ file, lineNumber: BigInt(lineNumber), content, score: 0 });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => from + index);
const ccrKey = (text: string) => createHash("md5").update(text, "utf8").digest("hex").slice(0, 24);
const marker = (original: number, kept: number, text: string) => `[${original} matches compressed to ${kept}. Retrieve more: hash=${ccrKey(text)}]`;

/** Headroom's Python `SearchCompressor.compress` goes through PyO3, which always hands Rust an in-memory CCR store. */
function py(content: string, config: Partial<SearchCompressorConfig> = {}, context = "", bias = 1): SearchCompressionResult {
  return compressSearchResults(content, context, bias, config, new MemoryStore()).result;
}

describe("search compressor parser (search_compressor.rs unit tests)", () => {
  it("parses_standard_grep_line", () => {
    expect(parseMatchLine("src/main.py:42:def main():")).toEqual(["src/main.py", 42n, "def main():"]);
  });

  it("cjk_bigrams_from_runs", () => {
    const bigrams = cjkBigrams("认证令牌");
    expect(bigrams).toEqual(new Set(["认证", "证令", "令牌"]));
    expect(cjkBigrams("hello").size).toBe(0);
    expect(cjkBigrams("a认b证").size).toBe(0);
  });

  it("dash_tier_does_not_run_past_the_path_into_the_body", () => {
    expect(parseMatchLine("notes.md-3-see-4-here")).toEqual(["notes.md", 3n, "see-4-here"]);
    expect(parseMatchLine("CHANGELOG.md-7-v1-2-beta")).toEqual(["CHANGELOG.md", 7n, "v1-2-beta"]);
  });

  it("parses_context_line_for_extensionless_path", () => {
    const cases: [string, string, bigint, string][] = [
      ["CHANGELOG-12-2026-05-03", "CHANGELOG", 12n, "2026-05-03"],
      ["LICENSE-1-Copyright-2026-Acme", "LICENSE", 1n, "Copyright-2026-Acme"],
      ["Makefile-7-build-2-stage", "Makefile", 7n, "build-2-stage"],
      ["Dockerfile-3-FROM-18-alpine", "Dockerfile", 3n, "FROM-18-alpine"],
      ["bin/run-3-exec-9-now", "bin/run", 3n, "exec-9-now"],
      [".github/workflows/ci-9-2026-01-02", ".github/workflows/ci", 9n, "2026-01-02"]
    ];
    for (const [line, file, lineNumber, body] of cases) expect(parseMatchLine(line), line).toEqual([file, lineNumber, body]);
  });

  it("dated_dir_still_wins_for_an_extensionless_file", () => {
    expect(parseMatchLine("logs/2026-05-03/Makefile-12-all:")).toEqual(["logs/2026-05-03/Makefile", 12n, "all:"]);
  });

  it("ambiguous_dash_line_falls_back_to_the_leftmost_marker", () => {
    expect(parseMatchLine("Makefile-7-include-2-src/foo.mk")).toEqual(["Makefile", 7n, "include-2-src/foo.mk"]);
  });

  it("a_dotted_version_in_the_body_is_not_an_extension", () => {
    for (const line of ["Makefile-9-VERSION=v1.2.3-4-gdeadbee", "Dockerfile-4-TAG=v2.0.1-3-gabc", "CHANGELOG-2-rel.1.2-3-final", "LICENSE-1-v1.0-2-clause"]) {
      const parsed = parseMatchLine(line);
      expect(parsed, line).not.toBeNull();
      expect(parsed![0], line).not.toContain(".");
    }
    expect(parseMatchLine("Makefile-9-VERSION=v1.2.3-4-gdeadbee")).toEqual(["Makefile", 9n, "VERSION=v1.2.3-4-gdeadbee"]);
  });

  it("a_real_extension_still_counts_even_with_digits_in_it", () => {
    expect(parseMatchLine("media/2026-05-03/track-2-final.mp3-8-id3")).toEqual(["media/2026-05-03/track-2-final.mp3", 8n, "id3"]);
  });

  it("dated_path_inside_a_context_body_is_not_hijacked", () => {
    expect(parseMatchLine("manifest.txt-5-logs/2026-05-03/app.log")).toEqual(["manifest.txt", 5n, "logs/2026-05-03/app.log"]);
    expect(parseMatchLine("index.md-2-advisories/CVE-2021-44228.md")).toEqual(["index.md", 2n, "advisories/CVE-2021-44228.md"]);
  });

  it("parses_ripgrep_context_line", () => {
    expect(parseMatchLine("src/main.py-43-context after match")).toEqual(["src/main.py", 43n, "context after match"]);
  });

  it("fixed_in_3e2_handles_windows_path_with_backslash", () => {
    expect(parseMatchLine("C:\\Users\\foo\\bar.py:42:def main():")).toEqual(["C:\\Users\\foo\\bar.py", 42n, "def main():"]);
  });

  it("fixed_in_3e2_handles_windows_path_with_forward_slash", () => {
    expect(parseMatchLine("C:/Users/foo/bar.py:42:def main():")).toEqual(["C:/Users/foo/bar.py", 42n, "def main():"]);
  });

  it("fixed_in_3e2_handles_dashes_in_filename_with_ripgrep_context", () => {
    expect(parseMatchLine("pre-commit-config.yaml-42-fail_fast: true")).toEqual(["pre-commit-config.yaml", 42n, "fail_fast: true"]);
  });

  it("date_stamped_path_is_not_misread_as_line_number_marker", () => {
    expect(parseMatchLine("logs/2026-05-03/app.log:12:ERROR boom")).toEqual(["logs/2026-05-03/app.log", 12n, "ERROR boom"]);
    expect(parseMatchLine("logs/2026-11-23/app.log-11-context before")).toEqual(["logs/2026-11-23/app.log", 11n, "context before"]);
    expect(parseMatchLine("src/v1-2-beta/mod.rs:3:fn x() {}")).toEqual(["src/v1-2-beta/mod.rs", 3n, "fn x() {}"]);
    expect(parseMatchLine("advisories/CVE-2021-44228.md:8:Log4Shell")).toEqual(["advisories/CVE-2021-44228.md", 8n, "Log4Shell"]);
    expect(parseMatchLine("migrations/20240101-002-add_users.sql-9-  id BIGINT")).toEqual(["migrations/20240101-002-add_users.sql", 9n, "  id BIGINT"]);
  });

  it("date_stamped_paths_are_not_collapsed_into_one_bogus_file", () => {
    const stats = emptySearchCompressorStats();
    const parsed = parseSearchResults("logs/2026-05-03/app.log:12:ERROR boom\nlogs/2026-05-04/app.log:7:ERROR bang", stats);
    expect(stats.linesUnparsed).toBe(0);
    expect([...parsed.keys()]).toEqual(["logs/2026-05-03/app.log", "logs/2026-05-04/app.log"]);
    expect(parsed.get("logs/2026-05-03/app.log")!.matches[0]!.lineNumber).toBe(12n);
    expect(parsed.get("logs/2026-05-03/app.log")!.matches[0]!.content).toBe("ERROR boom");
  });

  it("body_line_reference_does_not_hijack_a_context_line", () => {
    expect(parseMatchLine("src/main.py-44-see foo.rs:12:bar")).toEqual(["src/main.py", 44n, "see foo.rs:12:bar"]);
  });

  it("digit_terminated_path_still_parses_ripgrep_context_line", () => {
    expect(parseMatchLine("logs/app.log.1-42-rotated line")).toEqual(["logs/app.log.1", 42n, "rotated line"]);
  });

  it("preserves_colons_in_match_content", () => {
    expect(parseMatchLine('config.py:10:DATABASE_URL = "postgres://user:pass@host:5432/db"'))
      .toEqual(["config.py", 10n, 'DATABASE_URL = "postgres://user:pass@host:5432/db"']);
  });

  it("rejects_lines_without_line_number_marker", () => {
    expect(parseMatchLine("just a normal line of prose")).toBeNull();
    expect(parseMatchLine("file.py:not-a-number:something")).toBeNull();
    expect(parseMatchLine(":42:something")).toBeNull();
  });

  it("rejects_negative_line_numbers", () => {
    expect(parseMatchLine("src/file.py:-1:invalid")).toBeNull();
    expect(parseMatchLine("src/file.py--1-invalid")).toBeNull();
  });

  it("parser_groups_by_file_and_counts", () => {
    const stats = emptySearchCompressorStats();
    const parsed = parseSearchResults("src/main.py:42:def main():\nsrc/main.py:43:    pass\nsrc/utils.py:15:def util():\njust prose, no marker\nsrc/main.py-44-context line", stats);
    expect(parsed.size).toBe(2);
    expect(parsed.get("src/main.py")!.matches).toHaveLength(3);
    expect(parsed.get("src/utils.py")!.matches).toHaveLength(1);
    expect(stats.linesUnparsed).toBe(1);
    expect(stats.linesScanned).toBe(5);
  });
});

describe("search compressor pipeline (search_compressor.rs unit tests)", () => {
  it("scoring_boosts_error_lines_in_search_context", () => {
    const files: FileMatchMap = new Map([["src/auth.py", { file: "src/auth.py", matches: [match("src/auth.py", 10, "ERROR auth failed"), match("src/auth.py", 11, "plain auth line")] }]]);
    scoreMatches(files, "find auth error", { contextKeywords: ["auth"] });
    const [first, second] = files.get("src/auth.py")!.matches;
    expect(first!.score).toBe(1);
    expect(second!.score).toBeGreaterThan(0);
    expect(second!.score).toBeLessThan(1);
    expect(second!.score).toBe(Math.fround(Math.fround(0.3) + Math.fround(0.4)));
  });

  it("select_respects_per_file_cap_and_global_cap", () => {
    const config = { maxMatchesPerFile: 2, maxTotalMatches: 6, maxFiles: 2, alwaysKeepFirst: true, alwaysKeepLast: true };
    const files: FileMatchMap = new Map();
    for (const [file, count] of [["a.py", 5], ["b.py", 4], ["c.py", 3]] as const) {
      files.set(file, { file, matches: range(1, count).map((i) => match(file, i, `line ${i}`)) });
    }
    const stats = emptySearchCompressorStats();
    const selected = selectMatches(files, 1, config, stats);
    expect(selected.size).toBe(2);
    expect(stats.filesDropped).toBeGreaterThanOrEqual(1);
    for (const group of selected.values()) {
      expect(group.matches.length).toBeLessThanOrEqual(2);
      for (let i = 1; i < group.matches.length; i += 1) expect(group.matches[i - 1]!.lineNumber < group.matches[i]!.lineNumber).toBe(true);
    }
    // Exact selection; the sizer budget (6) is the recorded Python golden "per_file_and_global_cap".
    expect([...selected].map(([file, group]) => [file, group.matches.map((m) => m.lineNumber)])).toEqual([["a.py", [1n, 5n]], ["b.py", [1n, 4n]]]);
    expect(stats).toMatchObject({ filesDropped: 1, matchesDroppedByPerFileCap: 5, matchesDroppedByGlobalCap: 0 });
  });

  it("empty_input_returns_unchanged", () => {
    const { result } = compressSearchResults("plain text only", "", 1);
    expect(result.originalMatchCount).toBe(0);
    expect(result.compressed).toBe("plain text only");
    expect(result.compressionRatio).toBe(1);
  });

  it("ccr_marker_emitted_when_thresholds_clear", () => {
    const content = range(1, 12).map((i) => `src/main.py:${i}:line content ${i}\n`).join("");
    const store = new MemoryStore();
    const { result, stats } = compressSearchResults(content, "", 1, { maxMatchesPerFile: 2, maxTotalMatches: 4, minMatchesForCcr: 5, minCompressionRatioForCcr: 0.95 }, store);
    expect(result.cacheKey).not.toBeNull();
    expect(stats.ccrEmitted).toBe(true);
    expect(result.compressed).toContain("[12 matches compressed to");
    expect(store.entries.get(result.cacheKey!)).toBe(content);
    expect(result.compressed).toBe(["src/main.py:1:line content 1", "src/main.py:12:line content 12", "[... and 10 more matches in src/main.py]", marker(12, 2, content)].join("\n"));
  });

  it("ccr_skipped_when_below_min_matches", () => {
    const store = new MemoryStore();
    const { stats } = compressSearchResults("src/main.py:1:hi\nsrc/main.py:2:bye\n", "", 1, { minMatchesForCcr: 100 }, store);
    expect(stats.ccrEmitted).toBe(false);
    expect(stats.ccrSkipReason).toBe("below min_matches_for_ccr");
    expect(store.entries.size).toBe(0);
  });

  it("ccr_skipped_when_disabled", () => {
    const content = range(1, 20).map((i) => `src/main.py:${i}:line\n`).join("");
    const { stats } = compressSearchResults(content, "", 1, { enableCcr: false }, new MemoryStore());
    expect(stats.ccrEmitted).toBe(false);
    expect(stats.ccrSkipReason).toBe("ccr disabled in config");
  });
});

describe("adaptive sizer (adaptive_sizer.rs unit tests)", () => {
  it("simhash_empty_string", () => expect(simhash("")).toBe(0xd41d8cd98f00b204n));
  it("simhash_single_char", () => expect(simhash("a")).toBe(0x0cc175b9c0f1b6a8n));
  it("simhash_short_strings", () => {
    expect(simhash("ab")).toBe(0x187ef4436122d1ccn);
    expect(simhash("abc")).toBe(0x900150983cd24fb0n);
  });
  it("simhash_n_eq_4_single_iteration", () => expect(simhash("abcd")).toBe(0xe2fc714c4727ee93n));
  it("simhash_multi_window", () => {
    expect(simhash("hello")).toBe(0x0209020130100020n);
    expect(simhash("hello world")).toBe(0x4681260120120222n);
  });
  it("simhash_unicode_codepoint_iteration", () => expect(simhash("café")).toBe(0x07117fe4a1ebd544n));
  it("simhash_lowercases_input", () => {
    expect(simhash("ABC")).toBe(simhash("abc"));
    expect(simhash("Hello")).toBe(simhash("hello"));
  });
  it("simhash_longer_text", () => expect(simhash("The quick brown fox jumps")).toBe(0x30875e2639b3cb98n));

  it("hamming_distance_zero_identical", () => {
    expect(hammingDistance(0n, 0n)).toBe(0);
    expect(hammingDistance(0xffn, 0xffn)).toBe(0);
  });
  it("hamming_distance_basic", () => {
    expect(hammingDistance(0b0000n, 0b1111n)).toBe(4);
    expect(hammingDistance(0b1010n, 0b0101n)).toBe(4);
    expect(hammingDistance(0b1100n, 0b1010n)).toBe(2);
  });
  it("hamming_distance_full_64_bits", () => expect(hammingDistance(0xffffffffffffffffn, 0n)).toBe(64));

  it("count_unique_simhash_empty", () => expect(countUniqueSimhash([], 3)).toBe(0));
  it("count_unique_simhash_all_identical", () => expect(countUniqueSimhash(["abc", "abc", "abc"], 3)).toBe(1));
  it("count_unique_simhash_diverse_items", () => {
    expect(countUniqueSimhash(["the cat sat on the mat", "the dog ran in the park", "a fish swam in the sea"], 3)).toBe(3);
  });
  it("count_unique_simhash_threshold_groups_near_dupes", () => expect(countUniqueSimhash(["abc", "abc"], 0)).toBe(1));

  it("bigram_curve_distinct_words", () => expect(computeUniqueBigramCurve(["the cat", "the dog", "a fish"])).toEqual([1, 2, 3]));
  it("bigram_curve_single_word_dedup", () => expect(computeUniqueBigramCurve(["hello", "world", "hello"])).toEqual([1, 2, 2]));
  it("bigram_curve_empty_string_contributes_one", () => expect(computeUniqueBigramCurve(["", "a", "a b"])).toEqual([1, 2, 3]));
  it("bigram_curve_lowercases_for_dedup", () => expect(computeUniqueBigramCurve(["Hello", "hello"])).toEqual([1, 1]));
  it("bigram_curve_cjk_uses_char_bigrams", () => expect(computeUniqueBigramCurve(["数据库连接失败", "数据库连接成功"])).toEqual([6, 8]));
  it("bigram_curve_cjk_single_char_is_unigram", () => expect(computeUniqueBigramCurve(["中", "文"])).toEqual([1, 2]));

  it("find_knee_too_short_is_none", () => {
    expect(findKnee([])).toBeNull();
    expect(findKnee([1])).toBeNull();
    expect(findKnee([1, 2])).toBeNull();
  });
  it("find_knee_flat_curve_returns_one", () => expect(findKnee([5, 5, 5, 5, 5])).toBe(1));
  it("find_knee_concave_curve", () => expect(findKnee([1, 5, 8, 9, 10, 10, 10, 10, 10])).toBe(3));
  it("find_knee_linear_no_clear_knee", () => expect(findKnee([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeNull());

  it("validate_zlib_passthrough_when_k_at_max", () => expect(validateWithZlib(["a", "b", "c"], 3, 10, 0.15)).toBe(3));
  it("validate_zlib_passthrough_when_total_too_small", () => expect(validateWithZlib(Array(5).fill("short"), 2, 100, 0.15)).toBe(2));
  it("validate_zlib_bumps_k_when_subset_undercompresses", () => {
    expect(validateWithZlib(Array(20).fill("the quick brown fox jumps over the lazy dog"), 5, 100, 0.15)).toBe(6);
  });
  it("validate_zlib_passthrough_when_subset_representative", () => {
    const items = range(0, 19).map((i) => `entry id=${i} payload=item value with content for item number ${i}`);
    expect(validateWithZlib(items, 10, 100, 0.15)).toBe(10);
  });

  it("compute_optimal_k_n_le_8_returns_n", () => expect(computeOptimalK(["a", "b", "c", "d", "e"], 1, 3, null)).toBe(5));
  it("compute_optimal_k_low_diversity_returns_unique_count", () => expect(computeOptimalK(Array(10).fill("abc"), 1, 3, null)).toBe(3));
  it("compute_optimal_k_all_unique_keeps_all", () => {
    expect(computeOptimalK(range(0, 19).map((i) => `unique item number ${i} with some long content`), 1, 3, null)).toBe(20);
  });
  it("compute_optimal_k_respects_max_k", () => {
    expect(computeOptimalK(range(0, 19).map((i) => `item ${i}`), 1, 3, 10)).toBeLessThanOrEqual(10);
  });
  it("compute_optimal_k_respects_min_k", () => expect(computeOptimalK(Array(20).fill("abc"), 1, 5, null)).toBe(5));
  it("compute_optimal_k_bias_keeps_more", () => {
    const items = range(0, 29).map((i) => `item content ${i}`);
    const low = computeOptimalK(items, 0.7, 3, null);
    const mid = computeOptimalK(items, 1, 3, null);
    const high = computeOptimalK(items, 1.5, 3, null);
    expect(low).toBeLessThanOrEqual(mid);
    expect(mid).toBeLessThanOrEqual(high);
  });
});

describe("keyword importance in Search context (keyword_detector.rs unit tests)", () => {
  it("fires_on_uppercase_error_in_search", () => expect(searchImportance("ERROR: connection refused")).toBe("error"));
  // Upstream asserts these in Diff context; the error set is context-independent, so they hold in Search too.
  it("timeout_now_classified_as_error", () => expect(searchImportance("FATAL: timeout connecting upstream")).toBe("error"));
  it("rejected_now_classified_as_error", () => expect(searchImportance("auth request rejected")).toBe("error"));
  it("token_no_longer_flags_security", () => expect(searchImportance("input_tokens=512 output_tokens=256")).toBeNull());
  it("security keywords never fire in Search context", () => expect(searchImportance("missing auth header")).toBeNull());
  it("warning_fires_in_search", () => expect(searchImportance("warning: deprecated API")).toBe("warning"));
  it("word_boundary_excludes_substring_matches", () => expect(searchImportance("the panicker showed up late")).toBeNull());
  it("neutral_line_returns_no_category", () => expect(searchImportance("the quick brown fox")).toBeNull());
  // From the Rust lookup order (error+importance automaton before warning); Python's legacy regex list differs here.
  it("importance outranks warning on the same line", () => expect(searchImportance("warning: TODO remove")).toBe("importance"));
});

describe("Headroom Python tests: tests/test_search_compressor.py", () => {
  it("test_parse_standard_grep_format", () => {
    const parsed = parseSearchResults('src/main.py:42:def process_data(items):\nsrc/main.py:43:    """Process items."""\nsrc/utils.py:15:def validate(data):\n');
    expect(parsed.get("src/main.py")!.matches).toHaveLength(2);
    expect(parsed.get("src/utils.py")!.matches).toHaveLength(1);
  });

  it("test_parse_ripgrep_context_format", () => {
    const parsed = parseSearchResults("src/main.py-40-some context before\nsrc/main.py:42:def process_data(items):\nsrc/main.py-43-some context after\n");
    expect(parsed.get("src/main.py")!.matches).toHaveLength(3);
  });

  it("test_parse_with_colons_in_content", () => {
    const parsed = parseSearchResults('src/config.py:10:DATABASE_URL = "postgres://user:pass@host:5432/db"\nsrc/config.py:20:REDIS_URL = "redis://localhost:6379"\n');
    expect(parsed.get("src/config.py")!.matches[0]!.content).toContain("postgres://user:pass@host:5432/db");
  });

  it("test_parse_windows_paths (upstream only asserts no crash; the Rust parser keeps the full path)", () => {
    const parsed = parseSearchResults("C:\\Users\\dev\\src\\main.py:10:def main():\nC:\\Users\\dev\\src\\utils.py:20:def helper():\n");
    expect([...parsed.keys()]).toEqual(["C:\\Users\\dev\\src\\main.py", "C:\\Users\\dev\\src\\utils.py"]);
  });

  it("test_parse_empty_content", () => expect(parseSearchResults("").size).toBe(0));
  it("test_parse_whitespace_only", () => expect(parseSearchResults("   \n\n   \n").size).toBe(0));
  it("test_parse_non_grep_content", () => {
    expect(parseSearchResults("This is just regular text\nwithout any grep-style formatting\njust normal lines here").size).toBe(0);
  });
  it("test_parse_mixed_valid_invalid", () => {
    const parsed = parseSearchResults("src/main.py:10:valid line\nthis is not a grep line\nsrc/utils.py:20:another valid line\nmore random text\n");
    expect([...parsed.keys()]).toEqual(["src/main.py", "src/utils.py"]);
  });

  it("test_matches_grouped_by_file", () => {
    const parsed = parseSearchResults("a.py:1:line 1\nb.py:2:line 2\na.py:3:line 3\nc.py:4:line 4\nb.py:5:line 5\na.py:6:line 6\n");
    expect(parsed.size).toBe(3);
    expect([...parsed.values()].map((group) => group.matches.length)).toEqual([3, 2, 1]);
  });

  it("test_score_context_word_overlap", () => {
    const parsed = parseSearchResults("src/main.py:10:def process_data():\nsrc/main.py:20:def calculate_result():\nsrc/main.py:30:def handle_error():\n");
    scoreMatches(parsed, "error handling");
    const matches = parsed.get("src/main.py")!.matches;
    expect(matches.find((m) => m.content.includes("error"))!.score).toBeGreaterThan(matches.find((m) => m.content.includes("data"))!.score);
  });

  it("test_score_error_patterns_boosted", () => {
    const parsed = parseSearchResults('src/main.py:10:def normal_function():\nsrc/main.py:20:raise ValueError("error occurred")\nsrc/main.py:30:# TODO: fix this\n');
    scoreMatches(parsed, "", { boostErrors: true });
    const matches = parsed.get("src/main.py")!.matches;
    expect(matches.find((m) => m.content.toLowerCase().includes("error"))!.score).toBeGreaterThan(matches.find((m) => m.content.includes("normal"))!.score);
  });

  it("test_score_warning_patterns", () => {
    const parsed = parseSearchResults("src/main.py:10:def normal():\nsrc/main.py:20:# WARNING: deprecated\n");
    scoreMatches(parsed, "");
    const matches = parsed.get("src/main.py")!.matches;
    expect(matches.find((m) => m.content.includes("WARNING"))!.score).toBeGreaterThan(matches.find((m) => m.content.includes("normal"))!.score);
  });

  it("test_score_todo_patterns", () => {
    const parsed = parseSearchResults("src/main.py:10:def normal():\nsrc/main.py:20:# FIXME: this needs work\nsrc/main.py:30:# TODO: implement later\n");
    scoreMatches(parsed, "");
    const matches = parsed.get("src/main.py")!.matches;
    expect(matches.find((m) => m.content.includes("FIXME"))!.score).toBeGreaterThan(matches.find((m) => m.content.includes("normal"))!.score);
  });

  it("test_score_context_keywords_config", () => {
    const parsed = parseSearchResults("src/main.py:10:def auth_handler():\nsrc/main.py:20:def data_processor():\n");
    scoreMatches(parsed, "", { contextKeywords: ["auth", "security"] });
    const matches = parsed.get("src/main.py")!.matches;
    expect(matches.find((m) => m.content.includes("auth"))!.score).toBeGreaterThan(matches.find((m) => m.content.includes("data"))!.score);
  });

  it("test_score_capped_at_one", () => {
    const parsed = parseSearchResults("src/main.py:10:ERROR FATAL exception fail warning TODO FIXME\n");
    scoreMatches(parsed, "error fatal exception");
    expect(parsed.get("src/main.py")!.matches[0]!.score).toBeLessThanOrEqual(1);
  });

  it("test_keeps_first_and_last_by_default", () => {
    const content = range(1, 100).map((i) => `src/file.py:${i}:line ${i}`).join("\n");
    const result = py(content, { alwaysKeepFirst: true, alwaysKeepLast: true, maxMatchesPerFile: 5 });
    expect(result.compressed).toContain("src/file.py:1:line 1");
    expect(result.compressed).toContain("src/file.py:100:line 100");
    expect(result.compressed).toBe([...[1, 2, 3, 4, 100].map((i) => `src/file.py:${i}:line ${i}`), "[... and 95 more matches in src/file.py]", marker(100, 5, content)].join("\n"));
  });

  it("test_respects_max_matches_per_file", () => {
    const content = range(1, 50).map((i) => `src/file.py:${i}:line ${i}`).join("\n");
    const result = py(content, { maxMatchesPerFile: 3, enableCcr: false });
    expect(result.compressed.split("\n").filter((line) => line.startsWith("src/file.py:")).length).toBeLessThanOrEqual(3);
    expect(result.compressed).toBe("src/file.py:1:line 1\nsrc/file.py:2:line 2\nsrc/file.py:50:line 50\n[... and 47 more matches in src/file.py]");
  });

  it("test_respects_max_total_matches", () => {
    const content = range(0, 19).flatMap((f) => range(0, 9).map((i) => `src/file${f}.py:${i}:line content`)).join("\n");
    const result = py(content, { maxTotalMatches: 15, maxFiles: 20, enableCcr: false });
    expect(result.compressed.split("\n").filter((line) => line !== "" && !line.startsWith("[")).length).toBeLessThanOrEqual(15);
    // Budget 15 is the recorded Python golden "twenty_files_ten_lines"; files rank in code-point path order.
    expect(result.compressed).toBe(["src/file0.py", "src/file1.py", "src/file10.py"]
      .flatMap((file) => [...[0, 1, 2, 3, 9].map((i) => `${file}:${i}:line content`), `[... and 5 more matches in ${file}]`]).join("\n"));
  });

  it("test_respects_max_files", () => {
    const content = range(0, 29).map((f) => `src/file${f}.py:1:content`).join("\n");
    const result = py(content, { maxFiles: 5, enableCcr: false });
    expect(result.compressed).toBe(["src/file0.py", "src/file1.py", "src/file10.py", "src/file11.py", "src/file12.py"].map((file) => `${file}:1:content`).join("\n"));
  });

  it("test_high_scoring_files_selected_first", () => {
    const result = py("normal/file.py:1:regular content\nimportant/file.py:1:ERROR critical failure\nanother/file.py:1:some code here\n", { maxFiles: 1, boostErrors: true, enableCcr: false });
    expect(result.compressed).toBe("important/file.py:1:ERROR critical failure");
  });

  it("test_output_sorted_by_line_number", () => {
    const result = py("src/file.py:50:middle line\nsrc/file.py:10:first line\nsrc/file.py:90:last line\n");
    expect(result.compressed).toBe("src/file.py:10:first line\nsrc/file.py:50:middle line\nsrc/file.py:90:last line");
  });

  it("test_small_results_unchanged", () => {
    const content = "src/file.py:1:def foo():\nsrc/file.py:2:    pass";
    const result = py(content);
    expect(result.compressionRatio).toBe(1);
    expect(result.compressed).toBe(content);
  });

  it("test_empty_input_handled", () => {
    const result = py("");
    expect(result.compressed).toBe("");
    expect(result.originalMatchCount).toBe(0);
    expect(result.compressionRatio).toBe(1);
  });

  it("test_compression_adds_summary", () => {
    const result = py(range(1, 50).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { maxMatchesPerFile: 3, enableCcr: false });
    expect(result.compressed).toContain("[... and");
    expect(result.compressed).toContain("more matches");
  });

  it("test_compression_ratio_calculated", () => {
    const content = range(1, 100).map((i) => `src/file.py:${i}:line ${i}`).join("\n");
    const result = py(content, { maxMatchesPerFile: 5, enableCcr: false });
    expect(result.compressionRatio).toBeLessThan(1);
    expect(result.compressionRatio).toBe(Buffer.byteLength(result.compressed) / Buffer.byteLength(content));
  });

  it("test_tokens_saved_estimate", () => {
    const result: SearchCompressionResult = { compressed: "b".repeat(40), original: "a".repeat(400), originalMatchCount: 100, compressedMatchCount: 10, filesAffected: 5, compressionRatio: 0.1, cacheKey: null, summaries: new Map() };
    expect(tokensSavedEstimate(result)).toBe(90);
  });

  it("test_matches_omitted_property", () => {
    const result: SearchCompressionResult = { compressed: "test", original: "original", originalMatchCount: 100, compressedMatchCount: 15, filesAffected: 10, compressionRatio: 0.15, cacheKey: null, summaries: new Map() };
    expect(matchesOmitted(result)).toBe(85);
  });

  it("test_single_match_passthrough", () => {
    const result = py("src/file.py:10:single match");
    expect(result.compressed).toBe("src/file.py:10:single match");
    expect(result.originalMatchCount).toBe(1);
    expect(result.compressedMatchCount).toBe(1);
  });

  it("test_unicode_content", () => {
    const result = py('src/main.py:10:msg = "こんにちは"\nsrc/main.py:20:emoji = "🎉"\nsrc/main.py:30:umlaut = "über"\n');
    expect(result.compressed).toBe('src/main.py:10:msg = "こんにちは"\nsrc/main.py:20:emoji = "🎉"\nsrc/main.py:30:umlaut = "über"');
  });

  it("test_very_long_lines", () => {
    const long = "x".repeat(10000);
    expect(py(`src/file.py:1:${long}`).compressed).toBe(`src/file.py:1:${long}`);
  });

  it("test_many_files_few_matches", () => {
    const result = py(range(0, 99).map((i) => `src/file${i}.py:1:single match`).join("\n"), { maxFiles: 10, enableCcr: false });
    expect(result.filesAffected).toBe(100);
    const files = ["src/file0.py", "src/file1.py", ...range(10, 17).map((i) => `src/file${i}.py`)];
    expect(result.compressed).toBe(files.map((file) => `${file}:1:single match`).join("\n"));
  });

  it("test_special_characters_in_path", () => {
    const result = py("src/my-file.py:10:content\nsrc/my_file.py:20:content\nsrc/my.file.py:30:content\nsrc/file (1).py:40:content\n");
    expect(result.compressed).toBe("src/file (1).py:40:content\nsrc/my-file.py:10:content\nsrc/my.file.py:30:content\nsrc/my_file.py:20:content");
  });

  it("test_line_number_zero", () => expect(py("src/file.py:0:line at position 0").compressed).toContain(":0:"));
  it("test_negative_line_number_skipped", () => expect(parseSearchResults("src/file.py:-1:invalid").size).toBe(0));

  it("test_context_influences_selection", () => {
    const content = [...range(0, 49).map((i) => `src/utils.py:${i}:def helper_${i}():`), "src/auth.py:100:def authenticate_user():", "src/auth.py:200:def validate_token():"].join("\n");
    const result = py(content, { maxTotalMatches: 5, contextKeywords: ["auth", "token", "validate"], enableCcr: false }, "find authentication code");
    expect(result.compressed).toBe([
      "src/auth.py:100:def authenticate_user():", "src/auth.py:200:def validate_token():",
      "src/utils.py:0:def helper_0():", "src/utils.py:1:def helper_1():", "src/utils.py:49:def helper_49():", "[... and 47 more matches in src/utils.py]"
    ].join("\n"));
  });

  it("test_short_context_words_ignored", () => {
    const parsed = parseSearchResults("src/file.py:10:a = 1\nsrc/file.py:20:do something important\n");
    scoreMatches(parsed, "a");
    expect(parsed.get("src/file.py")!.matches.map((m) => m.score)).toEqual([0, Math.fround(0.3)]);
  });

  it("test_output_maintains_grep_format", () => {
    expect(py("src/file.py:10:def foo():\nsrc/file.py:20:def bar():\n").compressed).toBe("src/file.py:10:def foo():\nsrc/file.py:20:def bar():");
  });

  it("test_summaries_track_omitted_per_file", () => {
    const result = py(range(1, 50).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { maxMatchesPerFile: 3, enableCcr: false });
    expect(result.summaries).toEqual(new Map([["src/file.py", "[... and 47 more matches in src/file.py]"]]));
  });

  it("test_files_sorted_in_output", () => {
    expect(py("z_file.py:1:content\na_file.py:1:content\nm_file.py:1:content\n").compressed).toBe("a_file.py:1:content\nm_file.py:1:content\nz_file.py:1:content");
  });

  it("test_disable_keep_first", () => {
    const result = py(range(1, 50).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { alwaysKeepFirst: false, alwaysKeepLast: true, maxMatchesPerFile: 2, enableCcr: false });
    expect(result.compressed).toBe("src/file.py:1:line 1\nsrc/file.py:50:line 50\n[... and 48 more matches in src/file.py]");
  });

  it("test_disable_keep_last", () => {
    const result = py(range(1, 50).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { alwaysKeepFirst: true, alwaysKeepLast: false, maxMatchesPerFile: 2, enableCcr: false });
    expect(result.compressed).toBe("src/file.py:1:line 1\nsrc/file.py:2:line 2\n[... and 48 more matches in src/file.py]");
  });

  it("test_disable_error_boost", () => {
    const parsed = parseSearchResults("src/file.py:1:ERROR critical failure\nsrc/file.py:2:normal code line\n");
    scoreMatches(parsed, "", { boostErrors: false });
    expect(parsed.get("src/file.py")!.matches[0]!.score).toBe(0);
  });

  it("test_min_matches_for_ccr", () => {
    expect(py(range(1, 5).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { minMatchesForCcr: 10, enableCcr: true }).cacheKey).toBeNull();
  });
});

describe("Headroom Python tests: CJK, transforms, text compressors, config exposure, CCR bridge", () => {
  it("test_search_compressor_cjk.py::test_cjk_bigrams_from_runs", () => {
    expect(cjkBigrams("认证令牌")).toEqual(new Set(["认证", "证令", "令牌"]));
    expect(cjkBigrams("hello world").size).toBe(0);
    expect(cjkBigrams("a认b证").size).toBe(0);
  });

  it("test_search_compressor_cjk.py::test_score_matches_cjk_query_bigrams_boost", () => {
    const parsed = parseSearchResults("src/a.py:10:认证令牌已过期需要重新登录\nsrc/b.py:2:plain ascii content here");
    scoreMatches(parsed, "认证令牌缓存淘汰策略", { boostErrors: false, contextKeywords: [] });
    expect(parsed.get("src/a.py")!.matches[0]!.score).toBeGreaterThan(0);
    expect(parsed.get("src/b.py")!.matches[0]!.score).toBe(0);
  });

  it("test_transforms_search_compressor.py::test_parse_score_select_and_format_search_results", () => {
    const config = { maxMatchesPerFile: 3, maxTotalMatches: 4, maxFiles: 2, contextKeywords: ["auth"] };
    const parsed = parseSearchResults(["src/auth.py:10:ERROR auth failed", "src/auth.py-11-warning auth retry", "src/auth.py:12:plain auth line", "src/db.py:2:warning token expired", "not a match"].join("\n"));
    expect(new Set(parsed.keys())).toEqual(new Set(["src/auth.py", "src/db.py"]));
    expect(parsed.get("src/auth.py")!.matches[0]).toEqual(match("src/auth.py", 10, "ERROR auth failed"));
    expect(parsed.get("src/auth.py")!.matches.at(-1)!.lineNumber).toBe(12n);

    scoreMatches(parsed, "find auth error", config);
    expect(parsed.get("src/auth.py")!.matches[0]!.score).toBe(1);
    expect(parsed.get("src/db.py")!.matches[0]!.score).toBeGreaterThan(0);

    // Upstream monkeypatches compute_optimal_k to 4; with four items the real sizer returns 4 as well.
    const selected = selectMatches(parsed, 1.2, config);
    expect([...selected.keys()]).toEqual(["src/auth.py", "src/db.py"]);
    expect(selected.get("src/auth.py")!.matches.map((m) => m.lineNumber)).toEqual([10n, 11n, 12n]);

    const original: FileMatchMap = new Map([...parsed, ["src/db.py", { file: "src/db.py", matches: [match("src/db.py", 2, "warning token expired"), match("src/db.py", 3, "another line")] }]]);
    const { output, summaries } = formatOutput(selected, original, config);
    expect(output).toContain("src/auth.py:10:ERROR auth failed");
    expect(summaries.get("src/db.py")).toBe("[... and 1 more matches in src/db.py]");
  });

  it("test_transforms_search_compressor.py::test_search_compressor_compress_paths_and_ccr", () => {
    const config = { enableCcr: true, minMatchesForCcr: 2, contextKeywords: ["auth"] };
    const noMatch = py("plain text only", config);
    expect(noMatch.originalMatchCount).toBe(0);
    expect(noMatch.compressed).toBe("plain text only");

    const content = [...range(1, 50).map((i) => `src/auth.py:${i}:auth event ${i}`), ...range(1, 30).map((i) => `src/db.py:${i}:db query ${i}`)].join("\n");
    const result = py(content, config, "auth", 0.5);
    expect(result.originalMatchCount).toBe(80);
    expect(result.filesAffected).toBe(2);
    expect(result.compressedMatchCount).toBeLessThan(result.originalMatchCount);
    expect(result.cacheKey).not.toBeNull();
    expect(result.compressed.endsWith(`. Retrieve more: hash=${result.cacheKey}]`)).toBe(true);
    expect(result.summaries.size).toBeGreaterThanOrEqual(1);
    // Budget 30 is the recorded Python golden "auth_db_bias_half".
    expect(result.compressed).toBe([
      ...[1, 2, 3, 4, 50].map((i) => `src/auth.py:${i}:auth event ${i}`), "[... and 45 more matches in src/auth.py]",
      ...[1, 2, 3, 4, 30].map((i) => `src/db.py:${i}:db query ${i}`), "[... and 25 more matches in src/db.py]",
      marker(80, 10, content)
    ].join("\n"));
  });

  it("test_transforms_search_compressor.py::test_search_compression_result_properties", () => {
    const result: SearchCompressionResult = { compressed: "tiny", original: "this is a much longer original string", originalMatchCount: 10, compressedMatchCount: 4, filesAffected: 2, compressionRatio: 0.3, cacheKey: null, summaries: new Map() };
    expect(tokensSavedEstimate(result)).toBeGreaterThan(0);
    expect(matchesOmitted(result)).toBe(6);
  });

  it("test_text_compressors.py::test_compress_search_results", () => {
    const content = range(0, 99).map((i) => `src/file${i}.py:${i * 10}:def function_${i}():`).join("\n");
    const result = py(content, {}, "find function_50");
    expect(result.originalMatchCount).toBe(100);
    expect(result.compressedMatchCount).toBeLessThan(100);
    expect(result.compressed).toContain("function_");
    // file50 ranks first (query word), 14 more in code-point order; budget 15 is the golden "hundred_files_function_query".
    const kept = [0, 1, ...range(10, 19), 2, 20, 50];
    expect(result.compressed).toBe([...kept.map((i) => `src/file${i}.py:${i * 10}:def function_${i}():`), marker(100, 15, content)].join("\n"));
  });

  it("test_text_compressors.py::test_keeps_first_and_last", () => {
    const result = py(range(1, 100).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { alwaysKeepFirst: true, alwaysKeepLast: true });
    expect(result.compressed).toContain("src/file.py:1:line 1");
    expect(result.compressed).toContain("src/file.py:100:line 100");
  });

  it("test_text_compressors.py::test_prioritizes_errors", () => {
    const content = [...range(1, 49).map((i) => `src/file.py:${i}:normal line`), "src/file.py:50:ERROR: something failed", ...range(51, 99).map((i) => `src/file.py:${i}:normal line`)].join("\n");
    const result = py(content);
    expect(result.compressed).toContain("ERROR: something failed");
    expect(result.compressed).toBe([
      "src/file.py:1:normal line", "src/file.py:2:normal line", "src/file.py:3:normal line", "src/file.py:50:ERROR: something failed",
      "src/file.py:99:normal line", "[... and 94 more matches in src/file.py]", marker(99, 5, content)
    ].join("\n"));
  });

  it("test_text_compressors.py::test_small_results_unchanged", () => {
    const content = "src/file.py:1:def foo():\nsrc/file.py:2:    pass";
    const result = py(content);
    expect(result.compressionRatio).toBe(1);
    expect(result.compressed).toBe(content);
  });

  const groupedInput = ["src/very/long/path/to/module.py:10:def alpha():", "src/very/long/path/to/module.py:20:def beta():", "src/very/long/path/to/module.py:30:def gamma():", "src/other.py:5:class Other:"].join("\n");

  it("test_compressor_config_exposure.py::test_standard_format_default", () => {
    const result = py(groupedInput);
    expect(result.compressed).toContain("src/very/long/path/to/module.py:10:");
    expect(result.compressed).toBe("src/other.py:5:class Other:\nsrc/very/long/path/to/module.py:10:def alpha():\nsrc/very/long/path/to/module.py:20:def beta():\nsrc/very/long/path/to/module.py:30:def gamma():");
  });

  it("test_compressor_config_exposure.py::test_grouped_format", () => {
    const result = py(groupedInput, { groupByFile: true });
    const lines = result.compressed.split("\n");
    expect(lines).toContain("src/very/long/path/to/module.py");
    expect(lines).toContain("10:def alpha():");
    expect(lines.some((line) => line.startsWith("src/very/long/path/to/module.py:10:"))).toBe(false);
    expect(result.compressed).toBe("src/other.py\n5:class Other:\n\nsrc/very/long/path/to/module.py\n10:def alpha():\n20:def beta():\n30:def gamma():");
  });

  it("test_compressor_config_exposure.py::test_grouped_is_smaller", () => {
    expect(py(groupedInput, { groupByFile: true }).compressed.length).toBeLessThan(py(groupedInput).compressed.length);
  });

  it("test_compressor_config_exposure.py::test_grouped_deterministic", () => {
    expect(py(groupedInput, { groupByFile: true }).compressed).toBe(py(groupedInput, { groupByFile: true }).compressed);
  });

  it("grouped summaries drop the path (search_compressor.rs format_output)", () => {
    const result = py(range(1, 50).map((i) => `src/file.py:${i}:line ${i}`).join("\n"), { maxMatchesPerFile: 2, groupByFile: true, enableCcr: false });
    expect(result.compressed).toBe("src/file.py\n1:line 1\n50:line 50\n[... and 48 more matches]");
  });

  it("test_ccr_rust_marker_hash_bridge.py: the marker key is MD5(original)[:24] and the store holds the original under it", () => {
    const original = "src/app.py:12: def handle_request(payload):\n".repeat(40);
    const store = new MemoryStore();
    const { result } = compressSearchResults(original, "", 1, {}, store);
    expect(result.cacheKey).toBe(ccrKey(original));
    expect(store.entries.get(ccrKey(original))).toBe(original);
    expect(result.compressed).toBe(`src/app.py:12: def handle_request(payload):\n[... and 39 more matches in src/app.py]\n${marker(40, 1, original)}`);
  });
});

interface SizerGolden { name: string; source: string; items: string[]; bias: number; min_k: number; max_k: number; expected_k: number }
const goldens = (JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "headroom-parity", "search_compressor", "adaptive_k.json"), "utf8")) as { scenarios: SizerGolden[] }).scenarios;

describe("adaptive sizer goldens recorded from Headroom's Python adaptive_sizer", () => {
  it("has the recorded scenarios", () => expect(goldens.length).toBe(16));
  for (const golden of goldens) {
    it(`${golden.name} -> k=${golden.expected_k}`, () => {
      expect(computeOptimalK(golden.items, golden.bias, golden.min_k, golden.max_k)).toBe(golden.expected_k);
    });
  }
});

describe("live zone dispatch (live_zone.rs: empty query, bias 0.0, no CCR store)", () => {
  it("compresses Headroom's router _SEARCH block to the sizer budget", () => {
    const text = range(0, 29).map((i) => `src/file${i}.py:${i}: def func${i}(): return ${i}`).join("\n");
    const { result, stats } = compressSearchResults(text, "", 0);
    // Budget 6 is the recorded Python golden "router_search_block_live_zone".
    expect(result.compressed).toBe([0, 1, 10, 11, 12, 13].map((i) => `src/file${i}.py:${i}: def func${i}(): return ${i}`).join("\n"));
    expect(stats).toMatchObject({ filesDropped: 15, matchesDroppedByGlobalCap: 9, ccrEmitted: false, ccrSkipReason: "no store provided" });
    expect(compressSearchForLiveZone(text)).toBe(result.compressed);
  });

  it("returns null when nothing changes", () => {
    expect(compressSearchForLiveZone("src/file.py:1:def foo():\nsrc/file.py:2:    pass")).toBeNull();
    expect(compressSearchForLiveZone("plain text only")).toBeNull();
  });
});

describe("Rust str semantics the port must keep", () => {
  it("orders paths by code point like a Rust BTreeMap, not by UTF-16 unit", () => {
    const parsed = parseSearchResults("src/\u{1F600}.py:1:emoji\nsrc/\u{FF5E}.py:1:fullwidth tilde");
    expect([...parsed.keys()]).toEqual(["src/\u{FF5E}.py", "src/\u{1F600}.py"]);
  });

  it("trims Unicode White_Space (U+0085 yes, U+FEFF no) before parsing", () => {
    expect([...parseSearchResults("\u0085src/a.py:1:x\u0085").keys()]).toEqual(["src/a.py"]);
    expect([...parseSearchResults("\uFEFFsrc/a.py:1:x").keys()]).toEqual(["\uFEFFsrc/a.py"]);
  });

  it("keeps u64 line numbers exact and rejects overflow", () => {
    expect(parseMatchLine("trace.log:18446744073709551615:max")).toEqual(["trace.log", 18446744073709551615n, "max"]);
    expect(parseMatchLine("trace.log:18446744073709551616:overflow")).toBeNull();
    expect(parseMatchLine("a.py:007:x")).toEqual(["a.py", 7n, "x"]);
  });

  it("lowercases only ASCII for query matching", () => {
    const parsed = parseSearchResults("a.py:1:ÉCOLE\nb.py:1:école");
    scoreMatches(parsed, "ÉCOLE", { boostErrors: false });
    expect(parsed.get("a.py")!.matches[0]!.score).toBe(Math.fround(0.3));
    expect(parsed.get("b.py")!.matches[0]!.score).toBe(0);
  });
});
