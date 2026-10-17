import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import {
  createOtlpSpanExporter,
  isSafeSpanAttributeValue,
  sanitizeSpanAttributes,
  type ExportedSpan,
  type SpanExporter
} from "@space/contracts";
import { createTracingSinks, resolveWorkflowTracingInterceptorPath } from "../src/worker-tracing.js";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { resolveWorkflowPath } from "./support/resolve-workflow-path.js";

describe("OTLP span attribute allowlist and sanitization", () => {
  it("admits only safe allowlisted identifiers, codes and metrics", () => {
    const raw = {
      "service.name": "space-worker",
      "workflow.type": "codexAppServerTurnWorkflow",
      "workflow.id": "workflow:room:123",
      "workflow.run_id": "01234567-89ab-cdef-0123-456789abcdef",
      "activity.type": "runRoomAgentAction",
      "activity.id": "1",
      "activity.attempt": 2,
      "activity.outcome": "COMPLETED",
      "space.room_id": "room:abc-123",
      "space.pane_id": "pane:xyz-456",
      "space.mission_id": "mission:789",
      "error.code": "TIMEOUT",
      "error.category": "TIMEOUT",
      duration_ms: 154,
      queue_ms: 12
    };

    const sanitized = sanitizeSpanAttributes(raw);
    expect(sanitized).toEqual(raw);
  });

  it("strictly rejects prompts, URLs, file paths, JSON blobs and multi-line user text", () => {
    const forbidden = {
      prompt: "Please write a python script to solve problem X",
      user_input: "Hello agent, please fix the bug in src/index.ts",
      url: "https://example.com/api/v1/resource?token=secret123",
      model_output: "Here is the response code:\n```python\nprint('secret')\n```",
      file_path: "/etc/shadow",
      relative_path: "./secrets/id_rsa",
      error_message: "Error: database connection failed at /app/dist/db.js:42:15",
      json_payload: '{"key": "value", "secret": "12345"}',
      // Allowlisted key but containing an unsafe URL value
      "space.room_id": "https://malicious.site/callback",
      // Allowlisted key but containing a file path
      "space.mission_id": "/var/log/sensitive.log",
      // Allowlisted key but containing multi-line content
      "error.code": "MULTILINE\nERROR_CODE"
    };

    const sanitized = sanitizeSpanAttributes(forbidden);
    expect(Object.keys(sanitized)).toHaveLength(0);

    expect(isSafeSpanAttributeValue("space.room_id", "https://evil.com")).toBe(false);
    expect(isSafeSpanAttributeValue("space.room_id", "/root/passwords.txt")).toBe(false);
    expect(isSafeSpanAttributeValue("space.mission_id", "mission\nwith\nnewlines")).toBe(false);
    expect(isSafeSpanAttributeValue("error.code", "{ json: true }")).toBe(false);
  });
});

