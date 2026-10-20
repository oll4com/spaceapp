import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowSpanSinks } from "../src/workflow-observability-worker.js";
import { WORKER_SPAN_ATTRIBUTES } from "../src/workflow-span.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { ROOM_AGENT_ENQUEUE_SIGNAL } from "@space/contracts";
import { createHttpObservability } from "../../api/src/observability.js";
import { traceContextForRawRequest } from "../../api/src/trace-context.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${apiSpanId}-01`;
type WireSpan = {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>;
};
const attributes = (span: WireSpan) => Object.fromEntries(span.attributes.map(a => [a.key, a.value.stringValue ?? a.value.intValue]));

describe.sequential("real Temporal workflow OTLP export", () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;
  let collector: Server;
  let endpoint: string;
  const received: WireSpan[] = [];
  let counter = 0;

  beforeAll(async () => {
    collector = createServer((request, response) => {
      if (request.url !== "/v1/traces") { response.writeHead(404).end(); return; }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; });
      request.on("end", async () => {
        const data = JSON.parse(body);
        for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans) received.push(...scope.spans);
        // Optional visual proof uses only synthetic test data and a loopback
        // Jaeger collector. Normal test execution needs no tracing backend.
        if (process.env.SPACE_TEST_TRACE_COLLECTOR) {
          const target = new URL(process.env.SPACE_TEST_TRACE_COLLECTOR);
          if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") throw new Error("Test collector must be loopback HTTP");
          await fetch(new URL("/v1/traces", target), { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(3000) });
        }
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    env = await TestWorkflowEnvironment.createTimeSkipping();
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./fixtures/tracing-workflows.ts", import.meta.url)),
      workflowInterceptorModules: [fileURLToPath(new URL("../src/workflow-observability.ts", import.meta.url))]
    });
  }, 60_000);

  afterAll(async () => {
    await env?.teardown();
    if (collector) await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
  });

  function exporter(): SpanExporter {
    return createOtlpSpanExporter({ endpoint, serviceName: "space-worker-test", flushIntervalMs: 60_000 });
  }

  async function worker(spans: SpanExporter, activities: Record<string, (...args: any[]) => any>, taskQueue = `tracing-${++counter}`) {
    return { taskQueue, instance: await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowBundle, activities,
      sinks: workflowSpanSinks(spans),
      interceptors: { activity: [createActivityObservabilityInterceptors({ spans })] }
    }) };
  }

  it("connects the API parent, real workflow and every retry attempt, and replay exports nothing", async () => {
    const start = received.length;
    const spans = exporter();
    const apiSpans = createOtlpSpanExporter({ endpoint, serviceName: "space-api-test", flushIntervalMs: 60_000 });
    const httpObservation = createHttpObservability({ serviceName: "space-api-test", spanExporter: apiSpans });
    const api = Fastify();
    api.addHook("onRequest", async request => httpObservation.onRequest(request));
    api.addHook("onResponse", async (request, reply) => httpObservation.onResponse(request, reply));
    let attempts = 0;
    const { instance, taskQueue } = await worker(spans, {
      recordDummyTurnStarted: async () => {
        if (++attempts === 1) throw ApplicationFailure.create({ message: "PRIVATE error /home/user/secret https://private.test", type: "UPSTREAM_TIMEOUT" });
      },
      recordDummyTurnCompleted: async () => ({ status: "COMPLETED" })
    });
    let history: unknown;
    api.get("/synthetic/turn", async request => {
      const handle = await env.client.workflow.start("dummyTurnWorkflow", {
        workflowId: `real-trace-${++counter}`, taskQueue, workflowExecutionTimeout: "30 seconds",
        args: [{ traceparent: traceContextForRawRequest(request.raw).traceparent, traceId: "trace:synthetic", roomId: "room:synthetic", paneId: "pane:synthetic",
          prompt: "PRIVATE prompt /home/user/file https://private.test", modelOutput: "PRIVATE model output" }]
      });
      const result = await handle.result();
      history = await handle.fetchHistory();
      return result;
    });
    try {
      await instance.runUntil(async () => {
        const response = await api.inject({ method: "GET", url: "/synthetic/turn", headers: { traceparent } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ status: "COMPLETED" });
      });
      await spans.flush();
      await apiSpans.flush();
      const exported = received.slice(start);
      const httpSpan = exported.find(s => s.name === "GET /synthetic/turn")!;
      const workflow = exported.find(s => s.name === "workflow dummyTurnWorkflow")!;
      expect(httpSpan).toBeDefined();
      expect(httpSpan.traceId).toBe(traceId);
      expect(httpSpan.parentSpanId).toBe(apiSpanId);
      expect(workflow).toBeDefined();
      expect(workflow.traceId).toBe(traceId);
      expect(workflow.parentSpanId).toBe(httpSpan.spanId);
      const activitySpans = exported.filter(s => s.name.startsWith("activity "));
      expect(activitySpans).toHaveLength(3);
      for (const span of activitySpans) {
        expect(span.traceId).toBe(traceId);
        expect(span.parentSpanId).toBe(workflow.spanId);
      }
      expect(new Set(activitySpans.map(s => s.spanId)).size).toBe(3);
      const retrySpans = activitySpans.filter(s => s.name === "activity recordDummyTurnStarted");
      expect(retrySpans.map(s => attributes(s)["space.attempt"]).sort()).toEqual(["1", "2"]);
      expect(attributes(retrySpans.find(s => attributes(s)["space.outcome"] === "FAILED")!)).toMatchObject({
        "space.reason_code": "UPSTREAM_TIMEOUT", "space.category": "TIMEOUT"
      });
      for (const span of exported.filter(s => s !== httpSpan)) for (const attribute of span.attributes) expect(WORKER_SPAN_ATTRIBUTES.has(attribute.key)).toBe(true);
      expect(JSON.stringify(exported)).not.toMatch(/PRIVATE|private\.test|\/home\/user|prompt|modelOutput/);
      const beforeReplay = spans.stats().exported;
      await Worker.runReplayHistory({ workflowBundle, sinks: workflowSpanSinks(spans) }, history);
      await spans.flush();
      expect(spans.stats().exported).toBe(beforeReplay);
      expect(received.slice(start)).toHaveLength(exported.length);
    } finally { await api.close(); httpObservation.close(); await apiSpans.close(); await spans.close(); }
  }, 60_000);

  it("nests a real memory consolidation child under maintenance without an input traceparent on the child", async () => {
    const start = received.length;
    const spans = exporter();
    const { instance, taskQueue } = await worker(spans, {
      refreshMemoryGraphSnapshot: async () => ({ sourceHash: "hash:synthetic" }),
      refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
      reconcileStaleSpaceAgentSessions: async () => undefined,
      createScheduledMemoryAudit: async () => ({ id: "audit:synthetic", workflowId: `audit-${++counter}` }),
      prepareMemoryConsolidation: async () => ({ changeSetId: null, run: { id: "audit:synthetic", status: "COMPLETED" } })
    }, MEMORY_MAINTENANCE_TASK_QUEUE);
    try {
      await instance.runUntil(env.client.workflow.execute("memoryMaintenanceWorkflow", {
        workflowId: `memory-trace-${++counter}`, taskQueue, workflowExecutionTimeout: "30 seconds", args: [{ traceparent, traceId: "trace:synthetic" }]
      }));
      await spans.flush();
      const exported = received.slice(start);
      const parent = exported.find(s => s.name === "workflow memoryMaintenanceWorkflow")!;
      const child = exported.find(s => s.name === "workflow memoryConsolidationWorkflow")!;
      expect(parent).toBeDefined(); expect(child).toBeDefined();
      expect(parent.parentSpanId).toBe(apiSpanId);
      expect(child.traceId).toBe(parent.traceId);
      expect(child.parentSpanId).toBe(parent.spanId);
      const childActivity = exported.find(s => s.name === "activity prepareMemoryConsolidation")!;
      expect(childActivity.parentSpanId).toBe(child.spanId);
      expect(childActivity.traceId).toBe(traceId);
    } finally { await spans.close(); }
  }, 60_000);

  it("links continued runs to the prior workflow span with distinct span IDs", async () => {
    const start = received.length;
    const spans = exporter();
    const { instance, taskQueue } = await worker(spans, { traceEcho: async () => "ok" });
    try {
      await instance.runUntil(env.client.workflow.execute("tracingContinuation", {
        workflowId: `continuation-trace-${++counter}`, taskQueue, workflowExecutionTimeout: "30 seconds", args: [{ iteration: 0, traceparent }]
      }));
      await spans.flush();
      const workflowSpans = received.slice(start).filter(s => s.name === "workflow tracingContinuation");
      expect(workflowSpans).toHaveLength(2);
      const first = workflowSpans.find(s => attributes(s)["space.outcome"] === "CONTINUED_AS_NEW")!;
      const second = workflowSpans.find(s => attributes(s)["space.outcome"] === "COMPLETED")!;
      expect(second.spanId).not.toBe(first.spanId);
      expect(second.traceId).toBe(traceId);
      expect(second.links).toContainEqual({ traceId, spanId: first.spanId });
    } finally { await spans.close(); }
  }, 60_000);

  it.each([
    { type: "dotGoalWorkflow", input: { goalId: "goal:synthetic" }, activity: "dotGoalStep",
      result: { state: "DONE", runId: null, goalStatus: "COMPLETED" } },
    { type: "roomAgentActionWorkflow", input: { actionId: "action:synthetic", traceId: "trace:synthetic" }, activity: "runRoomAgentBackgroundAction",
      result: { status: "COMPLETED" } },
    { type: "memoryMutationWorkflow", input: { changeSetId: "memory_change:synthetic", traceId: "trace:synthetic" }, activity: "executePersistedMemoryChangeSet",
      result: { status: "COMPLETED" } }
  ])("parents $type and its activity through memo when input has no W3C fields", async ({ type, input, activity, result }) => {
    const start = received.length;
    const spans = exporter();
    const { instance, taskQueue } = await worker(spans, { [activity]: async () => result });
    try {
      await instance.runUntil(env.client.workflow.execute(type, {
        workflowId: `memo-trace-${++counter}`, taskQueue, workflowExecutionTimeout: "30 seconds",
        args: [input], memo: { traceparent }
      }));
      await spans.flush();
      const exported = received.slice(start);
      const workflow = exported.find(s => s.name === `workflow ${type}`)!;
      const attempt = exported.find(s => s.name === `activity ${activity}`)!;
      expect(workflow).toBeDefined(); expect(attempt).toBeDefined();
      expect(workflow.traceId).toBe(traceId);
      expect(workflow.parentSpanId).toBe(apiSpanId);
      expect(attempt.traceId).toBe(traceId);
      expect(attempt.parentSpanId).toBe(workflow.spanId);
    } finally { await spans.close(); }
  }, 60_000);

  it("performs no export when workflow instrumentation and the activity exporter are disabled", async () => {
    const start = received.length;
    const plainBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./fixtures/tracing-workflows.ts", import.meta.url))
    });
    const taskQueue = `untraced-${++counter}`;
    const instance = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: plainBundle,
      activities: { recordDummyTurnStarted: async () => undefined, recordDummyTurnCompleted: async () => ({ status: "COMPLETED" }) },
      interceptors: { activity: [createActivityObservabilityInterceptors({ spans: null })] }
    });
    await instance.runUntil(env.client.workflow.execute("dummyTurnWorkflow", {
      workflowId: `untraced-${++counter}`, taskQueue, workflowExecutionTimeout: "30 seconds", args: [{ traceparent }]
    }));
    expect(received).toHaveLength(start);
  }, 60_000);

  it("keeps a second signaled supervisor mission and its activities in that request's trace", async () => {
    const start = received.length;
    const spans = exporter();
    const secondTrace = "11111111111111111111111111111111";
    const secondApiSpan = "2222222222222222";
    const secondParent = `00-${secondTrace}-${secondApiSpan}-01`;
    let firstDone!: () => void;
    let secondDone!: () => void;
    let backgroundDone!: () => void;
    const firstFinished = new Promise<void>(resolve => { firstDone = resolve; });
    const secondFinished = new Promise<void>(resolve => { secondDone = resolve; });
    const backgroundFinished = new Promise<void>(resolve => { backgroundDone = resolve; });
    const waitForMission = async (finished: Promise<void>) => {
      let timer: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([finished, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Synthetic mission did not finish")), 10_000);
        })]);
      } finally { clearTimeout(timer!); }
    };
    const { instance, taskQueue } = await worker(spans, {
      checkRoomAgentSupervisorTurn: async () => "READY",
      runCodexAppServerTurn: async () => ({ status: "COMPLETED", message: "done",
        roomAgentOutcome: { status: "VERIFIED", statusReason: "Synthetic completion", pendingActionIds: [] } }),
      finishRoomAgentSupervisorTurn: async ({ item }: any) => {
        if (item.missionId === "mission:first") firstDone();
        if (item.missionId === "mission:second") secondDone();
        if (item.missionId === "mission:background") backgroundDone();
      }
    });
    const item = (suffix: string, parent: string) => ({ missionId: `mission:${suffix}`, turn: {
      roomId: "room:tracing", paneId: "pane:tracing", prompt: "Synthetic task", artifactIds: [],
      traceId: `trace:${suffix}`, traceparent: parent, agentRunId: `agent_run:${suffix}`,
      roomAgentMissionId: `mission:${suffix}`
    } });
    try {
      await instance.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor-trace-${++counter}`, taskQueue, workflowExecutionTimeout: "1 minute",
          args: [{ roomId: "room:tracing", pending: [], processedCount: 0 }], memo: { traceparent }
        });
        try {
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("first", traceparent));
          await waitForMission(firstFinished);
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("second", secondParent));
          await waitForMission(secondFinished);
          const background = item("background", "00-33333333333333333333333333333333-4444444444444444-01");
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...background, turn: { ...background.turn, traceLink: secondParent } });
          await waitForMission(backgroundFinished);
          // The activity stub resolves before the SDK reports its completion.
          // Wait for the server to record that completion and the following
          // workflow task before cancelling the now-idle supervisor. Cancelling
          // from inside the stub races activity completion on the test server.
          await expect.poll(async () => {
            const events = (await handle.fetchHistory()).events ?? [];
            const finishes = events.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === "finishRoomAgentSupervisorTurn");
            if (finishes.length !== 3) return false;
            const scheduledId = String(finishes[2]!.eventId);
            const completed = events.findIndex(event => String(event.activityTaskCompletedEventAttributes?.scheduledEventId) === scheduledId);
            return completed >= 0 && events.slice(completed + 1).some(event => event.workflowTaskCompletedEventAttributes);
          }, { timeout: 10_000, interval: 20 }).toBe(true);
        } finally {
          await handle.cancel();
          await expect(handle.result()).rejects.toThrow();
        }
      });
      await spans.flush();
      const exported = received.slice(start);
      const missionActivities = exported.filter(s => attributes(s)["space.mission_id"] === "mission:second" && s.name.startsWith("activity "));
      expect(missionActivities.filter(s => /checkRoomAgentSupervisorTurn|finishRoomAgentSupervisorTurn/.test(s.name))).toHaveLength(2);
      for (const activity of missionActivities) expect(activity.traceId).toBe(secondTrace);
      const child = exported.find(s => s.traceId === secondTrace && s.name === "workflow codexAppServerTurnWorkflow")!;
      expect(child).toBeDefined();
      const segment = exported.find(s => s.traceId === secondTrace && s.spanId === child.parentSpanId)!;
      expect(segment).toBeDefined();
      expect(segment.parentSpanId).toBe(secondApiSpan);
      expect(segment.links?.some(link => link.traceId === traceId)).toBe(true);
      for (const activity of missionActivities.filter(s => /checkRoomAgentSupervisorTurn|finishRoomAgentSupervisorTurn/.test(s.name))) {
        expect(activity.parentSpanId).toBe(segment.spanId);
      }
      const backgroundChild = exported.find(s => s.traceId === "33333333333333333333333333333333" && s.name === "workflow codexAppServerTurnWorkflow")!;
      expect(backgroundChild).toBeDefined();
      const backgroundSegment = exported.find(s => s.traceId === backgroundChild.traceId && s.spanId === backgroundChild.parentSpanId)!;
      expect(backgroundSegment).toBeDefined();
      expect(backgroundSegment.parentSpanId).toBeUndefined();
      expect(backgroundSegment.links).toContainEqual({ traceId: secondTrace, spanId: secondApiSpan });
    } finally { await spans.close(); }
  }, 60_000);
});
