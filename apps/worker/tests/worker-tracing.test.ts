import { createOtlpSpanExporter, type OtlpSpanExporterOptions } from "@space/telemetry";
import { describe, expect, it, vi } from "vitest";
import { contextFromHeaders, traceAttributes, withTraceHeader } from "../src/workflow-trace-context.js";
import { workerTracingOptions } from "../src/worker-tracing.js";

describe("worker tracing boundary", () => {
  it("does not register workflow sinks or interceptors when export is off", () => {
    const options = workerTracingOptions(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors?.workflowModules).toBeUndefined();
    expect(options.interceptors?.activity).toHaveLength(1);
  });
  it("drops unknown attributes and free-form values", () => {
    expect(traceAttributes({ workflowId: "workflow:123", runId: "run-1", roomId: "room:1", attempt: 2, durationMs: 2.5,
      prompt: "private", output: "private", error: "private", url: "https://secret", path: "/private/file", reasonCode: "error with secrets", missionId: "/private/path", status: "FAILED", category: "UNKNOWN", paneId: "https://secret" }))
      .toEqual({ workflowId: "workflow:123", runId: "run-1", roomId: "room:1", attempt: 2, durationMs: 2.5, status: "FAILED", category: "UNKNOWN" });
    expect(traceAttributes({ attempt: NaN, durationMs: -1 })).toEqual({});
  });
  it("validates propagated context and bounds links", () => {
    const context = { traceId: "a".repeat(32), spanId: "b".repeat(16) };
    const headers = withTraceHeader({}, { ...context, links: Array(20).fill(context) });
    expect(contextFromHeaders(headers)).toEqual({ ...context, links: Array(4).fill(context) });
    expect(contextFromHeaders({ "space-otlp-context": { data: new Uint8Array([0]) } })).toBeNull();
    expect(contextFromHeaders(withTraceHeader({}, { traceId: "0".repeat(32), spanId: "b".repeat(16) }))).toBeNull();
  });
});

it("can export after an idle/empty flush", async () => {
  const fetch = vi.fn(async () => ({ ok: true }));
  const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:1", serviceName: "test", fetch });
  try {
    await exporter.flush();
    exporter.record({ traceId: "a".repeat(32), spanId: "b".repeat(16), parentSpanId: null, name: "test", startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: {}, error: false });
    await exporter.flush();
    expect(fetch).toHaveBeenCalledOnce();
    expect(exporter.stats()).toEqual({ exported: 1, dropped: 0, failed: 0 });
  } finally { await exporter.close(); }
});

it("finishes activity work while export is pending and preserves failure codes", async () => {
  let release!: (value: { ok: boolean }) => void;
  const send = vi.fn<NonNullable<OtlpSpanExporterOptions["fetch"]>>(() => new Promise<{ ok: boolean }>(resolve => { release = resolve; }));
  const exporter = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:1", serviceName: "test", fetch: send, batchSize: 1, maxQueue: 1 });
  const factory = workerTracingOptions(exporter).interceptors!.activity![0]!;
  const context = { info: { activityType: "testActivity", attempt: 2, workflowExecution: { workflowId: "workflow:1", runId: "11111111-2222-3333-4444-555555555555" }, workflowType: "testWorkflow", activityId: "1", currentAttemptScheduledTimestampMs: Date.now() }, cancellationSignal: new AbortController().signal };
  const interceptor = factory(context as Parameters<typeof factory>[0]).inbound!;
  const headers = withTraceHeader({}, { traceId: "a".repeat(32), spanId: "b".repeat(16) });
  try {
    expect(await interceptor.execute!({ args: [{ prompt: "PRIVATE" }], headers }, async () => "ok")).toBe("ok");
    expect(send).toHaveBeenCalledOnce();
    // One batch is in flight, one is queued and the third is dropped.
    const error = Object.assign(new Error("private /path https://secret"), { code: "UPSTREAM_TIMEOUT" });
    await expect(interceptor.execute!({ args: [], headers }, async () => { throw error; })).rejects.toBe(error);
    await interceptor.execute!({ args: [], headers }, async () => "ok");
    expect(exporter.stats().dropped).toBe(1);
    const firstBatch = JSON.parse(send.mock.calls[0]![1].body);
    expect(JSON.stringify(firstBatch)).not.toContain("PRIVATE");
    release({ ok: false });
    await exporter.flush();
    const retry = exporter.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    const failed = JSON.parse(send.mock.calls[1]![1].body).resourceSpans[0].scopeSpans[0].spans[0];
    expect(failed.attributes).toEqual(expect.arrayContaining([
      { key: "reasonCode", value: { stringValue: "UPSTREAM_TIMEOUT" } },
      { key: "category", value: { stringValue: "TIMEOUT" } },
      { key: "attempt", value: { intValue: "2" } }
    ]));
    expect(JSON.stringify(failed)).not.toMatch(/private|https:\/\//);
    release({ ok: false });
    await retry;
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 1, failed: 2 });
  } finally { release?.({ ok: false }); await exporter.close(); }
});
