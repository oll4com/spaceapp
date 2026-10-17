import Fastify from "fastify";
import { createHttpObservability } from "../../api/src/observability.js";
import { traceContextForRawRequest } from "../../api/src/trace-context.js";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { createOtlpSpanExporter, type ServerSpan, type SpanExporter } from "@space/runtime";
import { MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";
import { createWorkerTracing } from "../src/worker-tracing.js";

const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-workflows.ts", import.meta.url));
const workflowModules = [fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))];
const traceId = "a".repeat(32), apiSpanId = "b".repeat(16);
type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string;
  links?: { traceId: string; spanId: string }[]; attributes: { key: string; value: { intValue?: string; stringValue?: string } }[] };
describe("real Temporal OTLP propagation", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => {
    env = process.env.SPACE_TRACE_JAEGER === "1"
      ? await TestWorkflowEnvironment.createLocal()
      : await TestWorkflowEnvironment.createTimeSkipping();
  }, 120_000);
  afterAll(async () => { await env?.teardown(); });
  it("instruments shipping turn and memory workflows across three worker instances", async () => {
    const recorded: ServerSpan[] = [];
    const exporter: SpanExporter = { record: span => { recorded.push(span); },
      flush: async () => {}, close: async () => {}, stats: () => ({ exported: recorded.length, failed: 0, dropped: 0 }) };
    const tracing = createWorkerTracing({}, "shipping-test", exporter);
    const options = { connection: env.nativeConnection,
      interceptors: { ...tracing.interceptors, workflowModules }, sinks: tracing.sinks };
    const main = await Worker.create({ ...options, taskQueue: "shipping-turn",
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
      activities: { runOpenCodeAgentTurn: async () => ({ status: "COMPLETED" }) } });
    const maintenance = await Worker.create({ ...options, taskQueue: "space-memory-maintenance",
      workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
      activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "a".repeat(64), status: "REFRESHED" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => ({}), reconcileStaleSpaceAgentSessions: async () => ({}),
        createScheduledMemoryAudit: async () => ({ id: "audit:fixture", workflowId: "memory-child-fixture" }),
        prepareMemoryConsolidation: async () => ({ changeSetId: "change:fixture", run: { status: "PREPARED" } }),
        finalizeMemoryRepair: async () => ({ status: "COMPLETED" })
      } });
    const mutation = await Worker.create({ ...options, taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)),
      activities: { executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) } });
    const memo = { traceparent: `00-${traceId}-${apiSpanId}-01` };
    await main.runUntil(() => maintenance.runUntil(() => mutation.runUntil(async () => {
      await env.client.workflow.execute("codexAppServerTurnWorkflow", { workflowId: "shipping-turn-fixture",
        taskQueue: "shipping-turn", args: [{ providerId: "opencode" }], memo });
      await env.client.workflow.execute("memoryMaintenanceWorkflow", { workflowId: "shipping-memory-fixture",
        taskQueue: "space-memory-maintenance", args: [{ traceId: "req:fixture", scheduledAt: new Date().toISOString() }], memo });
      await env.client.workflow.execute("memoryMutationWorkflow", { workflowId: "shipping-mutation-fixture",
        taskQueue: MEMORY_MUTATION_TASK_QUEUE, args: [{ traceId: "req:fixture", changeSetId: "change:fixture" }], memo });
    })));
    for (const name of ["codexAppServerTurnWorkflow", "memoryMaintenanceWorkflow", "memoryMutationWorkflow"]) {
      expect(recorded.find(span => span.name === `workflow ${name}`)?.parentSpanId).toBe(apiSpanId);
    }
    const parent = recorded.find(span => span.name === "workflow memoryMaintenanceWorkflow")!;
    const child = recorded.find(span => span.name === "workflow memoryConsolidationWorkflow")!;
    expect(child.parentSpanId).toBe(parent.spanId);
    const mutationSpan = recorded.find(span => span.name === "activity executePersistedMemoryChangeSet" && span.parentSpanId === child.spanId);
    expect(mutationSpan).toBeDefined();
    expect(recorded.every(span => span.traceId === traceId)).toBe(true);
  }, 120_000);
  it("keeps two requests on one supervisor in their own traces", async () => {
    const recorded: ServerSpan[] = [];
    const exporter: SpanExporter = { record: span => { recorded.push(span); },
      flush: async () => {}, close: async () => {}, stats: () => ({ exported: recorded.length, failed: 0, dropped: 0 }) };
    const tracing = createWorkerTracing({}, "test-supervisor", exporter);
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "supervisor-tracing", workflowsPath,
      interceptors: { ...tracing.interceptors, workflowModules }, sinks: tracing.sinks,
      activities: { tracedActivity: async () => "ok" } });
    const secondTrace = "c".repeat(32);
    await worker.runUntil(() => env.client.workflow.execute("roomAgentSupervisorWorkflow", {
      taskQueue: "supervisor-tracing", workflowId: "supervisor-test",
      args: [{ items: [{ traceparent: `00-${traceId}-${apiSpanId}-01`, missionId: "mission:one" },
        { traceparent: `00-${secondTrace}-${apiSpanId}-01`, missionId: "mission:two" }] }]
    }));
    for (const id of [traceId, secondTrace]) {
      const scope = recorded.find(span => span.traceId === id && span.name === "workflow roomAgentSupervisorWorkflow request")!;
      const child = recorded.find(span => span.traceId === id && span.name === "workflow tracedChild")!;
      const activity = recorded.find(span => span.traceId === id && span.name === "activity tracedActivity")!;
      expect(scope.parentSpanId).toBe(apiSpanId);
      expect(child.parentSpanId).toBe(scope.spanId);
      expect(activity.parentSpanId).toBe(child.spanId);
    }
  }, 120_000);
  it("replays a history made before workflow instrumentation without exporting", async () => {
    const legacy = await Worker.create({ connection: env.nativeConnection, taskQueue: "legacy-tracing", workflowsPath,
      activities: { tracedActivity: async () => "ok" } });
    const handle = await legacy.runUntil(async () => {
      const handle = await env.client.workflow.start("tracedChild", { taskQueue: "legacy-tracing", workflowId: "legacy-trace", args: [] });
      await handle.result();
      return handle;
    });
    let recorded = 0;
    const tracing = createWorkerTracing({}, "replay", { record: () => { recorded++; },
      flush: async () => {}, close: async () => {}, stats: () => ({ exported: recorded, failed: 0, dropped: 0 }) });
    await Worker.runReplayHistory({ workflowsPath, interceptors: { workflowModules }, sinks: tracing.sinks }, await handle.fetchHistory());
    expect(recorded).toBe(0);
  }, 120_000);
  it("connects workflow, child, retry attempts and continuation, and emits nothing on replay", async () => {
    const spans: Span[] = [];
    const server = createServer((req, res) => {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        const value = JSON.parse(body);
        spans.push(...value.resourceSpans[0].scopeSpans[0].spans);
        if (process.env.SPACE_TRACE_JAEGER === "1") {
          void fetch("http://127.0.0.1:4318/v1/traces", { method: "POST", headers: { "content-type": "application/json" }, body })
            .then(response => { res.statusCode = response.status; res.end("{}"); })
            .catch(() => { res.statusCode = 502; res.end("{}"); });
        } else res.end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${port}`, serviceName: "test-worker", flushIntervalMs: 20 });
    const tracing = createWorkerTracing({}, "test-worker", exporter);
    const apiExporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${port}`, serviceName: "test-api", flushIntervalMs: 20 });
    const observability = createHttpObservability({ serviceName: "test-api", spanExporter: apiExporter });
    const app = Fastify();
    app.addHook("onRequest", async request => observability.onRequest(request));
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    let actualApiSpanId = "";
    app.post("/trace-test", async request => {
      const context = traceContextForRawRequest(request.raw);
      actualApiSpanId = context.spanId;
      await env.client.workflow.start("tracedRoot", { taskQueue: "trace-test", workflowId: "trace-root",
        args: [{ traceparent: context.traceparent, continuation: true }] });
      return { ok: true };
    });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "trace-test", workflowsPath,
      interceptors: { ...tracing.interceptors, workflowModules }, sinks: tracing.sinks,
      activities: { tracedActivity: async () => {
        if (Context.current().info.attempt === 1) throw ApplicationFailure.retryable("PRIVATE error", "ACTIVITY_ERROR");
        return "PRIVATE output";
      } }
    });
    try {
      const handle = await worker.runUntil(async () => {
        const response = await fetch(address + "/trace-test", { method: "POST", headers: { traceparent: `00-${traceId}-${apiSpanId}-01` } });
        expect(response.status).toBe(200);
        const handle = env.client.workflow.getHandle("trace-root");
        expect(await handle.result()).toBe("PRIVATE output");
        return handle;
      });
      await exporter.flush();
      await apiExporter.flush();
      const roots = spans.filter(x => x.name === "workflow tracedRoot");
      const child = spans.find(x => x.name === "workflow tracedChild")!;
      const activities = spans.filter(x => x.name === "activity tracedActivity");
      expect(roots).toHaveLength(2);
      expect(roots[0]?.parentSpanId).toBe(actualApiSpanId);
      expect(spans.find(x => x.spanId === actualApiSpanId)?.parentSpanId).toBe(apiSpanId);
      expect(roots[1]?.links).toContainEqual({ traceId, spanId: roots[0]!.spanId });
      expect(child.parentSpanId).toBe(roots[1]?.spanId);
      expect(activities).toHaveLength(6);
      expect(new Set(activities.map(x => x.spanId)).size).toBe(6);
      for (const activity of activities) expect(spans.some(x => x.spanId === activity.parentSpanId)).toBe(true);
      expect(spans.every(x => x.traceId === traceId)).toBe(true);
      expect(JSON.stringify(spans)).not.toMatch(/PRIVATE|prompt|output/);
      expect(exporter.stats().failed).toBe(0);
      expect(apiExporter.stats().failed).toBe(0);
      const count = spans.length;
      await Worker.runReplayHistory({ workflowsPath, interceptors: { workflowModules }, sinks: tracing.sinks }, await handle.fetchHistory());
      await exporter.flush();
      expect(spans).toHaveLength(count);
      const disabled = createWorkerTracing({}, "disabled", null);
      await Worker.runReplayHistory({ workflowsPath, interceptors: { workflowModules }, sinks: disabled.sinks }, await handle.fetchHistory());
      expect(spans).toHaveLength(count);
    } finally {
      await app.close();
      observability.close();
      await apiExporter.close();
      await tracing.close();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  }, 120_000);
});
