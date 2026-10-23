import { describe, expect, it, vi } from "vitest";
import { createWorkflowTelemetrySinks } from "../src/workflow-telemetry-sink.js";
import type { ServerSpan, SpanExporter } from "@space/runtime";

function fakeExporter() {
  const spans: ServerSpan[] = [];
  const exporter: SpanExporter = {
    record: (span) => { spans.push(span); },
    flush: async () => {},
    close: async () => {},
    stats: () => ({ exported: spans.length, dropped: 0, failed: 0 })
  };
  return { exporter, spans };
}

const info = (overrides: Record<string, unknown> = {}) => ({
  workflowId: "workflow:test:1",
  runId: "3b2a1f4e-8c7d-4a1b-9e2f-5d6c7b8a9e0f",
  workflowType: "testWorkflow",
  ...overrides
}) as never;

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentSpanId = "00f067aa0ba902b7";

describe("workflow telemetry sink", () => {
  it("records one INTERNAL span per workflow execution with parent and attributes", () => {
    const { exporter, spans } = fakeExporter();
    const sinks = createWorkflowTelemetrySinks(exporter);
    const spanId = "3b2a1f4e8c7d4a1b";

    sinks.workflowTelemetry.workflowStarted.fn(info(), JSON.stringify({
      traceId,
      spanId,
      parentSpanId,
      name: "workflow testWorkflow",
      attributes: { "space.trace_id": "req:abcdefghijkl", "space.room_id": "room:alpha01" },
      links: []
    }));
    expect(spans).toHaveLength(0);

    sinks.workflowTelemetry.workflowCompleted.fn(info(), JSON.stringify({ spanId, status: "COMPLETED" }));
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.traceId).toBe(traceId);
    expect(span.spanId).toBe(spanId);
    expect(span.parentSpanId).toBe(parentSpanId);
    expect(span.name).toBe("workflow testWorkflow");
    expect(span.kind).toBe(1);
    expect(span.error).toBe(false);
    expect(span.attributes["space.trace_id"]).toBe("req:abcdefghijkl");
    expect(span.attributes["space.room_id"]).toBe("room:alpha01");
    expect(span.attributes["space.workflow_type"]).toBe("testWorkflow");
    expect(span.attributes["space.status"]).toBe("COMPLETED");
    expect(span.links).toEqual([]);
  });

  it("marks failed workflows with error code and redacts unsafe values", () => {
    const { exporter, spans } = fakeExporter();
    const sinks = createWorkflowTelemetrySinks(exporter);
    const spanId = "aaaaaaaaaaaaaaaa";

    sinks.workflowTelemetry.workflowStarted.fn(info(), JSON.stringify({
      traceId,
      spanId,
      parentSpanId: null,
      name: "workflow testWorkflow",
      attributes: { "space.prompt": "PRIVATE PROMPT: sk-live-123", "space.trace_id": "req:abcdefghijkl" },
      links: [{ traceId, spanId: "bbbbbbbbbbbbbbbb" }]
    }));
    sinks.workflowTelemetry.workflowCompleted.fn(info(), JSON.stringify({ spanId, status: "FAILED", errorCode: "WORKFLOW_ERROR" }));

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.error).toBe(true);
    expect(span.parentSpanId).toBeNull();
    expect(span.attributes["space.error_code"]).toBe("WORKFLOW_ERROR");
    expect(span.attributes["space.prompt"]).toBeUndefined();
    expect(JSON.stringify(span.attributes)).not.toContain("sk-live-123");
    expect(span.links).toEqual([{ traceId, spanId: "bbbbbbbbbbbbbbbb" }]);
  });

  it("drops spans with invalid ids and ignores unknown completions", () => {
    const { exporter, spans } = fakeExporter();
    const sinks = createWorkflowTelemetrySinks(exporter);

    sinks.workflowTelemetry.workflowStarted.fn(info(), JSON.stringify({
      traceId: "not-hex",
      spanId: "xyz",
      parentSpanId: null,
      name: "workflow testWorkflow",
      attributes: {},
      links: []
    }));
    sinks.workflowTelemetry.workflowCompleted.fn(info(), JSON.stringify({ spanId: "does-not-exist", status: "COMPLETED" }));
    expect(spans).toHaveLength(0);
  });

  it("is a no-op when the exporter is null (export off)", () => {
    const sinks = createWorkflowTelemetrySinks(null);
    expect(() => {
      sinks.workflowTelemetry.workflowStarted.fn(info(), JSON.stringify({ traceId, spanId: "aaaaaaaaaaaaaaaa" }));
      sinks.workflowTelemetry.workflowCompleted.fn(info(), JSON.stringify({ spanId: "aaaaaaaaaaaaaaaa", status: "COMPLETED" }));
    }).not.toThrow();
  });

  it("bounds the pending span map", () => {
    const { exporter } = fakeExporter();
    const sinks = createWorkflowTelemetrySinks(exporter);
    for (let i = 0; i < 5000; i++) {
      const spanId = i.toString(16).padStart(16, "0");
      sinks.workflowTelemetry.workflowStarted.fn(info(), JSON.stringify({
        traceId,
        spanId,
        parentSpanId: null,
        name: "workflow testWorkflow",
        attributes: {},
        links: []
      }));
    }
    // Should not throw or grow unbounded; completing the last one works.
    const lastSpanId = (4999).toString(16).padStart(16, "0");
    expect(() => {
      sinks.workflowTelemetry.workflowCompleted.fn(info(), JSON.stringify({ spanId: lastSpanId, status: "COMPLETED" }));
    }).not.toThrow();
  });
});
