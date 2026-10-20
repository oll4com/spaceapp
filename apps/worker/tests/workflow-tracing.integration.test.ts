import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it } from "vitest";
import { ApplicationFailure, Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { TraceContextRegistry, traceContextForRawRequest, withTurnTraceparent } from "../../api/src/trace-context.js";
import { createActivityObservabilityInterceptors, currentActivityTraceparent } from "../src/activity-observability.js";
import { workflowTracing } from "../src/workflow-tracing.js";

type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>; links?: Array<{ traceId: string; spanId: string }> };
const collected: OtlpSpan[] = [];
const secret = "DO_NOT_EXPORT_PROMPT_OUTPUT_FILE_PATH_OR_ERROR_MESSAGE";
const workflowsPath = fileURLToPath(new URL("./fixtures/tracing-workflows.ts", import.meta.url));
const workflowModule = fileURLToPath(new URL("../src/workflow-observability.ts", import.meta.url));
const collector = createServer((request, response) => {
  if (request.url !== "/v1/traces") { response.writeHead(404).end(); return; }
  let body = "";
  request.on("data", chunk => { body += chunk; });
  request.on("end", () => {
    for (const resource of JSON.parse(body).resourceSpans) for (const scope of resource.scopeSpans) collected.push(...scope.spans);
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
});
let env: TestWorkflowEnvironment;
let endpoint: string;
beforeAll(async () => {
  await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(collector.address() as { port: number }).port}`;
  env = await TestWorkflowEnvironment.createLocal({ server: { ip: "127.0.0.1", ui: false } });
}, 240_000);
afterAll(async () => {
  await env?.teardown();
  await new Promise<void>(resolve => collector.close(() => resolve()));
}, 30_000);

const attrs = (span: OtlpSpan) => Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value.stringValue ?? Number(attribute.value.intValue)]));

async function runTree(remaining = 0) {
  const before = collected.length;
  const spans = createOtlpSpanExporter({ endpoint, serviceName: "space-trace-test", flushIntervalMs: 60_000 });
  const tracing = workflowTracing(spans, workflowModule);
  const taskQueue = `trace-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath,
    activities: { traceProbe: async (input: { mode: string }) => {
      if (input.mode === "root" && Context.current().info.attempt === 1) throw ApplicationFailure.retryable(secret, "UPSTREAM_RETRYABLE_UNAVAILABLE");
      return "ok";
    } },
    interceptors: { activity: [createActivityObservabilityInterceptors({ spans })], workflowModules: tracing.workflowModules }, sinks: tracing.sinks
  });
  const observability = createHttpObservability({ serviceName: "space-api", spanExporter: spans });
  const app = Fastify();
  app.addHook("onRequest", async request => observability.onRequest(request));
  app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
  const registry = new TraceContextRegistry();
  const workflowId = `trace-root-${randomUUID()}`;
  let handle: ReturnType<typeof env.client.workflow.getHandle> | undefined;
  app.post("/start", async request => {
    registry.remember(request.id, traceContextForRawRequest(request.raw));
    const input = withTurnTraceparent({ traceId: request.id, remaining, secret }, registry);
    handle = await env.client.workflow.start("traceTreeWorkflow", { workflowId, taskQueue, args: [input] });
    return { result: await handle.result() };
  });
  try {
    const response = await worker.runUntil(() => app.inject({ method: "POST", url: "/start" }));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ result: "ok" });
    await spans.flush();
    const history = await handle!.fetchHistory();
    const output = collected.slice(before);
    // Every emitted identifier has a matching parent inside this real trace.
    const server = output.find(span => span.kind === 2)!;
    expect(server).toBeDefined();
    expect(new Set(output.map(span => span.traceId))).toEqual(new Set([server.traceId]));
    const ids = new Set(output.map(span => span.spanId));
    for (const span of output.filter(span => span !== server)) expect(ids.has(span.parentSpanId!), span.name).toBe(true);
    expect(JSON.stringify(output)).not.toContain(secret);
    return { output, history, workflowId, spans };
  } finally {
    await app.close(); observability.close(); await spans.close();
  }
}

