import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deterministicSpanId,
  formatTraceparent,
  parseTraceparent,
  type DummyTurnInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import {
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  ALLOWED_SPAN_LINK_ATTRIBUTE_KEYS,
  createOtlpSpanExporter,
  otlpTraceRequest,
  sanitizeSpanAttributes,
  type SpanExporter
} from "@space/runtime";
import {
  createActivityObservabilityInterceptors,
  noteActivityFailureReason
} from "../src/activity-observability.js";
import { prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import {
  createWorkflowObservabilitySinks,
  recordWorkflowSpanFromSink,
  workflowObservabilityInterceptorsPath
} from "../src/workflow-observability.js";
import {
  ContinueAsNew,
  type Headers,
  type WorkflowInfo
} from "@temporalio/workflow";
import { continuationFixture } from "./room-continuation-fixture.js";

const workflowState = vi.hoisted(() => ({
  info: null as WorkflowInfo | null,
  sinks: null as ReturnType<typeof createWorkflowObservabilitySinks> | null,
  nowMs: 1_700_000_000_000
}));

vi.mock("@temporalio/workflow", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@temporalio/workflow")>();
  return {
    ...actual,
    workflowInfo: () => {
      if (!workflowState.info) throw new Error("workflowInfo() called outside simulated workflow context");
      return workflowState.info;
    },
    proxySinks: () => ({
      observability: {
        recordWorkflowSpan(payload: Parameters<typeof recordWorkflowSpanFromSink>[0]) {
          if (workflowState.info && workflowState.sinks) {
            void workflowState.sinks.observability.recordWorkflowSpan.fn(workflowState.info, payload);
          }
        }
      }
    })
  };
});

import {
  decodeSpaceTraceHeader,
  interceptors as createWorkflowInterceptors
} from "../src/workflow-observability-interceptors.js";

interface OtlpExportedAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface OtlpExportedLink {
  traceId: string;
  spanId: string;
  attributes?: OtlpExportedAttribute[];
}

interface OtlpExportedSpan {
  serviceName: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  links?: Array<{
    traceId: string;
    spanId: string;
    attributes: Record<string, string | number>;
  }>;
  status: { code: number };
}

function decodeAttributes(entries: OtlpExportedAttribute[] | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const entry of entries ?? []) {
    if (entry.value.intValue !== undefined) out[entry.key] = Number(entry.value.intValue);
    else if (entry.value.stringValue !== undefined) out[entry.key] = entry.value.stringValue;
  }
  return out;
}

