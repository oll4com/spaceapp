import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { observeActivityExecution } from "../src/activity-observability.js";
import { recordWorkflowSpan, workflowTracingSinks } from "../src/workflow-tracing-sink.js";
import { workflowSpanId } from "../src/workflow-span-ids.js";
import type { WorkflowSpanWire } from "../src/workflow-tracing-wire.js";
import { createWorkerMetrics } from "../src/worker-metrics.js";
import { MetricsRegistry } from "@space/runtime";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "a1b2c3d4e5f60718";
const runId = "aabbccdd-0000-4abc-8def-000000000001";
const secretText = "private prompt and password must never leave the process";
const activeExporters: SpanExporter[] = [];
afterEach(async () => { await Promise.all(activeExporters.splice(0).map(e => e.close())); });

function sample(overrides: Partial<WorkflowSpanWire> = {}): WorkflowSpanWire {
  return {
    traceId, spanId: workflowSpanId(runId), parentSpanId: apiSpanId,
    runId, workflowId: "workflow:example:001", workflowType: "codexAppServerTurnWorkflow",
    startMs: 1500, endMs: 2000, status: "COMPLETED",
    continuedFromRunId: null, linkedTraceId: null, linkedSpanId: null, ...overrides
  };
}

describe("workflow OTLP instrumentation", () => {
  it("uses deterministic span IDs from Temporal run IDs across worker and isolate contexts", () => {
    expect(workflowSpanId(runId)).toBe("aabbccdd00004abc");
    expect(workflowSpanId(runId)).toBe(workflowSpanId(runId));
    expect(workflowSpanId("non-uuid-run")).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowSpanId("non-uuid-run")).not.toBe(workflowSpanId("another-run"));
  });

  it("drops unauthorized fields and accepts only documented identifiers", () => {
    const observed: unknown[] = [];
    const exporter = { record: (s: unknown) => observed.push(s) } as never;
    const valid = sample();
    recordWorkflowSpan(exporter, { ...valid, message: secretText, path: "/private/document" } as never);
    expect(observed).toHaveLength(1);
    expect(JSON.stringify(observed, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain(secretText);
    expect(JSON.stringify(observed, (_, value) => typeof value === "bigint" ? value.toString() : value)).not.toContain("/private/document");
    recordWorkflowSpan(exporter, sample({ workflowId: secretText }));
    recordWorkflowSpan(exporter, sample({ workflowType: "bad/type" }));
    recordWorkflowSpan(exporter, sample({ traceId: "bad" }));
    expect(observed).toHaveLength(1);
    expect(workflowTracingSinks(exporter).spaceTrace.record.callDuringReplay).toBe(false);
  });

  it("emits links to continuation runs and previous trace contexts", () => {
    const observed: Array<{ links?: unknown[] }> = [];
    const exporter = { record: (s: { links?: unknown[] }) => observed.push(s) } as never;
    const previousRun = "ffffffff-ffff-4fff-8fff-fffffffffffe";
    const linkedTraceId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    recordWorkflowSpan(exporter, sample({
      continuedFromRunId: previousRun,
      linkedTraceId, linkedSpanId: "0011223344556677"
    }));
    expect(observed[0]?.links).toEqual([
      { traceId, spanId: workflowSpanId(previousRun) },
      { traceId: linkedTraceId, spanId: "0011223344556677" }
    ]);
  });

  it("exports a connected API -> workflow -> activity tree to a local OTLP collector", async () => {
    const received: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> }> = [];
    const collector = createServer((req, res) => {
      if (req.url !== "/v1/traces" || req.method !== "POST") { res.writeHead(404).end(); return; }
      let body = "";
      req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => {
        received.push(JSON.parse(body));
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const addr = collector.address();
    if (!addr || typeof addr === "string") throw new Error("Collector port missing");
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:" + addr.port,
      serviceName: "space-worker", flushIntervalMs: 60_000
    });
    activeExporters.push(exporter);
    try {
      exporter.record({
        traceId, spanId: apiSpanId, parentSpanId: null, name: "POST /api/turns",
        startTimeUnixNano: 1_000_000_000n, endTimeUnixNano: 1_100_000_000n,
        attributes: { "http.request.method": "POST" }, error: false, kind: 2
      });
      recordWorkflowSpan(exporter, sample());
      const header = defaultPayloadConverter.toPayload("00-" + traceId + "-" + workflowSpanId(runId) + "-01");
      const info = {
        activityType: "runCodexAppServerTurn", activityId: "attempt-1", attempt: 2,
        workflowType: "codexAppServerTurnWorkflow", workflowExecution: { workflowId: "workflow:example:001", runId },
        currentAttemptScheduledTimestampMs: 1800
      };
      await observeActivityExecution(info, [{ traceparent: "00-" + traceId + "-" + apiSpanId + "-01", prompt: secretText }],
        async () => "ok", {
          now: () => 1900,
          metrics: createWorkerMetrics(new MetricsRegistry()),
          spans: exporter,
          headers: { "space.w3c.traceparent": header }
        });
      await exporter.flush();
      const spans = received.flatMap(r => r.resourceSpans.flatMap(a => a.scopeSpans.flatMap(b => b.spans)));
      const api = spans.find(s => s.name === "POST /api/turns");
      const workflow = spans.find(s => s.name === "workflow codexAppServerTurnWorkflow");
      const activity = spans.find(s => s.name === "activity runCodexAppServerTurn");
      expect(api).toMatchObject({ traceId, spanId: apiSpanId });
      expect(workflow).toMatchObject({ traceId, parentSpanId: apiSpanId });
      expect(activity).toMatchObject({ traceId, parentSpanId: workflowSpanId(runId) });
      expect(JSON.stringify(received)).not.toContain(secretText);
      expect(exporter.stats()).toMatchObject({ exported: 3, dropped: 0, failed: 0 });
    } finally {
      await new Promise<void>(resolve => collector.close(() => resolve()));
    }
  });
});
