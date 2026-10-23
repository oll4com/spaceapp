// A slow, hanging or failing collector never delays or fails workflow or
// activity work: recording is synchronous into a bounded queue that drops and
// counts, and every POST has a timeout. Real workflows against a collector
// that hangs or answers 500.
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { createOtlpSpanExporter } from "@space/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { observeActivityExecution } from "../src/activity-observability.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { MetricsRegistry } from "@space/runtime";
import { createWorkerMetrics } from "../src/worker-metrics.js";
import { apiTraceparent, runTracedScenarios } from "./support/otlp-scenarios.js";
import { startFakeCollector } from "./support/otlp-temporal.js";

let env: TestWorkflowEnvironment;
/** Restores worker logging; replaced in beforeAll. */
let restoreLogs: () => void = () => undefined;

beforeAll(async () => {
  restoreLogs = captureWorkerLogs(() => undefined);
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 240_000);

afterAll(async () => {
  restoreLogs();
  await env?.teardown();
});

const info = { activityType: "runTurn", activityId: "1", attempt: 1, currentAttemptScheduledTimestampMs: Date.now(),
  workflowType: "codexAppServerTurnWorkflow", workflowExecution: { workflowId: "w", runId: "r" } } as never;

describe("OTLP export under a bad collector", () => {
  for (const mode of ["hang", "fail"] as const) {
    it(`finishes real workflows on time when the collector ${mode === "hang" ? "never answers" : "answers 500"}`, async () => {
      const collector = await startFakeCollector(mode);
      const exporter = createOtlpSpanExporter({ endpoint: collector.url, serviceName: "space-worker", timeoutMs: 300, batchSize: 1, flushIntervalMs: 50 });
      const started = Date.now();
      await runTracedScenarios(env, { collector, mainExporter: exporter, only: ["turnWorkflowId", "actionWorkflowId"] });
      const elapsed = Date.now() - started;
      // Each span was attempted and failed; none was exported; work completed regardless.
      const stats = exporter.stats();
      expect(stats.exported).toBe(0);
      expect(stats.failed).toBeGreaterThanOrEqual(5);
      expect(collector.paths.length).toBeGreaterThanOrEqual(1);
      expect(elapsed).toBeLessThan(60_000);
      await collector.close();
    }, 120_000);
  }

  it("records synchronously: an activity is not delayed by a collector that hangs", async () => {
    const collector = await startFakeCollector("hang");
    const exporter = createOtlpSpanExporter({ endpoint: collector.url, serviceName: "space-worker", timeoutMs: 400, batchSize: 1, flushIntervalMs: 60_000 });
    const metrics = createWorkerMetrics(new MetricsRegistry());
    const durations: number[] = [];
    for (let index = 0; index < 5; index++) {
      const started = performance.now();
      await observeActivityExecution(info, [{ traceparent: apiTraceparent }], async () => "ok", { metrics, spans: exporter });
      durations.push(performance.now() - started);
    }
    expect(Math.max(...durations)).toBeLessThan(50);
    // The hanging POSTs end at their timeout; close() is bounded by it too.
    const closing = performance.now();
    await exporter.close();
    expect(performance.now() - closing).toBeLessThan(5 * 400 + 1_000);
    expect(exporter.stats()).toMatchObject({ exported: 0, failed: 5, dropped: 0 });
    await collector.close();
  }, 30_000);

  it("drops and counts spans beyond the bounded queue instead of growing", async () => {
    const collector = await startFakeCollector("hang");
    const exporter = createOtlpSpanExporter({ endpoint: collector.url, serviceName: "space-worker", timeoutMs: 200, batchSize: 1_000, maxQueue: 3, flushIntervalMs: 60_000 });
    const metrics = createWorkerMetrics(new MetricsRegistry());
    for (let index = 0; index < 10; index++) {
      await observeActivityExecution({ ...(info as object), activityId: String(index) } as never, [{ traceparent: apiTraceparent }], async () => "ok", { metrics, spans: exporter });
    }
    expect(exporter.stats().dropped).toBe(7);
    await exporter.close();
    expect(exporter.stats()).toMatchObject({ dropped: 7, failed: 3, exported: 0 });
    await collector.close();
  }, 30_000);
});
