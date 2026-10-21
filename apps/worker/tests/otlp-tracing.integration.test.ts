import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { createOtlpSpanExporter } from "@space/runtime";
import Fastify from "fastify";
import { createHttpObservability } from "../../api/src/observability.js";
import { traceContextForRawRequest } from "../../api/src/trace-context.js";
import { workerTracingOptions } from "../src/worker-tracing.js";
import { childTraceparent } from "../src/activity-observability.js";
import { parseTraceparent } from "@space/contracts";

interface ExportedSpan { traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>; status: { code: number } }
const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-workflows.ts", import.meta.url));
const traceId = "11111111111111111111111111111111";
const apiSpanId = "2222222222222222";
const traceparent = `00-${traceId}-${apiSpanId}-01`;

describe("real Temporal OTLP export", () => {
  let env: TestWorkflowEnvironment;
  let tracedBundle: WorkflowBundleWithSourceMap;
  let legacyBundle: WorkflowBundleWithSourceMap;
  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    tracedBundle = await bundleWorkflowCode({ workflowsPath,
      workflowInterceptorModules: [fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))] });
    legacyBundle = await bundleWorkflowCode({ workflowsPath });
  }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  async function run(options: { continue?: boolean; childTraceparent?: string; disabled?: boolean; workflow?: string;
    collectorMode?: "fail" | "slow"; legacy?: boolean; traceLink?: { traceId: string; spanId: string } } = {}) {
    const spans: ExportedSpan[] = [];
    const requests: string[] = [];
    const outboundParents: string[] = [];
    const collector = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(body);
      expect(request.url).toBe("/v1/traces");
      const data = JSON.parse(body);
      for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans) spans.push(...scope.spans);
      if (options.collectorMode === "slow") await new Promise(resolve => setTimeout(resolve, 100));
      response.writeHead(options.collectorMode === "fail" ? 503 : 200).end("{}");
    });
    await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address() as { port: number };
    const exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${address.port}`, serviceName: "space-worker", flushIntervalMs: 60_000,
      ...(options.collectorMode ? { timeoutMs: 20, batchSize: 1 } : {}) });
    const taskQueue = `otlp-${randomUUID()}`;
    const tracing = workerTracingOptions(options.disabled ? null : exporter);
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowBundle: options.legacy ? legacyBundle : tracedBundle,
      ...tracing,
      // Workflow interceptors are already included in the selected bundle.
      interceptors: { activity: tracing.interceptors!.activity },
      activities: { echo: async (value: unknown) => {
        const outbound = childTraceparent(undefined);
        if (outbound) outboundParents.push(outbound);
        return value;
      },
        retry: async () => { if (Context.current().info.attempt === 1) throw ApplicationFailure.retryable("PRIVATE", "ACTIVITY_TIMEOUT"); } } });
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: options.disabled ? null : exporter });
    const app = Fastify();
    app.addHook("onRequest", async request => observability.onRequest(request));
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    app.get("/trace", async request => {
      const requestParent = traceContextForRawRequest(request.raw).traceparent;
      const handle = await env.client.workflow.start(options.workflow ?? "tracedRoot", { taskQueue,
        workflowTaskTimeout: "30s",
        workflowId: `trace-${randomUUID()}`, args: [{ ...options, traceparent: requestParent }] });
      if (options.workflow === "tracedFailure") await expect(handle.result()).rejects.toThrow();
      else expect(await handle.result()).toBe("done");
      history = await handle.fetchHistory();
      return { ok: true };
    });
    let history;
    try {
      await worker.runUntil(async () => {
        expect((await app.inject({ url: "/trace", headers: { traceparent } })).statusCode).toBe(200);
      });
      await exporter.flush();
      const before = requests.length;
      // Replay a real recorded history, with the production interceptor loaded.
      await Worker.runReplayHistory({ workflowBundle: tracedBundle, sinks: tracing.sinks }, history!);
      const disabledReplay = workerTracingOptions(null);
      await Worker.runReplayHistory({ workflowBundle: tracedBundle, sinks: disabledReplay.sinks }, history!);
      await exporter.flush();
      expect(requests).toHaveLength(before);
      return { spans, requests, history, stats: exporter.stats(), outboundParents };
    } finally {
      await app.close();
      observability.close();
      await exporter.close();
      await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
    }
  }

  it("exports parent/child spans, activity retries and no replay duplicates", async () => {
    const { spans, requests, outboundParents } = await run();
    const workflows = spans.filter(span => span.name === "temporal.workflow");
    const api = spans.find(span => span.name === "GET /trace")!;
    expect(api.parentSpanId).toBe(apiSpanId);
    const root = workflows.find(span => span.parentSpanId === api.spanId)!;
    expect(root).toBeDefined();
    expect(workflows).toHaveLength(2);
    expect(workflows.find(span => span.spanId !== root.spanId)?.parentSpanId).toBe(root.spanId);
    expect(spans.every(span => span.traceId === traceId)).toBe(true);
    const attempts = spans.filter(span => span.attributes.some(attr => attr.key === "temporal.activity_type" && attr.value.stringValue === "retry"));
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map(span => span.spanId)).size).toBe(2);
    expect(attempts.every(span => span.parentSpanId === root.spanId)).toBe(true);
    expect(outboundParents).toHaveLength(2);
    for (const header of outboundParents) {
      const outgoing = parseTraceparent(header)!;
      expect(spans.some(span => span.name === "temporal.activity" && span.traceId === outgoing.traceId && span.spanId === outgoing.parentId)).toBe(true);
    }
    expect(requests.join("")).not.toMatch(/PRIVATE|\/home\/private|private.example/);
  }, 120_000);

  it("links continue-as-new to an actually exported preceding workflow span", async () => {
    const { spans } = await run({ continue: true });
    const linked = spans.find(span => span.links?.length)!;
    expect(linked).toBeDefined();
    expect(spans.some(span => span.traceId === linked.links![0]!.traceId && span.spanId === linked.links![0]!.spanId)).toBe(true);
  }, 120_000);

  it("exports a durable background link to a previously completed workflow span", async () => {
    const first = await run();
    const previous = first.spans.find(span => span.name === "temporal.workflow")!;
    const traceLink = { traceId: previous.traceId, spanId: previous.spanId };
    const second = await run({ traceLink });
    expect(second.spans.some(span => span.links?.some(link => link.traceId === traceLink.traceId && link.spanId === traceLink.spanId))).toBe(true);
  }, 120_000);

  it("parents a later request's child to that request even within the same trace", async () => {
    const laterApi = "3333333333333333";
    const { spans } = await run({ childTraceparent: `00-${traceId}-${laterApi}-01` });
    expect(spans.filter(span => span.name === "temporal.workflow").some(span => span.parentSpanId === laterApi)).toBe(true);
  }, 120_000);

  it("does not export when disabled", async () => {
    expect((await run({ disabled: true })).requests).toEqual([]);
  }, 120_000);

  it("replays a pre-instrumentation history without adding trace commands or spans", async () => {
    const { spans } = await run({ legacy: true });
    expect(spans.some(span => span.name === "temporal.workflow")).toBe(false);
  }, 120_000);

  it.each(["fail", "slow"] as const)("preserves workflow/activity results when the collector is %s", async collectorMode => {
    const { stats } = await run({ collectorMode });
    expect(stats.failed).toBeGreaterThan(0);
  }, 120_000);

  it("exports workflow failures without raw exception messages", async () => {
    const { spans, requests } = await run({ workflow: "tracedFailure" });
    expect(spans.find(span => span.name === "temporal.workflow")?.status.code).toBe(2);
    expect(requests.join("")).not.toContain("PRIVATE");
  }, 120_000);
});
