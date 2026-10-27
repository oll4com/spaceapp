import { describe, expect, it } from "vitest";
import { runProjectionBenchmark, formatBenchmarkReportMarkdown } from "../src/demo/benchmark-harness.js";

describe("Performance Benchmark & Frame-time Harness", () => {
  it("validates 2,000 nodes target: p95 <= 16.7 ms (60 fps)", () => {
    const result = runProjectionBenchmark("2k", 120);
    console.log("2k result:", result);
    expect(result.nodeCount).toBe(2000);
    expect(result.p95Ms).toBeLessThanOrEqual(16.7);
    expect(result.passed).toBe(true);
  });

  it("validates 50,000 nodes / 150,000 edges target: p95 <= 33 ms (>= 30 fps)", () => {
    const result = runProjectionBenchmark("50k", 60);
    console.log("50k result:", result);
    expect(result.nodeCount).toBe(50000);
    expect(result.edgeCount).toBe(150000);
    expect(result.p95Ms).toBeLessThanOrEqual(33.0);
    expect(result.passed).toBe(true);
  });

  it("generates markdown report", () => {
    const r2k = runProjectionBenchmark("2k", 60);
    const r10k = runProjectionBenchmark("10k", 60);
    const r50k = runProjectionBenchmark("50k", 60);
    const md = formatBenchmarkReportMarkdown([r2k, r10k, r50k]);
    console.log("\n" + md);
    expect(md).toContain("50,000");
    expect(md).toContain("PASS");
  });
});
