import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { MetricsRegistry, type ServerSpan, type SpanExporter } from "@space/runtime";
import {
  activityCorrelation,
  childTraceparent,
  createActivityObservabilityInterceptors,
  noteActivityFailureReason,
  observeActivityExecution
} from "../src/activity-observability.js";
import { captureWorkerLogs, workerLog } from "../src/worker-log.js";
import {
  createWorkerMetrics,
  renderWorkerMetrics,
  resolveTemporalCoreMetricsBind,
  resolveWorkerMetricsListen,
  startWorkerMetricsServer
} from "../src/worker-metrics.js";

const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
const secretPrompt = "PRIVATE PROMPT: deploy with token sk-live-worker-secret-123";

const info = (overrides: Partial<Parameters<typeof observeActivityExecution>[0]> = {}) => ({
  activityType: "runCodexAppServerTurn",
  activityId: "3",
  attempt: 1,
  workflowType: "codexAppServerTurnWorkflow",
  workflowExecution: { workflowId: "workflow:codex-app-server:room:a:pane:a:req:abcdefghijkl", runId: "run-uuid-1" },
  currentAttemptScheduledTimestampMs: 1_000,
  ...overrides
});

function capture() {
  const records: Array<Record<string, unknown>> = [];
  const lines: string[] = [];
  const restore = captureWorkerLogs((line) => { lines.push(line); records.push(JSON.parse(line)); });
  return { records, lines, restore };
}

function captureSpans() {
  const recorded: ServerSpan[] = [];
  const spans: SpanExporter = {
    record: span => void recorded.push(span),
    flush: async () => undefined,
    close: async () => undefined,
    stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
  };
  return { recorded, spans };
}

// A Temporal binary/plain header, constructed independently of the encoder.
function traceHeaders(value: string) {
  const encoder = new TextEncoder();
  return { "space-traceparent": { metadata: { encoding: encoder.encode("binary/plain") }, data: encoder.encode(value) } };
}

let restoreLogs: (() => void) | null = null;
afterEach(() => { restoreLogs?.(); restoreLogs = null; });

describe("activity correlation", () => {
  it("reads allowlisted identifiers from turn inputs, queue items and bridge requests only", () => {
    const turn = {
      roomId: "room:alpha01", paneId: "pane:alpha01", prompt: secretPrompt, traceId: "req:abcdefghijkl", traceparent,
      agentRunId: "agent_run:1", agentSessionId: "agent_session:1", roomAgentMissionId: "mission:1"
    };
    expect(activityCorrelation([turn])).toEqual({
      traceId: "req:abcdefghijkl",
      w3cTraceId: "4bf92f3577b34da6a3ce929d0e0e4736",
      missionId: "mission:1",
      roomId: "room:alpha01",
      paneId: "pane:alpha01",
      agentRunId: "agent_run:1",
      agentSessionId: "agent_session:1"
    });
    expect(activityCorrelation([{ item: { missionId: "mission:2", turn } }])).toMatchObject({ missionId: "mission:2", traceId: "req:abcdefghijkl" });
    expect(activityCorrelation([{ actionId: "action:1", traceId: "req:internal0001", bridge: { requestId: "req:abcdefghijkl" } }]))
      .toEqual({ traceId: "req:internal0001", parentTraceId: "req:abcdefghijkl", actionId: "action:1" });
    expect(activityCorrelation(["goal:positional", { roomId: "has spaces in it", traceId: secretPrompt }])).toEqual({});
  });

  it("creates child traceparents in the same trace", () => {
    const child = childTraceparent(traceparent);
    expect(child).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(child).not.toBe(traceparent);
    expect(childTraceparent("invalid")).toBeNull();
  });
});

