import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { ApplicationFailure } from "@temporalio/common";
import { Client } from "@temporalio/client";
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime/otlp-span-exporter";
import { continuationFixture } from "./room-continuation-fixture.js";
import { prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import { dotGoalStep } from "../src/activities.js";
import { registerDotGoalRoutes } from "../../api/src/dot-goals.js";
import { TemporalCodexAppServerTurnStarter } from "../../api/src/turns.js";
import { createWorkerTracing } from "../src/worker-tracing.js";
import { safeWorkerAttributes } from "../src/temporal-trace-context.js";
import { createHttpObservability } from "../../api/src/observability.js";
import { traceparentForTraceId, workflowCorrelationMemo, requestTraceContexts, traceContextForRawRequest } from "../../api/src/trace-context.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const upstream = `00-${traceId}-00f067aa0ba902b7-01`;
type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number; attributes: { key: string; value: { stringValue?: string; intValue?: string } }[]; links?: { traceId: string; spanId: string }[]; status: { code: number }; service: string };
const attrs = (span: Span) => Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? a.value.intValue]));
async function collector() {
  const spans: Span[] = [], paths: string[] = [];
  const server = createServer(async (req, res) => {
    paths.push(req.url!); const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const data = JSON.parse(Buffer.concat(chunks).toString());
    for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans)
      for (const span of scope.spans) spans.push({ ...span, service: resource.resource.attributes[0].value.stringValue });
    res.writeHead(200, { "content-type": "application/json" }); res.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { spans, paths, endpoint: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())) };
}
const bundle = (relative: string) => bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL(relative, import.meta.url)),
  workflowInterceptorModules: [fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))] });

