import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeOptimalK, computeUniqueBigramCurve, countUniqueSimhash, findKnee, validateWithZlib } from "../src/compression/log-compressor/adaptive-sizer.js";
import { compressLog, DEFAULT_LOG_COMPRESSOR_CONFIG, detectLogFormat, parseLogLines, type LogCompressorConfig } from "../src/compression/log-compressor/index.js";

interface FixtureOutput {
  cache_key: string | null;
  compressed: string;
  compressed_line_count: number;
  compression_ratio: number;
  format_detected: string;
  original: string;
  original_line_count: number;
  stats: Record<string, number>;
}

const directory = join(import.meta.dirname, "fixtures", "headroom-parity", "log_compressor");
const fixtures = readdirSync(directory).filter((name) => name.endsWith(".json")).map((name) => ({
  name, ...(JSON.parse(readFileSync(join(directory, name), "utf8")) as { input: string; config: Record<string, unknown>; output: FixtureOutput })
}));

/** Fixture configs use Headroom's snake_case field names. */
function toConfig(raw: Record<string, unknown>): Partial<LogCompressorConfig> {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (!(camel in DEFAULT_LOG_COMPRESSOR_CONFIG)) throw new Error(`unknown fixture config key ${key}`);
    config[camel] = value;
  }
  return config as Partial<LogCompressorConfig>;
}

describe("log compressor (Headroom 0.37 parity fixtures)", () => {
  it("has the upstream fixtures", () => expect(fixtures.length).toBe(20));
  for (const fixture of fixtures) {
    it(`matches ${fixture.name}`, () => {
      const result = compressLog(fixture.input, { config: toConfig(fixture.config) });
      const expected = fixture.output;
      expect(result.compressed).toBe(expected.compressed);
      expect(result.original).toBe(expected.original);
      expect(result.originalLineCount).toBe(expected.original_line_count);
      expect(result.compressedLineCount).toBe(expected.compressed_line_count);
      expect(result.formatDetected).toBe(expected.format_detected);
      expect(result.compressionRatio).toBeCloseTo(expected.compression_ratio, 12);
      expect(result.cacheKey).toBe(expected.cache_key);
      expect(result.stats).toEqual(expected.stats);
    });
  }
});

