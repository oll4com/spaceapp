import { beforeAll, describe, expect, it } from "vitest";
import { createCompressors, initCompressors } from "../src/compression/compressors.js";
import { detectContentType } from "../src/compression/content-detector.js";
import { compressBlock, type BlockOutcome, type Compressors, type CompressionOutcome } from "../src/compression/engine.js";
import { compressLog } from "../src/compression/log-compressor/index.js";
import { compressionRows } from "../src/compression/recorder.js";
import { hasStrongErrorIndicators, hasTestFailureReport, isProtectedLine, missingProtectedLines } from "../src/compression/test-output.js";
import { crushText, defaultTextCrusherConfig } from "../src/compression/text-crusher/index.js";

const tokens = { count: (text: string) => Math.ceil(text.length / 4) };
const compressors = createCompressors();
const lossy = { codeText: "ON" as const, lossy: true };

beforeAll(async () => { await initCompressors(); });

/** `node --test` TAP output with `tests` cases; the ones listed in `failing` carry an assertion block. */
function tap(tests: number, failing: number[]): string {
  const lines = ["TAP version 13"];
  for (let index = 1; index <= tests; index += 1) {
    const name = `case ${index} does the thing number ${index}`;
    lines.push(`# Subtest: ${name}`);
    if (failing.includes(index)) {
      lines.push(`not ok ${index} - ${name}`, "  ---", `  duration_ms: ${(index * 0.37).toFixed(3)}`, `  location: '/repo/test/mod.test.js:${10 + index}:1'`,
        "  failureType: 'testCodeFailure'", "  error: |-", "    Expected values to be strictly equal:", "    ", `    ${index * 10} !== ${index * 10 + 1}`,
        "  code: 'ERR_ASSERTION'", "  name: 'AssertionError'", `  expected: ${index * 10 + 1}`, `  actual: ${index * 10}`, "  operator: 'strictEqual'",
        "  stack: |-", `    TestContext.<anonymous> (file:///repo/test/mod.test.js:${11 + index}:10)`, "    Test.runInAsyncScope (node:async_hooks:214:14)",
        "    Test.run (node:internal/test_runner/test:1047:25)", "  ...");
    } else {
      lines.push(`ok ${index} - ${name}`, "  ---", `  duration_ms: ${(index * 0.37).toFixed(3)}`, "  ...");
    }
  }
  lines.push(`1..${tests}`, `# tests ${tests}`, "# suites 0", `# pass ${tests - failing.length}`, `# fail ${failing.length}`, "# cancelled 0", "# skipped 0",
    "# todo 0", "# duration_ms 123.456");
  return `${lines.join("\n")}\n`;
}

const jest = [
  "PASS src/money.test.ts", "FAIL src/report.test.ts", "  ● revenue › counts paid orders only", "", "    expect(received).toEqual(expected) // deep equality", "",
  "    - Expected", "    + Received", "", "      Object {", '    -   "EU": 1000,', '    +   "EU": 1500,', '        "US": 540,', "      }", "",
  "      12 |   it(\"counts paid orders only\", () => {", "    > 13 |     expect(revenueByRegion(orders)).toEqual({ EU: 1000, US: 540 });",
  "         |                                     ^", "      14 |   });", "", "      at Object.<anonymous> (src/report.test.ts:13:37)", "",
  "Test Suites: 1 failed, 1 passed, 2 total", "Tests:       1 failed, 3 passed, 4 total", "Snapshots:   0 total", "Time:        1.234 s", "Ran all test suites."
].join("\n");

function pytest(passing: number): string {
  const lines = ["============================= test session starts ==============================", "platform linux -- Python 3.12.4, pytest-8.2.0", `collected ${passing + 1} items`, ""];
  for (let index = 0; index < passing; index += 1) lines.push(`tests/test_mod_${index}.py::test_case PASSED                                [${Math.round(((index + 1) / (passing + 1)) * 100)}%]`);
  lines.push("tests/test_mod_25.py::test_bad FAILED                                          [100%]", "",
    "=================================== FAILURES ===================================", "__________________________________ test_bad ____________________________________", "",
    "    def test_bad():", ">       assert compute(1, 2) == 4", "E       assert 3 == 4", "E        +  where 3 = compute(1, 2)", "", "tests/test_mod_25.py:17: AssertionError",
    "=========================== short test summary info ============================", "FAILED tests/test_mod_25.py::test_bad - assert 3 == 4",
    `========================= 1 failed, ${passing} passed in 0.42s =========================`);
  return `${lines.join("\n")}\n`;
}

