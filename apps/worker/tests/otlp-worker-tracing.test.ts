import { describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/worker";
import { MetricsRegistry, createOtlpSpanExporter, type ServerSpan, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors, observeActivityExecution, traceparentFromHeaders } from "../src/activity-observability.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { createWorkerMetrics } from "../src/worker-metrics.js";
import { createWorkerTracing, spaceTracingSinks, toWorkflowSpan, workerObservabilityOptions, workerTracing, workflowTracingModulePath } from "../src/worker-tracing.js";
import type { WorkflowSpanRecord } from "../src/workflow-tracing-interceptors.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const workflowSpanTraceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-a3ce929d0e0e4736-01";

function recordingExporter(): SpanExporter & { recorded: ServerSpan[] } {
  const recorded: ServerSpan[] = [];
  return {
    recorded,
    record: (span) => { recorded.push(span); },
    flush: async () => undefined,
    close: async () => undefined,
    stats: () => ({ exported: 0, dropped: 0, failed: 0 })
  };
}

const workflowInfo = { workflowId: "workflow:codex-app-server:room_1:pane_1:req:abc", runId: "0190-run", workflowType: "codexAppServerTurnWorkflow", taskQueue: "space-turns" };
const record: WorkflowSpanRecord = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "a3ce929d0e0e4736",
  parentSpanId: "00f067aa0ba902b7",
  startTimeMs: 1_000,
  endTimeMs: 1_400,
  outcome: "FAILED",
  errorCode: "CODEX_APP_SERVER_TURN_TIMEOUT",
  correlation: { spaceTraceId: "req:abc", roomId: "room_1", paneId: "/etc/passwd" },
  links: [{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", reason: "continue_as_new" }]
};

describe("worker tracing switch", () => {
  it("is off without SPACE_OTEL_EXPORTER_OTLP_ENDPOINT and leaves the Worker options unchanged", () => {
    expect(workerTracing({}, "space-worker")).toBeNull();
    expect(createWorkerTracing({}, "space-worker")).toBeNull();
    expect(workerTracing({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector" }, "space-worker")).toBeNull();
    const options = workerObservabilityOptions(null);
    expect(Object.keys(options)).toEqual(["interceptors"]);
    expect(Object.keys(options.interceptors!)).toEqual(["activity"]);
    expect(options.interceptors!.activity).toHaveLength(1);
  });

  it("registers the workflow interceptor module, the sink and the activity exporter when on", async () => {
    const tracing = workerTracing({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" }, "space-worker")!;
    try {
      const options = workerObservabilityOptions(tracing);
      expect(options.interceptors!.workflowModules).toEqual([workflowTracingModulePath()]);
      expect(workflowTracingModulePath()).toMatch(/workflow-tracing-interceptors\.(js|ts)$/);
      expect(options.sinks).toBe(tracing.sinks);
      expect(tracing.sinks.spaceTracing.workflowSpan.callDuringReplay).toBe(false);
      expect(options.interceptors!.activity).toHaveLength(1);
    } finally {
      await tracing.close();
    }
  });

  it("wires every Temporal worker through the shared options builder", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const entry of ["worker.ts", "memory-maintenance-worker.ts", "memory-mutation-worker.ts"]) {
      const source = await readFile(new URL(`../src/${entry}`, import.meta.url), "utf8");
      expect(source, entry).toMatch(/const tracing = workerTracing\(process\.env, /);
      expect(source, entry).toMatch(/\.\.\.workerObservabilityOptions\(tracing\)/);
      expect(source, entry).toMatch(/await tracing\?\.close\(\)/);
    }
  });

  it("caps shutdown at two seconds when the collector hangs", async () => {
    const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "space-worker", fetch: () => new Promise(() => undefined), timeoutMs: 60_000 });
    exporter.record({ ...toWorkflowSpan(workflowInfo, record) });
    const started = Date.now();
    await createWorkerTracing(exporter).close();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe("workflow span sink", () => {
  it("builds an INTERNAL workflow span with allowlisted attributes and reasoned links", () => {
    const span = toWorkflowSpan(workflowInfo, record);
    expect(span).toMatchObject({
      traceId: record.traceId, spanId: record.spanId, parentSpanId: "00f067aa0ba902b7", kind: 1, error: true,
      name: "workflow codexAppServerTurnWorkflow", startTimeUnixNano: 1_000_000_000n, endTimeUnixNano: 1_400_000_000n
    });
    expect(span.attributes).toEqual({
      "temporal.workflow.id": workflowInfo.workflowId,
      "temporal.workflow.run_id": "0190-run",
      "temporal.workflow.type": "codexAppServerTurnWorkflow",
      "space.outcome": "FAILED",
      "error.code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.error.category": "TIMEOUT",
      "space.duration_ms": 400,
      "space.trace_id": "req:abc",
      "space.room_id": "room_1"
    });
    expect(span.links).toEqual([{ traceId: "0af7651916cd43dd8448eb211c80319c", spanId: "b7ad6b7169203331", attributes: { "space.link.kind": "continue_as_new" } }]);
  });

  it("is never called during replay and never throws into the worker", () => {
    const throwing = { ...recordingExporter(), record: () => { throw new Error("collector bug"); } };
    const sinks = spaceTracingSinks(throwing);
    expect(sinks.spaceTracing.workflowSpan.callDuringReplay).toBe(false);
    expect(() => sinks.spaceTracing.workflowSpan.fn(workflowInfo as never, record)).not.toThrow();
    const exporter = recordingExporter();
    spaceTracingSinks(exporter).spaceTracing.workflowSpan.fn(workflowInfo as never, { ...record, outcome: "COMPLETED", errorCode: null });
    expect(exporter.recorded[0]!.attributes).not.toHaveProperty("error.code");
    expect(exporter.recorded[0]!.error).toBe(false);
  });
});

describe("activity attempt spans", () => {
  const info = { activityType: "runTurn", activityId: "7", attempt: 2, currentAttemptScheduledTimestampMs: 900, workflowType: "codexAppServerTurnWorkflow", workflowExecution: { workflowId: "w-1", runId: "r-1" } } as never;

  it("nests under the workflow span from the header, ahead of the traceparent in the input", async () => {
    const exporter = recordingExporter();
    const restore = captureWorkerLogs(() => undefined);
    let clock = 1_000;
    try {
      await observeActivityExecution(info, [{ turn: { traceparent, traceId: "req:abc", roomId: "room_1", prompt: "never exported" } }], async () => { clock += 25; return { status: "FAILED" }; }, {
        metrics: createWorkerMetrics(new MetricsRegistry()), now: () => clock, spans: exporter, parentTraceparent: workflowSpanTraceparent
      });
    } finally {
      restore();
    }
    expect(exporter.recorded).toHaveLength(1);
    const span = exporter.recorded[0]!;
    expect(span).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "a3ce929d0e0e4736", kind: 1, error: true, name: "activity runTurn" });
    expect(span.attributes).toEqual({
      "temporal.activity.type": "runTurn",
      "temporal.activity.id": "7",
      "temporal.activity.attempt": 2,
      "temporal.workflow.id": "w-1",
      "temporal.workflow.run_id": "r-1",
      "temporal.workflow.type": "codexAppServerTurnWorkflow",
      "space.outcome": "FAILED_RESULT",
      "error.code": "ACTIVITY_RESULT_FAILED",
      "space.error.category": "INTERNAL",
      "space.duration_ms": 25,
      "space.queue_ms": 100,
      "space.trace_id": "req:abc",
      "space.room_id": "room_1"
    });
    expect(JSON.stringify(span.attributes)).not.toContain("never exported");
  });

  it("reads the traceparent header and ignores anything that is not one", () => {
    expect(traceparentFromHeaders({ "space-traceparent": defaultPayloadConverter.toPayload(workflowSpanTraceparent) })).toBe(workflowSpanTraceparent);
    expect(traceparentFromHeaders({ "space-traceparent": defaultPayloadConverter.toPayload("https://example.test") })).toBeNull();
    expect(traceparentFromHeaders({})).toBeNull();
    expect(traceparentFromHeaders(undefined)).toBeNull();
  });

  it("passes the header to the span through the interceptor", async () => {
    const exporter = recordingExporter();
    const factory = createActivityObservabilityInterceptors({ spans: exporter, metrics: createWorkerMetrics(new MetricsRegistry()) });
    const interceptors = factory({ info, cancellationSignal: new AbortController().signal } as never);
    const restore = captureWorkerLogs(() => undefined);
    try {
      await interceptors.inbound!.execute!({ args: [{}], headers: { "space-traceparent": defaultPayloadConverter.toPayload(workflowSpanTraceparent) } }, async () => "ok");
    } finally {
      restore();
    }
    expect(exporter.recorded[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "a3ce929d0e0e4736" });
  });

  it("preserves activity results when the exporter throws", async () => {
    const exporter = { ...recordingExporter(), record: () => { throw new Error("export failure"); } };
    const restore = captureWorkerLogs(() => undefined);
    const dependencies = { spans: exporter, parentTraceparent: workflowSpanTraceparent, metrics: createWorkerMetrics(new MetricsRegistry()) };
    try {
      await expect(observeActivityExecution(info, [], async () => "ok", dependencies)).resolves.toBe("ok");
      const error = new Error("activity failure");
      await expect(observeActivityExecution(info, [], async () => { throw error; }, dependencies)).rejects.toBe(error);
    } finally { restore(); }
  });

  it("is not delayed or failed by a collector that never answers", async () => {
    const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "space-worker", batchSize: 1, maxQueue: 1, fetch: () => new Promise(() => undefined) });
    const restore = captureWorkerLogs(() => undefined);
    try {
      const started = Date.now();
      for (let index = 0; index < 5; index += 1) {
        await expect(observeActivityExecution(info, [{}], async () => "done", {
          metrics: createWorkerMetrics(new MetricsRegistry()), spans: exporter, parentTraceparent: workflowSpanTraceparent
        })).resolves.toBe("done");
      }
      await expect(observeActivityExecution(info, [{}], async () => { throw new Error("activity failure stays the activity's"); }, {
        metrics: createWorkerMetrics(new MetricsRegistry()), spans: exporter, parentTraceparent: workflowSpanTraceparent
      })).rejects.toThrow("activity failure stays the activity's");
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(exporter.stats().dropped).toBeGreaterThan(0);
    } finally {
      restore();
    }
  });
});
