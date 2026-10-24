import { randomUUID } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Worker } from "@temporalio/worker";
import { describe, expect, it } from "vitest";
import { ROOM_AGENT_ENQUEUE_SIGNAL, buildCodexAppServerTurnWorkflowId, roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { requestTraceContexts, traceContextForRawRequest } from "../../api/src/trace-context.js";
import { TemporalCodexAppServerTurnStarter } from "../../api/src/turns.js";
import { childTraceparent, createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { createWorkflowTracingOptions } from "../src/workflow-tracing-worker.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiParentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${apiParentId}-01`;
const privateText = "PRIVATE_PROMPT_MODEL_OUTPUT /home/private/customer.txt https://private.example/token";
const workflowsPath = fileURLToPath(new URL("./support/otlp-workflows.ts", import.meta.url));
const workerAttributeKeys = new Set([
  "space.workflow_type", "space.workflow_id", "space.temporal_run_id", "space.activity_type", "space.activity_id",
  "space.attempt", "space.outcome", "space.reason_code", "space.category", "space.duration_ms", "space.room_id",
  "space.pane_id", "space.mission_id", "space.trace_id"
]);
type CollectedSpan = {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>;
  status: { code: number };
};

function attributes(span: CollectedSpan) {
  return Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? Number(value.intValue)]));
}

