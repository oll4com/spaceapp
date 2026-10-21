import { describe, expect, it } from "vitest";
import { continuationSourceTraceparent, headersWithSpanContext, resolveWorkflowSpanContext, spanContextFromHeaders, WORKFLOW_SPAN_HEADER } from "../src/workflow-span-context.js";
import { allowlistedWorkerSpanAttributes, workflowSpanOptions, workflowSpanSinks } from "../src/workflow-span-export.js";

const traceId = "1234567890abcdef1234567890abcdef";
const spanId = "1234567890abcdef";
const traceparent = `00-${traceId}-${spanId}-01`;
const resolve = (args: unknown[] = [], headers = {}, memo = {}) => resolveWorkflowSpanContext({ workflowId: "workflow:1", runId: "run:1", args, headers, memo });

describe("workflow trace context", () => {
  it("round trips a bounded validated header and ignores corrupt payloads", () => {
    const headers = headersWithSpanContext({}, { traceId, spanId });
    expect(spanContextFromHeaders(headers)).toEqual({ traceId, spanId });
    expect(spanContextFromHeaders({ [WORKFLOW_SPAN_HEADER]: { data: new Uint8Array(1025) } })).toBeNull();
    expect(spanContextFromHeaders(headersWithSpanContext({}, { traceId: "0".repeat(32), spanId }))).toBeNull();
  });

  it("parents API workflows to the exact exported API span, also from memo", () => {
    expect(resolve([{ traceparent }])).toMatchObject({ context: { traceId }, parentSpanId: spanId });
    expect(resolve([], {}, { traceparent })).toEqual(resolve([{ traceparent }]));
  });

  it("keeps child workflows nested, while a distinct request overrides the supervisor trace", () => {
    const headers = headersWithSpanContext({}, { traceId, spanId: "abcdef1234567890" });
    expect(resolve([{ turn: { traceparent } }], headers).parentSpanId).toBe("abcdef1234567890");
    const other = "fedcba0987654321fedcba0987654321";
    expect(resolve([{ turn: { traceparent: `00-${other}-${spanId}-01` } }], headers))
      .toMatchObject({ context: { traceId: other }, parentSpanId: spanId });
  });

  it("links continue-as-new and background traces without making them children", () => {
    const next = resolve([{ traceparent }], headersWithSpanContext({}, { traceId, spanId, link: true }));
    expect(next).toMatchObject({ context: { traceId }, parentSpanId: null, links: [{ traceId, spanId }] });
    const background = resolve([{ traceId: "trace:bg-1", sourceTraceparent: traceparent }], headersWithSpanContext({}, { traceId, spanId }));
    expect(background.context.traceId).not.toBe(traceId);
    expect(background).toMatchObject({ parentSpanId: null, links: [{ traceId, spanId }] });
    expect(background).toEqual(resolve([{ traceId: "trace:bg-1", sourceTraceparent: traceparent }], headersWithSpanContext({}, { traceId, spanId })));
  });

  it("does not install workflow instrumentation when export is disabled", () => {
    expect(workflowSpanOptions(null)).toEqual({});
    expect(workflowSpanSinks(null)).toBeUndefined();
  });

  it("links successive background continuations to the immediate previous run", () => {
    const firstTurn = { traceId: "trace:bg-first", sourceTraceparent: traceparent };
    const first = resolve([firstTurn]);
    const source = continuationSourceTraceparent({ workflowId: "workflow:1", temporalRunId: "run:1", turn: firstTurn });
    expect(source).toBe(`00-${first.context.traceId}-${first.context.spanId}-01`);
    const next = resolve([{ traceId: "trace:bg-second", sourceTraceparent: source }]);
    expect(next.links).toEqual([{ traceId: first.context.traceId, spanId: first.context.spanId }]);
    expect(next.links[0]?.traceId).not.toBe(traceId);
    expect(continuationSourceTraceparent({ workflowId: "legacy", temporalRunId: null, turn: { traceparent } })).toBe(traceparent);
  });
});

it("enforces an attribute allowlist and validates values, including known-key attacks", () => {
  expect(allowlistedWorkerSpanAttributes({
    "space.workflow_id": "workflow:1", "space.attempt": 2, "space.duration_ms": 42,
    "space.outcome": "FAILED", "space.reason_code": "ACTIVITY_TIMEOUT", "space.category": "TIMEOUT",
    prompt: "secret", output: "secret", path: "/private/file", url: "https://private.example",
    "space.room_id": "/private/file", "space.workflow_type": "https://private.example",
    "space.activity_type": "user supplied text", "space.pane_id": "x".repeat(241),
    "space.trace_id": "has spaces", "space.unknown": "SECRET", message: "SECRET"
  })).toEqual({
    "space.workflow_id": "workflow:1", "space.attempt": 2, "space.duration_ms": 42,
    "space.outcome": "FAILED", "space.reason_code": "ACTIVITY_TIMEOUT", "space.category": "TIMEOUT"
  });
});
