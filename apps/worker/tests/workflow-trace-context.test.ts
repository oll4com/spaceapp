import { describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { workflowTraceSpanId } from "@space/contracts";
import { inputTrace, readTraceCarrier, traceHeaders, WORKFLOW_TRACE_HEADER } from "../src/workflow-trace-context.js";
import { allowlistedTraceAttributes, workerTracingOptions } from "../src/worker-tracing.js";

const traceparent = "00-11111111111111111111111111111111-2222222222222222-01";

describe("workflow tracing wire contract", () => {
  it("roundtrips context and keeps unrelated headers", () => {
    const other = defaultPayloadConverter.toPayload("other")!;
    const headers = traceHeaders({ other }, { traceparent, requestTraceparent: traceparent });
    expect(headers.other).toBe(other);
    expect(readTraceCarrier(headers)).toMatchObject({ traceparent, requestTraceparent: traceparent });
    expect(readTraceCarrier({ [WORKFLOW_TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceparent: "invalid" })! })).toBeNull();
    expect(readTraceCarrier({ [WORKFLOW_TRACE_HEADER]: { data: new Uint8Array(3000) } })).toBeNull();
  });

  it("reads correlation only at known input locations", () => {
    expect(inputTrace([{ turn: { traceparent, prompt: "PRIVATE" } }])).toEqual({ traceparent, link: undefined });
    expect(inputTrace([{ prompt: { traceparent }, metadata: { traceparent } }])).toEqual({ traceparent: undefined, link: undefined });
  });

  it("uses stable run/attempt IDs without sharing IDs between attempts", () => {
    expect(workflowTraceSpanId("run:activity:1")).toBe(workflowTraceSpanId("run:activity:1"));
    expect(workflowTraceSpanId("run:activity:1")).not.toBe(workflowTraceSpanId("run:activity:2"));
    expect(workflowTraceSpanId("run:activity:1")).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rejects private content, unbounded fields, paths and URLs at the export boundary", () => {
    expect(allowlistedTraceAttributes({ "prompt": "PRIVATE", "error.message": "PRIVATE",
      "temporal.workflow_type": "https://private.example/path", "space.room_id": "/home/private",
      "space.outcome": "PRIVATE", "space.duration_ms": Infinity, "temporal.attempt": -1,
      "temporal.run_id": "run:1", "space.reason_code": "ACTIVITY_TIMEOUT" })).toEqual({
        "temporal.run_id": "run:1", "space.reason_code": "ACTIVITY_TIMEOUT", "space.category": "TIMEOUT"
      });
  });

  it("keeps the history-compatible interceptor installed when export is off", () => {
    const options = workerTracingOptions(null);
    expect(options.interceptors?.workflowModules).toHaveLength(1);
    expect(options.sinks?.spaceTracing?.record.callDuringReplay).toBe(false);
  });
});
