import type {} from "./request-context.js";
import type { FastifyInstance } from "fastify";
import {
  maintenanceAutopilotRunRequestSchema,
  maintenanceAutopilotScheduleUpdateSchema,
  maintenanceAutopilotStatusSchema
} from "@space/contracts";
import { sendApiError } from "./http-errors.js";
import type { MaintenanceAutopilot } from "./maintenance-autopilot.js";
import type { AuditRecorder } from "./request-audit.js";

/** ADMIN one-tap maintenance: status, run now, and the nightly schedule. */
export function registerMaintenanceAutopilotRoutes(app: FastifyInstance, options: {
  autopilot: MaintenanceAutopilot;
  recordAudit: AuditRecorder;
}) {
  const { autopilot, recordAudit } = options;
  app.get(
    "/api/admin/maintenance-autopilot",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Maintenance requires the ADMIN role.");
      }
      return maintenanceAutopilotStatusSchema.parse(await autopilot.status());
    }
  );
  app.post(
    "/api/admin/maintenance-autopilot/runs",
    { config: { rateLimit: { max: 4, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Maintenance requires the ADMIN role.");
      }
      maintenanceAutopilotRunRequestSchema.parse(request.body ?? {});
      const run = await autopilot.start("MANUAL", request.user.id);
      await recordAudit(request, {
        action: "admin.maintenance_autopilot.started",
        targetType: "maintenance_autopilot",
        targetId: run.id,
        metadata: { trigger: run.trigger }
      });
      return reply.code(202).send(maintenanceAutopilotStatusSchema.parse(await autopilot.status()));
    }
  );
  app.put(
    "/api/admin/maintenance-autopilot/schedule",
    { config: { rateLimit: { max: 20, timeWindow: "5 minutes" } } },
    async (request, reply) => {
      if (request.user?.role !== "ADMIN") {
        return sendApiError(reply, 403, "ADMIN_REQUIRED", "Maintenance requires the ADMIN role.");
      }
      const input = maintenanceAutopilotScheduleUpdateSchema.parse(request.body ?? {});
      const schedule = await autopilot.updateSchedule(input, request.user.id);
      await recordAudit(request, {
        action: schedule.enabled ? "admin.maintenance_autopilot.scheduled" : "admin.maintenance_autopilot.unscheduled",
        targetType: "maintenance_autopilot",
        targetId: "nightly",
        metadata: { hour: schedule.hour, timeZone: schedule.timeZone }
      });
      return maintenanceAutopilotStatusSchema.parse(await autopilot.status());
    }
  );
}
