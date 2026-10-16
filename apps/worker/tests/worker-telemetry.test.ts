import { createServer, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { Client } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { createWorkerTelemetry } from "../src/worker-telemetry.js";
import { childTraceparent, noteActivityFailureReason } from "../src/activity-observability.js";
import { temporalAttributeKeys, temporalAttributes, workflowSpanId } from "../src/temporal-trace-context.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { createHttpObservability } from "../../api/src/observability.js";
import { requestTraceContexts, traceContextForRawRequest } from "../../api/src/trace-context.js";
import { TemporalCodexAppServerTurnStarter } from "../../api/src/turns.js";

type Span = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  links?: Array<{ traceId: string; spanId: string }>;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>; service: string };
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiParent = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${apiParent}-01`;
const secret = "PRIVATE PROMPT sk-live-not-real /home/operator/private https://secret.invalid";
const complete = { status: "COMPLETED", message: secret };
let collector: Server;
let endpoint: string;
let requests: any[];
let collectorResponds: boolean;
let heldResponses: ServerResponse[];
let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let workers: Worker[];
let running: Promise<void>[];
let telemetries: ReturnType<typeof createWorkerTelemetry>[];
let handles: Array<Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>>;
let handlers: Record<string, (...args: any[]) => unknown>;
let workerFailures: unknown[];
const mainQueue = "synthetic-telemetry";
const serviceQueues = [
  ["space-worker", mainQueue],
  ["space-memory-maintenance-worker", MEMORY_MAINTENANCE_TASK_QUEUE],
  ["space-memory-mutation-worker", MEMORY_MUTATION_TASK_QUEUE]
] as const;

beforeAll(async () => {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  bundle = await bundleWorkflowCode({
    workflowsPath: fileURLToPath(new URL("./support/telemetry-workflows.ts", import.meta.url)),
    workflowInterceptorModules: [fileURLToPath(new URL("../src/workflow-telemetry.ts", import.meta.url))],
    logger: new DefaultLogger("ERROR")
  });
}, 60_000);

beforeEach(async () => {
  requests = []; workers = []; running = []; telemetries = []; handles = []; workerFailures = []; collectorResponds = true; heldResponses = [];
  collector = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ path: request.url, ...JSON.parse(body) });
    if (collectorResponds) response.writeHead(200, { "content-type": "application/json" }).end("{}");
    else heldResponses.push(response);
  });
  await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  env = await TestWorkflowEnvironment.createTimeSkipping();
  handlers = {
    recordDummyTurnStarted: () => undefined, recordDummyTurnCompleted: () => complete,
    runCodexAppServerTurn: () => complete, runOpenCodeAgentTurn: () => complete,
    runRoomAgentBackgroundAction: () => complete, failRoomAgentBackgroundAction: () => undefined,
    dotGoalStep: () => ({ state: "DONE", goalStatus: "COMPLETED", runId: null }),
    checkRoomAgentSupervisorTurn: () => "RUN", markRoomAgentMissionStarted: () => undefined,
    markRoomAgentMissionFinished: () => undefined, finishRoomAgentSupervisorTurn: () => undefined,
    refreshMemoryGraphSnapshot: () => ({ sourceHash: "synthetic", nodeCount: 0, edgeCount: 0 }),
    refreshAllMonthsMemoryGraphSnapshot: () => undefined, reconcileStaleSpaceAgentSessions: () => undefined,
    createScheduledMemoryAudit: () => ({ id: "consolidation:synthetic", workflowId: `synthetic-child-${randomUUID()}` }),
    prepareMemoryConsolidation: () => ({ changeSetId: "change:synthetic", run: { id: "consolidation:synthetic" } }),
    executePersistedMemoryChangeSet: () => ({ status: "APPLIED" }), finalizeMemoryRepair: () => ({ status: "COMPLETED" })
  };
  for (const [serviceName, taskQueue] of serviceQueues) {
    // Exercise the same environment configuration and options as the real entrypoints.
    const telemetry = createWorkerTelemetry({ serviceName, env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint } });
    telemetries.push(telemetry);
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowBundle: bundle,
      sinks: telemetry.workerOptions.sinks,
      interceptors: { activity: telemetry.workerOptions.interceptors!.activity },
      activities: Object.fromEntries(Object.keys(handlers).map(name => [name, (...args: any[]) => handlers[name]!(...args)])),
      maxCachedWorkflows: 16, maxConcurrentWorkflowTaskExecutions: 8, maxConcurrentActivityTaskExecutions: 8,
      maxConcurrentWorkflowTaskPolls: 2, maxConcurrentActivityTaskPolls: 2, shutdownGraceTime: "1 second"
    });
    workers.push(worker);
    running.push(worker.run().catch(error => { workerFailures.push(error); }));
  }
}, 30_000);

afterEach(async () => {
  try {
    for (const handle of handles) if ((await handle.describe()).status.name === "RUNNING") await handle.terminate("Synthetic telemetry cleanup");
    for (const worker of workers) if (worker.getState() === "RUNNING") worker.shutdown();
    await Promise.all(running);
    expect(workerFailures).toEqual([]);
  } finally {
    collectorResponds = true;
    for (const response of heldResponses) response.writeHead(503).end();
    await Promise.all(telemetries.map(telemetry => telemetry.close()));
    await env?.teardown();
    collector.closeAllConnections();
    await new Promise<void>(resolve => collector.close(() => resolve()));
  }
}, 15_000);

function spans(): Span[] {
  return requests.flatMap(request => request.resourceSpans.flatMap((resource: any) =>
    resource.scopeSpans.flatMap((scope: any) => scope.spans.map((span: Span) => ({
      ...span, service: resource.resource.attributes.find((attr: any) => attr.key === "service.name").value.stringValue
    })))));
}
const attrs = (span: Span) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
async function flush() { await Promise.all(telemetries.map(telemetry => telemetry.flush())); }
async function start(type: string, input: unknown, taskQueue = mainQueue) {
  const handle = await env.client.workflow.start(type, {
    workflowId: `synthetic-${type}-${randomUUID()}`, taskQueue, args: [input], memo: { traceparent }
  });
  handles.push(handle);
  return handle;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  expect(predicate()).toBe(true);
}

it("connects the real API SERVER span to the production turn workflow and every retry attempt", async () => {
  const outboundParents: Array<string | null> = [];
  handlers.runCodexAppServerTurn = () => {
    outboundParents.push(childTraceparent(traceparent));
    if (Context.current().info.attempt === 1) throw ApplicationFailure.retryable(secret, "UPSTREAM_RETRYABLE_UNAVAILABLE");
    noteActivityFailureReason("OPENCODE_TURN_TIMEOUT");
    return { status: "FAILED", message: secret };
  };
  const apiExporter = createOtlpSpanExporter({ endpoint, serviceName: "space-api" });
  const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
  const app = Fastify({ genReqId: () => "req:synthetic0001" });
  const starter = new TemporalCodexAppServerTurnStarter({ address: "unused", namespace: env.namespace ?? "default", taskQueue: mainQueue,
    clientFactory: async () => ({ client: env.client, close: async () => undefined }) });
  app.addHook("onRequest", async request => {
    observability.onRequest(request);
    requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
  });
  app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
  app.post("/synthetic/turn", request => starter.start({
    roomId: "room:synthetic0001", paneId: "pane:synthetic0001", traceId: request.id, prompt: secret, artifactIds: [],
    permissionMode: null, collaborationMode: "default"
  }));
  try {
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const response = await fetch(`${address}/synthetic/turn`, { method: "POST", headers: { traceparent } });
    expect(response.status).toBe(200);
    const result = await response.json() as { workflowId: string; runId: string };
    // The manual UI proof uses wall-clock time so Jaeger does not need to
    // correct clock skew between skipped workflow time and host activity time.
    const resultClient = process.env.SPACE_TELEMETRY_PROOF_ENDPOINT
      ? new Client({ connection: env.connection, namespace: env.namespace }) : env.client;
    const handle = resultClient.workflow.getHandle(result.workflowId);
    expect(await handle.result()).toMatchObject({ status: "FAILED" });
    await flush(); await apiExporter.flush();
    const recorded = spans();
    expect(recorded).toHaveLength(4);
    expect(new Set(recorded.map(span => span.traceId))).toEqual(new Set([traceId]));
    const server = recorded.find(span => span.kind === 2)!;
    const workflow = recorded.find(span => span.name === "workflow.codexAppServerTurnWorkflow")!;
    expect(server.parentSpanId).toBe(apiParent);
    expect(workflow.parentSpanId).toBe(server.spanId);
    expect(workflow.spanId).toBe(workflowSpanId(result.runId));
    const activities = recorded.filter(span => span.name.startsWith("activity."));
    expect(activities.map(span => span.parentSpanId)).toEqual([workflow.spanId, workflow.spanId]);
    expect(new Set(activities.map(span => span.spanId)).size).toBe(2);
    expect(outboundParents).toEqual(activities.map(span => `00-${span.traceId}-${span.spanId}-01`));
    expect(activities.map(attrs)).toEqual([
      expect.objectContaining({ "temporal.attempt": 1, "space.outcome": "FAILED", "space.reason_code": "UPSTREAM_RETRYABLE_UNAVAILABLE" }),
      expect.objectContaining({ "temporal.attempt": 2, "space.outcome": "FAILED_RESULT", "space.reason_code": "OPENCODE_TURN_TIMEOUT", "space.category": "TIMEOUT" })
    ]);
    for (const span of recorded.filter(span => span.kind === 1)) expect(span.attributes.every(attribute => temporalAttributeKeys.includes(attribute.key as any))).toBe(true);
    expect(JSON.stringify(requests)).not.toMatch(/PRIVATE PROMPT|sk-live|operator\/private|secret.invalid|message|stack/);
    expect(requests.every(request => request.path === "/v1/traces")).toBe(true);

    // Explicit opt-in manual proof: forward this already-checked synthetic
    // trace to a local Jaeger. Normal tests contact only their fake collector.
    if (process.env.SPACE_TELEMETRY_PROOF_ENDPOINT) {
      const target = new URL(process.env.SPACE_TELEMETRY_PROOF_ENDPOINT);
      if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) {
        throw new Error("The synthetic proof collector must be loopback HTTP");
      }
      for (const { path: _path, ...body } of requests) {
        const forwarded = await fetch(new URL("/v1/traces", target), { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(3_000) });
        expect(forwarded.ok).toBe(true);
      }
    }

    // Replaying the actual history with the same sinks must enqueue no spans.
    requests.length = 0;
    await Worker.runReplayHistory({ workflowBundle: bundle, sinks: telemetries[0]!.sinks }, await handle.fetchHistory(), handle.workflowId);
    await flush();
    expect(spans()).toEqual([]);
  } finally { await app.close(); observability.close(); await apiExporter.close(); }
}, 30_000);

it("nests the memory child workflow and its cross-queue mutation under the API parent", async () => {
  const handle = await start("memoryMaintenanceWorkflow", { traceId: "req:syntheticmemory", month: "2025-01" }, MEMORY_MAINTENANCE_TASK_QUEUE);
  await handle.result(); await flush();
  const recorded = spans();
  const root = recorded.find(span => span.name === "workflow.memoryMaintenanceWorkflow")!;
  const child = recorded.find(span => span.name === "workflow.memoryConsolidationWorkflow")!;
  expect(root.parentSpanId).toBe(apiParent);
  expect(child.parentSpanId).toBe(root.spanId);
  const mutation = recorded.find(span => span.name === "activity.executePersistedMemoryChangeSet")!;
  expect(mutation.parentSpanId).toBe(child.spanId);
  expect(mutation.service).toBe("space-memory-mutation-worker");
  expect(root.service).toBe("space-memory-maintenance-worker");
  expect(new Set(recorded.map(span => span.traceId))).toEqual(new Set([traceId]));
  for (const activity of recorded.filter(span => span.name.startsWith("activity."))) {
    expect([root.spanId, child.spanId]).toContain(activity.parentSpanId);
    expect(attrs(activity)).toMatchObject({ "temporal.attempt": 1, "space.outcome": "COMPLETED" });
  }
}, 20_000);

it.each(["dummyTurnWorkflow", "roomAgentActionWorkflow", "memoryMutationWorkflow"])("exports %s with an input or memo parent", async type => {
  const handle = await start(type, { traceparent, roomId: "room:synthetic", paneId: "pane:synthetic", traceId: "req:synthetic", prompt: secret,
    actionId: "action:synthetic", bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, changeSetId: "change:synthetic" },
    type === "memoryMutationWorkflow" ? MEMORY_MUTATION_TASK_QUEUE : mainQueue);
  await handle.result(); await flush();
  const workflow = spans().find(span => span.name === `workflow.${type}`)!;
  expect(workflow).toMatchObject({ traceId, parentSpanId: apiParent });
  expect(spans().filter(span => span.name.startsWith("activity.")).every(span => span.parentSpanId === workflow.spanId)).toBe(true);
}, 15_000);

it("links a real dot continue-as-new run to its previous run", async () => {
  let steps = 0;
  handlers.dotGoalStep = () => ({ state: ++steps <= 300 ? "WAITING" : "DONE", goalStatus: steps <= 300 ? "ACTIVE" : "COMPLETED", runId: null });
  const handle = await start("dotGoalWorkflow", { goalId: "goal:synthetic" });
  await handle.result(); await flush();
  const workflows = spans().filter(span => span.name === "workflow.dotGoalWorkflow");
  expect(workflows).toHaveLength(2);
  const first = workflows.find(span => attrs(span)["space.outcome"] === "CONTINUED_AS_NEW")!;
  const second = workflows.find(span => span !== first)!;
  expect(first.parentSpanId).toBe(apiParent);
  expect(second).toMatchObject({ traceId, parentSpanId: apiParent, links: [{ traceId, spanId: first.spanId }] });
  expect(spans().filter(span => span.name === "activity.dotGoalStep")).toHaveLength(301);
}, 30_000);

it.each(["COMPLETED", "FAILED", "CANCELLED"])("records %s when a workflow catches its continue-as-new attempt", async outcome => {
  const handle = await start("caughtContinuationWorkflow", outcome);
  if (outcome === "COMPLETED") expect(await handle.result()).toBe("recovered");
  else await expect(handle.result()).rejects.toThrow();
  await flush();
  const workflow = spans().find(span => span.name === "workflow.caughtContinuationWorkflow")!;
  expect(attrs(workflow)["space.outcome"]).toBe(outcome);
}, 15_000);

it("links a background continuation to its supervising run and keeps its originating request trace", async () => {
  const childTrace = "1234567890abcdef1234567890abcdef";
  const item = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:synthetic", turn: {
    roomId: "room:synthetic", paneId: "pane:synthetic", traceId: "trace:bg-synthetic", prompt: secret,
    traceparent: `00-${childTrace}-${apiParent}-01`, agentRunId: "agent_run:synthetic",
    roomAgentContinuation: { sourceRunId: "agent_run:source", generation: 1 }
  } });
  const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", pending: [item] }));
  await until(() => telemetries[0]!.stats().exported > 0 || requests.length > 0);
  await flush();
  const child = spans().find(span => span.name === "workflow.codexAppServerTurnWorkflow");
  expect(child).toMatchObject({ traceId: childTrace, parentSpanId: apiParent,
    links: [{ traceId, spanId: workflowSpanId(handle.firstExecutionRunId) }, { traceId: childTrace, spanId: apiParent }] });
}, 20_000);

it("rejects non-identifier attributes and makes the unset exporter a no-op", async () => {
  const telemetry = createWorkerTelemetry({ serviceName: "space-worker", env: {} });
  expect(telemetry.workerOptions.sinks).toBeUndefined();
  expect(telemetry.workerOptions.interceptors?.workflowModules).toBeUndefined();
  expect(temporalAttributes({ "space.room_id": secret, "space.pane_id": "/home/secret", "space.mission_id": "https://secret.invalid",
    "temporal.attempt": Infinity, prompt: secret, message: secret, error: secret, "space.trace_id": "req:synthetic" }))
    .toEqual({ "space.trace_id": "req:synthetic" });
  await telemetry.flush(); await telemetry.close();
  expect(telemetry.stats()).toEqual({ exported: 0, dropped: 0, failed: 0 });
  expect(requests).toEqual([]);
});

it("completes real workflows before a stalled collector responds, with bounded drops", async () => {
  collectorResponds = false;
  const exporter = createOtlpSpanExporter({ endpoint, serviceName: "space-worker", batchSize: 1, maxQueue: 2,
    timeoutMs: 30_000, flushIntervalMs: 60_000 });
  const telemetry = createWorkerTelemetry({ serviceName: "space-worker", exporter });
  telemetries.push(telemetry);
  const taskQueue = "synthetic-backpressure";
  const worker = await Worker.create({
    connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowBundle: bundle,
    sinks: telemetry.workerOptions.sinks, interceptors: { activity: telemetry.workerOptions.interceptors!.activity },
    activities: { recordDummyTurnStarted: () => undefined, recordDummyTurnCompleted: () => complete },
    maxCachedWorkflows: 16, shutdownGraceTime: "1 second",
    maxConcurrentWorkflowTaskExecutions: 4, maxConcurrentActivityTaskExecutions: 4,
    maxConcurrentWorkflowTaskPolls: 2, maxConcurrentActivityTaskPolls: 2
  });
  workers.push(worker); running.push(worker.run().catch(error => { workerFailures.push(error); }));
  const started = await Promise.all(Array.from({ length: 2 }, () => start("dummyTurnWorkflow", { traceparent }, taskQueue)));
  // The test deadline is shorter than the POST timeout. The collector cannot
  // release its first request until BOTH workflows have already completed.
  // No workflow timers are involved here. Keep the global test clock locked
  // while concurrent activity attempts complete instead of auto-skipping it.
  const realTime = new Client({ connection: env.connection, namespace: env.namespace });
  expect(await Promise.all(started.map(handle => realTime.workflow.getHandle(handle.workflowId).result()))).toHaveLength(2);
  await until(() => heldResponses.length > 0);
  expect(telemetry.stats()).toMatchObject({ exported: 0, failed: 0 });
  expect(telemetry.stats().dropped).toBe(3);
  collectorResponds = true;
  for (const response of heldResponses.splice(0)) response.writeHead(503).end();
  await telemetry.flush();
  expect(telemetry.stats()).toEqual({ exported: 2, dropped: 3, failed: 1 });
}, 15_000);

it("times out a real HTTP POST and counts its failure", async () => {
  collectorResponds = false;
  const exporter = createOtlpSpanExporter({ endpoint, serviceName: "space-worker", timeoutMs: 50 });
  exporter.record({ traceId, spanId: apiParent, parentSpanId: null, name: "synthetic-timeout", startTimeUnixNano: 1n,
    endTimeUnixNano: 2n, attributes: {}, error: false });
  try {
    await exporter.flush();
    expect(exporter.stats()).toEqual({ exported: 0, dropped: 0, failed: 1 });
    expect(heldResponses).toHaveLength(1);
  } finally { await exporter.close(); }
});
