import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  cjkBigrams,
  compressDiff,
  compressDiffWithStats,
  detectDiff,
  isDiff,
  md5Hex24,
  SCORE_CHANGE_DENSITY_CAP,
  SCORE_CHANGE_DENSITY_WEIGHT,
  SCORE_CONTEXT_MIN_WORD_LEN,
  SCORE_CONTEXT_WORD_WEIGHT,
  SCORE_PRIORITY_PATTERN_BOOST,
  SCORE_TOTAL_CAP,
  type DiffCompressionResult,
  type DiffCompressorConfig
} from "../src/compression/diff-compressor/index.js";
import { formatRustFixed, rustLines, splitRustWhitespace } from "../src/compression/diff-compressor/rust-compat.js";

interface Fixture {
  transform: string;
  input: string;
  config: Partial<DiffCompressorConfig>;
  output: DiffCompressionResult;
}

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "diff_compressor");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).sort().map((name) => ({
  name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as Fixture)
}));

describe("diff compressor (Headroom 0.37 parity fixtures)", () => {
  it("has the upstream fixtures", () => {
    expect(fixtures.length).toBe(27);
    for (const fixture of fixtures) expect(fixture.transform).toBe("diff_compressor");
  });

  for (const fixture of fixtures) {
    it(`matches ${fixture.name}`, () => {
      // The recorder calls `DiffCompressor(config).compress(input)` with the default empty context.
      const result = compressDiff(fixture.input, "", fixture.config);
      expect(Object.keys(result).sort()).toEqual(Object.keys(fixture.output).sort());
      for (const [field, expected] of Object.entries(fixture.output)) {
        const actual = result[field as keyof DiffCompressionResult];
        if (typeof expected === "number" && !Number.isInteger(expected)) expect(actual).toBeCloseTo(expected, 12);
        else expect(actual, field).toStrictEqual(expected);
      }
    });
  }
});

// ─── Ports of the upstream Rust unit tests ─────────────────────────────────

const lowThreshold = { min_lines_for_ccr: 5 };

function syntheticDiff(files: number): string {
  let text = "";
  for (let file = 0; file < files; file += 1) {
    text += `diff --git a/file_${file}.py b/file_${file}.py\n--- a/file_${file}.py\n+++ b/file_${file}.py\n@@ -1,10 +1,12 @@\n`;
    for (let k = 0; k < 5; k += 1) text += ` context_${k}_${file}\n`;
    for (let k = 0; k < 3; k += 1) text += `-removed_${k}_${file}\n`;
    for (let k = 0; k < 5; k += 1) text += `+added_${k}_${file}\n`;
    for (let k = 0; k < 5; k += 1) text += ` tail_${k}_${file}\n`;
  }
  return `${text}# variant 1`;
}

function hunkDiff(hunks: number): string {
  let text = "diff --git a/big.py b/big.py\n--- a/big.py\n+++ b/big.py\n";
  for (let hunk = 0; hunk < hunks; hunk += 1) {
    const start = hunk * 100 + 1;
    text += `@@ -${start},6 +${start},6 @@\n ctx_a_${hunk}\n ctx_b_${hunk}\n-old_${hunk}\n+new_${hunk}\n ctx_c_${hunk}\n ctx_d_${hunk}\n`;
  }
  return text;
}

