import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Headers } from "@temporalio/workflow";
import { ContinueAsNew } from "@temporalio/workflow";
import { interceptors } from "../src/workflow-tracing.js";
import {
  WORKFLOW_TRACE_CONTEXT_HEADER,
  encodeTraceContextHeader,
  readTraceContextHeaders,
  workflowSpanId,
  type SpaceTraceContext,
  type WorkflowTraceSpan
} from "../src/workflow-trace-context.js";

const temporal = vi.hoisted(() => ({
  patched: vi.fn(() => true),
  exportSpan: vi.fn<(span: WorkflowTraceSpan) => void>(),
  info: {
    workflowId: "workflow:unit", runId: "run:unit", workflowType: "unitWorkflow", taskQueue: "queue:unit",
    runStartTime: new Date(1000), memo: {} as Record<string, unknown>, unsafe: { isReplaying: false }
  }
}));

vi.mock("@temporalio/workflow", () => ({
  ContinueAsNew: class ContinueAsNew extends Error {},
  isCancellation: (value: unknown) => value instanceof Error && value.name === "CancelledFailure",
  patched: temporal.patched,
  proxySinks: () => ({ spaceTracing: { exportSpan: temporal.exportSpan } }),
  workflowInfo: () => temporal.info
}));

const context: SpaceTraceContext = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", flags: 1 };
const requestParent = { traceId: context.traceId, spanId: context.spanId };
const traceparent = `00-${context.traceId}-${context.spanId}-01`;
const args = [{ traceId: "req:unit", traceparent, prompt: "PRIVATE PROMPT token=sk-unit-secret" }];
const headers = (parent: SpaceTraceContext): Headers => ({ [WORKFLOW_TRACE_CONTEXT_HEADER]: encodeTraceContextHeader(parent) });

beforeEach(() => {
  temporal.patched.mockReset().mockReturnValue(true);
  temporal.exportSpan.mockReset();
  temporal.info.runId = "run:unit";
  temporal.info.memo = {};
  temporal.info.unsafe.isReplaying = false;
});

