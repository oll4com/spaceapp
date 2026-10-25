import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { CliLoginResponse } from "@space/contracts";
import type { SpaceEventBus, SpaceStore } from "@space/runtime";
import type { ActivityLogService } from "./activity-log.js";
import type { CliMaintenanceManager } from "./cli-maintenance.js";
import { sendApiError } from "./http-errors.js";
import { getLatestRoomEvent } from "./pane-guards.js";
import { recordAudit } from "./request-audit.js";
import { parseBody } from "./route-parsing.js";

/**
 * ADMIN CLI maintenance login handoff: opens provider logins in the CLI Recovery room; the parent retains
 * authentication, CSRF, errors and rate limits.
 */
export function registerCliAuthHandoffRoutes(app: FastifyInstance, deps: {
  options: {
    cliRecoveryLoginOpener?: (input: { roomId: string; runtimeId: string; requestId: string; }) => Promise<{ paneId: string }>;
  };
  store: SpaceStore;
  activityLogService: ActivityLogService;
  cliMaintenanceManager: CliMaintenanceManager;
  eventBus: SpaceEventBus;
  openCliLogin: (request: FastifyRequest, roomId: string, runtimeId: string) => Promise<CliLoginResponse>;
}) {
  const { options, store, activityLogService, cliMaintenanceManager, eventBus, openCliLogin } = deps;
  app.post(
    "/api/admin/cli-maintenance/auth-handoffs/open",
    { config: { rateLimit: { max: 8, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI Recovery requires the ADMIN role.");
      }
      parseBody(z.object({}).strict(), request.body ?? {});
      const candidates = await cliMaintenanceManager.listAuthHandoffsForRecovery();
      if (candidates.length === 0) {
        return { status: "NOOP", room: null, handoffs: [], loginPanes: [] };
      }

      let room = (await store.listRooms()).find((candidate) => candidate.kind === "CLI_RECOVERY") ?? null;
      if (!room) {
        room = await store.createRoom(
          {
            name: "CLI Recovery",
            description: "Reusable provider login room created by Space health and repair.",
            initialPaneCount: 0,
            kind: "CLI_RECOVERY"
          },
          request.requestIdForSpace
        );
        await activityLogService.recordRoomCreate({
          roomId: room.id,
          actorUserId: null,
          reason: "CLI maintenance recovery room",
          traceId: request.requestIdForSpace,
          metadata: { roomName: room.name, source: "cli-maintenance" }
        });
        const latestEvent = await getLatestRoomEvent(store, room.id);
        if (latestEvent) eventBus.publish(latestEvent);
      }

      const handoffs = [];
      const loginPanes: Array<{
        handoffId: string;
        runtimeId: string;
        paneId: string | null;
        status: "OPENED" | "FAILED";
        safeErrorCode: string | null;
      }> = [];
      for (const handoff of candidates) {
        if (handoff.status === "OPENED" && handoff.roomId === room.id) {
          handoffs.push(handoff);
          continue;
        }
        const attemptCount = handoff.attemptCount + 1;
        try {
          const opened = options.cliRecoveryLoginOpener
            ? await options.cliRecoveryLoginOpener({
                roomId: room.id,
                runtimeId: handoff.runtimeId,
                requestId: request.requestIdForSpace
              })
            : await openCliLogin(request, room.id, handoff.runtimeId).then((result) => ({
                paneId: result.pane.id
              }));
          const updated = await store.updateCliMaintenanceAuthHandoff(handoff.id, {
            roomId: room.id,
            status: "OPENED",
            attemptCount,
            safeErrorCode: null
          });
          await store.appendCliMaintenanceEvent({
            runId: handoff.runId,
            runtimeId: handoff.runtimeId,
            phase: "AUTH_HANDOFF",
            state: "SUCCEEDED",
            severity: "INFO",
            code: "CLI_RECOVERY_OPENED",
            message: `${handoff.runtimeId} provider login opened in CLI Recovery.`,
            attempt: Math.min(10, Math.max(1, attemptCount)),
            installedVersion: null,
            availableVersion: null,
            targetVersion: null,
            durationMs: null,
            outcome: "ACTION_REQUIRED",
            rollback: null,
            diagnostics: {}
          });
          handoffs.push(updated);
          loginPanes.push({
            handoffId: handoff.id,
            runtimeId: handoff.runtimeId,
            paneId: opened.paneId,
            status: "OPENED",
            safeErrorCode: null
          });
        } catch {
          const updated = await store.updateCliMaintenanceAuthHandoff(handoff.id, {
            roomId: room.id,
            status: "FAILED",
            attemptCount,
            safeErrorCode: "CLI_LOGIN_UNAVAILABLE"
          });
          await store.appendCliMaintenanceEvent({
            runId: handoff.runId,
            runtimeId: handoff.runtimeId,
            phase: "AUTH_HANDOFF",
            state: "FAILED",
            severity: "ERROR",
            code: "CLI_LOGIN_UNAVAILABLE",
            message: `${handoff.runtimeId} provider login could not be opened; durable retry remains available.`,
            attempt: Math.min(10, Math.max(1, attemptCount)),
            installedVersion: null,
            availableVersion: null,
            targetVersion: null,
            durationMs: null,
            outcome: "ACTION_REQUIRED",
            rollback: null,
            diagnostics: {}
          });
          handoffs.push(updated);
          loginPanes.push({
            handoffId: handoff.id,
            runtimeId: handoff.runtimeId,
            paneId: null,
            status: "FAILED",
            safeErrorCode: "CLI_LOGIN_UNAVAILABLE"
          });
        }
      }
      await recordAudit(store, request, {
        action: "cli_maintenance.recovery_opened",
        targetType: "room",
        targetId: room.id,
        metadata: {
          handoffCount: handoffs.length,
          openedCount: handoffs.filter((handoff) => handoff.status === "OPENED").length,
          failedCount: handoffs.filter((handoff) => handoff.status === "FAILED").length
        }
      });
      return {
        status: handoffs.some((handoff) => handoff.status === "OPENED") ? "OPENED" : "FAILED",
        room,
        handoffs,
        loginPanes
      };
    }
  );
}
