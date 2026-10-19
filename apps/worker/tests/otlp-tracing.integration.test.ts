import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHttpObservability } from "../../api/src/observability.js";
import {
  TraceContextRegistry,
  traceContextForRawRequest,
  traceparentForTraceId
} from "../../api/src/trace-context.js";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { noteActivityFailureReason } from "../src/activity-observability.js";
import { createWorkerTracing } from "../src/worker-tracing.js";
import type { TraceWorkflowInput } from "./fixtures/otlp-workflows.js";

interface WireAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string };
}

interface WireSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: WireAttribute[];
  status: { code: number };
  links?: Array<{ traceId: string; spanId: string }>;
}

interface TraceRequest {
  resourceSpans: Array<{
    resource: { attributes: WireAttribute[] };
    scopeSpans: Array<{ spans: WireSpan[] }>;
  }>;
}

type CapturedSpan = WireSpan & { service: string; values: Record<string, string | number> };
type WorkerTracing = ReturnType<typeof createWorkerTracing>;

const TRACE_A = "4bf92f3577b34da6a3ce929d0e0e4736";
const TRACE_B = "bbf92f3577b34da6a3ce929d0e0e4736";
const UPSTREAM_SPAN = "0123456789abcdef";
const PRIVATE_PROMPT = "synthetic private prompt: do not export this sentence";
const PRIVATE_PATH = "/synthetic/private/trace-fixture.txt";
const PRIVATE_URL = "https://example.test/trace?token=synthetic-private-token";
const PRIVATE_RESULT = "synthetic private model output";
const PRIVATE_ERROR = "synthetic private failure message";

function attributes(entries: WireAttribute[]): Record<string, string | number> {
  return Object.fromEntries(entries.map(({ key, value }) => [
    key,
    value.intValue === undefined ? value.stringValue ?? "" : Number(value.intValue)
  ]));
}

/** Real loopback HTTP collector. It never contacts an OTLP service outside this test. */
async function startCollector() {
  const requests: TraceRequest[] = [];
  const paths: string[] = [];
  const pending = new Set<ServerResponse>();
  let mode: "ok" | "reject" | "hold" = "ok";
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      paths.push(request.url ?? "");
      requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as TraceRequest);
      if (mode === "hold") {
        pending.add(response);
        response.once("close", () => pending.delete(response));
      } else {
        response.writeHead(mode === "reject" ? 503 : 200, { "content-type": "application/json" });
        response.end("{}");
      }
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const release = () => {
    for (const response of pending) response.writeHead(200, { "content-type": "application/json" }).end("{}");
    pending.clear();
  };
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    paths,
    setMode(next: typeof mode) { mode = next; },
    pendingCount: () => pending.size,
    release,
    clear() { requests.length = 0; paths.length = 0; mode = "ok"; },
    spans(): CapturedSpan[] {
      return requests.flatMap(request => request.resourceSpans.flatMap(resource => {
        const service = String(attributes(resource.resource.attributes)["service.name"]);
        return resource.scopeSpans.flatMap(scope => scope.spans.map(span => ({
          ...span,
          service,
          values: attributes(span.attributes)
        })));
      }));
    },
    async close() {
      release();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}

/** Nest runUntil so both success and a failed assertion shut down every worker. */
function runWorkers<T>(workers: Worker[], run: () => Promise<T>): Promise<T> {
  const [first, ...rest] = workers;
  return first ? first.runUntil(() => runWorkers(rest, run)) : run();
}

function only(spans: CapturedSpan[], predicate: (span: CapturedSpan) => boolean): CapturedSpan {
  const found = spans.filter(predicate);
  expect(found).toHaveLength(1);
  return found[0]!;
}

function fixtureInput(activityTaskQueue: string, extra: Partial<TraceWorkflowInput> = {}): TraceWorkflowInput {
  return {
    activityTaskQueue,
    traceparent: `00-${TRACE_A}-${UPSTREAM_SPAN}-01`,
    traceId: "req:non-hex-space-request-id",
    roomId: "room:otlp-fixture",
    prompt: PRIVATE_PROMPT,
    filePath: PRIVATE_PATH,
    url: PRIVATE_URL,
    ...extra
  };
}

