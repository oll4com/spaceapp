import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client, Connection } from "@temporalio/client";
import { ApplicationFailure } from "@temporalio/common";
import { NativeConnection, Runtime, Worker } from "@temporalio/worker";
import { native as coreBridgeNative, type native as CoreBridgeTypes } from "@temporalio/core-bridge";
import { formatTraceparent } from "@space/contracts";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createOtlpWorkflowSinks } from "../src/otlp-workflow-sink.js";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { resolveWorkflowInterceptorsPath } from "../src/worker-otlp.js";
import { createOtlpWorkflowInboundInterceptor } from "../src/otlp-workflow-interceptors.js";
import { encodeTraceCarrierHeader, runIdToSpanId } from "../src/otlp-attributes.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";

interface ReceivedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: Record<string, string> }>;
  status: { code: number };
  links?: Array<{
    traceId: string;
    spanId: string;
    attributes?: Array<{ key: string; value: Record<string, string> }>;
  }>;
  serviceName?: string;
}

interface ReceivedTraceRequest {
  resourceSpans: Array<{
    resource?: { attributes?: Array<{ key: string; value: Record<string, string> }> };
    scopeSpans: Array<{
      scope?: { name?: string };
      spans: ReceivedSpan[];
    }>;
  }>;
}

function resolveWorkflowsPath(): string {
  const jsPath = fileURLToPath(new URL("../src/workflows.js", import.meta.url));
  const tsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
  return existsSync(jsPath) ? jsPath : tsPath;
}

function resolveMemoryMaintenanceWorkflowsPath(): string {
  const jsPath = fileURLToPath(new URL("../src/memory-maintenance-workflows.js", import.meta.url));
  const tsPath = fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url));
  return existsSync(jsPath) ? jsPath : tsPath;
}

