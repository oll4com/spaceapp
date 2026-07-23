import type { MemoryMaintenanceInput } from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MAINTENANCE_WORKFLOW_TYPE, memoryMaintenanceEnabled } from "./memory-maintenance-config.js";

const ATHENS_TIME_ZONE = "Europe/Athens";

interface WorkflowStartResult {
  workflowId?: string;
  firstExecutionRunId?: string;
}

interface WorkflowStartOptions {
  taskQueue: string;
  workflowId: string;
  args: [MemoryMaintenanceInput];
  workflowIdReusePolicy: "REJECT_DUPLICATE";
  workflowIdConflictPolicy: "USE_EXISTING";
}

export interface ScheduleMemoryMaintenanceOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  now?: () => Date;
  startWorkflow: (workflowType: string, options: WorkflowStartOptions) => Promise<WorkflowStartResult>;
}

export type ScheduleMemoryMaintenanceResult =
  | { status: "DISABLED" }
  | { status: "SCHEDULED"; workflowId: string; runId: string | null }
  | { status: "ALREADY_SCHEDULED"; workflowId: string };

function athensDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ATHENS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value;
  const year = value("year");
  const month = value("month");
  const day = value("day");
  if (!year || !month || !day) throw new Error("Unable to resolve the Athens calendar date.");
  return `${year}-${month}-${day}`;
}

function alreadyStarted(error: unknown): boolean {
  return error instanceof Error && error.name === "WorkflowExecutionAlreadyStartedError";
}

export async function scheduleMemoryMaintenance(options: ScheduleMemoryMaintenanceOptions): Promise<ScheduleMemoryMaintenanceResult> {
  const env = options.env ?? process.env;
  if (!memoryMaintenanceEnabled(env)) return { status: "DISABLED" };

  const scheduledAt = (options.now ?? (() => new Date()))();
  const date = athensDate(scheduledAt);
  const workflowId = `space-memory-maintenance:${date}`;
  const input: MemoryMaintenanceInput = {
    scheduledAt: scheduledAt.toISOString(),
    traceId: `trace:memory-maintenance-${date}`
  };

  try {
    const handle = await options.startWorkflow(MEMORY_MAINTENANCE_WORKFLOW_TYPE, {
      taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE,
      workflowId,
      args: [input],
      workflowIdReusePolicy: "REJECT_DUPLICATE",
      workflowIdConflictPolicy: "USE_EXISTING"
    });
    return { status: "SCHEDULED", workflowId, runId: handle.firstExecutionRunId ?? null };
  } catch (error) {
    if (alreadyStarted(error)) return { status: "ALREADY_SCHEDULED", workflowId };
    throw error;
  }
}
