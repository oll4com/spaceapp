import type {} from "./request-context.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  cliMaintenanceRequestSchema, cliUpdateAllRequestSchema, idSchema, maintenanceApplyRequestSchema,
  maintenancePlanRequestSchema
} from "@space/contracts";
import type { SpaceStore } from "@space/runtime";
import type { CliMaintenanceManager, CliUpdateAllRunner } from "./cli-maintenance.js";
import { sendApiError } from "./http-errors.js";
import type { NotificationService } from "./notifications/service.js";
import type { AuditRecorder } from "./request-audit.js";
import { formatSseMessage, startSseHeartbeat } from "./sse.js";

export const cliMaintenanceRunParamSchema = z.object({ runId: idSchema }).strict();
const cliMaintenanceReplayQuerySchema = z.object({
  afterSequence: z.coerce.number().int().min(0).max(1_000_000_000).default(0)
}).strict();

/**
 * ADMIN CLI health, repair and update-all domain. Every route keeps its own
 * stricter rate limit. Opening provider logins in the CLI Recovery room creates
 * rooms and CLI panes, so that route stays in the composition root, which also
 * retains authentication, CSRF and errors.
 */
export function registerCliMaintenanceRoutes(app: FastifyInstance, options: {
  store: Pick<SpaceStore, "listCliRuntimeSettings" | "upsertUser">;
  cliMaintenanceManager: CliMaintenanceManager;
  cliUpdateAllRunner: CliUpdateAllRunner;
  recordAudit: AuditRecorder;
  notifications?: Pick<NotificationService, "raise">;
}) {
  const { store, cliMaintenanceManager, cliUpdateAllRunner, recordAudit, notifications } = options;
  // An update takes minutes and its window may be minimized or closed, so its end is a notification too.
  async function notifyUpdateAll(request: FastifyRequest, failed: boolean, title: string, body: string) {
    if (!notifications || !request.user) return;
    try {
      await notifications.raise({
        ownerUserId: (await store.upsertUser(request.user)).id, roomId: null, paneId: null, source: "SYSTEM", kind: "CLI_UPDATE_FINISHED",
        severity: failed ? "ATTENTION" : "INFO", title, body, link: {}, dedupeKey: null, payload: {}, telegram: null
      });
    } catch (error) {
      request.log.warn({ err: error }, "CLI update-all notification failed");
    }
  }
  app.get(
    "/api/admin/cli-maintenance/runs",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI maintenance requires the ADMIN role.");
      }
      return { data: await cliMaintenanceManager.list() };
    }
  );
  app.get(
    "/api/admin/cli-maintenance/runs/:runId",
    { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI maintenance requires the ADMIN role.");
      }
      const params = cliMaintenanceRunParamSchema.parse(request.params);
      return cliMaintenanceManager.get(params.runId);
    }
  );
  app.get(
    "/api/admin/cli-maintenance/runs/:runId/replay",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI maintenance replay requires the ADMIN role.");
      }
      const params = cliMaintenanceRunParamSchema.parse(request.params);
      const query = cliMaintenanceReplayQuerySchema.parse(request.query);
      return cliMaintenanceManager.replay(params.runId, query.afterSequence);
    }
  );
  app.get(
    "/api/admin/cli-maintenance/runs/:runId/export",
    { config: { rateLimit: { max: 12, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI maintenance export requires the ADMIN role.");
      }
      const params = cliMaintenanceRunParamSchema.parse(request.params);
      const exported = await cliMaintenanceManager.export(params.runId);
      const suffix = params.runId.slice(params.runId.indexOf(":") + 1);
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Disposition", `attachment; filename="cli-health-repair-${suffix}.json"`);
      return exported;
    }
  );
  app.get(
    "/api/admin/cli-maintenance/runs/:runId/stream",
    {
      compress: false,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } }
    },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI maintenance live progress requires the ADMIN role.");
      }
      const params = cliMaintenanceRunParamSchema.parse(request.params);
      const query = cliMaintenanceReplayQuerySchema.parse(request.query);
      const rawLastEventId = request.headers["last-event-id"];
      const lastEventId = Array.isArray(rawLastEventId) ? rawLastEventId[0] : rawLastEventId;
      const parsedLastEventId = /^\d{1,10}$/.test(String(lastEventId ?? ""))
        ? Math.min(1_000_000_000, Number(lastEventId))
        : 0;
      let afterSequence = Math.max(query.afterSequence, parsedLastEventId);
      const replay = await cliMaintenanceManager.replay(params.runId, afterSequence);

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      reply.raw.write(formatSseMessage("ready", {
        runId: replay.run.id,
        afterSequence,
        requestId: request.requestIdForSpace
      }));
      for (const event of replay.events) {
        afterSequence = event.sequence;
        reply.raw.write(formatSseMessage("progress", event, event.sequence));
      }
      reply.raw.write(formatSseMessage("run", replay.run));
      if (cliMaintenanceManager.isStreamTerminal(replay)) {
        reply.raw.end();
        return;
      }

      let isClosed = false;
      let polling = false;
      let lastRunUpdatedAt = replay.run.updatedAt;
      let pollTimer: ReturnType<typeof setInterval> | null = null;
      const stopHeartbeat = startSseHeartbeat((frame) => {
        if (!isClosed) reply.raw.write(frame);
      });
      const closeStream = () => {
        if (isClosed) return;
        isClosed = true;
        if (pollTimer) clearInterval(pollTimer);
        stopHeartbeat();
      };
      const poll = async () => {
        if (isClosed || polling) return;
        polling = true;
        try {
          const current = await cliMaintenanceManager.replay(params.runId, afterSequence);
          for (const event of current.events) {
            afterSequence = event.sequence;
            reply.raw.write(formatSseMessage("progress", event, event.sequence));
          }
          if (current.run.updatedAt !== lastRunUpdatedAt || cliMaintenanceManager.isStreamTerminal(current)) {
            lastRunUpdatedAt = current.run.updatedAt;
            reply.raw.write(formatSseMessage("run", current.run));
          }
          if (cliMaintenanceManager.isStreamTerminal(current)) {
            closeStream();
            reply.raw.end();
          }
        } catch {
          if (!isClosed) {
            reply.raw.write(formatSseMessage("stream-error", {
              code: "CLI_MAINTENANCE_STREAM_UNAVAILABLE",
              message: "Live progress paused; durable replay remains available."
            }));
            closeStream();
            reply.raw.end();
          }
        } finally {
          polling = false;
        }
      };
      pollTimer = setInterval(() => void poll(), 500);
      reply.raw.once("close", closeStream);
      request.raw.once("aborted", closeStream);
    }
  );

  app.post("/api/admin/cli-maintenance/plans", { config: { rateLimit: { max: 4, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Maintenance requires ADMIN.");
    const run = await cliMaintenanceManager.createPlan(maintenancePlanRequestSchema.parse(request.body ?? {}), request.user.id);
    await recordAudit(request, { action: "cli_maintenance.plan_queued", targetType: "admin_operation_run", targetId: run.id, metadata: {} });
    return reply.code(202).send(run);
  });
  app.post("/api/admin/cli-maintenance/plans/:planId/apply", { config: { rateLimit: { max: 4, timeWindow: "15 minutes" } } }, async (request, reply) => {
    if (request.user?.role !== "ADMIN") return sendApiError(reply, 403, "ADMIN_REQUIRED", "Maintenance requires ADMIN.");
    const { planId } = request.params as { planId: string };
    const run = await cliMaintenanceManager.applyPlan(planId, maintenanceApplyRequestSchema.parse(request.body), request.user.id);
    await recordAudit(request, { action: "cli_maintenance.plan_applied", targetType: "admin_operation_run", targetId: run.id, metadata: { planId } });
    return reply.code(202).send(run);
  });
  app.post(
    "/api/admin/cli-maintenance/runs",
    { config: { rateLimit: { max: 4, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI maintenance requires the ADMIN role.");
      }
      const input = cliMaintenanceRequestSchema.parse(request.body);
      const run = await cliMaintenanceManager.start(input, request.user.id);
      await recordAudit(request, {
        action: input.mode === "CHECK"
          ? "cli_maintenance.check_queued"
          : input.mode === "REPAIR"
            ? "cli_maintenance.repair_queued"
            : "cli_maintenance.update_queued",
        targetType: "admin_operation_run",
        targetId: run.id,
        metadata: {
          operationType: run.operationType,
          status: run.status
        }
      });
      return reply.status(202).send(run);
    }
  );
  app.get(
    "/api/admin/cli-maintenance/update-all/detect",
    { config: { rateLimit: { max: 30, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI update-all detection requires the ADMIN role.");
      }
      try {
        const detection = await cliUpdateAllRunner.detect(await store.listCliRuntimeSettings());
        return reply.send(detection);
      } catch (error) {
        request.log.error({ err: error }, "CLI update-all detection failed");
        return sendApiError(reply, 502, "UPDATE_ALL_DETECTION_FAILED", "CLI update-all detection could not be completed.");
      }
    }
  );
  app.post(
    "/api/admin/cli-maintenance/update-all/run",
    { config: { rateLimit: { max: 4, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "CLI update-all requires the ADMIN role.");
      }
      let input: ReturnType<typeof cliUpdateAllRequestSchema.parse> = {};
      try {
        input = cliUpdateAllRequestSchema.parse(request.body ?? {});
      } catch {
        return sendApiError(reply, 400, "INVALID_UPDATE_ALL_REQUEST", "Invalid CLI update-all request body.");
      }
      try {
        const result = await cliUpdateAllRunner.updateAll(input);
        await recordAudit(request, {
          action: "cli_maintenance.update_all_completed",
          targetType: "cli_update_all",
          targetId: `admin_run:${Date.now().toString(36)}`,
          metadata: {
            mode: result.mode,
            overallStatus: result.overallStatus,
            runtimeCount: result.runtimes?.length ?? 0,
            scope: result.scope,
            reinstall: result.reinstall
          }
        });
        const updated = result.runtimes.filter((runtime) => runtime.code.startsWith("UPDATED")).length;
        const failed = result.runtimes.filter((runtime) => runtime.status === "FAIL").length;
        await notifyUpdateAll(
          request,
          result.overallStatus === "FAIL" || result.overallStatus === "WARN",
          result.overallStatus === "FAIL" ? "CLI update finished with failures"
            : result.overallStatus === "WARN" ? "CLI update finished with warnings" : "CLI update finished",
          `${updated} updated · ${failed} failed · ${result.runtimes.length} checked.`
        );
        return reply.send(result);
      } catch (error) {
        request.log.error({ err: error }, "CLI update-all run failed");
        await notifyUpdateAll(request, true, "CLI update failed", "The CLI update could not be completed. Open Manage → Update All for details.");
        return sendApiError(reply, 502, "UPDATE_ALL_FAILED", "CLI update-all could not be completed.");
      }
    }
  );
}
