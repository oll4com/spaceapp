import { z } from "zod";

const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9:_-]+$/);
const measurement = z.number().finite().min(0).max(1_000_000);
export const terminalRenderReasonSchema = z.enum([
  "GEOMETRY_CONSISTENT", "GRID_CLIPPED", "GRID_CLIPPED_PERSISTENT", "HIDDEN", "MINIMIZED",
  "UNMOUNTED", "RENDERER_UNKNOWN", "GEOMETRY_UNAVAILABLE", "STREAM_COUNTERS_UNAVAILABLE",
  "SESSION_ID_UNAVAILABLE", "BUDGET_LIMITED", "NO_CLIENT", "STALE_SAMPLE", "SESSION_CHANGED",
  "CAPTURE_UNAVAILABLE", "CLIENT_CHANGED", "EXPIRED", "MULTIPLE_CLIENTS"
]);
export const terminalRenderGeometrySchema = z.object({
  hostWidth: measurement, hostHeight: measurement, screenWidth: measurement, screenHeight: measurement,
  cols: z.number().int().min(0).max(10000), rows: z.number().int().min(0).max(10000),
  cellWidth: measurement.nullable(), cellHeight: measurement.nullable(),
  domRows: z.number().int().min(0).max(10000).nullable(),
  dpr: z.number().positive().max(16), zoom: z.number().positive().max(16),
  coverageRatio: z.number().finite().min(0).max(100).nullable(),
  clippedWidth: measurement, clippedHeight: measurement
}).strict();
/** Numeric/enum metadata only. Never add operator terminal text or hashes here. */
export const terminalRenderObservationSchema = z.object({
  schemaVersion: z.literal(1), roomId: id, paneId: id,
  surfaceGeneration: id.nullable(), sessionId: id.nullable(), runtimeId: id.nullable(),
  observedAt: z.number().int().nonnegative(),
  renderer: z.enum(["DOM", "CANVAS", "WEBGL", "UNKNOWN"]),
  visibility: z.enum(["VISIBLE", "HIDDEN", "MINIMIZED", "UNMOUNTED"]),
  verdict: z.enum(["HEALTHY", "SUSPECTED", "FAULT", "INCONCLUSIVE", "NOT_APPLICABLE"]),
  reasons: z.array(terminalRenderReasonSchema).max(16),
  geometry: terminalRenderGeometrySchema.nullable(),
  transportSequence: z.number().int().nonnegative().nullable(),
  parserSequence: z.number().int().nonnegative().nullable(),
  renderSequence: z.number().int().nonnegative().nullable(),
  sampleDurationMs: z.number().finite().min(0).max(60_000)
}).strict();
export const terminalRenderBatchSchema = z.array(terminalRenderObservationSchema).max(64);
export const terminalRenderAuditEvidenceSchema = z.object({
  observation: terminalRenderObservationSchema.nullable(),
  reason: terminalRenderReasonSchema.optional(),
  capture: z.enum(["NOT_REQUESTED", "UNAVAILABLE"])
}).strict();
export type TerminalRenderObservation = z.infer<typeof terminalRenderObservationSchema>;
export type TerminalRenderGeometry = z.infer<typeof terminalRenderGeometrySchema>;
export type TerminalRenderReason = z.infer<typeof terminalRenderReasonSchema>;
export const terminalRenderFreshnessMs = 15_000;
