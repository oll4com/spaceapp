/** Local manual proof: real HTTP + Temporal, stub executor, no provider/DB credentials. */
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { createOtlpSpanExporter } from "@space/runtime/otlp-span-exporter";
import { createWorkerTracing } from "../src/worker-tracing.js";
import { createHttpObservability } from "../../api/src/observability.js";
import { requestTraceContexts, traceContextForRawRequest } from "../../api/src/trace-context.js";
import { TemporalCodexAppServerTurnStarter } from "../../api/src/turns.js";

const endpoint = process.env.SPACE_OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://127.0.0.1:4318";
if (new URL(endpoint).hostname !== "127.0.0.1") throw new Error("This proof only exports synthetic data to a loopback collector.");
const env = await TestWorkflowEnvironment.createTimeSkipping();
const tracing = createWorkerTracing("space-worker", { SPACE_OTEL_EXPORTER_OTLP_ENDPOINT: endpoint });
const exporter = createOtlpSpanExporter({ endpoint, serviceName: "space-api" });
const observation = createHttpObservability({ serviceName: "space-api", spanExporter: exporter });
const app = Fastify({ genReqId: () => "req:local-otlp-proof" });
app.addHook("onRequest", async req => { requestTraceContexts.remember(req.id, traceContextForRawRequest(req.raw)); observation.onRequest(req); });
app.addHook("onResponse", async (req, reply) => observation.onResponse(req, reply));
const starter = new TemporalCodexAppServerTurnStarter({ address: "local-test", namespace: "default", taskQueue: "otlp-proof",
  clientFactory: async () => ({ client: env.client, close: async () => undefined }) });
let traceId: string | undefined;
app.post("/proof/turn", async req => {
  traceId = requestTraceContexts.lookup(req.id)?.w3cTraceId;
  const started = await starter.start({ roomId: "room:local-proof", paneId: "pane:local-proof", traceId: req.id,
    prompt: "Synthetic manual tracing proof", artifactIds: [] });
  return env.client.workflow.getHandle(started.workflowId).result();
});
try {
  const workflowBundle = await bundleWorkflowCode({ workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
    workflowInterceptorModules: [fileURLToPath(new URL("../src/workflow-tracing.ts", import.meta.url))] });
  const worker = await Worker.create({ connection: env.nativeConnection, taskQueue: "otlp-proof", workflowBundle, ...tracing.options,
    activities: { runCodexAppServerTurn: async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { status: "COMPLETED" }; } } });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address() as { port: number };
  await worker.runUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/proof/turn`, { method: "POST" });
    if (!response.ok || (await response.json() as { status: string }).status !== "COMPLETED") throw new Error("Proof turn failed");
  });
  await Promise.all([tracing.close(), exporter.close()]);
  console.log(JSON.stringify({ traceId, jaeger: `http://127.0.0.1:16686/trace/${traceId}`, api: exporter.stats(), worker: tracing.exporter?.stats() }));
} finally { await app.close(); observation.close(); await Promise.all([tracing.close(), exporter.close()]); await env.teardown(); }
