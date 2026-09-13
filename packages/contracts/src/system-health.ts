import { z } from "zod";

export const systemHealthRangeSchema = z.enum(["1m", "10m", "1h", "7d", "30d"]);
export const systemHealthUnitSchema = z.enum([
  "PERCENT",
  "BYTES",
  "BYTES_PER_SECOND",
  "MILLISECONDS",
  "COUNT",
]);
export const systemHealthMetricSchema = z
  .object({
    id: z.string().min(1).max(160),
    label: z.string().min(1).max(160),
    group: z.enum(["cpu", "memory", "swap", "disk", "network", "requests"]),
    unit: systemHealthUnitSchema,
    value: z.number().finite().nonnegative().nullable(),
    total: z.number().finite().nonnegative().nullable().optional(),
    detail: z.string().max(300),
    sampledAt: z.string().datetime(),
  })
  .strict();
export const systemHealthServiceSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    status: z.enum([
      "healthy",
      "warning",
      "critical",
      "unavailable",
      "disabled",
    ]),
    detail: z.string().max(500),
    checkedAt: z.string().datetime(),
    values: z
      .array(
        z
          .object({ label: z.string().max(100), value: z.string().max(160) })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();
export const systemHealthRequestsSchema = z
  .object({
    windowSeconds: z.literal(300),
    requestCount: z.number().int().nonnegative(),
    errorCount: z.number().int().nonnegative(),
    errorRatePercent: z.number().min(0).max(100).nullable(),
    p95Ms: z.number().nonnegative().nullable(),
    sampledAt: z.string().datetime(),
  })
  .strict();
export const systemHealthSnapshotSchema = z
  .object({
    sampledAt: z.string().datetime(),
    metrics: z.array(systemHealthMetricSchema).max(128),
    services: z.array(systemHealthServiceSchema).max(32),
    requests: systemHealthRequestsSchema,
    uptimeSeconds: z.number().nonnegative(),
    coreCount: z.number().int().positive(),
  })
  .strict();
export const systemHealthSeriesSchema = z
  .object({
    id: z.string().max(160),
    label: z.string().max(160),
    unit: systemHealthUnitSchema,
    points: z
      .array(
        z
          .object({
            at: z.string().datetime(),
            min: z.number().nonnegative(),
            avg: z.number().nonnegative(),
            max: z.number().nonnegative(),
          })
          .strict(),
      )
      .max(720),
  })
  .strict();
export const systemHealthHistorySchema = z
  .object({
    range: systemHealthRangeSchema,
    sampledAt: z.string().datetime(),
    series: z.array(systemHealthSeriesSchema).max(128),
  })
  .strict();
export type SystemHealthRange = z.infer<typeof systemHealthRangeSchema>;
export type SystemHealthMetric = z.infer<typeof systemHealthMetricSchema>;
export type SystemHealthService = z.infer<typeof systemHealthServiceSchema>;
export type SystemHealthRequests = z.infer<typeof systemHealthRequestsSchema>;
export type SystemHealthSnapshot = z.infer<typeof systemHealthSnapshotSchema>;
export type SystemHealthSeries = z.infer<typeof systemHealthSeriesSchema>;
export type SystemHealthHistory = z.infer<typeof systemHealthHistorySchema>;