/** Behaviour the fixtures do not reach, ported from the upstream Rust unit tests. */
describe("log compressor (upstream unit behaviour)", () => {
  const flags = (lines: string[]) => parseLogLines(lines, { ...DEFAULT_LOG_COMPRESSOR_CONFIG }).map((line) => line.isStackTrace);

  it("detects formats", () => {
    expect(detectLogFormat(["============================= test session starts =============================", "collected 15 items", "tests/test_foo.py::test_basic PASSED [  6%]", "FAILED tests/test_foo.py::test_edge"])).toBe("pytest");
    expect(detectLogFormat(["npm WARN deprecated x", "npm ERR! something"])).toBe("npm");
    expect(detectLogFormat(["   Compiling app v0.1.0", "warning: unused variable"])).toBe("cargo");
    expect(detectLogFormat(["PASS src/app.test.js", "Test Suites: 1 failed"])).toBe("jest");
    expect(detectLogFormat(["make[1]: Entering directory", "gcc -c main.c"])).toBe("make");
    expect(detectLogFormat(["INFO Starting application", "DEBUG Initializing"])).toBe("generic");
  });

  it("classifies levels on whole words only, leftmost first", () => {
    const levels = (lines: string[]) => parseLogLines(lines, { ...DEFAULT_LOG_COMPRESSOR_CONFIG }).map((line) => line.level);
    expect(levels(["ERROR: critical", "warning: x", "INFO: x", "no level here"])).toEqual(["error", "warn", "info", "unknown"]);
    expect(levels(["informant arrested", "errorless code", "warned-off"])).toEqual(["unknown", "unknown", "unknown"]);
    expect(levels(["INFO: task failed"])).toEqual(["info"]);
  });

  it("keeps chained Python tracebacks together across blank lines", () => {
    expect(flags(["Traceback (most recent call last):", '  File "a.py", line 1, in <module>', "ValueError: x", "", "During handling of the above exception, another exception occurred:", "", "Traceback (most recent call last):", '  File "b.py", line 2, in <module>', "RuntimeError: y"]))
      .toEqual(Array(9).fill(true));
  });

  it("detects Go panics with goroutine dumps", () => {
    expect(flags(["some build output", "panic: runtime error: index out of range [3] with length 3", "", "goroutine 1 [running]:", "main.lookup(0x1, 0x2)", "\t/app/pkg/lookup.go:42 +0x1d", "main.main()", "\t/app/main.go:10 +0x20", "exit status 2"]))
      .toEqual([false, true, true, true, true, true, true, true, false]);
  });

  it("detects Rust panic backtraces including the message line", () => {
    expect(flags(["thread 'main' panicked at src/main.rs:5:5:", "index out of bounds: the len is 3 but the index is 99", "stack backtrace:", "   0: rust_begin_unwind", "             at /rustc/abc123/library/std/src/panicking.rs:645:5", "   1: core::panicking::panic_fmt", "   2: app::run", "note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace", "done"]))
      .toEqual([...Array(8).fill(true), false]);
  });

  it("continues .NET traces across inner exceptions", () => {
    expect(flags(["Unhandled exception. System.InvalidOperationException: outer failed", " ---> System.ArgumentNullException: inner value was null", "   at App.Data.Load(String path) in /src/App/Data.cs:line 42", "   --- End of inner exception stack trace ---", "   at App.Program.Main(String[] args) in /src/App/Program.cs:line 12", "Build finished."]))
      .toEqual([true, true, true, true, true, false]);
  });

  it("continues Java traces across Caused by and ... N more", () => {
    expect(flags(["at com.example.Service.call(Service.java:10)", "at com.example.Main.run(Main.java:5)", "Caused by: java.io.IOException: disk gone", "at com.example.Disk.read(Disk.java:77)", "... 17 more", "INFO next request"]))
      .toEqual([true, true, true, true, true, false]);
  });

  it("returns short logs verbatim", () => {
    const result = compressLog("a\nb\nc");
    expect(result.compressed).toBe("a\nb\nc");
    expect(result.compressionRatio).toBe(1);
    expect(result.stats).toEqual({});
  });

  it("caps the global line total", () => {
    const content = `${Array.from({ length: 60 }, (_, index) => `INFO line ${index}\n`).join("")}ERROR something exploded\nERROR another failure\n`;
    const result = compressLog(content, { config: { maxTotalLines: 12, stackTraceMaxLines: 2, minLinesForCcr: 1 } });
    expect(result.compressedLineCount).toBeLessThanOrEqual(12);
    expect(result.formatDetected).toBe("generic");
  });

  it("emits the CCR marker and hands the original to the store", () => {
    const content = `${Array.from({ length: 50 }, (_, index) => `INFO line ${index}\n`).join("")}ERROR boom\n`;
    const stored = new Map<string, string>();
    const result = compressLog(content, { config: { maxTotalLines: 5, minLinesForCcr: 5, minCompressionRatioForCcr: 0.95 }, store: { put: (key, original) => stored.set(key, original) } });
    expect(result.cacheKey).toMatch(/^[0-9a-f]{24}$/);
    expect(stored.get(result.cacheKey!)).toBe(content);
    expect(result.compressed.endsWith(`Retrieve more: hash=${result.cacheKey}]`)).toBe(true);
  });

  it("dedupes repeated warnings but keeps distinct messages", () => {
    const filler = (count: number) => Array.from({ length: count }, (_, index) => `step ${index} ok`);
    const content = [...filler(10), "WARN cache miss: shard 12 at /tmp/a/1/", ...filler(10), "WARN cache miss: shard 99 at /tmp/b/2/", ...filler(10), "WARN disk slow: 120ms", ...filler(20)].join("\n");
    const result = compressLog(content);
    expect(result.compressed).toContain("WARN cache miss: shard 12");
    expect(result.compressed).not.toContain("WARN cache miss: shard 99");
    expect(result.compressed).toContain("WARN disk slow: 120ms");
    expect(compressLog(content, { config: { dedupeWarnings: false } }).compressed).toContain("WARN cache miss: shard 99");
  });

  const javaChainedTrace = (runtimeFrames: number) => [
    'Exception in thread "main" java.lang.IllegalStateException: boom',
    "at com.example.App.handle(App.java:10)",
    "at com.example.App.dispatch(App.java:20)",
    ...Array.from({ length: runtimeFrames }, (_, index) => `at java.base/java.util.stream.Op${index}.eval(Op${index}.java:${index + 1})`),
    "Caused by: java.io.IOException: disk gone",
    "at com.example.Disk.read(Disk.java:77)",
    ...Array.from({ length: runtimeFrames }, (_, index) => `at java.base/java.lang.Thread${index}.run(Thread.java:${index + 1})`),
    "... 17 more"
  ].join("\n");

  it("collapses runtime frames but keeps chain heads and app frames", () => {
    const result = compressLog(javaChainedTrace(30));
    expect(result.compressed).toContain("Caused by: java.io.IOException");
    expect(result.compressed).toContain("com.example.Disk.read");
    expect(result.compressed).toContain("... 17 more");
    expect(result.compressed).toContain("frames collapsed]");
    expect(result.compressed).not.toContain("Thread25.run");
  });

  it("loses the buried chain head when collapse is disabled", () => {
    expect(compressLog(javaChainedTrace(30), { config: { collapseRuntimeFrames: false } }).compressed).not.toContain("com.example.Disk.read");
  });

  it("does not collapse small traces", () => {
    expect(compressLog(javaChainedTrace(2), { config: { minLinesForCcr: 1 } }).compressed).not.toContain("frames collapsed]");
  });
});

