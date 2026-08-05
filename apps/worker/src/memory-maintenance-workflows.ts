import { executeChild, proxyActivities } from "@temporalio/workflow";
import type {
  MemoryConsolidationRun,
  MemoryConsolidationWorkflowInput,
  MemoryMaintenanceInput,
  MemoryMaintenanceResult
} from "@space/contracts";
import type * as activities from "./memory-maintenance-activities.js";
import type * as mutationActivities from "./memory-mutation-activity.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "./memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "./memory-mutation-config.js";

const {
  createScheduledMemoryAudit,
  finalizeMemoryRepair,
  prepareMemoryConsolidation,
  refreshMemoryGraphSnapshot,
  refreshAllMonthsMemoryGraphSnapshot
} = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  retry: {
    maximumAttempts: 3
  }
});

const { executePersistedMemoryChangeSet } = proxyActivities<typeof mutationActivities>({
  taskQueue: MEMORY_MUTATION_TASK_QUEUE,
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 3 }
});

export async function memoryMaintenanceWorkflow(input: MemoryMaintenanceInput): Promise<MemoryMaintenanceResult> {
  const result = await refreshMemoryGraphSnapshot(input);
  try {
    await refreshAllMonthsMemoryGraphSnapshot(input);
  } catch (error) {
    console.warn("All-months memory graph refresh failed; the live snapshot and maintenance continue.", error);
  }
  const run = await createScheduledMemoryAudit({ ...input, sourceHash: result.sourceHash });
  await executeChild(memoryConsolidationWorkflow, {
    args: [{ runId: run.id, traceId: input.traceId }],
    workflowId: run.workflowId,
    taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE
  });
  return result;
}

export async function memoryConsolidationWorkflow(input: MemoryConsolidationWorkflowInput): Promise<MemoryConsolidationRun> {
  const prepared = await prepareMemoryConsolidation(input);
  if (!prepared.changeSetId) return prepared.run;
  const mutationResult = await executePersistedMemoryChangeSet({
    changeSetId: prepared.changeSetId,
    traceId: input.traceId
  });
  return finalizeMemoryRepair({
    runId: input.runId,
    changeSetId: prepared.changeSetId,
    mutationResult
  });
}
