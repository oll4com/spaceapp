import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { formatTraceparent } from "@space/contracts";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createOtlpWorkflowSinks } from "../src/otlp-workflow-sink.js";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { resolveWorkflowInterceptorsPath } from "../src/worker-otlp.js";
import { createOtlpWorkflowInboundInterceptor } from "../src/otlp-workflow-interceptors.js";
import { runIdToSpanId } from "../src/otlp-attributes.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";

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
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();

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
                for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
                  for (const span of scopeSpan.spans ?? []) {
                    receivedSpans.push(span);
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
    if (testEnv) {
      await testEnv.teardown();
    }
  });

  beforeEach(() => {
    receivedSpans.length = 0;
    shouldFailCollector = false;
  });

  it("exports a connected trace: API SERVER parent -> Workflow span -> Activity attempt spans", async () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const apiParentSpanId = "00f067aa0ba902b7";
    const inboundTraceparent = formatTraceparent(traceId, apiParentSpanId, "01");

    const spanExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-worker",
      flushIntervalMs: 100
    });

    const sinks = createOtlpWorkflowSinks(spanExporter);
    const interceptorPath = resolveWorkflowInterceptorsPath();
    const taskQueue = "test-otlp-queue-1";

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: "default",
      taskQueue,
      workflowsPath: resolveWorkflowsPath(),
      activities: {
        recordDummyTurnStarted: async (input: unknown) => ({ ok: true, input }),
        recordDummyTurnCompleted: async (input: unknown) => ({ status: "COMPLETED", input })
      },
      sinks,
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: spanExporter })],
        workflowModules: [interceptorPath]
      }
    });

    const workflowId = `workflow:test-dummy-turn-${Date.now()}`;
    const runPromise = worker.run();

    try {
      const handle = await testEnv.workflowClient.start("dummyTurnWorkflow", {
        taskQueue,
        workflowId,
        args: [
          {
            roomId: "room:alpha1",
            paneId: "pane:beta1",
            prompt: "synthetic test turn",
            traceId: "req:abcdef123456",
            traceparent: inboundTraceparent
          }
        ],
        memo: {
          w3cTraceId: traceId,
          traceparent: inboundTraceparent
        }
      });

      const result = await handle.result();
      expect(result).toMatchObject({ status: "COMPLETED" });

      // Flush exporter
      await spanExporter.flush();
      console.log("DEBUG: ENDPOINT:", collectorEndpoint, "STATS:", spanExporter.stats(), "RECEIVED:", receivedSpans.length);

      // Verify received spans
      expect(receivedSpans.length).toBeGreaterThanOrEqual(3);

      const workflowSpan = receivedSpans.find((s) => s.name === "workflow dummyTurnWorkflow");
      expect(workflowSpan).toBeDefined();
      expect(workflowSpan!.traceId).toBe(traceId);
      expect(workflowSpan!.parentSpanId).toBe(apiParentSpanId);
      expect(workflowSpan!.kind).toBe(1); // INTERNAL

      const startedActivitySpan = receivedSpans.find((s) => s.name === "activity recordDummyTurnStarted");
      expect(startedActivitySpan).toBeDefined();
      expect(startedActivitySpan!.traceId).toBe(traceId);
      expect(startedActivitySpan!.parentSpanId).toBe(workflowSpan!.spanId);
      expect(startedActivitySpan!.kind).toBe(1); // INTERNAL

      const completedActivitySpan = receivedSpans.find((s) => s.name === "activity recordDummyTurnCompleted");
      expect(completedActivitySpan).toBeDefined();
      expect(completedActivitySpan!.traceId).toBe(traceId);
      expect(completedActivitySpan!.parentSpanId).toBe(workflowSpan!.spanId);
      expect(completedActivitySpan!.kind).toBe(1); // INTERNAL

      // Verify attributes contain only safe, allowlisted identifiers
      const workflowAttrs = Object.fromEntries(workflowSpan!.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue]));
      expect(workflowAttrs["service.name"]).toBe("space-worker");
      expect(workflowAttrs["temporal.workflow_type"]).toBe("dummyTurnWorkflow");
      expect(workflowAttrs["space.outcome"]).toBe("COMPLETED");

      // Check replay determinism: replaying execution history must emit 0 spans
      const history = await handle.fetchHistory();
      receivedSpans.length = 0;

      await Worker.runReplayHistories(
        {
          sinks,
          interceptors: {
            workflowModules: [interceptorPath]
          }
        },
        [history]
      );

      await spanExporter.flush();
      expect(receivedSpans).toHaveLength(0);
    } finally {
      worker.shutdown();
      await runPromise;
      await spanExporter.close();
    }
  }, 45_000);

  it("nests child workflows under their parent workflow span", async () => {
    const traceId = "c0ffeed00d1e57ac71ca1029384756ab";
    const apiParentSpanId = "1234567890abcdef";
    const inboundTraceparent = formatTraceparent(traceId, apiParentSpanId, "01");

    const spanExporter: SpanExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-memory-maintenance-worker",
      flushIntervalMs: 50
    });

    const sinks = createOtlpWorkflowSinks(spanExporter);
    const interceptorPath = resolveWorkflowInterceptorsPath();
    const taskQueue = MEMORY_MAINTENANCE_TASK_QUEUE;

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: "default",
      taskQueue,
      workflowsPath: resolveMemoryMaintenanceWorkflowsPath(),
      activities: {
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "hash123", snapshotId: "snap1" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => ({ ok: true }),
        reconcileStaleSpaceAgentSessions: async () => ({ reconciled: 0 }),
        createScheduledMemoryAudit: async () => ({ id: "audit1", workflowId: `workflow:child-consolidation-${Date.now()}` }),
        prepareMemoryConsolidation: async () => ({ changeSetId: null, run: { status: "COMPLETED" } }),
        executePersistedMemoryChangeSet: async () => ({ applied: true })
      },
      sinks,
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: spanExporter })],
        workflowModules: [interceptorPath]
      }
    });

    const workflowId = `workflow:test-maintenance-${Date.now()}`;
    const runPromise = worker.run();

    try {
      const handle = await testEnv.workflowClient.start("memoryMaintenanceWorkflow", {
        taskQueue,
        workflowId,
        args: [{ roomId: "room:mem1", traceId: "req:mem123", force: false }],
        memo: {
          w3cTraceId: traceId,
          traceparent: inboundTraceparent
        }
      });

      await handle.result();
      await spanExporter.flush();

      const parentWorkflowSpan = receivedSpans.find((s) => s.name === "workflow memoryMaintenanceWorkflow");
      const childWorkflowSpan = receivedSpans.find((s) => s.name === "workflow memoryConsolidationWorkflow");

      expect(parentWorkflowSpan).toBeDefined();
      expect(childWorkflowSpan).toBeDefined();

      expect(parentWorkflowSpan!.traceId).toBe(traceId);
      expect(parentWorkflowSpan!.parentSpanId).toBe(apiParentSpanId);

      // Child workflow span must be parented by parent workflow's span ID
      expect(childWorkflowSpan!.traceId).toBe(traceId);
      expect(childWorkflowSpan!.parentSpanId).toBe(parentWorkflowSpan!.spanId);
    } finally {
      worker.shutdown();
      await runPromise;
      await spanExporter.close();
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
          exportSpan: (payload: any) => sinks.otlpExport.exportSpan.fn({} as any, payload)
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
        attributes: expect.arrayContaining([{ key: "link.reason", value: { stringValue: "room_background_continuation" } }])
      })
    );

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
      connection: testEnv.nativeConnection,
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
      const handle = await testEnv.workflowClient.start("dummyTurnWorkflow", {
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

      // Workflow and activities must complete without error despite collector 500
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
