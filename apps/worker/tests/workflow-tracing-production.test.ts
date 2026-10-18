import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { defaultPayloadConverter } from "@temporalio/common";
import { ApplicationFailure } from "@temporalio/common";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { dummyTurnInputSchema, parseTraceparent, ROOM_AGENT_ENQUEUE_SIGNAL, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { createOtlpSpanExporter, type ServerSpan, type SpanExporter } from "@space/runtime";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { recordTraceActivity } from "./workflow-tracing-activity.js";
import { observeActivityExecution, activitySpanParent, activityTraceparent } from "../src/activity-observability.js";
import { workerTracingOptions } from "../src/worker-tracing.js";
import { TRACE_HEADER, runSpanId, MAX_MISSION_CONTEXTS, missionContextsFromHeaders, withMissionContextsHeader } from "../src/workflow-trace-context.js";
import { executeRoomActionBridge, executeBackgroundRoomAction } from "../src/room-action-bridge.js";
import { executeBrowserActionBridge } from "../src/browser-action-bridge.js";
import { executeMcpActionBridge } from "../src/mcp-action-bridge.js";
import { handleDotToolCall } from "../src/dot-tool-gateway.js";
import { getCodexAppServerTurnActivityConfig, dotGoalStep } from "../src/activities.js";

const traceA = "4bf92f3577b34da6a3ce929d0e0e4736";
const traceB = "0af7651916cd43dd8448eb211c80319c";
const apiSpan = "00f067aa0ba902b7";
const parentA = `00-${traceA}-${apiSpan}-01`;
const parentB = `00-${traceB}-${apiSpan}-01`;
const runId = "12345678-1234-4234-8234-123456789abc";
function exporter(spans: ServerSpan[]): SpanExporter {
  return { record: s => { spans.push(s); }, flush: async () => {}, close: async () => {}, stats: () => ({ exported: spans.length, dropped: 0, failed: 0 }) };
}
function info() { return { activityType: "runCodexAppServerTurn", activityId: "1", attempt: 1, workflowType: "codexAppServerTurnWorkflow", workflowExecution: { workflowId: "review:workflow", runId }, currentAttemptScheduledTimestampMs: Date.now() }; }
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("Probe timed out"); await new Promise(r => setTimeout(r, 20)); }
}