function goTest(passing: number): string {
  const lines: string[] = [];
  for (let index = 0; index < passing; index += 1) lines.push(`=== RUN   TestCase${index}`, `--- PASS: TestCase${index} (0.00s)`);
  lines.push("=== RUN   TestFoo", "    foo_test.go:12: expected 2, got 1", "--- FAIL: TestFoo (0.00s)", "FAIL", "FAIL\texample.com/pkg\t0.012s", "ok  \texample.com/other\t0.005s");
  return `${lines.join("\n")}\n`;
}

const cargo = [
  "running 23 tests", ...Array.from({ length: 20 }, (_, index) => `test inventory::tests::reserve_case_${index} ... ok`),
  "test money::tests::rounds ... ok", "test money::tests::discount ... FAILED", "test money::tests::total ... ok", "", "failures:", "",
  "---- money::tests::discount stdout ----", "thread 'money::tests::discount' panicked at src/money.rs:17:9:", "assertion `left == right` failed", "  left: 850",
  " right: 849", "", "failures:", "    money::tests::discount", "",
  "test result: FAILED. 22 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s"
].join("\n");

const outcomeOf = (blocks: BlockOutcome[]): CompressionOutcome => ({ body: {}, modified: false, blocks, tokensBefore: 0, tokensAfter: 0, durationMs: 1, timedOut: false,
  waste: {}, stageMs: {}, cacheHits: 0 });

