import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { formatTraceparent } from "@space/contracts";
import { createOtlpSpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workerSpanSinks } from "../src/workflow-spans-sink.js";
import { WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST, type WorkflowSpanEvent } from "../src/workflow-span-context.js";

const taskQueue = "worker-span-test";
const workflowsPath = fileURLToPath(new URL("./support/traced-workflows.ts", import.meta.url));
const workflowInterceptorModules = [fileURLToPath(new URL("../src/workflow-observability-interceptors.ts", import.meta.url))];
const secretPrompt = "PRIVATE PROMPT: deploy with token sk-live-worker-secret-123";
const apiTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "1111111111111111";

interface CollectorSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes?: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>;
}

/** A fake OTLP/HTTP JSON collector on loopback: records every posted body. */
async function startCollector() {
  const bodies: string[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = 200;
      response.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  return {
    endpoint,
    bodies,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    spans: (): CollectorSpan[] => {
      const spans: CollectorSpan[] = [];
      for (const body of bodies) {
        const parsed = JSON.parse(body) as { resourceSpans?: Array<{ scopeSpans?: Array<{ spans?: CollectorSpan[] }> }> };
        for (const resource of parsed.resourceSpans ?? []) {
          for (const scope of resource.scopeSpans ?? []) spans.push(...(scope.spans ?? []));
        }
      }
      return spans;
    }
  };
}

function recordApiSpan(exporter: ReturnType<typeof createOtlpSpanExporter>) {
  // The API SERVER span that starts the trace, as apps/api would export it.
  exporter.record({
    traceId: apiTraceId,
    spanId: apiSpanId,
    parentSpanId: null,
    name: "POST /api/rooms/:roomId/turns",
    startTimeUnixNano: 1_000_000_000n,
    endTimeUnixNano: 9_000_000_000n,
    attributes: { "http.request.method": "POST", "http.route": "/api/rooms/:roomId/turns", "space.request_id": "req:abcdefghijkl" },
    error: false,
    kind: 2
  });
}

let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createLocal();
}, 300_000);
afterAll(async () => {
  await env.teardown();
});

async function withWorker(collector: Awaited<ReturnType<typeof startCollector>>, run: () => Promise<void>) {
  const exporter = createOtlpSpanExporter({ endpoint: collector.endpoint, serviceName: "space-worker", batchSize: 4, flushIntervalMs: 50 });
  recordApiSpan(exporter);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: "default",
    taskQueue,
    workflowsPath,
    activities: { echo: async (input: { value: string }) => input.value },
    interceptors: {
      activity: [createActivityObservabilityInterceptors({ spans: exporter })],
      workflowModules: workflowInterceptorModules
    },
    sinks: workerSpanSinks(exporter)
  });
  const running = worker.run();
  try {
    await run();
  } finally {
    await worker.shutdown();
    await running;
    await exporter.close();
    await collector.close();
  }
}