describe("observeActivityExecution", () => {
  it("logs start and finish with queue time, attempt and correlation and records metrics", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const metrics = createWorkerMetrics(new MetricsRegistry());
    let clock = 1_250;
    const result = await observeActivityExecution(info({ attempt: 2 }), [{ traceId: "req:abcdefghijkl", traceparent, prompt: secretPrompt }],
      async () => { clock = 1_400; return { status: "COMPLETED" }; }, { metrics, now: () => clock });

    expect(result).toEqual({ status: "COMPLETED" });
    expect(logs.records).toEqual([
      expect.objectContaining({ level: "info", service: "space-worker", event: "activity.started", activityType: "runCodexAppServerTurn",
        attempt: 2, queueMs: 250, traceId: "req:abcdefghijkl", w3cTraceId: "4bf92f3577b34da6a3ce929d0e0e4736", temporalRunId: "run-uuid-1" }),
      expect.objectContaining({ event: "activity.finished", outcome: "COMPLETED", durationMs: 150, reasonCode: null, category: null })
    ]);
    const text = metrics.registry.render();
    expect(text).toContain('space_worker_activity_executions_total{activity_type="runCodexAppServerTurn",outcome="COMPLETED"} 1');
    expect(text).toContain('space_worker_activity_retries_total{activity_type="runCodexAppServerTurn"} 1');
    expect(text).toContain('space_worker_activity_schedule_to_start_seconds_count{activity_type="runCodexAppServerTurn"} 1');
    expect(text).toContain('space_worker_activities_in_flight{activity_type="runCodexAppServerTurn"} 0');
  });

  it("reports the noted reason of a returned failure with its category", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const metrics = createWorkerMetrics(new MetricsRegistry());
    await observeActivityExecution(info(), [{ traceId: "req:abcdefghijkl" }], async () => {
      await Promise.resolve();
      noteActivityFailureReason("CODEX_APP_SERVER_TURN_TIMEOUT");
      noteActivityFailureReason("not a code: secret");
      return { status: "FAILED", message: secretPrompt };
    }, { metrics });
    expect(logs.records.at(-1)).toMatchObject({ level: "error", outcome: "FAILED_RESULT", reasonCode: "CODEX_APP_SERVER_TURN_TIMEOUT", category: "TIMEOUT" });
    expect(metrics.registry.render())
      .toContain('space_worker_activity_failures_total{activity_type="runCodexAppServerTurn",category="TIMEOUT",code="CODEX_APP_SERVER_TURN_TIMEOUT"} 1');
  });

  it("classifies thrown and cancelled activities without logging error messages", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const metrics = createWorkerMetrics(new MetricsRegistry());
    const thrown = Object.assign(new Error(`database said ${secretPrompt}`), { code: "TOOL_UNAVAILABLE" });
    await expect(observeActivityExecution(info(), [], async () => { throw thrown; }, { metrics })).rejects.toBe(thrown);
    expect(logs.records.at(-1)).toMatchObject({ outcome: "FAILED", reasonCode: "TOOL_UNAVAILABLE", category: "TOOL_UNAVAILABLE", errorName: "Error" });

    class CancelledFailure extends Error { override name = "CancelledFailure"; }
    await expect(observeActivityExecution(info(), [], async () => { throw new CancelledFailure(secretPrompt); }, { metrics }))
      .rejects.toBeInstanceOf(CancelledFailure);
    expect(logs.records.at(-1)).toMatchObject({ level: "warn", outcome: "CANCELLED", category: "CANCELLED" });

    await expect(observeActivityExecution(info(), [], async () => { throw new TypeError(secretPrompt); }, { metrics })).rejects.toThrow();
    expect(logs.records.at(-1)).toMatchObject({ outcome: "FAILED", reasonCode: "ACTIVITY_ERROR", category: "INTERNAL", errorName: "TypeError" });

    const everything = `${logs.lines.join("\n")}\n${metrics.registry.render()}`;
    expect(everything).not.toContain("sk-live-worker-secret-123");
    expect(everything).not.toContain("PRIVATE PROMPT");
  });

  it("runs through the Temporal interceptor factory", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const metrics = createWorkerMetrics(new MetricsRegistry());
    const interceptors = createActivityObservabilityInterceptors({ metrics })({
      info: info(),
      cancellationSignal: new AbortController().signal
    } as never);
    const value = await interceptors.inbound!.execute!({ args: [{ traceId: "req:abcdefghijkl" }], headers: {} }, async () => "done");
    expect(value).toBe("done");
    expect(logs.records.map((record) => record.event)).toEqual(["activity.started", "activity.finished"]);
  });

  it.each([
    { name: "no arguments", args: [] },
    { name: "legacy arguments", args: [{ traceparent, prompt: secretPrompt }] }
  ])("uses the workflow header for activities with $name", async ({ args }) => {
    const logs = capture(); restoreLogs = logs.restore;
    const { recorded, spans } = captureSpans();
    const metrics = createWorkerMetrics(new MetricsRegistry());
    const workflowParent = "00-11111111111111111111111111111111-2222222222222222-01";
    const interceptors = createActivityObservabilityInterceptors({ metrics, spans })({
      info: info(), cancellationSignal: new AbortController().signal
    } as never);
    const input = { args, headers: traceHeaders(workflowParent) };
    const result = { value: secretPrompt };
    const returned = await interceptors.inbound!.execute!(input, async nextInput => {
      expect(nextInput).toBe(input);
      return result;
    });
    expect(returned).toBe(result);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ traceId: "11111111111111111111111111111111", parentSpanId: "2222222222222222", kind: 1 });
    expect(logs.records[0]).toMatchObject({ w3cTraceId: "11111111111111111111111111111111" });
    expect(JSON.stringify(recorded[0]!.attributes)).not.toContain(secretPrompt);
  });

  it("falls back to the legacy argument context when a workflow header is malformed", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const { recorded, spans } = captureSpans();
    const interceptors = createActivityObservabilityInterceptors({ metrics: createWorkerMetrics(new MetricsRegistry()), spans })({
      info: info(), cancellationSignal: new AbortController().signal
    } as never);
    await interceptors.inbound!.execute!({ args: [{ turn: { traceparent } }], headers: traceHeaders("invalid") }, async () => "ok");
    await interceptors.inbound!.execute!({ args: [], headers: traceHeaders("invalid") }, async () => "ok");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
  });

  it("gives retry attempts distinct spans with safe failure and correlation metadata", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const { recorded, spans } = captureSpans();
    const metrics = createWorkerMetrics(new MetricsRegistry());
    let clock = 1_000;
    const args = [{ turn: { traceparent, traceId: "req:abcdefghijkl", requestId: "req:parent00001",
      roomId: "room:1", paneId: "pane:1", roomAgentMissionId: "mission:1", agentRunId: "agent_run:1",
      prompt: secretPrompt, output: secretPrompt, path: "/private/transcript", url: "https://private.example/?token=secret",
      headers: { authorization: secretPrompt } } }];
    const failedResult = { status: "FAILED", message: secretPrompt };
    expect(await observeActivityExecution(info(), args, async () => {
      noteActivityFailureReason("CODEX_APP_SERVER_TURN_TIMEOUT");
      clock += 125;
      return failedResult;
    }, { metrics, spans, now: () => clock })).toBe(failedResult);
    expect(await observeActivityExecution(info({ attempt: 2 }), args, async () => {
      clock += 75;
      return "ok";
    }, { metrics, spans, now: () => clock })).toBe("ok");

    expect(recorded).toHaveLength(2);
    expect(recorded[0]!.spanId).not.toBe(recorded[1]!.spanId);
    for (const exported of recorded) {
      expect(exported.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(exported.spanId).not.toBe("0000000000000000");
      expect(exported).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
      expect(exported.attributes).toMatchObject({ "space.activity_id": "3", "space.workflow_type": "codexAppServerTurnWorkflow",
        "space.workflow_id": info().workflowExecution.workflowId, "space.temporal_run_id": "run-uuid-1",
        "space.trace_id": "req:abcdefghijkl", "space.request_id": "req:parent00001", "space.room_id": "room:1",
        "space.pane_id": "pane:1", "space.mission_id": "mission:1", "space.agent_run_id": "agent_run:1" });
    }
    expect(recorded[0]).toMatchObject({ error: true, attributes: { "space.attempt": 1, "space.outcome": "FAILED_RESULT",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT", "space.failure_category": "TIMEOUT", "space.duration_ms": 125 } });
    expect(recorded[1]).toMatchObject({ error: false, attributes: { "space.attempt": 2, "space.outcome": "COMPLETED", "space.duration_ms": 75 } });
    expect(recorded[1]!.attributes).not.toHaveProperty("space.reason_code");
    const exportedText = JSON.stringify(recorded.map(({ name, attributes }) => ({ name, attributes })));
    expect(exportedText).not.toMatch(/PRIVATE PROMPT|sk-live|private\.example|transcript|authorization/);
  });

  it("parents outbound calls to the exported attempt and keeps concurrent activity scopes separate", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const { recorded, spans } = captureSpans();
    const metrics = createWorkerMetrics(new MetricsRegistry());
    const outgoing = await Promise.all(["1", "2"].map(activityId => observeActivityExecution(info({ activityId }), [{ traceparent }], async () => {
      await Promise.resolve();
      return { activityId, traceparent: childTraceparent(null) };
    }, { metrics, spans })));
    expect(recorded).toHaveLength(2);
    for (const call of outgoing) {
      const activity = recorded.find(span => span.attributes["space.activity_id"] === call.activityId)!;
      expect(call.traceparent).toBe(`00-${activity.traceId}-${activity.spanId}-01`);
    }
    expect(outgoing[0]!.traceparent).not.toBe(outgoing[1]!.traceparent);
    expect(childTraceparent(null)).toBeNull();
  });

  it("never lets a throwing span exporter replace a result or an original activity failure", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const { recorded, spans } = captureSpans();
    let flushes = 0;
    spans.record = span => { recorded.push(span); throw new Error("collector is unavailable"); };
    spans.flush = async () => { flushes += 1; };
    const dependencies = { metrics: createWorkerMetrics(new MetricsRegistry()), spans };
    const result = { status: "COMPLETED", value: secretPrompt };
    expect(await observeActivityExecution(info(), [{ traceparent }], async () => result, dependencies)).toBe(result);
    const failure = Object.assign(new Error(secretPrompt), { code: "TOOL_UNAVAILABLE" });
    await expect(observeActivityExecution(info(), [{ traceparent }], async () => { throw failure; }, dependencies)).rejects.toBe(failure);
    expect(recorded.map(span => span.attributes["space.outcome"])).toEqual(["COMPLETED", "FAILED"]);
    expect(recorded[1]).toMatchObject({ error: true, attributes: { "space.reason_code": "TOOL_UNAVAILABLE", "space.failure_category": "TOOL_UNAVAILABLE" } });
    expect(flushes).toBe(0);
  });

  it("keeps telemetry failures and cancellation classification from changing business outcomes", async () => {
    const logs = capture(); restoreLogs = logs.restore;
    const { recorded, spans } = captureSpans();
    const metrics = createWorkerMetrics(new MetricsRegistry());
    metrics.activitiesInFlight.inc = () => { throw new Error("broken metrics sink"); };
    expect(await observeActivityExecution(info(), [{ traceparent }], async () => "ok", { metrics, spans })).toBe("ok");
    const failure = new Error(secretPrompt);
    await expect(observeActivityExecution(info(), [{ traceparent }], async () => { throw failure; }, { metrics, spans, cancelled: () => true }))
      .rejects.toBe(failure);
    expect(recorded.map(span => span.attributes["space.outcome"])).toEqual(["COMPLETED", "CANCELLED"]);
    expect(recorded[1]).toMatchObject({ error: false, attributes: { "space.failure_category": "CANCELLED" } });
  });
});