describe("OTLP Spans Integration & Determinism Suite (Issue #61)", () => {
  let collectorServer: Server | null = null;
  let collectorEndpoint = "";
  let shouldFailCollector = false;
  const receivedSpans: ReceivedSpan[] = [];

  let ephemeralServer: CoreBridgeTypes.EphemeralServer | null = null;
  let nativeConnection: NativeConnection | null = null;
  let clientConnection: Connection | null = null;
  let workflowClient: Client;

  beforeAll(async () => {
    ephemeralServer = await Runtime.instance().createEphemeralServer({
      type: "time-skipping",
      exe: {
        type: "cached-download",
        downloadDir: null,
        version: "default",
        ttl: 0,
        sdkName: "sdk-typescript",
        sdkVersion: "1.24.0"
      },
      port: null,
      extraArgs: []
    });
    const address = coreBridgeNative.ephemeralServerGetTarget(ephemeralServer);
    nativeConnection = await NativeConnection.connect({ address });
    clientConnection = await Connection.connect({ address });
    workflowClient = new Client({ connection: clientConnection, namespace: "default" });

    await new Promise<void>((resolve) => {
      collectorServer = createServer((req, res) => {
        if (shouldFailCollector) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "collector_down" }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/traces") {
          const chunks: Buffer[] = [];
          req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
          req.on("end", () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReceivedTraceRequest;
              for (const resourceSpan of body.resourceSpans ?? []) {
                const serviceAttr = resourceSpan.resource?.attributes?.find((a) => a.key === "service.name");
                const serviceName = serviceAttr?.value?.stringValue;
                for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
                  for (const span of scopeSpan.spans ?? []) {
                    receivedSpans.push({ ...span, ...(serviceName ? { serviceName } : {}) });
                  }
                }
              }
              res.writeHead(200, { "content-type": "application/json" });
              res.end(JSON.stringify({ partialSuccess: {} }));
            } catch {
              res.writeHead(400);
              res.end();
            }
          });
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      collectorServer.listen(0, "127.0.0.1", () => {
        const addr = collectorServer!.address();
        if (addr && typeof addr === "object") {
          collectorEndpoint = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  }, 60_000);

  afterAll(async () => {
    if (collectorServer) {
      await new Promise((resolve) => collectorServer!.close(resolve));
    }
    await clientConnection?.close();
    await nativeConnection?.close();
    if (ephemeralServer) {
      await Runtime.instance().shutdownEphemeralServer(ephemeralServer);
    }
  });

  beforeEach(() => {
    receivedSpans.length = 0;
    shouldFailCollector = false;
  });

  it("exports a connected trace: API SERVER parent -> Workflow span -> Activity attempt spans, and emits 0 duplicate spans on replay", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const apiParentSpanId = "00f067aa0ba902b7";
    const inboundTraceparent = formatTraceparent(traceId, apiParentSpanId, "01");

    const apiExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-api",
      flushIntervalMs: 100
    });
    const workerExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-worker",
      flushIntervalMs: 100
    });

    const sinks = createOtlpWorkflowSinks(workerExporter);
    const interceptorPath = resolveWorkflowInterceptorsPath();
    const taskQueue = "test-otlp-queue-1";

    let startAttempts = 0;
    const worker = await Worker.create({
      connection: nativeConnection!,
      namespace: "default",
      taskQueue,
      workflowsPath: resolveWorkflowsPath(),
      activities: {
        recordDummyTurnStarted: async (input: unknown) => {
          if (++startAttempts === 1) {
            throw ApplicationFailure.retryable("transient error /secret/path", "UPSTREAM_RETRYABLE_UNAVAILABLE");
          }
          return { ok: true, input };
        },
        recordDummyTurnCompleted: async (input: unknown) => ({ status: "COMPLETED", input })
      },
      sinks,
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: workerExporter })],
        workflowModules: [interceptorPath]
      }
    });

    const workflowId = `workflow:test-dummy-turn-${Date.now()}`;
    const runPromise = worker.run();

    try {
      const apiStartNs = BigInt(Date.now()) * 1_000_000n;
      const handle = await workflowClient.workflow.start("dummyTurnWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            roomId: "room:alpha1",
            paneId: "pane:beta1",
            prompt: "synthetic test turn with secret sk-live-12345",
            traceId: "req:abcdef123456",
            traceparent: inboundTraceparent
          }
        ],
        memo: {
          w3cTraceId: traceId,
          traceparent: inboundTraceparent,
          spaceTraceId: "req:abcdef123456"
        }
      });

      apiExporter.record({
        traceId,
        spanId: apiParentSpanId,
        parentSpanId: null,
        name: "POST /api/rooms/:roomId/turns",
        kind: 2,
        startTimeUnixNano: apiStartNs,
        endTimeUnixNano: apiStartNs + 5_000_000n,
        attributes: {
          "http.request.method": "POST",
          "http.route": "/api/rooms/:roomId/turns",
          "http.response.status_code": 202,
          "space.request_id": "req:abcdef123456"
        },
        error: false
      });

      const result = await handle.result();
      expect(result).toMatchObject({ status: "COMPLETED" });

      await apiExporter.flush();
      await workerExporter.flush();

      const apiSpan = receivedSpans.find((s) => s.name === "POST /api/rooms/:roomId/turns");
      expect(apiSpan).toBeDefined();
      expect(apiSpan!.traceId).toBe(traceId);
      expect(apiSpan!.spanId).toBe(apiParentSpanId);
      expect(apiSpan!.kind).toBe(2); // SERVER

      const workflowSpan = receivedSpans.find((s) => s.name === "workflow dummyTurnWorkflow");
      expect(workflowSpan).toBeDefined();
      expect(workflowSpan!.traceId).toBe(traceId);
      expect(workflowSpan!.parentSpanId).toBe(apiSpan!.spanId);
      expect(workflowSpan!.kind).toBe(1); // INTERNAL

      const startedActivitySpans = receivedSpans.filter((s) => s.name === "activity recordDummyTurnStarted");
      expect(startedActivitySpans).toHaveLength(2);
      for (const span of startedActivitySpans) {
        expect(span.traceId).toBe(traceId);
        expect(span.parentSpanId).toBe(workflowSpan!.spanId);
        expect(span.kind).toBe(1);
      }

      const completedActivitySpan = receivedSpans.find((s) => s.name === "activity recordDummyTurnCompleted");
      expect(completedActivitySpan).toBeDefined();
      expect(completedActivitySpan!.traceId).toBe(traceId);
      expect(completedActivitySpan!.parentSpanId).toBe(workflowSpan!.spanId);
      expect(completedActivitySpan!.kind).toBe(1); // INTERNAL

      // Verify attributes contain only safe, allowlisted identifiers and no prompt/error strings
      const workflowAttrs = Object.fromEntries(
        workflowSpan!.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue])
      );
      expect(workflowSpan!.serviceName).toBe("space-worker");
      expect(workflowAttrs["temporal.workflow_type"]).toBe("dummyTurnWorkflow");
      expect(workflowAttrs["space.outcome"]).toBe("COMPLETED");
      expect(JSON.stringify(receivedSpans)).not.toContain("sk-live-12345");
      expect(JSON.stringify(receivedSpans)).not.toContain("/secret/path");

      // Check replay determinism: replaying execution history must emit 0 duplicate spans
      const history = await handle.fetchHistory();
      receivedSpans.length = 0;

      await Worker.runReplayHistories(
        {
          workflowsPath: resolveWorkflowsPath(),
          sinks,
          interceptors: {
            workflowModules: [interceptorPath]
          }
        },
        [history]
      );

      await workerExporter.flush();
      expect(receivedSpans).toHaveLength(0);
    } finally {
      worker.shutdown();
      await runPromise;
      await apiExporter.close();
      await workerExporter.close();
    }
  }, 45_000);

  it("nests child workflows under their parent workflow span and correlates cross-queue activities", async () => {
    const traceId = "c0ffeed00d1e57ac71ca1029384756ab";
    const apiParentSpanId = "1234567890abcdef";
    const inboundTraceparent = formatTraceparent(traceId, apiParentSpanId, "01");

    const maintenanceExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-memory-maintenance-worker",
      flushIntervalMs: 50
    });
    const mutationExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-memory-mutation-worker",
      flushIntervalMs: 50
    });

    const maintenanceSinks = createOtlpWorkflowSinks(maintenanceExporter);
    const interceptorPath = resolveWorkflowInterceptorsPath();

    const maintenanceWorker = await Worker.create({
      connection: nativeConnection!,
      namespace: "default",
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath: resolveMemoryMaintenanceWorkflowsPath(),
      activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "hash123", snapshotId: "snap1" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => ({ ok: true }),
        reconcileStaleSpaceAgentSessions: async () => ({ reconciled: 0 }),
        createScheduledMemoryAudit: async () => ({
          id: "audit1",
          workflowId: `workflow:child-consolidation-${Date.now()}`
        }),
        prepareMemoryConsolidation: async () => ({
          changeSetId: "changeset:1",
          run: { status: "COMPLETED" }
        }),
        finalizeMemoryRepair: async () => ({ status: "COMPLETED" })
      },
      sinks: maintenanceSinks,
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: maintenanceExporter })],
        workflowModules: [interceptorPath]
      }
    });

    const mutationWorker = await Worker.create({
      connection: nativeConnection!,
      namespace: "default",
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      activities: {
        executePersistedMemoryChangeSet: async () => ({ status: "APPLIED" })
      },
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: mutationExporter })]
      }
    });

    const workflowId = `workflow:test-maintenance-${Date.now()}`;
    const maintenanceRun = maintenanceWorker.run();
    const mutationRun = mutationWorker.run();

    try {
      const handle = await workflowClient.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
        workflowId,
        args: [{ roomId: "room:mem1", traceId: "req:mem123", force: false }],
        memo: {
          w3cTraceId: traceId,
          traceparent: inboundTraceparent
        }
      });

      await handle.result();
      await maintenanceExporter.flush();
      await mutationExporter.flush();

      const parentWorkflowSpan = receivedSpans.find((s) => s.name === "workflow memoryMaintenanceWorkflow");
      const childWorkflowSpan = receivedSpans.find((s) => s.name === "workflow memoryConsolidationWorkflow");
      const mutationActivitySpan = receivedSpans.find((s) => s.name === "activity executePersistedMemoryChangeSet");

      expect(parentWorkflowSpan).toBeDefined();
      expect(childWorkflowSpan).toBeDefined();
      expect(mutationActivitySpan).toBeDefined();

      expect(parentWorkflowSpan!.traceId).toBe(traceId);
      expect(parentWorkflowSpan!.parentSpanId).toBe(apiParentSpanId);

      // Child workflow span must be parented by parent workflow's span ID
      expect(childWorkflowSpan!.traceId).toBe(traceId);
      expect(childWorkflowSpan!.parentSpanId).toBe(parentWorkflowSpan!.spanId);

      // Cross-queue mutation activity span must be parented by the child workflow span
      expect(mutationActivitySpan!.traceId).toBe(traceId);
      expect(mutationActivitySpan!.parentSpanId).toBe(childWorkflowSpan!.spanId);
      expect(mutationActivitySpan!.serviceName).toBe("space-memory-mutation-worker");
    } finally {
      maintenanceWorker.shutdown();
      mutationWorker.shutdown();
      await Promise.all([maintenanceRun, mutationRun]);
      await maintenanceExporter.close();
      await mutationExporter.close();
    }
  }, 45_000);

  it("attaches OTLP span links for continue-as-new and room background continuations", async () => {
    const traceId = "11223344556677889900aabbccddeeff";
    const previousRunId = "a1b2c3d4-e5f6-7890-1234-567890abcdef";
    const prevSpanId = runIdToSpanId(previousRunId);

    const spanExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-worker",
      flushIntervalMs: 50
    });

    const sinks = createOtlpWorkflowSinks(spanExporter);

    const mockProxySinks = () =>
      ({
        otlpExport: {
          exportSpan: (payload: Parameters<typeof sinks.otlpExport.exportSpan.fn>[1]) =>
            sinks.otlpExport.exportSpan.fn({} as never, payload)
        }
      }) as never;

    // 1. Continue-as-new link test
    const continueAsNewInterceptor = createOtlpWorkflowInboundInterceptor({
      workflowInfo: () =>
        ({
          workflowType: "roomAgentSupervisorWorkflow",
          workflowId: "workflow:supervisor-1",
          runId: "bbbbbbbb-1111-2222-3333-444444444444",
          continuedFromExecutionRunId: previousRunId,
          memo: {
            traceparent: formatTraceparent(traceId, "0011223344556677", "01")
          }
        }) as never,
      proxySinks: mockProxySinks
    });

    await continueAsNewInterceptor.execute!({ args: [], headers: {} as never }, async () => "ok");
    await spanExporter.flush();

    const continueSpan = receivedSpans.find((s) => s.name === "workflow roomAgentSupervisorWorkflow");
    expect(continueSpan).toBeDefined();
    expect(continueSpan!.links).toBeDefined();
    expect(continueSpan!.links).toContainEqual(
      expect.objectContaining({
        traceId,
        spanId: prevSpanId,
        attributes: expect.arrayContaining([{ key: "link.reason", value: { stringValue: "continue_as_new" } }])
      })
    );

    // 2. Room background continuation link test
    receivedSpans.length = 0;
    const bgSourceRunId = "c1d2e3f4-5678-90ab-cdef-1234567890ab";
    const bgSourceSpanId = runIdToSpanId(bgSourceRunId);

    const bgInterceptor = createOtlpWorkflowInboundInterceptor({
      workflowInfo: () =>
        ({
          workflowType: "roomAgentSupervisorWorkflow",
          workflowId: "workflow:supervisor-2",
          runId: "cccccccc-1111-2222-3333-444444444444",
          memo: {
            traceparent: formatTraceparent(traceId, "0011223344556677", "01")
          }
        }) as never,
      proxySinks: mockProxySinks
    });

    const bgArg = {
      item: {
        turn: {
          roomAgentContinuation: {
            sourceRunId: bgSourceRunId,
            generation: 2
          }
        }
      }
    };

    await bgInterceptor.execute!({ args: [bgArg], headers: {} as never }, async () => "ok");
    await spanExporter.flush();

    const bgSpan = receivedSpans.find((s) => s.name === "workflow roomAgentSupervisorWorkflow");
    expect(bgSpan).toBeDefined();
    expect(bgSpan!.links).toBeDefined();
    expect(bgSpan!.links).toContainEqual(
      expect.objectContaining({
        traceId,
        spanId: bgSourceSpanId,
        attributes: expect.arrayContaining([
          { key: "link.reason", value: { stringValue: "room_background_continuation" } }
        ])
      })
    );

    // 3. Two child turn workflows started under a long-lived supervisor keep their own request traceparent
    receivedSpans.length = 0;
    const supervisorRunId = "dddddddd-0000-1111-2222-333333333333";
    const supervisorSpanId = runIdToSpanId(supervisorRunId);
    const req1TraceId = "aaaa1111bbbb2222cccc3333dddd4444";
    const req1ApiSpanId = "1111111111111111";
    const req2TraceId = "eeee5555ffff66660000777788889999";
    const req2ApiSpanId = "2222222222222222";
    const supervisorCarrierHeader = encodeTraceCarrierHeader({
      traceparent: formatTraceparent(req1TraceId, supervisorSpanId, "01"),
      w3cTraceId: req1TraceId,
      spaceTraceId: "req:turn-1"
    });

    const turn1Interceptor = createOtlpWorkflowInboundInterceptor({
      workflowInfo: () =>
        ({
          workflowType: "dummyTurnWorkflow",
          workflowId: "workflow:turn-1",
          runId: "eeeeeeee-1111-2222-3333-444444444444",
          parent: { workflowId: "workflow:supervisor", runId: supervisorRunId },
          memo: {}
        }) as never,
      proxySinks: mockProxySinks
    });
    await turn1Interceptor.execute!(
      {
        args: [{ traceId: "req:turn-1", traceparent: formatTraceparent(req1TraceId, req1ApiSpanId, "01") }],
        headers: { "x-space-otlp-trace": supervisorCarrierHeader } as never
      },
      async () => "ok"
    );

    const turn2Interceptor = createOtlpWorkflowInboundInterceptor({
      workflowInfo: () =>
        ({
          workflowType: "dummyTurnWorkflow",
          workflowId: "workflow:turn-2",
          runId: "ffffffff-1111-2222-3333-444444444444",
          parent: { workflowId: "workflow:supervisor", runId: supervisorRunId },
          memo: {}
        }) as never,
      proxySinks: mockProxySinks
    });
    await turn2Interceptor.execute!(
      {
        args: [{ traceId: "req:turn-2", traceparent: formatTraceparent(req2TraceId, req2ApiSpanId, "01") }],
        headers: { "x-space-otlp-trace": supervisorCarrierHeader } as never
      },
      async () => "ok"
    );
    await spanExporter.flush();

    const turnSpans = receivedSpans.filter((s) => s.name === "workflow dummyTurnWorkflow");
    expect(turnSpans).toHaveLength(2);
    expect(turnSpans[0].traceId).toBe(req1TraceId);
    expect(turnSpans[1].traceId).toBe(req2TraceId);
    expect(turnSpans[1].parentSpanId).toBe(req2ApiSpanId);

    await spanExporter.close();
  });

  it("does not delay or fail activity/workflow work when collector is failing", async () => {
    shouldFailCollector = true;

    const spanExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-worker",
      flushIntervalMs: 50,
      timeoutMs: 100
    });

    const sinks = createOtlpWorkflowSinks(spanExporter);
    const interceptorPath = resolveWorkflowInterceptorsPath();
    const taskQueue = "test-failing-collector-queue";

    const worker = await Worker.create({
      connection: nativeConnection!,
      namespace: "default",
      taskQueue,
      workflowsPath: resolveWorkflowsPath(),
      activities: {
        recordDummyTurnStarted: async () => ({ ok: true }),
        recordDummyTurnCompleted: async () => ({ status: "COMPLETED" })
      },
      sinks,
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: spanExporter })],
        workflowModules: [interceptorPath]
      }
    });

    const workflowId = `workflow:test-failing-collector-${Date.now()}`;
    const runPromise = worker.run();

    try {
      const handle = await workflowClient.workflow.start("dummyTurnWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            roomId: "room:1",
            paneId: "pane:1",
            prompt: "test turn with failing collector",
            traceId: "req:123",
            traceparent: formatTraceparent("4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7", "01")
          }
        ]
      });

      const result = await handle.result();
      expect(result).toMatchObject({ status: "COMPLETED" });

      await spanExporter.flush();
      expect(spanExporter.stats().failed).toBeGreaterThan(0);
    } finally {
      worker.shutdown();
      await runPromise;
      await spanExporter.close();
    }
  }, 45_000);
});
