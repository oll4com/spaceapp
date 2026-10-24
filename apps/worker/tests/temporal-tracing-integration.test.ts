import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowTracingSinks } from "../src/workflow-tracing-sink.js";

/** A real Temporal time-skipping test server, with no Docker, secrets or LLM.
 * Replaying the history must emit no network spans.
 */
describe("end-to-end Temporal OTLP tracing", () => {
  it("links API, parent, child, and activity attempts and suppresses replay exports", async () => {
    const payloads: unknown[] = [];
    const collector = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += String(chunk); });
      req.on("end", () => {
        payloads.push(JSON.parse(body));
        res.writeHead(200).end("ok");
      });
    });
    await new Promise<void>((resolve) => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (!address || typeof address === "string") throw new Error("No collector port");
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:" + address.port,
      serviceName: "space-worker", flushIntervalMs: 60_000
    });
    let environment: TestWorkflowEnvironment | undefined;
    try {
      environment = await TestWorkflowEnvironment.createTimeSkipping();
      const workflowFile = fileURLToPath(new URL("./fixtures/workflow-tracing-fixture.ts", import.meta.url));
      const moduleFile = fileURLToPath(new URL("../src/workflow-tracing-interceptors.ts", import.meta.url));
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: "space-otlp-fixture",
        workflowsPath: workflowFile,
        activities: { traceFixtureActivity: async (input: { marker: string }) => input.marker },
        interceptors: {
          activity: [createActivityObservabilityInterceptors({ spans: exporter })],
          workflowModules: [moduleFile]
        },
        sinks: workflowTracingSinks(exporter)
      });
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const apiSpanId = "00f067aa0ba902b7";
      const id = "trace-otlp-fixture-root";
      const result = await worker.runUntil(() => environment!.client.workflow.execute(
        "traceFixtureRoot",
        { taskQueue: "space-otlp-fixture", workflowId: id,
          args: [{ traceparent: "00-" + traceId + "-" + apiSpanId + "-01" }] }
      ));
      expect(result).toBe("rootchild");
      await exporter.flush();
      const spans = payloads.flatMap(p =>
        (p as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> })
          .resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans))
      );
      const workflowSpans = spans.filter(s => String(s.name).startsWith("workflow "));
      const activitySpans = spans.filter(s => String(s.name).startsWith("activity "));
      expect(workflowSpans).toHaveLength(2);
      expect(activitySpans).toHaveLength(2);
      const root = workflowSpans.find(s => s.name === "workflow traceFixtureRoot");
      const child = workflowSpans.find(s => s.name === "workflow traceFixtureChild");
      expect(root).toMatchObject({ traceId, parentSpanId: apiSpanId });
      expect(child).toMatchObject({ traceId, parentSpanId: root!.spanId });
      const rootActivity = activitySpans.find(s => s.parentSpanId === root!.spanId);
      const childActivity = activitySpans.find(s => s.parentSpanId === child!.spanId);
      expect(rootActivity).toBeDefined();
      expect(childActivity).toBeDefined();
      expect(JSON.stringify(payloads)).not.toContain("SENSITIVE PROMPT");

      const history = await environment.client.workflow.getHandle(id).fetchHistory();
      const before = payloads.length;
      await Worker.runReplayHistory({
        workflowsPath: workflowFile,
        interceptors: { workflowModules: [moduleFile] },
        sinks: workflowTracingSinks(exporter)
      }, history, id);
      await exporter.flush();
      expect(payloads).toHaveLength(before);
    } finally {
      await exporter.close();
      await environment?.teardown();
      await new Promise<void>((resolve) => collector.close(() => resolve()));
    }
  }, 240000);
});