describe("diff compressor behaviour", () => {
  it("passes short input through", () => {
    const input = "diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b";
    expect(compressDiff(input)).toEqual({
      compressed: input, original_line_count: 4, compressed_line_count: 4, files_affected: 0,
      additions: 0, deletions: 0, hunks_kept: 0, hunks_removed: 0, cache_key: null
    });
  });

  it("passes non-diff input through", () => {
    const input = "this is not a diff\n".repeat(60);
    const result = compressDiff(input);
    expect(result.compressed).toBe(input);
    expect(result.files_affected).toBe(0);
  });

  it("hashes like hashlib.md5(...).hexdigest()[:24]", () => {
    expect(md5Hex24("hello")).toBe("5d41402abc4b2a76b9719d91");
    expect(md5Hex24("")).toBe("d41d8cd98f00b204e9800998");
  });

  it("reports pass-through stats", () => {
    const { stats } = compressDiffWithStats("noise\n".repeat(60));
    expect(stats.input_lines).toBe(61);
    expect(stats.output_lines).toBe(61);
    expect(stats.compression_ratio).toBe(1);
    expect(stats.parse_warnings).toEqual([]);
    expect(stats.ccr_skipped_reason).toBe("no diff sections parsed");
  });

  it("compresses the synthetic eight-file diff to the known shape", () => {
    const result = compressDiff(syntheticDiff(8));
    expect(result).toMatchObject({ original_line_count: 177, compressed_line_count: 129, files_affected: 8, additions: 40, deletions: 24, hunks_kept: 8, hunks_removed: 0 });
    expect(result.cache_key).not.toBeNull();
    expect(result.compressed.endsWith(`\n[177 lines compressed to 129. Retrieve full diff: hash=${result.cache_key}]`)).toBe(true);
  });

  it("caps hunks per file and records the drops", () => {
    const { result, stats } = compressDiffWithStats(hunkDiff(15), "", { max_hunks_per_file: 10 });
    expect(result.hunks_kept).toBe(10);
    expect(result.hunks_removed).toBe(5);
    expect(stats.hunks_total).toBe(15);
    expect(stats.hunks_dropped).toBe(5);
    expect(stats.hunks_dropped_per_file).toEqual({ "--- a/big.py -> +++ b/big.py": 5 });
    expect(stats.largest_hunk_dropped_lines).toBe(6);
    expect(result.compressed).toContain("[1 files changed, +15 -15 lines, 5 hunks omitted]");
    // First and last always survive; equal-score middle hunks keep their original order.
    const kept = [...result.compressed.matchAll(/^@@ -(\d+),6/gm)].map((match) => Number(match[1]));
    expect(kept).toEqual([1, 101, 201, 301, 401, 501, 601, 701, 801, 1401]);
  });

  it("caps files and records the dropped labels", () => {
    const { stats } = compressDiffWithStats(syntheticDiff(25), "", { max_files: 20 });
    expect(stats.files_total).toBe(25);
    expect(stats.files_kept).toBe(20);
    expect(stats.files_dropped).toHaveLength(5);
    for (const label of stats.files_dropped) expect(label).toContain(" -> ");
  });

  it("records file mode normalization of the executable bit", () => {
    const input = `diff --git a/script.sh b/script.sh\nnew file mode 100755\n--- /dev/null\n+++ b/script.sh\n@@ -0,0 +1,3 @@\n+#!/bin/sh\n+echo hi\n+exit 0\n${"# pad\n".repeat(50)}`;
    const { result, stats } = compressDiffWithStats(input);
    expect(stats.file_mode_normalizations).toEqual([["--- /dev/null -> +++ b/script.sh", "new file mode 100755"]]);
    expect(result.compressed).toContain("new file mode 100644");
  });

  it("records binary file simplification", () => {
    const input = `diff --git a/img.png b/img.png\nBinary files a/img.png and b/img.png differ\n${"# pad\n".repeat(60)}`;
    const { result, stats } = compressDiffWithStats(input);
    expect(stats.binary_files_simplified).toEqual(["Binary files a/img.png and b/img.png differ"]);
    expect(result.compressed.split("\n").slice(0, 2)).toEqual(["diff --git a/img.png b/img.png", "Binary files differ"]);
  });

  it("makes the CCR savings threshold configurable", () => {
    expect(compressDiff(syntheticDiff(8)).cache_key).not.toBeNull();
    const { result, stats } = compressDiffWithStats(syntheticDiff(8), "", { min_compression_ratio_for_ccr: 0.5 });
    expect(result.cache_key).toBeNull();
    expect(stats.cache_key_emitted).toBe(false);
    expect(stats.ccr_skipped_reason).toBe("compression ratio 0.729 above threshold 0.500");
    expect(compressDiffWithStats(syntheticDiff(8), "", { enable_ccr: false }).stats.ccr_skipped_reason).toBe("ccr disabled");
  });

  it("stores the original under the emitted cache key", () => {
    const stored = new Map<string, string>();
    const input = syntheticDiff(8);
    const { result, stats } = compressDiffWithStats(input, "", {}, { put: (hash, payload) => void stored.set(hash, payload) });
    expect(stats.cache_key_emitted).toBe(true);
    expect(result.cache_key).not.toBeNull();
    expect(result.compressed).toContain(`hash=${result.cache_key}`);
    expect(stored.get(result.cache_key!)).toBe(input);
    expect(result).toEqual(compressDiff(input));
  });

  it("does not store when CCR is skipped", () => {
    const stored = new Map<string, string>();
    const { result } = compressDiffWithStats(syntheticDiff(8), "", { min_compression_ratio_for_ccr: 0.1 }, { put: (hash, payload) => void stored.set(hash, payload) });
    expect(result.cache_key).toBeNull();
    expect(stored.size).toBe(0);
  });

  it("pins the score constants", () => {
    expect([SCORE_CHANGE_DENSITY_WEIGHT, SCORE_CHANGE_DENSITY_CAP, SCORE_CONTEXT_WORD_WEIGHT, SCORE_CONTEXT_MIN_WORD_LEN, SCORE_PRIORITY_PATTERN_BOOST, SCORE_TOTAL_CAP])
      .toEqual([0.03, 0.3, 0.2, 2, 0.3, 1]);
  });

  it("preserves rename markers after the diff header", () => {
    const input = "diff --git a/old.py b/new.py\nsimilarity index 92%\nrename from old.py\nrename to new.py\n--- a/old.py\n+++ b/new.py\n@@ -1,3 +1,3 @@\n ctx_a\n-old_line\n+new_line\n ctx_b\n";
    const lines = compressDiff(input, "", lowThreshold).compressed.split("\n");
    expect(lines.slice(0, 4)).toEqual(["diff --git a/old.py b/new.py", "similarity index 92%", "rename from old.py", "rename to new.py"]);
  });

  it("builds CJK bigrams from query runs", () => {
    expect([...cjkBigrams("数据库连接")].sort()).toEqual(["库连", "据库", "数据", "连接"].sort());
    expect(cjkBigrams("hello world").size).toBe(0);
    expect(cjkBigrams("a数b据").size).toBe(0);
  });

  it("lets a CJK query boost the overlapping hunk into the kept set", () => {
    const input = "diff --git a/svc.py b/svc.py\n--- a/svc.py\n+++ b/svc.py\n@@ -1,2 +1,2 @@\n-first_old\n+first_new\n@@ -10,4 +10,4 @@\n-plain_a\n+plain_b\n-plain_c\n+plain_d\n@@ -20,2 +20,2 @@\n-数据库连接失败重试\n+数据库连接成功\n@@ -30,2 +30,2 @@\n-last_old\n+last_new\n";
    const config = { max_hunks_per_file: 3, min_lines_for_ccr: 5 };
    expect(compressDiff(input, "数据库连接超时排查", config).compressed).toContain("数据库连接失败重试");
    expect(compressDiff(input, "", config).compressed).not.toContain("数据库连接失败重试");
  });

  it("ranks hunks by query words and priority keywords", () => {
    const input = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1,2 +1,2 @@\n-a\n+b\n@@ -10,2 +10,2 @@\n-plain one\n+plain two\n@@ -20,2 +20,2 @@\n-retry budget\n+retry budget doubled\n@@ -30,2 +30,2 @@\n-x\n+y\n";
    expect(compressDiff(input, "Retry", { max_hunks_per_file: 3, min_lines_for_ccr: 5 }).compressed).toContain("retry budget doubled");
    // Two-byte words are ignored; multi-byte words count by UTF-8 length like Rust `str::len`.
    expect(compressDiff(input, "re", { max_hunks_per_file: 3, min_lines_for_ccr: 5 }).compressed).toContain("plain two");
    const keyword = input.replace("retry budget doubled", "raise Error('boom')");
    expect(compressDiff(keyword, "", { max_hunks_per_file: 3, min_lines_for_ccr: 5 }).compressed).toContain("raise Error('boom')");
    // Unicode word boundaries: a letter before the keyword is not a boundary (Rust `\b`).
    const glued = input.replace("retry budget doubled", "éerror");
    expect(compressDiff(glued, "", { max_hunks_per_file: 3, min_lines_for_ccr: 5 }).compressed).not.toContain("éerror");
  });

  it("parses and emits combined-diff (@@@) hunks", () => {
    const input = "diff --git a/merge.py b/merge.py\n--- a/merge.py\n+++ b/merge.py\n@@@ -1,3 -1,3 +1,4 @@@\n  unchanged_a\n -old_branch_1\n- old_branch_2\n++new_in_merge\n +new_added\n  unchanged_b\n";
    const { result, stats } = compressDiffWithStats(input, "", lowThreshold);
    expect(result.compressed).toContain("@@@ -1,3 -1,3 +1,4 @@@");
    expect(result.compressed).toContain("++new_in_merge");
    expect(stats.files_total).toBe(1);
  });

  it("keeps the no-newline marker regardless of distance from a change", () => {
    const input = "diff --git a/last.txt b/last.txt\n--- a/last.txt\n+++ b/last.txt\n@@ -1,8 +1,8 @@\n-old_first\n+new_first\n ctx_a\n ctx_b\n ctx_c\n ctx_d\n ctx_e\n ctx_f\n\\ No newline at end of file\n";
    const result = compressDiff(input, "", lowThreshold);
    expect(result.compressed).toContain("\\ No newline at end of file");
    expect(result.compressed).not.toContain("ctx_c");
  });

  it("starts a file at diff --combined and diff --cc headers", () => {
    const combined = "diff --combined merge.py\nindex abc..def..ghi 100644\n--- a/merge.py\n+++ b/merge.py\n@@@ -1,3 -1,3 +1,4 @@@\n  ctx_a\n- removed_p1\n -removed_p2\n++added_in_merge\n  ctx_b\n";
    const combinedResult = compressDiff(combined, "", lowThreshold);
    expect(combinedResult.files_affected).toBe(1);
    expect(combinedResult.compressed).toContain("diff --combined merge.py");
    expect(combinedResult.compressed).toContain("++added_in_merge");
    const cc = "diff --cc cc_target.py\nindex abc..def..ghi\n--- a/cc_target.py\n+++ b/cc_target.py\n@@@ -1,3 -1,3 +1,4 @@@\n  ctx\n- p1_removed\n -p2_removed\n++merge_added\n  more_ctx\n";
    const ccResult = compressDiff(cc, "", lowThreshold);
    expect(ccResult.files_affected).toBe(1);
    expect(ccResult.compressed).toContain("diff --cc cc_target.py");
    expect(ccResult.compressed).toContain("++merge_added");
  });

  it("preserves pre-diff commit content", () => {
    const input = "commit abc1234567890\nAuthor: Tester <t@example.com>\nDate:   Mon Apr 25 12:00:00 2026\n\n    Refactor: rename and modify\n\ndiff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n";
    const result = compressDiff(input, "", lowThreshold);
    expect(result.compressed.startsWith("commit abc1234567890\nAuthor: Tester")).toBe(true);
    expect(result.compressed).toContain("    Refactor: rename and modify");
    expect(result.compressed).toContain("diff --git a/x.py b/x.py");
  });

  it("rejects config values Rust's usize would not accept", () => {
    expect(() => compressDiff("x", "", { max_files: -1 })).toThrow(RangeError);
    expect(() => compressDiff("x", "", { max_context_lines: 1.5 })).toThrow(RangeError);
  });
});