describe("test output protection", () => {
  it("recognises failure, summary and assertion lines of every runner", () => {
    for (const line of ["not ok 4 - reserve refuses when nothing is left", "# fail 4", "# tests 17", "# pass 13", "✖ failing tests:", "  error: |-", "    850 !== 849",
      "  expected: 849", "FAIL src/report.test.ts", "  ● revenue › counts paid orders only", "    - Expected", "Tests:       1 failed, 3 passed, 4 total",
      "  1 failing", "  1) money", "FAILED tests/test_mod_25.py::test_bad - assert 3 == 4", "E       assert 3 == 4", "tests/test_mod_25.py:17: AssertionError",
      "========================= 1 failed, 59 passed in 0.42s =========================", "--- FAIL: TestFoo (0.00s)", "FAIL\texample.com/pkg\t0.012s",
      "test money::tests::discount ... FAILED", "test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s",
      "thread 'money::tests::discount' panicked at src/money.rs:17:9:", "Missing expected exception (InsufficientStockError)."]) {
      expect(isProtectedLine(line), line).toBe(true);
    }
    for (const line of ["  duration_ms: 0.816629", "tests/test_mod_0.py::test_case PASSED", "const ok = a !== b;", '{"name": "AssertionError"}', "ok 5 - reserve validates qty",
      "2026-10-10T00:00:05.313Z ERROR req=15f4b9 method=POST path=/api/orders status=500", "    at reserve (src/inventory.js:17:11)"]) {
      expect(isProtectedLine(line), line).toBe(false);
    }
    expect(hasTestFailureReport(tap(5, [2]))).toBe(true);
    expect(hasTestFailureReport(tap(5, []))).toBe(false);
    expect(missingProtectedLines(tap(5, [2]), tap(5, [2]).replace("not ok 2", "ok 2"))).toBe(1);
  });

  it("needs two distinct error indicators and ignores zero counts", () => {
    expect(hasStrongErrorIndicators("ERROR: the build failed on step 3")).toBe(true);
    expect(hasStrongErrorIndicators("Traceback (most recent call last):\nValueError: bad input")).toBe(true);
    expect(hasStrongErrorIndicators("0 errors, 0 failed, 12 passed")).toBe(false);
    expect(hasStrongErrorIndicators("# tests 5\n# pass 5\n# fail 0\nerrors: 0")).toBe(false);
    expect(hasStrongErrorIndicators("one error only")).toBe(false);
  });

  it("passes a small failing run through unchanged, whatever the runner", () => {
    for (const text of [tap(20, [4]), jest, pytest(10), goTest(20), cargo]) {
      const result = compressBlock(text, compressors, tokens, undefined, lossy);
      expect(result.action, text.slice(0, 40)).toMatchObject({ kind: "protected", reason: "test_failures" });
      expect(result.replacement).toBeNull();
    }
    expect(compressBlock(tap(20, []), compressors, tokens, undefined, lossy).action.kind).not.toBe("protected");
  });

  it("passes a small log with strong error indicators through, but not a JSON array that mentions them", () => {
    const crash = Array.from({ length: 60 }, (_, index) => `2026-10-10T08:00:${String(index).padStart(2, "0")}Z INFO request ${index} served`).join("\n")
      + "\n2026-10-10T08:01:00Z ERROR worker crashed: Traceback (most recent call last)\n  File \"app.py\", line 7\nRuntimeError: boom\n";
    expect(compressBlock(crash, compressors, tokens, undefined, lossy).action).toMatchObject({ kind: "protected", reason: "error_output" });
    const rows = JSON.stringify(Array.from({ length: 40 }, (_, index) => ({ id: index, status: "error", note: `request failed ${index}` })));
    expect(compressBlock(rows, compressors, tokens, undefined, lossy).action.kind).not.toBe("protected");
  });

  it("keeps every failure, its assertion block and the counts of a large TAP run", () => {
    const text = tap(60, [7, 33, 58]);
    expect(Buffer.byteLength(text)).toBeGreaterThan(8000);
    const result = compressBlock(text, compressors, tokens, undefined, lossy);
    expect(result.action).toMatchObject({ kind: "compressed", strategy: "log_compressor" });
    for (const line of ["not ok 7 -", "not ok 33 -", "not ok 58 -", "70 !== 71", "330 !== 331", "580 !== 581", "# tests 60", "# pass 57", "# fail 3"]) {
      expect(result.replacement, line).toContain(line);
    }
    expect(result.replacement!.split("error: |-").length - 1).toBe(3);
    expect(result.replacement!.length).toBeLessThan(text.length / 2);
    expect(compressBlock(text, compressors, tokens, undefined, lossy).replacement).toBe(result.replacement);
  });

  it("keeps pytest and go test failures through the caps", () => {
    const py = pytest(200);
    expect(Buffer.byteLength(py)).toBeGreaterThan(8000);
    const pyResult = compressBlock(py, compressors, tokens, undefined, lossy);
    const pyText = pyResult.replacement ?? py;
    for (const line of ["FAILED tests/test_mod_25.py::test_bad - assert 3 == 4", "E       assert 3 == 4", "tests/test_mod_25.py:17: AssertionError", "1 failed, 200 passed"]) {
      expect(pyText, line).toContain(line.trim());
    }
    const go = goTest(300);
    expect(Buffer.byteLength(go)).toBeGreaterThan(8000);
    const goResult = compressBlock(go, compressors, tokens, undefined, lossy);
    expect(goResult.action).toMatchObject({ kind: "compressed", strategy: "log_compressor" });
    for (const line of ["--- FAIL: TestFoo (0.00s)", "foo_test.go:12: expected 2, got 1", "FAIL\texample.com/pkg\t0.012s"]) expect(goResult.replacement, line).toContain(line);
  });

  it("keeps protected lines in the log compressor past the error cap", () => {
    const failing = Array.from({ length: 15 }, (_, index) => index * 25 + 3);
    const text = tap(400, failing);
    const count = (output: string) => output.split("\n").filter((line) => line.startsWith("not ok ")).length;
    expect(count(compressLog(text, { config: { enableCcr: false }, protect: isProtectedLine }).compressed)).toBe(15);
    expect(count(compressLog(text, { config: { enableCcr: false } }).compressed)).toBeLessThan(15);
  });

  it("pins protected lines in TextCrusher even when they score low", () => {
    const prose = Array.from({ length: 14 }, (_, index) => `The deploy step ${index} copied bundle ${index * 7} to HOST${index} and waited ${index + 2} seconds for it.`);
    const text = [...prose, "not ok 7 - the thing", "# fail 2"].join("\n");
    const pinned = crushText(text, "", 0.3, defaultTextCrusherConfig, { pin: isProtectedLine }).compressed;
    expect(pinned).toContain("not ok 7 - the thing");
    expect(pinned).toContain("# fail 2");
    expect(pinned.length).toBeLessThan(text.length);
    expect(crushText(text, "", 0.3).compressed).not.toContain("# fail 2");
  });

  it("rejects a replacement that lost a protected line and counts it as rejected", () => {
    const stub: Compressors = { logCompressor: () => "ok 1 - something\n[354 lines omitted: 3 FAIL]" };
    const result = compressBlock(tap(60, [7, 33, 58]), stub, tokens, undefined, lossy);
    expect(result.replacement).toBeNull();
    expect(result.action).toMatchObject({ kind: "rejected_protected_lines", strategy: "log_compressor" });
    expect((result.action as { lines: number }).lines).toBeGreaterThan(0);
    const rows = compressionRows(outcomeOf([{ itemIndex: 0, blockType: "tool_result#0", action: result.action }]), { at: "2026-10-13T08:00:00.000Z", mode: "ON", provider: "CODEX" });
    expect(rows.find((row) => row.strategy === "log_compressor")).toMatchObject({ rejectedBlocks: 1, blocks: 0 });
  });

  it("detects test-runner output as a log", () => {
    for (const text of [tap(20, []), tap(20, [3]), jest, goTest(5), cargo]) expect(detectContentType(text).contentType, text.slice(0, 30)).toBe("build");
  });
});
