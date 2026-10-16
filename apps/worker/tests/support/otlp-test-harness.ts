import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Worker, type WorkflowBundle } from "@temporalio/worker";
import { createWorkerTracing, type WorkerTracingOptions } from "../../src/worker-tracing.js";

export interface CollectedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  status: { code: number };
  attributes: Array<{ key: string; value: { stringValue?: string; intValue?: string; boolValue?: boolean } }>;
  links?: Array<{ traceId: string; spanId: string }>;
}

export function attributes(span: CollectedSpan): Record<string, string | boolean | undefined> {
  return Object.fromEntries(span.attributes.map(({ key, value }) => [key, value.stringValue ?? value.intValue ?? value.boolValue]));
}

/** Real loopback HTTP collector. Captured bodies are the bytes the exporter sends. */
export async function startOtlpCollector(mode: "ok" | "reject" | "hold" = "ok") {
  const bodies: any[] = [];
  const pending: ServerResponse[] = [];
  let held = mode === "hold";
  const respond = (response: ServerResponse) => {
    response.writeHead(mode === "ok" ? 200 : 503, { "content-type": "application/json" });
    response.end("{}");
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (held) pending.push(response);
      else respond(response);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    bodies,
    release: () => { held = false; for (const response of pending.splice(0)) respond(response); },
    spans: (): CollectedSpan[] => bodies.flatMap((body) => body.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans))),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

const bundles = new Map<boolean, Promise<WorkflowBundle>>();
export function otlpWorkflowBundle(traced = true): Promise<WorkflowBundle> {
  let bundle = bundles.get(traced);
  if (!bundle) {
    bundle = bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./otlp-workflows.ts", import.meta.url)),
      workflowInterceptorModules: traced ? [fileURLToPath(new URL("../../src/workflow-tracing.ts", import.meta.url))] : [],
      logger: new DefaultLogger("ERROR")
    });
    bundles.set(traced, bundle);
  }
  return bundle;
}

export interface OtlpHarnessContext {
  env: TestWorkflowEnvironment;
  collector: Awaited<ReturnType<typeof startOtlpCollector>>;
  tracing: ReturnType<typeof createWorkerTracing>;
  taskQueue: string;
  start(type: string, args: unknown[], memo?: Record<string, unknown>): Promise<WorkflowHandle>;
  collectUntil(predicate: (spans: CollectedSpan[]) => boolean): Promise<CollectedSpan[]>;
}

export async function withOtlpHarness(
  activities: Record<string, (...args: any[]) => any>,
  run: (context: OtlpHarnessContext) => Promise<void>,
  options: { enabled?: boolean; collectorMode?: "ok" | "reject" | "hold"; memoryQueues?: boolean; exporter?: WorkerTracingOptions["exporter"] } = {}
) {
  const enabled = options.enabled !== false;
  const workflowBundle = await otlpWorkflowBundle(enabled);
  const collector = await startOtlpCollector(options.collectorMode);
  const tracing = createWorkerTracing("space-worker-test", {
    env: enabled ? { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: collector.endpoint } : {},
    workflowModule: fileURLToPath(new URL("../../src/workflow-tracing.ts", import.meta.url)),
    exporter: { flushIntervalMs: 60_000, batchSize: 1024, maxQueue: 4096, timeoutMs: 500, ...options.exporter }
  });
  let env: TestWorkflowEnvironment | undefined;
  const handles: WorkflowHandle[] = [];
  try {
    env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-otlp-client" } });
    const currentEnv = env;
    const taskQueue = `otlp-${randomUUID()}`;
    const queues = options.memoryQueues ? [taskQueue, "space-memory-maintenance", "space-memory-mutations"] : [taskQueue];
    const workers = await Promise.all(queues.map((queue) => Worker.create({
      connection: currentEnv.nativeConnection, taskQueue: queue, workflowBundle, activities,
      identity: "synthetic-otlp-worker", shutdownGraceTime: 0,
      ...tracing.workerOptions,
      // Workflow modules were included by bundleWorkflowCode above.
      interceptors: { activity: tracing.workerOptions.interceptors?.activity }
    })));
    const context: OtlpHarnessContext = {
      env: currentEnv, collector, tracing, taskQueue,
      start: async (type, args, memo) => {
        const handle = await currentEnv.client.workflow.start(type, { workflowId: `otlp-${randomUUID()}`, taskQueue, args, memo });
        handles.push(handle);
        return handle;
      },
      collectUntil: async (predicate) => {
        const deadline = Date.now() + 10_000;
        do {
          await tracing.flush();
          const spans = collector.spans();
          if (predicate(spans)) return spans;
          await new Promise((resolve) => setTimeout(resolve, 10));
        } while (Date.now() < deadline);
        throw new Error("Expected OTLP spans were not exported within 10 seconds");
      }
    };
    const execute = async () => {
      try { await run(context); }
      finally {
        await Promise.all(handles.map(async (handle) => {
          try { await currentEnv.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test cleanup"); } catch { /* already closed */ }
        }));
      }
    };
    const runWorkers = (index: number): Promise<void> => index === workers.length
      ? execute()
      : workers[index]!.runUntil(() => runWorkers(index + 1));
    await runWorkers(0);
  } finally {
    collector.release();
    await tracing.close();
    await env?.teardown();
    await collector.close();
  }
}