describe("workflow tracing interceptor", () => {
  it("parents from explicit headers before input and memo and exports no input text", async () => {
    const headerParent = { ...context, spanId: "0123456789abcdef" };
    temporal.info.memo = { traceparent: `00-${"a".repeat(32)}-${"b".repeat(16)}-01` };
    const tracer = interceptors();
    const result = await tracer.inbound![0]!.execute!({ args, headers: headers(headerParent) }, async () => ({ status: "ok" }));
    expect(result).toEqual({ status: "ok" });
    expect(temporal.exportSpan).toHaveBeenCalledOnce();
    expect(temporal.exportSpan.mock.calls[0]![0]).toMatchObject({
      traceId: context.traceId, spanId: workflowSpanId("run:unit"), parentSpanId: headerParent.spanId,
      name: "temporal.workflow.unitWorkflow", startTimeUnixNano: "1000000000", error: false,
      attributes: { workflowId: "workflow:unit", runId: "run:unit", traceId: "req:unit", outcome: "COMPLETED" }
    });
    expect(JSON.stringify(temporal.exportSpan.mock.calls)).not.toContain("PRIVATE PROMPT");
  });

  it("uses a memo parent when the workflow input has no context", async () => {
    temporal.info.memo = { traceparent, spaceTraceId: "req:memo" };
    await interceptors().inbound![0]!.execute!({ args: [{ goalId: "goal:one" }], headers: {} }, async () => "ok");
    expect(temporal.exportSpan.mock.calls[0]![0]).toMatchObject({
      traceId: context.traceId, parentSpanId: context.spanId, attributes: { traceId: "req:memo", goalId: "goal:one" }
    });
  });

  it("propagates the actual current span in activities, local activities and same-trace children", async () => {
    const tracer = interceptors();
    const outbound = tracer.outbound![0]!;
    const preserved = { data: new Uint8Array([1]) };
    const captured: Headers[] = [];
    await tracer.inbound![0]!.execute!({ args, headers: {} }, async () => {
      const input = { args, activityType: "unitActivity", options: { startToCloseTimeout: "1m" }, headers: { preserved }, seq: 1 };
      await outbound.scheduleActivity!(input, async activity => { captured.push(activity.headers); return "activity"; });
      await outbound.scheduleLocalActivity!({ ...input, attempt: 1 }, async activity => { captured.push(activity.headers); return "local"; });
      await outbound.startChildWorkflowExecution!({ workflowType: "unitChild", options: { args }, headers: { preserved }, seq: 1 } as never,
        async child => { captured.push(child.headers); return [Promise.resolve("run:child"), Promise.resolve("child")]; });
      return "ok";
    });
    expect(captured).toHaveLength(3);
    for (const outgoing of captured) {
      expect(outgoing.preserved).toBe(preserved);
      expect(readTraceContextHeaders(outgoing)).toEqual({ ...context, spanId: workflowSpanId("run:unit"), requestParent });
    }
  });

  it.each([
    { description: "a new distributed trace", traceId: "0123456789abcdef0123456789abcdef" },
    { description: "a new API span in the same distributed trace", traceId: context.traceId }
  ])("parents later requests to $description and links the long-lived supervisor", async ({ traceId }) => {
    const laterRequest = { traceId, spanId: "0123456789abcdef", flags: 1 };
    const predecessor = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    temporal.info.memo = { traceparent };
    const tracer = interceptors();
    let outgoing: Headers = {};
    await tracer.inbound![0]!.execute!({ args: [], headers: {} }, async () => {
      await tracer.outbound![0]!.startChildWorkflowExecution!({ workflowType: "unitChild", options: { args: [{
        traceparent: `00-${laterRequest.traceId}-${laterRequest.spanId}-01`, traceLink: predecessor
      }] }, headers: {}, seq: 1 } as never, async child => {
        outgoing = child.headers;
        return [Promise.resolve("run:child"), Promise.resolve("child")];
      });
    });
    expect(readTraceContextHeaders(outgoing)).toEqual({ ...laterRequest,
      requestParent: { traceId: laterRequest.traceId, spanId: laterRequest.spanId },
      links: [predecessor, { traceId: context.traceId, spanId: workflowSpanId("run:unit") }]
    });
  });

  it.each([
    { description: "retained API arguments", inboundArgs: args, origin: {} },
    { description: "header-only API origin", inboundArgs: [], origin: { requestParent } }
  ])("keeps a grandchild under its workflow parent with $description", async ({ inboundArgs, origin }) => {
    const workflowParent = { ...context, spanId: workflowSpanId("run:parent"), ...origin };
    const tracer = interceptors();
    let outgoing: Headers = {};
    await tracer.inbound![0]!.execute!({ args: inboundArgs, headers: headers(workflowParent) }, async () => {
      await tracer.outbound![0]!.startChildWorkflowExecution!({ workflowType: "unitGrandchild", options: { args }, headers: {}, seq: 1 } as never,
        async child => { outgoing = child.headers; return [Promise.resolve("run:grandchild"), Promise.resolve("ok")]; });
    });
    expect(readTraceContextHeaders(outgoing)).toEqual({ ...context, spanId: workflowSpanId("run:unit"), requestParent });
    expect(temporal.exportSpan.mock.calls[0]![0].parentSpanId).toBe(workflowParent.spanId);
  });

  it("automatically links continue-as-new to the preceding run's actual span", async () => {
    const tracer = interceptors();
    let continuedHeaders: Headers = {};
    const continued = new ContinueAsNew({} as never);
    await expect(tracer.inbound![0]!.execute!({ args, headers: {} }, async () =>
      tracer.outbound![0]!.continueAsNew!({ args: [{ unrelated: true }], headers: {}, options: { workflowType: "unitWorkflow" } }, async input => {
        continuedHeaders = input.headers;
        throw continued;
      })
    )).rejects.toBe(continued);
    const predecessor = temporal.exportSpan.mock.calls[0]![0];
    expect(predecessor).toMatchObject({ error: false, attributes: { outcome: "CONTINUED_AS_NEW" } });
    temporal.info.runId = "run:continued";
    const nextRun = interceptors();
    let nextChild: Headers = {};
    await nextRun.inbound![0]!.execute!({ args: [], headers: continuedHeaders }, async () => {
      await nextRun.outbound![0]!.startChildWorkflowExecution!({ workflowType: "unitChild", options: { args }, headers: {}, seq: 1 } as never,
        async child => { nextChild = child.headers; return [Promise.resolve("run:child"), Promise.resolve("ok")]; });
    });
    expect(temporal.exportSpan.mock.calls[1]![0]).toMatchObject({
      traceId: predecessor.traceId, spanId: workflowSpanId("run:continued"), parentSpanId: predecessor.spanId,
      links: [{ traceId: predecessor.traceId, spanId: predecessor.spanId }]
    });
    expect(readTraceContextHeaders(nextChild)).toEqual({ ...context, spanId: workflowSpanId("run:continued"), requestParent });
  });

  it("leaves historical commands untouched and emits no span without a patch marker", async () => {
    temporal.patched.mockReturnValue(false);
    const tracer = interceptors();
    const input = { args, activityType: "unitActivity", options: { startToCloseTimeout: "1m" }, headers: {}, seq: 1 };
    const next = vi.fn(async value => { expect(value).toBe(input); return "ok"; });
    await tracer.inbound![0]!.execute!({ args, headers: {} }, async () => tracer.outbound![0]!.scheduleActivity!(input, next));
    expect(temporal.patched).toHaveBeenCalledWith("space-worker-tracing-v1");
    expect(next).toHaveBeenCalledOnce();
    expect(temporal.exportSpan).not.toHaveBeenCalled();
  });

  it("recreates headers deterministically during replay but never exports duplicate spans", async () => {
    temporal.info.unsafe.isReplaying = true;
    const tracer = interceptors();
    await tracer.inbound![0]!.execute!({ args, headers: {} }, async () => tracer.outbound![0]!.scheduleActivity!({
      args, activityType: "unitActivity", options: { startToCloseTimeout: "1m" }, headers: {}, seq: 1
    }, async input => {
      expect(readTraceContextHeaders(input.headers)).toEqual({ ...context, spanId: workflowSpanId("run:unit"), requestParent });
    }));
    expect(temporal.exportSpan).not.toHaveBeenCalled();
  });

  it("preserves workflow errors without exporting their private details", async () => {
    const failure = new Error("PRIVATE ERROR token=sk-unit-secret");
    await expect(interceptors().inbound![0]!.execute!({ args, headers: {} }, async () => { throw failure; })).rejects.toBe(failure);
    expect(temporal.exportSpan.mock.calls[0]![0]).toMatchObject({ error: true, attributes: { outcome: "FAILED" } });
    expect(JSON.stringify(temporal.exportSpan.mock.calls)).not.toContain("sk-unit-secret");
  });

  it("marks a returned FAILED result without inspecting its message", async () => {
    const result = { status: "FAILED", message: "PRIVATE RESULT token=sk-unit-secret" };
    await expect(interceptors().inbound![0]!.execute!({ args, headers: {} }, async () => result)).resolves.toBe(result);
    expect(temporal.exportSpan.mock.calls[0]![0]).toMatchObject({ error: true, attributes: { outcome: "FAILED_RESULT" } });
    expect(JSON.stringify(temporal.exportSpan.mock.calls)).not.toContain("sk-unit-secret");
  });

  it("never lets a sink failure change the workflow result or thrown failure", async () => {
    temporal.exportSpan.mockImplementation(() => { throw new Error("sink unavailable"); });
    await expect(interceptors().inbound![0]!.execute!({ args, headers: {} }, async () => "ok")).resolves.toBe("ok");
    const failure = new Error("workflow failure");
    await expect(interceptors().inbound![0]!.execute!({ args, headers: {} }, async () => { throw failure; })).rejects.toBe(failure);
  });
});