describe("Hermetic end-to-end integration and replay determinism: API traceparent to Workflow and Activity spans", () => {
  let collectorServer: http.Server;
  let collectorUrl: string;
  const receivedBodies: any[] = [];
  let testEnv: TestWorkflowEnvironment;

  beforeAll(async () => {
    // 1. Start local fake OTLP HTTP collector
    collectorServer = http.createServer((req, res) => {
      if (req.method === "POST" && req.url === "/v1/traces") {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            receivedBodies.push(JSON.parse(body));
          } catch {}
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({}));
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => collectorServer.listen(0, "127.0.0.1", () => resolve()));
    const port = (collectorServer.address() as AddressInfo).port;
    collectorUrl = `http://127.0.0.1:${port}`;

    // 2. Start Temporal time-skipping test environment
    testEnv = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await testEnv?.teardown();
    await new Promise<void>((resolve) => collectorServer.close(() => resolve()));
  });

  it("exports connected spans across workflow and activities (with and without arg traceparent) and emits zero spans on history replay", async () => {
    const testTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const testApiSpanId = "00f067aa0ba902b7";
    const testTraceparent = `00-${testTraceId}-${testApiSpanId}-01`;

    const spanExporter = createOtlpSpanExporter({
      endpoint: collectorUrl,
      serviceName: "space-worker",
      flushIntervalMs: 50,
      batchSize: 10
    });

    const taskQueue = "test-otlp-trace-queue";
    const executedActivities: string[] = [];

    const testActivities = {
      async executeMockActivity(input: { traceparent: string; roomId: string }) {
        executedActivities.push(`with-arg:${input.roomId}`);
        return { status: "COMPLETED", ok: true };
      },
      async executeArglessMockActivity(input: { actionId: string; roomId: string }) {
        executedActivities.push(`argless:${input.actionId}`);
        return { status: "COMPLETED", ok: true };
      }
    };

    const worker = await Worker.create({
      connection: testEnv.nativeConnection,
      namespace: testEnv.namespace,
      taskQueue,
      workflowsPath: resolveWorkflowPath("support/test-tracing-workflows"),
      activities: testActivities,
      sinks: createTracingSinks(spanExporter),
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: spanExporter })],
        workflowModules: [resolveWorkflowTracingInterceptorPath()]
      }
    });

    const runPromise = worker.run();
    let workflowHistory: unknown;

    try {
      const client = testEnv.client;
      const handle = await client.workflow.start("testTraceWorkflow", {
        taskQueue,
        workflowId: "test-trace-wf-1",
        args: [
          {
            traceparent: testTraceparent,
            roomId: "room:test-room",
            missionId: "mission:test-mission"
          }
        ],
        memo: {
          traceparent: testTraceparent,
          w3cTraceId: testTraceId
        }
      });

      const result = await handle.result();
      expect(result).toEqual({ success: true });
      expect(executedActivities).toEqual(["with-arg:room:test-room", "argless:action:bg-1"]);
      workflowHistory = await handle.fetchHistory();
    } finally {
      worker.shutdown();
      await runPromise;
      await spanExporter.close();
    }

    // Replay the completed workflow history through Temporal's replay runner and assert zero spans emitted
    const replayRecordedSpans: ExportedSpan[] = [];
    const replayExporter: SpanExporter = {
      record: (span) => void replayRecordedSpans.push(span),
      flush: async () => undefined,
      close: async () => undefined,
      stats: () => ({ exported: replayRecordedSpans.length, dropped: 0, failed: 0 })
    };
    const replaySinks = createTracingSinks(replayExporter);
    expect(replaySinks.tracing.exportWorkflowSpan.callDuringReplay).toBe(false);

    await Worker.runReplayHistory(
      {
        workflowsPath: resolveWorkflowPath("support/test-tracing-workflows"),
        sinks: replaySinks,
        interceptors: {
          workflowModules: [resolveWorkflowTracingInterceptorPath()]
        }
      },
      workflowHistory as never
    );
    expect(replayRecordedSpans).toHaveLength(0);

    // Wait briefly for collector HTTP server to parse received body
    await new Promise((r) => setTimeout(r, 200));
    expect(receivedBodies.length).toBeGreaterThanOrEqual(1);

    // Collect all exported spans from resourceSpans
    const allSpans: any[] = [];
    for (const body of receivedBodies) {
      for (const resSpan of body.resourceSpans ?? []) {
        for (const scopeSpan of resSpan.scopeSpans ?? []) {
          for (const s of scopeSpan.spans ?? []) {
            allSpans.push(s);
          }
        }
      }
    }

    // Must have the workflow span and both activity attempt spans
    expect(allSpans.length).toBeGreaterThanOrEqual(3);

    const wfSpan = allSpans.find((s) => s.name === "workflow:testTraceWorkflow");
    expect(wfSpan).toBeDefined();
    expect(wfSpan.traceId).toBe(testTraceId);
    expect(wfSpan.parentSpanId).toBe(testApiSpanId); // Direct child of API request span!
    expect(wfSpan.kind).toBe(1); // SPAN_KIND_INTERNAL

    const actSpan = allSpans.find((s) => s.name === "activity executeMockActivity");
    expect(actSpan).toBeDefined();
    expect(actSpan.traceId).toBe(testTraceId); // Exact same trace!
    expect(actSpan.parentSpanId).toBe(wfSpan.spanId); // Direct child of the workflow span!
    expect(actSpan.kind).toBe(1); // SPAN_KIND_INTERNAL

    const arglessActSpan = allSpans.find((s) => s.name === "activity executeArglessMockActivity");
    expect(arglessActSpan).toBeDefined();
    expect(arglessActSpan.traceId).toBe(testTraceId); // Propagated via x-space-traceparent activity header!
    expect(arglessActSpan.parentSpanId).toBe(wfSpan.spanId); // Direct child of the workflow span!
    expect(arglessActSpan.kind).toBe(1);

    // Verify allowlisted attributes on spans
    const wfAttrs = Object.fromEntries(wfSpan.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]));
    expect(wfAttrs["workflow.type"]).toBe("testTraceWorkflow");
    expect(wfAttrs["space.room_id"]).toBe("room:test-room");
    expect(wfAttrs["space.mission_id"]).toBe("mission:test-mission");

    const actAttrs = Object.fromEntries(actSpan.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]));
    expect(actAttrs["activity.type"]).toBe("executeMockActivity");
    expect(actAttrs["activity.attempt"]).toBe("1");
    expect(actAttrs["space.room_id"]).toBe("room:test-room");
  }, 60_000);
});
