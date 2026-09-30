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

export const systemTopologyNodeTypeSchema = z.enum([
  "client",
  "gateway",
  "database",
  "service",
  "runtime",
  "infra",
  "external",
]);

export const systemTopologyNodeStatusSchema = z.enum([
  "healthy",
  "warning",
  "critical",
  "unavailable",
  "disabled",
]);

export const systemTopologyNodeMetricSchema = z
  .object({
    label: z.string().max(100),
    value: z.string().max(160),
  })
  .strict();

export const systemTopologySubcomponentSchema = z
  .object({
    id: z.string().min(1).max(120),
    name: z.string().min(1).max(160),
    category: z.string().max(80),
    status: z.enum(["healthy", "warning", "critical", "unavailable", "disabled", "active"]),
    description: z.string().max(500),
    riskLevel: z.string().max(30).optional(),
    protocol: z.string().max(60).optional(),
  })
  .strict();

export const systemTopologyNodeSchema = z
  .object({
    id: z.string().min(1).max(80),
    label: z.string().min(1).max(120),
    type: systemTopologyNodeTypeSchema,
    group: z.enum(["clients", "core", "runtimes", "external", "infra"]),
    status: systemTopologyNodeStatusSchema,
    detail: z.string().max(500),
    host: z.string().max(100).optional(),
    metrics: z.array(systemTopologyNodeMetricSchema).max(16).default([]),
    subcomponents: z.array(systemTopologySubcomponentSchema).max(64).optional(),
  })
  .strict();

export const systemTopologyEdgeSchema = z
  .object({
    id: z.string().min(1).max(120),
    source: z.string().min(1).max(80),
    target: z.string().min(1).max(80),
    label: z.string().max(100),
    protocol: z.string().max(60),
    status: z.enum(["active", "degraded", "inactive"]),
    direction: z.enum(["forward", "bidirectional"]).default("forward"),
    detail: z.string().max(300).optional(),
  })
  .strict();

export const systemTopologySnapshotSchema = z
  .object({
    sampledAt: z.string().datetime(),
    nodes: z.array(systemTopologyNodeSchema).max(64),
    edges: z.array(systemTopologyEdgeSchema).max(128),
    summary: z
      .object({
        totalNodes: z.number().int().nonnegative(),
        healthyNodes: z.number().int().nonnegative(),
        warningNodes: z.number().int().nonnegative(),
        criticalNodes: z.number().int().nonnegative(),
        activeEdges: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export type SystemTopologyNodeType = z.infer<typeof systemTopologyNodeTypeSchema>;
export type SystemTopologyNodeStatus = z.infer<typeof systemTopologyNodeStatusSchema>;
export type SystemTopologyNodeMetric = z.infer<typeof systemTopologyNodeMetricSchema>;
export type SystemTopologySubcomponent = z.infer<typeof systemTopologySubcomponentSchema>;
export type SystemTopologyNode = z.infer<typeof systemTopologyNodeSchema>;
export type SystemTopologyEdge = z.infer<typeof systemTopologyEdgeSchema>;
export type SystemTopologySnapshot = z.infer<typeof systemTopologySnapshotSchema>;