describe("worker log", () => {
  it("drops free-text string fields instead of truncating them", () => {
    const logs = capture(); restoreLogs = logs.restore;
    workerLog("info", "probe", { traceId: "req:abcdefghijkl", note: secretPrompt, count: 2, missing: undefined });
    expect(logs.records[0]).toEqual({ ts: expect.any(String), level: "info", service: "space-worker", event: "probe", traceId: "req:abcdefghijkl", count: 2 });
  });
});

describe("worker metrics endpoint", () => {
  it("is disabled by default and only binds loopback addresses", () => {
    expect(resolveWorkerMetricsListen({})).toBeNull();
    expect(resolveWorkerMetricsListen({ SPACE_WORKER_METRICS_PORT: "0" })).toBeNull();
    expect(resolveWorkerMetricsListen({ SPACE_WORKER_METRICS_PORT: "80" })).toBeNull();
    expect(resolveWorkerMetricsListen({ SPACE_WORKER_METRICS_PORT: "9469" })).toEqual({ host: "127.0.0.1", port: 9469 });
    expect(resolveWorkerMetricsListen({ SPACE_WORKER_METRICS_PORT: "9469", SPACE_WORKER_METRICS_HOST: "0.0.0.0" })).toBeNull();
    expect(resolveWorkerMetricsListen({ SPACE_WORKER_METRICS_PORT: "9469", SPACE_WORKER_METRICS_HOST: "::1" })).toEqual({ host: "::1", port: 9469 });
    expect(resolveTemporalCoreMetricsBind({})).toBeNull();
    expect(resolveTemporalCoreMetricsBind({ SPACE_WORKER_TEMPORAL_METRICS_BIND: "127.0.0.1:9464" })).toBe("127.0.0.1:9464");
    expect(resolveTemporalCoreMetricsBind({ SPACE_WORKER_TEMPORAL_METRICS_BIND: "0.0.0.0:9464" })).toBeNull();
  });

  it("serves Prometheus text on loopback and nothing else", async () => {
    const port = 20_000 + Math.floor(Math.random() * 20_000);
    const server = await startWorkerMetricsServer({ host: "127.0.0.1", port });
    expect(server).not.toBeNull();
    const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
      request({ host: "127.0.0.1", port, path }, (response) => {
        let body = "";
        response.on("data", (chunk) => { body += String(chunk); });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
      }).on("error", reject).end();
    });
    try {
      const metrics = await get("/metrics");
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain("# TYPE space_worker_activity_executions_total counter");
      expect(metrics.body).toMatch(/space_process_event_loop_lag_seconds\{stat="p99"\}/);
      expect((await get("/other")).status).toBe(404);
      expect(renderWorkerMetrics()).toContain("space_process_cpu_seconds_total");
    } finally {
      await new Promise((resolve) => server!.close(resolve));
    }
  });
});

