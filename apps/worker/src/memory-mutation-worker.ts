import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import { executePersistedMemoryChangeSet } from "./memory-mutation-activity.js";
import { MEMORY_MUTATION_TASK_QUEUE, memoryMutationsEnabled, memoryMutationWorkerOptions } from "./memory-mutation-config.js";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";
import { otlpSpanExporterFromEnv } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { reloadWhenServicesCommitChanges } from "./deployed-code-reload.js";
import { createWorkflowObservabilitySinks, workflowObservabilityInterceptorsPath } from "./workflow-observability.js";

const service = "space-memory-mutation-worker";

if (!memoryMutationsEnabled(process.env)) {
  console.log(JSON.stringify({ service, status: "disabled" }));
} else {
  const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  const connection = await NativeConnection.connect({ address });
  const spans = otlpSpanExporterFromEnv(process.env, service);
  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue: MEMORY_MUTATION_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL("./memory-mutation-workflows.js", import.meta.url)),
    activities: { executePersistedMemoryChangeSet },
    ...memoryMutationWorkerOptions,
    interceptors: {
      workflowModules: [workflowObservabilityInterceptorsPath],
      activity: [createActivityObservabilityInterceptors({ spans })]
    },
    sinks: createWorkflowObservabilitySinks({ spans })
  });
  console.log(JSON.stringify({ service, status: "running", address, namespace, taskQueue: MEMORY_MUTATION_TASK_QUEUE }));
  const stopReloadWatch = reloadWhenServicesCommitChanges(worker, { log: (message) => console.log(JSON.stringify({ service, status: "reloading", message })) });
  try {
    await worker.run();
  } finally {
    stopReloadWatch();
    await spans?.close();
  }
}
