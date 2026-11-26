import { Client, Connection } from "@temporalio/client";
import type { SpaceApiConfig } from "./config.js";

/** One workflow's workflow-task faults: Temporal's cause enum, never the failure message (it can carry user content). */
export interface WorkflowTaskFault { workflowId: string; cause: string; failures: number; lastAt: string }

type HistoryEvent = {
  eventTime?: { seconds?: number | string | { toString(): string } | null; nanos?: number | null } | null;
  workflowTaskFailedEventAttributes?: { toJSON?(): { cause?: unknown } } | null;
};

const eventIso = (time: HistoryEvent["eventTime"]) =>
  new Date(Number(String(time?.seconds ?? 0)) * 1000 + Math.floor((time?.nanos ?? 0) / 1e6)).toISOString();

/**
 * Reads the Temporal history of the workflows a trace names and keeps their WorkflowTaskFailed events (EXT-G-5): a
 * workflow-task fault never becomes a Space event or run error, so before this it showed only in Temporal's own history.
 * A workflow Temporal no longer holds, or a history read that fails, contributes nothing.
 */
export async function readWorkflowTaskFaults(client: Pick<Client, "workflow">, workflowIds: string[]): Promise<WorkflowTaskFault[]> {
  const faults = await Promise.all(workflowIds.map(async (workflowId): Promise<WorkflowTaskFault | null> => {
    const history = await client.workflow.getHandle(workflowId).fetchHistory().catch(() => null);
    // fetchHistory() returns decoded protobufjs messages; their typings omit toJSON.
    const failed = ((history?.events ?? []) as HistoryEvent[]).filter((event) => event.workflowTaskFailedEventAttributes);
    const last = failed.at(-1);
    if (!last) return null;
    // protobufjs's toJSON names the enum (WORKFLOW_TASK_FAILED_CAUSE_...); the message field is never read.
    const cause = last.workflowTaskFailedEventAttributes?.toJSON?.().cause;
    return { workflowId, cause: typeof cause === "string" && /^[A-Z_]{1,80}$/.test(cause) ? cause : "UNKNOWN", failures: failed.length, lastAt: eventIso(last.eventTime) };
  }));
  return faults.filter((fault): fault is WorkflowTaskFault => fault !== null);
}

/** The trace route's reader: one Temporal connection per lookup; while Temporal is unreachable the lookup has no faults. */
export function temporalWorkflowTaskFaults(config: Pick<SpaceApiConfig, "temporalAddress" | "temporalNamespace">) {
  return async (workflowIds: string[]): Promise<WorkflowTaskFault[]> => {
    if (!workflowIds.length) return [];
    const connection = await Connection.connect({ address: config.temporalAddress, connectTimeout: "5s" }).catch(() => null);
    if (!connection) return [];
    try {
      return await readWorkflowTaskFaults(new Client({ connection, namespace: config.temporalNamespace }), workflowIds);
    } finally { await connection.close(); }
  };
}
