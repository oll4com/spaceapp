import { CancelledFailure } from "@temporalio/common";
import { ContinueAsNew, type WorkflowOutboundCallsInterceptor } from "@temporalio/workflow";
import { describe, expect, it } from "vitest";
import { createWorkflowTracingInterceptors, type WorkflowTracingDependencies } from "../src/workflow-tracing.js";
import { readTraceHeader, withTraceHeader, workflowSpanId, workflowTraceId, type TraceEnvelope, type WorkflowTraceSpan } from "../src/tracing-protocol.js";

const api = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7", flags: "01" };
const traceparent = `00-${api.traceId}-${api.spanId}-01`;
const runId = "8cf9d522-63c9-4a66-9fe2-e2301b2ea468";
const privateText = "PRIVATE PROMPT /home/operator/private.txt token sk-live-secret https://private.example";

function harness(overrides: Partial<ReturnType<WorkflowTracingDependencies["info"]>> = {}, record?: WorkflowTracingDependencies["record"]) {
  const spans: WorkflowTraceSpan[] = [];
  const interceptors = createWorkflowTracingInterceptors({
    info: () => ({ runId, workflowId: "workflow:synthetic", workflowType: "dummyTurnWorkflow", runStartTime: new Date(100), ...overrides }),
    now: () => 250,
    record: record ?? (span => spans.push(span))
  });
  return { spans, inbound: interceptors.inbound![0]!, outbound: interceptors.outbound![0]! };
}

type OutboundInput<K extends keyof WorkflowOutboundCallsInterceptor> = Parameters<NonNullable<WorkflowOutboundCallsInterceptor[K]>>[0];
const activity = { activityType: "runDummyTurn", args: [{ prompt: privateText }], options: { startToCloseTimeout: "1 minute" }, headers: {}, seq: 1 } satisfies OutboundInput<"scheduleActivity">;

