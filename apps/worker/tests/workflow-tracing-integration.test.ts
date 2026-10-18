import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter, isAllowlistedSpanAttributeKey, type ServerSpan, type SpanExporter } from "@space/runtime";
import { workerTracingOptions } from "../src/worker-tracing.js";
import { recordTraceActivity } from "./workflow-tracing-activity.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "00f067aa0ba902b7";
const missionTraceId = "0af7651916cd43dd8448eb211c80319c";
const missionApiSpanId = "b7ad6b7169203331";
const backgroundTraceId = "70f9a911b4c44a4ab7b3e7b9f4e4d7a1";
const backgroundApiSpanId = "1111111111111111";
const workflowPath = fileURLToPath(new URL("./workflow-tracing-fixture.ts", import.meta.url));
const interceptorPath = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));

let environment: TestWorkflowEnvironment;
let collector: Server;
let collectorEndpoint: string;
let payloads: Array<Record<string, unknown>>;

async function startCollector(): Promise<void> {
  payloads = [];
  collector = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      payloads.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200).end();
    });
  });
  collector.listen(0, "127.0.0.1");
  await once(collector, "listening");
  const address = collector.address();
  if (!address || typeof address === "string") throw new Error("Collector did not bind to a TCP port.");
  collectorEndpoint = `http://127.0.0.1:${address.port}`;
}

function makeExporter(recorded: ServerSpan[]): SpanExporter {
  const exporter = createOtlpSpanExporter({
    endpoint: collectorEndpoint,
    serviceName: "space-worker-test",
    flushIntervalMs: 60_000
  });
  return {
    record(span) { recorded.push(span); exporter.record(span); },
    flush: () => exporter.flush(),
    close: () => exporter.close(),
    stats: () => exporter.stats()
  };
}

function collectorSpans(): Array<Record<string, unknown>> {
  return payloads.flatMap(payload => {
    const resourceSpans = payload.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>;
    return resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans));
  });
}

beforeEach(() => { payloads = []; });

beforeAll(async () => {
  await startCollector();
  environment = await TestWorkflowEnvironment.createLocal();
}, 120_000);

afterAll(async () => {
  await environment?.teardown();
  if (collector?.listening) await new Promise<void>(resolve => collector.close(() => resolve()));
}, 30_000);

