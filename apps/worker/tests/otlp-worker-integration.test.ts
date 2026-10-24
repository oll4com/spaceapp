import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOtlpSpanExporter, InMemorySpaceStore, otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { requestTraceContexts, traceContextForRawRequest, withTurnTraceparent, workflowCorrelationMemo } from "../../api/src/trace-context.js";
import { noteActivityFailureReason } from "../src/activity-observability.js";
import { createWorkerTracing } from "../src/worker-tracing.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import type { TraceTestActivities, TraceTestInput } from "./fixtures/otlp-workflows.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const callerSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${callerSpanId}-01`;
const privateText = "PRIVATE-PROMPT-and-tool-output-must-stay-local";
const privatePath = "/private/synthetic-test-workspace/source.ts";
const privateUrl = "https://private.invalid/provider?secret=synthetic-test-value";
const workflowInterceptorModule = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));
const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-workflows.ts", import.meta.url));

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: OtlpAttribute[];
  status: { code: number };
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  links?: Array<{ traceId: string; spanId: string }>;
}
interface OtlpRequest {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ spans: OtlpSpan[] }>;
  }>;
}

function attributes(span: OtlpSpan): Record<string, string> {
  return Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? ""]));
}

async function startCollector() {
  const requests: Array<{ path: string; contentType: string; body: OtlpRequest }> = [];
  const heldResponses = new Set<ServerResponse>();
  let holdResponses = false;
  let statusCode = 200;
  let notifyRequest: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    requests.push({ path: request.url ?? "", contentType: request.headers["content-type"] ?? "", body: JSON.parse(body) as OtlpRequest });
    notifyRequest?.();
    if (holdResponses) {
      heldResponses.add(response);
      response.on("close", () => heldResponses.delete(response));
    } else {
      response.writeHead(statusCode, { "content-type": "application/json" }).end("{}");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    spans: () => requests.flatMap(({ body }) => body.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))),
    fail: () => { statusCode = 503; },
    hold: () => { holdResponses = true; },
    get pendingResponses() { return heldResponses.size; },
    nextRequest: () => new Promise<void>((resolve) => { notifyRequest = resolve; }),
    release: () => {
      holdResponses = false;
      for (const response of heldResponses) response.writeHead(200, { "content-type": "application/json" }).end("{}");
      heldResponses.clear();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

const testActivities: TraceTestActivities = {
  noArgumentActivity: async () => "done",
  retryOnceActivity: async () => {
    if (Context.current().info.attempt === 1) {
      throw ApplicationFailure.create({ message: privateText, type: "TOOL_UNAVAILABLE" });
    }
    return "retried";
  },
  privateActivity: async () => {
    noteActivityFailureReason("TOOL_UNAVAILABLE");
    return { status: "FAILED", message: privateText };
  }
};

describe("OTLP through real Temporal workflows and activities", () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;
  let untracedBundle: WorkflowBundleWithSourceMap;

  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    env = await TestWorkflowEnvironment.createTimeSkipping();
    [workflowBundle, untracedBundle] = await Promise.all([
      bundleWorkflowCode({ workflowsPath, workflowInterceptorModules: [workflowInterceptorModule], logger: new DefaultLogger("ERROR") }),
      bundleWorkflowCode({ workflowsPath, logger: new DefaultLogger("ERROR") })
    ]);
  }, 90_000);

  afterAll(async () => { await env?.teardown(); });

  async function workerFor(spans: SpanExporter | null, overrides: Partial<TraceTestActivities> = {}) {
    const taskQueue = `otlp-test-${randomUUID()}`;
    const tracing = createWorkerTracing(spans, { workflowInterceptorModule });
    const worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowBundle: spans ? workflowBundle : untracedBundle,
      ...tracing,
      // The same workflow interceptor is already in the prebuilt bundle.
      interceptors: { ...tracing.interceptors, workflowModules: [] },
      activities: { ...testActivities, ...overrides },
      shutdownForceTime: "10 seconds"
    });
    return { worker, taskQueue };
  }

  function exporter(endpoint: string, serviceName = "space-worker") {
    return createOtlpSpanExporter({ endpoint, serviceName, flushIntervalMs: 60_000, batchSize: 512 });
  }

  it("connects a real API span to workflow, child and every activity attempt, then replays without exports", async () => {
    const collector = await startCollector();
    const apiSpans = exporter(collector.endpoint, "space-api");
    const workerSpans = exporter(collector.endpoint);
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiSpans });
    const app = Fastify({ genReqId: () => "req:otlp-integration" });
    app.addHook("onRequest", async (request) => {
      requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
      observability.onRequest(request);
    });
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    const workflowId = `otlp-tree-${randomUUID()}`;
    const { worker, taskQueue } = await workerFor(workerSpans);
    app.post("/api/trace-test/:roomId", async (request) => {
      const input = withTurnTraceparent<TraceTestInput>({
        traceId: request.id, roomId: "room:integration", missionId: "mission:integration",
        prompt: privateText, toolOutput: privateText, path: privatePath, url: privateUrl
      });
      return env.client.workflow.execute("traceTreeWorkflow", {
        workflowId, taskQueue, args: [input], memo: workflowCorrelationMemo(input)
      });
    });
    try {
      const response = await worker.runUntil(app.inject({
        method: "POST", url: "/api/trace-test/private-room?query=private-query-value", headers: { traceparent }
      }));
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(["done", "retried", "done", "done"]);
      await Promise.all([apiSpans.flush(), workerSpans.flush()]);
      const spans = collector.spans();
      expect(spans).toHaveLength(9);
      expect(new Set(spans.map((span) => span.spanId)).size).toBe(spans.length);
      expect(new Set(spans.map((span) => span.traceId))).toEqual(new Set([traceId]));
      const api = spans.find((span) => span.kind === 2)!;
      const workflow = spans.find((span) => span.name === "workflow traceTreeWorkflow")!;
      const child = spans.find((span) => span.name === "workflow traceChildWorkflow")!;
      expect(api).toMatchObject({ name: "POST /api/trace-test/:roomId", parentSpanId: callerSpanId });
      expect(workflow).toMatchObject({ kind: 1, parentSpanId: api.spanId });
      expect(child).toMatchObject({ kind: 1, parentSpanId: workflow.spanId });
      const activities = spans.filter((span) => attributes(span)["space.activity_type"]);
      expect(activities).toHaveLength(6);
      for (const activity of activities) {
        const values = attributes(activity);
        expect(activity.parentSpanId).toBe(values["space.workflow_type"] === "traceChildWorkflow" ? child.spanId : workflow.spanId);
        expect(values["space.activity_id"]).toBeTruthy();
        expect(values["space.temporal_run_id"]).toBeTruthy();
      }
      const retries = activities.filter((span) => attributes(span)["space.activity_type"] === "retryOnceActivity")
        .sort((a, b) => Number(attributes(a)["space.attempt"]) - Number(attributes(b)["space.attempt"]));
      expect(retries).toHaveLength(2);
      expect(attributes(retries[0]!)).toMatchObject({
        "space.attempt": "1", "space.outcome": "FAILED", "space.reason_code": "TOOL_UNAVAILABLE", "space.failure_category": "TOOL_UNAVAILABLE"
      });
      expect(retries[0]!.status.code).toBe(2);
      expect(attributes(retries[1]!)).toMatchObject({ "space.attempt": "2", "space.outcome": "COMPLETED" });
      expect(retries[1]!.status.code).toBe(0);
      expect(attributes(activities.find((span) => attributes(span)["space.activity_type"] === "privateActivity")!))
        .toMatchObject({ "space.outcome": "FAILED_RESULT", "space.reason_code": "TOOL_UNAVAILABLE" });

      const allowedAttributes = new Set([
        "http.request.method", "http.route", "http.response.status_code", "space.request_id",
        "space.workflow_type", "space.workflow_id", "space.temporal_run_id", "space.activity_type", "space.activity_id",
        "space.attempt", "space.outcome", "space.duration_ms", "space.queue_ms", "space.reason_code", "space.failure_category",
        "space.trace_id", "space.w3c_trace_id", "space.mission_id", "space.room_id"
      ]);
      for (const span of spans) {
        expect(span.attributes.map(({ key }) => key).filter((key) => !allowedAttributes.has(key))).toEqual([]);
        expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
      }
      const wire = JSON.stringify(collector.requests);
      for (const secret of [privateText, privatePath, privateUrl, "private-room", "private-query-value"]) expect(wire).not.toContain(secret);
      expect(collector.requests.every((request) => request.path === "/v1/traces" && request.contentType === "application/json")).toBe(true);
      expect(new Set(collector.requests.flatMap(({ body }) => body.resourceSpans.map((resource) =>
        resource.resource.attributes.find(({ key }) => key === "service.name")?.value.stringValue))))
        .toEqual(new Set(["space-api", "space-worker"]));

      const requestCount = collector.requests.length;
      const beforeReplay = workerSpans.stats();
      for (const replayWorkflowId of [workflowId, `${workflowId}:child`]) {
        const history = await env.client.workflow.getHandle(replayWorkflowId).fetchHistory();
        expect(history.events!.length).toBeGreaterThan(5);
        const tracing = createWorkerTracing(workerSpans, { workflowInterceptorModule });
        await Worker.runReplayHistory({ workflowBundle, sinks: tracing.sinks }, history, replayWorkflowId);
      }
      await workerSpans.flush();
      expect(collector.requests).toHaveLength(requestCount);
      expect(workerSpans.stats()).toEqual(beforeReplay);
    } finally {
      await app.close();
      observability.close();
      await Promise.all([apiSpans.close(), workerSpans.close()]);
      await collector.close();
    }
  }, 60_000);

  it("links distinct continue-as-new runs and attaches no-argument activities to their own run", async () => {
    const collector = await startCollector();
    const spans = exporter(collector.endpoint);
    try {
      const { worker, taskQueue } = await workerFor(spans);
      const workflowId = `otlp-continue-${randomUUID()}`;
      expect(await worker.runUntil(env.client.workflow.execute("traceContinueWorkflow", {
        workflowId, taskQueue, args: [0], memo: { traceparent }
      }))).toBe("continued");
      await spans.flush();
      const exported = collector.spans();
      const workflows = exported.filter((span) => span.name === "workflow traceContinueWorkflow");
      expect(workflows).toHaveLength(2);
      const first = workflows.find((span) => span.parentSpanId === callerSpanId)!;
      const next = workflows.find((span) => span.spanId !== first.spanId)!;
      expect(next).toMatchObject({ traceId, parentSpanId: first.spanId, links: [{ traceId, spanId: first.spanId }] });
      expect(attributes(first)["space.temporal_run_id"]).not.toBe(attributes(next)["space.temporal_run_id"]);
      const activities = exported.filter((span) => attributes(span)["space.activity_type"]);
      expect(activities).toHaveLength(2);
      for (const activity of activities) {
        const run = workflows.find((workflow) => attributes(workflow)["space.temporal_run_id"] === attributes(activity)["space.temporal_run_id"]);
        expect(activity.parentSpanId).toBe(run!.spanId);
      }
      const requestCount = collector.requests.length;
      for (const workflow of workflows) {
        const history = await env.client.workflow.getHandle(workflowId, attributes(workflow)["space.temporal_run_id"]).fetchHistory();
        await Worker.runReplayHistory({ workflowBundle, sinks: createWorkerTracing(spans).sinks }, history, workflowId);
      }
      await spans.flush();
      expect(collector.requests).toHaveLength(requestCount);
    } finally {
      await spans.close();
      await collector.close();
    }
  }, 60_000);

  it("separates requests on a long-lived supervisor and links successive background missions to the actual preceding spans", async () => {
    const collector = await startCollector();
    const apiSpans = exporter(collector.endpoint, "space-api");
    const spans = exporter(collector.endpoint);
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiSpans });
    const app = Fastify({ genReqId: () => `req:${randomUUID()}` });
    app.addHook("onRequest", async (request) => {
      requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
      observability.onRequest(request);
    });
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    const { worker, taskQueue } = await workerFor(spans);
    const workflowId = `otlp-supervisor-${randomUUID()}`;
    const handle = env.client.workflow.getHandle(workflowId);
    const secondTraceId = "2bf92f3577b34da6a3ce929d0e0e4736";
    app.post("/api/start-trace-supervisor", async (request) => {
      const input = withTurnTraceparent({ traceId: request.id, missionId: "mission:first" });
      await env.client.workflow.start("traceMissionWorkflow", {
        workflowId, taskQueue, args: [4], memo: workflowCorrelationMemo(input)
      });
      await handle.signal("traceMission", input);
      return { ok: true };
    });
    app.post("/api/trace-mission", async (request) => {
      await handle.signal("traceMission", withTurnTraceparent({ traceId: request.id, missionId: "mission:second" }));
      return { ok: true };
    });
    const mission = (missionId: string) => collector.spans().find((span) =>
      span.name === "workflow traceMissionWorkflow mission" && attributes(span)["space.mission_id"] === missionId)!;
    const waitForMission = async (count: number) => {
      await expect.poll(() => handle.query<number>("completedTraceMissions"), { timeout: 10_000 }).toBe(count);
      await spans.flush();
    };
    try {
      expect(await worker.runUntil(async () => {
        expect((await app.inject({ method: "POST", url: "/api/start-trace-supervisor", headers: { traceparent } })).statusCode).toBe(200);
        await waitForMission(1);
        expect((await app.inject({
          method: "POST", url: "/api/trace-mission", headers: { traceparent: `00-${secondTraceId}-${callerSpanId}-01` }
        })).statusCode).toBe(200);
        await waitForMission(2);
        const second = mission("mission:second");
        expect(second).toBeDefined();
        await handle.signal("traceMission", {
          traceId: "trace:bg-integration-one", agentRunId: "agentrun:bg-integration-one", missionId: "mission:bg-one",
          continuedTraceparent: `00-${second.traceId}-${second.spanId}-01`
        });
        await waitForMission(3);
        const background = mission("mission:bg-one");
        expect(background).toBeDefined();
        await handle.signal("traceMission", {
          traceId: "trace:bg-integration-two", agentRunId: "agentrun:bg-integration-two", missionId: "mission:bg-two",
          continuedTraceparent: `00-${background.traceId}-${background.spanId}-01`
        });
        return handle.result();
      })).toBe(4);
      await Promise.all([apiSpans.flush(), spans.flush()]);
      const exported = collector.spans();
      const root = exported.find((span) => span.name === "workflow traceMissionWorkflow")!;
      const firstApi = exported.find((span) => span.name === "POST /api/start-trace-supervisor")!;
      const secondApi = exported.find((span) => span.name === "POST /api/trace-mission")!;
      const first = mission("mission:first");
      const second = mission("mission:second");
      const background = mission("mission:bg-one");
      const nextBackground = mission("mission:bg-two");
      expect(root).toMatchObject({ traceId, parentSpanId: firstApi.spanId });
      expect(first).toMatchObject({ traceId, parentSpanId: firstApi.spanId });
      expect(second).toMatchObject({ traceId: secondTraceId, parentSpanId: secondApi.spanId });
      expect(second.links).toContainEqual({ traceId: root.traceId, spanId: root.spanId });
      expect(new Set([first.traceId, second.traceId, background.traceId, nextBackground.traceId]).size).toBe(4);
      for (const [previous, current] of [[second, background], [background, nextBackground]]) {
        expect(current!.parentSpanId).toBeUndefined();
        expect(current!.links).toContainEqual({ traceId: previous!.traceId, spanId: previous!.spanId });
      }
      const activitySpans = exported.filter((span) => attributes(span)["space.activity_type"]);
      expect(activitySpans).toHaveLength(4);
      for (const current of [first, second, background, nextBackground]) {
        expect(activitySpans.filter((span) => span.traceId === current.traceId && span.parentSpanId === current.spanId)).toHaveLength(1);
      }
      const count = collector.requests.length;
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowBundle, sinks: createWorkerTracing(spans).sinks }, history, workflowId);
      await spans.flush();
      expect(collector.requests).toHaveLength(count);
    } finally {
      await app.close();
      observability.close();
      await Promise.all([apiSpans.close(), spans.close()]);
      await collector.close();
    }
  }, 60_000);

  it("finishes real workflow work while the collector has not responded", async () => {
    const collector = await startCollector();
    collector.hold();
    const spans = createOtlpSpanExporter({ endpoint: collector.endpoint, serviceName: "space-worker", batchSize: 1, timeoutMs: 30_000 });
    try {
      const requestReceived = collector.nextRequest();
      const { worker, taskQueue } = await workerFor(spans);
      const result = await worker.runUntil(env.client.workflow.execute("traceSingleActivityWorkflow", {
        workflowId: `otlp-slow-${randomUUID()}`, taskQueue, memo: { traceparent }
      }));
      await requestReceived;
      expect(result).toBe("done");
      // No wall-clock threshold: the collector is still deliberately blocked
      // after both the activity and its workflow have completed successfully.
      expect(collector.pendingResponses).toBe(1);
      expect(spans.stats().exported).toBe(0);
      collector.release();
      await spans.flush();
      expect(spans.stats()).toMatchObject({ exported: 2, failed: 0 });
    } finally {
      collector.release();
      await spans.close();
      await collector.close();
    }
  }, 60_000);

  it("exports production maintenance, consolidation and mutation workflows across both memory worker queues", async () => {
    const collector = await startCollector();
    const maintenanceSpans = exporter(collector.endpoint, "space-memory-maintenance-worker");
    const mutationSpans = exporter(collector.endpoint, "space-memory-mutation-worker");
    const sourceHash = "a".repeat(64);
    const changeSetId = "changeset:otlp-integration";
    const maintenanceResult = {
      status: "REFRESHED", generatedAt: "2026-10-18T00:00:00.000Z", sourceHash, previousSourceHash: null,
      summary: { sourceCount: 0, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 }, durationMs: 1
    };
    const run = new InMemorySpaceStore().createMemoryConsolidationRun({
      mode: "REPAIR", triggerKind: "SCHEDULED", workflowId: `otlp-consolidation-${randomUUID()}`,
      dedupeKey: `otlp-memory-${randomUUID()}`, sourceHash, actorUserId: null
    });
    const mutationResult = { status: "APPLIED", changeSetId, resultingSourceHash: sourceHash, reason: null };
    try {
      const [maintenanceBundle, mutationBundle] = await Promise.all([
        bundleWorkflowCode({
          workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
          workflowInterceptorModules: [workflowInterceptorModule], logger: new DefaultLogger("ERROR")
        }),
        bundleWorkflowCode({
          workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)),
          workflowInterceptorModules: [workflowInterceptorModule], logger: new DefaultLogger("ERROR")
        })
      ]);
      const maintenanceTracing = createWorkerTracing(maintenanceSpans);
      const mutationTracing = createWorkerTracing(mutationSpans);
      const maintenance = await Worker.create({
        connection: env.nativeConnection, namespace: env.namespace, taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowBundle: maintenanceBundle, ...maintenanceTracing,
        interceptors: { ...maintenanceTracing.interceptors, workflowModules: [] },
        activities: {
          refreshMemoryGraphSnapshot: async () => maintenanceResult,
          refreshAllMonthsMemoryGraphSnapshot: async () => maintenanceResult,
          reconcileStaleSpaceAgentSessions: async () => 0,
          createScheduledMemoryAudit: async () => run,
          prepareMemoryConsolidation: async () => ({ run, changeSetId }),
          finalizeMemoryRepair: async () => run
        }
      });
      const mutation = await Worker.create({
        connection: env.nativeConnection, namespace: env.namespace, taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowBundle: mutationBundle, ...mutationTracing,
        interceptors: { ...mutationTracing.interceptors, workflowModules: [] },
        activities: { executePersistedMemoryChangeSet: async () => mutationResult }
      });
      const maintenanceId = `otlp-maintenance-${randomUUID()}`;
      const mutationId = `otlp-mutation-${randomUUID()}`;
      const results = await maintenance.runUntil(mutation.runUntil(async () => {
        const maintenanceResult = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
          workflowId: maintenanceId, taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          args: [{ scheduledAt: "2026-10-18T00:00:00.000Z", traceId: "req:memory-integration" }], memo: { traceparent }
        });
        const mutationResult = await env.client.workflow.execute("memoryMutationWorkflow", {
          workflowId: mutationId, taskQueue: MEMORY_MUTATION_TASK_QUEUE,
          args: [{ changeSetId, traceId: "req:memory-integration" }], memo: { traceparent }
        });
        return [maintenanceResult, mutationResult];
      }));
      expect(results).toEqual([maintenanceResult, mutationResult]);
      await Promise.all([maintenanceSpans.flush(), mutationSpans.flush()]);
      const exported = collector.spans();
      expect(exported).toHaveLength(11);
      expect(new Set(exported.map((span) => span.traceId))).toEqual(new Set([traceId]));
      const maintenanceWorkflow = exported.find((span) => span.name === "workflow memoryMaintenanceWorkflow")!;
      const consolidation = exported.find((span) => span.name === "workflow memoryConsolidationWorkflow")!;
      const mutationWorkflow = exported.find((span) => span.name === "workflow memoryMutationWorkflow")!;
      expect(maintenanceWorkflow.parentSpanId).toBe(callerSpanId);
      expect(consolidation.parentSpanId).toBe(maintenanceWorkflow.spanId);
      expect(mutationWorkflow.parentSpanId).toBe(callerSpanId);
      const workflowsByType = new Map([maintenanceWorkflow, consolidation, mutationWorkflow].map((span) => [attributes(span)["space.workflow_type"], span]));
      for (const span of exported.filter((item) => attributes(item)["space.activity_type"])) {
        expect(span.parentSpanId).toBe(workflowsByType.get(attributes(span)["space.workflow_type"])!.spanId);
      }
      const perService = new Map<string, OtlpSpan[]>();
      for (const { body } of collector.requests) for (const resource of body.resourceSpans) {
        const service = resource.resource.attributes.find(({ key }) => key === "service.name")!.value.stringValue!;
        perService.set(service, [...(perService.get(service) ?? []), ...resource.scopeSpans.flatMap((scope) => scope.spans)]);
      }
      expect(perService.get("space-memory-maintenance-worker")).toHaveLength(8);
      expect(perService.get("space-memory-mutation-worker")).toHaveLength(3);
      const count = collector.requests.length;
      for (const id of [maintenanceId, run.workflowId]) {
        await Worker.runReplayHistory({ workflowBundle: maintenanceBundle, sinks: maintenanceTracing.sinks },
          await env.client.workflow.getHandle(id).fetchHistory(), id);
      }
      await Worker.runReplayHistory({ workflowBundle: mutationBundle, sinks: mutationTracing.sinks },
        await env.client.workflow.getHandle(mutationId).fetchHistory(), mutationId);
      await Promise.all([maintenanceSpans.flush(), mutationSpans.flush()]);
      expect(collector.requests).toHaveLength(count);
    } finally {
      await Promise.all([maintenanceSpans.close(), mutationSpans.close()]);
      await collector.close();
    }
  }, 60_000);

  it("counts refused collector delivery without failing workflow or activity execution", async () => {
    const collector = await startCollector();
    collector.fail();
    const spans = exporter(collector.endpoint);
    try {
      const { worker, taskQueue } = await workerFor(spans);
      expect(await worker.runUntil(env.client.workflow.execute("traceSingleActivityWorkflow", {
        workflowId: `otlp-failure-${randomUUID()}`, taskQueue, memo: { traceparent }
      }))).toBe("done");
      await spans.flush();
      expect(spans.stats()).toEqual({ exported: 0, dropped: 0, failed: 2 });
    } finally {
      await spans.close();
      await collector.close();
    }
  }, 60_000);

  it("runs normally with tracing disabled when no endpoint is configured", async () => {
    const collector = await startCollector();
    try {
      const spans = otlpSpanExporterFromEnv({}, "space-worker");
      expect(spans).toBeNull();
      const { worker, taskQueue } = await workerFor(spans);
      const workflowId = `otlp-disabled-${randomUUID()}`;
      expect(await worker.runUntil(env.client.workflow.execute("traceRandomActivityIdWorkflow", {
        workflowId, taskQueue, memo: { traceparent }
      }))).toBe("done");
      expect(collector.requests).toHaveLength(0);
      // Enabling tracing must also replay histories recorded before this patch,
      // without adding export side effects or changing workflow commands.
      const enabledSpans = exporter(collector.endpoint);
      try {
        await Worker.runReplayHistory({ workflowBundle, sinks: createWorkerTracing(enabledSpans).sinks },
          await env.client.workflow.getHandle(workflowId).fetchHistory(), workflowId);
        await enabledSpans.flush();
        expect(collector.requests).toHaveLength(0);
      } finally {
        await enabledSpans.close();
      }
    } finally {
      await collector.close();
    }
  }, 60_000);
});
