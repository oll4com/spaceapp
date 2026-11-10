import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  type CliSessionStats, cliSessionReapResponseSchema, cliSessionStatsSchema, type HostMemoryDetails, hostMemoryDetailsSchema,
  type MemoryReclaimResponse, memoryReclaimResponseSchema
} from "@space/contracts";
import { nowIso, SpaceConflictError, SpaceNotFoundError, type SpaceStore } from "@space/runtime";
import type { CliHostReapAggregate } from "./cli-terminal.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";
import type { KernelCacheReclaimResult } from "./toolbar-system-services.js";

const emptyToolbarActionSchema = z.object({}).strict();

export const minimumKernelCacheReclaimBytes = 256 * 1024 * 1024;

export function invalidateToolbarProvider(provider: unknown): void {
  const invalidate = (provider as { invalidate?: unknown } | null)?.invalidate;
  if (typeof invalidate === "function") invalidate.call(provider);
}

/**
 * ADMIN toolbar cleanup: the detached CLI reap and the memory reclaim. Both share one in-flight flag with the
 * maintenance autopilot's memory step, so the register function returns that lock and the closed-pane reap.
 */
export function registerAdminCleanupRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  toolbarCliSessionStatsProvider: () => Promise<CliSessionStats>;
  toolbarHostMemoryProvider: () => Promise<HostMemoryDetails>;
  toolbarCliSessionReaper: () => Promise<CliHostReapAggregate>;
  toolbarCliSessionTerminator: (sessionId: string, traceId?: string) => Promise<boolean>;
  toolbarKernelCacheReclaimer: () => Promise<KernelCacheReclaimResult>;
}) {
  const {
    store, toolbarCliSessionStatsProvider, toolbarHostMemoryProvider, toolbarCliSessionReaper, toolbarCliSessionTerminator,
    toolbarKernelCacheReclaimer
  } = options;
  let toolbarCleanupInFlight = false;
  async function performToolbarCliReap() {
    const before = cliSessionStatsSchema.parse(await toolbarCliSessionStatsProvider());
    const reaped = await toolbarCliSessionReaper();
    const killedSessionIds = [...new Set(reaped.killedSessions.map((session) => session.cliSessionId))].slice(0, 500);
    const killed = new Set(killedSessionIds);
    const estimatedReclaimedBytes = before.sessions.reduce(
      (total, session) => total + (killed.has(session.sessionId) ? session.rssBytes : 0),
      0
    );
    invalidateToolbarProvider(toolbarCliSessionStatsProvider);
    invalidateToolbarProvider(toolbarHostMemoryProvider);
    return cliSessionReapResponseSchema.parse({
      status: reaped.failedHostCount > 0 ? "PARTIAL" : killedSessionIds.length > 0 ? "COMPLETED" : "NOOP",
      killedSessionIds,
      skippedCount: Math.max(Math.trunc(reaped.skippedCount), 0),
      estimatedReclaimedBytes,
      completedAt: nowIso()
    });
  }
  /**
   * Memory reclaim stops a detached CLI only when its pane is closed or gone.
   * A pane that is still open (another room, minimized, browser closed) keeps
   * its agent running; an uncertain pane lookup also protects the session.
   */
  async function performClosedPaneCliReap(traceId?: string) {
    const before = cliSessionStatsSchema.parse(await toolbarCliSessionStatsProvider());
    const killedSessionIds: string[] = [];
    let protectedSessionCount = 0;
    let failedCount = 0;
    let estimatedReclaimedBytes = 0;
    for (const session of before.sessions.filter((candidate) => candidate.cleanupEligible)) {
      let paneOpen = true;
      try {
        paneOpen = !(await store.getPane(session.paneId)).isClosed;
      } catch (error) {
        paneOpen = !(error instanceof SpaceNotFoundError);
      }
      if (paneOpen) {
        protectedSessionCount += 1;
        continue;
      }
      try {
        if (await toolbarCliSessionTerminator(session.sessionId, traceId)) {
          killedSessionIds.push(session.sessionId);
          estimatedReclaimedBytes += session.rssBytes;
        }
      } catch {
        failedCount += 1;
      }
    }
    invalidateToolbarProvider(toolbarCliSessionStatsProvider);
    invalidateToolbarProvider(toolbarHostMemoryProvider);
    return {
      status: failedCount > 0 ? "PARTIAL" as const : killedSessionIds.length > 0 ? "COMPLETED" as const : "NOOP" as const,
      killedSessionIds: killedSessionIds.slice(0, 500),
      protectedSessionCount,
      estimatedReclaimedBytes
    };
  }
  app.post(
    "/api/admin/cli-session-reaps",
    { config: { rateLimit: { max: 4, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI session cleanup requires the ADMIN role.");
      }
      parseBody(emptyToolbarActionSchema, request.body ?? {});
      if (toolbarCleanupInFlight) throw new SpaceConflictError("A toolbar cleanup action is already running.");
      toolbarCleanupInFlight = true;
      try {
        const result = await performToolbarCliReap();
        await recordAudit(store, request, {
          action: "admin.cli_sessions.reaped",
          targetType: "cli_sessions",
          targetId: "space-managed",
          metadata: {
            status: result.status,
            killedCount: result.killedSessionIds.length,
            skippedCount: result.skippedCount,
            estimatedReclaimedBytes: result.estimatedReclaimedBytes
          }
        });
        return result;
      } finally {
        toolbarCleanupInFlight = false;
      }
    }
  );
  app.post(
    "/api/admin/memory-reclaims",
    { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Memory cleanup requires the ADMIN role.");
      }
      parseBody(emptyToolbarActionSchema, request.body ?? {});
      if (toolbarCleanupInFlight) throw new SpaceConflictError("A toolbar cleanup action is already running.");
      toolbarCleanupInFlight = true;
      try {
        const before = hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider());
        const cli = await performClosedPaneCliReap(request.requestIdForSpace);
        const kernelCache: KernelCacheReclaimResult = !before.pressure.isUnderPressure
          ? { status: "SKIPPED_LOW_PRESSURE", reclaimedBytes: 0, message: null }
          : !before.pressure.canDropPageCache || before.memory.reclaimableBytes < minimumKernelCacheReclaimBytes
            ? { status: "SKIPPED_SMALL_CACHE", reclaimedBytes: 0, message: null }
            : await toolbarKernelCacheReclaimer();
        invalidateToolbarProvider(toolbarHostMemoryProvider);
        let after = before;
        let afterCollectionFailed = false;
        try {
          after = hostMemoryDetailsSchema.parse(await toolbarHostMemoryProvider());
        } catch {
          afterCollectionFailed = true;
        }
        const didWork = cli.killedSessionIds.length > 0 || kernelCache.status === "CLEARED";
        const status: MemoryReclaimResponse["status"] =
          cli.status === "PARTIAL" || kernelCache.status === "FAILED" || afterCollectionFailed
            ? "PARTIAL"
            : didWork
              ? "COMPLETED"
              : "NOOP";
        const result = memoryReclaimResponseSchema.parse({
          status,
          cli: {
            killedSessionIds: cli.killedSessionIds,
            estimatedReclaimedBytes: cli.estimatedReclaimedBytes,
            protectedSessionCount: cli.protectedSessionCount
          },
          kernelCache,
          before: before.memory,
          after: after.memory,
          completedAt: nowIso()
        });
        await recordAudit(store, request, {
          action: "admin.memory.reclaimed",
          targetType: "host_memory",
          targetId: "vm207",
          metadata: {
            status: result.status,
            killedCliCount: result.cli.killedSessionIds.length,
            protectedCliCount: cli.protectedSessionCount,
            estimatedCliReclaimedBytes: result.cli.estimatedReclaimedBytes,
            kernelCacheStatus: result.kernelCache.status,
            kernelCacheReclaimedBytes: result.kernelCache.reclaimedBytes
          }
        });
        return result;
      } finally {
        toolbarCleanupInFlight = false;
      }
    }
  );
  return {
    acquire: () => {
      if (toolbarCleanupInFlight) return false;
      toolbarCleanupInFlight = true;
      return true;
    },
    release: () => { toolbarCleanupInFlight = false; },
    stopClosedPaneClis: () => performClosedPaneCliReap()
  };
}

