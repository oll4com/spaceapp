import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { defaultPayloadConverter } from "@temporalio/common";

// Mock the workflow isolate context before importing the interceptor module.
const mockWorkflowInfo = vi.fn();
const mockProxySinks = vi.fn();
vi.mock("@temporalio/workflow", async (importOriginal) => {
  const original = await importOriginal<typeof import("@temporalio/workflow")>();
  return {
    ...original,
    workflowInfo: (...args: unknown[]) => mockWorkflowInfo(...args),
    proxySinks: (...args: unknown[]) => mockProxySinks(...args)
  };
});

import { createOtlpSpanExporter } from "@space/runtime";
import { createWorkflowTelemetrySinks } from "../src/workflow-telemetry-sink.js";
import { interceptors, workflowSpanIdForRun } from "../src/workflow-observability.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${apiSpanId}-01`;

describe("workflow span integration", () => {
  let server: Server;
  let received: Array<{ url: string; body: unknown }>;
  let baseUrl: string;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (chunk) => { data += chunk; });
      req.on("end", () => {
        received.push({ url: req.url ?? "", body: JSON.parse(data) });
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.clearAllMocks();
  });

  it("produces one connected trace: API span -> workflow span -> activity span", async () => {
    // Fake OTLP collector + real exporter + real sink.
    const exporter = createOtlpSpanExporter({
      endpoint: baseUrl,
      serviceName: "space-worker",
      flushIntervalMs: 60_000
    });
    const sinks = createWorkflowTelemetrySinks(exporter);

    // Simulate what the inbound interceptor does: workflowStarted -> workflowCompleted.
    const runId = "3b2a1f4e-8c7d-4a1b-9e2f-5d6c7b8a9e0f";
    const workflowSpanId = workflowSpanIdForRun(runId);
    const startedPayload = JSON.stringify({
      traceId,
      spanId: workflowSpanId,
      parentSpanId: apiSpanId,
      name: "workflow testWorkflow",
      attributes: { "space.trace_id": "req:abcdefghijkl", "space.workflow_type": "testWorkflow" },
      links: []
    });
    const workflowInfo = { workflowId: "workflow:test:1", runId, workflowType: "testWorkflow" } as never;
    sinks.workflowTelemetry.workflowStarted.fn(workflowInfo, startedPayload);

    // Simulate an activity span as a child of the workflow span (header injection result).
    exporter.record({
      traceId,
      spanId: "cccccccccccccccc",
      parentSpanId: workflowSpanId,
      name: "activity testActivity",
      startTimeUnixNano: 1_700_000_000_000_000_000n,
      endTimeUnixNano: 1_700_000_000_500_000_000n,
      attributes: { "space.activity_type": "testActivity", "space.outcome": "COMPLETED", "space.attempt": 1 },
      error: false,
      kind: 1
    });

    sinks.workflowTelemetry.workflowCompleted.fn(workflowInfo, JSON.stringify({ spanId: workflowSpanId, status: "COMPLETED" }));
    await exporter.flush();
    await exporter.close();

    expect(received.length).toBeGreaterThan(0);
    const spans = received.flatMap((r) => {
      const body = r.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> };
      return body.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
    });
    expect(spans.length).toBe(2);

    const workflowSpan = spans.find((s) => s.name === "workflow testWorkflow")!;
    const activitySpan = spans.find((s) => s.name === "activity testActivity")!;
    expect(workflowSpan.traceId).toBe(traceId);
    expect(workflowSpan.parentSpanId).toBe(apiSpanId);
    expect(activitySpan.traceId).toBe(traceId);
    expect(activitySpan.parentSpanId).toBe(workflowSpan.spanId);
  });

  it("interceptor injects traceparent header on activity calls", async () => {
    const runId = "3b2a1f4e-8c7d-4a1b-9e2f-5d6c7b8a9e0f";
    const workflowSpanId = workflowSpanIdForRun(runId);
    mockWorkflowInfo.mockReturnValue({ runId, workflowId: "w", workflowType: "testWorkflow" });
    const startedCalls: string[] = [];
    const completedCalls: string[] = [];
    mockProxySinks.mockReturnValue({
      workflowTelemetry: {
        workflowStarted: (json: string) => { startedCalls.push(json); },
        workflowCompleted: (json: string) => { completedCalls.push(json); }
      }
    });

    const factory = interceptors();
    const inbound = factory.inbound![0]!;
    const outbound = factory.outbound![0]!;

    // Simulate workflow start with traceparent in args.
    const headers: Record<string, unknown> = {};
    await inbound.execute!(
      { args: [{ traceId: "req:abcdefghijkl", traceparent }], headers } as never,
      (async () => "result") as never
    );

    expect(startedCalls).toHaveLength(1);
    const started = JSON.parse(startedCalls[0]!);
    expect(started.traceId).toBe(traceId);
    expect(started.spanId).toBe(workflowSpanId);
    expect(started.parentSpanId).toBe(apiSpanId);
    expect(completedCalls).toHaveLength(1);
    expect(JSON.parse(completedCalls[0]!).status).toBe("COMPLETED");

    // Simulate an activity call: the outbound interceptor should inject the header.
    const activityHeaders: Record<string, unknown> = {};
    await outbound.scheduleActivity!(
      { activityType: "test", args: [], options: {}, headers: activityHeaders, seq: 1 } as never,
      (async () => undefined) as never
    );
    const headerPayload = activityHeaders.traceparent as unknown;
    const headerValue = defaultPayloadConverter.fromPayload(headerPayload as never) as string;
    expect(headerValue).toBe(`00-${traceId}-${workflowSpanId}-01`);
  });

  it("emits no spans when there is no traceparent", async () => {
    mockWorkflowInfo.mockReturnValue({ runId: "r", workflowId: "w", workflowType: "testWorkflow" });
    const startedCalls: string[] = [];
    mockProxySinks.mockReturnValue({
      workflowTelemetry: {
        workflowStarted: (json: string) => { startedCalls.push(json); },
        workflowCompleted: () => {}
      }
    });

    const factory = interceptors();
    const result = await factory.inbound![0]!.execute!(
      { args: [{ traceId: "req:no-traceparent" }], headers: {} } as never,
      (async () => "ok") as never
    );
    expect(result).toBe("ok");
    expect(startedCalls).toHaveLength(0);
  });
});
