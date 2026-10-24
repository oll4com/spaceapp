import { expect, it } from "vitest";
import { traceAttributes, traceContextFromArgs } from "../src/trace-propagation.js";
import { createWorkflowTracingOptions } from "../src/workflow-tracing-worker.js";

it("keeps workflow telemetry disabled without a configured exporter", () => {
  expect(createWorkflowTracingOptions(null)).toEqual({});
});

it("exports only bounded identifiers and numeric values from the trace allowlist", () => {
  expect(traceAttributes({
    "space.workflow_id": "workflow:test", "space.attempt": 2,
    "space.room_id": "/home/private", "space.outcome": "FAILED",
    "space.reason_code": "Error contains private text", prompt: "secret",
    url: "https://private.example", "space.duration_ms": Infinity
  })).toEqual({ "space.workflow_id": "workflow:test", "space.attempt": 2, "space.outcome": "FAILED" });
});

it("finds W3C context in queue items without looking at prompts or arbitrary nested data", () => {
  const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";
  expect(traceContextFromArgs([{ turn: { traceparent, prompt: "private text" } }])).toBe(traceparent);
  expect(traceContextFromArgs([{ prompt: traceparent, unrelated: { traceparent } }])).toBeNull();
});