async function startFakeOtlpCollector() {
  const payloads: unknown[] = [];
  const spans: OtlpExportedSpan[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST" || req.url !== "/v1/traces") {
      res.writeHead(404).end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => { body += String(chunk); });
    req.on("end", () => {
      const parsed = JSON.parse(body);
      payloads.push(parsed);
      for (const rs of parsed.resourceSpans ?? []) {
        const serviceAttr = (rs.resource?.attributes ?? []).find((a: OtlpExportedAttribute) => a.key === "service.name");
        const serviceName = serviceAttr?.value?.stringValue ?? "unknown";
        for (const ss of rs.scopeSpans ?? []) {
          for (const rawSpan of ss.spans ?? []) {
            spans.push({
              serviceName,
              traceId: rawSpan.traceId,
              spanId: rawSpan.spanId,
              ...(rawSpan.parentSpanId ? { parentSpanId: rawSpan.parentSpanId } : {}),
              name: rawSpan.name,
              kind: rawSpan.kind,
              startTimeUnixNano: rawSpan.startTimeUnixNano,
              endTimeUnixNano: rawSpan.endTimeUnixNano,
              attributes: decodeAttributes(rawSpan.attributes),
              ...(rawSpan.links?.length
                ? {
                    links: rawSpan.links.map((link: OtlpExportedLink) => ({
                      traceId: link.traceId,
                      spanId: link.spanId,
                      attributes: decodeAttributes(link.attributes)
                    }))
                  }
                : {}),
              status: rawSpan.status
            });
          }
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    payloads,
    spans,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

function makeWorkflowInfo(overrides: Partial<WorkflowInfo> & Pick<WorkflowInfo, "workflowId" | "runId" | "workflowType">): WorkflowInfo {
  return {
    taskQueue: "space-default",
    namespace: "default",
    firstExecutionRunId: overrides.runId,
    originalExecutionRunId: overrides.runId,
    startTime: new Date(workflowState.nowMs),
    runStartTime: new Date(workflowState.nowMs),
    taskTimeoutMs: 10_000,
    attempt: 1,
    historyLength: 4,
    historySize: 512,
    continueAsNewSuggested: false,
    targetWorkerDeploymentVersionChanged: false,
    searchAttributes: {},
    typedSearchAttributes: {} as never,
    unsafe: { now: () => Date.now(), isReplaying: false },
    ...overrides
  };
}

/**
 * Runs a workflow body through the real workflow-observability-interceptors and
 * activity-observability-interceptors, supporting nested child workflows,
 * signals, concludeActivation, and activity retries.
 */
async function executeSimulatedWorkflow<T>(options: {
  info: WorkflowInfo;
  args: unknown[];
  headers?: Headers;
  spans: SpanExporter;
  run: (runtime: {
    scheduleActivity: <R>(
      activityType: string,
      activityArgs: unknown[],
      fn: (attempt: number, headers: Headers) => Promise<R>,
      maxAttempts?: number
    ) => Promise<R>;
    executeChild: <R>(
      childInfo: WorkflowInfo,
      childArgs: unknown[],
      fn: (childHeaders: Headers, childInterceptors: ReturnType<typeof createWorkflowInterceptors>) => Promise<R>
    ) => Promise<R>;
    deliverSignal: (signalName: string, signalArgs: unknown[], headers?: Headers) => Promise<void>;
    concludeActivation: () => void;
    continueAsNew: (nextArgs: unknown[], workflowType?: string) => Promise<{ headers: Headers; error: unknown }>;
  }) => Promise<T>;
}): Promise<T> {
  const previousInfo = workflowState.info;
  const previousSinks = workflowState.sinks;
  workflowState.info = options.info;
  workflowState.sinks = createWorkflowObservabilitySinks({ spans: options.spans });
  const wfInterceptors = createWorkflowInterceptors();
  const inbound = wfInterceptors.inbound![0]!;
  const outbound = wfInterceptors.outbound![0]!;
  const internals = wfInterceptors.internals![0]!;
  const actInterceptorFactory = createActivityObservabilityInterceptors({ spans: options.spans });

  const runtime = {
    async scheduleActivity<R>(
      activityType: string,
      activityArgs: unknown[],
      fn: (attempt: number, headers: Headers) => Promise<R>,
      maxAttempts = 1
    ): Promise<R> {
      const headers: Headers = {};
      return (await outbound.scheduleActivity!(
        {
          activityType,
          args: activityArgs,
          options: { startToCloseTimeout: "1 minute" },
          headers,
          seq: 1
        },
        async (actInput) => {
          let lastError: unknown;
          for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const actInterceptor = actInterceptorFactory({
              info: {
                activityType,
                activityId: `${attempt}`,
                attempt,
                workflowType: options.info.workflowType,
                workflowExecution: { workflowId: options.info.workflowId, runId: options.info.runId },
                currentAttemptScheduledTimestampMs: Date.now() - 5
              },
              cancellationSignal: new AbortController().signal
            } as never);
            try {
              return (await actInterceptor.inbound!.execute!(
                { args: actInput.args, headers: actInput.headers },
                async () => fn(attempt, actInput.headers)
              )) as R;
            } catch (err) {
              lastError = err;
              if (attempt === maxAttempts) throw err;
            }
          }
          throw lastError;
        }
      )) as R;
    },

    async executeChild<R>(
      childInfo: WorkflowInfo,
      childArgs: unknown[],
      fn: (childHeaders: Headers, childInterceptors: ReturnType<typeof createWorkflowInterceptors>) => Promise<R>
    ): Promise<R> {
      const childHeaders: Headers = {};
      const [, completed] = await outbound.startChildWorkflowExecution!(
        {
          workflowType: childInfo.workflowType,
          options: {
            workflowId: childInfo.workflowId,
            args: childArgs,
            taskQueue: childInfo.taskQueue,
            cancellationType: 0 as never,
            parentClosePolicy: 0 as never,
            workflowIdReusePolicy: 0 as never
          },
          headers: childHeaders,
          seq: 1
        },
        async (childInput) => {
          const savedInfo = workflowState.info;
          try {
            const result = await fn(childInput.headers, wfInterceptors);
            return [Promise.resolve(childInfo.runId), Promise.resolve(result)];
          } finally {
            workflowState.info = savedInfo;
          }
        }
      );
      return (await completed) as R;
    },

    async deliverSignal(signalName: string, signalArgs: unknown[], headers: Headers = {}): Promise<void> {
      await inbound.handleSignal!({ signalName, args: signalArgs, headers }, async () => undefined);
    },

    concludeActivation(): void {
      internals.concludeActivation!({ commands: [] }, (c) => c);
    },

    async continueAsNew(nextArgs: unknown[], workflowType = options.info.workflowType): Promise<{ headers: Headers; error: unknown }> {
      const headers: Headers = {};
      try {
        await outbound.continueAsNew!(
          {
            args: nextArgs,
            headers,
            options: { workflowType, taskQueue: options.info.taskQueue }
          },
          async () => {
            throw new ContinueAsNew({
              workflowType,
              arguments: [],
              headers,
              taskQueue: options.info.taskQueue
            });
          }
        );
        throw new Error("unreachable");
      } catch (error) {
        return { headers, error };
      }
    }
  };

  try {
    return (await inbound.execute!(
      { args: options.args, headers: options.headers ?? {} },
      async () => options.run(runtime)
    )) as T;
  } finally {
    workflowState.info = previousInfo;
    workflowState.sinks = previousSinks;
  }
}

const collectors: Array<{ close: () => Promise<void> }> = [];
const exporters: SpanExporter[] = [];

afterEach(async () => {
  await Promise.all(exporters.splice(0).map((e) => e.close()));
  await Promise.all(collectors.splice(0).map((c) => c.close()));
});

describe("End-to-end OTLP trace continuity across API, workflows, child workflows, and activities", () => {
  const secretPrompt = "PRIVATE PROMPT: summarize /home/operator/secret-plan.md using https://internal.example/api?token=sk-live-secret999";

  it("exports a single W3C trace tree from API HTTP request -> workflow -> retried & failed activities", async () => {
    const collector = await startFakeOtlpCollector();
    collectors.push(collector);

    const apiExporter = createOtlpSpanExporter({
      endpoint: collector.endpoint,
      serviceName: "space-api",
      flushIntervalMs: 60_000
    });
    const workerExporter = createOtlpSpanExporter({
      endpoint: collector.endpoint,
      serviceName: "space-worker",
      flushIntervalMs: 60_000
    });
    exporters.push(apiExporter, workerExporter);

    const { createHttpObservability } = await import("../../api/src/observability.js");
    const {
      requestTraceContexts,
      traceContextForRawRequest,
      withTurnTraceparent,
      workflowCorrelationMemo
    } = await import("../../api/src/trace-context.js");

    const httpObs = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
    const app = Fastify({ genReqId: () => "req:turn00000001" });
    app.addHook("onRequest", async (req) => {
      requestTraceContexts.remember(String(req.id), traceContextForRawRequest(req.raw));
      httpObs.onRequest(req);
    });
    app.addHook("onResponse", async (req, reply) => httpObs.onResponse(req, reply));

    let capturedTurnInput: DummyTurnInput | null = null;
    let capturedMemo: Record<string, string> = {};
    app.post("/api/rooms/:roomId/turns", async (req) => {
      const turn: DummyTurnInput = withTurnTraceparent({
        roomId: "room:alpha",
        paneId: "pane:alpha",
        prompt: secretPrompt,
        artifactIds: [],
        permissionMode: null,
        collaborationMode: "default",
        traceId: String(req.id),
        agentRunId: "agent_run:turn-1",
        dotId: "dot:researcher"
      });
      capturedTurnInput = turn;
      capturedMemo = workflowCorrelationMemo({ traceId: turn.traceId, traceparent: turn.traceparent ?? null });
      return { ok: true, traceId: turn.traceId };
    });

    const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const inboundCallerSpanId = "00f067aa0ba902b7";
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/rooms/room:alpha/turns?secret=sk-live-query",
        headers: { traceparent: `00-${inboundTraceId}-${inboundCallerSpanId}-01` }
      });
      expect(res.statusCode).toBe(200);
    } finally {
      await app.close();
      httpObs.close();
    }

    expect(capturedTurnInput).not.toBeNull();
    const wfInfo = makeWorkflowInfo({
      workflowId: "workflow:codex-app-server:room:alpha:pane:alpha:req:turn00000001",
      runId: "run:turn-wf-1",
      workflowType: "codexAppServerTurnWorkflow",
      memo: capturedMemo
    });

    await executeSimulatedWorkflow({
      info: wfInfo,
      args: [capturedTurnInput!],
      spans: workerExporter,
      run: async ({ scheduleActivity }) =>
        scheduleActivity(
          "runCodexAppServerTurn",
          [capturedTurnInput!],
          async (attempt) => {
            if (attempt === 1) {
              throw Object.assign(new Error(`transient failure for ${secretPrompt}`), {
                code: "UPSTREAM_RETRYABLE_UNAVAILABLE"
              });
            }
            noteActivityFailureReason("CODEX_APP_SERVER_TURN_TIMEOUT");
            return { status: "FAILED", reasonCode: "CODEX_APP_SERVER_TURN_TIMEOUT", message: secretPrompt };
          },
          2
        )
    });

    await apiExporter.flush();
    await workerExporter.flush();

    expect(collector.spans).toHaveLength(4);
    const apiSpan = collector.spans.find((s) => s.serviceName === "space-api" && s.name === "POST /api/rooms/:roomId/turns")!;
    const wfSpan = collector.spans.find((s) => s.serviceName === "space-worker" && s.name === "workflow codexAppServerTurnWorkflow")!;
    const attempt1Span = collector.spans.find((s) => s.name === "activity runCodexAppServerTurn" && s.attributes["space.attempt"] === 1)!;
    const attempt2Span = collector.spans.find((s) => s.name === "activity runCodexAppServerTurn" && s.attributes["space.attempt"] === 2)!;

    expect(apiSpan).toBeDefined();
    expect(wfSpan).toBeDefined();
    expect(attempt1Span).toBeDefined();
    expect(attempt2Span).toBeDefined();

    // All 4 spans belong to the exact same W3C trace.
    for (const s of [apiSpan, wfSpan, attempt1Span, attempt2Span]) {
      expect(s.traceId).toBe(inboundTraceId);
    }

    // Exact parent-child hierarchy: Inbound caller -> API request -> Workflow -> Activity attempts.
    expect(apiSpan.parentSpanId).toBe(inboundCallerSpanId);
    expect(wfSpan.parentSpanId).toBe(apiSpan.spanId);
    expect(attempt1Span.parentSpanId).toBe(wfSpan.spanId);
    expect(attempt2Span.parentSpanId).toBe(wfSpan.spanId);
    expect(attempt1Span.spanId).not.toBe(attempt2Span.spanId);

    // Correlation & failure categorization on workflow and activity spans.
    expect(wfSpan.attributes).toMatchObject({
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.workflow_id": wfInfo.workflowId,
      "space.run_id": wfInfo.runId,
      "space.trace_id": "req:turn00000001",
      "space.room_id": "room:alpha",
      "space.pane_id": "pane:alpha",
      "space.agent_run_id": "agent_run:turn-1",
      "space.dot_id": "dot:researcher",
      "space.outcome": "FAILED_RESULT",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT"
    });
    expect(wfSpan.status.code).toBe(2);

    expect(attempt1Span.attributes).toMatchObject({
      "space.activity_type": "runCodexAppServerTurn",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.trace_id": "req:turn00000001",
      "space.attempt": 1,
      "space.outcome": "FAILED",
      "space.reason_code": "UPSTREAM_RETRYABLE_UNAVAILABLE",
      "space.category": "UPSTREAM_UNAVAILABLE"
    });
    expect(attempt1Span.status.code).toBe(2);

    expect(attempt2Span.attributes).toMatchObject({
      "space.activity_type": "runCodexAppServerTurn",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.trace_id": "req:turn00000001",
      "space.attempt": 2,
      "space.outcome": "FAILED_RESULT",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT"
    });
    expect(attempt2Span.status.code).toBe(2);

    // Zero sensitive data anywhere in exported OTLP JSON payloads.
    const serialized = JSON.stringify(collector.payloads);
    expect(serialized).not.toMatch(/PRIVATE PROMPT|secret-plan|internal\.example|sk-live/);
  });

  it("links API request -> roomAgentSupervisorWorkflow -> child codexAppServerTurnWorkflow -> activities and links background continuations (trace:bg-<id>)", async () => {
    const collector = await startFakeOtlpCollector();
    collectors.push(collector);

    const workerExporter = createOtlpSpanExporter({
      endpoint: collector.endpoint,
      serviceName: "space-worker",
      flushIntervalMs: 60_000
    });
    exporters.push(workerExporter);

    const fixture = continuationFixture();
    const initialTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const apiSpanId = "a1b2c3d4e5f60718";
    const initialTraceparent = formatTraceparent(initialTraceId, apiSpanId, "01");

    // Enqueue initial mission turn with W3C traceparent from the API request.
    const initialTurn: DummyTurnInput = {
      ...fixture.initial.queueItem.turn,
      agentRunId: "agent_run:traced-1",
      traceparent: initialTraceparent,
      prompt: secretPrompt
    };
    const initialItem: RoomAgentSupervisorQueueItem = {
      missionId: fixture.initial.mission.id,
      turn: initialTurn
    };
    // Update the store's initial turn so prepareBackgroundContinuation reads the traced turn.
    fixture.store.enqueueRoomAgentMission({
      requestId: "room_agent_request:traced-1",
      clientRequestId: "traced-1",
      content: secretPrompt,
      supervisorWorkflowId: "room-supervisor:room:continuation",
      childWorkflowId: "workflow:codex-app-server:room:continuation:pane:agent:req:traced1",
      promptMessageId: "agent_msg:traced-user-1",
      responseMessageId: "agent_msg:traced-assistant-1",
      runId: "agent_run:traced-1",
      queueItem: {
        missionId: fixture.initial.mission.id,
        turn: {
          ...initialTurn,
          agentRunId: "agent_run:traced-1",
          agentUserMessageId: "agent_msg:traced-user-1",
          agentAssistantMessageId: "agent_msg:traced-assistant-1"
        }
      }
    }, initialTurn.traceId);
    fixture.store.updateSpaceAgentRun("agent_run:traced-1", { status: "COMPLETED" });

    const supervisorInfo = makeWorkflowInfo({
      workflowId: `room-supervisor:${fixture.room.id}`,
      runId: "run:supervisor-1",
      workflowType: "roomAgentSupervisorWorkflow",
      memo: {
        spaceTraceId: initialTurn.traceId,
        traceparent: initialTraceparent,
        w3cTraceId: initialTraceId,
        missionId: fixture.initial.mission.id
      }
    });

    const child1Info = makeWorkflowInfo({
      workflowId: `workflow:codex-app-server:${fixture.room.id}:${initialTurn.paneId}:${initialTurn.traceId}`,
      runId: "run:child-turn-1",
      workflowType: "codexAppServerTurnWorkflow",
      parent: { workflowId: supervisorInfo.workflowId, runId: supervisorInfo.runId, namespace: "default" }
    });

    let preparedContinuation: RoomAgentSupervisorQueueItem | null = null;

    await executeSimulatedWorkflow({
      info: supervisorInfo,
      args: [{ roomId: fixture.room.id, pending: [], monitoringMissionIds: [], interrupted: [], processedCount: 0 }],
      spans: workerExporter,
      run: async ({ deliverSignal, scheduleActivity, executeChild, concludeActivation }) => {
        // 1. Signal initial mission turn into supervisor.
        await deliverSignal("enqueueRoomAgentMission", [
          {
            missionId: fixture.initial.mission.id,
            turn: { ...initialTurn, agentRunId: "agent_run:traced-1" }
          }
        ]);

        // 2. Supervisor checks turn state, runs child codexAppServerTurnWorkflow, and enters monitoring.
        await scheduleActivity("checkRoomAgentSupervisorTurn", [initialItem], async () => "READY");
        await executeChild(
          child1Info,
          [{ ...initialTurn, agentRunId: "agent_run:traced-1" }],
          async (childHeaders) =>
            executeSimulatedWorkflow({
              info: child1Info,
              args: [{ ...initialTurn, agentRunId: "agent_run:traced-1" }],
              headers: childHeaders,
              spans: workerExporter,
              run: async (childRuntime) =>
                childRuntime.scheduleActivity(
                  "runCodexAppServerTurn",
                  [{ ...initialTurn, agentRunId: "agent_run:traced-1" }],
                  async () => ({
                    status: "COMPLETED" as const,
                    message: "Allocated panes",
                    roomAgentOutcome: {
                      status: "VERIFIED" as const,
                      executedActionCount: 1,
                      pendingActionIds: [fixture.action.actionId],
                      statusReason: "Background action running"
                    }
                  })
                )
            })
        );
        // Activation concludes while mission enters monitoring (flushes turn 1 supervisor span).
        concludeActivation();

        // 3. Supervisor polls prepareRoomAgentBackgroundContinuation.
        const prep = await scheduleActivity(
          "prepareRoomAgentBackgroundContinuation",
          [{ roomId: fixture.room.id, missionId: fixture.initial.mission.id, continuationId: "cont0001" }],
          async () => prepareBackgroundContinuation(
            { roomId: fixture.room.id, missionId: fixture.initial.mission.id, continuationId: "cont0001" },
            fixture.store
          )
        );
        if (prep.state !== "READY") throw new Error("Expected READY continuation");
        preparedContinuation = prep.item;

        // 4. Supervisor executes the prepared background continuation turn (trace:bg-cont0001).
        const child2Info = makeWorkflowInfo({
          workflowId: `workflow:codex-app-server:${fixture.room.id}:${prep.item.turn.paneId}:${prep.item.turn.traceId}`,
          runId: "run:child-turn-bg-1",
          workflowType: "codexAppServerTurnWorkflow",
          parent: { workflowId: supervisorInfo.workflowId, runId: supervisorInfo.runId, namespace: "default" }
        });

        await scheduleActivity("checkRoomAgentSupervisorTurn", [prep.item], async () => "READY");
        await executeChild(
          child2Info,
          [prep.item.turn],
          async (childHeaders) =>
            executeSimulatedWorkflow({
              info: child2Info,
              args: [prep.item.turn],
              headers: childHeaders,
              spans: workerExporter,
              run: async (childRuntime) =>
                childRuntime.scheduleActivity(
                  "runCodexAppServerTurn",
                  [prep.item.turn],
                  async () => ({
                    status: "COMPLETED" as const,
                    message: "Verified",
                    roomAgentOutcome: {
                      status: "VERIFIED" as const,
                      executedActionCount: 1,
                      statusReason: "All done"
                    }
                  })
                )
            })
        );
        await scheduleActivity(
          "finishRoomAgentSupervisorTurn",
          [{ item: prep.item, status: "COMPLETED", statusReason: "All done" }],
          async () => undefined
        );
      }
    });

    await workerExporter.flush();

    // Check initial mission turn hierarchy in initialTraceId:
    const trace1Spans = collector.spans.filter((s) => s.traceId === initialTraceId);
    const supSpan1 = trace1Spans.find((s) => s.name === "workflow roomAgentSupervisorWorkflow")!;
    const childWfSpan1 = trace1Spans.find((s) => s.name === "workflow codexAppServerTurnWorkflow")!;
    const checkSpan1 = trace1Spans.find((s) => s.name === "activity checkRoomAgentSupervisorTurn")!;
    const turnActSpan1 = trace1Spans.find((s) => s.name === "activity runCodexAppServerTurn")!;
    const prepSpan = trace1Spans.find((s) => s.name === "activity prepareRoomAgentBackgroundContinuation")!;

    expect(supSpan1).toBeDefined();
    expect(childWfSpan1).toBeDefined();
    expect(checkSpan1).toBeDefined();
    expect(turnActSpan1).toBeDefined();
    expect(prepSpan).toBeDefined();

    // API span -> Supervisor workflow span -> Child turn workflow span -> Turn activity span.
    expect(supSpan1.parentSpanId).toBe(apiSpanId);
    expect(checkSpan1.parentSpanId).toBe(supSpan1.spanId);
    expect(childWfSpan1.parentSpanId).toBe(supSpan1.spanId);
    expect(childWfSpan1.attributes["space.parent_workflow_id"]).toBe(supervisorInfo.workflowId);
    expect(turnActSpan1.parentSpanId).toBe(childWfSpan1.spanId);

    // Check background continuation trace (trace:bg-cont0001):
    expect(preparedContinuation).not.toBeNull();
    expect(preparedContinuation!.turn.traceId).toBe("trace:bg-cont0001");
    const bgW3cTraceId = parseTraceparent(preparedContinuation!.turn.traceparent)?.traceId;
    expect(bgW3cTraceId).toMatch(/^[0-9a-f]{32}$/);
    expect(bgW3cTraceId).not.toBe(initialTraceId);

    const bgSpans = collector.spans.filter((s) => s.traceId === bgW3cTraceId);
    const supSpanBg = bgSpans.find((s) => s.name === "workflow roomAgentSupervisorWorkflow")!;
    const childWfSpanBg = bgSpans.find((s) => s.name === "workflow codexAppServerTurnWorkflow")!;
    const turnActSpanBg = bgSpans.find((s) => s.name === "activity runCodexAppServerTurn")!;
    const finishSpanBg = bgSpans.find((s) => s.name === "activity finishRoomAgentSupervisorTurn")!;

    expect(supSpanBg).toBeDefined();
    expect(childWfSpanBg).toBeDefined();
    expect(turnActSpanBg).toBeDefined();
    expect(finishSpanBg).toBeDefined();

    expect(childWfSpanBg.parentSpanId).toBe(supSpanBg.spanId);
    expect(turnActSpanBg.parentSpanId).toBe(childWfSpanBg.spanId);
    expect(finishSpanBg.parentSpanId).toBe(supSpanBg.spanId);

    // Both supervisor and child workflow spans in the background continuation carry OTLP span links to the source trace!
    expect(supSpanBg.links).toEqual([
      {
        traceId: initialTraceId,
        spanId: apiSpanId,
        attributes: {
          "space.link_type": "background_continuation",
          "space.source_run_id": "agent_run:traced-1",
          "space.source_trace_id": initialTurn.traceId,
          "space.continuation_generation": 1
        }
      }
    ]);
    expect(supSpanBg.attributes).toMatchObject({
      "space.trace_id": "trace:bg-cont0001",
      "space.mission_id": fixture.initial.mission.id,
      "space.agent_run_id": "agent_run:bg-cont0001",
      "space.continuation_of_run_id": "agent_run:traced-1",
      "space.continuation_generation": 1
    });
  });

  it("propagates traceparent and OTLP span links across continueAsNew for long-running workflows (dotGoalWorkflow)", async () => {
    const collector = await startFakeOtlpCollector();
    collectors.push(collector);
    const workerExporter = createOtlpSpanExporter({
      endpoint: collector.endpoint,
      serviceName: "space-worker",
      flushIntervalMs: 60_000
    });
    exporters.push(workerExporter);

    const w3cTraceId = "11112222333344445555666677778888";
    const apiSpanId = "9999aaaabbbbcccc";
    const traceparent = formatTraceparent(w3cTraceId, apiSpanId, "01");
    const goalInput = { goalId: "dot_goal:goal12345", traceId: "req:goalcreate01", traceparent };

    const run1Info = makeWorkflowInfo({
      workflowId: "dot-goal:dot_goal:goal12345",
      runId: "run:goal-1",
      workflowType: "dotGoalWorkflow"
    });

    let continuedHeaders: Headers = {};
    await expect(
      executeSimulatedWorkflow({
        info: run1Info,
        args: [goalInput],
        spans: workerExporter,
        run: async ({ scheduleActivity, continueAsNew }) => {
          // Positional string arg (`dotGoalStep(goalId)`) receives traceparent via workflow outbound header!
          await scheduleActivity("dotGoalStep", [goalInput.goalId], async () => ({ state: "STARTED", runId: "agent_run:step1" }));
          const continued = await continueAsNew([goalInput]);
          continuedHeaders = continued.headers;
          throw continued.error;
        }
      })
    ).rejects.toBeInstanceOf(ContinueAsNew);

    const decodedCarry = decodeSpaceTraceHeader(continuedHeaders);
    expect(decodedCarry).toMatchObject({
      traceId: "req:goalcreate01",
      goalId: "dot_goal:goal12345",
      continuedFromRunId: "run:goal-1",
      continuedFromSpanId: deterministicSpanId(`workflow:${run1Info.workflowId}:${run1Info.runId}`)
    });

    // Run 2 starts after ContinueAsNew with the headers propagated by Temporal.
    const run2Info = makeWorkflowInfo({
      workflowId: "dot-goal:dot_goal:goal12345",
      runId: "run:goal-2",
      workflowType: "dotGoalWorkflow",
      continuedFromExecutionRunId: "run:goal-1"
    });

    await executeSimulatedWorkflow({
      info: run2Info,
      args: [goalInput],
      headers: continuedHeaders,
      spans: workerExporter,
      run: async ({ scheduleActivity }) => {
        await scheduleActivity("dotGoalObserve", [goalInput.goalId, "agent_run:step1"], async () => ({ goalStatus: "COMPLETED" }));
        return { goalStatus: "COMPLETED" };
      }
    });

    await workerExporter.flush();

    const run1WfSpan = collector.spans.find((s) => s.name === "workflow dotGoalWorkflow" && s.attributes["space.run_id"] === "run:goal-1")!;
    const stepActSpan = collector.spans.find((s) => s.name === "activity dotGoalStep")!;
    const run2WfSpan = collector.spans.find((s) => s.name === "workflow dotGoalWorkflow" && s.attributes["space.run_id"] === "run:goal-2")!;
    const observeActSpan = collector.spans.find((s) => s.name === "activity dotGoalObserve")!;

    expect(run1WfSpan.attributes["space.outcome"]).toBe("CONTINUED_AS_NEW");
    expect(run1WfSpan.status.code).toBe(0);
    expect(run1WfSpan.parentSpanId).toBe(apiSpanId);
    expect(stepActSpan.parentSpanId).toBe(run1WfSpan.spanId);
    expect(stepActSpan.attributes["space.goal_id"]).toBe("dot_goal:goal12345");

    expect(run2WfSpan.parentSpanId).toBe(apiSpanId);
    expect(run2WfSpan.attributes["space.continued_from_run_id"]).toBe("run:goal-1");
    expect(run2WfSpan.links).toEqual([
      {
        traceId: w3cTraceId,
        spanId: run1WfSpan.spanId,
        attributes: {
          "space.link_type": "continue_as_new",
          "space.source_run_id": "run:goal-1"
        }
      }
    ]);
    expect(observeActSpan.parentSpanId).toBe(run2WfSpan.spanId);
  });

  it("enforces the strict attribute allowlist and strips prompts, paths, URLs, error messages, and unknown keys", () => {
    const dirty = {
      "space.trace_id": "req:validtrace01",
      "space.workflow_id": "workflow:valid",
      "space.run_id": "run:valid",
      "space.room_id": "room:valid",
      "space.pane_id": "/home/operator/secret/file.ts",
      "space.mission_id": "https://evil.example/callback?secret=1",
      "space.agent_run_id": "sk-live-supersecretkey123456",
      "space.action_id": "has spaces and user text",
      "space.goal_id": "C:\\Users\\Admin\\secret.txt",
      "space.dot_id": "dot:valid",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 1,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "prompt": secretPrompt,
      "error.message": "Connection refused to 10.0.0.8",
      "http.url": "https://space.local/api/rooms?token=abc"
    };

    const sanitized = sanitizeSpanAttributes(dirty);
    expect(Object.keys(sanitized).every((k) => ALLOWED_SPAN_ATTRIBUTE_KEYS.includes(k))).toBe(true);
    expect(sanitized).toEqual({
      "space.trace_id": "req:validtrace01",
      "space.workflow_id": "workflow:valid",
      "space.run_id": "run:valid",
      "space.room_id": "room:valid",
      "space.dot_id": "dot:valid",
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 1,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT"
    });

    const wire = JSON.stringify(
      otlpTraceRequest(
        [
          {
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
            parentSpanId: null,
            name: "workflow codexAppServerTurnWorkflow",
            startTimeUnixNano: 1000n,
            endTimeUnixNano: 2000n,
            attributes: dirty as never,
            error: true,
            kind: 1,
            links: [
              {
                traceId: "11112222333344445555666677778888",
                spanId: "9999aaaabbbbcccc",
                attributes: {
                  "space.link_type": "background_continuation",
                  "space.source_run_id": "agent_run:1",
                  "prompt": secretPrompt
                } as never
              }
            ]
          }
        ],
        "space-worker"
      )
    );
    expect(wire).not.toMatch(/PRIVATE PROMPT|secret|evil\.example|sk-live|10\.0\.0\.8|space\.local/);
    expect(ALLOWED_SPAN_LINK_ATTRIBUTE_KEYS).toEqual([
      "space.link_type",
      "space.source_run_id",
      "space.source_trace_id",
      "space.continuation_generation"
    ]);
  });

  it("UNDETERMINISTIC REPLAY PROOF: sink callDuringReplay is false and workflow interceptor bundles cleanly in Temporal", async () => {
    const recorded: unknown[] = [];
    const spans: SpanExporter = {
      record: (span) => recorded.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: recorded.length, dropped: 0, failed: 0 })
    };
    const sinks = createWorkflowObservabilitySinks({ spans });
    expect(sinks.observability.recordWorkflowSpan.callDuringReplay).toBe(false);

    // Bundle workflow-observability-interceptors.ts + workflows.ts with Temporal's real WorkflowCodeBundler
    // to prove zero disallowed Node built-ins or non-deterministic imports enter the V8 isolate.
    const { bundleWorkflowCode } = await import("@temporalio/worker");
    const { existsSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const wfJs = fileURLToPath(new URL("../src/workflows.js", import.meta.url));
    const workflowsPath = existsSync(wfJs) ? wfJs : wfJs.replace(/\.js$/, ".ts");

    const bundle = await bundleWorkflowCode({
      workflowsPath,
      workflowInterceptorModules: [workflowObservabilityInterceptorsPath],
      logger: {
        trace: () => undefined,
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        log: () => undefined
      }
    });
    expect(bundle.code.length).toBeGreaterThan(1000);
  }, 60_000);
});