async function collector(holdResponses = false) {
  const spans: CollectedSpan[] = [];
  const bodies: string[] = [];
  const paths: string[] = [];
  const responses = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    bodies.push(body);
    paths.push(request.url!);
    const parsed = JSON.parse(body);
    // Optional synthetic evidence for a local collector demonstration. Normal
    // tests perform no filesystem writes and contact only this local server.
    if (process.env.SPACE_OTLP_TEST_CAPTURE) await appendFile(process.env.SPACE_OTLP_TEST_CAPTURE, `${JSON.stringify(parsed)}\n`);
    for (const resource of parsed.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
    if (holdResponses) responses.add(response);
    else { response.writeHead(200, { "content-type": "application/json" }); response.end("{}"); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    endpoint, spans, bodies, paths, responses,
    release() { for (const response of responses) response.end("{}"); responses.clear(); },
    async close() {
      for (const response of responses) response.end("{}");
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

const compiled = new Map<string, ReturnType<typeof bundleWorkflowCode>>();
function workflowBundle(modulePaths: string[]) {
  const key = modulePaths.join("\n");
  const existing = compiled.get(key);
  if (existing) return existing;
  const pending = bundleWorkflowCode({
    workflowsPath, workflowInterceptorModules: modulePaths, logger: new DefaultLogger("ERROR"),
    webpackConfigHook: config => ({ ...config, resolve: { ...config.resolve, alias: {
      ...config.resolve?.alias,
      "@space/contracts$": fileURLToPath(new URL("../../../packages/contracts/src/index.ts", import.meta.url))
    } } })
  });
  compiled.set(key, pending);
  return pending;
}

async function waitUntil(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for a synthetic trace");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

type TestContext = {
  env: TestWorkflowEnvironment; taskQueue: string; spans: SpanExporter;
  collected: Awaited<ReturnType<typeof collector>>;
  bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
  tracing: ReturnType<typeof createWorkflowTracingOptions>;
};

async function withTracing(
  activities: Record<string, Function>,
  run: (context: TestContext) => Promise<void>,
  options: { queues?: string[]; holdResponses?: boolean; enabled?: boolean } = {}
) {
  const collected = await collector(options.holdResponses);
  let environment: TestWorkflowEnvironment | undefined;
  const spans = createOtlpSpanExporter({
    endpoint: collected.endpoint, serviceName: "space-worker", flushIntervalMs: 60_000,
    batchSize: options.holdResponses ? 1 : 256, timeoutMs: 1000
  });
  try {
    const env = environment = await TestWorkflowEnvironment.createTimeSkipping();
    const exporter = options.enabled === false ? null : spans;
    const tracing = createWorkflowTracingOptions(exporter);
    const bundle = await workflowBundle(tracing.interceptors?.workflowModules ?? []);
    const taskQueue = `otlp-${randomUUID()}`;
    const queues = [taskQueue, ...options.queues ?? []];
    const runWorker = async (index: number): Promise<void> => {
      if (index === queues.length) return run({ env, taskQueue, spans, collected, bundle, tracing });
      const worker = await Worker.create({
        connection: env.nativeConnection, taskQueue: queues[index]!, workflowBundle: bundle,
        activities, sinks: tracing.sinks,
        interceptors: { activity: [createActivityObservabilityInterceptors({ spans: exporter })] },
        shutdownGraceTime: "1 second"
      });
      await worker.runUntil(() => runWorker(index + 1));
    };
    await runWorker(0);
  } finally {
    collected.release();
    try { await spans.close(); }
    finally {
      try { await environment?.teardown(); }
      finally { await collected.close(); }
    }
  }
}

function onlyWorkflow(spans: CollectedSpan[], workflowId: string) {
  const matches = spans.filter(span => attributes(span)["space.workflow_id"] === workflowId && span.name.startsWith("workflow "));
  expect(matches, `Expected one workflow span for ${workflowId}`).toHaveLength(1);
  return matches[0]!;
}

describe("connected OTLP traces through the real Temporal sandbox", () => {
  it("connects the actual API server span to the workflow and each retry, with no replay duplicates or user text", async () => {
    const outboundParents: Array<string | null> = [];
    await withTracing({
      async runCodexAppServerTurn(input: { traceparent: string }) {
        outboundParents.push(childTraceparent(input.traceparent));
        if (Context.current().info.attempt === 1) throw ApplicationFailure.create({ message: privateText, type: "UPSTREAM_RETRYABLE_UNAVAILABLE" });
        return { status: "COMPLETED", message: privateText };
      }
    }, async ({ env, taskQueue, spans, collected, bundle, tracing }) => {
      const apiSpans = createOtlpSpanExporter({ endpoint: collected.endpoint, serviceName: "space-api", flushIntervalMs: 60_000 });
      const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiSpans });
      const app = Fastify({ genReqId: () => `req:otlp-${randomUUID()}` });
      const starter = new TemporalCodexAppServerTurnStarter({
        address: env.address, namespace: "default", taskQueue,
        clientFactory: async () => ({ client: env.client, close: async () => undefined })
      });
      app.addHook("onRequest", async request => {
        requestTraceContexts.remember(request.id, traceContextForRawRequest(request.raw));
        observability.onRequest(request);
      });
      app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
      app.post("/turn", request => starter.start({
        roomId: "room:otlp", paneId: "pane:otlp", prompt: privateText, traceId: request.id,
        artifactIds: [], permissionMode: null, collaborationMode: "default"
      }));
      try {
        const response = await app.inject({ method: "POST", url: "/turn", headers: { traceparent } });
        expect(response.statusCode).toBe(200);
        const handle = env.client.workflow.getHandle(response.json().workflowId);
        expect(await handle.result()).toEqual({ status: "COMPLETED", message: privateText });
        await spans.flush();
        await apiSpans.flush();
        const api = collected.spans.find(span => span.kind === 2)!;
        expect(api).toBeDefined();
        expect(api.traceId).toBe(traceId);
        expect(api.parentSpanId).toBe(apiParentId);
        const workflow = onlyWorkflow(collected.spans, handle.workflowId);
        expect(workflow.traceId).toBe(traceId);
        expect(workflow.parentSpanId).toBe(api.spanId);
        const attempts = collected.spans.filter(span => span.name === "activity runCodexAppServerTurn");
        expect(attempts).toHaveLength(2);
        expect(attempts.map(span => attributes(span)["space.attempt"])).toEqual([1, 2]);
        expect(attempts.map(span => attributes(span)["space.outcome"])).toEqual(["FAILED", "COMPLETED"]);
        expect(attributes(attempts[0]!)).toMatchObject({ "space.reason_code": "UPSTREAM_RETRYABLE_UNAVAILABLE", "space.category": "UPSTREAM_UNAVAILABLE" });
        expect(outboundParents).toEqual(attempts.map(span => `00-${span.traceId}-${span.spanId}-01`));
        for (const attempt of attempts) {
          expect(attempt.traceId).toBe(traceId);
          expect(attempt.parentSpanId).toBe(workflow.spanId);
        }
        expect(new Set(collected.spans.map(span => span.spanId)).size).toBe(collected.spans.length);
        for (const span of collected.spans.filter(span => span.kind !== 2)) {
          expect(span.attributes.every(attribute => workerAttributeKeys.has(attribute.key))).toBe(true);
          expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
        }
        expect(collected.bodies.join("\n")).not.toMatch(/PRIVATE_PROMPT|MODEL_OUTPUT|customer\.txt|private\.example/);
        expect(new Set(collected.paths)).toEqual(new Set(["/v1/traces"]));

        const recorded = await handle.fetchHistory();
        const beforeReplay = collected.spans.length;
        await Worker.runReplayHistory({ workflowBundle: bundle, sinks: tracing.sinks }, recorded, handle.workflowId);
        await spans.flush();
        expect(collected.spans).toHaveLength(beforeReplay);
      } finally {
        await app.close();
        observability.close();
        await apiSpans.close();
      }
    });
  }, 60_000);

  it("parents memory activities and the consolidation child even when only the root memo carries context", async () => {
    const childId = `memory-consolidation-${randomUUID()}`;
    const run = { id: "run:otlp", workflowId: childId, status: "SUCCEEDED" };
    await withTracing({
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "synthetic", status: "REFRESHED" }),
      refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
      reconcileStaleSpaceAgentSessions: async () => undefined,
      createScheduledMemoryAudit: async () => run,
      prepareMemoryConsolidation: async () => ({ run, changeSetId: "change:otlp" }),
      executePersistedMemoryChangeSet: async () => ({ status: "APPLIED", changeSetId: "change:otlp" }),
      finalizeMemoryRepair: async () => run
    }, async ({ env, taskQueue, spans, collected }) => {
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
        workflowId: `memory-maintenance-${randomUUID()}`, taskQueue,
        args: [{ scheduledAt: "2026-10-01T00:00:00.000Z", traceId: "trace:memory-otlp" }], memo: { traceparent }
      });
      await handle.result();
      await spans.flush();
      const parent = onlyWorkflow(collected.spans, handle.workflowId);
      const child = onlyWorkflow(collected.spans, childId);
      expect(parent.traceId).toBe(traceId);
      expect(parent.parentSpanId).toBe(apiParentId);
      expect(child.traceId).toBe(traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      const activitySpans = collected.spans.filter(span => span.name.startsWith("activity "));
      expect(activitySpans).toHaveLength(7);
      for (const span of activitySpans) {
        expect(span.traceId).toBe(traceId);
        expect(span.parentSpanId).toBe(attributes(span)["space.workflow_id"] === childId ? child.spanId : parent.spanId);
      }
    }, { queues: ["space-memory-maintenance", "space-memory-mutations"] });
  }, 60_000);

  it("links a continue-as-new run to the preceding workflow span and keeps its trace", async () => {
    let steps = 0;
    await withTracing({
      dotGoalStep: async () => ++steps <= 300
        ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    }, async ({ env, taskQueue, spans, collected }) => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId: `dot-otlp-${randomUUID()}`, taskQueue, args: [{ goalId: "dot_goal:otlp" }], memo: { traceparent }
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      await spans.flush();
      const workflows = collected.spans.filter(span => span.name === "workflow dotGoalWorkflow");
      expect(workflows).toHaveLength(2);
      const first = workflows.find(span => attributes(span)["space.temporal_run_id"] === handle.firstExecutionRunId)!;
      const next = workflows.find(span => span !== first)!;
      expect(first).toBeDefined();
      expect(first.traceId).toBe(traceId);
      expect(next.traceId).toBe(traceId);
      expect(next.parentSpanId).toBe(first.spanId);
      expect(next.links).toEqual(expect.arrayContaining([{ traceId, spanId: first.spanId }]));
      const activities = collected.spans.filter(span => span.name === "activity dotGoalStep");
      expect(activities.filter(span => span.parentSpanId === first.spanId)).toHaveLength(300);
      expect(activities.filter(span => span.parentSpanId === next.spanId)).toHaveLength(1);
    });
  }, 60_000);

  it("links the independently traced background child to the supervisor and source trace", async () => {
    const initial = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:otlp", turn: {
      roomId: "room:otlp", paneId: "pane:otlp", traceId: "trace:initial", traceparent,
      prompt: privateText, agentRunId: "agent_run:initial"
    } });
    const background = roomAgentSupervisorQueueItemSchema.parse({ missionId: initial.missionId, turn: {
      ...initial.turn, traceId: "trace:bg-otlp", agentRunId: "agent_run:background",
      roomAgentContinuation: { sourceRunId: "agent_run:initial", generation: 1 }
    } });
    const verified = { status: "COMPLETED", message: privateText, roomAgentOutcome: {
      status: "VERIFIED", executedActionCount: 1, statusReason: privateText
    } };
    await withTracing({
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async (turn: { traceId: string }) => turn.traceId === "trace:initial"
        ? { ...verified, roomAgentOutcome: { ...verified.roomAgentOutcome, pendingActionIds: ["action:otlp"] } }
        : verified,
      prepareRoomAgentBackgroundContinuation: async () => ({ state: "READY", item: background }),
      finishRoomAgentSupervisorTurn: async () => undefined
    }, async ({ env, taskQueue, spans, collected }) => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        workflowId: `supervisor-otlp-${randomUUID()}`, taskQueue, memo: { traceparent },
        args: [roomAgentSupervisorInputSchema.parse({ roomId: initial.turn.roomId, pending: [initial], processedCount: 48 })]
      });
      try {
        const firstRun = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
        await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
        await spans.flush();
        const supervisor = collected.spans.find(span => span.name === "workflow roomAgentSupervisorWorkflow" &&
          attributes(span)["space.temporal_run_id"] === handle.firstExecutionRunId)!;
        expect(supervisor).toBeDefined();
        const original = onlyWorkflow(collected.spans, buildCodexAppServerTurnWorkflowId(initial.turn));
        const continued = onlyWorkflow(collected.spans, buildCodexAppServerTurnWorkflowId(background.turn));
        expect(original.traceId).toBe(traceId);
        expect(original.parentSpanId).toBe(supervisor.spanId);
        expect(continued.traceId).not.toBe(traceId);
        expect(continued.links).toEqual(expect.arrayContaining([
          { traceId, spanId: supervisor.spanId }, { traceId, spanId: apiParentId }
        ]));
        const continuedActivity = collected.spans.find(span => span.name === "activity runCodexAppServerTurn" &&
          attributes(span)["space.workflow_id"] === buildCodexAppServerTurnWorkflowId(background.turn))!;
        expect(continuedActivity.traceId).toBe(continued.traceId);
        expect(continuedActivity.parentSpanId).toBe(continued.spanId);
      } finally {
        await handle.terminate("Synthetic tracing scenario complete");
      }
    });
  }, 60_000);

  it("parents a later enqueued mission under its own API request and links the existing supervisor", async () => {
    const nextTraceId = "11111111111111111111111111111111";
    const nextApiSpanId = "2222222222222222";
    const initial = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:first", turn: {
      roomId: "room:otlp", paneId: "pane:otlp", traceId: "trace:first", traceparent,
      prompt: privateText, agentRunId: "agent_run:first"
    } });
    const followUp = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:next", turn: {
      ...initial.turn, traceId: "trace:next", agentRunId: "agent_run:next",
      traceparent: `00-${nextTraceId}-${nextApiSpanId}-01`
    } });
    let executed = 0;
    await withTracing({
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async () => {
        executed++;
        return { status: "COMPLETED", message: privateText, roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: privateText } };
      },
      finishRoomAgentSupervisorTurn: async () => undefined
    }, async ({ env, taskQueue, spans, collected }) => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        workflowId: `supervisor-followup-${randomUUID()}`, taskQueue, memo: { traceparent },
        args: [roomAgentSupervisorInputSchema.parse({ roomId: initial.turn.roomId, pending: [initial], processedCount: 48 })]
      });
      try {
        await waitUntil(() => executed === 1);
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp);
        const firstRun = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
        await expect(firstRun.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
        await spans.flush();
        const supervisor = collected.spans.find(span => span.name === "workflow roomAgentSupervisorWorkflow" &&
          attributes(span)["space.temporal_run_id"] === handle.firstExecutionRunId)!;
        const next = onlyWorkflow(collected.spans, buildCodexAppServerTurnWorkflowId(followUp.turn));
        expect(next.traceId).toBe(nextTraceId);
        expect(next.parentSpanId).toBe(nextApiSpanId);
        expect(next.links).toEqual(expect.arrayContaining([{ traceId, spanId: supervisor.spanId }]));
        const attempt = collected.spans.find(span => span.name === "activity runCodexAppServerTurn" &&
          attributes(span)["space.workflow_id"] === buildCodexAppServerTurnWorkflowId(followUp.turn))!;
        expect(attempt.traceId).toBe(nextTraceId);
        expect(attempt.parentSpanId).toBe(next.spanId);
      } finally { await handle.terminate("Synthetic follow-up trace complete"); }
    });
  }, 60_000);

  it.each([
    { type: "dummyTurnWorkflow", input: { traceId: "trace:dummy", roomId: "room:otlp", paneId: "pane:otlp", prompt: privateText },
      activities: { recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => ({ status: "COMPLETED" }) }, count: 2 },
    { type: "roomAgentActionWorkflow", input: { actionId: "action:otlp", bridge: { roomId: "room:otlp", missionId: "mission:otlp" } },
      activities: { runRoomAgentBackgroundAction: async () => ({ status: "COMPLETED" }) }, count: 1 },
    { type: "memoryMutationWorkflow", input: { changeSetId: "change:otlp", traceId: "trace:mutation" },
      activities: { executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) }, count: 1 }
  ])("exports $type and its activities when context is carried in the memo", async ({ type, input, activities, count }) => {
    await withTracing(activities, async ({ env, taskQueue, spans, collected }) => {
      const handle = await env.client.workflow.start(type, { workflowId: `root-otlp-${randomUUID()}`, taskQueue, args: [input], memo: { traceparent } });
      await handle.result();
      await spans.flush();
      const workflow = onlyWorkflow(collected.spans, handle.workflowId);
      expect(workflow.traceId).toBe(traceId);
      expect(workflow.parentSpanId).toBe(apiParentId);
      const attempts = collected.spans.filter(span => span.name.startsWith("activity "));
      expect(attempts).toHaveLength(count);
      expect(attempts.every(span => span.traceId === traceId && span.parentSpanId === workflow.spanId)).toBe(true);
    });
  }, 60_000);

  it("finishes activity and workflow work while the collector deliberately withholds its response", async () => {
    await withTracing({ executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) }, async ({ env, taskQueue, collected }) => {
      const handle = await env.client.workflow.start("memoryMutationWorkflow", {
        workflowId: `slow-collector-${randomUUID()}`, taskQueue,
        args: [{ changeSetId: "change:otlp", traceId: "trace:slow" }], memo: { traceparent }
      });
      expect(await handle.result()).toEqual({ status: "APPLIED" });
      await waitUntil(() => collected.responses.size > 0);
      expect([...collected.responses].every(response => !response.writableEnded)).toBe(true);
    }, { holdResponses: true });
  }, 60_000);

  it("does no tracing work when the worker exporter is disabled", async () => {
    await withTracing({ executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) }, async ({ env, taskQueue, spans, collected }) => {
      const handle = await env.client.workflow.start("memoryMutationWorkflow", {
        workflowId: `disabled-tracing-${randomUUID()}`, taskQueue,
        args: [{ changeSetId: "change:otlp", traceId: "trace:disabled", traceparent }], memo: { traceparent }
      });
      expect(await handle.result()).toEqual({ status: "APPLIED" });
      await spans.flush();
      expect(collected.spans).toEqual([]);
      expect(collected.paths).toEqual([]);
      const recorded = await handle.fetchHistory();
      const activity = recorded.events!.find(event => event.activityTaskScheduledEventAttributes)!.activityTaskScheduledEventAttributes!;
      expect(activity.header?.fields?.["space-trace-context"]).toBeUndefined();
    }, { enabled: false });
  }, 60_000);
});
