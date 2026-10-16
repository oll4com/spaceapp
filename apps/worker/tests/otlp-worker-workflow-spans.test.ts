import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import {
  ALLOWED_SPAN_ATTRIBUTE_KEYS,
  deterministicSpanId,
  deterministicTraceId,
  formatTraceparent,
   ROOM_AGENT_ENQUEUE_SIGNAL,
  sanitizeSpanAttributes,
  workflowExecutionSpanId,
  type DummyTurnInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { createOtlpSpanExporter, otlpSpanExporterFromEnv } from "@space/runtime";
import { continuationFixture } from "./room-continuation-fixture.js";
import { prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import {
  createWorkerObservability,
  resolveWorkflowObservabilityModulePath,
  WorkflowTraceRegistry
} from "../src/worker-observability.js";
import { noteActivityFailureReason } from "../src/activity-observability.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";

interface ExportedOtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface ExportedOtlpLink {
  traceId: string;
  spanId: string;
  attributes?: ExportedOtlpAttribute[];
}

interface ExportedOtlpSpan {
  serviceName: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Record<string, string | number>;
  rawAttributeKeys: string[];
  links: Array<{
    traceId: string;
    spanId: string;
    attributes: Record<string, string | number>;
  }>;
  status: { code: number };
}

function decodeAttributes(attrs: ExportedOtlpAttribute[] | undefined): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const attr of attrs ?? []) {
    if (attr.value.stringValue !== undefined) {
      out[attr.key] = attr.value.stringValue;
    } else if (attr.value.intValue !== undefined) {
      out[attr.key] = Number(attr.value.intValue);
    }
  }
  return out;
}

