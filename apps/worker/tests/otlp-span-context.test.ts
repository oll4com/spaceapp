import { describe, expect, it } from "vitest";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import {
  SPAN_ATTRIBUTE_ALLOWLIST,
  backgroundContinuationFromArgs,
  sanitizeSpanAttributes,
  spanIdFromRunId,
  traceIdFromRunId,
  traceparentFromArgs,
  traceparentFromHeaders,
  traceparentHeaderPayload
} from "../src/otlp-span-context.js";
import { createOtlpSpanSinks } from "../src/otlp-span-sink.js";

const API_TRACE_ID = "a".repeat(32);
const API_SPAN_ID = "b".repeat(16);
const API_TRACEPARENT = `00-${API_TRACE_ID}-${API_SPAN_ID}-01`;

describe("span id derivation", () => {
  it("is deterministic for a run id and differs across runs", () => {
    expect(spanIdFromRunId("run-1")).toBe(spanIdFromRunId("run-1"));
    expect(spanIdFromRunId("run-1")).not.toBe(spanIdFromRunId("run-2"));
    expect(spanIdFromRunId("run-1")).toMatch(/^[0-9a-f]{16}$/);
    expect(spanIdFromRunId("run-1")).not.toBe("0000000000000000");
  });

  it("derives a valid trace id for runs without a propagated traceparent", () => {
    expect(traceIdFromRunId("run-1")).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdFromRunId("run-1")).toBe(traceIdFromRunId("run-1"));
    expect(traceIdFromRunId("run-1")).not.toBe(traceIdFromRunId("run-2"));
  });
});

describe("attribute allowlist", () => {
  it("keeps allowlisted ids, types, attempt, outcome, codes and durations", () => {
    const sanitized = sanitizeSpanAttributes({
      "space.workflow_id": "workflow-1",
      "space.run_id": "run-1",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.activity_type": "sendMessage",
      "space.attempt": 2,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "space.duration_ms": 1234,
      "space.room_id": "room-1",
      "space.mission_id": "mission-1"
    });
    expect(sanitized["space.attempt"]).toBe(2);
    expect(sanitized["space.reason_code"]).toBe("CODEX_APP_SERVER_TURN_TIMEOUT");
    expect(Object.keys(sanitized).every((key) => SPAN_ATTRIBUTE_ALLOWLIST.has(key))).toBe(true);
  });

  it("drops prompts, model output, file paths, URLs, error messages and user text", () => {
    const sanitized = sanitizeSpanAttributes({
      "space.room_id": "room-1",
      prompt: "the user's secret prompt",
      "space.prompt": "the user's secret prompt",
      modelOutput: "model output text",
      "error.message": "Error: failed at /home/user/secret.txt with prompt 'secret'",
      filePath: "/home/user/secret.txt",
      url: "https://example.com/private?token=secret",
      message: "user text",
      "space.duration_ms": "not-a-number"
    });
    expect(sanitized).toEqual({ "space.room_id": "room-1" });
    expect(JSON.stringify(sanitized)).not.toContain("secret");
  });

  it("drops non-finite numbers, empty strings and non-scalar values", () => {
    expect(sanitizeSpanAttributes({
      "space.attempt": Number.NaN,
      "space.duration_ms": Number.POSITIVE_INFINITY,
      "space.outcome": "",
      "space.room_id": { nested: true }
    })).toEqual({});
  });
});

