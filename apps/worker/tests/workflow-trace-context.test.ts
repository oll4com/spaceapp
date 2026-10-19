import { describe, expect, it, vi } from "vitest";
import {
  WORKFLOW_TRACE_CONTEXT_HEADER,
  encodeTraceContextHeader,
  mergeTraceLinks,
  readTraceContextHeaders,
  sanitizeTraceAttributes,
  traceContextFromArgs,
  traceContextFromMemo,
  traceCorrelationAttributes,
  traceLinksFromArgs,
  workflowSpanId,
  workflowTraceId,
  type SpaceTraceContext
} from "../src/workflow-trace-context.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${spanId}-01`;
const context: SpaceTraceContext = { traceId, spanId, flags: 1 };
const secret = "PRIVATE PROMPT /home/operator/private.txt token=sk-secret";

describe("workflow trace context", () => {
  it("round-trips an explicit Temporal header and strips unrelated data", () => {
    const header = encodeTraceContextHeader({ ...context, prompt: secret, links: [{ traceId, spanId, result: secret }] } as SpaceTraceContext);
    expect(new TextDecoder().decode(header.metadata!.encoding!)).toBe("json/plain");
    expect(readTraceContextHeaders({ [WORKFLOW_TRACE_CONTEXT_HEADER]: header })).toEqual({ ...context, links: [{ traceId, spanId }] });
    expect(new TextDecoder().decode(header.data!)).not.toContain(secret);
  });

  it("ignores malformed, oversized and invalid incoming headers", () => {
    const encode = (value: unknown) => ({
      metadata: { encoding: new TextEncoder().encode("json/plain") },
      data: new TextEncoder().encode(JSON.stringify(value))
    });
    for (const invalid of [
      { ...context, traceId: "req:application-id" },
      { ...context, traceId: "0".repeat(32) },
      { ...context, spanId: "0".repeat(16) },
      { ...context, flags: "01" },
      { ...context, flags: -1 },
      { ...context, flags: 256 },
      { ...context, flags: 0.5 },
      { ...context, secret: "x".repeat(4096) },
      null
    ]) expect(readTraceContextHeaders({ [WORKFLOW_TRACE_CONTEXT_HEADER]: encode(invalid) })).toBeNull();
    expect(readTraceContextHeaders({ [WORKFLOW_TRACE_CONTEXT_HEADER]: { data: new Uint8Array([255]) } })).toBeNull();
    expect(readTraceContextHeaders({ [WORKFLOW_TRACE_CONTEXT_HEADER]: { ...encode(context), data: new Uint8Array([123]) } })).toBeNull();
    expect(readTraceContextHeaders({})).toBeNull();
    expect(readTraceContextHeaders(undefined)).toBeNull();
  });

  it("carries only validated API parent identifiers through the header", () => {
    const requestParent = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    const encode = (origin: unknown) => encodeTraceContextHeader({ ...context, requestParent: origin } as SpaceTraceContext);
    expect(readTraceContextHeaders({ [WORKFLOW_TRACE_CONTEXT_HEADER]: encode({ ...requestParent, prompt: secret }) }))
      .toEqual({ ...context, requestParent });
    expect(readTraceContextHeaders({ [WORKFLOW_TRACE_CONTEXT_HEADER]: encode({ traceId: "req:application-id", spanId }) }))
      .toEqual(context);
  });

  it("accepts only explicit W3C fields in known input wrappers or memo", () => {
    expect(traceContextFromArgs([{ traceId: "req:application-id", prompt: secret }])).toBeNull();
    expect(traceContextFromArgs([{ metadata: { traceparent } }])).toBeNull();
    expect(traceContextFromArgs([{ item: { turn: { traceparent, traceId: "req:application-id" } } }])).toEqual(context);
    expect(traceContextFromMemo({ traceparent, spaceTraceId: "req:application-id", prompt: secret })).toEqual(context);
    expect(traceContextFromArgs([{ traceparent: `00-${"0".repeat(32)}-${spanId}-01` }])).toBeNull();
    expect(traceContextFromArgs([{ traceparent: `${traceparent}-unexpected` }])).toBeNull();
  });

  it("reads actual predecessor links separately from the parent and bounds them", () => {
    const predecessor = { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" };
    const args = [{ traceparent, traceLink: { ...predecessor, transcript: secret } }];
    expect(traceLinksFromArgs(args)).toEqual([predecessor]);
    expect(traceContextFromArgs(args)).toEqual({ ...context, links: [predecessor] });
    expect(traceLinksFromArgs([{ traceLink: { traceId: "req:old-request", spanId } }])).toEqual([]);
    const distinctLinks = Array.from({ length: 20 }, (_, index) => ({ traceId, spanId: (index + 1).toString(16).padStart(16, "0") }));
    expect(mergeTraceLinks([predecessor, predecessor], distinctLinks)).toHaveLength(8);
    expect(mergeTraceLinks([predecessor, predecessor], distinctLinks)[0]).toEqual(predecessor);
  });

  it("keeps identifiers and bounded numeric fields while dropping free text", () => {
    const value = sanitizeTraceAttributes({
      traceId: "req:application-id", w3cTraceId: traceId, workflowId: "workflow:example", runId: "run:one",
      activityType: "runWork", attempt: 2, durationMs: 3.5, reasonCode: "ACTIVITY_ERROR", outcome: "FAILED",
      prompt: secret, message: secret, stack: secret, headers: { authorization: secret },
      taskQueue: "/home/operator/private", roomId: "includes spaces", unknownIdentifier: "looks_safe"
    });
    expect(value).toEqual({
      traceId: "req:application-id", w3cTraceId: traceId, workflowId: "workflow:example", runId: "run:one",
      activityType: "runWork", attempt: 2, durationMs: 3.5, reasonCode: "ACTIVITY_ERROR", outcome: "FAILED"
    });
    expect(sanitizeTraceAttributes({ reasonCode: "free-text", attempt: 1.5, durationMs: Infinity, workflowId: "x".repeat(201) })).toEqual({});
    expect(sanitizeTraceAttributes({ attempt: -1, durationMs: -1, w3cTraceId: "req:application-id" })).toEqual({});
    expect(traceCorrelationAttributes([{ item: { missionId: "mission:one", turn: {
      traceId: "req:application-id", roomId: "room:one", paneId: "pane:one", prompt: secret
    } } }])).toEqual({ missionId: "mission:one", traceId: "req:application-id", roomId: "room:one", paneId: "pane:one" });
  });

  it("rejects uppercase W3C ids and avoids self-parenting", () => {
    const uppercaseTraceparent = traceparent.toUpperCase();
    expect(traceContextFromMemo({ traceparent: uppercaseTraceparent })).toBeNull();
    expect(traceContextFromArgs([{ traceparent: uppercaseTraceparent }])).toBeNull();
    expect(traceCorrelationAttributes([{ requestId: "req:same" }], {
      spaceTraceId: "req:same", parentSpaceTraceId: "req:earlier"
    })).toEqual({ traceId: "req:same", parentTraceId: "req:earlier" });
    expect(traceCorrelationAttributes([{ traceId: "req:same", requestId: "req:same" }], {
      spaceTraceId: "req:same", parentSpaceTraceId: "req:same"
    })).toEqual({ traceId: "req:same" });
  });

  it("derives stable distinct run identifiers without consuming workflow randomness", () => {
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("Workflow RNG must not be consumed"); });
    try {
      const first = workflowSpanId("run:one");
      expect(first).toMatch(/^[0-9a-f]{16}$/);
      expect(first).not.toBe("0".repeat(16));
      expect(workflowSpanId("run:one")).toBe(first);
      expect(workflowSpanId("run:two")).not.toBe(first);
      expect(workflowTraceId("run:one")).toMatch(/^[0-9a-f]{32}$/);
      expect(workflowTraceId("run:one")).not.toBe(workflowTraceId("run:two"));
      expect(random).not.toHaveBeenCalled();
    } finally { random.mockRestore(); }
  });
});