describe("worker tracing with real Temporal histories", () => {
  let env: TestWorkflowEnvironment, memory: WorkflowBundleWithSourceMap, main: WorkflowBundleWithSourceMap, fixtures: WorkflowBundleWithSourceMap;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    memory = await bundle("../src/memory-maintenance-workflows.ts");
    main = await bundle("../src/workflows.ts");
    fixtures = await bundle("./fixtures/tracing-workflows.ts");
  }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  it("connects a real HTTP request, production memory child and a separately configured activity worker; replay exports nothing", async () => {
    const c = await collector();
    const settings = { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint };
    const maintenance = createWorkerTracing("space-memory-maintenance-worker", settings);
    const mutation = createWorkerTracing("space-memory-mutation-worker", settings);
    const apiExporter = createOtlpSpanExporter({ endpoint: c.endpoint, serviceName: "space-api" });
    const observation = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
    const app = Fastify();
    app.addHook("onRequest", async req => { requestTraceContexts.remember(req.id, traceContextForRawRequest(req.raw)); observation.onRequest(req); });
    app.addHook("onResponse", async (req, reply) => observation.onResponse(req, reply));
    const run = { id: "audit:test", workflowId: "consolidation:test", status: "COMPLETED" };
    const mw = await Worker.create({ connection: env.nativeConnection, taskQueue: "space-memory-maintenance", workflowBundle: memory,
      ...maintenance.options, activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "source:test" }), refreshAllMonthsMemoryGraphSnapshot: async () => ({}),
        reconcileStaleSpaceAgentSessions: async () => ({}), createScheduledMemoryAudit: async () => run,
        prepareMemoryConsolidation: async () => ({ run, changeSetId: "changes:test" }), finalizeMemoryRepair: async () => run
      } });
    const aw = await Worker.create({ connection: env.nativeConnection, taskQueue: "space-memory-mutations", ...mutation.options,
      activities: { executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) } });
    let history: Awaited<ReturnType<ReturnType<typeof env.client.workflow.getHandle>["fetchHistory"]>>;
    app.post("/start", async req => {
      expect(traceparentForTraceId(req.id)).toMatch(new RegExp(`^00-${traceId}-`));
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", { taskQueue: "space-memory-maintenance", workflowId: "maintenance:test",
        args: [{ traceId: req.id }], memo: workflowCorrelationMemo({ traceId: req.id, traceparent: traceparentForTraceId(req.id) }) });
      const result = await handle.result(); history = await handle.fetchHistory(); return result;
    });
    try {
      await mw.runUntil(() => aw.runUntil(async () => {
        expect((await app.inject({ method: "POST", url: "/start", headers: { traceparent: upstream } })).statusCode).toBe(200);
      }));
      await Promise.all([maintenance.close(), mutation.close(), apiExporter.close()]);
      const api = c.spans.find(s => s.kind === 2)!;
      const parent = c.spans.find(s => s.name === "memoryMaintenanceWorkflow")!;
      const child = c.spans.find(s => s.name === "memoryConsolidationWorkflow")!;
      const remote = c.spans.find(s => s.name === "activity executePersistedMemoryChangeSet")!;
      expect(api).toBeDefined(); expect(parent.parentSpanId).toBe(api.spanId); expect(child.parentSpanId).toBe(parent.spanId);
      expect(remote.parentSpanId).toBe(child.spanId); expect(remote.service).toBe("space-memory-mutation-worker");
      expect(new Set(c.spans.map(s => s.traceId))).toEqual(new Set([traceId]));
      expect(c.paths.every(p => p === "/v1/traces")).toBe(true);
      const count = c.spans.length;
      const replay = createWorkerTracing("replay-worker", settings);
      await Worker.runReplayHistory({ workflowBundle: memory, sinks: replay.options.sinks }, history!);
      await replay.close(); expect(c.spans).toHaveLength(count);
    } finally { await app.close(); observation.close(); await Promise.all([maintenance.close(), mutation.close(), apiExporter.close()]); await c.close(); }
  }, 60_000);

  it("keeps the Dot Goal activity, internal API and resulting real turn workflow in one tree", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const apiExporter = createOtlpSpanExporter({ endpoint: c.endpoint, serviceName: "space-api" });
    const observation = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
    let requestNumber = 0;
    const app = Fastify({ genReqId: () => `req:goal-trace-${++requestNumber}` }), f = continuationFixture();
    app.addHook("onRequest", async req => { requestTraceContexts.remember(req.id, traceContextForRawRequest(req.raw)); observation.onRequest(req); });
    app.addHook("onResponse", async (req, reply) => observation.onResponse(req, reply));
    // The outer execute already unlocks the test server's clock. A second
    // time-skipping result() inside an activity can expire that activity while
    // its HTTP handler is still returning, causing spurious retries and a
    // worker shutdown that waits on the retried request. Use a production
    // client for this nested API call so only the outer wait advances time.
    const apiClient = new Client({ connection: env.connection });
    const starter = new TemporalCodexAppServerTurnStarter({ address: "test", namespace: "default", taskQueue: "trace-goal",
      clientFactory: async () => ({ client: apiClient, close: async () => undefined }) });
    registerDotGoalRoutes(app, { step: async (_goalId: string, requestId: string) => {
      const started = await starter.start({ ...f.initial.queueItem.turn, traceId: requestId });
      await apiClient.workflow.getHandle(started.workflowId).result();
      return { state: "DONE", goal: { status: "COMPLETED" } };
    } } as never, null, { routeOptions: {}, authenticatedOwner: async () => "user:test" });
    const internalFetch: typeof fetch = async (url, init) => {
      const result = await app.inject({ method: "POST", url: new URL(String(url)).pathname, headers: init?.headers as Record<string, string>, payload: String(init?.body) });
      return new Response(result.body, { status: result.statusCode });
    };
    vi.stubEnv("SPACE_INTERNAL_API_TOKEN", "synthetic-test-token");
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-goal", workflowBundle: main, ...tracing.options,
      activities: { dotGoalStep: (id: string) => dotGoalStep(id, internalFetch), runCodexAppServerTurn: async () => ({ status: "COMPLETED" }) } });
    app.post("/start-goal", async req => env.client.workflow.execute("dotGoalWorkflow", { taskQueue: "trace-goal", workflowId: "trace:goal",
      args: [{ goalId: "dot_goal:abcdefgh1" }], memo: workflowCorrelationMemo({ traceId: req.id, traceparent: traceparentForTraceId(req.id) }) }));
    try {
      await worker.runUntil(async () => { expect((await app.inject({ method: "POST", url: "/start-goal", headers: { traceparent: upstream } })).statusCode).toBe(200); });
      await Promise.all([tracing.close(), apiExporter.close()]);
      expect(c.spans.filter(s => s.name === "activity dotGoalStep")).toHaveLength(1);
      expect(c.spans.filter(s => s.name === "codexAppServerTurnWorkflow")).toHaveLength(1);
      const goal = c.spans.find(s => s.name === "dotGoalWorkflow")!, step = c.spans.find(s => s.name === "activity dotGoalStep")!;
      const internal = c.spans.find(s => s.kind === 2 && s.parentSpanId === step.spanId)!;
      const turn = c.spans.find(s => s.name === "codexAppServerTurnWorkflow")!, activity = c.spans.find(s => s.name === "activity runCodexAppServerTurn")!;
      expect(step.parentSpanId).toBe(goal.spanId); expect(internal).toBeDefined(); expect(turn.parentSpanId).toBe(internal.spanId);
      expect(activity.parentSpanId).toBe(turn.spanId); expect(c.spans.some(s => s.kind === 2 && s.spanId === goal.parentSpanId)).toBe(true);
      expect(c.spans.every(s => s.traceId === traceId)).toBe(true);
    } finally { vi.unstubAllEnvs(); await app.close(); observation.close(); await Promise.all([tracing.close(), apiExporter.close()]); await c.close(); }
  }, 60_000);

  it("replays a production history recorded with tracing disabled without sending spans", async () => {
    const disabled = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)) });
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-off-history", workflowBundle: disabled,
      activities: { runCodexAppServerTurn: async () => ({ status: "COMPLETED" }) } });
    const handle = await worker.runUntil(async () => {
      const h = await env.client.workflow.start("codexAppServerTurnWorkflow", { taskQueue: "trace-off-history", workflowId: "trace:off-history", args: [{ traceparent: upstream }] });
      await h.result(); return h;
    });
    const c = await collector(), tracing = createWorkerTracing("replay", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    try { await Worker.runReplayHistory({ workflowBundle: main, sinks: tracing.options.sinks }, await handle.fetchHistory());
      await tracing.close(); expect(c.spans).toHaveLength(0); }
    finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("does not export workflow completion for a retryable Workflow Task error", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const broken = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-task-error", workflowBundle: fixtures, ...tracing.options });
    const handle = await env.client.workflow.start("recoverableTaskFailure", { taskQueue: "trace-task-error", workflowId: "trace:task-error", args: [] });
    try {
      await broken.runUntil(async () => { await vi.waitFor(async () => {
        const history = await handle.fetchHistory(); expect(history.events?.some(e => e.workflowTaskFailedEventAttributes)).toBe(true);
      }, { timeout: 15_000 }); });
      await tracing.exporter!.flush(); expect(c.spans).toHaveLength(0); expect((await handle.describe()).status.name).toBe("RUNNING");
      const repaired = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-task-error",
        workflowBundle: await bundle("./fixtures/repaired-tracing-workflow.ts"), ...tracing.options });
      await repaired.runUntil(() => handle.result()); await tracing.close();
      expect(c.spans).toHaveLength(1); expect(attrs(c.spans[0]!)["space.outcome"]).toBe("COMPLETED");
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("records every attempt of the production turn workflow with stable failure categories and no user text", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    let calls = 0;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-turn", workflowBundle: main, ...tracing.options,
      activities: { runCodexAppServerTurn: async () => { if (++calls === 1) throw ApplicationFailure.retryable("secret error /private/path", "PROVIDER_ERROR"); return { status: "COMPLETED" }; } } });
    try {
      await worker.runUntil(() => env.client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: "trace-turn", workflowId: "trace:turn",
        args: [{ traceId: "req:turn", traceparent: upstream, prompt: "secret prompt", roomId: "room:test", paneId: "pane:test" }] }));
      await tracing.close();
      const wf = c.spans.find(s => s.name === "codexAppServerTurnWorkflow")!;
      const acts = c.spans.filter(s => s.name === "activity runCodexAppServerTurn");
      expect(acts).toHaveLength(2); expect(new Set(acts.map(s => s.spanId)).size).toBe(2);
      expect(acts.map(s => attrs(s)["space.attempt"]).sort()).toEqual(["1", "2"]);
      expect(acts.every(s => s.parentSpanId === wf.spanId && s.traceId === traceId)).toBe(true);
      expect(attrs(acts.find(s => s.status.code === 2)!)["space.category"]).toBe("PROVIDER_ERROR");
      expect(JSON.stringify(c.spans)).not.toMatch(/secret|private|prompt|error.message/);
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("carries a span link and trace through continue-as-new without relying on inputs being retained", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-continue", workflowBundle: fixtures,
      ...tracing.options, activities: { probe: async () => "ok" } });
    try {
      await worker.runUntil(() => env.client.workflow.execute("continuingTrace", { taskQueue: "trace-continue", workflowId: "trace:continue", args: [{ remaining: 1, traceparent: upstream }] }));
      await tracing.close();
      const workflows = c.spans.filter(s => s.name === "continuingTrace"); expect(workflows).toHaveLength(2);
      const previous = workflows.find(s => attrs(s)["space.outcome"] === "CONTINUED_AS_NEW")!;
      const next = workflows.find(s => attrs(s)["space.outcome"] === "COMPLETED")!;
      expect(next.links).toContainEqual({ traceId, spanId: previous.spanId });
      expect(c.spans.every(s => s.traceId === traceId)).toBe(true);
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("gives later requests in a long-lived run a workflow node instead of orphaning their activities", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-later", workflowBundle: fixtures,
      ...tracing.options, activities: { perRequest: async () => undefined } });
    const laterTrace = "22222222222222223333333333333333";
    try {
      await worker.runUntil(() => env.client.workflow.execute("laterRequestTrace", { taskQueue: "trace-later", workflowId: "trace:later",
        args: [{ traceparent: upstream, later: { traceparent: `00-${laterTrace}-2222222222222222-01` } }] }));
      await tracing.close();
      const node = c.spans.filter(s => s.traceId === laterTrace && s.name === "laterRequestTrace"); expect(node).toHaveLength(1);
      expect(node[0]!.parentSpanId).toBe("2222222222222222");
      const acts = c.spans.filter(s => s.name === "activity perRequest"); expect(acts).toHaveLength(2);
      expect(acts.every(s => s.traceId === laterTrace && s.parentSpanId === node[0]!.spanId)).toBe(true);
      expect(node[0]!.links ?? []).toEqual([]); // no link to a root that was never emitted
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("exports completed production supervisor missions while waiting, including two API parents in the same trace", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const f = continuationFixture(), first = { ...f.initial.queueItem, turn: { ...f.initial.queueItem.turn, traceparent: upstream } };
    const second = { ...first, turn: { ...first.turn, agentRunId: "agent_run:second", traceparent: `00-${traceId}-3333333333333333-01` } };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-supervisor", workflowBundle: main, ...tracing.options,
      activities: { checkRoomAgentSupervisorTurn: async () => "READY", finishRoomAgentSupervisorTurn: async () => undefined,
        runCodexAppServerTurn: async () => ({ status: "COMPLETED", roomAgentOutcome: { status: "VERIFIED", statusReason: "done" } }) } });
    try {
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: "trace-supervisor", workflowId: "trace:supervisor",
          args: [{ roomId: f.room.id, pending: [first] }], memo: { traceparent: upstream } });
        try {
          await vi.waitFor(async () => { await tracing.exporter!.flush(); expect(c.spans.filter(s => s.name === "roomAgentSupervisorWorkflow")).toHaveLength(1); }, { timeout: 15_000 });
          expect((await handle.describe()).status.name).toBe("RUNNING");
          await handle.signal("enqueueRoomAgentMission", second);
          await vi.waitFor(async () => { await tracing.exporter!.flush(); expect(c.spans.filter(s => s.name === "roomAgentSupervisorWorkflow")).toHaveLength(2); }, { timeout: 15_000 });
          const roots = c.spans.filter(s => s.name === "roomAgentSupervisorWorkflow");
          expect(roots.map(s => s.parentSpanId).sort()).toEqual(["00f067aa0ba902b7", "3333333333333333"]);
          expect(new Set(roots.map(s => s.spanId)).size).toBe(2);
          const children = c.spans.filter(s => s.name === "codexAppServerTurnWorkflow"); expect(children).toHaveLength(2);
          expect(children.every(s => roots.some(r => r.spanId === s.parentSpanId))).toBe(true);
          expect(c.spans.every(s => s.traceId === traceId)).toBe(true);
        } finally { await handle.cancel(); await handle.result().catch(() => undefined); }
        const count = c.spans.length;
        const replay = createWorkerTracing("replay", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
        await Worker.runReplayHistory({ workflowBundle: main, sinks: replay.options.sinks }, await handle.fetchHistory());
        await replay.close(); expect(c.spans).toHaveLength(count);
      });
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("retains a monitored mission context across production supervisor continue-as-new", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const f = continuationFixture(), item = { ...f.initial.queueItem, turn: { ...f.initial.queueItem.turn, traceparent: upstream } };
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-monitor", workflowBundle: main, ...tracing.options,
      activities: { checkRoomAgentSupervisorTurn: async () => "READY", prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" }),
        runCodexAppServerTurn: async () => ({ status: "COMPLETED", roomAgentOutcome: { status: "VERIFIED", statusReason: "running", pendingActionIds: ["action:one"] } }) } });
    try {
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: "trace-monitor", workflowId: "trace:monitor",
          args: [{ roomId: f.room.id, pending: [item], processedCount: 49 }], memo: { traceparent: `00-99999999999999998888888888888888-4444444444444444-01` } });
        try {
          await vi.waitFor(async () => { await tracing.exporter!.flush(); expect(c.spans.filter(s => s.name === "roomAgentSupervisorWorkflow")).toHaveLength(2); }, { timeout: 15_000 });
          const roots = c.spans.filter(s => s.name === "roomAgentSupervisorWorkflow"), first = roots.find(s => s.parentSpanId === "00f067aa0ba902b7")!;
          const monitor = roots.find(s => s !== first)!;
          expect(monitor.parentSpanId).toBe(first.spanId); expect(monitor.links).toContainEqual({ traceId, spanId: first.spanId });
          expect(attrs(monitor)["space.run_id"]).not.toBe(attrs(first)["space.run_id"]);
          const prepare = c.spans.find(s => s.name === "activity prepareRoomAgentBackgroundContinuation")!;
          expect(prepare.parentSpanId).toBe(monitor.spanId); expect(c.spans.every(s => s.traceId === traceId)).toBe(true);
        } finally { await handle.cancel(); await handle.result().catch(() => undefined); }
      });
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("links two real background preparations to emitted source activity spans and gives paused retries unique IDs", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const f = continuationFixture(), item = { ...f.initial.queueItem, turn: { ...f.initial.queueItem.turn, traceparent: upstream } };
    let preparations = 0, paused = false;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-generations", workflowBundle: main, ...tracing.options,
      activities: {
        checkRoomAgentSupervisorTurn: async (queued: typeof item) => { if (queued.turn.roomAgentContinuation && !paused) { paused = true; return "PAUSED"; } return "READY"; },
        runCodexAppServerTurn: async (turn: typeof item.turn) => { f.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
          return { status: "COMPLETED", roomAgentOutcome: { status: "VERIFIED", statusReason: "running", pendingActionIds: ["action:one"] } }; },
        prepareRoomAgentBackgroundContinuation: async (input: typeof f.input) => ++preparations > 2 ? { state: "DONE" } : prepareBackgroundContinuation(input, f.store)
      } });
    try {
      await worker.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: "trace-generations", workflowId: "trace:generations", args: [{ roomId: f.room.id, pending: [item] }] });
        try {
          await vi.waitFor(async () => { await tracing.exporter!.flush(); expect(c.spans.filter(s => s.name === "activity prepareRoomAgentBackgroundContinuation")).toHaveLength(3); }, { timeout: 20_000 });
          const roots = c.spans.filter(s => s.name === "roomAgentSupervisorWorkflow" && !s.parentSpanId);
          expect(roots).toHaveLength(3); // first background paused then completed, second generation completed
          expect(new Set(c.spans.map(s => `${s.traceId}:${s.spanId}`)).size).toBe(c.spans.length);
          for (const root of roots) {
            expect(root.links).toHaveLength(1);
            expect(c.spans.some(s => s.traceId === root.links![0]!.traceId && s.spanId === root.links![0]!.spanId && s.name === "activity prepareRoomAgentBackgroundContinuation")).toBe(true);
          }
          expect(new Set(roots.map(s => s.traceId)).size).toBe(2);
        } finally { await handle.cancel(); await handle.result().catch(() => undefined); }
      });
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);

  it("links a background child trace to its persisted source trace", async () => {
    const c = await collector(), tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: c.endpoint });
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-background", workflowBundle: fixtures,
      ...tracing.options, activities: { probe: async () => "ok" } });
    const nextTrace = "11111111111111112222222222222222";
    try {
      await worker.runUntil(() => env.client.workflow.execute("backgroundTrace", { taskQueue: "trace-background", workflowId: "trace:background",
        args: [{ turn: { traceparent: `00-${nextTrace}-1111111111111111-01`, roomAgentContinuation: { sourceTraceparent: upstream } } }], memo: { traceparent: upstream } }));
      await tracing.close(); const child = c.spans.find(s => s.name === "continuingTrace")!;
      expect(child.traceId).toBe(nextTrace); expect(child.links).toContainEqual({ traceId, spanId: "00f067aa0ba902b7" });
    } finally { await tracing.close(); await c.close(); }
  }, 60_000);
});

it("disables export and workflow interception without configuration for all worker roles", async () => {
  for (const service of ["space-worker", "space-memory-maintenance-worker", "space-memory-mutation-worker"]) {
    const tracing = createWorkerTracing(service, {});
    expect(tracing.exporter).toBeNull(); expect(tracing.options.interceptors.workflowModules).toEqual([]); await tracing.close();
  }
});
it("drops non-allowlisted attributes and free-text values, including misleading allowed keys", () => {
  expect(safeWorkerAttributes({ "space.workflow_id": "/private/path", "space.reason_code": "secret message", prompt: "secret",
    "space.room_id": "https://secret", "space.attempt": NaN, "space.duration_ms": -1, "space.run_id": "run:123", "space.outcome": "COMPLETED", "space.attempts": 1 }))
    .toEqual({ "space.run_id": "run:123", "space.outcome": "COMPLETED" });
});