describe("Rust semantics helpers", () => {
  it("formats like Rust {:.N} (ties to even, signed zero)", () => {
    expect([0.0625, 0.0005, 0.0015, 0.0025, 0.8, 2.5e-4, -0, 0.1235, 0.0035, 1 / 3].map((value) => formatRustFixed(value, 3)))
      .toEqual(["0.062", "0.001", "0.002", "0.003", "0.800", "0.000", "-0.000", "0.123", "0.004", "0.333"]);
    expect([Number.NaN, Infinity, -Infinity].map((value) => formatRustFixed(value, 3))).toEqual(["NaN", "inf", "-inf"]);
  });

  it("splits lines like Rust str::lines", () => {
    expect(rustLines("")).toEqual([]);
    expect(rustLines("a\r\nb\rc\r")).toEqual(["a", "b\rc\r"]);
    expect(rustLines("a\r\n\r\n")).toEqual(["a", ""]);
    expect(rustLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("splits whitespace like Rust str::split_whitespace", () => {
    expect(splitRustWhitespace("x\u0085y\ufeffz\u00a0 w\u3000v ")).toEqual(["x", "y\ufeffz", "w", "v"]);
  });
});

// ─── Ports of the upstream unidiff detector tests ──────────────────────────

describe("unidiff detector", () => {
  it("rejects empty input, prose, JSON, code, HTML and YAML", () => {
    for (const text of ["", "The quick brown fox jumps over the lazy dog. This is just regular English prose.", '{"name": "Alice", "tags": ["a", "b", "c"]}',
      "def foo():\n    return 42\n\nclass Bar:\n    pass\n", "<!DOCTYPE html><html><body><h1>Hi</h1></body></html>", "name: my-app\nversion: 1.0\ndependencies:\n  - foo\n", "not a diff", "{}"]) {
      expect(isDiff(text)).toBe(false);
      expect(detectDiff(text)).toBeNull();
    }
  });

  it("rejects shell xtrace and orphaned target headers without throwing", () => {
    expect(isDiff("+++ test.sh")).toBe(false);
    expect(isDiff("+ set -euo pipefail\n+++ dirname test.sh\n++ cd scripts/..\n")).toBe(false);
    expect(isDiff("+++ x")).toBe(false);
    expect(isDiff("some prose\n+++ target without a source\nmore")).toBe(false);
  });

  it("detects git, naked, multi-file, added-file and removed-file diffs", () => {
    const standard = "diff --git a/foo.py b/foo.py\nindex abc123..def456 100644\n--- a/foo.py\n+++ b/foo.py\n@@ -1,3 +1,4 @@\n def hello():\n+    print(\"new\")\n     return \"world\"\n-    # gone\n";
    expect(isDiff(standard)).toBe(true);
    expect(detectDiff(standard)).toBe("diff");
    expect(isDiff("--- a/foo.py\n+++ b/foo.py\n@@ -1,2 +1,2 @@\n-old line\n+new line\n context\n")).toBe(true);
    expect(isDiff("--- a/foo.py\n+++ b/foo.py\n@@ -1,1 +1,1 @@\n-old\n+new\n--- a/bar.py\n+++ b/bar.py\n@@ -1,1 +1,1 @@\n-gone\n+here\n")).toBe(true);
    expect(isDiff("diff --git a/new.py b/new.py\nnew file mode 100644\nindex 0000000..9b710f3\n--- /dev/null\n+++ b/new.py\n@@ -0,0 +1,3 @@\n+line one\n+line two\n+line three\n")).toBe(true);
    expect(isDiff("diff --git a/gone.py b/gone.py\ndeleted file mode 100644\nindex 9b710f3..0000000\n--- a/gone.py\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-line one\n-line two\n")).toBe(true);
  });

  it("rejects an empty patch set", () => {
    expect(isDiff("Some prose mentioning @@ in passing.\nAnd maybe even --- a sentence with dashes.\n")).toBe(false);
  });

  it("models unidiff parse errors and panics as not-a-diff", () => {
    const valid = "--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n";
    expect(isDiff(valid)).toBe(true);
    // A removed line rendered as `--- x` inside a hunk is consumed by the hunk, not read as a header.
    expect(isDiff("--- a/f\n+++ b/f\n@@ -1,2 +1 @@\n--- x\n-y\n+z\n@@ -9 +9 @@\n-q\n+r\n")).toBe(true);
    // Error::UnexpectedHunk: a hunk after a new source header without its target header.
    expect(isDiff(`${valid}--- a/g\n@@ -1 +1 @@\n-a\n+b\n`)).toBe(false);
    // Error::TargetWithoutSource: a second target header for the same file.
    expect(isDiff(`${valid}+++ b/again\n`)).toBe(false);
    // Panic: a later hunk number that is a non-ASCII digit or overflows usize.
    expect(isDiff(`--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -\u0663 +3 @@\n-a\n+b\n`)).toBe(false);
    expect(isDiff(`--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -18446744073709551616 +3 @@\n-a\n+b\n`)).toBe(false);
    expect(isDiff(`--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n@@ -18446744073709551615,2 +3 @@\n-a\n+b\n`)).toBe(true);
  });
});
