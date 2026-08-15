import { z } from "zod";

export const appDiagnosticsRetentionHours = 24;
export const appDiagnosticsQuotaBytes = 8 * 1024 ** 3;
export const appDiagnosticsTechnicalQuotaBytes = 512 * 1024 ** 2;
export const appDiagnosticsVisualQuotaBytes = appDiagnosticsQuotaBytes - appDiagnosticsTechnicalQuotaBytes;
export const appDiagnosticsVideoLeaseTtlSeconds = 90;
export const appDiagnosticsVideoHeartbeatSeconds = 30;
export const appDiagnosticsEventBatchMaxEvents = 200;
export const appDiagnosticsEventBatchMaxBytes = 256 * 1024;
export const appDiagnosticsClientBufferMaxEvents = 1_000;
export const appDiagnosticsClientBufferMaxBytes = 2 * 1024 ** 2;
export const appDiagnosticsSnapshotMaxElements = 2_000;
export const appDiagnosticsSnapshotMaxBytes = 256 * 1024;
export const appDiagnosticsVideoSegmentMaxBytes = 4 * 1024 ** 2;
export const appDiagnosticsMaxSegments = 250_000;

const diagnosticsIdSchema = z.string()
  .min(6)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
const sequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const occurredAtSchema = z.iso.datetime({ offset: true });
const safeTechnicalNameSchema = z.string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const safeTechnicalValueSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._:/%#(),-]*$/);
const safePathTemplateSchema = z.string()
  .min(1)
  .max(240)
  .startsWith("/")
  .refine((value) => !/[?&#]/.test(value), "Path templates cannot contain a query string or fragment.");

const lifecycleEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("LIFECYCLE"),
  event: z.enum(["BOOTSTRAP", "MOUNT", "UNMOUNT", "PAGE_SHOW", "PAGE_HIDE", "VISIBILITY"]),
  visibilityState: z.enum(["visible", "hidden", "prerender"]).optional()
}).strict();

const navigationEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("NAVIGATION"),
  event: z.enum(["PUSH", "REPLACE", "POP", "HASH"]),
  pathTemplate: safePathTemplateSchema
}).strict();

const selectionEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("SELECTION"),
  surface: z.enum(["ROOM", "PANE", "SETTINGS", "ROOMS", "HEALTH", "MEDIA", "CLIPBOARD", "LINKS", "ROOM_AGENT"]),
  roomId: diagnosticsIdSchema.nullable().optional(),
  paneId: diagnosticsIdSchema.nullable().optional()
}).strict();

const performanceEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("PERFORMANCE"),
  metric: z.enum([
    "LAYOUT_SHIFT",
    "FRAME_STALL",
    "LONG_TASK",
    "INTERACTION_LATENCY",
    "ROOM_HYDRATION",
    "ROOM_PRESENTATION",
    "TERMINAL_GEOMETRY",
    "TERMINAL_PAINT",
    "TERMINAL_FULLSCREEN",
    "PANE_LAYOUT",
    "RECORDER",
    "TERMINAL_OUTPUT_PRESSURE",
    "WARM_ROOM_CAPACITY",
    "ROOM_REVEAL_PROGRESS"
  ]),
  roomId: diagnosticsIdSchema.optional(),
  paneId: diagnosticsIdSchema.optional(),
  instanceId: diagnosticsIdSchema.optional(),
  phase: z.enum([
    "START",
    "PANES_READY",
    "METADATA_READY",
    "COMPLETE",
    "ERROR",
    "READY",
    "PANE_LIMIT",
    "TOTAL_LIMIT",
    "EVICTED",
    "SAMPLE",
    "ADMIT",
    "EVICT",
    "OVERCOMMIT",
    "REVOKE",
    "PRESSURE",
    "WAITING",
    "PANE_READY",
    "TIMEOUT",
    "PAINT_INITIAL",
    "PAINT_REVEAL",
    "PAINT_REFIT",
    "PAINT_DELAYED",
    "PAINT_FORCE",
    "PAINT_BACKGROUND",
    "LAYOUT_CHANGED",
    "REGISTRY_EMPTY",
    "BACKGROUND_APPLIED",
    "REFERENCE_RECORDED",
    "REVEAL_PRE_ALIGN",
    "COORDINATOR_MISSING",
    "LAYOUT_PRESET",
    "LAYOUT_APPLIED",
    "HOST_RESIZE",
    "INITIAL_FIT",
    "SURFACE_OPENED",
    "CHAR_MEASURE",
    "CHAR_INVALIDATE",
    "RESTORED",
    "PAGE_HIDE",
    "RELEASED",
    "STARTED",
    "STOPPED",
    "RESTORED_SKIP"
  ]).optional(),
  durationMs: z.number().finite().min(0).max(120_000).optional(),
  value: z.number().finite().min(0).max(1_000_000).optional(),
  hadRecentInput: z.boolean().optional(),
  width: z.number().finite().min(0).max(100_000).optional(),
  height: z.number().finite().min(0).max(100_000).optional(),
  cols: z.number().int().min(0).max(100_000).optional(),
  rows: z.number().int().min(0).max(100_000).optional(),
  repaired: z.boolean().optional(),
  cellWidth: z.number().finite().min(0).max(1_000).optional(),
  cellHeight: z.number().finite().min(0).max(1_000).optional(),
  canvasWidth: z.number().int().min(0).max(100_000).optional(),
  canvasHeight: z.number().int().min(0).max(100_000).optional(),
  canvasBlank: z.boolean().optional(),
  darkPixelRatio: z.number().finite().min(0).max(1).optional(),
  rowCount: z.number().int().min(0).max(100_000).optional(),
  populatedRowCount: z.number().int().min(0).max(100_000).optional(),
  blankRowRatio: z.number().finite().min(0).max(1).optional(),
  bufferedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  bufferedEvents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  totalBufferedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  writtenBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  writtenEvents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  safeCapacity: z.number().int().min(0).max(10_000).optional(),
  hardCapacity: z.number().int().min(0).max(10_000).optional(),
  warmRoomCount: z.number().int().min(0).max(10_000).optional(),
  connectedPaneCount: z.number().int().min(0).max(100_000).optional(),
  safePaneCapacity: z.number().int().min(0).max(100_000).optional(),
  hardPaneCapacity: z.number().int().min(0).max(100_000).optional(),
  estimatedRoomBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  usedBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  longTaskCount: z.number().int().min(0).max(100_000).optional(),
  driftCount: z.number().int().min(0).max(100_000).optional(),
  readyCount: z.number().int().min(0).max(100_000).optional(),
  totalCount: z.number().int().min(0).max(100_000).optional(),
  missingPaneIds: z.string().min(0).max(4_000).optional()
}).strict();

const visualEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("VISUAL"),
  event: z.enum(["ANIMATION_START", "ANIMATION_END", "TRANSITION_START", "TRANSITION_END", "DOM_MUTATION"]),
  elementTag: z.string().min(1).max(30).regex(/^[a-z][a-z0-9-]*$/).optional(),
  role: safeTechnicalNameSchema.optional(),
  propertyName: safeTechnicalNameSchema.optional(),
  addedNodes: z.number().int().min(0).max(2_000).optional(),
  removedNodes: z.number().int().min(0).max(2_000).optional(),
  attributeChanges: z.number().int().min(0).max(2_000).optional()
}).strict();

const anomalyEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("ANOMALY"),
  anomaly: z.enum(["VISIBILITY_CHURN", "STYLE_CHURN", "REMOUNT_CHURN", "FLICKER"]),
  occurrenceCount: z.number().int().min(2).max(10_000),
  windowMs: z.number().int().min(1).max(60_000),
  snapshotId: diagnosticsIdSchema.optional()
}).strict();

const networkEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("NETWORK"),
  transport: z.enum(["HTTP", "SSE", "WEBSOCKET"]),
  phase: z.enum(["OPEN", "COMPLETE", "ERROR", "CLOSE", "RETRY"]),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).optional(),
  pathTemplate: safePathTemplateSchema.optional(),
  status: z.number().int().min(100).max(599).optional(),
  durationMs: z.number().finite().min(0).max(300_000).optional(),
  correlationId: diagnosticsIdSchema.optional()
}).strict();

const interactionEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("INTERACTION"),
  event: z.enum(["POINTER", "KEYBOARD", "FOCUS", "BLUR"]),
  elementTag: z.string().min(1).max(30).regex(/^[a-z][a-z0-9-]*$/).optional(),
  role: safeTechnicalNameSchema.optional(),
  pointerType: z.enum(["mouse", "pen", "touch"]).optional()
}).strict();

const errorEventSchema = z.object({
  sequence: sequenceSchema,
  occurredAt: occurredAtSchema,
  category: z.literal("ERROR"),
  name: safeTechnicalNameSchema,
  code: safeTechnicalNameSchema.optional(),
  stackLocations: z.array(z.object({
    file: safePathTemplateSchema,
    line: z.number().int().min(1).max(10_000_000),
    column: z.number().int().min(1).max(1_000_000).optional()
  }).strict()).max(12).default([])
}).strict();