describe("trace context extraction", () => {
  it("reads the traceparent from args, turns and queue items", () => {
    expect(traceparentFromArgs([{ traceparent: API_TRACEPARENT }])?.traceId).toBe(API_TRACE_ID);
    expect(traceparentFromArgs([{ turn: { traceparent: API_TRACEPARENT } }])?.parentId).toBe(API_SPAN_ID);
    expect(traceparentFromArgs([{ item: { turn: { traceparent: API_TRACEPARENT } } }])?.traceId).toBe(API_TRACE_ID);
    expect(traceparentFromArgs([{ turn: { prompt: "no trace here" } }])).toBeNull();
    expect(traceparentFromArgs([{ traceparent: "not-a-traceparent" }])).toBeNull();
  });

  it("round-trips the Temporal header payload", () => {
    const headers = { "space-traceparent": traceparentHeaderPayload(API_TRACEPARENT) };
    expect(traceparentFromHeaders(headers)).toBe(API_TRACEPARENT);
    expect(traceparentFromHeaders({})).toBeNull();
    expect(traceparentFromHeaders({ "space-traceparent": { data: new TextEncoder().encode("x"), metadata: { encoding: new TextEncoder().encode("json/plain") } } })).toBeNull();
  });

  it("detects background continuations and their source run", () => {
    const continuation = backgroundContinuationFromArgs([{
      item: { turn: { traceId: "trace:bg-123", roomAgentContinuation: { sourceRunId: "agent_run:source", generation: 2 } } }
    }]);
    expect(continuation).toEqual({ sourceRunId: "agent_run:source", generation: 2, backgroundTraceId: "trace:bg-123" });
    expect(backgroundContinuationFromArgs([{ turn: { prompt: "plain" } }])).toBeNull();
  });
});

function fakeExporter(): { exporter: SpanExporter; recorded: ServerSpan[] } {
  const recorded: ServerSpan[] = [];
  return {
    recorded,
    exporter: {
      record: (span) => { recorded.push(span); },
      flush: async () => {},
      close: async () => {},
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    }
  };
}

describe("workflow span sink", () => {
  it("does not call the exporter during replay (callDuringReplay is false)", () => {
    const sinks = createOtlpSpanSinks(null);
    const sink = sinks.otlp.exportWorkflowSpan;
    expect(typeof sink).toBe("object");
    if (typeof sink === "object") expect(sink.callDuringReplay).toBe(false);
  });

  it("records spans handed over from the sandbox, re-sanitizing attributes", () => {
    const { exporter, recorded } = fakeExporter();
    const sinks = createOtlpSpanSinks(exporter);
    const sink = sinks.otlp.exportWorkflowSpan;
    const fn = typeof sink === "function" ? sink : sink.fn;
    fn({ workflowId: "w", runId: "r" } as never, {
      traceId: API_TRACE_ID,
      spanId: API_SPAN_ID,
      parentSpanId: null,
      name: "workflow/probe",
      kind: 1,
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
      attributes: { "space.workflow_type": "probe", prompt: "secret prompt" },
      error: false
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.startTimeUnixNano).toBe(1000000n);
    expect(recorded[0]!.attributes).toEqual({ "space.workflow_type": "probe" });
  });

  it("forwards span links from the sandbox payload to the exporter", () => {
    const { exporter, recorded } = fakeExporter();
    const sinks = createOtlpSpanSinks(exporter);
    const sink = sinks.otlp.exportWorkflowSpan;
    const fn = typeof sink === "function" ? sink : sink.fn;
    fn({ workflowId: "w", runId: "r2" } as never, {
      traceId: API_TRACE_ID,
      spanId: "c".repeat(16),
      parentSpanId: null,
      name: "workflow/probe",
      kind: 1,
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
      attributes: { "space.workflow_type": "probe" },
      error: false,
      links: [{ traceId: API_TRACE_ID, spanId: API_SPAN_ID, attributes: { "space.link.type": "continue_as_new" } }]
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.links).toEqual([{
      traceId: API_TRACE_ID,
      spanId: API_SPAN_ID,
      attributes: { "space.link.type": "continue_as_new" }
    }]);
  });

  it("is a no-op when no exporter is configured", () => {
    const sinks = createOtlpSpanSinks(null);
    const sink = sinks.otlp.exportWorkflowSpan;
    const fn = typeof sink === "function" ? sink : sink.fn;
    expect(() => fn({ workflowId: "w", runId: "r" } as never, {
      traceId: API_TRACE_ID,
      spanId: API_SPAN_ID,
      parentSpanId: null,
      name: "workflow/probe",
      kind: 1,
      startTimeUnixNano: "1000000",
      endTimeUnixNano: "2000000",
      attributes: {},
      error: false
    })).not.toThrow();
  });
});
