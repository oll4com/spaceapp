import { proxyActivities } from "@temporalio/workflow";
import type { MemoryMutationWorkflowInput, MemoryMutationWorkflowResult } from "@space/contracts";
import type * as activities from "./memory-mutation-activity.js";

const { executePersistedMemoryChangeSet } = proxyActivities<typeof activities>({
  startToCloseTimeout: "15 minutes",
  retry: { maximumAttempts: 3 }
});

export async function memoryMutationWorkflow(input: MemoryMutationWorkflowInput): Promise<MemoryMutationWorkflowResult> {
  return executePersistedMemoryChangeSet(input);
}
