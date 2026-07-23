import { fileURLToPath } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";
import * as activities from "./memory-maintenance-activities.js";
import {
  MEMORY_MAINTENANCE_TASK_QUEUE,
  memoryMaintenanceEnabled,
  memoryMaintenanceWorkerOptions
} from "./memory-maintenance-config.js";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";

const service = "space-memory-maintenance-worker";

if (!memoryMaintenanceEnabled(process.env)) {
  console.log(JSON.stringify({ service, status: "disabled" }));
} else {
  const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  const workflowsPath = fileURLToPath(new URL("./memory-maintenance-workflows.js", import.meta.url));

  try {
    const connection = await NativeConnection.connect({ address });
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowsPath,
      activities,
      ...memoryMaintenanceWorkerOptions
    });
    console.log(JSON.stringify({
      service,
      status: "running",
      address,
      namespace,
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      activityConcurrency: memoryMaintenanceWorkerOptions.maxConcurrentActivityTaskExecutions
    }));
    await worker.run();
  } catch (error) {
    console.error(JSON.stringify({
      service,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown maintenance worker failure."
    }));
    process.exitCode = 1;
  }
}