/** ADMIN removal of closed panes older than a number of hours (default 24), in one room or all, in batches. */
export function registerPanePruneRoute(app: FastifyInstance, options: { store: SpaceStore }) {
  const { store } = options;
  app.post(
    "/api/admin/panes/prune",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Pane pruning requires the ADMIN role.");
      }
      const body = (request.body as { olderThanHours?: number; roomId?: string; batchSize?: number } | undefined) ?? {};
      const olderThanHours = typeof body.olderThanHours === "number" ? Math.max(0, body.olderThanHours) : 24;
      const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : undefined;
      const batchSize = typeof body.batchSize === "number" ? Math.max(1, Math.min(body.batchSize, 5000)) : undefined;
      const pruneFn = (store as {
        pruneClosedPanes?: (opts?: { olderThanHours?: number; roomId?: string; batchSize?: number }) => Promise<{ deletedPanes: number }>;
      }).pruneClosedPanes;
      if (typeof pruneFn !== "function") {
        return reply.send({ deletedPanes: 0, olderThanHours, roomId });
      }
      const result = await pruneFn.call(store, { olderThanHours, roomId, batchSize });
      await recordAudit(store, request, {
        action: "pane.prune",
        targetType: "panes",
        targetId: roomId ?? "global",
        metadata: { olderThanHours, roomId, deletedPanes: result.deletedPanes }
      });
      return reply.send({ ...result, olderThanHours, roomId });
    }
  );
}