describe("production trace propagation", () => {
  it("checks the disabled worker tracing path structurally at runtime", () => {
    const options = workerTracingOptions(null);
    expect(options.sinks).toBeUndefined();
    expect(options.interceptors?.workflowModules).toBeUndefined();
  });

  it("bounds and validates mission contexts carried through continue-as-new", () => {
    const contexts = new Map(Array.from({ length: 300 }, (_, i) => [`mission:${i}`, { traceId: traceA, spanId: apiSpan }] as const));
    const restored = missionContextsFromHeaders(withMissionContextsHeader({}, contexts));
    expect(restored).toHaveLength(MAX_MISSION_CONTEXTS);
    expect(restored[0]![0]).toBe("mission:44");
    expect(restored.at(-1)![0]).toBe("mission:299");
    expect(missionContextsFromHeaders({ "space-otlp-mission-contexts": defaultPayloadConverter.toPayload([["bad mission", { traceId: traceA, spanId: apiSpan }], ["mission:zero", { traceId: traceA, spanId: "0".repeat(16) }]]) })).toEqual([]);
  });

  it("isolates concurrent activities and survives an exporter that throws", async () => {
    const spans: ServerSpan[] = [];
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const first = observeActivityExecution(info(), [{ traceparent: parentA }], async () => {
      const before = activityTraceparent();
      await blocked;
      expect(activityTraceparent()).toBe(before);
      return before;
    }, { spans: exporter(spans) });
    const second = await observeActivityExecution({ ...info(), activityId: "2" }, [{ traceparent: parentB }], async () => {
      return activityTraceparent();
    }, { spans: exporter(spans) });
    release();
    const firstParent = await first;
    expect(parseTraceparent(firstParent)?.traceId).toBe(traceA);
    expect(parseTraceparent(second)?.traceId).toBe(traceB);
    expect(spans.some(s => s.spanId === parseTraceparent(firstParent)?.parentId)).toBe(true);
    await expect(observeActivityExecution(info(), [], async () => "done", { spans: { ...exporter([]), record: () => { throw new Error("collector bug"); } } })).resolves.toBe("done");
  });

  it("propagates the exported activity span through the foreground room bridge", async () => {
    const spans: ServerSpan[] = [];
    let outgoing = "";
    const request = { toolId: "room:inspect", action: { type: "inspect" } };
    const turn = dummyTurnInputSchema.parse({ roomId: "room:review", paneId: "pane:review", prompt: "review", traceId: "req:review", traceparent: parentA, agentSessionId: "session:review", roomAgentMissionId: "mission:review", selectedToolIds: ["room:inspect"] });
    await observeActivityExecution(info(), [turn], () => executeRoomActionBridge({
      turnInput: turn,
      assistantContent: "```space-room-actions\n" + JSON.stringify({ version: 1, actions: [request] }) + "\n```",
      config: { ...getCodexAppServerTurnActivityConfig({}), internalApiToken: "review-only" },
      fetchImpl: async (_url, init) => { outgoing = new Headers(init?.headers).get("traceparent") ?? ""; return Response.json({ id: "space-agent-room-action-bridge", results: [{ request, status: "EXECUTED", statusReason: "review" }] }); }
    }), { spans: exporter(spans), headers: { [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceId: traceA, spanId: runSpanId(runId) }) } });
    const outboundParent = parseTraceparent(outgoing)!.parentId;
    expect(spans).toHaveLength(1);
    expect(outboundParent).not.toBe(apiSpan);
    expect(outboundParent).not.toBe(runSpanId(runId));
    expect(outboundParent).toBe(spans[0]!.spanId);
  });

  it("propagates active activity contexts through background room, Dot Goal, browser, MCP and Dot tool HTTP requests", async () => {
    const captured: Array<HeadersInit | undefined> = [];
    const spans: ServerSpan[] = [];
    const request = { toolId: "room:inspect", action: { type: "inspect" } };
    const turn = dummyTurnInputSchema.parse({ roomId: "room:review", paneId: "pane:review", prompt: "review", traceId: "req:review", traceparent: parentA, agentSessionId: "session:review", operatorUserId: "user:review", dotId: `dot:${"a".repeat(32)}`, roomAgentMissionId: "mission:review", selectedToolIds: ["browser:navigate", "mcp:call"] });
    const config = { ...getCodexAppServerTurnActivityConfig({}), browserToolBridgeEnabled: true, mcpToolBridgeEnabled: true, internalApiToken: "review-only" };
    await observeActivityExecution(info(), [], () => executeBackgroundRoomAction({ roomId: "room:review", missionId: "mission:review", agentPaneId: "pane:review", agentSessionId: "session:review", requestId: "req:review", selectedToolIds: ["room:inspect"], actions: [request] } as never,
      { internalApiBaseUrl: "http://127.0.0.1:4910", internalApiToken: "review-only" },
      (async (_url: unknown, init: RequestInit) => { captured.push(init.headers); return Response.json({ id: "space-agent-room-action-bridge", results: [{ request, status: "EXECUTED", statusReason: "review" }] }); }) as never), { spans: exporter(spans), headers: { [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceId: traceA, spanId: runSpanId(runId) }) } });
    vi.stubEnv("SPACE_INTERNAL_API_TOKEN", "review-only");
    try {
      await observeActivityExecution({ ...info(), activityType: "dotGoalStep", activityId: "2" }, [], () => dotGoalStep("goal:review", async (_url, init) => { captured.push(init?.headers); return Response.json({ state: "DONE", goal: { status: "COMPLETED" } }); }), { spans: exporter(spans), headers: { [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceId: traceA, spanId: runSpanId(runId) }) } });
    } finally { vi.unstubAllEnvs(); }
    await observeActivityExecution({ ...info(), activityId: "3" }, [turn], () => executeBrowserActionBridge({
      turnInput: turn,
      assistantContent: "```space-browser-actions\n" + JSON.stringify({ version: 1, actions: [{ toolId: "browser:navigate", targetPaneId: "pane:browser", action: { type: "navigate", url: "https://example.com" } }] }) + "\n```",
      config,
      fetchImpl: async (_url, init) => { captured.push(init?.headers); return Response.json({ id: "space-agent-browser-action-bridge", results: [] }); }
    }), { spans: exporter(spans), headers: { [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceId: traceA, spanId: runSpanId(runId) }) } });
    await observeActivityExecution({ ...info(), activityId: "4" }, [turn], () => executeMcpActionBridge({
      turnInput: turn,
      assistantContent: "```space-mcp-actions\n" + JSON.stringify({ version: 1, actions: [{ toolId: "mcp:call", action: { type: "execute", arguments: {} } }] }) + "\n```",
      config,
      fetchImpl: async (_url, init) => { captured.push(init?.headers); return Response.json({ id: "space-agent-mcp-action-bridge", results: [] }); }
    }), { spans: exporter(spans), headers: { [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceId: traceA, spanId: runSpanId(runId) }) } });
    await observeActivityExecution({ ...info(), activityId: "5" }, [turn], () => handleDotToolCall({
      turnInput: turn,
      config,
      store: {} as never,
      repository: {} as never,
      fetchImpl: async (_url, init) => { captured.push(init?.headers); return Response.json({ tools: [] }); }
    }, { id: 1, method: "item/tool/call", params: { tool: "space_search_tools", arguments: { query: "memory" } } } as never), { spans: exporter(spans), headers: { [TRACE_HEADER]: defaultPayloadConverter.toPayload({ traceId: traceA, spanId: runSpanId(runId) }) } });
    expect(captured.map(h => parseTraceparent(new Headers(h).get("traceparent"))?.parentId)).toEqual(spans.map(s => s.spanId));
    expect(spans).toHaveLength(5);
    expect(new Set(spans.map(s => s.spanId)).size).toBe(5);
  });

  it("parents pre-header activities to their owning workflow", () => {
    const parent = activitySpanParent(info(), [{ traceparent: parentA }]);
    expect(parent?.spanId).not.toBe(apiSpan);
    expect(parent?.spanId).toBe(runSpanId(runId));
  });
});

