import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { bundleWorkflowCode, Worker, type WorkflowBundle } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowSpanSinks } from "../src/workflow-span-export.js";

interface ExportedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>; status: { code: number };
}
const traceId = "1234567890abcdef1234567890abcdef";
const apiSpanId = "1234567890abcdef";
const traceparent = `00-${traceId}-${apiSpanId}-01`;
const secret = "PRIVATE PROMPT /private/file https://private.example TOKEN=secret";
const attribute = (span: ExportedSpan, key: string) => {
  const value = span.attributes.find(item => item.key === key)?.value;
  return value?.stringValue ?? value?.intValue;
};

describe("real Temporal workflows export connected OTLP traces", () => {
  let env: TestWorkflowEnvironment;
  let collector: Server;
  let exporter: SpanExporter;
  let bundle: WorkflowBundle;
  const received: ExportedSpan[] = [];
  const bodies: string[] = [];
  beforeAll(async () => {
    collector = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      if (request.url !== "/v1/traces") { response.writeHead(404).end(); return; }
      bodies.push(body);
      const data = JSON.parse(body);
      for (const resource of data.resourceSpans) for (const scope of resource.scopeSpans) received.push(...scope.spans);
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    }).listen(0, "127.0.0.1");
    await once(collector, "listening");
    const address = collector.address() as { port: number };
    exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${address.port}`, serviceName: "space-worker-test", flushIntervalMs: 60_000 });
    env = await TestWorkflowEnvironment.createTimeSkipping();
    bundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./support/tracing-workflows.ts", import.meta.url)),
      workflowInterceptorModules: [fileURLToPath(new URL("../src/workflow-observability-interceptors.ts", import.meta.url))]
    });
  }, 120_000);
  afterAll(async () => {
    await exporter?.close();
    await env?.teardown();
    if (collector) await new Promise<void>((resolve, reject) => collector.close(error => error ? reject(error) : resolve()));
  });

  async function run(mode: "tree" | "continue" | "background" | "requests") {
    const start = received.length;
    const taskQueue = `trace-test-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
      activities: {
        echo: async () => "ok",
        retry: async () => {
          if (Context.current().info.attempt === 1) throw ApplicationFailure.retryable(secret, "UPSTREAM_RETRYABLE_UNAVAILABLE");
          return "ok";
        }
      },
      interceptors: { activity: [createActivityObservabilityInterceptors({ spans: exporter })] },
      sinks: workflowSpanSinks(exporter)
    });
    const handle = await env.client.workflow.start("tracingWorkflow", {
      workflowId: `trace-workflow-${randomUUID()}`, taskQueue,
      args: [{ traceparent, mode, prompt: secret, otherTraceparent: `00-${"f".repeat(32)}-${apiSpanId}-01` }]
    });
    await worker.runUntil(handle.result());
    await exporter.flush();
    return { spans: received.slice(start), handle };
  }

  it("connects the API span, workflow, every retry, local activity and child workflow; replay exports nothing", async () => {
    exporter.record({ traceId, spanId: apiSpanId, parentSpanId: null, name: "POST /api/turns", kind: 2,
      startTimeUnixNano: BigInt(Date.now()) * 1_000_000n, endTimeUnixNano: BigInt(Date.now()) * 1_000_000n, attributes: {}, error: false });
    await exporter.flush();
    const { spans, handle } = await run("tree");
    const root = spans.find(span => span.name === "workflow tracingWorkflow")!;
    const child = spans.find(span => span.name === "workflow tracingLeafWorkflow")!;
    expect(root.parentSpanId).toBe(apiSpanId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(spans.every(span => span.traceId === traceId)).toBe(true);
    const retries = spans.filter(span => span.name === "activity retry");
    expect(retries.map(span => attribute(span, "space.attempt")).sort()).toEqual(["1", "2"]);
    expect(retries.every(span => span.parentSpanId === root.spanId)).toBe(true);
    expect(attribute(retries.find(span => span.status.code === 2)!, "space.reason_code")).toBe("UPSTREAM_RETRYABLE_UNAVAILABLE");
    expect(spans.filter(span => span.name.startsWith("activity "))).toHaveLength(5);
    for (const span of spans.filter(span => span.name.startsWith("activity "))) expect([root.spanId, child.spanId]).toContain(span.parentSpanId);
    expect(bodies.join("")).not.toContain(secret);
    expect(bodies.join("")).not.toContain("private.example");
    const history = await handle.fetchHistory();
    const count = received.length;
    await Worker.runReplayHistory({ workflowBundle: bundle, sinks: workflowSpanSinks(exporter) }, history);
    await exporter.flush();
    expect(received).toHaveLength(count);
  }, 120_000);

  it("links continue-as-new runs to the previous run", async () => {
    const { spans } = await run("continue");
    const workflows = spans.filter(span => span.name === "workflow tracingWorkflow");
    expect(workflows).toHaveLength(2);
    const first = workflows.find(span => attribute(span, "space.outcome") === "CONTINUED_AS_NEW")!;
    const next = workflows.find(span => span !== first)!;
    expect(next.parentSpanId).toBeUndefined();
    expect(next.links).toContainEqual({ traceId: first.traceId, spanId: first.spanId });
  }, 120_000);

  it("links a background trace to its source, and keeps separate requests out of the supervisor's trace", async () => {
    const background = await run("background");
    const continued = background.spans.find(span => span.name === "workflow tracingLeafWorkflow")!;
    expect(continued.traceId).not.toBe(traceId);
    expect(continued.parentSpanId).toBeUndefined();
    expect(continued.links).toContainEqual({ traceId, spanId: apiSpanId });
    const requests = await run("requests");
    const other = requests.spans.find(span => span.name === "workflow tracingLeafWorkflow" && span.traceId === "f".repeat(32))!;
    expect(other.parentSpanId).toBe(apiSpanId);
  }, 120_000);
});
