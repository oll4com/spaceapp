import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type OtlpSpan, type SpanExporter } from "@space/runtime";
import { observeActivityExecution } from "../src/activity-observability.js";
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
import { workerOtlp } from "../src/worker-otlp.js";

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

function fakeExporter(): { exporter: SpanExporter; recorded: OtlpSpan[] } {
  const recorded: OtlpSpan[] = [];
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

describe("worker OTLP wiring", () => {
  it("is off (null exporter, no-op sink) when the endpoint is unset", () => {
    const { spanExporter, workerOptions } = workerOtlp("space-worker", {});
    expect(spanExporter).toBeNull();
    expect(workerOptions.sinks).toBeDefined();
    expect(workerOptions.interceptors?.workflowModules).toHaveLength(1);
  });

  it("is off when the endpoint is invalid", () => {
    expect(workerOtlp("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector" }).spanExporter).toBeNull();
  });

  it("creates an exporter when the endpoint is set", () => {
    const { spanExporter } = workerOtlp("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318" });
    expect(spanExporter).not.toBeNull();
    return spanExporter!.close();
  });
});

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
});

describe("shared exporter flush", () => {
  it("still delivers after a flush on an empty queue (no wedged in-flight promise)", async () => {
    const bodies: string[] = [];
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:4318",
      serviceName: "space-worker",
      scopeName: "space-worker",
      flushIntervalMs: 60_000,
      fetch: async (_url, init) => { bodies.push(init.body); return { ok: true }; }
    });
    const span = (spanId: string): OtlpSpan => ({
      traceId: API_TRACE_ID, spanId, parentSpanId: null, name: "probe", kind: 1,
      startTimeUnixNano: 1000000n, endTimeUnixNano: 2000000n, attributes: {}, error: false
    });
    // An idle flush (what the interval timer does between batches) must not
    // disable later flushes.
    await exporter.flush();
    exporter.record(span("1111111111111111"));
    await exporter.flush();
    expect(exporter.stats().exported).toBe(1);
    await exporter.flush();
    exporter.record(span("2222222222222222"));
    await exporter.flush();
    expect(exporter.stats().exported).toBe(2);
    expect(bodies.join("")).toContain("2222222222222222");
    await exporter.close();
  });
});

describe("activity attempt spans", () => {
  const info = {
    activityType: "probeActivity",
    activityId: "activity-1",
    attempt: 2,
    workflowType: "codexAppServerTurnWorkflow",
    workflowExecution: { workflowId: "workflow-1", runId: "run-under-test" },
    currentAttemptScheduledTimestampMs: Date.now() - 5
  };

  it("records one span per attempt, parented to the workflow span, with outcome and codes", async () => {
    const { exporter, recorded } = fakeExporter();
    const failure = new Error("sensitive error message with /paths and prompts");
    await expect(observeActivityExecution(info, [{ roomId: "room-1", prompt: "secret" }], async () => { throw failure; }, {
      spanExporter: exporter,
      traceparent: API_TRACEPARENT,
      now: (() => { let tick = 1000; return () => (tick += 10); })()
    })).rejects.toBe(failure);
    expect(recorded).toHaveLength(1);
    const span = recorded[0]!;
    expect(span.traceId).toBe(API_TRACE_ID);
    expect(span.parentSpanId).toBe(API_SPAN_ID);
    expect(span.name).toBe("activity/probeActivity");
    expect(span.error).toBe(true);
    expect(span.attributes["space.attempt"]).toBe(2);
    expect(span.attributes["space.outcome"]).toBe("FAILED");
    expect(span.attributes["space.reason_code"]).toBe("ACTIVITY_ERROR");
    expect(span.attributes["space.room_id"]).toBe("room-1");
    expect(JSON.stringify(span.attributes)).not.toContain("secret");
  });

  it("parents to the run-derived workflow span when only the args carry the traceparent", async () => {
    const { exporter, recorded } = fakeExporter();
    await observeActivityExecution(info, [{ turn: { traceparent: API_TRACEPARENT } }], async () => "ok", {
      spanExporter: exporter,
      now: (() => { let tick = 5000; return () => (tick += 10); })()
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.traceId).toBe(API_TRACE_ID);
    expect(recorded[0]!.parentSpanId).toBe(spanIdFromRunId("run-under-test"));
    expect(recorded[0]!.error).toBe(false);
  });

  it("records nothing when no exporter is configured", async () => {
    const { exporter, recorded } = fakeExporter();
    await observeActivityExecution(info, [{}], async () => "ok", { spanExporter: null });
    expect(recorded).toHaveLength(0);
    void exporter;
  });
});