it("registers the activity interceptor on every Temporal worker, including both memory workers", async () => {
  const { readFile } = await import("node:fs/promises");
  const { createWorkerTracing } = await import("../src/worker-tracing.js");
  const logs = capture(); restoreLogs = logs.restore;
  const tracing = createWorkerTracing(null);
  expect(tracing.interceptors?.activity).toHaveLength(1);
  const interceptors = tracing.interceptors!.activity![0]!({
    info: info(), cancellationSignal: new AbortController().signal
  } as never);
  await interceptors.inbound!.execute!({ args: [], headers: {} }, async () => "ok");
  expect(logs.records.map(record => record.event)).toEqual(["activity.started", "activity.finished"]);
  for (const entry of ["worker.ts", "memory-maintenance-worker.ts", "memory-mutation-worker.ts"]) {
    const source = await readFile(new URL(`../src/${entry}`, import.meta.url), "utf8");
    expect(source, entry).toMatch(/\.\.\.createWorkerTracing\(spans\)/);
  }
});

it("exports one INTERNAL span per activity under the caller's traceparent", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const spans = { record: (span: Record<string, unknown>) => recorded.push(span), flush: async () => undefined, close: async () => undefined, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
  const metrics = createWorkerMetrics(new MetricsRegistry());
  let clock = 1_000;
  const info = { activityType: "runTurn", activityId: "1", attempt: 1, currentAttemptScheduledTimestampMs: 1_000, workflowExecution: { workflowId: "w", runId: "r" } } as never;
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  await observeActivityExecution(info, [{ turn: { traceparent } }], async () => { clock += 250; return "ok"; }, { metrics, now: () => clock, spans: spans as never });
  await observeActivityExecution(info, [{ traceId: "req:no-w3c-parent" }], async () => "ok", { metrics, now: () => clock, spans: spans as never });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7", name: "activity runTurn",
    kind: 1, error: false, startTimeUnixNano: 1_000_000_000n, endTimeUnixNano: 1_250_000_000n });
});

it("exports only generated correlation identifiers and a valid attempt on activity spans", async () => {
  const { recorded, spans } = captureSpans();
  const args = [{ turn: { traceparent, traceId: "req:abcdefghijkl", roomId: "room:1",
    roomAgentMissionId: "PRIVATE-PROMPT-and-tool-output-must-stay-local", paneId: "private-notes.txt" } }];
  await observeActivityExecution(info(), args, async () => "ok", { spans });
  await observeActivityExecution(info({ attempt: -1 }), args, async () => "ok", { spans });
  expect(recorded[0]!.attributes).toMatchObject({ "space.room_id": "room:1", "space.trace_id": "req:abcdefghijkl", "space.attempt": 1 });
  expect(recorded[0]!.attributes).not.toHaveProperty("space.mission_id");
  expect(recorded[0]!.attributes).not.toHaveProperty("space.pane_id");
  expect(JSON.stringify(recorded.map(({ name, attributes }) => ({ name, attributes })))).not.toMatch(/PRIVATE-PROMPT|private-notes/);
  expect(recorded[1]!.attributes).not.toHaveProperty("space.attempt");
});
