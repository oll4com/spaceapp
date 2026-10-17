import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { otlpSpanExporterFromEnv } from "@space/runtime";
import { executePersistedMemoryChangeSet } from "./memory-mutation-activity.js";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { createTracingSinks, resolveWorkflowTracingInterceptorPath } from "./worker-tracing.js";
import { MEMORY_MUTATION_TASK_QUEUE, memoryMutationsEnabled, memoryMutationWorkerOptions } from "./memory-mutation-config.js";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";

const service = "space-memory-mutation-worker";

if (!memoryMutationsEnabled(process.env)) {
  console.log(JSON.stringify({ service, status: "disabled" }));
} else {
  const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  const spans = otlpSpanExporterFromEnv(process.env, service);

  try {
    const connection = await NativeConnection.connect({ address });
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowsPath: fileURLToPath(new URL("./memory-mutation-workflows.js", import.meta.url)),
      activities: { executePersistedMemoryChangeSet },
      ...memoryMutationWorkerOptions,
      sinks: createTracingSinks(spans),
      interceptors: { activity: [createActivityObservabilityInterceptors({ spans })], workflowModules: [resolveWorkflowTracingInterceptorPath()] }
    });
    console.log(JSON.stringify({ service, status: "running", address, namespace, taskQueue: MEMORY_MUTATION_TASK_QUEUE }));
    await worker.run();
  } finally {
    await spans?.close();
  }
}
