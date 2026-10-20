import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowObservabilitySinks } from "../src/workflow-observability-sinks.js";

const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const parentId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${parentId}-01`;
const secret = "prompt-that-must-never-be-exported";

const allowedAttributes = new Set([
  "space.workflow_type", "space.workflow_id", "space.run_id", "space.status",
  "space.room_id", "space.pane_id", "space.mission_id",
  "space.activity_type", "space.outcome", "space.attempt",
  "space.reason_code", "space.category", "space.duration_ms"
]);

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  attributes: Array<{ key: string; value?: { stringValue?: string; intValue?: string } }>;
  links?: Array<{ traceId: string; spanId: string }>;
}

describe("workflow OTLP export", () => {
  let env: TestWorkflowEnvironment;
  let server: Server;
  let exporter: SpanExporter;
  let bodies: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> }>;
  let paths: string[] = [];

  const received = (): OtlpSpan[] =>
    bodies.flatMap(body => body.resourceSpans.flatMap(resource => resource.scopeSpans.flatMap(scope => scope.spans)));

  beforeAll(async () => {
    bodies = [];
    server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { raw += chunk; });
      request.on("end", () => {
        paths.push(request.url ?? "");
        bodies.push(JSON.parse(raw));
        response.writeHead(200, { "content-type": "application/json" }).end("{}");
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    exporter = createOtlpSpanExporter({
      endpoint: `http://127.0.0.1:${port}/`,
      serviceName: "space-worker",
      batchSize: 64
    });
    env = await TestWorkflowEnvironment.createLocal();
  }, 240_000);

  afterAll(async () => {
    await exporter?.close();
    await env?.teardown();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  function worker() {
    return Worker.create({
      connection: env.nativeConnection,
      taskQueue: "workflow-otlp-test",
      workflowsPath: fileURLToPath(new URL("./fixtures/workflow-observability.workflow.ts", import.meta.url)),
      activities: { ping: async () => "pong" },
      interceptors: {
        activity: [createActivityObservabilityInterceptors({ spans: exporter })],
        workflowModules: [fileURLToPath(new URL("../src/workflow-observability.ts", import.meta.url))]
      },
      sinks: workflowObservabilitySinks(exporter)
    });
  }

  it("posts one API trace with a workflow, child workflow and activity span", async () => {
    bodies = [];
    paths = [];
    const running = await worker();
    await running.runUntil(async () => {
      await env.client.workflow.execute("traceChild", {
        taskQueue: "workflow-otlp-test",
        workflowId: `workflow-otlp-${Date.now()}`,
        args: [{ traceparent, prompt: secret }]
      });
    });
    await exporter.flush();

    const spans = received();
    expect(paths.every(path => path === "/v1/traces")).toBe(true);
    expect(spans.map(span => span.name).sort()).toEqual(["activity ping", "workflow traceChild", "workflow tracePing"]);
    const parent = spans.find(span => span.name === "workflow traceChild")!;
    const child = spans.find(span => span.name === "workflow tracePing")!;
    const activity = spans.find(span => span.name === "activity ping")!;
    expect(spans.every(span => span.traceId === traceId)).toBe(true);
    expect(parent.parentSpanId).toBe(parentId);
    expect(child.parentSpanId).toBe(parent.spanId);
    expect(activity.parentSpanId).toBe(child.spanId);
    expect(JSON.stringify(bodies)).not.toContain(secret);
    for (const span of spans) for (const attribute of span.attributes) expect(allowedAttributes.has(attribute.key)).toBe(true);
    expect(activity.attributes.map(attribute => attribute.key)).toEqual(expect.arrayContaining([
      "space.reason_code", "space.category", "space.duration_ms"
    ]));
    expect(parent.attributes.map(attribute => attribute.key)).toContain("space.duration_ms");
  }, 180_000);

  it("exports the continue-as-new link", async () => {
    bodies = [];
    const running = await worker();
    await running.runUntil(async () => {
      await env.client.workflow.execute("traceContinue", {
        taskQueue: "workflow-otlp-test",
        workflowId: `workflow-otlp-continue-${Date.now()}`,
        args: [{ traceparent, generation: 0 }]
      });
    });
    await exporter.flush();

    const workflowSpans = received().filter(span => span.name === "workflow traceContinue");
    expect(workflowSpans).toHaveLength(2);
    expect(workflowSpans[1].links).toContainEqual({ traceId, spanId: workflowSpans[0].spanId });
  }, 180_000);

  it("exports the background continuation link from the turn input", async () => {
    bodies = [];
    const link = { traceId: "c".repeat(32), spanId: "d".repeat(16) };
    const running = await worker();
    await running.runUntil(async () => {
      await env.client.workflow.execute("traceBackground", {
        taskQueue: "workflow-otlp-test",
        workflowId: `workflow-otlp-background-${Date.now()}`,
        args: [{ traceLink: link }]
      });
    });
    await exporter.flush();

    const workflowSpan = received().find(span => span.name === "workflow traceBackground");
    expect(workflowSpan).toBeDefined();
    expect(workflowSpan!.links).toContainEqual(link);
  }, 180_000);

  it("exports room, pane and mission identifiers and never the prompt", async () => {
    bodies = [];
    const running = await worker();
    await running.runUntil(async () => {
      await env.client.workflow.execute("traceCorrelated", {
        taskQueue: "workflow-otlp-test",
        workflowId: `workflow-otlp-correlated-${Date.now()}`,
        args: [{ traceparent, roomId: "room:otlp01", paneId: "pane:otlp01", roomAgentMissionId: "mission:otlp01", prompt: secret }]
      });
    });
    await exporter.flush();

    const spans = received();
    const workflowSpan = spans.find(span => span.name === "workflow traceCorrelated")!;
    const activitySpan = spans.find(span => span.name === "activity ping")!;
    const stringAttributes = (span: OtlpSpan) =>
      Object.fromEntries(span.attributes.map(attribute => [attribute.key, attribute.value?.stringValue]));
    for (const span of [workflowSpan, activitySpan]) {
      expect(stringAttributes(span)).toMatchObject({
        "space.room_id": "room:otlp01", "space.pane_id": "pane:otlp01", "space.mission_id": "mission:otlp01"
      });
      for (const attribute of span.attributes) expect(allowedAttributes.has(attribute.key)).toBe(true);
    }
    expect(JSON.stringify(bodies)).not.toContain(secret);
  }, 180_000);
});
