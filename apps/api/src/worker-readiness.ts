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
  approximateBacklogAge?: unknown;
}

interface TemporalTaskQueueDescription {
  pollers?: TemporalPoller[] | null;
  stats?: TemporalTaskQueueStats | null;
}

export type WorkerReadinessChecker = (() => Promise<WorkerReadiness>) & {
  /** Closes the cached Temporal connection; safe to call more than once. */
  dispose?: () => Promise<void>;
};

const staleConnectionCloseDelayMs = 60_000;

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

/** google.protobuf.Duration ({ seconds, nanos }) to seconds; null when absent. */
export function durationToSeconds(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as { seconds?: unknown; nanos?: unknown };
  const seconds = longishToNumber(record.seconds);
  if (seconds === null) return null;
  const nanos = typeof record.nanos === "number" && Number.isFinite(record.nanos) && record.nanos > 0 ? record.nanos : 0;
  return seconds + nanos / 1e9;
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
  // One connection is reused across checks. Closing a connection right after a
  // failed call is unsafe: @temporalio/client's retry interceptor re-issues the
  // call from a timer and throws "Channel has been shut down" outside any
  // promise chain, which took the whole API down while Temporal restarted.
  // Failed connections are therefore retired and only closed after a delay.
  let current: Promise<Connection> | null = null;
  const pendingCloses = new Set<NodeJS.Timeout>();

  const openConnection = (): Promise<Connection> => {
    if (!current) {
      const attempt = Connection.connect({ address: config.temporalAddress, connectTimeout: "2s" });
      current = attempt;
      attempt.catch(() => {
        if (current === attempt) {
          current = null;
        }
      });
    }
    return current;
  };

  const retireConnection = (attempt: Promise<Connection>): void => {
    if (current === attempt) {
      current = null;
    }
    const timer = setTimeout(() => {
      pendingCloses.delete(timer);
      void attempt.then((connection) => connection.close()).catch(() => undefined);
    }, staleConnectionCloseDelayMs);
    timer.unref();
    pendingCloses.add(timer);
  };

  const checker: WorkerReadinessChecker = async () => {
    const checkedAt = new Date().toISOString();
    let attempt: Promise<Connection> | null = null;
    try {
      attempt = openConnection();
      const connection = await attempt;
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
        workflowBacklogAgeSeconds: durationToSeconds(workflow.stats?.approximateBacklogAge),
        activityBacklogAgeSeconds: durationToSeconds(activity.stats?.approximateBacklogAge),
        pollerIdentities: uniquePollerIdentities(workflowPollers, activityPollers),
        lastPollerAccessAt,
        checkedAt
      });
    } catch (error) {
      if (attempt) {
        retireConnection(attempt);
      }
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
    }
  };
  checker.dispose = async () => {
    for (const timer of pendingCloses) {
      clearTimeout(timer);
    }
    pendingCloses.clear();
    const open = current;
    current = null;
    if (open) {
      await open.then((connection) => connection.close()).catch(() => undefined);
    }
  };
  return checker;
}
