import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { createOtlpSpanExporter } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { workflowOtlpSinks } from "../src/workflow-otlp-sink.js";

const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-bounty-workflows.ts", import.meta.url));
const interceptorPath = fileURLToPath(new URL("../src/workflow-otlp-interceptors.ts", import.meta.url));
const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const apiSpanId = "00f067aa0ba902b7";
const traceparent = `00-${traceId}-${apiSpanId}-01`;
const secretPrompt = "PRIVATE PROMPT sk-real-secret-do-not-export";

let env: TestWorkflowEnvironment;
let server: Server;
let endpoint: string;
let posted: any[];
beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  posted = [];
  server = createServer(async (req, res) => {
    let data = "";
    for await (const chunk of req) data += chunk.toString("utf8");
    posted.push(JSON.parse(data));
    res.writeHead(200).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("collector HTTP port unavailable");
  endpoint = `http://127.0.0.1:${address.port}`;
}, 90_000);

afterAll(async () => {
  await env?.teardown();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
}, 90_000);

describe("OTLP API → Temporal workflow → child workflow → activity", () => {
  it("exports real spans through local HTTP, preserves W3C tree and excludes prompt text", async () => {
    posted.length = 0;
    const exporter = createOtlpSpanExporter({ endpoint, serviceName: "test-worker", flushIntervalMs: 60_000 });
    const taskQueue = `otlp-bounty-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowsPath,
      activities: { runSyntheticActivity: async () => "OK" },
      interceptors: {
        workflowModules: [interceptorPath],
        activity: [createActivityObservabilityInterceptors({ spans: exporter })]
      },
      sinks: workflowOtlpSinks(exporter)
    });
    try {
      let history: Awaited<ReturnType<ReturnType<typeof env.client.workflow.getHandle>["fetchHistory"]>> | undefined;
      const result = await worker.runUntil(async () => {
        const handle = await env.client.workflow.start("otlpBountyRootWorkflow",
          { workflowId: `otlp-${randomUUID()}`, taskQueue, args: [{ traceparent, prompt: secretPrompt }] });
        const output = await handle.result();
        history = await handle.fetchHistory();
        return output;
      });
      expect(result).toBe("OK");
      await exporter.flush();
      const spans = posted.flatMap(p => p.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
      expect(spans).toHaveLength(3);
      const root = spans.find((s: any) => s.name === "workflow otlpBountyRootWorkflow");
      const child = spans.find((s: any) => s.name === "workflow otlpBountyChildWorkflow");
      const activity = spans.find((s: any) => s.name === "activity runSyntheticActivity");
      expect(root?.traceId).toBe(traceId);
      expect(root?.parentSpanId).toBe(apiSpanId);
      expect(child?.parentSpanId).toBe(root?.spanId);
      expect(activity?.parentSpanId).toBe(child?.spanId);
      expect(spans.every((s: any) => s.traceId === traceId)).toBe(true);
      const text = JSON.stringify(posted);
      expect(text).not.toContain(secretPrompt);
      expect(text).not.toContain("sk-real-secret");
      const beforeReplay = JSON.stringify(posted);
      expect(history).toBeDefined();
      await Worker.runReplayHistory({
        workflowsPath, sinks: workflowOtlpSinks(exporter),
        interceptors: { workflowModules: [interceptorPath] }
      }, history!);
      await exporter.flush();
      expect(JSON.stringify(posted)).toBe(beforeReplay);
    } finally {
      await exporter.close();
    }
  }, 90_000);

  it("links the next Temporal run after continue-as-new without changing trace identity", async () => {
    posted.length = 0;
    const exporter = createOtlpSpanExporter({ endpoint, serviceName: "test-worker", flushIntervalMs: 60_000 });
    const taskQueue = `otlp-continued-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowsPath,
      activities: { runSyntheticActivity: async () => "OK" },
      interceptors: { workflowModules: [interceptorPath], activity: [createActivityObservabilityInterceptors({ spans: exporter })] },
      sinks: workflowOtlpSinks(exporter)
    });
    try {
      const result = await worker.runUntil(() => env.client.workflow.execute(
        "otlpBountyContinueWorkflow",
        { workflowId: `continued-${randomUUID()}`, taskQueue, args: [{ traceparent, generation: 0 }] }
      ));
      expect(result).toBe("OK");
      await exporter.flush();
      const spans = posted.flatMap(p => p.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
      expect(spans).toHaveLength(2);
      expect(spans.every((s: any) => s.traceId === traceId)).toBe(true);
      const first = spans.find((s: any) => s.parentSpanId === apiSpanId);
      const second = spans.find((s: any) => s.parentSpanId === first?.spanId);
      expect(first).toBeDefined();
      expect(second?.links).toEqual([{ traceId, spanId: first?.spanId }]);
    } finally {
      await exporter.close();
    }
  }, 90_000);

  it("gives a Temporal-only supervisor root a stable trace and traces its child/activity", async () => {
    posted.length = 0;
    const exporter = createOtlpSpanExporter({ endpoint, serviceName: "test-worker", flushIntervalMs: 60_000 });
    const taskQueue = `otlp-supervisor-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowsPath,
      activities: { runSyntheticActivity: async () => "OK" },
      interceptors: { workflowModules: [interceptorPath], activity: [createActivityObservabilityInterceptors({ spans: exporter })] },
      sinks: workflowOtlpSinks(exporter)
    });
    try {
      const result = await worker.runUntil(() => env.client.workflow.execute(
        "otlpBountySupervisorRootWorkflow",
        { workflowId: `supervisor-${randomUUID()}`, taskQueue, args: [{ prompt: secretPrompt }] }
      ));
      expect(result).toBe("OK");
      await exporter.flush();
      const spans = posted.flatMap(p => p.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
      expect(spans).toHaveLength(3);
      const root = spans.find((s: any) => s.name === "workflow otlpBountySupervisorRootWorkflow");
      const child = spans.find((s: any) => s.name === "workflow otlpBountyChildWorkflow");
      const activity = spans.find((s: any) => s.name === "activity runSyntheticActivity");
      expect(root).toBeDefined();
      expect(root.parentSpanId).toBeUndefined();
      expect(root.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(child?.parentSpanId).toBe(root.spanId);
      expect(activity?.parentSpanId).toBe(child?.spanId);
      expect(spans.every((s: any) => s.traceId === root.traceId)).toBe(true);
      expect(JSON.stringify(posted)).not.toContain(secretPrompt);
    } finally { await exporter.close(); }
  }, 90_000);

  it("links a separate background continuation trace to the preceding W3C context without exporting any source text", async () => {
    posted.length = 0;
    const exporter = createOtlpSpanExporter({ endpoint, serviceName: "test-worker", flushIntervalMs: 60_000 });
    const taskQueue = `otlp-background-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue, workflowsPath,
      activities: { runSyntheticActivity: async () => "OK" },
      interceptors: { workflowModules: [interceptorPath], activity: [createActivityObservabilityInterceptors({ spans: exporter })] },
      sinks: workflowOtlpSinks(exporter)
    });
    const previousTraceId = "abcdef0123456789abcdef0123456789";
    const previousSpanId = "1234567890abcdef";
    try {
      const result = await worker.runUntil(() => env.client.workflow.execute(
        "otlpBountyBackgroundWorkflow",
        { workflowId: `background-${randomUUID()}`, taskQueue,
          args: [{
            traceparent, roomAgentContinuation: {
              sourceRunId: "agent_run:prior", generation: 1,
              sourceTraceparent: `00-${previousTraceId}-${previousSpanId}-01`
            }, prompt: secretPrompt
          }] }
      ));
      expect(result).toBe("READY");
      await exporter.flush();
      const spans = posted.flatMap(p => p.resourceSpans.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)));
      expect(spans).toHaveLength(1);
      expect(spans[0].traceId).toBe(traceId);
      expect(spans[0].links).toContainEqual({ traceId: previousTraceId, spanId: previousSpanId });
      expect(JSON.stringify(posted)).not.toContain(secretPrompt);
    } finally { await exporter.close(); }
  }, 90_000);
});
