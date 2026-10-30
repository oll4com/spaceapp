import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import Fastify from "fastify";
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { describe, expect, it } from "vitest";
import { createOtlpSpanExporter } from "@space/runtime";
import { createHttpObservability } from "../../api/src/observability.js";
import { traceContextForRawRequest } from "../../api/src/trace-context.js";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { createWorkflowTraceSinks } from "../src/workflow-tracing-sink.js";

const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-workflows.ts", import.meta.url));
const workflowModules = [fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))];
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;

interface CollectedSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
  links?: { traceId: string; spanId: string }[];
}

describe("real Temporal OTLP trace structure", () => {
  it("connects an HTTP SERVER span, workflow, retries and child; replay emits no spans", async () => {
    const collected: CollectedSpan[] = [];
    const collector = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      for (const resource of body.resourceSpans) for (const scope of resource.scopeSpans) collected.push(...scope.spans);
      // Optional local Jaeger proof, using only this test's synthetic data.
      const jaegerEndpoint = process.env.SPACE_TEMPORAL_TEST_JAEGER;
      if (jaegerEndpoint) {
        const target = new URL(jaegerEndpoint);
        if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)) throw new Error("Test collector forwarding must be loopback");
        const forwarded = await fetch(new URL("/v1/traces", target), {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000)
        });
        if (!forwarded.ok) throw new Error("Local Jaeger rejected test traces");
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    collector.listen(0, "127.0.0.1");
    await once(collector, "listening");
    const port = (collector.address() as { port: number }).port;
    const exporter = createOtlpSpanExporter({ endpoint: `http://127.0.0.1:${port}`, serviceName: "space-test", batchSize: 1 });
    // The collector uses wall time, so keep the local Temporal server on the
    // same clock. Time skipping would make trace durations misleading.
    const environment = await TestWorkflowEnvironment.createLocal().catch(async (error: unknown) => {
      await exporter.close();
      await new Promise<void>(resolve => collector.close(() => resolve()));
      throw error;
    });
    const workerOptions = {
      connection: environment.nativeConnection, taskQueue: "otlp-test", workflowsPath,
      activities: {
        tracedRetry: async () => {
          if (Context.current().info.attempt === 1) throw new Error("PRIVATE-CONTROL error message");
          return "ok";
        },
        recordDummyTurnStarted: async () => undefined,
        recordDummyTurnCompleted: async () => ({ status: "COMPLETED" })
      },
      sinks: createWorkflowTraceSinks(exporter),
      interceptors: { workflowModules, activity: [createActivityObservabilityInterceptors({ spans: exporter })] }
    };
    const observability = createHttpObservability({ serviceName: "space-api", spanExporter: exporter });
    const app = Fastify();
    app.addHook("onRequest", async request => observability.onRequest(request));
    app.addHook("onResponse", async (request, reply) => observability.onResponse(request, reply));
    app.get("/trace-test", async request => {
      const context = traceContextForRawRequest(request.raw);
      return environment.client.workflow.execute("tracedRoot", {
        workflowId: "otlp-root", taskQueue: "otlp-test",
        args: [{ traceparent: context.traceparent, prompt: "PRIVATE-CONTROL prompt" }]
      });
    });
    try {
      const worker = await Worker.create(workerOptions);
      await worker.runUntil(async () => {
        const result = await app.inject({ method: "GET", url: "/trace-test", headers: { traceparent } });
        expect(result.statusCode).toBe(200);
        expect(result.body).toBe("complete");
      });
      await exporter.flush();
      const server = collected.find(span => span.name === "GET /trace-test")!;
      const root = collected.find(span => span.name === "workflow tracedRoot")!;
      const child = collected.find(span => span.name === "workflow dummyTurnWorkflow")!;
      expect(server).toMatchObject({ traceId, parentSpanId: parentId });
      expect(root).toMatchObject({ traceId, parentSpanId: server.spanId });
      expect(child).toMatchObject({ traceId, parentSpanId: root.spanId });
      expect(collected.filter(span => span.name.startsWith("workflow "))).toHaveLength(2);
      const retries = collected.filter(span => span.name === "activity tracedRetry");
      expect(retries).toHaveLength(2);
      expect(retries.map(span => span.attributes.find(a => a.key === "space.attempt")?.value.intValue).sort()).toEqual(["1", "2"]);
      expect(retries.every(span => span.traceId === traceId && span.parentSpanId === root.spanId)).toBe(true);
      const childActivities = collected.filter(span => span.name.startsWith("activity recordDummyTurn"));
      expect(childActivities).toHaveLength(2);
      expect(childActivities.every(span => span.parentSpanId === child.spanId)).toBe(true);
      expect(JSON.stringify(collected)).not.toContain("PRIVATE-CONTROL");
      const beforeReplay = collected.length;
      const history = await environment.client.workflow.getHandle("otlp-root").fetchHistory();
      await Worker.runReplayHistory({ workflowsPath, interceptors: { workflowModules }, sinks: createWorkflowTraceSinks(exporter) }, history);
      await exporter.flush();
      expect(collected).toHaveLength(beforeReplay);

      const continuationWorker = await Worker.create(workerOptions);
      await continuationWorker.runUntil(() => environment.client.workflow.execute("tracedContinuation", {
        workflowId: "otlp-continuation", taskQueue: "otlp-test", args: [{ traceparent, generation: 0 }]
      }));
      await exporter.flush();
      const runs = collected.filter(span => span.name === "workflow tracedContinuation");
      expect(runs).toHaveLength(2);
      expect(runs[0]!.spanId).not.toBe(runs[1]!.spanId);
      expect(runs[1]!.links).toContainEqual({ traceId, spanId: runs[0]!.spanId });
    } finally {
      await app.close();
      observability.close();
      await exporter.close();
      await environment.teardown();
      await new Promise<void>(resolve => collector.close(() => resolve()));
    }
  }, 120_000);
});
