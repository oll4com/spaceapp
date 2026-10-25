import { z } from "zod";

const activityLogIdSchema = z.string()
  .min(8)
  .max(128)
  .regex(/^[a-zA-Z0-9._:-]+$/);

const activityLogFilterSchema = z.string().min(1).max(128);

const activityLogIsoSchema = z.string().datetime({ offset: true });

export const activityLogActionSchema = z.enum(["room.create"]);
export type ActivityLogAction = z.infer<typeof activityLogActionSchema>;

export const activityLogEventSchema = z.object({
  id: activityLogIdSchema,
  roomId: activityLogIdSchema.nullable(),
  actorUserId: activityLogIdSchema.nullable(),
  action: activityLogActionSchema,
  reason: z.string().max(500).nullable(),
  traceId: z.string().min(8).max(128),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: activityLogIsoSchema
}).strict();
export type ActivityLogEvent = z.infer<typeof activityLogEventSchema>;

export const activityLogSettingsSchema = z.object({
  enabled: z.boolean(),
  enabledAt: activityLogIsoSchema.nullable(),
  enabledByUserId: activityLogIdSchema.nullable(),
  disabledAt: activityLogIsoSchema.nullable(),
  disabledByUserId: activityLogIdSchema.nullable(),
  updatedAt: activityLogIsoSchema
}).strict();
export type ActivityLogSettings = z.infer<typeof activityLogSettingsSchema>;

export const updateActivityLogSettingsInputSchema = z.object({
  enabled: z.boolean()
}).strict();
export type UpdateActivityLogSettingsInput = z.infer<typeof updateActivityLogSettingsInputSchema>;

export const listActivityLogEventsQuerySchema = z.object({
  roomId: activityLogIdSchema.optional(),
  action: activityLogActionSchema.optional(),
  actorUserId: activityLogFilterSchema.optional(),
  hasReason: z.enum(["true", "false"]).optional()
    .transform((value) => (value === undefined ? undefined : value === "true")),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
}).strict();
export type ListActivityLogEventsQuery = z.infer<typeof listActivityLogEventsQuerySchema>;
