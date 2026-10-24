// A non-Temporal error from the workflow function or a signal/update handler
// fails the workflow task: Temporal retries it while the execution keeps
// running, so it must not be exported as a completed FAILED span. A Temporal
// failure is a real outcome and is exported.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { WorkflowFailedError, WorkflowUpdateFailedError, type WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOtlpSpanExporter, type SpanExporter } from "@space/runtime";
import { deterministicWorkflowSpanId } from "../src/temporal-trace-context.js";
import { createWorkerTracing } from "../src/worker-tracing.js";

const workflowInterceptorModule = fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url));
const workflowsPath = fileURLToPath(new URL("./fixtures/otlp-task-failure-workflows.ts", import.meta.url));
const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

interface OtlpSpan {
  traceId: string; spanId: string; parentSpanId?: string; name: string;
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string } }>;
}
const attrs = (span: OtlpSpan) => Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? ""]));

interface TracedWorker {
  taskQueue: string;
  executions: Record<string, number>;
  spans: SpanExporter;
  exported: () => OtlpSpan[];
  requests: () => number;
}

describe("OTLP and workflow-task failures", () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: WorkflowBundleWithSourceMap;
  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    env = await TestWorkflowEnvironment.createTimeSkipping();
    workflowBundle = await bundleWorkflowCode({ workflowsPath, workflowInterceptorModules: [workflowInterceptorModule], logger: new DefaultLogger("ERROR") });
  }, 120_000);
  afterAll(async () => { await env?.teardown(); });

  async function withTracedWorker<T>(run: (worker: TracedWorker) => Promise<T>): Promise<T> {
    const bodies: Array<{ resourceSpans: Array<{ scopeSpans: Array<{ spans: OtlpSpan[] }> }> }> = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += String(chunk);
      bodies.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const spans = createOtlpSpanExporter({
      endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, serviceName: "space-worker", flushIntervalMs: 60_000
    });
    const tracing = createWorkerTracing(spans, { workflowInterceptorModule });
    const executions: Record<string, number> = {};
    const taskQueue = `otlp-task-failure-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace, taskQueue, workflowBundle,
      ...tracing, interceptors: { ...tracing.interceptors, workflowModules: [] }, activities: {},
      sinks: {
        ...tracing.sinks,
        taskFailureProbe: { executed: { fn: (_info, entry: string) => { executions[entry] = (executions[entry] ?? 0) + 1; }, callDuringReplay: true } }
      }
    });
    try {
      return await worker.runUntil(run({
        taskQueue, executions, spans,
        exported: () => bodies.flatMap((b) => b.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans))),
        requests: () => bodies.length
      }));
    } finally {
      await spans.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }

  // History shows the failed task; a second execution shows Temporal retried it.
  async function retriedTaskFailure(handle: WorkflowHandle, executions: Record<string, number>, entry: string): Promise<string> {
    await expect.poll(async () => (await handle.fetchHistory()).events!.some((event) => event.workflowTaskFailedEventAttributes),
      { timeout: 30_000 }).toBe(true);
    await expect.poll(() => executions[entry] ?? 0, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    return (await handle.describe()).status.name;
  }

  async function firstTaskCompleted(handle: WorkflowHandle): Promise<void> {
    await expect.poll(async () => (await handle.fetchHistory()).events!.some((event) => event.workflowTaskCompletedEventAttributes),
      { timeout: 30_000 }).toBe(true);
  }

  // Captured before the execution is terminated for cleanup.
  async function capture(worker: TracedWorker, status: string) {
    await worker.spans.flush();
    return { status, stats: worker.spans.stats(), requests: worker.requests(), spans: worker.exported() };
  }

  it("exports no span while a workflow function's failed task is retried", async () => {
    const result = await withTracedWorker(async (worker) => {
      const handle = await env.client.workflow.start("traceTaskFailureWorkflow", { taskQueue: worker.taskQueue, workflowId: worker.taskQueue, memo: { traceparent } });
      const observed = await capture(worker, await retriedTaskFailure(handle, worker.executions, "workflow"));
      await handle.terminate("test cleanup");
      return observed;
    });
    expect(result).toEqual({ status: "RUNNING", stats: { exported: 0, dropped: 0, failed: 0 }, requests: 0, spans: [] });
  }, 120_000);

  it("exports no span while a signal handler's failed task is retried", async () => {
    const result = await withTracedWorker(async (worker) => {
      const handle = await env.client.workflow.start("traceHandlerFailureWorkflow", { taskQueue: worker.taskQueue, workflowId: worker.taskQueue, memo: { traceparent } });
      await firstTaskCompleted(handle);
      await handle.signal("plainErrorSignal");
      const observed = await capture(worker, await retriedTaskFailure(handle, worker.executions, "signal"));
      await handle.terminate("test cleanup");
      return observed;
    });
    expect(result).toEqual({ status: "RUNNING", stats: { exported: 0, dropped: 0, failed: 0 }, requests: 0, spans: [] });
  }, 120_000);

  it("exports no span while an update handler's failed task is retried", async () => {
    const result = await withTracedWorker(async (worker) => {
      const handle = await env.client.workflow.start("traceHandlerFailureWorkflow", { taskQueue: worker.taskQueue, workflowId: worker.taskQueue, memo: { traceparent } });
      await firstTaskCompleted(handle);
      const update = handle.executeUpdate("plainErrorUpdate").then(() => "completed", () => "rejected");
      const observed = await capture(worker, await retriedTaskFailure(handle, worker.executions, "update"));
      await handle.terminate("test cleanup");
      await Promise.race([update, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      return observed;
    });
    expect(result).toEqual({ status: "RUNNING", stats: { exported: 0, dropped: 0, failed: 0 }, requests: 0, spans: [] });
  }, 120_000);

  it("rejects an update that throws a Temporal failure and exports a FAILED update span", async () => {
    const result = await withTracedWorker(async (worker) => {
      const handle = await env.client.workflow.start("traceHandlerFailureWorkflow", { taskQueue: worker.taskQueue, workflowId: worker.taskQueue, memo: { traceparent } });
      const rejection = await handle.executeUpdate("applicationFailureUpdate").then(() => null, (error: unknown) => error);
      const observed = await capture(worker, (await handle.describe()).status.name);
      await handle.terminate("test cleanup");
      return { ...observed, rejection, runId: handle.firstExecutionRunId };
    });
    expect(result.rejection).toBeInstanceOf(WorkflowUpdateFailedError);
    expect(result.status).toBe("RUNNING");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: deterministicWorkflowSpanId(result.runId!) });
    expect(result.spans[0]!.name).toBe("workflow traceHandlerFailureWorkflow update");
    expect(attrs(result.spans[0]!)).toMatchObject({
      "space.outcome": "FAILED", "space.reason_code": "TOOL_UNAVAILABLE", "space.update_name": "applicationFailureUpdate"
    });
  }, 120_000);

  it("exports a FAILED run span when the workflow function throws a Temporal failure", async () => {
    const result = await withTracedWorker(async (worker) => {
      const handle = await env.client.workflow.start("traceTerminalFailureWorkflow", { taskQueue: worker.taskQueue, workflowId: worker.taskQueue, memo: { traceparent } });
      const failure = await handle.result().then(() => null, (error: unknown) => error);
      return { ...(await capture(worker, (await handle.describe()).status.name)), failure };
    });
    expect(result.failure).toBeInstanceOf(WorkflowFailedError);
    expect(result.status).toBe("FAILED");
    expect(result.spans).toHaveLength(1);
    expect(result.spans[0]).toMatchObject({ traceId: "4bf92f3577b34da6a3ce929d0e0e4736", parentSpanId: "00f067aa0ba902b7" });
    expect(attrs(result.spans[0]!)).toMatchObject({ "space.outcome": "FAILED", "space.reason_code": "TOOL_UNAVAILABLE" });
  }, 120_000);

  it("exports the FAILED signal span when a signal handler's Temporal failure ends the workflow", async () => {
    const result = await withTracedWorker(async (worker) => {
      const handle = await env.client.workflow.start("traceHandlerFailureWorkflow", { taskQueue: worker.taskQueue, workflowId: worker.taskQueue, memo: { traceparent } });
      await firstTaskCompleted(handle);
      await handle.signal("applicationFailureSignal");
      const failure = await handle.result().then(() => null, (error: unknown) => error);
      return { ...(await capture(worker, (await handle.describe()).status.name)), failure };
    });
    expect(result.failure).toBeInstanceOf(WorkflowFailedError);
    expect(result.status).toBe("FAILED");
    // The workflow function never returns, so the run span is not exported
    // (docs/quality/observability.md, Traces).
    expect(result.spans.map((span) => span.name)).toEqual(["workflow traceHandlerFailureWorkflow signal"]);
    expect(attrs(result.spans[0]!)).toMatchObject({
      "space.outcome": "FAILED", "space.reason_code": "TOOL_UNAVAILABLE", "space.signal_name": "applicationFailureSignal"
    });
  }, 120_000);
});
