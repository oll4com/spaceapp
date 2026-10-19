import http from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { temporal } from "@temporalio/proto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, DefaultLogger, Runtime, type WorkflowBundle } from "@temporalio/worker";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { workflowTracingOptions, workerSpanAttributes } from "../src/workflow-tracing-worker.js";
import { childTraceparent, createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { traceInput, workflowSpanId } from "../src/workflow-trace-context.js";
import { createRequestTraceContext, TraceContextRegistry, withTurnTraceparent, workflowCorrelationMemo } from "../../api/src/trace-context.js";

const secret = "PRIVATE_PROMPT https://private.example/path /private/file.txt raw exception";
const turn = { roomId: "room:tracing", paneId: "pane:tracing", prompt: secret, artifactIds: [], traceId: "req:tracing" };
const workflowEntry = fileURLToPath(new URL("./support/tracing-workflows.ts", import.meta.url));
const contracts = fileURLToPath(new URL("../../../packages/contracts/src/index.ts", import.meta.url));
let sequence = 0;

describe("connected Temporal tracing", () => {
  let env: TestWorkflowEnvironment;
  let bundle: WorkflowBundle;
  let exporter: SpanExporter;
  let collector: http.Server;
  const emitted: any[] = [];
  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    collector = http.createServer(async (request, response) => {
      expect(request.url).toBe("/v1/traces");
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const data = JSON.parse(Buffer.concat(chunks).toString());
      for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans) emitted.push(...scope.spans);
      const preview = process.env.SPACE_TRACE_PREVIEW_ENDPOINT;
      if (preview) {
        const target = new URL(preview);
        if (target.origin !== "http://127.0.0.1:4318" || target.pathname !== "/" || target.search || target.hash) throw Error("Preview must use the task's local-only Jaeger collector");
        const accepted = await fetch(`${target.origin}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(data), signal: AbortSignal.timeout(2_000) });
        expect(accepted.ok).toBe(true);
      }
      response.writeHead(200).end("{}");
    });
    collector.listen(0, "127.0.0.1"); await once(collector, "listening");
    exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${(collector.address() as any).port}`,
      serviceName: "space-trace-integration", flushIntervalMs: 20 });
    env = await TestWorkflowEnvironment.createTimeSkipping();
    bundle = await bundleWorkflowCode({ workflowsPath: workflowEntry,
      workflowInterceptorModules: workflowTracingOptions(exporter).workflowModules,
      logger: new DefaultLogger("ERROR"), webpackConfigHook(config) {
        config.resolve!.alias = { ...config.resolve!.alias, "@space/contracts$": contracts }; return config;
      } });
  }, 90_000);
  afterAll(async () => {
    await env?.teardown(); await exporter?.close(); collector?.close();
    if (process.env.SPACE_TRACE_ARTIFACT_PATH) await writeFile(process.env.SPACE_TRACE_ARTIFACT_PATH,
      JSON.stringify({ source: "Synthetic real-server integration; inspect the test result separately", spans: emitted }, null, 2));
  }, 20_000);

  async function worker<T>(taskQueue: string, activities: Record<string, (...args: any[]) => any>, task: () => Promise<T>) {
    const tracing = workflowTracingOptions(exporter);
    const instance = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue,
      workflowBundle: bundle, activities, sinks: tracing.sinks,
      interceptors: { activity: [createActivityObservabilityInterceptors({ spans: exporter })] } });
    return instance.runUntil(task);
  }

  it("does nothing when disabled and projects only safe identifier/type attributes", () => {
    expect(workflowTracingOptions(null)).toEqual({});
    expect(workerSpanAttributes({ prompt: secret, url: secret, path: secret, error: secret,
      "space.workflow_id": "workflow:allowed", "space.status": "FAILED", "space.reason_code": "ACTIVITY_ERROR",
      "space.category": "INTERNAL", "space.activity_type": secret, "space.duration_ms": 12 })).toEqual({
      "space.workflow_id": "workflow:allowed", "space.status": "FAILED", "space.reason_code": "ACTIVITY_ERROR",
      "space.category": "INTERNAL", "space.duration_ms": 12 });
    expect(traceInput([{ prompt: secret, traceId: "req:allowed", bridge: { prompt: secret, roomId: "room:allowed" } }]).attributes)
      .toEqual({ "space.traceId": "req:allowed", "space.roomId": "room:allowed" });
  });

  it("can deliver spans recorded after an empty flush instead of stranding the queue", async () => {
    let sent = 0;
    const target = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:1", serviceName: "synthetic",
      fetch: async (_url, input) => { sent++; expect(input.body).not.toContain(secret); return { ok: true }; } });
    try {
      await target.flush();
      target.record({ traceId: "1".repeat(32), spanId: "2".repeat(16), parentSpanId: null, name: "synthetic",
        startTimeUnixNano: 1n, endTimeUnixNano: 2n, attributes: {}, error: false,
        links: [{ traceId: "3".repeat(32), spanId: "4".repeat(16), prompt: secret } as any] });
      await target.flush(); expect(sent).toBe(1); expect(target.stats().exported).toBe(1);
    } finally { await target.close(); }
  });

  it("connects an actual HTTP request, production workflow, and each retry attempt; replay exports nothing", async () => {
    const queue = `trace-http-${++sequence}`; let attempts = 0; let handle: any;
    const registry = new TraceContextRegistry(); let apiSpan: any; let actionSpan: any;
    const api = http.createServer(async (request, response) => {
      const context = createRequestTraceContext(request.headers.traceparent);
      if (request.url === "/synthetic-action") {
        actionSpan = { traceId: context.w3cTraceId, spanId: context.spanId, parentSpanId: context.parentSpanId,
          name: "POST /synthetic-action", kind: 2, startTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
          endTimeUnixNano: BigInt(Date.now()) * 1_000_000n, attributes: { "http.request.method": "POST" }, error: false };
        exporter.record(actionSpan); response.writeHead(202).end("{}"); return;
      }
      registry.remember(turn.traceId, context);
      apiSpan = { traceId: context.w3cTraceId, spanId: context.spanId, parentSpanId: context.parentSpanId,
        name: "POST /synthetic-turn", kind: 2, startTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        endTimeUnixNano: BigInt(Date.now()) * 1_000_000n, attributes: { "http.request.method": "POST" }, error: false };
      const input = withTurnTraceparent(turn, registry);
      // This is the production API's context/memo path, not a hand-written
      // parent ID in the worker test. The request span must really exist.
      handle = await env.client.workflow.start("dummyTurnWorkflow", { workflowId: queue, taskQueue: queue, args: [input],
        memo: workflowCorrelationMemo({ traceId: input.traceId, traceparent: input.traceparent }) });
      apiSpan.endTimeUnixNano = BigInt(Date.now()) * 1_000_000n; exporter.record(apiSpan);
      response.writeHead(202, { "content-type": "application/json" }).end("{}");
    });
    api.listen(0, "127.0.0.1"); await once(api, "listening");
    try { await worker(queue, {
      recordDummyTurnStarted: () => { if (++attempts === 1) throw Error(secret); },
      recordDummyTurnCompleted: async () => {
        const parent = childTraceparent(registry.lookup(turn.traceId)?.traceparent);
        const response = await fetch(`http://127.0.0.1:${(api.address() as any).port}/synthetic-action`,
          { method: "POST", headers: parent ? { traceparent: parent } : {} });
        expect(response.status).toBe(202); return { status: "COMPLETED", message: secret };
      }
    }, async () => {
      const response = await fetch(`http://127.0.0.1:${(api.address() as any).port}/synthetic-turn`, { method: "POST" });
      expect(response.status).toBe(202); expect(await handle.result()).toMatchObject({ status: "COMPLETED" });
      await exporter.flush(); const spans = emitted.filter(span => span.traceId === apiSpan.traceId);
      expect(spans).toHaveLength(6);
      expect(new Set(spans.map(span => span.spanId)).size).toBe(spans.length);
      const root = spans.find(span => span.name === "workflow dummyTurnWorkflow");
      expect(root).toBeDefined(); expect(root.parentSpanId).toBe(apiSpan.spanId);
      const activities = spans.filter(span => span.name.startsWith("activity "));
      expect(activities).toHaveLength(3);
      for (const activity of activities) expect(activity.parentSpanId).toBe(root.spanId);
      expect(actionSpan.traceId).toBe(apiSpan.traceId);
      expect(actionSpan.parentSpanId).toBe(activities.find(span => span.name === "activity recordDummyTurnCompleted").spanId);
      const attributes = (span: any) => Object.fromEntries(span.attributes.map((a: any) => [a.key, a.value.intValue ?? a.value.stringValue]));
      expect(activities.filter(span => span.name === "activity recordDummyTurnStarted").map(span => attributes(span)["space.attempt"]).sort()).toEqual(["1", "2"]);
      expect(JSON.stringify(spans)).not.toContain(secret); expect(JSON.stringify(spans)).not.toContain("private.example");
      const before = emitted.length, history = await handle.fetchHistory();
      const replayErrors = [];
      for await (const replay of Worker.runReplayHistories({ workflowBundle: bundle, sinks: workflowTracingOptions(exporter).sinks },
        [{ workflowId: "dummyTurnWorkflow-recorded-history", history }])) if (replay.error) replayErrors.push(replay.error);
      expect(replayErrors).toEqual([]); await exporter.flush(); expect(emitted).toHaveLength(before);
    }); } finally { api.close(); }
  }, 45_000);

  it("nests a real consolidation child under memory maintenance across actual worker queues", async () => {
    const queue = `trace-memory-${++sequence}`, trace = createRequestTraceContext(undefined);
    const run = { id: "run:tracing", workflowId: `child-${queue}`, status: "COMPLETED" };
    const activities = { refreshMemoryGraphSnapshot: () => ({ sourceHash: "synthetic" }), refreshAllMonthsMemoryGraphSnapshot: () => undefined,
      reconcileStaleSpaceAgentSessions: () => undefined, createScheduledMemoryAudit: () => run,
      prepareMemoryConsolidation: () => ({ changeSetId: null, run }) };
    await worker("space-memory-maintenance", activities, () => worker(queue, activities, async () => {
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", { workflowId: queue, taskQueue: queue,
        args: [{ scheduledAt: "2026-10-20T00:00:00Z", traceId: "req:memory-trace" }], memo: { traceparent: trace.traceparent } });
      await handle.result(); await exporter.flush();
      const spans = emitted.filter(span => span.traceId === trace.w3cTraceId);
      const parent = spans.find(span => span.name === "workflow memoryMaintenanceWorkflow");
      const child = spans.find(span => span.name === "workflow memoryConsolidationWorkflow");
      expect(parent.parentSpanId).toBe(trace.spanId); expect(child.parentSpanId).toBe(parent.spanId);
      const preparation = spans.find(span => span.name === "activity prepareMemoryConsolidation");
      expect(preparation.parentSpanId).toBe(child.spanId);
    }));
  }, 30_000);

  it("links a real continued goal run back to its previous run without changing production code", async () => {
    const queue = `trace-goal-${++sequence}`, trace = createRequestTraceContext(undefined); let steps = 0;
    await worker(queue, { dotGoalStep: () => ++steps <= 300 ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" } }, async () => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", { workflowId: queue, taskQueue: queue,
        args: [{ goalId: "goal:tracing" }], memo: { traceparent: trace.traceparent } });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" }); await exporter.flush();
      const runs = emitted.filter(span => span.traceId === trace.w3cTraceId && span.name === "workflow dotGoalWorkflow");
      expect(runs).toHaveLength(2);
      const continued = runs.find(span => span.links?.length);
      expect(continued).toBeDefined(); expect(continued.parentSpanId).toBe(trace.spanId);
      expect(continued.links).toEqual([{ traceId: trace.w3cTraceId, spanId: runs.find(span => span.spanId !== continued.spanId).spanId }]);
    });
  }, 45_000);

  it("replays a pre-instrumentation production history without exporting a span", async () => {
    const history = temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(
      new URL("./fixtures/pre-tracing-dummy-history.json", import.meta.url), "utf8")));
    await exporter.flush(); const before = emitted.length; const failures = [];
    for await (const replay of Worker.runReplayHistories({ workflowBundle: bundle, sinks: workflowTracingOptions(exporter).sinks },
      [{ workflowId: "dummyTurnWorkflow-pre-instrumentation", history }])) if (replay.error) failures.push(replay.error);
    expect(failures).toEqual([]); await exporter.flush(); expect(emitted).toHaveLength(before);
  }, 30_000);

  it("links an actual background continuation to its originating trace", async () => {
    const queue = `trace-background-${++sequence}`, trace = createRequestTraceContext(undefined);
    let release!: () => void, finished!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reachedFinish = new Promise<void>(resolve => { finished = resolve; });
    const automatic = { missionId: "mission:tracing", turn: { ...turn, traceId: "trace:bg-synthetic", traceparent: trace.traceparent,
      agentRunId: "agent_run:background", roomAgentContinuation: { sourceRunId: "agent_run:previous", generation: 1 } } };
    await worker(queue, { prepareRoomAgentBackgroundContinuation: () => ({ state: "READY", item: automatic }),
      checkRoomAgentSupervisorTurn: () => "READY", runCodexAppServerTurn: () => ({ status: "COMPLETED", message: secret }),
      finishRoomAgentSupervisorTurn: async () => { finished(); await gate; } }, async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { workflowId: queue, taskQueue: queue,
        args: [{ roomId: turn.roomId, monitoringMissionIds: [automatic.missionId] }], memo: { traceparent: trace.traceparent } });
      const clock = env.sleep("10 seconds");
      try {
        await reachedFinish; await exporter.flush();
        const spans = emitted.filter(span => span.traceId === trace.w3cTraceId);
        // An open supervisor has not ended its span. Its completed child still
        // uses the exact parent ID that this actual run will export on closure.
        expect(spans.some(span => span.name === "workflow roomAgentSupervisorWorkflow")).toBe(false);
        const child = spans.find(span => span.name === "workflow codexAppServerTurnWorkflow");
        expect(child.parentSpanId).toBe(workflowSpanId(handle.firstExecutionRunId));
        expect(child.links).toEqual([{ traceId: trace.w3cTraceId, spanId: trace.spanId }]);
        expect(JSON.stringify(spans)).not.toContain(secret);
      } finally { release(); await clock; await handle.terminate("Synthetic continuation proof complete"); }
    });
  }, 30_000);
});
