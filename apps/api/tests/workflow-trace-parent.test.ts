// Workflows started by the API name the request's exported SERVER span as
// their trace parent, so the worker's workflow span joins the request trace.
import { parseTraceparent } from "@space/contracts";
import { describe, expect, it } from "vitest";
import { TraceContextRegistry, createRequestTraceContext, requestWorkflowMemo, traceparentForTraceId } from "../src/trace-context.js";

const inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("workflow trace parent", () => {
  it("is the request's own SERVER span, the one the API exports", () => {
    const registry = new TraceContextRegistry();
    const request = createRequestTraceContext(inbound);
    registry.remember("req:one", request);
    const parent = traceparentForTraceId("req:one", registry);
    expect(parent).toBe(request.traceparent);
    expect(parseTraceparent(parent)).toEqual({ traceId: request.w3cTraceId, parentId: request.spanId, flags: "01" });
    expect(traceparentForTraceId("req:unknown", registry)).toBeNull();
    expect(traceparentForTraceId(null, registry)).toBeNull();
  });

  it("puts the request trace on the memo of workflows the API starts", () => {
    const registry = new TraceContextRegistry();
    const request = createRequestTraceContext(inbound);
    registry.remember("req:two", request);
    expect(requestWorkflowMemo("req:two", registry)).toEqual({ spaceTraceId: "req:two", traceparent: request.traceparent, w3cTraceId: request.w3cTraceId });
    expect(requestWorkflowMemo("req:unknown", registry)).toBeUndefined();
    expect(requestWorkflowMemo(undefined, registry)).toBeUndefined();
  });
});
