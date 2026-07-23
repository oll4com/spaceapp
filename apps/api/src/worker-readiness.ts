import { Connection } from "@temporalio/client";
import { workerReadinessSchema, type WorkerReadiness } from "@space/contracts";
import type { SpaceApiConfig } from "./config.js";

const TASK_QUEUE_TYPE_WORKFLOW = 1;
const TASK_QUEUE_TYPE_ACTIVITY = 2;
const readinessDeadlineMs = 2_500;

interface TemporalPoller {
  identity?: string | null;
  lastAccessTime?: unknown;
}

interface TemporalTaskQueueStats {
  approximateBacklogCount?: unknown;
}

interface TemporalTaskQueueDescription {
  pollers?: TemporalPoller[] | null;
  stats?: TemporalTaskQueueStats | null;
}

export type WorkerReadinessChecker = () => Promise<WorkerReadiness>;

function longishToNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  if (value && typeof value === "object" && "toString" in value) {
    const rendered = String((value as { toString: () => string }).toString());
    if (/^\d+$/.test(rendered)) return Number(rendered);
  }
  return null;
}

function timestampToIso(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { seconds?: unknown; nanos?: unknown };
  const seconds = longishToNumber(record.seconds);
  if (seconds === null) return null;
  const nanos = typeof record.nanos === "number" && Number.isFinite(record.nanos) ? record.nanos : 0;
  return new Date((seconds * 1000) + Math.floor(nanos / 1_000_000)).toISOString();
}

function latestIso(values: Array<string | null>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function uniquePollerIdentities(...pollerSets: TemporalPoller[][]): string[] {
  return Array.from(
    new Set(
      pollerSets
        .flat()
        .map((poller) => poller.identity?.trim())
        .filter((identity): identity is string => Boolean(identity))
    )
  ).slice(0, 20);
}

async function describeTaskQueue(input: {
  connection: Connection;
  namespace: string;
  taskQueue: string;
  taskQueueType: number;
}): Promise<TemporalTaskQueueDescription> {
  return input.connection.workflowService.describeTaskQueue({
    namespace: input.namespace,
    taskQueue: { name: input.taskQueue },
    taskQueueType: input.taskQueueType,
    reportStats: true
  }) as Promise<TemporalTaskQueueDescription>;
}

export function createWorkerReadinessChecker(config: SpaceApiConfig): WorkerReadinessChecker {
  return async () => {
    const checkedAt = new Date().toISOString();
    let connection: Connection | null = null;
    try {
      connection = await Connection.connect({
        address: config.temporalAddress,
        connectTimeout: "2s"
      });
      const [workflow, activity] = await connection.withDeadline(Date.now() + readinessDeadlineMs, () =>
        Promise.all([
          describeTaskQueue({
            connection: connection as Connection,
            namespace: config.temporalNamespace,
            taskQueue: config.temporalTaskQueue,
            taskQueueType: TASK_QUEUE_TYPE_WORKFLOW
          }),
          describeTaskQueue({
            connection: connection as Connection,
            namespace: config.temporalNamespace,
            taskQueue: config.temporalTaskQueue,
            taskQueueType: TASK_QUEUE_TYPE_ACTIVITY
          })
        ])
      );
      const workflowPollers = workflow.pollers ?? [];
      const activityPollers = activity.pollers ?? [];
      const workflowPollerCount = workflowPollers.length;
      const activityPollerCount = activityPollers.length;
      const pollerCount = workflowPollerCount + activityPollerCount;
      const status = workflowPollerCount > 0 && activityPollerCount > 0 ? "RUNNING" : "NO_POLLERS";
      const lastPollerAccessAt = latestIso([...workflowPollers, ...activityPollers].map((poller) => timestampToIso(poller.lastAccessTime)));

      return workerReadinessSchema.parse({
        id: "space-worker",
        status,
        statusReason:
          status === "RUNNING"
            ? "Temporal is reachable and the Space worker has workflow and activity pollers on the configured task queue."
            : "Temporal is reachable, but the configured task queue does not currently show both workflow and activity pollers.",
        address: config.temporalAddress,
        namespace: config.temporalNamespace,
        taskQueue: config.temporalTaskQueue,
        reachable: true,
        workflowPollerCount,
        activityPollerCount,
        pollerCount,
        workflowBacklogCount: longishToNumber(workflow.stats?.approximateBacklogCount),
        activityBacklogCount: longishToNumber(activity.stats?.approximateBacklogCount),
        pollerIdentities: uniquePollerIdentities(workflowPollers, activityPollers),
        lastPollerAccessAt,
        checkedAt
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown Temporal worker readiness error.";
      return workerReadinessSchema.parse({
        id: "space-worker",
        status: "ERROR",
        statusReason: `Temporal worker readiness check failed: ${message.slice(0, 900)}`,
        address: config.temporalAddress,
        namespace: config.temporalNamespace,
        taskQueue: config.temporalTaskQueue,
        reachable: false,
        workflowPollerCount: 0,
        activityPollerCount: 0,
        pollerCount: 0,
        workflowBacklogCount: null,
        activityBacklogCount: null,
        pollerIdentities: [],
        lastPollerAccessAt: null,
        checkedAt
      });
    } finally {
      await connection?.close();
    }
  };
}
