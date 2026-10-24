import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowSpanId } from "../src/workflow-span-ids.js";
import { workflowTracingSinks } from "../src/workflow-tracing-sink.js";

describe("OTLP links between Temporal runs", () => {
  it("links continue-as-new and roots a background trace against the prior workflow", async () => {
    const payloads: unknown[] = [];
    const collector = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => { payloads.push(JSON.parse(body)); res.writeHead(200).end("ok"); });
    });
    await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (!address || typeof address === "string") throw new Error("Missing collector address");
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:" + address.port,
      serviceName: "space-worker", flushIntervalMs: 60000
    });
    let environment: TestWorkflowEnvironment | undefined;
    try {
      environment = await TestWorkflowEnvironment.createTimeSkipping();
      const workflowFile = fileURLToPath(new URL("./fixtures/workflow-tracing-fixture.ts", import.meta.url));
      const moduleFile = fileURLToPath(new URL("../src/workflow-tracing-interceptors.ts", import.meta.url));
      let retryAttempts = 0;
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: "space-otlp-continuation-fixture",
        workflowsPath: workflowFile,
        activities: { traceFixtureActivity: async (input: { marker: string }) => {
          if (input.marker === "retry" && ++retryAttempts === 1) throw new Error("SENSITIVE SYNTHETIC FAILURE");
          return input.marker;
        } },
        interceptors: {
          activity: [createActivityObservabilityInterceptors({ spans: exporter })],
          workflowModules: [moduleFile]
        },
        sinks: workflowTracingSinks(exporter)
      });
      const trace = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
      const backgroundTrace = "dddddddddddddddddddddddddddddddd";
      const api = "aaaaaaaaaaaaaaaa";
      const sourceRunId = "agent_run:source-example";
      const sourceTemporalRunId = "abcdefab-cdef-4fab-8fab-abcdefabcdef";
      const firstRun = "continue-fixture";
      const bgRun = "background-fixture";
      const retryRun = "retry-fixture";
      await worker.runUntil(async () => {
        const continued = await environment!.client.workflow.execute("traceFixtureContinue", {
          taskQueue: "space-otlp-continuation-fixture", workflowId: firstRun,
          args: [{ traceparent: "00-" + trace + "-" + api + "-01", remaining: 1 }]
        });
        expect(continued).toBe("final");
        const result = await environment!.client.workflow.execute("traceFixtureBackground", {
          taskQueue: "space-otlp-continuation-fixture", workflowId: bgRun,
          args: [{
            traceparent: "00-" + backgroundTrace + "-bbbbbbbbbbbbbbbb-01",
            roomAgentContinuation: {
              generation: 1, sourceRunId, sourceTemporalRunId,
              sourceTraceparent: "00-" + trace + "-" + api + "-01"
            }
          }]
        });
        expect(result).toBe("background");
        const noTemporalIdResult = await environment!.client.workflow.execute("traceFixtureBackground", {
          taskQueue: "space-otlp-continuation-fixture", workflowId: "background-without-temporal-id",
          args: [{
            traceparent: "00-" + backgroundTrace + "-bbbbbbbbbbbbbbbb-01",
            roomAgentContinuation: {
              generation: 1, sourceRunId,
              sourceTraceparent: "00-" + trace + "-" + api + "-01"
            }
          }]
        });
        expect(noTemporalIdResult).toBe("background");
        const retryResult = await environment!.client.workflow.execute("traceFixtureRetry", {
          taskQueue: "space-otlp-continuation-fixture", workflowId: retryRun,
          args: [{ traceparent: "00-" + trace + "-" + api + "-01" }]
        });
        expect(retryResult).toBe("retry");
      });
      await exporter.flush();
      const spans = payloads.flatMap(p =>
        (p as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> })
          .resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans))
      );
      const continued = spans.filter(s => s.name === "workflow traceFixtureContinue");
      expect(continued).toHaveLength(2);
      expect(continued[0]?.traceId).toBe(trace);
      expect(continued[1]?.traceId).toBe(trace);
      expect(continued[0]?.parentSpanId).toBe(api);
      expect(continued[1]?.parentSpanId).toBe(continued[0]?.spanId);
      expect(continued[1]?.links).toContainEqual({ traceId: trace, spanId: continued[0]?.spanId });

      const bg = spans.find(s => s.name === "workflow traceFixtureBackground");
      expect(bg?.traceId).toBe(backgroundTrace);
      expect(bg?.parentSpanId).toBeUndefined();
      expect(bg?.links).toContainEqual({ traceId: trace, spanId: workflowSpanId(sourceTemporalRunId) });
      const missingTemporalSpan = spans.find(s => s.name === "workflow traceFixtureBackground" &&
        s.traceId === backgroundTrace && s.spanId !== bg?.spanId);
      expect(missingTemporalSpan).toBeDefined();
      expect(missingTemporalSpan?.links).toBeUndefined();
      const bgActivity = spans.find(s => s.name === "activity traceFixtureActivity" && s.traceId === backgroundTrace);
      expect(bgActivity?.parentSpanId).toBe(bg?.spanId);
      const retryWorkflow = spans.find(s => s.name === "workflow traceFixtureRetry");
      const retryActivitySpans = spans.filter(s =>
        s.name === "activity traceFixtureActivity" && s.parentSpanId === retryWorkflow?.spanId);
      expect(retryActivitySpans).toHaveLength(2);
      const attempts = retryActivitySpans.map(s =>
        (s.attributes as Array<{ key: string; value: { intValue?: string; stringValue?: string } }>)
          .find(a => a.key === "space.attempt")?.value.intValue).sort();
      expect(attempts).toEqual(["1", "2"]);
      expect(retryActivitySpans.every(s => s.traceId === trace)).toBe(true);
      expect(retryActivitySpans.map(s => (s.status as { code: number }).code).sort()).toEqual([0, 2]);
      expect(JSON.stringify(payloads)).not.toContain("SENSITIVE PROMPT");
      expect(JSON.stringify(payloads)).not.toContain("SENSITIVE SYNTHETIC FAILURE");
    } finally {
      await exporter.close();
      await environment?.teardown();
      await new Promise<void>(resolve => collector.close(() => resolve()));
    }
  }, 240000);
});
