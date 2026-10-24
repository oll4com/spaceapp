import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowTracingSinks } from "../src/workflow-tracing-sink.js";

describe("multiple HTTP requests to a long-lived supervisor", () => {
  it("keeps later requests in their own trace and links them back to the supervisor", async () => {
    const payloads: unknown[] = [];
    const collector = createServer((req, res) => {
      let body = "";
      req.on("data", chunk => { body += String(chunk); });
      req.on("end", () => { payloads.push(JSON.parse(body)); res.writeHead(200).end("ok"); });
    });
    await new Promise<void>(resolve => collector.listen(0, "127.0.0.1", resolve));
    const address = collector.address();
    if (!address || typeof address === "string") throw new Error("Missing port");
    const exporter = createOtlpSpanExporter({
      endpoint: "http://127.0.0.1:" + address.port, serviceName: "space-worker",
      flushIntervalMs: 60000
    });
    let environment: TestWorkflowEnvironment | undefined;
    try {
      environment = await TestWorkflowEnvironment.createTimeSkipping();
      const workflowFile = fileURLToPath(new URL("./fixtures/workflow-signal-tracing-fixture.ts", import.meta.url));
      const moduleFile = fileURLToPath(new URL("../src/workflow-tracing-interceptors.ts", import.meta.url));
      const worker = await Worker.create({
        connection: environment.nativeConnection,
        taskQueue: "space-otlp-supervisor-fixture",
        workflowsPath: workflowFile,
        activities: { traceActivity: async (input: { marker?: string; item?: { turn: { marker: string } } }) =>
          input.marker ?? input.item?.turn.marker ?? "" },
        interceptors: {
          activity: [createActivityObservabilityInterceptors({ spans: exporter })],
          workflowModules: [moduleFile]
        },
        sinks: workflowTracingSinks(exporter)
      });
      const firstTrace = "11111111111111111111111111111111";
      const secondTrace = "22222222222222222222222222222222";
      const firstApi = "111111111111111a";
      const secondApi = "222222222222222b";
      const id = "space-long-supervisor-fixture";
      const item = (trace: string, parent: string, marker: string) => ({
        turn: { traceparent: "00-" + trace + "-" + parent + "-01", marker, prompt: "SENSITIVE PROMPT" }
      });
      const result = await worker.runUntil(async () => {
        const handle = await environment!.client.workflow.signalWithStart("roomAgentSupervisorWorkflow", {
          workflowId: id, taskQueue: "space-otlp-supervisor-fixture",
          args: [], signal: "queue-mission",
          signalArgs: [item(firstTrace, firstApi, "a")]
        });
        await handle.signal("queue-mission", item(secondTrace, secondApi, "b"));
        return handle.result();
      });
      expect(result).toBe("aabb");
      await exporter.flush();
      const spans = payloads.flatMap(p =>
        (p as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }> })
          .resourceSpans.flatMap(r => r.scopeSpans.flatMap(s => s.spans))
      );
      const supervisor = spans.find(s => s.name === "workflow roomAgentSupervisorWorkflow");
      expect(supervisor).toMatchObject({ traceId: firstTrace, parentSpanId: firstApi });
      const children = spans.filter(s => s.name === "workflow traceSupervisorChild");
      expect(children).toHaveLength(2);
      const childA = children.find(s => s.traceId === firstTrace);
      const childB = children.find(s => s.traceId === secondTrace);
      expect(childA).toMatchObject({ parentSpanId: supervisor!.spanId });
      expect(childB).toMatchObject({ parentSpanId: secondApi });
      expect(childB?.links).toContainEqual({ traceId: firstTrace, spanId: supervisor!.spanId });
      const secondActivities = spans.filter(s => s.name === "activity traceActivity" && s.traceId === secondTrace);
      expect(secondActivities.length).toBeGreaterThanOrEqual(2);
      expect(secondActivities.some(s => s.parentSpanId === secondApi)).toBe(true);
      expect(secondActivities.some(s => s.parentSpanId === childB!.spanId)).toBe(true);
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
      await new Promise<void>(resolve => collector.close(() => resolve()));
    }
  }, 240000);
});