async function startFakeOtlpCollector() {
  const rawPayloads: string[] = [];
  const spans: ExportedOtlpSpan[] = [];
  const paths: string[] = [];

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    paths.push(req.url ?? "");
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      rawPayloads.push(body);
      try {
        const parsed = JSON.parse(body) as {
          resourceSpans?: Array<{
            resource?: { attributes?: ExportedOtlpAttribute[] };
            scopeSpans?: Array<{
              spans?: Array<{
                traceId: string;
                spanId: string;
                parentSpanId?: string;
                name: string;
                kind: number;
                startTimeUnixNano: string;
                endTimeUnixNano: string;
                attributes?: ExportedOtlpAttribute[];
                links?: ExportedOtlpLink[];
                status: { code: number };
              }>;
            }>;
          }>;
        };
        for (const rs of parsed.resourceSpans ?? []) {
          const resourceAttrs = decodeAttributes(rs.resource?.attributes);
          const serviceName = String(resourceAttrs["service.name"] ?? "");
          for (const ss of rs.scopeSpans ?? []) {
            for (const s of ss.spans ?? []) {
              spans.push({
                serviceName,
                traceId: s.traceId,
                spanId: s.spanId,
                parentSpanId: s.parentSpanId ?? "",
                name: s.name,
                kind: s.kind,
                startTimeUnixNano: s.startTimeUnixNano,
                endTimeUnixNano: s.endTimeUnixNano,
                attributes: decodeAttributes(s.attributes),
                rawAttributeKeys: (s.attributes ?? []).map((a) => a.key),
                links: (s.links ?? []).map((link) => ({
                  traceId: link.traceId,
                  spanId: link.spanId,
                  attributes: decodeAttributes(link.attributes)
                })),
                status: s.status
              });
            }
          }
        }
      } catch {
        // Ignore malformed test payloads.
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    spans,
    rawPayloads,
    paths,
    clear() {
      spans.length = 0;
      rawPayloads.length = 0;
      paths.length = 0;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

describe("worker OTLP span configuration and allowlist", () => {
  it("is disabled by default across all three worker entrypoints and exports to <endpoint>/v1/traces when configured", async () => {
    const collector = await startFakeOtlpCollector();
    try {
      for (const serviceName of [
        "space-worker",
        "space-memory-maintenance-worker",
        "space-memory-mutation-worker"
      ]) {
        const disabled = createWorkerObservability({ env: {}, serviceName });
        expect(disabled.spanExporter).toBeNull();
        await disabled.flush();
        await disabled.close();
      }
      expect(collector.paths).toEqual([]);

      for (const serviceName of [
        "space-worker",
        "space-memory-maintenance-worker",
        "space-memory-mutation-worker"
      ]) {
        const enabled = createWorkerObservability({
          env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: `${collector.endpoint}/` },
          serviceName
        });
        expect(enabled.spanExporter).not.toBeNull();
        enabled.spanExporter!.record({
          traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
          spanId: deterministicSpanId(serviceName),
          parentSpanId: "00f067aa0ba902b7",
          name: `${serviceName}.probe`,
          startTimeUnixNano: 1_000_000n,
          endTimeUnixNano: 2_000_000n,
          attributes: {
            "space.trace_id": "req:probe0000001",
            "space.outcome": "COMPLETED",
            "space.duration_ms": 1
          },
          error: false
        });
        await enabled.close();
      }

      expect(collector.paths).toEqual(["/v1/traces", "/v1/traces", "/v1/traces"]);
      expect(collector.spans.map((s) => s.serviceName)).toEqual([
        "space-worker",
        "space-memory-maintenance-worker",
        "space-memory-mutation-worker"
      ]);
    } finally {
      await collector.close();
    }
  });

  it("wires createWorkerObservability into worker.ts, memory-maintenance-worker.ts and memory-mutation-worker.ts", () => {
    for (const relPath of [
      "../src/worker.ts",
      "../src/memory-maintenance-worker.ts",
      "../src/memory-mutation-worker.ts"
    ]) {
      const source = readFileSync(fileURLToPath(new URL(relPath, import.meta.url)), "utf8");
      expect(source).toContain("createWorkerObservability");
      expect(source).toContain("...observability.workerOptions");
      expect(source).toContain("await observability.close()");
    }
  });

  it("enforces the span attribute allowlist and strips prompts, model output, paths, URLs and error messages", async () => {
    const collector = await startFakeOtlpCollector();
    try {
      const secretPrompt = "PROMPT_SECRET_DO_NOT_EXPORT sk-live-999999";
      const secretOutput = "MODEL_OUTPUT_SECRET_DO_NOT_EXPORT";
      const secretPath = "/var/lib/spaceapp/private/secret.txt";
      const secretUrl = "https://internal.example.test/api?token=secret-token";
      const secretError = "Database connection failed for user postgres with password supersecret";

      const sanitized = sanitizeSpanAttributes({
        "space.trace_id": "req:allowlist001",
        "space.workflow_id": "workflow:codex-app-server:room:a:pane:a:req:allowlist001",
        "space.run_id": "run-uuid-allowlist",
        "space.room_id": "room:alpha01",
        "space.pane_id": "pane:alpha01",
        "space.mission_id": "mission:alpha01",
        "space.workflow_type": "codexAppServerTurnWorkflow",
        "space.activity_type": "runCodexAppServerTurn",
        "space.attempt": 2,
        "space.status": "FAILED",
        "space.outcome": "FAILED",
        "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
        "space.category": "TIMEOUT",
        "space.duration_ms": 42,
        // Disallowed keys and unsafe values must all be dropped:
        "space.prompt": secretPrompt,
        "space.output": secretOutput,
        "space.file_path": secretPath,
        "space.url": secretUrl,
        "space.error_message": secretError,
        "http.route": secretPath,
        "space.room_id_with_path": secretPath,
        "space.action_id": secretUrl
      });

      expect(sanitized).toEqual({
        "space.trace_id": "req:allowlist001",
        "space.workflow_id": "workflow:codex-app-server:room:a:pane:a:req:allowlist001",
        "space.run_id": "run-uuid-allowlist",
        "space.room_id": "room:alpha01",
        "space.pane_id": "pane:alpha01",
        "space.mission_id": "mission:alpha01",
        "space.workflow_type": "codexAppServerTurnWorkflow",
        "space.activity_type": "runCodexAppServerTurn",
        "space.attempt": 2,
        "space.status": "FAILED",
        "space.outcome": "FAILED",
        "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
        "space.category": "TIMEOUT",
        "space.duration_ms": 42
      });

      const exporter = otlpSpanExporterFromEnv(
        { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
        "space-worker"
      )!;
      exporter.record({
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        parentSpanId: null,
        name: "runCodexAppServerTurn",
        startTimeUnixNano: 100n,
        endTimeUnixNano: 200n,
        attributes: {
          ...sanitized,
          // Even if a caller passes an unallowlisted key directly to exporter.record, the exporter filters it out:
          "prompt": secretPrompt,
          "error.message": secretError,
          "file.path": secretPath
        } as Record<string, string | number>,
        error: true
      });
      await exporter.close();

      expect(collector.spans).toHaveLength(1);
      for (const key of collector.spans[0]!.rawAttributeKeys) {
        expect(ALLOWED_SPAN_ATTRIBUTE_KEYS.has(key)).toBe(true);
      }
      const dumped = collector.rawPayloads.join("\n");
      expect(dumped).not.toContain(secretPrompt);
      expect(dumped).not.toContain(secretOutput);
      expect(dumped).not.toContain(secretPath);
      expect(dumped).not.toContain(secretUrl);
      expect(dumped).not.toContain(secretError);
    } finally {
      await collector.close();
    }
  });

  it("prepares background continuations with a fresh trace:bg-<id> and source trace linkage", async () => {
    const fixture = continuationFixture();
    const sourceRunId = fixture.initial.run.runId;
    const sourceTraceId = fixture.initial.queueItem.turn.traceId!;

    const prepared = await prepareBackgroundContinuation(
      { roomId: fixture.room.id, missionId: fixture.initial.mission.id, continuationId: "cont-001" },
      fixture.store
    );
    expect(prepared.state).toBe("READY");
    if (prepared.state !== "READY") throw new Error("Expected READY continuation");

    expect(prepared.item.turn.traceId).toBe("trace:bg-cont-001");
    expect(prepared.item.turn.traceparent).toBe(
      formatTraceparent(deterministicTraceId("trace:bg-cont-001"), deterministicSpanId("bg:cont-001"))
    );
    expect(prepared.item.turn.roomAgentContinuation).toEqual({
      sourceRunId,
      generation: 1,
      sourceTraceId,
      sourceTraceparent: formatTraceparent(
        deterministicTraceId(sourceTraceId),
        deterministicSpanId(sourceRunId)
      )
    });
  });
});

describe("end-to-end OTLP trace continuity across API, Temporal workflows and activities", () => {
  let testEnv: TestWorkflowEnvironment;
  let collector: Awaited<ReturnType<typeof startFakeOtlpCollector>>;
  let mainWorkflowBundle: WorkflowBundleWithSourceMap;
  let memoryWorkflowBundle: WorkflowBundleWithSourceMap;

  beforeAll(async () => {
    collector = await startFakeOtlpCollector();
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
    const interceptorModule = resolveWorkflowObservabilityModulePath();
    [mainWorkflowBundle, memoryWorkflowBundle] = await Promise.all([
      bundleWorkflowCode({
        workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
        workflowInterceptorModules: [interceptorModule]
      }),
      bundleWorkflowCode({
        workflowsPath: fileURLToPath(new URL("../src/memory-maintenance-workflows.ts", import.meta.url)),
        workflowInterceptorModules: [interceptorModule]
      })
    ]);
  }, 120_000);

  afterAll(async () => {
    await testEnv?.teardown();
    await collector?.close();
  });

  it("connects the API SERVER span -> codexAppServerTurnWorkflow -> retried activity attempts in one trace, and emits 0 spans on history replay", async () => {
    collector.clear();
    const apiExporter = createOtlpSpanExporter({
      endpoint: collector.endpoint,
      serviceName: "space-api"
    });
    const traceRegistry = new WorkflowTraceRegistry();
    const workerObs = createWorkerObservability({
      env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
      serviceName: "space-worker",
      traceRegistry
    });

    const spaceTraceId = "req:turn00000001";
    const w3cTraceId = deterministicTraceId(spaceTraceId);
    const apiSpanId = deterministicSpanId(`${spaceTraceId}:http`);
    const traceparent = formatTraceparent(w3cTraceId, apiSpanId);
    const secretPrompt = "PRIVATE USER PROMPT: leak nothing sk-secret-12345";
    const secretErrorDetail = " internal stack /home/user/secret.key";

    let attempts = 0;
    const taskQueue = "test-otlp-turn-queue";
    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle: mainWorkflowBundle,
      activities: {
        async runCodexAppServerTurn(_input: DummyTurnInput) {
          attempts += 1;
          if (attempts === 1) {
            throw Object.assign(new Error(`Codex timed out:${secretErrorDetail}`), {
              code: "CODEX_APP_SERVER_TURN_TIMEOUT"
            });
          }
          return {
            status: "COMPLETED" as const,
            message: `MODEL SECRET RESPONSE ${secretPrompt}`
          };
        }
      },
      ...workerObs.workerOptions
    });

    apiExporter.record({
      traceId: w3cTraceId,
      spanId: apiSpanId,
      parentSpanId: null,
      name: "POST /api/rooms/:id/turns",
      kind: 2,
      startTimeUnixNano: 1_000_000n,
      endTimeUnixNano: 2_000_000n,
      attributes: {
        "http.request.method": "POST",
        "http.route": "/api/rooms/:id/turns",
        "http.response.status_code": 202,
        "space.request_id": spaceTraceId,
        "space.trace_id": spaceTraceId
      },
      error: false
    });

    const workflowId = "workflow:codex-app-server:room:r1:pane:p1:req:turn00000001";
    const turnInput: DummyTurnInput = {
      roomId: "room:r1",
      paneId: "pane:p1",
      prompt: secretPrompt,
      artifactIds: [],
      agentRunId: "agent_run:turn1",
      agentSessionId: "agent_session:turn1",
      permissionMode: null,
      collaborationMode: "default",
      traceId: spaceTraceId,
      traceparent
    };

    const handle = await worker.runUntil(async () => {
      const h = await testEnv.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue,
        workflowId,
        args: [turnInput],
        memo: {
          spaceTraceId,
          traceparent,
          w3cTraceId
        }
      });
      await h.result();
      return h;
    });

    const history = await handle.fetchHistory();
    await apiExporter.close();
    await workerObs.close();

    const traceSpans = collector.spans.filter((s) => s.traceId === w3cTraceId);
    expect(traceSpans).toHaveLength(4);

    const apiSpan = traceSpans.find((s) => s.serviceName === "space-api" && s.name === "POST /api/rooms/:id/turns");
    const wfSpan = traceSpans.find((s) => s.serviceName === "space-worker" && s.name === "codexAppServerTurnWorkflow");
    const actAttempt1 = traceSpans.find(
      (s) => s.name === "runCodexAppServerTurn" && s.attributes["space.attempt"] === 1
    );
    const actAttempt2 = traceSpans.find(
      (s) => s.name === "runCodexAppServerTurn" && s.attributes["space.attempt"] === 2
    );

    expect(apiSpan).toBeDefined();
    expect(wfSpan).toBeDefined();
    expect(actAttempt1).toBeDefined();
    expect(actAttempt2).toBeDefined();

    // Parent/child hierarchy: API SERVER span -> workflow span -> each activity attempt span
    expect(apiSpan!.parentSpanId).toBe("");
    expect(wfSpan!.parentSpanId).toBe(apiSpan!.spanId);
    expect(wfSpan!.spanId).toBe(workflowExecutionSpanId(workflowId, handle.firstExecutionRunId));
    expect(wfSpan!.attributes).toMatchObject({
      "space.trace_id": spaceTraceId,
      "space.workflow_type": "codexAppServerTurnWorkflow",
      "space.workflow_id": workflowId,
      "space.run_id": handle.firstExecutionRunId,
      "space.room_id": "room:r1",
      "space.pane_id": "pane:p1",
      "space.agent_run_id": "agent_run:turn1",
      "space.agent_session_id": "agent_session:turn1",
      "space.outcome": "COMPLETED"
    });

    expect(actAttempt1!.parentSpanId).toBe(wfSpan!.spanId);
    expect(actAttempt1!.status.code).toBe(2);
    expect(actAttempt1!.attributes).toMatchObject({
      "space.trace_id": spaceTraceId,
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 1,
      "space.outcome": "FAILED",
      "space.reason_code": "CODEX_APP_SERVER_TURN_TIMEOUT",
      "space.category": "TIMEOUT",
      "space.room_id": "room:r1",
      "space.pane_id": "pane:p1"
    });

    expect(actAttempt2!.parentSpanId).toBe(wfSpan!.spanId);
    expect(actAttempt2!.status.code).toBe(0);
    expect(actAttempt2!.attributes).toMatchObject({
      "space.trace_id": spaceTraceId,
      "space.activity_type": "runCodexAppServerTurn",
      "space.attempt": 2,
      "space.outcome": "COMPLETED"
    });

    // No prompts, model outputs or error messages ever leave in OTLP payloads
    const allPayloads = collector.rawPayloads.join("\n");
    expect(allPayloads).not.toContain("PRIVATE USER PROMPT");
    expect(allPayloads).not.toContain("sk-secret-12345");
    expect(allPayloads).not.toContain("secret.key");
    expect(allPayloads).not.toContain("MODEL SECRET RESPONSE");

    // Replay proof: replaying the workflow history emits 0 spans and does not violate determinism
    collector.clear();
    const replayObs = createWorkerObservability({
      env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
      serviceName: "space-worker",
      traceRegistry: new WorkflowTraceRegistry()
    });
    await Worker.runReplayHistory(
      {
        workflowBundle: mainWorkflowBundle,
        ...replayObs.workerOptions
      },
      history,
      workflowId
    );
    await replayObs.close();
    expect(collector.spans).toEqual([]);
  }, 60_000);

  it("nests child workflows (memoryMaintenanceWorkflow -> memoryConsolidationWorkflow) and cross-worker activities under the same trace", async () => {
    collector.clear();
    const traceRegistry = new WorkflowTraceRegistry();
    const maintenanceObs = createWorkerObservability({
      env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
      serviceName: "space-memory-maintenance-worker",
      traceRegistry
    });
    const mutationObs = createWorkerObservability({
      env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
      serviceName: "space-memory-mutation-worker",
      traceRegistry
    });

    const spaceTraceId = "req:memory000001";
    const w3cTraceId = deterministicTraceId(spaceTraceId);
    const apiSpanId = deterministicSpanId(`${spaceTraceId}:api`);
    const traceparent = formatTraceparent(w3cTraceId, apiSpanId);

    const maintenanceWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowBundle: memoryWorkflowBundle,
      activities: {
        async refreshMemoryGraphSnapshot() {
          return {
            generatedAt: "2026-07-13T00:00:00.000Z",
            sourceHash: "hash:mem1",
            nodeCount: 3,
            edgeCount: 2,
            findingCount: 1
          };
        },
        async refreshAllMonthsMemoryGraphSnapshot() {
          return { refreshedMonths: 1 };
        },
        async reconcileStaleSpaceAgentSessions() {
          return { reconciledCount: 0 };
        },
        async createScheduledMemoryAudit() {
          return {
            id: "mem_run:1",
            workflowId: "workflow:memory-consolidation:mem_run:1"
          };
        },
        async prepareMemoryConsolidation() {
          return {
            changeSetId: "change_set:mem1",
            run: {
              id: "mem_run:1",
              mode: "REPAIR",
              status: "RUNNING"
            }
          };
        },
        async finalizeMemoryRepair() {
          return {
            id: "mem_run:1",
            mode: "REPAIR",
            status: "COMPLETED"
          };
        }
      },
      ...maintenanceObs.workerOptions
    });

    const mutationWorker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      activities: {
        async executePersistedMemoryChangeSet() {
          return {
            changeSetId: "change_set:mem1",
            status: "APPLIED" as const,
            revisionId: "rev:mem1"
          };
        }
      },
      ...mutationObs.workerOptions
    });

    await maintenanceWorker.runUntil(async () =>
      mutationWorker.runUntil(async () => {
        const handle = await testEnv.client.workflow.start("memoryMaintenanceWorkflow", {
          taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
          workflowId: "workflow:memory-maintenance:req:memory000001",
          args: [
            {
              triggerKind: "SCHEDULED",
              actorUserId: null,
              traceId: spaceTraceId,
              traceparent
            }
          ],
          memo: {
            spaceTraceId,
            traceparent,
            w3cTraceId
          }
        });
        await handle.result();
      })
    );

    await maintenanceObs.close();
    await mutationObs.close();

    const traceSpans = collector.spans.filter((s) => s.traceId === w3cTraceId);
    const parentWf = traceSpans.find((s) => s.name === "memoryMaintenanceWorkflow");
    const childWf = traceSpans.find((s) => s.name === "memoryConsolidationWorkflow");
    const prepareAct = traceSpans.find((s) => s.name === "prepareMemoryConsolidation");
    const mutateAct = traceSpans.find((s) => s.name === "executePersistedMemoryChangeSet");
    const finalizeAct = traceSpans.find((s) => s.name === "finalizeMemoryRepair");

    expect(parentWf).toBeDefined();
    expect(childWf).toBeDefined();
    expect(prepareAct).toBeDefined();
    expect(mutateAct).toBeDefined();
    expect(finalizeAct).toBeDefined();

    // Parent workflow -> child workflow -> child workflow's activities
    expect(parentWf!.parentSpanId).toBe(apiSpanId);
    expect(childWf!.parentSpanId).toBe(parentWf!.spanId);
    expect(childWf!.attributes["space.parent_workflow_id"]).toBe("workflow:memory-maintenance:req:memory000001");
    expect(prepareAct!.parentSpanId).toBe(childWf!.spanId);
    expect(mutateAct!.parentSpanId).toBe(childWf!.spanId);
    expect(mutateAct!.serviceName).toBe("space-memory-mutation-worker");
    expect(finalizeAct!.parentSpanId).toBe(childWf!.spanId);
  }, 60_000);

  it("attaches OTLP span links for continue-as-new runs (dotGoalWorkflow) and background continuations (roomAgentSupervisorWorkflow)", async () => {
    collector.clear();
    const traceRegistry = new WorkflowTraceRegistry();
    const workerObs = createWorkerObservability({
      env: { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint },
      serviceName: "space-worker",
      traceRegistry
    });

    const taskQueue = "test-otlp-links-queue";
    let dotGoalCalls = 0;
    let supervisorTurns = 0;
    let finishedSupervisorTurns = 0;

    const initialSpaceTraceId = "req:mission00001";
    const initialW3cTraceId = deterministicTraceId(initialSpaceTraceId);
    const initialApiSpanId = deterministicSpanId(`${initialSpaceTraceId}:api`);
    const initialTraceparent = formatTraceparent(initialW3cTraceId, initialApiSpanId);

    const bgSpaceTraceId = "trace:bg-cont-test-1";
    const bgW3cTraceId = deterministicTraceId(bgSpaceTraceId);
    const bgTraceparent = formatTraceparent(bgW3cTraceId, deterministicSpanId(bgSpaceTraceId));

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      taskQueue,
      workflowBundle: mainWorkflowBundle,
      activities: {
        async dotGoalStep(_goalId: string) {
          dotGoalCalls += 1;
          // First 300 calls return WAITING so runDotGoalLoop hits its 300-iteration budget and triggers continueAsNew.
          if (dotGoalCalls <= 300) {
            return { state: "WAITING" as const, runId: null, goalStatus: "ACTIVE" };
          }
          return { state: "DONE" as const, runId: null, goalStatus: "COMPLETED" };
        },
        async dotGoalObserve(_goalId: string, _runId: string) {
          return { run: "COMPLETED", goalStatus: "COMPLETED" };
        },
        async runRoomAgentBackgroundAction() {
          noteActivityFailureReason("ROOM_ACTION_FAILED");
          return { status: "COMPLETED" };
        },
        async checkRoomAgentSupervisorTurn(_item: RoomAgentSupervisorQueueItem) {
          return "READY" as const;
        },
        async discardRoomAgentSupervisorTurn() {
          return;
        },
        async finishRoomAgentSupervisorTurn() {
          finishedSupervisorTurns += 1;
          return;
        },
        async prepareRoomAgentBackgroundContinuation() {
          return {
            state: "READY" as const,
            item: {
              missionId: "mission:cont1",
              turn: {
                roomId: "room:cont1",
                paneId: "pane:cont1",
                prompt: "Background verification prompt",
                artifactIds: [],
                agentRunId: "agent_run:bg-cont-test-1",
                agentSessionId: "agent_session:cont1",
                permissionMode: null,
                collaborationMode: "default" as const,
                traceId: bgSpaceTraceId,
                traceparent: bgTraceparent,
                roomAgentMissionId: "mission:cont1",
                roomAgentContinuation: {
                  sourceRunId: "agent_run:initial-1",
                  generation: 1,
                  sourceTraceId: initialSpaceTraceId,
                  sourceTraceparent: initialTraceparent
                }
              }
            }
          };
        },
        async runCodexAppServerTurn(_input: DummyTurnInput) {
          supervisorTurns += 1;
          if (supervisorTurns === 1) {
            return {
              status: "COMPLETED" as const,
              message: "Started background action",
              roomAgentOutcome: {
                status: "VERIFIED" as const,
                executedActionCount: 1,
                pendingActionIds: ["action:bg1"],
                statusReason: "Waiting on background action"
              }
            };
          }
          return {
            status: "COMPLETED" as const,
            message: "Verified background action",
            roomAgentOutcome: {
              status: "VERIFIED" as const,
              executedActionCount: 0,
              statusReason: "All done"
            }
          };
        }
      },
      ...workerObs.workerOptions
    });

    const goalTraceId = "req:dotgoal00001";
    const goalW3cTraceId = deterministicTraceId(goalTraceId);
    const goalApiSpanId = deterministicSpanId(`${goalTraceId}:api`);
    const goalTraceparent = formatTraceparent(goalW3cTraceId, goalApiSpanId);

    await worker.runUntil(async () => {
      // 1. dotGoalWorkflow continue-as-new
      const goalHandle = await testEnv.client.workflow.start("dotGoalWorkflow", {
        taskQueue,
        workflowId: "space-dot-goal:dot_goal:test1",
        args: [{ goalId: "dot_goal:test1", traceId: goalTraceId, traceparent: goalTraceparent }],
        memo: {
          spaceTraceId: goalTraceId,
          traceparent: goalTraceparent,
          w3cTraceId: goalW3cTraceId
        }
      });
      const goalResult = await goalHandle.result();
      expect(goalResult).toEqual({ goalStatus: "COMPLETED" });

      // 2. roomAgentActionWorkflow
      const actionHandle = await testEnv.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue,
        workflowId: "space-room-action:action:bg1",
        args: [
          {
            actionId: "action:bg1",
            traceId: initialSpaceTraceId,
            traceparent: initialTraceparent,
            bridge: {
              roomId: "room:cont1",
              paneId: "pane:cont1",
              missionId: "mission:cont1",
              requestId: initialSpaceTraceId
            }
          }
        ],
        memo: {
          spaceTraceId: initialSpaceTraceId,
          traceparent: initialTraceparent,
          w3cTraceId: initialW3cTraceId
        }
      });
      await actionHandle.result();

      // 3. roomAgentSupervisorWorkflow with initial turn -> background continuation turn
      const supHandle = await testEnv.client.workflow.signalWithStart("roomAgentSupervisorWorkflow", {
        taskQueue,
        workflowId: "workflow:room-agent:room:cont1",
        args: [{ roomId: "room:cont1", pending: [], interrupted: [], monitoringMissionIds: [], processedCount: 0 }],
        signal: ROOM_AGENT_ENQUEUE_SIGNAL,
        signalArgs: [
          {
            missionId: "mission:cont1",
            turn: {
              roomId: "room:cont1",
              paneId: "pane:cont1",
              prompt: "Initial operator mission",
              artifactIds: [],
              agentRunId: "agent_run:initial-1",
              agentSessionId: "agent_session:cont1",
              permissionMode: null,
              collaborationMode: "default",
              traceId: initialSpaceTraceId,
              traceparent: initialTraceparent,
              roomAgentMissionId: "mission:cont1"
            }
          }
        ],
        memo: {
          spaceTraceId: initialSpaceTraceId,
          traceparent: initialTraceparent,
          w3cTraceId: initialW3cTraceId
        }
      });

      // Wait until both turns (initial + background continuation) and terminal supervisor activity have completed
      const deadline = Date.now() + 20_000;
      while ((supervisorTurns < 2 || finishedSupervisorTurns < 1) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(supervisorTurns).toBe(2);
      expect(finishedSupervisorTurns).toBe(1);
      await new Promise((r) => setTimeout(r, 50));
      await supHandle.terminate("test complete");
    });

    await workerObs.close();

    // Verify dotGoalWorkflow continue-as-new span link
    const goalWfSpans = collector.spans.filter(
      (s) => s.name === "dotGoalWorkflow" && s.traceId === goalW3cTraceId
    );
    expect(goalWfSpans).toHaveLength(2);
    const firstGoalRun = goalWfSpans.find((s) => s.attributes["space.outcome"] === "CONTINUED_AS_NEW");
    const secondGoalRun = goalWfSpans.find((s) => s.attributes["space.outcome"] === "COMPLETED");
    expect(firstGoalRun).toBeDefined();
    expect(secondGoalRun).toBeDefined();
    expect(firstGoalRun!.parentSpanId).toBe(goalApiSpanId);
    expect(secondGoalRun!.links).toEqual([
      {
        traceId: goalW3cTraceId,
        spanId: firstGoalRun!.spanId,
        attributes: {
          "space.link_kind": "continue_as_new",
          "space.continued_from_run_id": String(firstGoalRun!.attributes["space.run_id"]),
          "space.workflow_id": "space-dot-goal:dot_goal:test1"
        }
      }
    ]);

    // Verify roomAgentActionWorkflow span and its activity child
    const actionWfSpan = collector.spans.find((s) => s.name === "roomAgentActionWorkflow");
    const actionActSpan = collector.spans.find((s) => s.name === "runRoomAgentBackgroundAction");
    expect(actionWfSpan).toBeDefined();
    expect(actionActSpan).toBeDefined();
    expect(actionWfSpan!.traceId).toBe(initialW3cTraceId);
    expect(actionWfSpan!.parentSpanId).toBe(initialApiSpanId);
    expect(actionActSpan!.traceId).toBe(initialW3cTraceId);
    expect(actionActSpan!.parentSpanId).toBe(actionWfSpan!.spanId);

    // Verify background continuation workflow span carries a span link to the source run/trace
    const bgTurnWfSpan = collector.spans.find(
      (s) => s.name === "codexAppServerTurnWorkflow" && s.traceId === bgW3cTraceId
    );
    expect(bgTurnWfSpan).toBeDefined();
    expect(bgTurnWfSpan!.links).toEqual([
      expect.objectContaining({
        traceId: initialW3cTraceId,
        attributes: expect.objectContaining({
          "space.link_kind": "background_continuation",
          "space.source_run_id": "agent_run:initial-1",
          "space.continuation_generation": 1,
          "space.parent_trace_id": initialSpaceTraceId
        })
      })
    ]);
  }, 90_000);
});
