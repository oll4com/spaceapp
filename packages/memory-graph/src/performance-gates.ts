export interface MemoryPerformanceGateInput {
  baselineBundleBrotliBytes: number;
  currentBundleBrotliBytes: number;
  graphApiP95Ms: number;
  coreEndpoints: Array<{
    name: string;
    baselineP95Ms: number;
    currentP95Ms: number;
  }>;
  lazyChunksPresent: boolean;
  startupIsolationPassed: boolean;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function evaluateMemoryPerformanceGates(input: MemoryPerformanceGateInput) {
  if (input.baselineBundleBrotliBytes <= 0 || input.currentBundleBrotliBytes <= 0) {
    throw new Error("Memory bundle gates require positive baseline and current Brotli byte counts.");
  }
  if (input.graphApiP95Ms < 0) throw new Error("Memory graph latency cannot be negative.");
  if (input.coreEndpoints.length === 0) throw new Error("Memory performance gates require core endpoint benchmarks.");

  const bundleGrowthBytes = input.currentBundleBrotliBytes - input.baselineBundleBrotliBytes;
  const bundle = {
    baselineBrotliBytes: input.baselineBundleBrotliBytes,
    currentBrotliBytes: input.currentBundleBrotliBytes,
    growthBytes: bundleGrowthBytes,
    maximumGrowthBytes: 3 * 1024,
    passed: bundleGrowthBytes <= 3 * 1024
  };
  const graphApi = {
    p95Ms: input.graphApiP95Ms,
    maximumP95Ms: 150,
    passed: input.graphApiP95Ms < 150
  };
  const coreEndpoints = input.coreEndpoints.map((endpoint) => {
    if (endpoint.baselineP95Ms <= 0 || endpoint.currentP95Ms < 0) {
      throw new Error(`Core endpoint ${endpoint.name} requires a positive baseline and non-negative current p95.`);
    }
    const regressionRatio = round((endpoint.currentP95Ms - endpoint.baselineP95Ms) / endpoint.baselineP95Ms);
    return {
      ...endpoint,
      regressionRatio,
      maximumRegressionRatio: 0.05,
      passed: regressionRatio <= 0.05
    };
  });
  const lazyLoading = { present: input.lazyChunksPresent, passed: input.lazyChunksPresent };
  const startupIsolation = { passed: input.startupIsolationPassed };

  return {
    bundle,
    graphApi,
    coreEndpoints,
    lazyLoading,
    startupIsolation,
    passed: bundle.passed && graphApi.passed && coreEndpoints.every((endpoint) => endpoint.passed) &&
      lazyLoading.passed && startupIsolation.passed
  };
}