describe("Temporal OTLP workflow tracing", () => {
  it("connects API, workflow, retry attempts, child continuation and replay through a fake collector", async () => {
    const apiExporter = createOtlpSpanExporter({
      endpoint: collectorEndpoint,
      serviceName: "space-api-test",
      flushIntervalMs: 60_000
    });
    apiExporter.record({
      traceId,
      spanId: apiSpanId,
      parentSpanId: null,
      name: "POST /api/rooms/:roomId/agent-turns",
      startTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
      endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
      attributes: {
        "http.request.method": "POST",
        "http.route": "/api/rooms/:roomId/agent-turns",
        "http.response.status_code": 202,
        "space.request_id": "req:trace-integration"
      },
      error: false
    });
    for (const [requestTraceId, requestSpanId] of [[missionTraceId, missionApiSpanId], [backgroundTraceId, backgroundApiSpanId]]) {
      apiExporter.record({ traceId: requestTraceId!, spanId: requestSpanId!, parentSpanId: null,
        name: "POST /api/rooms/:roomId/agent-turns", kind: 2,
        startTimeUnixNano: BigInt(Date.now()) * 1_000_000n, endTimeUnixNano: BigInt(Date.now()) * 1_000_000n,
        attributes: { "http.request.method": "POST", "http.route": "/api/rooms/:roomId/agent-turns" }, error: false });
    }
    await apiExporter.close();

    const recorded: ServerSpan[] = [];
    const exporter = makeExporter(recorded);
    const tracing = workerTracingOptions(exporter, interceptorPath);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "trace-integration",
      workflowsPath: workflowPath,
      activities: { recordTraceActivity },
      ...tracing
    });
    const run = worker.run();
    try {
      const workflowId = "trace-integration:mission-1";
      const handle = await environment.client.workflow.start("tracedWorkflow", {
        workflowId,
        taskQueue: "trace-integration",
        args: [{
          missionTraceparent: `00-${missionTraceId}-${missionApiSpanId}-01`,
          backgroundTraceparent: `00-${backgroundTraceId}-${backgroundApiSpanId}-01`,
          roomAgentContinuation: { sourceRunId: "agent_run:source1", generation: 1 },
          prompt: "PRIVATE PROMPT: never export this content",
          modelOutput: "PRIVATE MODEL OUTPUT: never export this",
          filePath: "/private/users/alice/project/secret.txt",
          rawUrl: "https://private.example/path?token=PRIVATE_URL_TOKEN",
          userText: "PRIVATE USER TEXT: never export this"
        }],
        memo: { traceparent: `00-${traceId}-${apiSpanId}-01` }
      });
      await expect(handle.result()).resolves.toBe("done");
      const history = await handle.fetchHistory();
      await Worker.runReplayHistory({ workflowsPath: workflowPath, ...tracing }, history, workflowId);
      expect(recorded).toHaveLength(7);

      await exporter.flush();

      const spans = collectorSpans();
      expect(spans).toHaveLength(10);
      const spanIndex = new Set(spans.map(span => `${span.traceId}:${span.spanId}`));
      for (const span of spans) {
        if (span.parentSpanId) expect(spanIndex.has(`${span.traceId}:${span.parentSpanId}`)).toBe(true);
        for (const attribute of span.attributes as Array<{ key: string }>) expect(isAllowlistedSpanAttributeKey(attribute.key)).toBe(true);
      }
      const apiSpan = spans.find(span => span.spanId === apiSpanId)!;
      expect(apiSpan).toMatchObject({
        traceId,
        name: "POST /api/rooms/:roomId/agent-turns",
        kind: 2,
        status: { code: 0 }
      });
      const workflow = spans.find(span => span.name === "tracedWorkflow")!;
      const children = spans.filter(span => span.name === "tracedChildWorkflow");
      const activities = spans.filter(span => span.name === "activity recordTraceActivity");
      expect(workflow).toMatchObject({ traceId, parentSpanId: apiSpanId, kind: 1 });
      expect(activities).toHaveLength(4);
      const rootActivity = activities.find(span => {
        const attributes = Object.fromEntries((span.attributes as Array<{ key: string; value: { stringValue?: string } }>).map(item => [item.key, item.value.stringValue]));
        return attributes["space.outcome"] === "FAILED";
      });
      expect(rootActivity).toBeDefined();
      expect(rootActivity!.parentSpanId).toBe(workflow.spanId);
      expect((rootActivity!.attributes as Array<{ key: string; value: { stringValue?: string } }>)).toContainEqual({
        key: "space.reason_code", value: { stringValue: "UPSTREAM_RETRYABLE_UNAVAILABLE" }
      });
      expect(children).toHaveLength(2);
      const missionChild = children.find(span => span.traceId === missionTraceId)!;
      expect(missionChild.parentSpanId).toBe(missionApiSpanId);
      expect(missionChild.links).toContainEqual(expect.objectContaining({
        traceId,
        spanId: workflow.spanId,
        attributes: [{ key: "link.reason", value: { stringValue: "room_agent_mission" } }]
      }));
      const backgroundChild = children.find(span => span.traceId === backgroundTraceId)!;
      expect(backgroundChild.parentSpanId).toBe(backgroundApiSpanId);
      expect(backgroundChild.links).toContainEqual(expect.objectContaining({
        traceId,
        spanId: workflow.spanId,
        attributes: [{ key: "link.reason", value: { stringValue: "room_agent_mission" } }]
      }));
      expect(backgroundChild.links).toContainEqual(expect.objectContaining({
        traceId: missionChild.traceId,
        spanId: missionChild.spanId,
        attributes: [{ key: "link.reason", value: { stringValue: "background_continuation" } }]
      }));
      const backgroundAttributes = Object.fromEntries(
        (backgroundChild.attributes as Array<{ key: string; value: { stringValue?: string } }>).map(item => [item.key, item.value.stringValue])
      );
      expect(backgroundAttributes["space.source_run_id"]).toBe("agent_run:source1");
      expect(JSON.stringify(payloads)).not.toContain("PRIVATE PROMPT");
      expect(JSON.stringify(payloads)).not.toContain("never export this content");
      expect(JSON.stringify(payloads)).not.toContain("PRIVATE MODEL OUTPUT");
      expect(JSON.stringify(payloads)).not.toContain("/private/users/alice");
      expect(JSON.stringify(payloads)).not.toContain("PRIVATE_URL_TOKEN");
      expect(JSON.stringify(payloads)).not.toContain("PRIVATE USER TEXT");
      expect(JSON.stringify(payloads)).not.toContain("PRIVATE ERROR MESSAGE");
    } finally {
      await worker.shutdown();
      await run;
      await exporter.close();
    }
  }, 120_000);

  it("links a continued-as-new workflow run to its prior run", async () => {
    const recorded: ServerSpan[] = [];
    const exporter = makeExporter(recorded);
    const tracing = workerTracingOptions(exporter, interceptorPath);
    const worker = await Worker.create({
      connection: environment.nativeConnection,
      namespace: environment.namespace,
      taskQueue: "trace-continue-integration",
      workflowsPath: workflowPath,
      activities: { recordTraceActivity },
      ...tracing
    });
    const run = worker.run();
    try {
      const handle = await environment.client.workflow.start("continuedWorkflow", {
        workflowId: "trace-integration:continue-1",
        taskQueue: "trace-continue-integration",
        args: [{ count: 0 }],
        memo: { traceparent: `00-${traceId}-${apiSpanId}-01` }
      });
      await expect(handle.result()).resolves.toBe("continued-done");
      await exporter.flush();

      const spans = collectorSpans().filter(span => span.name === "continuedWorkflow");
      expect(spans).toHaveLength(2);
      const continued = spans.find(span => (span.attributes as Array<{ key: string; value: { stringValue?: string } }>).some(
        item => item.key === "space.status" && item.value.stringValue === "CONTINUED_AS_NEW"
      ))!;
      const nextRun = spans.find(span => span !== continued)!;
      expect(nextRun.parentSpanId).toBe(continued.spanId);
      expect(nextRun.links).toContainEqual(expect.objectContaining({
        traceId,
        spanId: continued.spanId,
        attributes: [{ key: "link.reason", value: { stringValue: "continue_as_new" } }]
      }));
    } finally {
      await worker.shutdown();
      await run;
      await exporter.close();
    }
  }, 120_000);
});
