import { Connection, WorkflowClient } from "@temporalio/client";
import { DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "./constants.js";
import { memoryMaintenanceEnabled } from "./memory-maintenance-config.js";
import { scheduleMemoryMaintenance } from "./memory-maintenance-scheduler-lib.js";

const service = "space-memory-maintenance-scheduler";

if (!memoryMaintenanceEnabled(process.env)) {
  console.log(JSON.stringify({ service, status: "disabled" }));
} else {
  const address = process.env.SPACE_TEMPORAL_ADDRESS ?? DEFAULT_TEMPORAL_ADDRESS;
  const namespace = process.env.SPACE_TEMPORAL_NAMESPACE ?? DEFAULT_TEMPORAL_NAMESPACE;
  let connection: Connection | null = null;
  try {
    connection = await Connection.connect({ address });
    const client = new WorkflowClient({ connection, namespace });
    const result = await scheduleMemoryMaintenance({
      startWorkflow: (workflowType, options) => client.start(workflowType, options)
    });
    console.log(JSON.stringify({ service, ...result }));
  } catch (error) {
    console.error(JSON.stringify({
      service,
      status: "failed",
      error: error instanceof Error ? error.message : "Unknown maintenance scheduler failure."
    }));
    process.exitCode = 1;
  } finally {
    await connection?.close();
  }
}
