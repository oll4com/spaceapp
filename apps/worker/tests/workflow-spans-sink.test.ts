import { describe, expect, it } from "vitest";
import type { ServerSpan, SpanExporter } from "@space/runtime";
import { recordWorkflowSpan, sanitizeWorkflowSpanEvent, workerSpanSinks } from "../src/workflow-spans-sink.js";
import type { WorkflowSpanEvent } from "../src/workflow-span-context.js";

const secretPrompt = "PRIVATE PROMPT: deploy with token sk-live-worker-secret-123";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";

function fakeExporter() {
  const recorded: ServerSpan[] = [];
  const spans: SpanExporter = {
    record: (span) => recorded.push(span),
    flush: async () => undefined,
    close: async () => undefined,
    stats: () => ({ exported: 0, dropped: 0, failed: 0 })
  };
  return { recorded, spans };
}

function event(overrides: Partial<WorkflowSpanEvent> = {}): WorkflowSpanEvent {
  return {
    traceId,
    spanId: "00f067aa0ba902b7",
    parentSpanId: "1111111111111111",
    name: "workflow tracedRootWorkflow",
    workflowType: "tracedRootWorkflow",
    workflowId: "workflow:trace-test",
    runId: "run-uuid-1",
    attempt: 1,
    startedAtMs: 1_000,
    endedAtMs: 2_500,
    outcome: "COMPLETED",
    attributes: { "space.outcome": "COMPLETED", "space.room_id": "room:alpha01" },
    links: [],
    ...overrides
  };
}

describe("sanitizeWorkflowSpanEvent", () => {
  it("drops every attribute outside the allowlist", () => {
    const sanitized = sanitizeWorkflowSpanEvent(event({
      attributes: { "space.outcome": "COMPLETED", "space.room_id": "room:alpha01", "space.prompt": secretPrompt, prompt: secretPrompt, "space.free_text": "leak" } as Record<string, string | number>
    }));
    expect(sanitized?.attributes).toEqual({ "space.outcome": "COMPLETED", "space.room_id": "room:alpha01" });
  });

  it("rejects events whose ids are not exactly hex", () => {
    expect(sanitizeWorkflowSpanEvent(event({ traceId: "req:abcdefghijkl" }))).toBeNull();
    expect(sanitizeWorkflowSpanEvent(event({ spanId: "nothex" }))).toBeNull();
    expect(sanitizeWorkflowSpanEvent(event({ parentSpanId: "bad parent" }))).toMatchObject({ parentSpanId: null });
  });

  it("caps, validates and normalizes links and timings", () => {
    const sanitized = sanitizeWorkflowSpanEvent(event({
      links: [
        { traceId, spanId: "00f067aa0ba902b7" },
        { traceId: "junk", spanId: "junk" },
        { traceId, spanId: "1111111111111111" },
        { traceId, spanId: "2222222222222222" }
      ] as never,
      startedAtMs: Number.NaN,
      endedAtMs: Number.NaN,
      outcome: "WEIRD" as never
    }));
    expect(sanitized?.links).toEqual([{ traceId, spanId: "00f067aa0ba902b7" }, { traceId, spanId: "1111111111111111" }, { traceId, spanId: "2222222222222222" }]);
    expect(sanitized?.startedAtMs).toBe(0);
    expect(sanitized?.endedAtMs).toBe(0);
    expect(sanitized?.outcome).toBe("COMPLETED");
  });
});

describe("recordWorkflowSpan", () => {
  it("exports a valid workflow span with INTERNAL kind and links", () => {
    const { recorded, spans } = fakeExporter();
    recordWorkflowSpan(spans, event({
      outcome: "CONTINUED",
      links: [{ traceId, spanId: "1111111111111111" }]
    }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      traceId,
      spanId: "00f067aa0ba902b7",
      parentSpanId: "1111111111111111",
      name: "workflow tracedRootWorkflow",
      kind: 1,
      error: false,
      startTimeUnixNano: 1_000_000_000n,
      endTimeUnixNano: 2_500_000_000n,
      links: [{ traceId, spanId: "1111111111111111" }]
    });
  });

  it("marks FAILED outcomes as errors and drops invalid events entirely", () => {
    const { recorded, spans } = fakeExporter();
    recordWorkflowSpan(spans, event({ outcome: "FAILED" }));
    recordWorkflowSpan(spans, event({ traceId: "invalid" }));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].error).toBe(true);
  });
});

describe("workerSpanSinks", () => {
  it("registers nothing when the exporter is off, and never during replay when it is on", () => {
    expect(workerSpanSinks(null)).toBeUndefined();
    const { recorded, spans } = fakeExporter();
    const sinks = workerSpanSinks(spans);
    expect(sinks?.workerSpans.workflowSpan.callDuringReplay).toBe(false);
    sinks?.workerSpans.workflowSpan.fn({ workflowId: "workflow:trace-test" }, event());
    sinks?.workerSpans.workflowSpan.fn({ workflowId: "workflow:trace-test" }, event({ traceId: "junk" }));
    expect(recorded).toHaveLength(1);
  });
});
