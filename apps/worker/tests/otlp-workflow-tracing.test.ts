// End to end: a real Temporal test server (@temporalio/testing), a real Worker
// with OTLP tracing pointed at a fake collector (local http.createServer), and
// test-only workflows with stub activities. No Docker, no AI provider.
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Runtime, Worker, DefaultLogger } from "@temporalio/worker";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { SPAN_ATTRIBUTE_ALLOWLIST } from "@space/runtime";
import { workerObservabilityOptions, workerTracing, workflowTracingModulePath, type WorkerTracing } from "../src/worker-tracing.js";
import { captureWorkerLogs } from "../src/worker-log.js";
import type { TracedInput, TracingStubActivities } from "./support/otlp-tracing-workflows.js";

interface OtlpAttribute { key: string; value: { stringValue?: string; intValue?: string } }
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  attributes: OtlpAttribute[];
  links?: Array<{ traceId: string; spanId: string; attributes: OtlpAttribute[] }>;
  status: { code: number };
}

const workflowsPath = fileURLToPath(new URL("./support/otlp-tracing-workflows.ts", import.meta.url));
const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const inboundSpanId = "00f067aa0ba902b7";
const inboundTraceparent = `00-${inboundTraceId}-${inboundSpanId}-01`;
const canary = {
  prompt: "CANARY-PROMPT summarise the secret plan",
  filePath: "/home/canary-user/secret-notes.txt",
  url: "https://canary-leak.example/path?token=abc"
};

Runtime.install({ logger: new DefaultLogger("WARN") });

let unavailable: string | null = null;
let env: TestWorkflowEnvironment | null = null;
try {
  // Starts (and on first use downloads) the Temporal CLI dev server.
  env = await TestWorkflowEnvironment.createLocal();
} catch (error) {
  unavailable = `Temporal test server unavailable (${error instanceof Error ? error.message.slice(0, 160) : "unknown"}); the OTLP integration and replay tests are skipped`;
  console.warn(unavailable);
}

const bodies: string[] = [];
let collector: http.Server;
let endpoint = "";
let tracing: WorkerTracing;
let restoreLogs: () => void = () => undefined;

