import { Client, Connection } from "@temporalio/client";
import {
  MEMORY_MUTATION_TASK_QUEUE,
  MEMORY_MUTATION_WORKFLOW_TYPE,
  buildMemoryMutationWorkflowId,
  memoryMutationWorkflowInputSchema,
  type MemoryMutationWorkflowInput
} from "@space/contracts";
import { SpaceFeatureDisabledError } from "@space/runtime";

export { MEMORY_MUTATION_TASK_QUEUE, MEMORY_MUTATION_WORKFLOW_TYPE, buildMemoryMutationWorkflowId };

export interface MemoryMutationStartResult {
  workflowId: string;
  runId: string | null;
  status: "SCHEDULED" | "ALREADY_SCHEDULED";
}

interface WorkflowStartOptions {
  args: [MemoryMutationWorkflowInput];
  taskQueue: typeof MEMORY_MUTATION_TASK_QUEUE;
  workflowId: string;
  workflowIdReusePolicy: "REJECT_DUPLICATE";
  workflowIdConflictPolicy: "USE_EXISTING";
}

interface WorkflowStartHandle {
  workflowId: string;
  firstExecutionRunId?: string;
}

export type MemoryMutationWorkflowStarter = (
  workflowType: typeof MEMORY_MUTATION_WORKFLOW_TYPE,
  options: WorkflowStartOptions
) => Promise<WorkflowStartHandle>;

function isAlreadyStarted(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError";
}

export async function scheduleMemoryMutation(
  rawInput: MemoryMutationWorkflowInput,
  startWorkflow: MemoryMutationWorkflowStarter,
  commandHash?: string
): Promise<MemoryMutationStartResult> {
  const input = memoryMutationWorkflowInputSchema.parse(rawInput);
  const workflowId = buildMemoryMutationWorkflowId(input.changeSetId, commandHash);
  try {
    const handle = await startWorkflow(MEMORY_MUTATION_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: MEMORY_MUTATION_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING"
    });
    return { status: "SCHEDULED", workflowId: handle.workflowId, runId: handle.firstExecutionRunId ?? null };
  } catch (error) {
    if (isAlreadyStarted(error)) return { status: "ALREADY_SCHEDULED", workflowId, runId: null };
    throw error;
  }
}

export interface MemoryMutationCoordinator {
  start(input: MemoryMutationWorkflowInput, commandHash?: string): Promise<MemoryMutationStartResult>;
}

class DisabledMemoryMutationCoordinator implements MemoryMutationCoordinator {
  async start(): Promise<never> {
    throw new SpaceFeatureDisabledError(
      "MEMORY_MUTATIONS_DISABLED",
      "Canonical memory mutations are disabled until their guarded rollout is enabled."
    );
  }
}

class TemporalMemoryMutationCoordinator implements MemoryMutationCoordinator {
  constructor(private readonly options: { address: string; namespace: string }) {}

  async start(input: MemoryMutationWorkflowInput, commandHash?: string): Promise<MemoryMutationStartResult> {
    const connection = await Connection.connect({ address: this.options.address, connectTimeout: "5s" });
    try {
      const client = new Client({ connection, namespace: this.options.namespace });
      return await scheduleMemoryMutation(
        input,
        (workflowType, options) => client.workflow.start(workflowType, options),
        commandHash
      );
    } finally {
      await connection.close();
    }
  }
}

export function createMemoryMutationCoordinator(options: {
  enabled: boolean;
  address: string;
  namespace: string;
}): MemoryMutationCoordinator {
  return options.enabled ? new TemporalMemoryMutationCoordinator(options) : new DisabledMemoryMutationCoordinator();
}