describe("workflow tracing interceptors", () => {
  it("reads memo after the SDK initializes and decodes workflow payloads", async () => {
    const spans: WorkflowTraceSpan[] = [];
    let decoded = false;
    const tracing = createWorkflowTracingInterceptors({
      info: () => ({ runId, workflowId: "workflow:synthetic", workflowType: "dummyTurnWorkflow", runStartTime: new Date(100), ...(decoded ? { memo: { traceparent } } : {}) }),
      now: () => 250,
      record: span => spans.push(span)
    });
    decoded = true;
    await tracing.inbound![0]!.execute!({ args: [], headers: {} }, async () => undefined);
    expect(spans[0]).toMatchObject({ traceId: api.traceId, parentSpanId: api.spanId });
  });

  it("parents activities to the emitted workflow span and records memo correlation without changing arguments/results", async () => {
    const { inbound, outbound, spans } = harness({ memo: { traceparent, spaceTraceId: "req:synthetic", prompt: privateText } });
    const input = { args: [{ roomId: "room:synthetic", prompt: privateText }], headers: {} };
    const result = { status: "COMPLETED" };
    expect(await inbound.execute!(input, async received => {
      expect(received).toBe(input);
      return outbound.scheduleActivity!(activity, async scheduled => {
        expect(scheduled.args).toBe(activity.args);
        expect(scheduled.options).toBe(activity.options);
        expect(readTraceHeader(scheduled.headers)).toEqual({ context: { ...api, spanId: workflowSpanId(runId) } });
        return result;
      });
    })).toBe(result);
    expect(activity.headers).toEqual({});
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ traceId: api.traceId, spanId: workflowSpanId(runId), parentSpanId: api.spanId, kind: 1, name: "workflow.dummyTurnWorkflow", startTimeMs: 100, endTimeMs: 250, error: false,
      attributes: { "space.outcome": "COMPLETED", "space.trace_id": "req:synthetic", "space.room_id": "room:synthetic" } });
    expect(JSON.stringify(spans)).not.toContain("PRIVATE");
  });

  it("prefers validated headers over stale argument traceparents and preserves all other headers", async () => {
    const { inbound, outbound, spans } = harness();
    const extra = { data: new Uint8Array([7]) };
    const headerContext = { ...api, traceId: "1".repeat(32), spanId: "2".repeat(16) };
    await inbound.execute!({ args: [{ traceparent }], headers: withTraceHeader({}, { context: headerContext }) }, async () => {
      await outbound.scheduleLocalActivity!({ ...activity, attempt: 1, headers: { other: extra } }, async scheduled => {
        expect(scheduled.headers.other).toBe(extra);
        expect(readTraceHeader(scheduled.headers)?.context).toEqual({ ...headerContext, spanId: workflowSpanId(runId) });
      });
    });
    expect(spans[0]).toMatchObject({ traceId: headerContext.traceId, parentSpanId: headerContext.spanId });
  });

  it("passes both child workflow promises through and uses the actual supervisor parent", async () => {
    const { inbound, outbound } = harness({ memo: { traceparent } });
    await inbound.execute!({ args: [], headers: {} }, async () => {
      const started = Promise.resolve("child-run");
      const result = Promise.resolve({ status: "COMPLETED" });
      const pair: [Promise<string>, Promise<unknown>] = [started, result];
      const promise = Promise.resolve(pair);
      const input = { workflowType: "child", headers: {}, seq: 1, options: { args: [{ traceparent }], workflowId: "child:1" } } as OutboundInput<"startChildWorkflowExecution">;
      const returned = outbound.startChildWorkflowExecution!(input, async child => {
        expect(readTraceHeader(child.headers)?.context.spanId).toBe(workflowSpanId(runId));
        return pair;
      });
      expect(await returned).toBe(pair);
      expect((await returned)[0]).toBe(started);
      expect((await returned)[1]).toBe(result);
      expect(outbound.startChildWorkflowExecution!(input, () => promise)).toBe(promise);
    });
  });

  it("keeps the original parent across continue-as-new, links runs and treats the SDK control exception as success", async () => {
    const first = harness({ memo: { traceparent } });
    let continuation: TraceEnvelope | null = null;
    const control = Object.create(ContinueAsNew.prototype) as ContinueAsNew;
    await expect(first.inbound.execute!({ args: [{ traceparent }], headers: {} }, async () => {
      return first.outbound.continueAsNew!({ args: [{ goalId: "goal:1" }], headers: {}, options: { workflowType: "dotGoalWorkflow" } }, async input => {
        continuation = readTraceHeader(input.headers);
        expect(input.args).toEqual([{ goalId: "goal:1" }]);
        throw control;
      });
    })).rejects.toBe(control);
    expect(first.spans[0]).toMatchObject({ error: false, attributes: { "space.outcome": "CONTINUED_AS_NEW" } });
    expect(continuation).toEqual({ context: { ...api, spanId: workflowSpanId(runId) }, parentSpanId: api.spanId, continuation: true, links: [{ traceId: api.traceId, spanId: workflowSpanId(runId) }] });
    const second = harness({ runId: "next-run", workflowType: "dotGoalWorkflow" });
    await second.inbound.execute!({ args: [{ goalId: "goal:1" }], headers: withTraceHeader({}, continuation!) }, async () => undefined);
    expect(second.spans[0]).toMatchObject({ traceId: api.traceId, spanId: workflowSpanId("next-run"), parentSpanId: api.spanId, links: [{ traceId: api.traceId, spanId: workflowSpanId(runId) }] });
  });

  it("can adopt the first signalWithStart item before scheduling, then links subsequent requests without reparenting", async () => {
    const { inbound, outbound, spans } = harness({ workflowType: "roomAgentSupervisorWorkflow" });
    await inbound.execute!({ args: [{ roomId: "room:synthetic" }], headers: {} }, async () => {
      await inbound.handleSignal!({ signalName: "enqueue", args: [{ item: { turn: { traceparent } } }], headers: {} }, async () => undefined);
      await outbound.scheduleActivity!(activity, async scheduled => { expect(readTraceHeader(scheduled.headers)?.context.traceId).toBe(api.traceId); });
      const other = { traceId: "1".repeat(32), spanId: "2".repeat(16), flags: "01" };
      await inbound.handleSignal!({ signalName: "enqueue", args: [], headers: withTraceHeader({}, { context: other }) }, async () => undefined);
      await outbound.scheduleActivity!(activity, async scheduled => { expect(readTraceHeader(scheduled.headers)?.context.traceId).toBe(api.traceId); });
    });
    expect(spans[0]).toMatchObject({ traceId: api.traceId, parentSpanId: api.spanId, links: [{ traceId: "1".repeat(32), spanId: "2".repeat(16) }] });
  });

  it("locks a generated root context after scheduling rather than orphaning already-started activities", async () => {
    const { inbound, outbound, spans } = harness();
    await inbound.execute!({ args: [], headers: {} }, async () => {
      await outbound.scheduleActivity!(activity, async scheduled => { expect(readTraceHeader(scheduled.headers)?.context.traceId).toBe(workflowTraceId(runId)); });
      await inbound.handleSignal!({ signalName: "enqueue", args: [{ turn: { traceparent } }], headers: {} }, async () => undefined);
    });
    expect(spans[0]).toMatchObject({ traceId: workflowTraceId(runId), parentSpanId: null, links: [{ traceId: api.traceId, spanId: api.spanId }] });
  });

  it("starts background children as new root traces with links, not as children of an unrecorded carrier id", async () => {
    const { inbound, outbound } = harness({ memo: { traceparent } });
    const backgroundContext = { traceId: "a".repeat(32), spanId: "b".repeat(16), flags: "01" };
    const input = { traceparent: `00-${backgroundContext.traceId}-${backgroundContext.spanId}-01`, traceLinks: [{ traceId: api.traceId, spanId: workflowSpanId(runId) }], roomAgentContinuation: { continuationId: "continuation:1" } };
    const background = harness({ runId: "background-run" });
    await inbound.execute!({ args: [], headers: {} }, async () => {
      const childInput = { workflowType: "dummyTurnWorkflow", options: { args: [input], workflowId: "background:1" }, seq: 1, headers: {} } as OutboundInput<"startChildWorkflowExecution">;
      await outbound.startChildWorkflowExecution!(childInput, async child => {
        expect(readTraceHeader(child.headers)).toMatchObject({ context: backgroundContext, root: true, parentSpanId: null, links: input.traceLinks });
        await background.inbound.execute!({ args: [input], headers: child.headers }, async () => undefined);
        return [Promise.resolve("background-run"), Promise.resolve(undefined)];
      });
    });
    expect(background.spans[0]).toMatchObject({ traceId: backgroundContext.traceId, spanId: workflowSpanId("background-run"), parentSpanId: null, links: input.traceLinks });
    const direct = harness({ runId: "direct-background-run" });
    await direct.inbound.execute!({ args: [input], headers: {} }, async () => undefined);
    expect(direct.spans[0]).toMatchObject({ traceId: backgroundContext.traceId, parentSpanId: null, links: input.traceLinks });
    const noSource = harness({ runId: "background-no-source-run" });
    await noSource.inbound.execute!({ args: [{ ...input, traceLinks: [] }], headers: {} }, async () => undefined);
    expect(noSource.spans[0]).toMatchObject({ traceId: backgroundContext.traceId, parentSpanId: null });
    expect(noSource.spans[0]!.links).toBeUndefined();
  });

  it("records bounded failure/cancellation outcomes without exception messages or result content", async () => {
    const failedResult = harness();
    const value = { status: "FAILED", output: privateText };
    expect(await failedResult.inbound.execute!({ args: [], headers: {} }, async () => value)).toBe(value);
    expect(failedResult.spans[0]).toMatchObject({ error: true, attributes: { "space.outcome": "FAILED_RESULT", "space.reason_code": "WORKFLOW_RESULT_FAILED" } });
    const failed = harness();
    const error = Object.assign(new Error(privateText), { code: "PROVIDER_TIMEOUT" });
    await expect(failed.inbound.execute!({ args: [], headers: {} }, async () => { throw error; })).rejects.toBe(error);
    expect(failed.spans[0]).toMatchObject({ error: true, attributes: { "space.outcome": "FAILED", "space.reason_code": "PROVIDER_TIMEOUT", "space.failure_category": "TIMEOUT" } });
    const cancelled = harness();
    const cancellation = new CancelledFailure(privateText);
    await expect(cancelled.inbound.execute!({ args: [], headers: {} }, async () => { throw cancellation; })).rejects.toBe(cancellation);
    expect(cancelled.spans[0]).toMatchObject({ attributes: { "space.outcome": "CANCELLED", "space.failure_category": "CANCELLED" } });
    expect(JSON.stringify([...failed.spans, ...failedResult.spans, ...cancelled.spans])).not.toContain("PRIVATE");
  });

  it("keeps the business result when optional telemetry recording fails", async () => {
    const { inbound } = harness({}, () => { throw new Error("optional sink unavailable"); });
    expect(await inbound.execute!({ args: [], headers: {} }, async () => "business-result")).toBe("business-result");
  });
});
