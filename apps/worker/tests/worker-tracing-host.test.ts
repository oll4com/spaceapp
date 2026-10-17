import type { Context } from "@temporalio/activity";
import type { Headers } from "@temporalio/common";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkerTracing, type WorkerTracingOptions } from "../src/worker-tracing.js";
import { createBackgroundTraceContext, runWithActivityTraceContext } from "../src/activity-trace-context.js";
import { observeActivityExecution } from "../src/activity-observability.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import { TRACE_CONTEXT_HEADER, withTraceHeader, workflowSpanId, workflowTraceId, type WorkflowTraceSpan } from "../src/tracing-protocol.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const spanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${spanId}-01`;
const execution = { workflowId: "workflow:host-test", runId: "ebef2b58-61a0-4ad0-846e-e306666dc129" };
const privateValue = "PRIVATE HOST SENTINEL /secrets/operator.json";
const info = (workflowExecution: typeof execution | undefined = execution) => ({
  activityType: "syntheticActivity", activityId: "1", attempt: 1, workflowType: "syntheticWorkflow",
  workflowExecution, currentAttemptScheduledTimestampMs: Date.now()
});
const active: ReturnType<typeof createWorkerTracing>[] = [];
const restores: Array<() => void> = [];
afterEach(async () => {
  await Promise.all(active.splice(0).map((tracing) => tracing.close()));
  for (const restore of restores.splice(0).reverse()) restore();
});

/** Capture host spans/logs through an injected transport and register afterEach cleanup. */
function setup(options: WorkerTracingOptions = {}) {
  const bodies: any[] = [];
  const logs: Array<Record<string, unknown>> = [];
  restores.push(captureWorkerLogs((line) => logs.push(JSON.parse(line))));
  const tracing = createWorkerTracing("space-worker-host-test", {
    env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid" },
    ...options,
    exporter: { flushIntervalMs: 60_000, fetch: async (_url, init) => { bodies.push(JSON.parse(init.body)); return { ok: true }; }, ...options.exporter }
  });
  active.push(tracing);
  const invoke = (args: unknown[], next: () => Promise<unknown>, headers: Headers = {}, workflowExecution: typeof execution | null = execution) => {
    const context = { info: { ...info(), workflowExecution: workflowExecution ?? undefined }, cancellationSignal: new AbortController().signal } as Context;
    return tracing.workerOptions.interceptors!.activity![0]!(context).inbound!.execute!({ args, headers }, next);
  };
  const spans = () => bodies.flatMap((body) => body.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
  return { tracing, bodies, logs, invoke, spans };
}

describe("worker tracing host edge cases", () => {
  it("exports exactly one span for each retry attempt when both input and workflow header carry context", async () => {
    const test = setup();
    const parent = { traceId, spanId: workflowSpanId(execution.runId), flags: "01" };
    for (const attempt of [1, 2]) {
      const context = { info: { ...info(), attempt }, cancellationSignal: new AbortController().signal } as Context;
      await test.tracing.workerOptions.interceptors!.activity![0]!(context).inbound!.execute!(
        { args: [{ turn: { traceparent } }], headers: withTraceHeader({}, { context: parent }) }, async () => "done");
    }
    await test.tracing.flush();
    const spans = test.spans();
    expect(spans).toHaveLength(2);
    expect(new Set(spans.map(span => span.spanId)).size).toBe(2);
    expect(spans.map(span => span.parentSpanId)).toEqual([parent.spanId, parent.spanId]);
    expect(spans.map(span => span.attributes.find((attribute: any) => attribute.key === "temporal.activity.attempt")?.value.intValue)).toEqual(["1", "2"]);
    expect(test.tracing.stats()).toEqual({ exported: 2, failed: 0, dropped: 0 });
  });

  it.each([undefined, "", "not a URL", "http://user:secret@collector.invalid"])("keeps invalid endpoint %s fully disabled while preserving activity logs", async (endpoint) => {
    const test = setup({ env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } });
    const value = { status: "COMPLETED" };
    expect(await test.invoke([], async () => value)).toBe(value);
    await test.tracing.flush();
    expect(test.tracing.enabled).toBe(false);
    expect(test.tracing.workerOptions.sinks).toBeUndefined();
    expect(test.tracing.workerOptions.interceptors?.workflowModules).toBeUndefined();
    expect(test.logs.map((record) => record.event)).toEqual(["activity.started", "activity.finished"]);
    expect(test.bodies).toEqual([]);
  });

  it("uses legacy traceparent input when the Temporal header is malformed", async () => {
    const test = setup();
    const malformed = { [TRACE_CONTEXT_HEADER]: { data: new TextEncoder().encode("not-json") } };
    await test.invoke([{ turn: { traceparent } }], async () => "done", malformed);
    await test.tracing.flush();
    expect(test.spans()).toHaveLength(1);
    expect(test.spans()[0]).toMatchObject({ traceId, parentSpanId: workflowSpanId(execution.runId), name: "activity.syntheticActivity" });
  });

  it("derives a stable run parent when neither headers nor arguments carry context", async () => {
    const test = setup();
    await test.invoke([{ traceparent: privateValue }], async () => "done");
    await test.tracing.flush();
    expect(test.spans()[0]).toMatchObject({ traceId: workflowTraceId(execution.runId), parentSpanId: workflowSpanId(execution.runId) });
    expect(JSON.stringify(test.bodies)).not.toContain(privateValue);
  });

  it("prefers the workflow header over stale request input and scopes background links", async () => {
    const test = setup();
    const headerContext = { traceId: "1".repeat(32), spanId: "2".repeat(16), flags: "01" };
    let background: ReturnType<typeof createBackgroundTraceContext> | undefined;
    await test.invoke([{ traceparent }], async () => {
      await Promise.resolve();
      background = createBackgroundTraceContext(traceparent);
      return "done";
    }, withTraceHeader({}, { context: headerContext }));
    await test.tracing.flush();
    expect(test.spans()[0]).toMatchObject({ traceId: headerContext.traceId, parentSpanId: headerContext.spanId });
    expect(background!.traceLinks).toEqual([{ traceId: headerContext.traceId, spanId: headerContext.spanId }]);
    expect(createBackgroundTraceContext(traceparent).traceLinks).toEqual([{ traceId, spanId }]);
  });

  it("observes standalone activity results without inventing a workflow span", async () => {
    const test = setup();
    expect(await test.invoke([{ traceparent }], async () => "standalone", {}, null)).toBe("standalone");
    await test.tracing.flush();
    expect(test.spans()).toEqual([]);
    expect(test.logs.at(-1)).toMatchObject({ workflowId: null, temporalRunId: null, outcome: "COMPLETED" });
  });

  it("sanitizes host sink attributes and ignores malformed span input without throwing", async () => {
    const test = setup();
    const sink = test.tracing.workerOptions.sinks!.tracing!.record!;
    expect(sink.callDuringReplay).toBe(false);
    const span: WorkflowTraceSpan = {
      traceId, spanId, parentSpanId: null, name: "workflow.syntheticWorkflow", kind: 1,
      startTimeMs: 1000, endTimeMs: 2000, error: false,
      attributes: { "temporal.workflow.type": "syntheticWorkflow", "space.outcome": "COMPLETED", "space.room_id": "room:synthetic",
        prompt: privateValue, "exception.message": privateValue, "workspace.path": privateValue },
      links: [{ traceId: "1".repeat(32), spanId: "2".repeat(16) }]
    };
    expect(() => sink.fn({} as never, null)).not.toThrow();
    expect(() => sink.fn({} as never, { ...span, startTimeMs: Number.NaN })).not.toThrow();
    sink.fn({} as never, span);
    await test.tracing.flush();
    expect(test.spans()).toHaveLength(1);
    expect(test.spans()[0].attributes).toEqual(expect.arrayContaining([
      { key: "space.room_id", value: { stringValue: "room:synthetic" } },
      { key: "space.outcome", value: { stringValue: "COMPLETED" } }
    ]));
    expect(test.spans()[0].attributes).toHaveLength(3);
    expect(test.spans()[0].links).toEqual(span.links);
    expect(JSON.stringify(test.bodies)).not.toContain(privateValue);
  });

  it("isolates concurrent activity contexts and leaves no parent after completion", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = { traceId, spanId, flags: "01" };
    const second = { traceId: "1".repeat(32), spanId: "2".repeat(16), flags: "01" };
    const waiting = runWithActivityTraceContext(first, async () => { await gate; return createBackgroundTraceContext(); });
    const immediate = await runWithActivityTraceContext(second, async () => { await Promise.resolve(); return createBackgroundTraceContext(); });
    release();
    expect((await waiting).traceLinks).toEqual([{ traceId, spanId }]);
    expect(immediate.traceLinks).toEqual([{ traceId: second.traceId, spanId: second.spanId }]);
    expect(createBackgroundTraceContext().traceLinks).toEqual([]);
  });

  it.each([false, true])("preserves the business outcome when the completion hook throws (failure=%s)", async (failure) => {
    const test = setup();
    const result = { status: "COMPLETED" };
    const error = new Error("original business error");
    let calls = 0;
    const observed = observeActivityExecution(info(), [], async () => {
      if (failure) throw error;
      return result;
    }, { onFinished: () => { calls++; throw new Error(privateValue); } });
    if (failure) await expect(observed).rejects.toBe(error);
    else expect(await observed).toBe(result);
    expect(calls).toBe(1);
    expect(test.logs.at(-1)?.outcome).toBe(failure ? "FAILED" : "COMPLETED");
    expect(JSON.stringify(test.logs)).not.toContain(privateValue);
  });

  it.each([false, true])("preserves the business outcome when the legacy span hook throws (failure=%s)", async (failure) => {
    const test = setup();
    const originalError = new Error("original business error");
    let calls = 0;
    const observed = observeActivityExecution(info(), [{ traceparent }], async () => {
      if (failure) throw originalError;
      return "done";
    }, { spans: {
      record: () => { calls++; throw new Error(privateValue); }, flush: async () => {}, close: async () => {},
      stats: () => ({ exported: 0, failed: 0, dropped: 0 })
    } });
    if (failure) await expect(observed).rejects.toBe(originalError);
    else await expect(observed).resolves.toBe("done");
    expect(calls).toBe(1);
    expect(test.logs.at(-1)?.outcome).toBe(failure ? "FAILED" : "COMPLETED");
    expect(JSON.stringify(test.logs)).not.toContain(privateValue);
  });
});
