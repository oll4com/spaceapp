import { describe, expect, it } from "vitest";
import { evaluateMemoryPerformanceGates } from "../src/index.js";

describe("memory performance gates", () => {
  it("accepts bounded bundle growth, graph latency and core regressions", () => {
    const result = evaluateMemoryPerformanceGates({
      baselineBundleBrotliBytes: 150_000,
      currentBundleBrotliBytes: 152_500,
      graphApiP95Ms: 42,
      coreEndpoints: [
        { name: "rooms", baselineP95Ms: 10, currentP95Ms: 10.4 },
        { name: "turn-enqueue", baselineP95Ms: 20, currentP95Ms: 20.8 }
      ],
      lazyChunksPresent: true,
      startupIsolationPassed: true
    });

    expect(result.bundle.growthBytes).toBe(2500);
    expect(result.coreEndpoints.map((endpoint) => endpoint.regressionRatio)).toEqual([0.04, 0.04]);
    expect(result.passed).toBe(true);
  });

  it("fails every gate at or beyond its strict boundary", () => {
    const result = evaluateMemoryPerformanceGates({
      baselineBundleBrotliBytes: 150_000,
      currentBundleBrotliBytes: 153_073,
      graphApiP95Ms: 150,
      coreEndpoints: [{ name: "turn-enqueue", baselineP95Ms: 20, currentP95Ms: 21.01 }],
      lazyChunksPresent: false,
      startupIsolationPassed: false
    });

    expect(result.bundle.passed).toBe(false);
    expect(result.graphApi.passed).toBe(false);
    expect(result.coreEndpoints[0]?.passed).toBe(false);
    expect(result.passed).toBe(false);
  });
});
