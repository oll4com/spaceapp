import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { MetricsRegistry } from "@space/runtime";
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

it("registers the workflow and activity observability interceptors and sinks on every Temporal worker, including both memory workers", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const entry of ["worker.ts", "memory-maintenance-worker.ts", "memory-mutation-worker.ts"]) {
    const source = await readFile(new URL(`../src/${entry}`, import.meta.url), "utf8");
    expect(source, entry).toMatch(/workflowModules:\s*\[workflowObservabilityInterceptorsPath\]/);
    expect(source, entry).toMatch(/activity:\s*\[createActivityObservabilityInterceptors\(\{ spans \}\)\]/);
    expect(source, entry).toMatch(/sinks:\s*createWorkflowObservabilitySinks\(\{ spans \}\)/);
  }
});

it("exports one INTERNAL span per activity under the caller's traceparent with allowlisted correlation attributes", async () => {
  const recorded: Array<Record<string, unknown>> = [];
  const spans = { record: (span: Record<string, unknown>) => recorded.push(span), flush: async () => undefined, close: async () => undefined, stats: () => ({ exported: 0, dropped: 0, failed: 0 }) };
  const metrics = createWorkerMetrics(new MetricsRegistry());
  let clock = 1_000;
  const info = {
    activityType: "runTurn",
    activityId: "1",
    attempt: 1,
    workflowType: "codexAppServerTurnWorkflow",
    currentAttemptScheduledTimestampMs: 950,
    workflowExecution: { workflowId: "workflow:codex-app-server:room:a:pane:a:req:abcdefghijkl", runId: "run-1" }
  } as never;
  const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
  await observeActivityExecution(
    info,
    [{ turn: { traceparent, traceId: "req:abcdefghijkl", roomId: "room:a", paneId: "pane:a", agentRunId: "agent_run:1", prompt: secretPrompt } }],
    async () => { clock += 250; return "ok"; },
    { metrics, now: () => clock, spans: spans as never }
  );
  await observeActivityExecution(info, [{ traceId: "req:no-w3c-parent" }], async () => "ok", { metrics, now: () => clock, spans: spans as never });
  expect(recorded).toHaveLength(1);
  expect(recorded[0]).toMatchObject({
    traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
    parentSpanId: "00f067aa0ba902b7",
    name: "activity runTurn",
    kind: 1,
    error: false,
    startTimeUnixNano: 1_000_000_000n,
    endTimeUnixNano: 1_250_000_000n,
    attributes: {
      "space.activity_type": "runTurn",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.workflow_id": "workflow:codex-app-server:room:a:pane:a:req:abcdefghijkl",
      "space.run_id": "run-1",
      "space.trace_id": "req:abcdefghijkl",
      "space.room_id": "room:a",
      "space.pane_id": "pane:a",
      "space.agent_run_id": "agent_run:1",
      "space.outcome": "COMPLETED",
      "space.attempt": 1,
      "space.duration_ms": 250,
      "space.queue_ms": 50
    }
  });
  expect(JSON.stringify(recorded[0]!.attributes)).not.toContain("PRIVATE PROMPT");
  expect(JSON.stringify(recorded[0]!.attributes)).not.toContain("sk-live");
});