it("exports a connected API/workflow/child/activity-attempt tree and replay emits nothing", async () => {
  const { output, history, workflowId } = await runTree();
  const server = output.find(span => span.kind === 2)!;
  const root = output.find(span => span.name === "workflow traceTreeWorkflow")!;
  const child = output.find(span => span.name === "workflow traceChildWorkflow")!;
  expect(root.parentSpanId).toBe(server.spanId); expect(child.parentSpanId).toBe(root.spanId);
  const attempts = output.filter(span => span.name === "activity traceProbe" && span.parentSpanId === root.spanId);
  expect(attempts).toHaveLength(2);
  expect(attempts.map(span => attrs(span)["space.attempt"]).sort()).toEqual([1, 2]);
  expect(attrs(attempts.find(span => attrs(span)["space.outcome"] === "FAILED")!)).toMatchObject({ "space.reason_code": "UPSTREAM_RETRYABLE_UNAVAILABLE", "space.category": "UPSTREAM_UNAVAILABLE" });
  expect(output.filter(span => span.name === "activity traceProbe" && span.parentSpanId === child.spanId)).toHaveLength(1);
  const replayExports: unknown[] = [];
  const replayTracing = workflowTracing({ record: span => replayExports.push(span), flush: async () => {}, close: async () => {}, stats: () => ({ exported: 0, failed: 0, dropped: 0 }) }, workflowModule);
  await Worker.runReplayHistory({ workflowsPath, interceptors: { workflowModules: replayTracing.workflowModules }, sinks: replayTracing.sinks }, history, workflowId);
  expect(replayExports).toEqual([]);
}, 60_000);

it("links continue-as-new to the previous run without breaking trace continuity", async () => {
  const { output } = await runTree(1);
  const roots = output.filter(span => span.name === "workflow traceTreeWorkflow");
  expect(roots).toHaveLength(2);
  const continued = roots.find(span => attrs(span)["space.outcome"] === "CONTINUED")!;
  const next = roots.find(span => span !== continued)!;
  expect(next.links).toEqual([{ traceId: continued.traceId, spanId: continued.spanId, attributes: [] }]);
}, 60_000);

it("keeps serial mission requests in their own traces and links a new background trace to its causal activity", async () => {
  const before = collected.length;
  const spans = createOtlpSpanExporter({ endpoint, serviceName: "space-worker", flushIntervalMs: 60_000 });
  const tracing = workflowTracing(spans, workflowModule);
  const taskQueue = `missions-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath,
    interceptors: { activity: [createActivityObservabilityInterceptors({ spans })], workflowModules: tracing.workflowModules }, sinks: tracing.sinks,
    activities: { traceProbe: async (input: { mode: string }) => input.mode === "link-source" ? currentActivityTraceparent()! : "ok" }
  });
  try {
    await worker.runUntil(() => env.client.workflow.execute("traceMissionWorkflow", { taskQueue, workflowId: `missions-${randomUUID()}`, args: [{
      first: { traceparent: `00-${"1".repeat(32)}-${"a".repeat(16)}-01` },
      second: { traceparent: `00-${"2".repeat(32)}-${"b".repeat(16)}-01` }, backgroundTraceId: "3".repeat(32)
    }] }));
    await spans.flush();
    const output = collected.slice(before);
    for (const [traceId, parentSpanId] of [["1".repeat(32), "a".repeat(16)], ["2".repeat(32), "b".repeat(16)]]) {
      const mission = output.find(span => span.traceId === traceId && span.name === "workflow traceMissionWorkflow")!;
      expect(mission.parentSpanId).toBe(parentSpanId);
      expect(output.find(span => span.traceId === traceId && span.name === "activity traceProbe")?.parentSpanId).toBe(mission.spanId);
    }
    const source = output.find(span => span.traceId === "2".repeat(32) && span.name === "activity traceProbe")!;
    const background = output.find(span => span.traceId === "3".repeat(32) && span.name === "workflow traceMissionWorkflow")!;
    expect(background.parentSpanId).toBeUndefined();
    expect(background.links).toEqual([{ traceId: source.traceId, spanId: source.spanId, attributes: [] }]);
    expect(output.find(span => span.traceId === "3".repeat(32) && span.name === "activity traceProbe")?.parentSpanId).toBe(background.spanId);
  } finally { await spans.close(); }
}, 60_000);

it("does no export when disabled and can replay a pre-tracing history without shifting application UUIDs", async () => {
  const before = collected.length;
  const tracing = workflowTracing(null, workflowModule);
  expect(tracing.workflowModules).toEqual([]); expect(tracing.sinks).toBeUndefined();
  const taskQueue = `disabled-${randomUUID()}`, workflowId = `uuid-${randomUUID()}`;
  const worker = await Worker.create({ connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowsPath,
    activities: { traceProbe: async () => "ok" }, interceptors: { activity: [createActivityObservabilityInterceptors({ spans: null })], workflowModules: tracing.workflowModules }
  });
  await worker.runUntil(() => env.client.workflow.execute("traceUuidWorkflow", { taskQueue, workflowId, args: [{}] }));
  const history = await env.client.workflow.getHandle(workflowId).fetchHistory();
  const replayExports: unknown[] = [];
  const enabled = workflowTracing({ record: span => replayExports.push(span), flush: async () => {}, close: async () => {}, stats: () => ({ exported: 0, failed: 0, dropped: 0 }) }, workflowModule);
  await Worker.runReplayHistory({ workflowsPath, interceptors: { workflowModules: enabled.workflowModules }, sinks: enabled.sinks }, history, workflowId);
  expect(replayExports).toEqual([]); expect(collected).toHaveLength(before);
}, 60_000);
