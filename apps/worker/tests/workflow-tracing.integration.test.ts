import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkerOptions, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOtlpSpanExporter, otlpTracesUrl, type SpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { traceContextForRawRequest } from "../../api/src/trace-context.js";
import { workerTracingOptions } from "../src/worker-tracing.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { ROOM_AGENT_ENQUEUE_SIGNAL, roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";

interface WireSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
  links?: { traceId: string; spanId: string }[];
}
const attrs = (span: WireSpan) => Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? a.value.intValue]));
const secret = "PRIVATE PROMPT /Users/private/token.txt https://secret.example sk-test-private";
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceparent = `00-${traceId}-00f067aa0ba902b7-01`;
const workflowPath = fileURLToPath(new URL("./fixtures/tracing-workflows.ts", import.meta.url));
const interceptorPath = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));

describe.skipIf(process.env.SPACE_SKIP_TEMPORAL_INTEGRATION === "1")("real Temporal OTLP tracing (local server, no Docker or provider)", () => {
  let env: TestWorkflowEnvironment;
  let bundle: WorkflowBundleWithSourceMap;
  let exporter: SpanExporter;
  const received: WireSpan[] = [];
  const paths: string[] = [];
  const collector = createServer((request, response) => {
    paths.push(request.url!);
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      const data = JSON.parse(body);
      for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans) received.push(...scope.spans);
      response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
    });
  });

  beforeAll(async () => {
    collector.listen(0, "127.0.0.1"); await once(collector, "listening");
    const address = collector.address() as { port: number };
    // Optional manual Jaeger proof. The default test only uses the local fake
    // collector. Mirroring is restricted to a loopback endpoint, never a provider.
    const mirror = otlpTracesUrl(process.env.SPACE_OTLP_TEST_MIRROR_ENDPOINT);
    if (mirror && !["localhost", "127.0.0.1", "[::1]"].includes(new URL(mirror).hostname)) {
      throw new Error("The test mirror must use a loopback collector.");
    }
    exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${address.port}`, serviceName: "space-worker-test", flushIntervalMs: 60_000,
      ...(mirror ? { fetch: async (url, init) => {
        const response = await fetch(url, init);
        const proof = await fetch(mirror, init);
        return { ok: response.ok && proof.ok };
      } } : {})
    });
    env = await TestWorkflowEnvironment.createLocal();
    bundle = await bundleWorkflowCode({ workflowsPath: workflowPath, workflowInterceptorModules: [interceptorPath] });
  }, 120_000);
  afterAll(async () => {
    await exporter?.close();
    await env?.teardown();
    collector.closeAllConnections();
    await new Promise<void>(resolve => collector.close(() => resolve()));
  });

  async function worker(taskQueue: string, activities: NonNullable<WorkerOptions["activities"]>) {
    const options = workerTracingOptions(exporter);
    return Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
      activities, ...options, interceptors: { activity: options.interceptors!.activity } });
  }
  const tracingActivity = async (input: Record<string, unknown>) => {
    if (input.retry && Context.current().info.attempt === 1) {
      throw ApplicationFailure.retryable(secret, "UPSTREAM_RETRYABLE_UNAVAILABLE");
    }
    return { status: "COMPLETED", output: secret };
  };

  it("joins an API SERVER span to a workflow, every activity attempt and child workflow; no private content", async () => {
    const start = received.length;
    const taskQueue = `trace-${randomUUID()}`;
    const running = await worker(taskQueue, { tracingActivity });
    const app = Fastify();
    const observation = createHttpObservability({ serviceName: "space-api-test", spanExporter: exporter });
    app.addHook("onRequest", async request => observation.onRequest(request));
    app.addHook("onResponse", async (request, reply) => observation.onResponse(request, reply));
    app.post("/trace/:id", async request => {
      const context = traceContextForRawRequest(request.raw);
      return env.client.workflow.execute("tracingTreeWorkflow", {
        workflowId: `trace-tree-${randomUUID()}`, taskQueue,
        args: [{ traceId: "req:trace-test", traceparent: context.traceparent, prompt: secret,
          roomId: "room:test", paneId: "pane:test", missionId: "mission:test", url: secret, path: secret }]
      });
    });
    try {
      await running.runUntil(async () => {
        const response = await app.inject({ method: "POST", url: "/trace/private-id?token=private" });
        expect(response.statusCode).toBe(200);
      });
    } finally { await app.close(); observation.close(); }
    await exporter.flush();
    const spans = received.slice(start);
    expect(paths.every(path => path === "/v1/traces")).toBe(true);
    const api = spans.find(span => span.name === "POST /trace/:id")!;
    const root = spans.find(span => span.name === "workflow tracingTreeWorkflow")!;
    expect(root.traceId).toBe(api.traceId);
    expect(root.parentSpanId).toBe(api.spanId);
    expect(spans.every(span => span.traceId === api.traceId)).toBe(true);
    const children = spans.filter(span => span.name === "workflow tracingChildWorkflow");
    expect(children).toHaveLength(2);
    expect(children.every(span => span.parentSpanId === root.spanId)).toBe(true);
    expect(children.some(span => span.links?.some(link => link.spanId === root.spanId))).toBe(true);
    const attempts = spans.filter(span => span.name === "activity tracingActivity" && span.parentSpanId === root.spanId);
    expect(attempts.map(span => attrs(span)["space.attempt"]).sort()).toEqual(["1", "2"]);
    expect(attrs(attempts.find(span => attrs(span)["space.outcome"] === "FAILED")!)).toMatchObject({
      "space.reason_code": "UPSTREAM_RETRYABLE_UNAVAILABLE", "space.failure_category": "UPSTREAM_UNAVAILABLE"
    });
    for (const child of children) expect(spans.some(span => span.name === "activity tracingActivity" && span.parentSpanId === child.spanId)).toBe(true);
    expect(JSON.stringify(spans)).not.toMatch(/PRIVATE PROMPT|token.txt|secret.example|sk-test-private|private-id/);
  }, 60_000);

  it("links continueAsNew runs and exports no spans during real history replay", async () => {
    const start = received.length;
    const taskQueue = `continue-${randomUUID()}`;
    const running = await worker(taskQueue, { tracingActivity });
    const handle = await env.client.workflow.start("tracingContinuedWorkflow", {
      workflowId: `continued-${randomUUID()}`, taskQueue, args: [{ traceparent, prompt: secret }]
    });
    await running.runUntil(() => handle.result());
    await exporter.flush();
    const spans = received.slice(start);
    const runs = spans.filter(span => span.name === "workflow tracingContinuedWorkflow");
    expect(runs).toHaveLength(2);
    const first = runs.find(span => attrs(span)["space.outcome"] === "CONTINUED_AS_NEW")!;
    const last = runs.find(span => attrs(span)["space.outcome"] === "COMPLETED")!;
    expect(last.links).toContainEqual({ traceId: first.traceId, spanId: first.spanId });
    const history = await handle.fetchHistory();
    const beforeReplay = received.length;
    await Worker.runReplayHistory({ workflowBundle: bundle, sinks: workerTracingOptions(exporter).sinks }, history);
    await exporter.flush();
    expect(received).toHaveLength(beforeReplay);
  }, 60_000);

  it("traces the production turn/action/goal and memory workflows with real child scheduling", async () => {
    const start = received.length;
    const taskQueue = `production-${randomUUID()}`;
    const activities = {
      runCodexAppServerTurn: async () => ({ status: "COMPLETED" }),
      runRoomAgentBackgroundAction: async () => ({ status: "COMPLETED" }),
      dotGoalStep: async () => ({ state: "DONE", goalStatus: "COMPLETED", runId: null }),
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "source:test" }),
      refreshAllMonthsMemoryGraphSnapshot: async () => ({}),
      reconcileStaleSpaceAgentSessions: async () => ({}),
      createScheduledMemoryAudit: async () => ({ id: "memory_run:test", workflowId: `memory-child-${randomUUID()}` }),
      prepareMemoryConsolidation: async () => ({ changeSetId: "change:test", run: { id: "memory_run:test" } }),
      executePersistedMemoryChangeSet: async () => ({ status: "COMPLETED" }),
      finalizeMemoryRepair: async () => ({ status: "COMPLETED" })
    };
    const main = await worker(taskQueue, activities);
    const maintenance = await worker(MEMORY_MAINTENANCE_TASK_QUEUE, activities);
    const mutation = await worker(MEMORY_MUTATION_TASK_QUEUE, activities);
    const execute = (name: string, input: Record<string, unknown>, queue = taskQueue) => env.client.workflow.execute(name, {
      workflowId: `${name}-${randomUUID()}`, taskQueue: queue, args: [input], memo: { traceparent }
    });
    await main.runUntil(() => maintenance.runUntil(() => mutation.runUntil(async () => {
      await execute("codexAppServerTurnWorkflow", { providerId: "codex", prompt: secret, roomId: "room:test", paneId: "pane:test" });
      await execute("roomAgentActionWorkflow", { bridge: { roomId: "room:test", missionId: "mission:test" }, actionId: "action:test" });
      await execute("dotGoalWorkflow", { goalId: "goal:test" });
      await execute("memoryMaintenanceWorkflow", { traceId: "req:memory", prompt: secret }, MEMORY_MAINTENANCE_TASK_QUEUE);
      await execute("memoryMutationWorkflow", { changeSetId: "change:test", traceId: "req:memory" }, MEMORY_MUTATION_TASK_QUEUE);
    })));
    await exporter.flush();
    const spans = received.slice(start);
    for (const name of ["codexAppServerTurnWorkflow", "roomAgentActionWorkflow", "dotGoalWorkflow",
      "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"]) {
      const run = spans.find(span => span.name === `workflow ${name}`)!;
      expect(run, name).toBeDefined();
      expect(spans.some(span => span.name.startsWith("activity ") && span.parentSpanId === run.spanId), name).toBe(true);
    }
    const parent = spans.find(span => span.name === "workflow memoryMaintenanceWorkflow")!;
    expect(spans.find(span => span.name === "workflow memoryConsolidationWorkflow")!.parentSpanId).toBe(parent.spanId);
    expect(spans.every(span => span.traceId === traceId)).toBe(true);
    expect(JSON.stringify(spans)).not.toContain(secret);
  }, 60_000);

  it("traces a real supervisor mission and cancels the idle supervisor cleanly", async () => {
    const start = received.length;
    const taskQueue = `supervisor-${randomUUID()}`;
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    let finishedCount = 0;
    const firstDone = new Promise<void>(resolve => { finishFirst = resolve; });
    const secondDone = new Promise<void>(resolve => { finishSecond = resolve; });
    const running = await worker(taskQueue, {
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async () => ({ status: "COMPLETED", roomAgentOutcome: {
        status: "VERIFIED", statusReason: "test", executedActionCount: 0
      } }),
      finishRoomAgentSupervisorTurn: async () => { if (++finishedCount === 1) finishFirst(); else finishSecond(); },
      discardRoomAgentSupervisorTurn: async () => undefined
    });
    const item = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:test", turn: {
      roomId: "room:test", paneId: "pane:test", traceId: "req:supervisor", traceparent,
      prompt: secret, modelId: "model:test", reasoningEffort: "high", agentRunId: "agent_run:test"
    } });
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: `supervisor-${randomUUID()}`, taskQueue,
      args: [roomAgentSupervisorInputSchema.parse({ roomId: "room:test", pending: [item] })], memo: { traceparent }
    });
    const foreignTraceId = "abcdefabcdefabcdefabcdefabcdefab";
    const foreignParentId = "1234567890abcdef";
    await running.runUntil(async () => {
      await firstDone;
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { missionId: "mission:second", turn: {
        ...item.turn, traceId: "req:second", agentRunId: "agent_run:second",
        traceparent: `00-${foreignTraceId}-${foreignParentId}-01`
      } });
      await secondDone;
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
    });
    await exporter.flush();
    const spans = received.slice(start);
    const supervisor = spans.find(span => span.name === "workflow roomAgentSupervisorWorkflow")!;
    const child = spans.find(span => span.name === "workflow codexAppServerTurnWorkflow" && span.traceId === traceId)!;
    expect(child.parentSpanId).toBe(supervisor.spanId);
    expect(attrs(supervisor)["space.outcome"]).toBe("CANCELLED");
    const foreignChild = spans.find(span => span.name === "workflow codexAppServerTurnWorkflow" && span.traceId === foreignTraceId)!;
    expect(foreignChild.parentSpanId).toBe(foreignParentId);
    expect(foreignChild.links).toContainEqual({ traceId, spanId: supervisor.spanId });
    expect(spans.some(span => span.name === "activity runCodexAppServerTurn" && span.traceId === foreignTraceId
      && span.parentSpanId === foreignChild.spanId)).toBe(true);
  }, 60_000);

  it("replays an old uninstrumented history without changing commands or exporting spans", async () => {
    const legacyBundle = await bundleWorkflowCode({ workflowsPath: workflowPath });
    const taskQueue = `legacy-${randomUUID()}`;
    const legacyWorker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowBundle: legacyBundle, activities: { tracingActivity } });
    const handle = await env.client.workflow.start("tracingTreeWorkflow", {
      workflowId: `legacy-${randomUUID()}`, taskQueue, args: [{ prompt: secret }]
    });
    await legacyWorker.runUntil(() => handle.result());
    const history = await handle.fetchHistory();
    await exporter.flush();
    const beforeReplay = received.length;
    await Worker.runReplayHistory({ workflowBundle: bundle, sinks: workerTracingOptions(exporter).sinks }, history);
    await exporter.flush();
    expect(received).toHaveLength(beforeReplay);
  }, 60_000);
});
