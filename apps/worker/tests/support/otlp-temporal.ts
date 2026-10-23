// A fake OTLP/HTTP collector on loopback plus Temporal workers that run the
// production workflow modules with the production tracing options. Used by the
// OTLP trace tests; no Docker, no AI provider and no live Space service.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultLogger, Runtime, Worker, type WorkerOptions } from "@temporalio/worker";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import { otlpSpanExporterFromEnv, type SpanExporter } from "@space/runtime";
import { workerTracingOptions } from "../../src/worker-tracing.js";

// Keep test output to errors; the SDK logs every state change and expected activity failure.
try { Runtime.install({ logger: new DefaultLogger("ERROR") }); } catch { /* already installed in this process */ }

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
/** Absolute path of a worker source module, such as a workflow file. */
export const workerSource = (name: string) => fileURLToPath(new URL(`../../src/${name}`, import.meta.url));

/** Bundle @space/* from packages/<name>/src, as the source-tree worker does. */
export const bundlerOptions: WorkerOptions["bundlerOptions"] = {
  webpackConfigHook: (config) => {
    const alias: Record<string, string> = {};
    for (const name of readdirSync(path.join(repoRoot, "packages"))) {
      const source = path.join(repoRoot, "packages", name, "src", "index.ts");
      if (existsSync(source)) alias[`@space/${name}$`] = source;
    }
    return { ...config, resolve: { ...config.resolve, alias: { ...(config.resolve?.alias as Record<string, string> | undefined), ...alias } } };
  }
};

export interface OtlpAttribute { key: string; value: { stringValue?: string; intValue?: string } }
export interface CollectedSpan {
  service: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  links?: Array<{ traceId: string; spanId: string; attributes: OtlpAttribute[] }>;
  status: { code: number };
}

export type CollectorMode = "ok" | "fail" | "hang";

export interface FakeCollector {
  url: string;
  /** Raw request bodies, for allowlist checks over everything that left the process. */
  bodies: string[];
  paths: string[];
  spans(): CollectedSpan[];
  mode: CollectorMode;
  close(): Promise<void>;
}

/** An OTLP/HTTP JSON collector: a plain http.createServer on 127.0.0.1. */
export async function startFakeCollector(mode: CollectorMode = "ok"): Promise<FakeCollector> {
  const bodies: string[] = [];
  const paths: string[] = [];
  const hanging = new Set<ServerResponse>();
  const collector: FakeCollector = {
    url: "",
    bodies,
    paths,
    mode,
    spans: () => bodies.flatMap((body) => {
      const parsed = JSON.parse(body) as { resourceSpans: Array<{ resource: { attributes: OtlpAttribute[] }; scopeSpans: Array<{ spans: CollectedSpan[] }> }> };
      return parsed.resourceSpans.flatMap((resource) => {
        const service = resource.resource.attributes.find((attribute) => attribute.key === "service.name")?.value.stringValue ?? "";
        return resource.scopeSpans.flatMap((scope) => scope.spans.map((span) => ({ ...span, service })));
      });
    }),
    close: async () => {
      for (const response of hanging) response.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      paths.push(`${request.method} ${request.url}`);
      if (collector.mode === "hang") { hanging.add(response); return; }
      if (collector.mode === "fail") { response.writeHead(500).end(); return; }
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  collector.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return collector;
}

/** The value of attribute `key` on a collected span (integers as numbers). */
export const attr = (span: { attributes: OtlpAttribute[] }, key: string): string | number | undefined => {
  const value = span.attributes.find((attribute) => attribute.key === key)?.value;
  if (!value) return undefined;
  return value.intValue !== undefined ? Number(value.intValue) : value.stringValue;
};

export interface TracedWorker {
  worker: Worker;
  spans: SpanExporter;
}

/**
 * One Temporal worker with the same options the production entry point builds
 * from SPACE_OTEL_EXPORTER_OTLP_ENDPOINT. `service` is the entry point's
 * service name, so the collector sees which process exported each span.
 */
export async function tracedWorker(env: TestWorkflowEnvironment, options: {
  collectorUrl: string | null;
  service: string;
  taskQueue: string;
  workflows: string;
  activities: object;
  /** An exporter to use instead of the one SPACE_OTEL_EXPORTER_OTLP_ENDPOINT would configure. */
  exporter?: SpanExporter;
}): Promise<TracedWorker> {
  const spans = options.exporter ?? (options.collectorUrl
    ? otlpSpanExporterFromEnv({ SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: options.collectorUrl }, options.service)
    : null);
  const worker = await Worker.create({
    connection: env.nativeConnection,
    namespace: env.namespace ?? "default",
    taskQueue: options.taskQueue,
    workflowsPath: workerSource(options.workflows),
    activities: options.activities,
    bundlerOptions,
    ...workerTracingOptions(spans)
  });
  return { worker, spans: spans! };
}

/** Runs the workers until `body` settles, then drains their exporters. */
export async function runTraced<T>(workers: TracedWorker[], body: () => Promise<T>): Promise<T> {
  let result!: T;
  const pending = [...workers];
  /** Runs worker `index` until the remaining workers and `body` finish. */
  const run = async (index: number): Promise<void> => {
    const current = pending[index];
    if (!current) {
      result = await body();
      return;
    }
    await current.worker.runUntil(run(index + 1));
  };
  await run(0);
  await Promise.all(workers.map((traced) => traced.spans?.close()));
  return result;
}