/** Values pinned by the upstream Rust adaptive_sizer tests. */
describe("adaptive sizer (upstream unit behaviour)", () => {
  it("clusters SimHash fingerprints", () => {
    expect(countUniqueSimhash(["abc", "abc", "abc"], 3)).toBe(1);
    expect(countUniqueSimhash(["the cat sat on the mat", "the dog ran in the park", "a fish swam in the sea"], 3)).toBe(3);
  });

  it("builds the unique-bigram curve", () => {
    expect(computeUniqueBigramCurve(["the cat", "the dog", "a fish"])).toEqual([1, 2, 3]);
    expect(computeUniqueBigramCurve(["", "a", "a b"])).toEqual([1, 2, 3]);
    expect(computeUniqueBigramCurve(["Hello", "hello"])).toEqual([1, 1]);
    expect(computeUniqueBigramCurve(["数据库连接失败", "数据库连接成功"])).toEqual([6, 8]);
  });

  it("finds the knee", () => {
    expect(findKnee([1, 2])).toBeNull();
    expect(findKnee([5, 5, 5, 5, 5])).toBe(1);
    expect(findKnee([1, 5, 8, 9, 10, 10, 10, 10, 10])).toBe(3);
    expect(findKnee([1, 2, 3, 4, 5, 6, 7, 8, 9])).toBeNull();
  });

  it("validates with zlib", () => {
    expect(validateWithZlib(Array<string>(20).fill("the quick brown fox jumps over the lazy dog"), 5, 100, 0.15)).toBe(6);
    expect(validateWithZlib(Array.from({ length: 20 }, (_, index) => `entry id=${index} payload=item value with content for item number ${index}`), 10, 100, 0.15)).toBe(10);
  });

  it("computes the optimal k", () => {
    expect(computeOptimalK(["a", "b", "c", "d", "e"], 1, 3)).toBe(5);
    expect(computeOptimalK(Array<string>(10).fill("abc"), 1, 3)).toBe(3);
    expect(computeOptimalK(Array.from({ length: 20 }, (_, index) => `unique item number ${index} with some long content`), 1, 3)).toBe(20);
    expect(computeOptimalK(Array<string>(20).fill("abc"), 1, 5)).toBe(5);
  });
});
