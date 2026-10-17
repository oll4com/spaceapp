import { describe, expect, it, vi } from "vitest";
import {
  MAX_TRACE_LINKS,
  TRACE_CONTEXT_HEADER,
  findBackgroundTrace,
  findTraceContext,
  findTraceLinks,
  isSpanId,
  isTraceId,
  readTraceHeader,
  sanitizeTraceAttributes,
  sanitizeTraceContext,
  sanitizeTraceLinks,
  traceCorrelationAttributes,
  traceContextFromTraceparent,
  traceparentFromContext,
  withTraceHeader,
  workflowSpanId,
  workflowTraceId
} from "../src/tracing-protocol.js";

const context = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", flags: "01" };
const traceparent = `00-${context.traceId}-${context.spanId}-01`;
const privateText = "PRIVATE PROMPT token sk-live-secret /home/operator/private.txt https://private.example/?secret=true";

describe("workflow tracing protocol", () => {
  it("requires nonzero W3C ids, rejects malformed contexts, and roundtrips a traceparent", () => {
    expect(traceContextFromTraceparent(traceparent)).toEqual(context);
    expect(traceContextFromTraceparent(` ${traceparent.toUpperCase()} `)).toEqual(context);
    expect(traceparentFromContext(context)).toBe(traceparent);
    for (const invalid of [undefined, privateText, traceparent.replace(context.traceId, "0".repeat(32)), traceparent.replace(context.spanId, "0".repeat(16)), `${traceparent}-extra`, traceparent.replace(/^00/, "ff")]) {
      expect(traceContextFromTraceparent(invalid)).toBeNull();
    }
    expect(sanitizeTraceContext({ ...context, flags: privateText })).toBeNull();
    expect(sanitizeTraceContext({ ...context, spanId: context.spanId.toUpperCase() })).toBeNull();
    expect(sanitizeTraceContext({ ...context, prompt: privateText })).toEqual(context);
  });

  it("preserves unrelated payload headers without mutation and serializes only allowed envelope fields", () => {
    const original = { other: { data: new Uint8Array([1, 2, 3]) } };
    const envelope = { context: { ...context, prompt: privateText }, links: [{ ...context, message: privateText }] };
    const headers = withTraceHeader(original, envelope);
    expect(headers.other).toBe(original.other);
    expect(Object.keys(original)).toEqual(["other"]);
    expect(readTraceHeader(headers)).toEqual({ context, links: [{ traceId: context.traceId, spanId: context.spanId }] });
    expect(new TextDecoder().decode(headers[TRACE_CONTEXT_HEADER]!.data!)).not.toContain("PRIVATE");
    expect(withTraceHeader(original, { context: { ...context, spanId: "0".repeat(16) } })).toBe(original);
  });

  it("fails closed on invalid, oversized and non-ASCII headers", () => {
    for (const data of [new Uint8Array(), new Uint8Array(4097), new Uint8Array([255]), new TextEncoder().encode("{malformed")]) {
      expect(readTraceHeader({ [TRACE_CONTEXT_HEADER]: { data } })).toBeNull();
    }
    expect(readTraceHeader(undefined)).toBeNull();
    expect(readTraceHeader(withTraceHeader({}, { context, continuation: true, parentSpanId: null }))).toEqual({ context, continuation: true, parentSpanId: null });
    expect(readTraceHeader(withTraceHeader({}, { context, continuation: true, parentSpanId: "0".repeat(16) }))).toBeNull();
  });

  it("looks only in known argument/memo shapes and validates background links", () => {
    expect(findTraceContext([{ item: { turnInput: { traceparent, prompt: privateText } } }])).toEqual(context);
    expect(findTraceContext([{ traceId: context.traceId }], { traceparent })).toEqual(context);
    expect(findTraceContext([{ arbitrary: { traceparent } }])).toBeNull();
    expect(findTraceContext([{ traceparent: privateText }])).toBeNull();
    const background = { roomAgentContinuation: { id: "continuation:1" }, traceparent, traceLinks: [context] };
    expect(findTraceLinks([{ item: { turn: background } }])).toEqual([{ traceId: context.traceId, spanId: context.spanId }]);
    expect(findBackgroundTrace([background])).toEqual({ context, links: [{ traceId: context.traceId, spanId: context.spanId }], root: true, parentSpanId: null });
    expect(findBackgroundTrace([{ ...background, traceLinks: [] }])).toEqual({ context, root: true, parentSpanId: null });
    expect(findBackgroundTrace([{ ...background, roomAgentContinuation: undefined }])).toBeNull();
    expect(findTraceLinks([], { traceLinks: [context] })).toHaveLength(1);
  });

  it("deduplicates links, bounds them and strips arbitrary link attributes", () => {
    const candidates = Array.from({ length: 100 }, (_, index) => ({ traceId: context.traceId, spanId: (index + 1).toString(16).padStart(16, "0"), prompt: privateText }));
    expect(sanitizeTraceLinks(candidates)).toHaveLength(MAX_TRACE_LINKS);
    expect(sanitizeTraceLinks([context, context, { ...context, traceId: "0".repeat(32) }])).toEqual([{ traceId: context.traceId, spanId: context.spanId }]);
    expect(JSON.stringify(sanitizeTraceLinks(candidates))).not.toContain("PRIVATE");
  });

  it("allows only bounded ids, names, outcomes and error codes in attributes", () => {
    expect(sanitizeTraceAttributes({
      "temporal.workflow.type": "dummyTurnWorkflow",
      "temporal.workflow.id": "workflow:room-a",
      "temporal.run.id": "run-uuid-1",
      "temporal.activity.type": "runDummyTurn",
      "temporal.activity.attempt": 2,
      "space.room_id": "room:alpha",
      "space.outcome": "FAILED_RESULT",
      "space.reason_code": "PROVIDER_TIMEOUT",
      "space.failure_category": "TIMEOUT",
      "space.action_id": privateText,
      "space.goal_id": "/home/operator/private.txt",
      "space.turn_id": "https://private.example",
      prompt: privateText,
      "exception.message": privateText,
      "exception.stacktrace": privateText,
      "http.url": privateText
    })).toEqual({
      "temporal.workflow.type": "dummyTurnWorkflow", "temporal.workflow.id": "workflow:room-a", "temporal.run.id": "run-uuid-1",
      "temporal.activity.type": "runDummyTurn", "temporal.activity.attempt": 2, "space.room_id": "room:alpha",
      "space.outcome": "FAILED_RESULT", "space.reason_code": "PROVIDER_TIMEOUT", "space.failure_category": "TIMEOUT"
    });
    expect(sanitizeTraceAttributes({ "space.outcome": privateText, "space.failure_category": "SECRET", "space.reason_code": privateText, "temporal.activity.attempt": Infinity })).toEqual({});
    expect(traceCorrelationAttributes([{ item: { turn: { roomId: "room:a", roomAgentMissionId: "mission:a", prompt: privateText } } }], { spaceTraceId: "req:abc", traceparent })).toEqual({
      "space.trace_id": "req:abc", "space.room_id": "room:a", "space.mission_id": "mission:a"
    });
  });

  it("derives stable distinct ids without consuming workflow random state", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("PRNG must not be used"); });
    try {
      const runId = "8cf9d522-63c9-4a66-9fe2-e2301b2ea468";
      expect(workflowTraceId(runId)).toBe("8cf9d52263c94a669fe2e2301b2ea468");
      expect(workflowSpanId(runId)).toBe(workflowSpanId(runId));
      const spans = Array.from({ length: 100 }, (_, index) => workflowSpanId(`run-${index}`));
      expect(new Set(spans).size).toBe(100);
      expect(spans.every(isSpanId)).toBe(true);
      expect(isTraceId(workflowTraceId("synthetic-run"))).toBe(true);
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });
});