export const appDiagnosticsTechnicalEventSchema = z.discriminatedUnion("category", [
  lifecycleEventSchema,
  navigationEventSchema,
  selectionEventSchema,
  performanceEventSchema,
  visualEventSchema,
  anomalyEventSchema,
  networkEventSchema,
  interactionEventSchema,
  errorEventSchema
]);
export type AppDiagnosticsTechnicalEvent = z.infer<typeof appDiagnosticsTechnicalEventSchema>;

export const appDiagnosticsDomSnapshotNodeSchema = z.object({
  index: z.number().int().min(0).max(appDiagnosticsSnapshotMaxElements - 1),
  parentIndex: z.number().int().min(0).max(appDiagnosticsSnapshotMaxElements - 1).nullable(),
  tag: z.string().min(1).max(30).regex(/^[a-z][a-z0-9-]*$/),
  role: safeTechnicalNameSchema.optional(),
  classes: z.array(z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/)).max(8).default([]),
  style: z.object({
    display: safeTechnicalValueSchema,
    visibility: safeTechnicalValueSchema,
    opacity: safeTechnicalValueSchema,
    position: safeTechnicalValueSchema,
    transform: safeTechnicalValueSchema,
    animationName: safeTechnicalValueSchema,
    transitionProperty: safeTechnicalValueSchema
  }).strict()
}).strict();
export type AppDiagnosticsDomSnapshotNode = z.infer<typeof appDiagnosticsDomSnapshotNodeSchema>;

export const appDiagnosticsDomSnapshotSchema = z.object({
  snapshotId: diagnosticsIdSchema,
  anomalySequence: sequenceSchema,
  capturedAt: occurredAtSchema,
  truncated: z.boolean(),
  nodes: z.array(appDiagnosticsDomSnapshotNodeSchema).max(appDiagnosticsSnapshotMaxElements)
}).strict();
export type AppDiagnosticsDomSnapshot = z.infer<typeof appDiagnosticsDomSnapshotSchema>;

export const appDiagnosticsEventBatchSchema = z.object({
  captureId: diagnosticsIdSchema,
  clientId: diagnosticsIdSchema,
  batchId: diagnosticsIdSchema,
  firstSequence: sequenceSchema,
  lastSequence: sequenceSchema,
  startedAt: occurredAtSchema,
  endedAt: occurredAtSchema,
  droppedBeforeBatch: z.number().int().min(0).max(1_000_000),
  events: z.array(appDiagnosticsTechnicalEventSchema).min(1).max(appDiagnosticsEventBatchMaxEvents),
  snapshots: z.array(appDiagnosticsDomSnapshotSchema).max(4).default([])
}).strict().superRefine((batch, context) => {
  if (batch.lastSequence < batch.firstSequence) {
    context.addIssue({ code: "custom", path: ["lastSequence"], message: "lastSequence must be at least firstSequence." });
  }
  if (Date.parse(batch.endedAt) < Date.parse(batch.startedAt)) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "endedAt must not precede startedAt." });
  }
  for (const [index, event] of batch.events.entries()) {
    if (event.sequence < batch.firstSequence || event.sequence > batch.lastSequence) {
      context.addIssue({ code: "custom", path: ["events", index, "sequence"], message: "Event sequence is outside the batch range." });
    }
  }
  for (const [index, snapshot] of batch.snapshots.entries()) {
    if (snapshot.anomalySequence < batch.firstSequence || snapshot.anomalySequence > batch.lastSequence) {
      context.addIssue({
        code: "custom",
        path: ["snapshots", index, "anomalySequence"],
        message: "Snapshot sequence is outside the batch range."
      });
    }
  }
});
export type AppDiagnosticsEventBatch = z.infer<typeof appDiagnosticsEventBatchSchema>;

export const updateAppDiagnosticsInputSchema = z.object({
  isEnabled: z.boolean()
}).strict();
export type UpdateAppDiagnosticsInput = z.infer<typeof updateAppDiagnosticsInputSchema>;

export const appDiagnosticsVideoLeaseStatusSchema = z.enum(["ACTIVE", "RELEASED", "EXPIRED", "REVOKED"]);
export type AppDiagnosticsVideoLeaseStatus = z.infer<typeof appDiagnosticsVideoLeaseStatusSchema>;

export const appDiagnosticsVideoLeaseSchema = z.object({
  leaseId: diagnosticsIdSchema,
  captureId: diagnosticsIdSchema,
  clientId: diagnosticsIdSchema,
  pageClientId: diagnosticsIdSchema,
  userId: diagnosticsIdSchema,
  status: appDiagnosticsVideoLeaseStatusSchema,
  acquiredAt: occurredAtSchema,
  heartbeatAt: occurredAtSchema,
  expiresAt: occurredAtSchema,
  releasedAt: occurredAtSchema.nullable()
}).strict();
export type AppDiagnosticsVideoLease = z.infer<typeof appDiagnosticsVideoLeaseSchema>;