const activities = {
  async retryOnce() {
    if (Context.current().info.attempt === 1) {
      noteActivityFailureReason("UPSTREAM_UNAVAILABLE");
      throw new Error(PRIVATE_ERROR);
    }
    return PRIVATE_RESULT;
  },
  async echo() { return PRIVATE_RESULT; }
};

describe("OTLP tracing with real Temporal workflows and an HTTP collector", () => {
  let environment: TestWorkflowEnvironment;
  let collector: Awaited<ReturnType<typeof startCollector>>;
  let tracedBundle: WorkflowBundleWithSourceMap;
  let untracedBundle: WorkflowBundleWithSourceMap;
  const activeTracing = new Set<WorkerTracing>();

  function tracing(serviceName: string, exporter?: SpanExporter, enabled = true) {
    const created = createWorkerTracing({
      serviceName,
      env: enabled ? { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint } : {},
      ...(exporter ? { exporter } : {})
    });
    activeTracing.add(created);
    return created;
  }

  async function closeTracing(...instances: WorkerTracing[]) {
    await Promise.all(instances.map(async instance => {
      await instance.close();
      activeTracing.delete(instance);
    }));
  }

  function worker(taskQueue: string, observer: WorkerTracing, workflows = true) {
    return Worker.create({
      connection: environment.nativeConnection,
      taskQueue,
      ...(workflows ? { workflowBundle: tracedBundle } : { activities }),
      interceptors: observer.interceptors,
      sinks: observer.sinks,
      shutdownGraceTime: "2s"
    });
  }

  beforeAll(async () => {
    collector = await startCollector();
    // A real isolated time-skipping server is mandatory. Unavailable binaries fail
    // the suite; no mocks or conditional skips turn missing coverage into a pass.
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    const bundleTracing = tracing("space-workflow-bundler");
    const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-workflows.ts", import.meta.url));
    [tracedBundle, untracedBundle] = await Promise.all([
      bundleWorkflowCode({ workflowsPath, workflowInterceptorModules: bundleTracing.interceptors.workflowModules }),
      bundleWorkflowCode({ workflowsPath })
    ]);
    await closeTracing(bundleTracing);
  }, 120_000);

  afterEach(async () => {
    collector?.release();
    await closeTracing(...activeTracing);
    collector?.clear();
  });

  afterAll(async () => {
    await environment?.teardown();
    await collector?.close();
  });

  it("connects an actual API request, child workflow and retried activities across independent workers; replay exports nothing", async () => {
    const suffix = randomUUID();
    const parentId = `trace-parent-${suffix}`;
    const childId = `trace-child-${suffix}`;
    const workflowTracing = tracing("space-worker");
    const childTracing = tracing("space-memory-maintenance-worker");
    const activityTracing = tracing("space-memory-mutation-worker");
    // No registry, exporter or other tracing state is shared between these
    // instances. In particular, the activity worker executes no workflows.
    const workers = await Promise.all([
      worker(`parent-${suffix}`, workflowTracing),
      worker(`child-${suffix}`, childTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    const apiExporter = createOtlpSpanExporter({ endpoint: collector.endpoint, serviceName: "space-api" });
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: apiExporter });
    const registry = new TraceContextRegistry();
    const api = Fastify();
    api.addHook("onRequest", async request => observability.onRequest(request));
    api.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    let history: Awaited<ReturnType<ReturnType<typeof environment.client.workflow.getHandle>["fetchHistory"]>> | undefined;
    api.post("/test-trace/:roomId", async request => {
      registry.remember(request.id, traceContextForRawRequest(request.raw));
      const traceparent = traceparentForTraceId(request.id, registry)!;
      const handle = await environment.client.workflow.start("traceParentWorkflow", {
        taskQueue: `parent-${suffix}`,
        workflowId: parentId,
        workflowExecutionTimeout: "30s",
        args: [fixtureInput(`activities-${suffix}`, {
          traceparent,
          traceId: request.id,
          childTaskQueue: `child-${suffix}`,
          childWorkflowId: childId
        })]
      });
      const result = await handle.result();
      history = await handle.fetchHistory();
      return { result };
    });
    try {
      await runWorkers(workers, async () => {
        const response = await api.inject({
          method: "POST",
          url: "/test-trace/room:otlp-fixture",
          headers: { traceparent: `00-${TRACE_A}-${UPSTREAM_SPAN}-01` }
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ result: [PRIVATE_RESULT, PRIVATE_RESULT] });
      });
    } finally {
      await api.close();
      observability.close();
      await apiExporter.close();
      await closeTracing(workflowTracing, childTracing, activityTracing);
    }

    const spans = collector.spans();
    const apiSpan = only(spans, span => span.kind === 2);
    const parent = only(spans, span => span.values.workflowType === "traceParentWorkflow" && !span.values.activityType);
    const child = only(spans, span => span.values.workflowType === "traceChildWorkflow" && !span.values.activityType);
    expect(apiSpan.traceId).toBe(TRACE_A);
    expect(apiSpan.parentSpanId).toBe(UPSTREAM_SPAN);
    expect(parent.parentSpanId).toBe(apiSpan.spanId);
    expect(parent.values.workflowId).toBe(parentId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(child.values.workflowId).toBe(childId);
    expect(child.service).toBe("space-memory-maintenance-worker");
    const attempts = spans.filter(span => span.values.activityType === "retryOnce")
      .sort((a, b) => Number(a.values.attempt) - Number(b.values.attempt));
    expect(attempts).toHaveLength(2);
    expect(attempts.map(span => span.values.attempt)).toEqual([1, 2]);
    expect(attempts.map(span => span.parentSpanId)).toEqual([parent.spanId, parent.spanId]);
    expect(attempts.map(span => span.status.code)).toEqual([2, 0]);
    expect(attempts[0]!.values.reasonCode).toBe("UPSTREAM_UNAVAILABLE");
    expect(attempts[0]!.values.category).toBe("UPSTREAM_UNAVAILABLE");
    const childActivity = only(spans, span => span.values.activityType === "echo");
    expect(childActivity.parentSpanId).toBe(child.spanId);
    for (const span of [...attempts, childActivity]) expect(span.service).toBe("space-memory-mutation-worker");
    expect(spans).toHaveLength(6);
    expect(new Set(spans.map(span => span.spanId)).size).toBe(spans.length);
    for (const span of spans) {
      expect(span.traceId).toBe(TRACE_A);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(BigInt(span.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span.startTimeUnixNano));
    }
    expect(collector.paths.every(path => path === "/v1/traces")).toBe(true);
    const serialized = JSON.stringify(collector.requests);
    for (const privateValue of [PRIVATE_PROMPT, PRIVATE_PATH, PRIVATE_URL, PRIVATE_RESULT, PRIVATE_ERROR]) {
      expect(serialized).not.toContain(privateValue);
    }
    const workerAttributeKeys = new Set([
      "workflowId", "runId", "workflowType", "taskQueue", "traceId", "w3cTraceId", "parentTraceId", "roomId", "paneId", "missionId",
      "activityId", "activityType", "attempt", "outcome", "status", "reasonCode", "category", "durationMs",
      "agentRunId", "agentSessionId", "actionId", "goalId", "dotId", "turnId", "cliTaskId", "revisionId"
    ]);
    for (const span of spans.filter(candidate => candidate.kind !== 2)) {
      for (const key of Object.keys(span.values)) expect(workerAttributeKeys.has(key), key).toBe(true);
    }

    expect(history?.events?.length).toBeGreaterThan(5);
    collector.clear();
    const replayTracing = tracing("space-replay-worker");
    await Worker.runReplayHistory({
      workflowBundle: tracedBundle,
      interceptors: replayTracing.interceptors,
      sinks: replayTracing.sinks
    }, history!, parentId);
    await closeTracing(replayTracing);
    expect(collector.requests).toEqual([]);
  }, 60_000);

  it("parents a child to a later API span even when both requests share a W3C trace", async () => {
    const suffix = randomUUID();
    const nextApiSpanId = "fedcba9876543210";
    const workflowTracing = tracing("space-worker");
    const childTracing = tracing("space-child-worker");
    const activityTracing = tracing("space-activity-worker");
    const workers = await Promise.all([
      worker(`same-trace-parent-${suffix}`, workflowTracing),
      worker(`same-trace-child-${suffix}`, childTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    await runWorkers(workers, () => environment.client.workflow.execute("traceParentWorkflow", {
      taskQueue: `same-trace-parent-${suffix}`,
      workflowId: `same-trace-parent-${suffix}`,
      workflowExecutionTimeout: "30s",
      args: [fixtureInput(`activities-${suffix}`, {
        childTaskQueue: `same-trace-child-${suffix}`,
        childWorkflowId: `same-trace-child-${suffix}`,
        childTraceparent: `00-${TRACE_A}-${nextApiSpanId}-01`
      })]
    }));
    await closeTracing(workflowTracing, childTracing, activityTracing);
    const spans = collector.spans();
    const parent = only(spans, span => span.values.workflowType === "traceParentWorkflow" && !span.values.activityType);
    const child = only(spans, span => span.values.workflowType === "traceChildWorkflow" && !span.values.activityType);
    expect(parent.traceId).toBe(TRACE_A);
    expect(parent.parentSpanId).toBe(UPSTREAM_SPAN);
    expect(child.traceId).toBe(TRACE_A);
    expect(child.parentSpanId).toBe(nextApiSpanId);
    expect(child.links).toEqual(expect.arrayContaining([{ traceId: parent.traceId, spanId: parent.spanId }]));
    const activity = only(spans, span => span.values.activityType === "echo");
    expect(activity.traceId).toBe(TRACE_A);
    expect(activity.parentSpanId).toBe(child.spanId);
  }, 45_000);

  it("continues as new with the same trace and a link to the actual preceding run", async () => {
    const suffix = randomUUID();
    const workflowTracing = tracing("space-worker");
    const activityTracing = tracing("space-activity-worker");
    const workers = await Promise.all([
      worker(`continue-${suffix}`, workflowTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    const finalRunId = await runWorkers(workers, () => environment.client.workflow.execute("traceContinueWorkflow", {
      taskQueue: `continue-${suffix}`,
      workflowId: `continue-${suffix}`,
      workflowExecutionTimeout: "30s",
      args: [{ ...fixtureInput(`activities-${suffix}`), remaining: 1 }]
    }));
    await closeTracing(workflowTracing, activityTracing);
    const spans = collector.spans();
    const workflowSpans = spans.filter(span => span.values.workflowType === "traceContinueWorkflow" && !span.values.activityType);
    expect(workflowSpans).toHaveLength(2);
    const next = only(workflowSpans, span => span.values.runId === finalRunId);
    const previous = only(workflowSpans, span => span.values.runId !== finalRunId);
    expect(previous.parentSpanId).toBe(UPSTREAM_SPAN);
    expect(next.parentSpanId).toBe(previous.spanId);
    expect(next.links).toEqual(expect.arrayContaining([{ traceId: previous.traceId, spanId: previous.spanId }]));
    expect(next.traceId).toBe(TRACE_A);
    expect(previous.traceId).toBe(TRACE_A);
    const activitySpans = spans.filter(span => span.values.activityType === "echo");
    expect(activitySpans).toHaveLength(2);
    expect(new Set(activitySpans.map(span => span.parentSpanId))).toEqual(new Set(workflowSpans.map(span => span.spanId)));
    for (const span of activitySpans) expect(span.traceId).toBe(TRACE_A);
  }, 45_000);

  it("links a new background trace to an actual predecessor span after replacing all tracing instances", async () => {
    const execute = async (input: TraceWorkflowInput) => {
      const suffix = randomUUID();
      const workflowTracing = tracing("space-worker");
      const activityTracing = tracing("space-activity-worker");
      const workers = await Promise.all([
        worker(`background-${suffix}`, workflowTracing),
        worker(`activities-${suffix}`, activityTracing, false)
      ]);
      await runWorkers(workers, () => environment.client.workflow.execute("traceSimpleWorkflow", {
        taskQueue: `background-${suffix}`,
        workflowId: `background-${suffix}`,
        workflowExecutionTimeout: "30s",
        args: [{ ...input, activityTaskQueue: `activities-${suffix}` }]
      }));
      await closeTracing(workflowTracing, activityTracing);
    };
    await execute(fixtureInput("unused"));
    const predecessor = only(collector.spans(), span => span.values.workflowType === "traceSimpleWorkflow" && !span.values.activityType);
    await execute(fixtureInput("unused", {
      traceId: "trace:bg-synthetic-continuation",
      traceparent: `00-${TRACE_B}-${UPSTREAM_SPAN}-01`,
      traceLink: { traceId: predecessor.traceId, spanId: predecessor.spanId }
    }));
    const next = only(collector.spans(), span => span.traceId === TRACE_B && !span.values.activityType);
    expect(next.links).toEqual(expect.arrayContaining([{ traceId: predecessor.traceId, spanId: predecessor.spanId }]));
    expect(next.traceId).not.toBe(predecessor.traceId);
    const nextActivity = only(collector.spans(), span => span.traceId === TRACE_B && span.values.activityType === "echo");
    expect(nextActivity.parentSpanId).toBe(next.spanId);
  }, 45_000);

  it("preserves activity spans from legacy workflows without trace headers", async () => {
    const suffix = randomUUID();
    const workflowQueue = "legacy-workflow-" + suffix;
    const activityQueue = "legacy-activity-" + suffix;
    const workflowWorker = await Worker.create({
      connection: environment.nativeConnection, taskQueue: workflowQueue, workflowBundle: untracedBundle
    });
    const activityTracing = tracing("space-upgraded-activity-worker");
    const activityWorker = await worker(activityQueue, activityTracing, false);
    const result = await runWorkers([workflowWorker, activityWorker], () => environment.client.workflow.execute("traceLegacyWorkflow", {
      taskQueue: workflowQueue, workflowId: "legacy-activity-" + suffix, workflowExecutionTimeout: "30s",
      args: [fixtureInput(activityQueue)]
    }));
    await closeTracing(activityTracing);
    expect(result).toBe(PRIVATE_RESULT);
    const activity = only(collector.spans(), span => span.values.activityType === "echo");
    expect(activity.traceId).toBe(TRACE_A);
    expect(activity.parentSpanId).toBe(UPSTREAM_SPAN);
    expect(activity.values.w3cTraceId).toBe(TRACE_A);
    expect(collector.spans()).toHaveLength(1);
    const payload = JSON.stringify(collector.requests);
    for (const secret of [PRIVATE_PROMPT, PRIVATE_PATH, PRIVATE_URL, PRIVATE_RESULT]) expect(payload).not.toContain(secret);
  }, 45_000);

  it("replays history created without tracing, without changing historical commands or exporting spans", async () => {
    const suffix = randomUUID();
    const originalWorker = await Worker.create({
      connection: environment.nativeConnection,
      taskQueue: suffix,
      workflowBundle: untracedBundle,
      activities
    });
    const history = await originalWorker.runUntil(async () => {
      const handle = await environment.client.workflow.start("traceSimpleWorkflow", {
        taskQueue: suffix,
        workflowId: `legacy-${suffix}`,
        workflowExecutionTimeout: "30s",
        args: [fixtureInput(suffix)]
      });
      expect(await handle.result()).toBe(PRIVATE_RESULT);
      return handle.fetchHistory();
    });
    expect(history.events!.length).toBeGreaterThan(5);
    const observer = tracing("space-upgraded-worker");
    await Worker.runReplayHistory({
      workflowBundle: tracedBundle,
      interceptors: observer.interceptors,
      sinks: observer.sinks
    }, history, `legacy-${suffix}`);
    await closeTracing(observer);
    expect(collector.requests).toEqual([]);
  }, 45_000);

  it("replays a previously traced history after export is disabled without removing the workflow patch", async () => {
    const suffix = randomUUID();
    const workflowTracing = tracing("space-worker");
    const activityTracing = tracing("space-activity-worker");
    const workers = await Promise.all([
      worker(`transition-${suffix}`, workflowTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    const history = await runWorkers(workers, async () => {
      const handle = await environment.client.workflow.start("traceContinueWorkflow", {
        taskQueue: `transition-${suffix}`,
        workflowId: `transition-${suffix}`,
        workflowExecutionTimeout: "30s",
        // A continued run includes both an inbound tracing header and an
        // activity scheduling header from the enabled deployment.
        args: [{ ...fixtureInput(`activities-${suffix}`), remaining: 1 }]
      });
      const finalRunId = await handle.result();
      return environment.client.workflow.getHandle(`transition-${suffix}`, finalRunId).fetchHistory();
    });
    await closeTracing(workflowTracing, activityTracing);
    expect(collector.spans().filter(span => !span.values.activityType)).toHaveLength(2);
    expect(history.events!.length).toBeGreaterThan(5);
    collector.clear();
    const disabled = tracing("space-disabled-replay-worker", undefined, false);
    // Build from the disabled deployment's actual configuration. Omitting its
    // workflow interceptor produces TMPRL1100 for the non-deprecated tracing
    // patch marker, even though no spans should be exported by this worker.
    const disabledBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./fixtures/otlp-workflows.ts", import.meta.url)),
      workflowInterceptorModules: disabled.interceptors.workflowModules
    });
    await Worker.runReplayHistory({
      workflowBundle: disabledBundle,
      interceptors: disabled.interceptors,
      sinks: disabled.sinks
    }, history, `transition-${suffix}`);
    await closeTracing(disabled);
    expect(collector.requests).toEqual([]);
  }, 45_000);

  it("leaves successful workflow and activity results unchanged when the collector rejects every batch", async () => {
    collector.setMode("reject");
    const suffix = randomUUID();
    const workflowTracing = tracing("space-worker");
    const activityTracing = tracing("space-activity-worker");
    const workers = await Promise.all([
      worker(`reject-${suffix}`, workflowTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    const result = await runWorkers(workers, () => environment.client.workflow.execute("traceSimpleWorkflow", {
      taskQueue: `reject-${suffix}`,
      workflowId: `reject-${suffix}`,
      workflowExecutionTimeout: "30s",
      args: [fixtureInput(`activities-${suffix}`)]
    }));
    await closeTracing(workflowTracing, activityTracing);
    expect(result).toBe(PRIVATE_RESULT);
    expect(workflowTracing.stats().failed).toBeGreaterThan(0);
    expect(activityTracing.stats().failed).toBeGreaterThan(0);
    expect(collector.spans().every(span => span.status.code === 0)).toBe(true);
  }, 45_000);

  it("does not wait for an in-flight collector response before completing work", async () => {
    collector.setMode("hold");
    const suffix = randomUUID();
    const makeExporter = (serviceName: string) => createOtlpSpanExporter({
      endpoint: collector.endpoint, serviceName, batchSize: 1, timeoutMs: 60_000
    });
    const workflowTracing = tracing("space-worker", makeExporter("space-worker"));
    const activityTracing = tracing("space-activity-worker", makeExporter("space-activity-worker"));
    const workers = await Promise.all([
      worker(`slow-${suffix}`, workflowTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    try {
      await runWorkers(workers, async () => {
        const handle = await environment.client.workflow.start("traceSimpleWorkflow", {
          taskQueue: `slow-${suffix}`,
          workflowId: `slow-${suffix}`,
          workflowExecutionTimeout: "30s",
          args: [fixtureInput(`activities-${suffix}`)]
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            handle.result(),
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error("workflow waited for the blocked OTLP collector")), 10_000);
            })
          ]);
          expect(result).toBe(PRIVATE_RESULT);
          // Delivery is still outstanding: work completed before its response,
          // not merely after the exporter eventually timed out.
          expect(collector.pendingCount()).toBeGreaterThan(0);
        } finally {
          clearTimeout(timer);
          collector.release();
          collector.setMode("ok");
        }
      });
    } finally {
      collector.release();
      await closeTracing(workflowTracing, activityTracing);
    }
  }, 45_000);

  it("executes work normally and makes no collector requests when export is disabled", async () => {
    const suffix = randomUUID();
    const workflowTracing = tracing("space-worker", undefined, false);
    const activityTracing = tracing("space-activity-worker", undefined, false);
    const workers = await Promise.all([
      worker(`disabled-${suffix}`, workflowTracing),
      worker(`activities-${suffix}`, activityTracing, false)
    ]);
    const result = await runWorkers(workers, () => environment.client.workflow.execute("traceSimpleWorkflow", {
      taskQueue: `disabled-${suffix}`,
      workflowId: `disabled-${suffix}`,
      workflowExecutionTimeout: "30s",
      args: [fixtureInput(`activities-${suffix}`)]
    }));
    await closeTracing(workflowTracing, activityTracing);
    expect(result).toBe(PRIVATE_RESULT);
    expect(collector.requests).toEqual([]);
  }, 45_000);
});
