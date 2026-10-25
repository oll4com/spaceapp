import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import {
  cliSessionCleanupExecuteRequestSchema, cliSessionCleanupPreviewRequestSchema, codexHistoryPurgeExecuteRequestSchema,
  codexHistoryPurgePreviewRequestSchema, type CodexHistoryPurgePreviewResponse,
  codexHistoryPurgePreviewResponseSchema, type CodexHistoryPurgeResponse, codexHistoryPurgeResponseSchema
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import type { CliRuntimeVisibilityPolicy } from "./cli-runtime-visibility.js";
import type { CliSessionCleanupService } from "./cli-session-cleanup.js";
import type { CodexHistoryAccessCoordinator, CodexHistoryPurgeService } from "./codex-history-purge.js";
import { sendApiError } from "./http-errors.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";

/**
 * ADMIN Codex history purge and CLI session cleanup (previews and confirmed runs); the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerCodexHistoryPurgeRoutes(app: FastifyInstance, options: {
  store: SpaceStore;
  cliRuntimeVisibility: CliRuntimeVisibilityPolicy;
  codexHistoryPurgeService: CodexHistoryPurgeService;
  cliSessionCleanupService: CliSessionCleanupService;
  codexHistoryAccessCoordinator: CodexHistoryAccessCoordinator;
  sharedCliTaskPurgePreviews: Map<string, { actorId: string; taskIds: string[]; expiresAt: string; }>;
}) {
  const { store, cliRuntimeVisibility, codexHistoryPurgeService, cliSessionCleanupService,
    codexHistoryAccessCoordinator, sharedCliTaskPurgePreviews } = options;
const emptyCodexHistoryPurgePreview = (protectedThreadIds: string[]): CodexHistoryPurgePreviewResponse => {
  const checkedAt = new Date();
  return {
    status: "NOOP",
    previewId: crypto.randomUUID(),
    candidates: { threads: 0, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
    protectedThreads: protectedThreadIds.length,
    expiresAt: new Date(checkedAt.getTime() + 5 * 60 * 1000).toISOString(),
    checkedAt: checkedAt.toISOString()
  };
};
const emptyCodexHistoryPurgeResult = (
  previewId: string,
  protectedThreadIds: string[]
): CodexHistoryPurgeResponse => ({
  status: "NOOP",
  previewId,
  backupId: crypto.randomUUID(),
  purged: { threads: 0, cliTasks: 0, indexEntries: 0, rolloutFiles: 0, shellSnapshots: 0 },
  protectedThreads: protectedThreadIds.length,
  newlyProtectedThreads: 0,
  completedAt: new Date().toISOString()
});
app.post(
    "/api/admin/codex-history-purge-previews",
    { config: { rateLimit: { max: 6, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "History purge previews require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertAnyCliRuntimeEnabled();
      parseBody(codexHistoryPurgePreviewRequestSchema, request.body ?? {});
      return codexHistoryAccessCoordinator.withExclusivePurge(async () => {
        const [protectedThreadIds, sharedCliTaskIds, codexEnabled] = await Promise.all([
          store.listActiveManagedCodexThreadIds(),
          store.listInactivePaneCliTaskIds(),
          cliRuntimeVisibility.isEnabled("cli:codex")
        ]);
        const nativePreview = codexEnabled
          ? codexHistoryPurgePreviewResponseSchema.parse(await codexHistoryPurgeService.preview({
              actorId: request.user!.id,
              protectedThreadIds
            }))
          : emptyCodexHistoryPurgePreview(protectedThreadIds);
        const preview = codexHistoryPurgePreviewResponseSchema.parse({
          ...nativePreview,
          status: nativePreview.status === "READY" || sharedCliTaskIds.length > 0 ? "READY" : "NOOP",
          candidates: {
            ...nativePreview.candidates,
            cliTasks: sharedCliTaskIds.length
          }
        });
        const now = Date.now();
        for (const [previewId, cached] of sharedCliTaskPurgePreviews) {
          if (Date.parse(cached.expiresAt) <= now) sharedCliTaskPurgePreviews.delete(previewId);
        }
        sharedCliTaskPurgePreviews.set(preview.previewId, {
          actorId: request.user!.id,
          taskIds: sharedCliTaskIds,
          expiresAt: preview.expiresAt
        });
        return preview;
      });
    }
  );
  app.post(
    "/api/admin/codex-history-purges",
    { config: { rateLimit: { max: 2, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "History purge requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertAnyCliRuntimeEnabled();
      const input = parseBody(codexHistoryPurgeExecuteRequestSchema, request.body ?? {});
      return codexHistoryAccessCoordinator.withExclusivePurge(async () => {
        const actorId = request.user!.id;
        const cachedPreview = sharedCliTaskPurgePreviews.get(input.previewId);
        if (!cachedPreview || cachedPreview.actorId !== actorId) {
          throw new SpaceConflictError("History purge preview is unavailable; refresh the preview before retrying.");
        }
        const [protectedThreadIds, codexEnabled] = await Promise.all([
          store.listActiveManagedCodexThreadIds(),
          cliRuntimeVisibility.isEnabled("cli:codex")
        ]);
        const nativeResult = codexEnabled
          ? codexHistoryPurgeResponseSchema.parse(await codexHistoryPurgeService.execute({
              actorId,
              previewId: input.previewId,
              protectedThreadIds
            }))
          : emptyCodexHistoryPurgeResult(input.previewId, protectedThreadIds);
        let hiddenSharedCliTaskIds: string[];
        try {
          hiddenSharedCliTaskIds = await store.hideInactivePaneCliTasks(cachedPreview.taskIds);
        } catch (sharedHistoryError) {
          if (!codexEnabled) {
            throw new SpaceConflictError("History purge failed.");
          }
          try {
            await codexHistoryPurgeService.rollback({
              actorId,
              previewId: nativeResult.previewId,
              backupId: nativeResult.backupId
            });
          } catch (rollbackError) {
            request.log.error(
              { sharedHistoryError, rollbackError, requestId: request.requestIdForSpace },
              "Shared CLI history purge failed and native history rollback failed"
            );
            throw new SpaceConflictError("History purge failed and recovery is required.");
          }
          throw new SpaceConflictError("History purge failed; native history was restored.");
        }
        const purged = {
          ...nativeResult.purged,
          cliTasks: hiddenSharedCliTaskIds.length
        };
        const result = codexHistoryPurgeResponseSchema.parse({
          ...nativeResult,
          status: Object.values(purged).some((count) => count > 0) ? "COMPLETED" : "NOOP",
          purged
        });
        try {
          await recordAudit(store, request, {
            action: "admin.codex_history.purged",
            targetType: "codex_history",
            targetId: result.backupId,
            metadata: {
              status: result.status,
              previewId: result.previewId,
              purged: result.purged,
              protectedThreads: result.protectedThreads,
              newlyProtectedThreads: result.newlyProtectedThreads
            }
          });
        } catch (auditError) {
          let nativeRollbackCompleted = !codexEnabled;
          let sharedRollbackCompleted = false;
          try {
            await store.restorePaneCliTasks(hiddenSharedCliTaskIds);
            sharedRollbackCompleted = true;
          } catch (sharedRollbackError) {
            request.log.error(
              { auditError, sharedRollbackError, requestId: request.requestIdForSpace },
              "Shared CLI history purge audit and rollback failed"
            );
          }
          if (codexEnabled) {
            try {
              await codexHistoryPurgeService.rollback({
                actorId,
                previewId: result.previewId,
                backupId: result.backupId
              });
              nativeRollbackCompleted = true;
            } catch (rollbackError) {
              request.log.error(
                { auditError, rollbackError, requestId: request.requestIdForSpace },
                "Codex history purge audit and rollback failed"
              );
            }
          }
          throw new SpaceConflictError(nativeRollbackCompleted && sharedRollbackCompleted
            ? "History purge audit failed; the purge was rolled back."
            : "History purge audit failed; recovery is required.");
        }
        return result;
      });
    }
  );
  app.post(
    "/api/admin/cli-session-cleanup-previews",
    { config: { rateLimit: { max: 6, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI session cleanup previews require the ADMIN role.");
      }
      await cliRuntimeVisibility.assertAnyCliRuntimeEnabled();
      parseBody(cliSessionCleanupPreviewRequestSchema, request.body ?? {});
      return codexHistoryAccessCoordinator.withExclusivePurge(async () => {
        const [protectedThreadIds, codexEnabled] = await Promise.all([
          store.listActiveManagedCodexThreadIds(),
          cliRuntimeVisibility.isEnabled("cli:codex")
        ]);
        return cliSessionCleanupService.preview({
          actorId: request.user!.id,
          protectedThreadIds,
          codexEnabled
        });
      });
    }
  );
  app.post(
    "/api/admin/cli-session-cleanups",
    { config: { rateLimit: { max: 2, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI session cleanup requires the ADMIN role.");
      }
      await cliRuntimeVisibility.assertAnyCliRuntimeEnabled();
      const input = parseBody(cliSessionCleanupExecuteRequestSchema, request.body ?? {});
      return codexHistoryAccessCoordinator.withExclusivePurge(async () => {
        const actorId = request.user!.id;
        const [protectedThreadIds, codexEnabled] = await Promise.all([
          store.listActiveManagedCodexThreadIds(),
          cliRuntimeVisibility.isEnabled("cli:codex")
        ]);
        const result = await cliSessionCleanupService.execute({
          actorId,
          previewId: input.previewId,
          protectedThreadIds,
          codexEnabled
        });
        try {
          await recordAudit(store, request, {
            action: "admin.cli_sessions.cleaned",
            targetType: "cli_sessions",
            targetId: result.previewId,
            metadata: {
              status: result.status,
              cleaned: result.cleaned,
              totalBytes: result.totalBytes,
              failures: result.failures
            }
          });
        } catch (auditError) {
          request.log.error(
            { auditError, requestId: request.requestIdForSpace },
            "CLI session cleanup audit failed"
          );
          throw new SpaceConflictError("CLI session cleanup audit failed; the cleanup completed but was not recorded.");
        }
        return result;
      });
    }
  );
}
