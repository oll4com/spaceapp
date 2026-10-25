import { z } from "zod";

/**
 * One-tap maintenance: safe cleanup, memory relief and guarded CLI updates
 * run server-side in a fixed order, on demand or nightly. History purge is
 * never part of it because it permanently deletes task history.
 */
export const maintenanceAutopilotStepIdSchema = z.enum(["cleanup", "memory", "check", "update"]);
export const maintenanceAutopilotStepStatusSchema = z.enum(["PENDING", "RUNNING", "DONE", "SKIPPED", "WARNING", "FAILED"]);
export const maintenanceAutopilotRunStatusSchema = z.enum(["RUNNING", "SUCCEEDED", "PARTIAL", "FAILED"]);
export const maintenanceAutopilotTriggerSchema = z.enum(["MANUAL", "SCHEDULED"]);

export const maintenanceAutopilotStepSchema = z.object({
  id: maintenanceAutopilotStepIdSchema,
  status: maintenanceAutopilotStepStatusSchema,
  summary: z.string().max(400),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable()
}).strict();

export const maintenanceAutopilotRunSchema = z.object({
  id: z.string().min(1).max(80),
  trigger: maintenanceAutopilotTriggerSchema,
  status: maintenanceAutopilotRunStatusSchema,
  summary: z.string().max(400),
  steps: z.array(maintenanceAutopilotStepSchema).max(8),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable()
}).strict();

export const maintenanceAutopilotScheduleSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23),
  timeZone: z.string().min(1).max(64),
  nextRunAt: z.string().datetime().nullable()
}).strict();

export const maintenanceAutopilotStatusSchema = z.object({
  schedule: maintenanceAutopilotScheduleSchema,
  currentRun: maintenanceAutopilotRunSchema.nullable(),
  lastRun: maintenanceAutopilotRunSchema.nullable(),
  checkedAt: z.string().datetime()
}).strict();

export const maintenanceAutopilotRunRequestSchema = z.object({}).strict();
export const maintenanceAutopilotScheduleUpdateSchema = z.object({
  enabled: z.boolean(),
  hour: z.number().int().min(0).max(23).optional(),
  timeZone: z.string().min(1).max(64).optional()
}).strict();

export type MaintenanceAutopilotStepId = z.infer<typeof maintenanceAutopilotStepIdSchema>;
export type MaintenanceAutopilotStepStatus = z.infer<typeof maintenanceAutopilotStepStatusSchema>;
export type MaintenanceAutopilotStep = z.infer<typeof maintenanceAutopilotStepSchema>;
export type MaintenanceAutopilotRun = z.infer<typeof maintenanceAutopilotRunSchema>;
export type MaintenanceAutopilotSchedule = z.infer<typeof maintenanceAutopilotScheduleSchema>;
export type MaintenanceAutopilotStatus = z.infer<typeof maintenanceAutopilotStatusSchema>;
export type MaintenanceAutopilotScheduleUpdate = z.infer<typeof maintenanceAutopilotScheduleUpdateSchema>;