describe("production Temporal trace regression tests", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { Runtime.install({ logger: new DefaultLogger("ERROR") }); env = await TestWorkflowEnvironment.createLocal(); }, 120_000);
  afterAll(async () => { await env?.teardown(); }, 30_000);
  it("preserves parentage across production memory workers and their child workflow", async () => {
    const spans: ServerSpan[] = [];
    const options = workerTracingOptions(exporter(spans), fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url)));
    const maintenance = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
      activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "review:hash" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => ({}),
        reconcileStaleSpaceAgentSessions: async () => ({}),
        createScheduledMemoryAudit: async () => ({ id: "review:audit", workflowId: "review:memory-child" }),
        prepareMemoryConsolidation: async () => ({ changeSetId: "review:change", run: {} }),
        finalizeMemoryRepair: async () => ({ id: "review:audit" })
      }, ...options });
    const mutation = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("../src/memory-mutation-workflows.ts", import.meta.url)),
      activities: { executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" }) }, ...options });
    const running = [maintenance.run(), mutation.run()];
    try {
      await env.client.workflow.execute("memoryMaintenanceWorkflow", { workflowId: "review:memory-root",
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, args: [{ traceId: "req:memory-review" }], memo: { traceparent: parentA } });
      await env.client.workflow.execute("memoryMutationWorkflow", { workflowId: "review:memory-mutation",
        taskQueue: MEMORY_MUTATION_TASK_QUEUE, args: [{ changeSetId: "review:change", traceId: "req:memory-review" }], memo: { traceparent: parentA } });
      expect(spans.filter(s => s.kind === 1).map(s => s.name)).toContain("memoryConsolidationWorkflow");
      expect(spans.filter(s => s.name === "activity executePersistedMemoryChangeSet")).toHaveLength(2);
      const index = new Set(spans.map(s => s.spanId));
      index.add(apiSpan);
      expect(spans.every(s => s.traceId === traceA && s.parentSpanId !== null && index.has(s.parentSpanId))).toBe(true);
      expect(new Set(spans.map(s => s.spanId)).size).toBe(spans.length);
    } finally { await Promise.all([maintenance.shutdown(), mutation.shutdown()]); await Promise.all(running); }
  }, 120_000);

  it("retains the underlying failure code and category through ActivityFailure for both ApplicationFailure and plain Error", async () => {
    const spans: ServerSpan[] = [];
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: "review-workflow-failure", workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)), activities: {
      runCodexAppServerTurn: async () => { throw ApplicationFailure.nonRetryable("review only", "UPSTREAM_RETRYABLE_UNAVAILABLE"); },
      runOpenCodeAgentTurn: async () => { throw Object.assign(new Error("review plain error"), { code: "CODEX_APP_SERVER_TURN_TIMEOUT" }); }
    }, ...workerTracingOptions(exporter(spans), fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))) });
    const running = worker.run();
    try {
      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", { workflowId: "review:workflow-failure", taskQueue: "review-workflow-failure", args: [{ roomId: "room:review", paneId: "pane:review", prompt: "review", traceId: "req:review", traceparent: parentA }] });
      await expect(handle.result()).rejects.toThrow();
      const workflow = spans.find(s => s.name === "codexAppServerTurnWorkflow" && s.attributes["space.workflow_id"] === "review:workflow-failure")!;
      const activity = spans.find(s => s.name === "activity runCodexAppServerTurn" && s.attributes["space.workflow_id"] === "review:workflow-failure")!;
      expect(activity.attributes["space.reason_code"]).toBe("UPSTREAM_RETRYABLE_UNAVAILABLE");
      expect(workflow.attributes["space.status"]).toBe("FAILED");
      expect(workflow.attributes["space.reason_code"]).toBe("UPSTREAM_RETRYABLE_UNAVAILABLE");
      expect(workflow.attributes["space.category"]).toBe("UPSTREAM_UNAVAILABLE");

      const plainHandle = await env.client.workflow.start("codexAppServerTurnWorkflow", { workflowId: "review:workflow-plain-failure", taskQueue: "review-workflow-failure", args: [{ roomId: "room:review", paneId: "pane:review", prompt: "review", traceId: "req:review-plain", traceparent: parentA, providerId: "opencode" }] });
      await expect(plainHandle.result()).rejects.toThrow();
      const plainWorkflow = spans.find(s => s.name === "codexAppServerTurnWorkflow" && s.attributes["space.workflow_id"] === "review:workflow-plain-failure")!;
      expect(plainWorkflow.attributes["space.status"]).toBe("FAILED");
      expect(plainWorkflow.attributes["space.reason_code"]).toBe("CODEX_APP_SERVER_TURN_TIMEOUT");
      expect(plainWorkflow.attributes["space.category"]).toBe("TIMEOUT");
    } finally { await worker.shutdown(); await running; }
  }, 120_000);
  it("completes real Temporal work while an exporter POST is still waiting", async () => {
    let release: (() => void) | undefined;
    let delivered = false;
    const otlp = createOtlpSpanExporter({ endpoint: "http://127.0.0.1:4318", serviceName: "review-only", batchSize: 1, timeoutMs: 30_000, flushIntervalMs: 60_000, fetch: async () => delivered ? { ok: true } : await new Promise<{ ok: boolean }>(resolve => { release = () => { delivered = true; resolve({ ok: true }); }; }) });
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue: "review-stalled-collector", workflowsPath: fileURLToPath(new URL("./workflow-tracing-fixture.ts", import.meta.url)), activities: { recordTraceActivity }, ...workerTracingOptions(otlp, fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))) });
    const running = worker.run();
    try {
      const handle = await env.client.workflow.start("tracedChildWorkflow", { workflowId: "review:stalled-collector", taskQueue: "review-stalled-collector", args: [{ traceparent: parentA }] });
      await expect(handle.result()).resolves.toBe("child-done");
      expect(release).toBeTypeOf("function");
      expect(delivered).toBe(false);
    } finally { await worker.shutdown(); await running; release?.(); await otlp.close(); }
  }, 120_000);
  it("retains mission attribution and background continuation links after a real supervisor continue-as-new", async () => {
    const spans: ServerSpan[] = [];
    const tracing = workerTracingOptions(exporter(spans), fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url)));
    const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
    const item = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:continued", turn: {
      roomId: "room:continued", paneId: "pane:review", prompt: "review", traceId: "req:continued", traceparent: parentA,
      agentRunId: "agent_run:continued", agentSessionId: "session:review", agentAssistantMessageId: "message:continued", roomAgentMissionId: "mission:continued"
    } });
    let preparedOnce = false;
    const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace,
      taskQueue: "review-supervisor-continue", workflowsPath, ...tracing,
      activities: {
        checkRoomAgentSupervisorTurn: async () => "READY",
        runCodexAppServerTurn: async (turn: Record<string, unknown>) => ({ roomId: turn.roomId, paneId: turn.paneId,
          traceId: turn.traceId, workflowId: "review:continued-child", status: "COMPLETED", message: "done",
          roomAgentOutcome: { status: "VERIFIED", statusReason: "review",
            ...(turn.roomAgentContinuation ? {} : { pendingActionIds: ["action:continued"] }) } }),
        finishRoomAgentSupervisorTurn: async () => {},
        discardRoomAgentSupervisorTurn: async () => {},
        prepareRoomAgentBackgroundContinuation: async () => {
          if (!preparedOnce) {
            preparedOnce = true;
            return {
              state: "READY",
              item: roomAgentSupervisorQueueItemSchema.parse({
                missionId: "mission:continued",
                turn: {
                  ...item.turn,
                  traceId: "trace:bg-continued",
                  agentRunId: "agent_run:bg-continued",
                  roomAgentContinuation: {
                    sourceRunId: "agent_run:continued",
                    generation: 1,
                    sourceSpanContext: { traceId: traceA, spanId: apiSpan }
                  }
                }
              })
            };
          }
          return { state: "DONE" };
        }
      } });
    const running = worker.run();
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { workflowId: "review:supervisor-continue",
      taskQueue: "review-supervisor-continue", args: [{ roomId: "room:continued", pending: [item], processedCount: 49 }], memo: { traceparent: parentB } });
    try {
      await eventually(() => spans.some(s => s.name === "activity finishRoomAgentSupervisorTurn" && s.attributes["space.agent_run_id"] === "agent_run:bg-continued"));
      const monitoring = spans.find(s => s.name === "activity prepareRoomAgentBackgroundContinuation")!;
      expect(monitoring.traceId).toBe(traceA);
      expect(monitoring.attributes["space.temporal_run_id"]).not.toBe(handle.firstExecutionRunId);
      await eventually(() => spans.some(s => s.traceId === traceA && s.spanId === monitoring.parentSpanId));
      const bgChild = spans.find(s => s.name === "codexAppServerTurnWorkflow" && s.attributes["space.agent_run_id"] === "agent_run:bg-continued")!;
      expect(bgChild.traceId).toBe(traceA);
      expect(bgChild.links).toContainEqual({
        traceId: traceA,
        spanId: apiSpan,
        attributes: { "link.reason": "background_continuation" }
      });
      await handle.cancel();
      await handle.result().catch(() => undefined);
      const history = await handle.fetchHistory();
      const count = spans.length;
      await Worker.runReplayHistory({ workflowsPath, ...tracing }, history, "review:supervisor-continue");
      expect(spans).toHaveLength(count);
    } finally { await handle.cancel().catch(() => undefined); await worker.shutdown(); await running; }
  }, 120_000);

  it("exports finite supervisor operations in each mission trace while the supervisor remains running", async () => {
    const spans: ServerSpan[] = [];
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace, taskQueue: "review-production-supervisor",
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
      activities: {
        checkRoomAgentSupervisorTurn: async () => "READY",
        runCodexAppServerTurn: async (turn: Record<string, unknown>) => ({ roomId: turn.roomId, paneId: turn.paneId, traceId: turn.traceId, workflowId: "review:child", status: "COMPLETED", message: "done", roomAgentOutcome: { status: "VERIFIED", statusReason: "review" } }),
        finishRoomAgentSupervisorTurn: async () => {},
        discardRoomAgentSupervisorTurn: async () => {}
      },
      ...workerTracingOptions(exporter(spans), fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url)))
    });
    const running = worker.run();
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: "review-production-supervisor", workflowId: "review:supervisor", args: [{ roomId: "room:review", pending: [], processedCount: 0 }], memo: { traceparent: parentA } });
    const item = (suffix: string, tp: string) => roomAgentSupervisorQueueItemSchema.parse({ missionId: `mission:review-${suffix}`, turn: { roomId: "room:review", paneId: "pane:review", prompt: "review", traceId: `req:review-${suffix}`, traceparent: tp, agentRunId: `agent_run:review-${suffix}`, agentSessionId: "session:review", agentAssistantMessageId: `message:review-${suffix}`, roomAgentMissionId: `mission:review-${suffix}` } });
    try {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("A", parentA));
      await eventually(() => spans.some(s => s.name === "activity finishRoomAgentSupervisorTurn" && s.attributes["space.mission_id"] === "mission:review-A"));
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("B", parentB));
      await eventually(() => spans.some(s => s.name === "activity finishRoomAgentSupervisorTurn" && s.attributes["space.mission_id"] === "mission:review-B"));
      const childB = spans.find(s => s.name === "codexAppServerTurnWorkflow" && s.attributes["space.mission_id"] === "mission:review-B")!;
      const bookkeepingB = spans.filter(s => s.attributes["space.mission_id"] === "mission:review-B" && s.name.includes("SupervisorTurn"));
      const supervisorSpans = spans.filter(s => s.name === "roomAgentSupervisorWorkflow");
      expect(childB.traceId).toBe(traceB);
      expect(bookkeepingB).toHaveLength(2);
      expect(bookkeepingB.every(s => s.traceId === traceB)).toBe(true);
      await eventually(() => spans.filter(s => s.name.startsWith("roomAgentSupervisorWorkflow.")).length >= 6);
      const operations = spans.filter(s => s.name.startsWith("roomAgentSupervisorWorkflow."));
      expect(operations.length).toBeGreaterThanOrEqual(6);
      for (const activity of bookkeepingB) {
        expect(operations.some(s => s.traceId === traceB && s.spanId === activity.parentSpanId && s.parentSpanId === apiSpan)).toBe(true);
      }
      expect(operations.some(s => s.traceId === traceB && s.spanId === childB.parentSpanId && s.parentSpanId === apiSpan)).toBe(true);
      expect(supervisorSpans).toHaveLength(0);
    } finally {
      await handle.cancel(); await handle.result().catch(() => {}); await worker.shutdown(); await running;
    }
  }, 120_000);
});
