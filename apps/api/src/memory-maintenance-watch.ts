import type { FastifyInstance } from "fastify";
import type { NotificationRaiseInput } from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import { connectTemporalClient, type TemporalClientFactory } from "./temporal-client.js";

const FAILED_STATUSES = new Set(["FAILED", "TIMED_OUT", "TERMINATED", "CANCELLED"]);

/** The maintenance scheduler names each day's run after its Athens date (apps/worker/src/memory-maintenance-scheduler-lib.ts). */
function athensDate(date: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Athens" }).format(date);
}

/**
 * Tells the admins when the daily Space Memory maintenance run failed: it failed silently every day from 2026-10-13 on
 * and the graph snapshots went stale (plan clipboard:yAtbVyHE5s4T). Checks today's and yesterday's run.
 */
export function createMemoryMaintenanceFailureWatch(input: {
  /** The run's status name, or null when no run has that id. */
  status: (workflowIds: string[]) => Promise<Map<string, string | null>>;
  admins: () => Promise<string[]>;
  raise: (notification: NotificationRaiseInput) => Promise<unknown>;
  log: { warn(meta: Record<string, unknown>, message: string): void };
  now?: () => Date;
  intervalMs?: number;
}) {
  // shortcut: announced runs live in memory, so an API restart may announce a failed run once more; persist them if that is noisy.
  const announced = new Set<string>();
  let timer: NodeJS.Timeout | null = null;

  async function tick(): Promise<void> {
    const now = (input.now ?? (() => new Date()))();
    const ids = [now, new Date(now.getTime() - 86_400_000)].map((date) => `space-memory-maintenance:${athensDate(date)}`);
    const statuses = await input.status(ids.filter((id) => !announced.has(id)));
    for (const [workflowId, status] of statuses) {
      if (!status || !FAILED_STATUSES.has(status)) continue;
      announced.add(workflowId);
      for (const ownerUserId of await input.admins()) {
        await input.raise({
          ownerUserId, roomId: null, paneId: null, source: "SYSTEM", kind: "MEMORY_MAINTENANCE_FAILED", severity: "ATTENTION",
          title: "Space Memory maintenance failed",
          body: `The daily Space Memory maintenance run ${workflowId} ended ${status}; the memory graph snapshots were not refreshed. See journalctl -u space-memory-maintenance-worker.`,
          link: {}, dedupeKey: `memory-maintenance:${workflowId}`, payload: { workflowId, status }, telegram: null
        });
      }
    }
  }

  return {
    tick,
    start() {
      timer ??= setInterval(() => { void tick().catch((error: unknown) => input.log.warn({ err: error }, "Memory maintenance watch failed.")); }, input.intervalMs ?? 3_600_000);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

/** Starts the watch on the instance that runs the `memory-maintenance-notify` job with memory maintenance on; every ADMIN is told. */
export function registerMemoryMaintenanceFailureWatch(app: FastifyInstance, input: {
  enabled: boolean; address: string; namespace: string; store: Pick<SpaceStore, "listUsersWithRoomCounts">;
  notifications: { raise(notification: NotificationRaiseInput): Promise<unknown> };
  connect?: TemporalClientFactory;
}): void {
  const watch = createMemoryMaintenanceFailureWatch({
    raise: (notification) => input.notifications.raise(notification), log: app.log,
    admins: async () => ((await input.store.listUsersWithRoomCounts?.()) ?? []).filter((user) => user.role === "ADMIN").map((user) => user.id),
    status: async (workflowIds) => {
      const result = new Map<string, string | null>();
      if (!workflowIds.length) return result;
      const lease = await (input.connect ?? connectTemporalClient)({ address: input.address, namespace: input.namespace });
      try {
        for (const workflowId of workflowIds) {
          const description = await lease.client.workflow.getHandle(workflowId).describe().catch((error: unknown) => {
            if (error instanceof Error && error.name === "WorkflowNotFoundError") return null;
            throw error;
          });
          result.set(workflowId, description?.status.name ?? null);
        }
      } finally {
        await lease.close();
      }
      return result;
    }
  });
  app.addHook("onReady", async () => { if (input.enabled) watch.start(); });
  app.addHook("onClose", async () => watch.stop());
}
