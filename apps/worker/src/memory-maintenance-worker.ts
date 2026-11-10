import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./memory-maintenance-activities.js";
import {
  MEMORY_MAINTENANCE_TASK_QUEUE,
  memoryMaintenanceEnabled,
  memoryMaintenanceWorkerOptions
} from "./memory-maintenance-config.js";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";
import { otlpSpanExporterFromEnv, redactSecretText } from "@space/runtime";
import { createActivityObservabilityInterceptors } from "./activity-observability.js";
import { resolveWorkerMetricsListen, startWorkerMetricsServer } from "./worker-metrics.js";
import { reloadWhenServicesCommitChanges } from "./deployed-code-reload.js";

const service = "space-memory-maintenance-worker";

if (!memoryMaintenanceEnabled(process.env)) {
  console.log(JSON.stringify({ service, status: "disabled" }));
} else {
  const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  const workflowsPath = fileURLToPath(new URL("./memory-maintenance-workflows.js", import.meta.url));

  try {
    const connection = await NativeConnection.connect({ address });
    const spans = otlpSpanExporterFromEnv(process.env, service);
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath,
      activities,
      ...memoryMaintenanceWorkerOptions,
      interceptors: { activity: [createActivityObservabilityInterceptors({ spans })] }
    });
    console.log(JSON.stringify({
      service,
      status: "running",
      address,
      namespace,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      activityConcurrency: memoryMaintenanceWorkerOptions.maxConcurrentActivityTaskExecutions
    }));
    // Its activity counters on their own loopback endpoint, like the main worker's (OBS-007); a bind failure never stops the worker.
    const metricsListen = resolveWorkerMetricsListen(process.env, "SPACE_MEMORY_MAINTENANCE_METRICS_PORT");
    if (metricsListen) console.log(JSON.stringify({ service, metricsEndpoint: (await startWorkerMetricsServer(metricsListen)) ? "LISTENING" : "UNAVAILABLE", port: metricsListen.port }));
    const stopReloadWatch = reloadWhenServicesCommitChanges(worker, { log: (message) => console.log(JSON.stringify({ service, status: "reloading", message })) });
    await worker.run();
    stopReloadWatch();
    await spans?.close();
  } catch (error) {
    console.error(JSON.stringify({
      service,
      status: "failed",
      error: error instanceof Error ? redactSecretText(error.message) : "Unknown maintenance worker failure."
    }));
    process.exitCode = 1;
  }
}
