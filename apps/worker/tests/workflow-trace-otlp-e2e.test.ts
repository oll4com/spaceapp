import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import type { DummyTurnInput, DummyTurnResult } from "@space/contracts";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { createWorkflowTraceSinks } from "../src/workflow-sinks.js";

interface CapturedOtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  status: { code: number };
}

function createInMemoryOtlpCollector() {
  const spans: CapturedOtlpSpan[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/v1/traces") {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(raw);
          const extracted: CapturedOtlpSpan[] =
            parsed.resourceSpans?.flatMap((rs: any) =>
              rs.scopeSpans?.flatMap((ss: any) => ss.spans ?? []) ?? []
            ) ?? [];
          spans.push(...extracted);
          res.writeHead(200, { "Content-Type": "application/json" });
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

  return {
    get spans() {
      return spans;
    },
    async start(): Promise<string> {
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address() as { address: string; port: number };
      return `http://${addr.address}:${addr.port}`;
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    }
  };
}

describe("OTLP Connected Trace Hierarchy E2E", () => {
  let collector: ReturnType<typeof createInMemoryOtlpCollector>;
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let spanExporter: ReturnType<typeof createOtlpSpanExporter>;

  const rootTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const apiServerSpanId = "00f067aa0ba902b7";
  const inboundTraceparent = `00-${rootTraceId}-${apiServerSpanId}-01`;
  const taskQueue = "test-otlp-trace-queue";

  let recordStartAttempts = 0;

  beforeAll(async () => {
    collector = createInMemoryOtlpCollector();
    const endpoint = await collector.start();

    spanExporter = createOtlpSpanExporter({
      endpoint,
      serviceName: "space-worker",
      flushIntervalMs: 50
    });

    env = await TestWorkflowEnvironment.createTimeSkipping();

    const workflowsPath = fileURLToPath(new URL("../src/workflows.ts", import.meta.url));
    const workflowInterceptorsPath = fileURLToPath(new URL("../src/workflow-interceptors.ts", import.meta.url));

    const testActivities = {
      recordDummyTurnStarted: async (_input: DummyTurnInput): Promise<void> => {
        recordStartAttempts += 1;
        if (recordStartAttempts === 1) {
          throw ApplicationFailure.retryable("Temporary resource glitch", "TOOL_UNAVAILABLE");
        }
      },
      recordDummyTurnCompleted: async (_input: DummyTurnInput): Promise<DummyTurnResult> => {
        return {
          status: "COMPLETED",
          providerId: "dummy",
          model: "test-model",
          totalTimeMs: 100,
          tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 }
        };
      }
    };

    worker = await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowsPath,
      activities: testActivities,
      sinks: createWorkflowTraceSinks(spanExporter),
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: spanExporter })],
        workflowModules: [workflowInterceptorsPath]
      }
    });
  });

  afterAll(async () => {
    await spanExporter?.close();
    await collector?.close();
    await env?.teardown();
  });

  it("exports a complete connected trace tree: API -> workflow -> activity retry attempts -> completion", async () => {
    const input: DummyTurnInput = {
      turnId: "turn-otlp-1",
      roomId: "room-otlp-1",
      traceId: `req:${rootTraceId.slice(0, 16)}`,
      traceparent: inboundTraceparent,
      clientSessionId: "sess-1",
      prompt: "hello"
    };

    const handle = await env.client.workflow.start("dummyTurnWorkflow", {
      taskQueue,
      workflowId: `wf-dummy-otlp-${Date.now()}`,
      args: [input],
      memo: {
        traceparent: inboundTraceparent,
        spaceTraceId: input.traceId,
        w3cTraceId: rootTraceId
      }
    });

    await worker.runUntil(handle.result());
    await spanExporter.flush();

    const spans = collector.spans;
    expect(spans.length).toBeGreaterThanOrEqual(4);

    // 1. All spans must share the exact same 32-hex traceId propagated from API
    for (const span of spans) {
      expect(span.traceId).toBe(rootTraceId);
    }

    // 2. Workflow span
    const wfSpan = spans.find((s) => s.name === "workflow dummyTurnWorkflow");
    expect(wfSpan).toBeDefined();
    expect(wfSpan!.parentSpanId).toBe(apiServerSpanId); // Child of API server request
    expect(wfSpan!.kind).toBe(1); // INTERNAL
    expect(wfSpan!.status.code).toBe(0); // OK

    // 3. Activity attempt 1 (failed with retryable error)
    const attempt1 = spans.find(
      (s) =>
        s.name === "activity recordDummyTurnStarted" &&
        s.attributes.some((a) => a.key === "space.attempt" && a.value.intValue === "1")
    );
    expect(attempt1).toBeDefined();
    expect(attempt1!.parentSpanId).toBe(wfSpan!.spanId); // Parent is the workflow span!
    expect(attempt1!.status.code).toBe(2); // ERROR
    expect(attempt1!.attributes).toEqual(
      expect.arrayContaining([
        { key: "space.outcome", value: { stringValue: "FAILED" } },
        { key: "space.reason_code", value: { stringValue: "TOOL_UNAVAILABLE" } },
        { key: "space.category", value: { stringValue: "TOOL_UNAVAILABLE" } }
      ])
    );

    // 4. Activity attempt 2 (succeeded retry)
    const attempt2 = spans.find(
      (s) =>
        s.name === "activity recordDummyTurnStarted" &&
        s.attributes.some((a) => a.key === "space.attempt" && a.value.intValue === "2")
    );
    expect(attempt2).toBeDefined();
    expect(attempt2!.parentSpanId).toBe(wfSpan!.spanId); // Parent is the workflow span!
    expect(attempt2!.status.code).toBe(0); // OK
    expect(attempt2!.attributes).toEqual(
      expect.arrayContaining([{ key: "space.outcome", value: { stringValue: "COMPLETED" } }])
    );

    // 5. Subsequent activity (recordDummyTurnCompleted)
    const completedAct = spans.find((s) => s.name === "activity recordDummyTurnCompleted");
    expect(completedAct).toBeDefined();
    expect(completedAct!.parentSpanId).toBe(wfSpan!.spanId); // Parent is the workflow span!
    expect(completedAct!.status.code).toBe(0);
  });
});