export const acquireAppDiagnosticsVideoLeaseInputSchema = z.object({
  clientId: diagnosticsIdSchema,
  pageClientId: diagnosticsIdSchema
}).strict();
export type AcquireAppDiagnosticsVideoLeaseInput = z.infer<typeof acquireAppDiagnosticsVideoLeaseInputSchema>;

export const appDiagnosticsVideoSegmentQuerySchema = z.object({
  startedAt: occurredAtSchema,
  endedAt: occurredAtSchema,
  firstEventSequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastEventSequence: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
}).strict().superRefine((input, context) => {
  const durationMs = Date.parse(input.endedAt) - Date.parse(input.startedAt);
  if (durationMs < 0 || durationMs > 35_000) {
    context.addIssue({ code: "custom", path: ["endedAt"], message: "Video segments must span between 0 and 35 seconds." });
  }
  if (input.lastEventSequence < input.firstEventSequence) {
    context.addIssue({ code: "custom", path: ["lastEventSequence"], message: "Event sequence range is invalid." });
  }
});
export type AppDiagnosticsVideoSegmentQuery = z.infer<typeof appDiagnosticsVideoSegmentQuerySchema>;

export const appDiagnosticsSegmentKindSchema = z.enum(["TECHNICAL", "DOM_SNAPSHOT", "VIDEO"]);
export type AppDiagnosticsSegmentKind = z.infer<typeof appDiagnosticsSegmentKindSchema>;

export const appDiagnosticsSegmentMetadataSchema = z.object({
  segmentId: diagnosticsIdSchema,
  captureId: diagnosticsIdSchema,
  clientId: diagnosticsIdSchema,
  leaseId: diagnosticsIdSchema.nullable(),
  kind: appDiagnosticsSegmentKindSchema,
  mimeType: z.enum(["application/x-ndjson+gzip", "application/json+gzip", "video/webm"]),
  byteSize: z.number().int().min(0).max(appDiagnosticsQuotaBytes),
  firstEventSequence: sequenceSchema.nullable(),
  lastEventSequence: sequenceSchema.nullable(),
  startedAt: occurredAtSchema,
  endedAt: occurredAtSchema,
  expiresAt: occurredAtSchema,
  downloadUrl: z.string().startsWith("/api/admin/app-diagnostics/segments/").nullable()
}).strict();
export type AppDiagnosticsSegmentMetadata = z.infer<typeof appDiagnosticsSegmentMetadataSchema>;

export const appDiagnosticsSegmentListQuerySchema = z.object({
  captureId: diagnosticsIdSchema.optional(),
  kind: appDiagnosticsSegmentKindSchema.optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25)
}).strict();
export type AppDiagnosticsSegmentListQuery = z.infer<typeof appDiagnosticsSegmentListQuerySchema>;

const appDiagnosticsRecorderStatusSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("IDLE") }).strict(),
  z.object({
    status: z.literal("ACTIVE"),
    leaseId: diagnosticsIdSchema,
    clientId: diagnosticsIdSchema,
    acquiredAt: occurredAtSchema,
    heartbeatAt: occurredAtSchema,
    expiresAt: occurredAtSchema
  }).strict()
]);

export const appDiagnosticsStatusSchema = z.object({
  isEnabled: z.boolean(),
  captureId: diagnosticsIdSchema.nullable(),
  enabledAt: occurredAtSchema.nullable(),
  enabledByUserId: diagnosticsIdSchema.nullable(),
  retentionHours: z.literal(appDiagnosticsRetentionHours),
  quotaBytes: z.literal(appDiagnosticsQuotaBytes),
  technicalQuotaBytes: z.literal(appDiagnosticsTechnicalQuotaBytes),
  visualQuotaBytes: z.literal(appDiagnosticsVisualQuotaBytes),
  usage: z.object({
    technicalBytes: z.number().int().min(0).max(appDiagnosticsQuotaBytes),
    visualBytes: z.number().int().min(0).max(appDiagnosticsQuotaBytes),
    totalBytes: z.number().int().min(0).max(appDiagnosticsQuotaBytes),
    segmentCount: z.number().int().min(0).max(10_000_000)
  }).strict(),
  counters: z.object({
    droppedEvents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    quotaDrops: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    rejectedUploads: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
  }).strict(),
  recorder: appDiagnosticsRecorderStatusSchema,
  checkedAt: occurredAtSchema
}).strict();
export type AppDiagnosticsStatus = z.infer<typeof appDiagnosticsStatusSchema>;
