import { describe, expect, it } from "vitest";
import type { SpanExporter } from "@space/runtime";
import { workerSpanAttributes } from "../src/workflow-span.js";
import { workflowSpanSinks } from "../src/workflow-observability-worker.js";
import { inputTraceContext, readTraceHeader, traceHeader, TRACE_HEADER, workflowSpanId } from "../src/trace-propagation.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("worker tracing boundary", () => {
  it("exports only approved identifier/status/duration fields and rejects user content", () => {
    expect(workerSpanAttributes({
      "space.workflow_id": "workflow:synthetic", "space.attempt": 2, "space.duration_ms": 3.5,
      "space.reason_code": "UPSTREAM_TIMEOUT", "space.category": "TIMEOUT",
      prompt: "private", modelOutput: "private", url: "https://private.test",
      "space.prompt": "private", "space.room_id": "/private/path", "space.pane_id": "user text with spaces",
      "space.queue_ms": Infinity, "space.trace_id": { prompt: "private" }
    })).toEqual({
      "space.workflow_id": "workflow:synthetic", "space.attempt": 2, "space.duration_ms": 3.5,
      "space.reason_code": "UPSTREAM_TIMEOUT", "space.category": "TIMEOUT"
    });
  });

  it("does not let a failing exporter or malformed sink record fail a workflow task", () => {
    const spans: SpanExporter = {
      record: () => { throw new Error("collector failure"); }, flush: async () => undefined,
      close: async () => undefined, stats: () => ({ exported: 0, dropped: 0, failed: 0 })
    };
    const record = workflowSpanSinks(spans).spaceTracing.record;
    expect(record.callDuringReplay).toBe(false);
    const span = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", parentSpanId: null,
      startTimeMs: 1, endTimeMs: 2, error: false, attributes: { "space.workflow_type": "dummyTurnWorkflow" } };
    expect(() => record.fn({} as any, span)).not.toThrow();
    expect(() => record.fn({} as any, { ...span, startTimeMs: Infinity })).not.toThrow();
  });

  it("round-trips converter headers, rejects malformed contexts and reads only context containers", () => {
    expect(readTraceHeader({ [TRACE_HEADER]: traceHeader(traceparent) })).toBe(traceparent);
    expect(readTraceHeader({ [TRACE_HEADER]: { data: new Uint8Array(601) } })).toBeNull();
    expect(readTraceHeader({ [TRACE_HEADER]: { data: new Uint8Array([123]) } })).toBeNull();
    expect(readTraceHeader({ [TRACE_HEADER]: traceHeader("private text") })).toBeNull();
    expect(inputTraceContext([{ prompt: { traceparent } }])).toBeNull();
    expect(inputTraceContext([{ item: { turn: { traceparent } } }])).toBe(traceparent);
    expect(workflowSpanId("run:synthetic")).toMatch(/^[0-9a-f]{16}$/);
    expect(workflowSpanId("run:synthetic")).toBe(workflowSpanId("run:synthetic"));
    expect(workflowSpanId("run:other")).not.toBe(workflowSpanId("run:synthetic"));
  });
});