function spans(): OtlpSpan[] {
  return bodies.flatMap(body => (JSON.parse(body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> })
    .resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));
}
/** Flushes until the collector has a matching span: the sink runs just after the workflow completes. */
async function waitForSpan(predicate: (span: OtlpSpan) => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await tracing.spans.flush();
    if (spans().some(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}
const attribute = (span: OtlpSpan, key: string) => {
  const value = span.attributes.find(entry => entry.key === key)?.value;
  return value?.intValue !== undefined ? Number(value.intValue) : value?.stringValue;
};

describe.skipIf(!env)("OTLP workflow and activity spans", () => {
  const taskQueue = `otlp-tracing-${Date.now()}`;
  let worker: Worker;
  let workerRun: Promise<void>;
  let memoryWorker: Worker;
  let memoryWorkerRun: Promise<void>;

  beforeAll(async () => {
    restoreLogs = captureWorkerLogs(() => undefined);
    collector = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk as Buffer));
      request.on("end", () => {
        if (request.method === "POST" && request.url === "/v1/traces") bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
    endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
    tracing = workerTracing({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }, "space-worker")!;    const failedOnce = new Set<string>();
    const activities: TracingStubActivities = {
      async stubStep() { return "ok"; },
      async flakyStep() {
        const key = Context.current().info.workflowExecution.workflowId;
        if (!failedOnce.has(key)) {
          failedOnce.add(key);
          throw ApplicationFailure.retryable(`first attempt fails: ${canary.prompt} ${canary.url}`, "TOOL_UNAVAILABLE");
        }
        return "ok";
      }
    };
    worker = await Worker.create({
      connection: env!.nativeConnection,
      namespace: env!.namespace ?? "default",
      taskQueue,
      workflowsPath,
      activities: {
        ...activities,
        refreshMemoryGraphSnapshot: async () => ({ sourceHash: "source-test" }),
        refreshAllMonthsMemoryGraphSnapshot: async () => ({}),
        reconcileStaleSpaceAgentSessions: async () => ({}),
        createScheduledMemoryAudit: async () => ({ id: "audit-test", workflowId: "otlp-memory-child" })
      },
      ...workerObservabilityOptions(tracing)
    });
    workerRun = worker.run();
    memoryWorker = await Worker.create({
      connection: env!.nativeConnection, namespace: env!.namespace ?? "default",
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, workflowsPath,
      activities: { prepareMemoryConsolidation: async () => ({ changeSetId: null, run: { id: "audit-test" } }) },
      ...workerObservabilityOptions(tracing)
    });
    memoryWorkerRun = memoryWorker.run();
  }, 120_000);

  afterAll(async () => {
    memoryWorker?.shutdown();
    await memoryWorkerRun?.catch(() => undefined);
    worker?.shutdown();
    await workerRun?.catch(() => undefined);
    await tracing?.close();
    await new Promise(resolve => collector?.close(resolve));
    restoreLogs();
    await env?.teardown();
  }, 60_000);

  it("connects the API span, the workflow, every activity attempt and the child workflow in one trace", async () => {
    const workflowId = `otlp-parent-${Date.now()}`;
    const input: TracedInput = { traceId: "req:otlp-integration", roomId: "room_otlp", paneId: "pane_otlp", traceparent: inboundTraceparent, ...canary };
    await env!.client.workflow.execute("tracedParentWorkflow", {
      args: [input], taskQueue, workflowId, memo: { traceparent: inboundTraceparent, spaceTraceId: input.traceId }
    });
    await waitForSpan(span => span.name === "workflow tracedParentWorkflow" && attribute(span, "temporal.workflow.id") === workflowId);
    const trace = spans().filter(span => span.traceId === inboundTraceId);
    const parent = trace.find(span => span.name === "workflow tracedParentWorkflow")!;
    const child = trace.find(span => span.name === "workflow tracedChildWorkflow")!;
    expect(parent).toBeDefined();
    expect(child).toBeDefined();
    expect(parent.parentSpanId).toBe(inboundSpanId);
    expect(parent.kind).toBe(1);
    expect(attribute(parent, "temporal.workflow.id")).toBe(workflowId);
    expect(attribute(parent, "space.outcome")).toBe("COMPLETED");
    expect(attribute(parent, "space.trace_id")).toBe("req:otlp-integration");
    expect(attribute(parent, "space.room_id")).toBe("room_otlp");
    expect(child.parentSpanId).toBe(parent.spanId);

    const flaky = trace.filter(span => span.name === "activity flakyStep").sort((a, b) => Number(attribute(a, "temporal.activity.attempt")) - Number(attribute(b, "temporal.activity.attempt")));
    expect(flaky.map(span => attribute(span, "temporal.activity.attempt"))).toEqual([1, 2]);
    expect(flaky.every(span => span.parentSpanId === parent.spanId && span.kind === 1)).toBe(true);
    expect(attribute(flaky[0]!, "space.outcome")).toBe("FAILED");
    expect(attribute(flaky[0]!, "error.code")).toBe("TOOL_UNAVAILABLE");
    expect(attribute(flaky[0]!, "space.error.category")).toBe("TOOL_UNAVAILABLE");
    expect(flaky[0]!.status.code).toBe(2);
    expect(attribute(flaky[1]!, "space.outcome")).toBe("COMPLETED");

    const stubs = trace.filter(span => span.name === "activity stubStep");
    expect(stubs.map(span => span.parentSpanId).sort()).toEqual([parent.spanId, child.spanId].sort());
    // Every span of this run is in the request's trace.
    expect(spans().filter(span => attribute(span, "temporal.workflow.id")?.toString().startsWith(workflowId)).every(span => span.traceId === inboundTraceId)).toBe(true);
  });

  it("nests the real memory maintenance and consolidation workflows", async () => {
    const workflowId = "otlp-memory-parent";
    await env!.client.workflow.execute("memoryMaintenanceWorkflow", {
      args: [{ traceId: "req:memory-test" }], taskQueue, workflowId,
      memo: { traceparent: inboundTraceparent }
    });
    await waitForSpan(span => span.name === "workflow memoryMaintenanceWorkflow");
    const parent = spans().find(span => span.name === "workflow memoryMaintenanceWorkflow")!;
    const child = spans().find(span => span.name === "workflow memoryConsolidationWorkflow")!;
    expect(parent.parentSpanId).toBe(inboundSpanId);
    expect(child.traceId).toBe(inboundTraceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(spans().find(span => span.name === "activity prepareMemoryConsolidation")?.parentSpanId).toBe(child.spanId);
  }, 30_000);

  it("keeps a continue-as-new run in the same trace with a link to the previous run", async () => {
    const workflowId = `otlp-continue-${Date.now()}`;
    await env!.client.workflow.execute("tracedContinueWorkflow", { args: [{ iteration: 0, traceparent: inboundTraceparent }], taskQueue, workflowId });
    await waitForSpan(span => attribute(span, "temporal.workflow.id") === workflowId && attribute(span, "space.outcome") === "COMPLETED");
    const runs = spans().filter(span => span.name === "workflow tracedContinueWorkflow" && attribute(span, "temporal.workflow.id") === workflowId);
    expect(runs).toHaveLength(2);
    const first = runs.find(span => attribute(span, "space.outcome") === "CONTINUED_AS_NEW")!;
    const second = runs.find(span => attribute(span, "space.outcome") === "COMPLETED")!;
    expect(first.traceId).toBe(inboundTraceId);
    expect(second.traceId).toBe(inboundTraceId);
    expect(second.parentSpanId).toBe(inboundSpanId);
    expect(second.links?.[0]).toMatchObject({ traceId: inboundTraceId, spanId: first.spanId });
    expect(second.links?.[0]?.attributes).toEqual([{ key: "space.link.kind", value: { stringValue: "continue_as_new" } }]);
  });

  it("links a background continuation to the turn it continues", async () => {
    const workflowId = `otlp-continuation-${Date.now()}`;
    const ownTraceparent = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    await env!.client.workflow.execute("tracedContinuationWorkflow", {
      args: [{ traceId: "trace:bg-otlp", roomId: "room_otlp", paneId: "pane_otlp", traceparent: ownTraceparent, continuationTraceparent: inboundTraceparent }],
      taskQueue, workflowId
    });
    await waitForSpan(entry => attribute(entry, "temporal.workflow.id") === workflowId);
    const span = spans().find(entry => entry.name === "workflow tracedContinuationWorkflow" && attribute(entry, "temporal.workflow.id") === workflowId)!;
    expect(span.traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(span.parentSpanId).toBeUndefined();
    expect(span.links).toEqual([{ traceId: inboundTraceId, spanId: inboundSpanId, attributes: [{ key: "space.link.kind", value: { stringValue: "background_continuation" } }] }]);
  });

  it("exports allowlisted attributes only and never the prompt, paths, URLs or error messages", async () => {
    expect(bodies.length).toBeGreaterThan(0);
    for (const span of spans()) {
      for (const { key, value } of [...span.attributes, ...(span.links ?? []).flatMap(link => link.attributes)]) {
        expect(SPAN_ATTRIBUTE_ALLOWLIST.has(key), key).toBe(true);
        if (value.stringValue !== undefined) expect(value.stringValue).toMatch(/^[A-Za-z0-9:._-]{1,200}$/);
      }
    }
    const all = bodies.join("\n");
    for (const secret of ["CANARY", "canary-user", "secret-notes", "canary-leak", "first attempt fails", "summarise"]) expect(all).not.toContain(secret);
  });

  it("replaying a recorded history emits no spans", async () => {
    const workflowId = `otlp-replay-${Date.now()}`;
    const handle = await env!.client.workflow.start("tracedParentWorkflow", {
      args: [{ traceId: "req:otlp-replay", roomId: "room_otlp", paneId: "pane_otlp", traceparent: inboundTraceparent }], taskQueue, workflowId
    });
    await handle.result();
    await waitForSpan(span => span.name === "workflow tracedParentWorkflow" && attribute(span, "temporal.workflow.id") === workflowId);
    const history = await handle.fetchHistory();
    const postsBefore = bodies.length;
    const sinkCalls: unknown[] = [];
    await Worker.runReplayHistory({
      workflowsPath,
      interceptors: { workflowModules: [workflowTracingModulePath()] },
      sinks: { spaceTracing: { workflowSpan: { fn: (_info: unknown, record: unknown) => { sinkCalls.push(record); }, callDuringReplay: false } } }
    }, history, workflowId);
    await tracing.spans.flush();
    expect(sinkCalls).toEqual([]);
    expect(bodies.length).toBe(postsBefore);
    // Control: the interceptor does run during replay; only the sink option keeps it silent.
    const controlCalls: unknown[] = [];
    await Worker.runReplayHistory({
      workflowsPath,
      interceptors: { workflowModules: [workflowTracingModulePath()] },
      sinks: { spaceTracing: { workflowSpan: { fn: (_info: unknown, record: unknown) => { controlCalls.push(record); }, callDuringReplay: true } } }
    }, history, workflowId);
    expect(controlCalls).toHaveLength(1);
  }, 120_000);
});

it.skipIf(!unavailable)("records why the Temporal integration tests were skipped", () => {
  expect(unavailable).toMatch(/Temporal test server unavailable/);
});
