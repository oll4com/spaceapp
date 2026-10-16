import { otlpSpanExporterFromEnv } from "@space/telemetry";
import { workerTracingOptions } from "./worker-tracing.js";
import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { executePersistedMemoryChangeSet } from "./memory-mutation-activity.js";
import { MEMORY_MUTATION_TASK_QUEUE, memoryMutationsEnabled, memoryMutationWorkerOptions } from "./memory-mutation-config.js";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";

const service = "space-memory-mutation-worker";

if (!memoryMutationsEnabled(process.env)) {
  console.log(JSON.stringify({ service, status: "disabled" }));
} else {
  const spanExporter = otlpSpanExporterFromEnv(process.env, service, "space-temporal");
  const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  const connection = await NativeConnection.connect({ address });
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: MEMORY_MUTATION_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./memory-mutation-workflows.js", import.meta.url)),
    activities: { executePersistedMemoryChangeSet },
    ...memoryMutationWorkerOptions,
    ...(spanExporter ? workerTracingOptions(spanExporter) : {})
  });
  console.log(JSON.stringify({ service, status: "running", address, namespace, taskQueue: MEMORY_MUTATION_TASK_QUEUE }));
  try { await worker.run(); } finally { await spanExporter?.close(); }
}