describe("worker OTLP span export", () => {
  it("connects the API span, the workflow, its activities and a child workflow in one trace", { timeout: 120_000 }, async () => {
    const collector = await startCollector();
    await withWorker(collector, async () => {
      const handle = await env.client.workflow.start("tracedRootWorkflow", {
        args: [{ roomId: "room:alpha01", traceparent: formatTraceparent(apiTraceId, apiSpanId), prompt: secretPrompt }],
        taskQueue,
        workflowId: "worker-span-trace-1"
      });
      await handle.result();
    });
    const spans = collector.spans();
    // Attribute allowlist: every worker span key must be allowlisted (the API
    // span keeps its own allowlist, tested in apps/api).
    for (const span of spans.filter((span) => span.spanId !== apiSpanId)) {
      for (const attribute of span.attributes ?? []) expect(WORKFLOW_SPAN_ATTRIBUTE_ALLOWLIST).toContain(attribute.key);
    }
    // No prompt or secret ever reaches the collector.
    expect(collector.bodies.join("")).not.toContain("sk-live-worker-secret-123");
    expect(collector.bodies.join("")).not.toContain("PRIVATE PROMPT");
    const root = spans.find((span) => span.name === "workflow tracedRootWorkflow");
    expect(root).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId });
    expect(root?.attributes).toEqual(expect.arrayContaining([{ key: "space.workflow_type", value: { stringValue: "tracedRootWorkflow" } }]));
    const echo = spans.find((span) => span.name === "activity echo");
    expect(echo).toMatchObject({ traceId: apiTraceId, parentSpanId: root?.spanId });
    expect(echo?.attributes).toEqual(expect.arrayContaining([
      { key: "space.activity_type", value: { stringValue: "echo" } },
      { key: "space.outcome", value: { stringValue: "COMPLETED" } },
      { key: "space.attempt", value: { intValue: "1" } },
      { key: "space.workflow_type", value: { stringValue: "tracedRootWorkflow" } }
    ]));
    const child = spans.find((span) => span.name === "workflow tracedChildWorkflow");
    expect(child).toMatchObject({ traceId: apiTraceId, parentSpanId: root?.spanId });
  });

  it("links a continue-as-new run and a background continuation to what they continue", { timeout: 120_000 }, async () => {
    const collector = await startCollector();
    await withWorker(collector, async () => {
      const handle = await env.client.workflow.start("tracedContinueWorkflow", {
        args: [{
          roomId: "room:beta02",
          traceparent: formatTraceparent(apiTraceId, apiSpanId),
          sourceTraceparent: formatTraceparent("dddddddddddddddddddddddddddddddd", "2222222222222222"),
          prompt: secretPrompt,
          pass: 0
        }],
        taskQueue,
        workflowId: "worker-span-continue-1"
      });
      await handle.result();
    });
    const spans = collector.spans();
    const runs = spans.filter((span) => span.name === "workflow tracedContinueWorkflow");
    expect(runs).toHaveLength(2);
    const continued = runs.find((span) => (span.links ?? []).some((link) => link.spanId !== "2222222222222222"));
    expect(continued).toBeDefined();
    // The continued run stays in the propagated trace, parents to the API span
    // and links to the previous run's span.
    expect(continued).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId });
    const previous = runs.find((span) => span !== continued);
    expect(previous).toBeDefined();
    expect(continued?.links).toEqual(expect.arrayContaining([{ traceId: apiTraceId, spanId: previous?.spanId ?? "" }]));
    // The background-continuation link points at the continued run's trace.
    expect(continued?.links).toEqual(expect.arrayContaining([{ traceId: "dddddddddddddddddddddddddddddddd", spanId: "2222222222222222" }]));
  });

  it("prefers the input traceparent when a signalled turn differs from the scheduling workflow's trace", { timeout: 120_000 }, async () => {
    const collector = await startCollector();
    const turnTraceId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const turnSpanId = "3333333333333333";
    await withWorker(collector, async () => {
      const handle = await env.client.workflow.start("tracedMixedWorkflow", {
        args: [{
          roomId: "room:delta04",
          traceparent: formatTraceparent(apiTraceId, apiSpanId),
          childTraceparent: formatTraceparent(turnTraceId, turnSpanId),
          prompt: secretPrompt
        }],
        taskQueue,
        workflowId: "worker-span-mixed-1"
      });
      await handle.result();
    });
    const spans = collector.spans();
    const mixed = spans.find((span) => span.name === "workflow tracedMixedWorkflow");
    expect(mixed).toMatchObject({ traceId: apiTraceId, parentSpanId: apiSpanId });
    const child = spans.find((span) => span.name === "workflow tracedChildWorkflow");
    // The signalled turn's own request trace wins over the scheduling
    // workflow's trace, so the turn stays connected to its API request.
    expect(child).toMatchObject({ traceId: turnTraceId, parentSpanId: turnSpanId });
    const childEcho = spans.find((span) => span.name === "activity echo" && span.traceId === turnTraceId);
    expect(childEcho).toMatchObject({ parentSpanId: child?.spanId });
    expect(collector.bodies.join("")).not.toContain("sk-live-worker-secret-123");
    expect(collector.bodies.join("")).not.toContain("PRIVATE PROMPT");
  });

  it("gives worker-internal runs a deterministic trace and emits no spans on replay", { timeout: 120_000 }, async () => {
    const collector = await startCollector();
    const workflowId = "worker-span-replay-1";
    await withWorker(collector, async () => {
      const handle = await env.client.workflow.start("tracedChildWorkflow", {
        args: [{ roomId: "room:gamma03", prompt: secretPrompt }],
        taskQueue,
        workflowId
      });
      await handle.result();
    });
    const spans = collector.spans();
    const child = spans.find((span) => span.name === "workflow tracedChildWorkflow");
    expect(child?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(child?.parentSpanId).toBeUndefined();
    const echo = spans.find((span) => span.name === "activity echo");
    expect(echo).toMatchObject({ traceId: child?.traceId, parentSpanId: child?.spanId });
    // Replaying the recorded history must emit no duplicate spans: the sink is
    // registered with callDuringReplay: false.
    const handle = env.client.workflow.getHandle(workflowId);
    const history = await handle.fetchHistory();
    const emitted: WorkflowSpanEvent[] = [];
    await Worker.runReplayHistory(
      {
        workflowsPath,
        interceptors: { workflowModules: workflowInterceptorModules },
        sinks: {
          workerSpans: {
            workflowSpan: {
              fn: (_info, event) => {
                emitted.push(event);
              },
              callDuringReplay: false
            }
          }
        }
      },
      history,
      workflowId
    );
    expect(emitted).toEqual([]);
  });
});
