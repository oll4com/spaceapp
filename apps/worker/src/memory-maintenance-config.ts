import type { WorkerOptions } from "@temporalio/worker";

export const MEMORY_MAINTENANCE_TASK_QUEUE = "space-memory-maintenance";
export const MEMORY_MAINTENANCE_WORKFLOW_TYPE = "memoryMaintenanceWorkflow";
export const MEMORY_MAINTENANCE_ACTIVITY_CONCURRENCY = 1;

export const memoryMaintenanceWorkerOptions = {
  maxConcurrentActivityTaskExecutions: MEMORY_MAINTENANCE_ACTIVITY_CONCURRENCY,
  maxConcurrentLocalActivityExecutions: MEMORY_MAINTENANCE_ACTIVITY_CONCURRENCY,
  maxConcurrentActivityTaskPolls: MEMORY_MAINTENANCE_ACTIVITY_CONCURRENCY
} satisfies Partial<WorkerOptions>;

export function memoryMaintenanceEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.SPACE_MEMORY_GRAPH_ENABLED === "true" && env.SPACE_MEMORY_MAINTENANCE_ENABLED === "true";
}
