import type { WorkerOptions } from "@temporalio/worker";
import { MEMORY_MUTATION_TASK_QUEUE, MEMORY_MUTATION_WORKFLOW_TYPE } from "@space/contracts";

export { MEMORY_MUTATION_TASK_QUEUE, MEMORY_MUTATION_WORKFLOW_TYPE };
export const MEMORY_MUTATION_ACTIVITY_CONCURRENCY = 1;

export const memoryMutationWorkerOptions = {
  maxConcurrentActivityTaskExecutions: MEMORY_MUTATION_ACTIVITY_CONCURRENCY,
  maxConcurrentLocalActivityExecutions: MEMORY_MUTATION_ACTIVITY_CONCURRENCY,
  maxConcurrentActivityTaskPolls: MEMORY_MUTATION_ACTIVITY_CONCURRENCY
} satisfies Partial<WorkerOptions>;

export function memoryMutationsEnabled(env: NodeJS.ProcessEnv | Record<string, string | undefined>): boolean {
  return env.SPACE_MEMORY_GRAPH_ENABLED === "true" && env.SPACE_MEMORY_MUTATIONS_ENABLED === "true";
}
