import { Client, Connection } from "@temporalio/client";
import {
  MEMORY_CONSOLIDATION_TASK_QUEUE,
  MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
  memoryConsolidationWorkflowInputSchema,
  type MemoryConsolidationWorkflowInput
} from "@space/contracts";
import { SpaceFeatureDisabledError } from "@space/runtime";

export { MEMORY_CONSOLIDATION_TASK_QUEUE, MEMORY_CONSOLIDATION_WORKFLOW_TYPE };

export interface MemoryConsolidationStartResult {
  status: "SCHEDULED" | "ALREADY_SCHEDULED";
  workflowId: string;
  runId: string | null;
}

interface WorkflowStartOptions {
  args: [MemoryConsolidationWorkflowInput];
  taskQueue: typeof MEMORY_CONSOLIDATION_TASK_QUEUE;
  workflowId: string;
  workflowIdReusePolicy: "REJECT_DUPLICATE";
  workflowIdConflictPolicy: "USE_EXISTING";
}

interface WorkflowStartHandle {
  workflowId: string;
  firstExecutionRunId?: string;
}

export type MemoryConsolidationWorkflowStarter = (
  workflowType: typeof MEMORY_CONSOLIDATION_WORKFLOW_TYPE,
  options: WorkflowStartOptions
) => Promise<WorkflowStartHandle>;

function isAlreadyStarted(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError";
}

export async function scheduleMemoryConsolidation(
  rawInput: MemoryConsolidationWorkflowInput,
  workflowId: string,
  startWorkflow: MemoryConsolidationWorkflowStarter
): Promise<MemoryConsolidationStartResult> {
  const input = memoryConsolidationWorkflowInputSchema.parse(rawInput);
  try {
    const handle = await startWorkflow(MEMORY_CONSOLIDATION_WORKFLOW_TYPE, {
      args: [input],
      taskQueue: MEMORY_CONSOLIDATION_TASK_QUEUE,
      workflowId,
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING"
    });
    return {
      status: "SCHEDULED",
      workflowId: handle.workflowId,
      runId: handle.firstExecutionRunId ?? null
    };
  } catch (error) {
    if (isAlreadyStarted(error)) return { status: "ALREADY_SCHEDULED", workflowId, runId: null };
    throw error;
  }
}

export interface MemoryConsolidationCoordinator {
  start(input: MemoryConsolidationWorkflowInput, workflowId: string): Promise<MemoryConsolidationStartResult>;
}

class DisabledMemoryConsolidationCoordinator implements MemoryConsolidationCoordinator {
  async start(): Promise<never> {
    throw new SpaceFeatureDisabledError(
      "MEMORY_MAINTENANCE_DISABLED",
      "Memory consolidation is disabled until its guarded maintenance rollout is enabled."
    );
  }
}

class TemporalMemoryConsolidationCoordinator implements MemoryConsolidationCoordinator {
  constructor(private readonly options: { address: string; namespace: string }) {}

  async start(input: MemoryConsolidationWorkflowInput, workflowId: string): Promise<MemoryConsolidationStartResult> {
    const connection = await Connection.connect({ address: this.options.address, connectTimeout: "5s" });
    try {
      const client = new Client({ connection, namespace: this.options.namespace });
      return await scheduleMemoryConsolidation(
        input,
        workflowId,
        (workflowType, startOptions) => client.workflow.start(workflowType, startOptions)
      );
    } finally {
      await connection.close();
    }
  }
}

export function createMemoryConsolidationCoordinator(options: {
  enabled: boolean;
  address: string;
  namespace: string;
}): MemoryConsolidationCoordinator {
  return options.enabled
    ? new TemporalMemoryConsolidationCoordinator(options)
    : new DisabledMemoryConsolidationCoordinator();
}
