import { z } from "zod";
import { idSchema, isoDateTimeSchema } from "./schemas.js";
import { SETUP_CATALOG_VERSION, type SetupFeatureId } from "./setup-catalog.js";

export const setupProtocolVersion = 2 as const;
export const setupFeatureIdSchema = z.string()
  .regex(/^(agent|dock|pane|widget|utility):[a-z0-9][a-z0-9-]{0,79}$/)
  .transform((value) => value as SetupFeatureId);
const uniqueIds = z.array(setupFeatureIdSchema).max(100)
  .refine((ids) => new Set(ids).size === ids.length, "Feature ids must be unique.");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nameSchema = z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/);
const referenceSchema = z.string().regex(/^[a-z][a-z0-9._:-]{3,127}$/);
const reasonCodeSchema = z.string().regex(/^[A-Z0-9_]{1,80}$/);

export const setupConnectionChoiceSchema = z.object({
  featureId: setupFeatureIdSchema,
  providerId: nameSchema.optional(),
  modelId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/).optional(),
  voiceId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/).optional(),
  credentialRef: z.string().regex(/^cred:[a-zA-Z0-9._:-]{3,120}$/).optional()
}).strict();

export const setupDraftSchema = z.object({
  id: idSchema,
  ownerId: idSchema,
  protocolVersion: z.literal(setupProtocolVersion),
  revision: z.number().int().nonnegative(),
  persona: z.enum(["everyday", "creator", "developer"]),
  level: z.enum(["minimal", "balanced", "full"]),
  requestedFeatureIds: uniqueIds,
  connectionChoices: z.array(setupConnectionChoiceSchema).max(40),
  catalogVersion: z.literal(SETUP_CATALOG_VERSION),
  updatedAt: isoDateTimeSchema
}).strict();
export type SetupDraft = z.infer<typeof setupDraftSchema>;

export const setupActionIdSchema = z.enum([
  "PREPARE_OPENCODE", "VERIFY_AGENT_TASK", "CONNECT_PROVIDER", "CHECK_SERVICE",
  "APPLY_SETTINGS", "ENSURE_STARTER_ROOM", "WRITE_INSTALLATION_MEMORY",
  "VERIFY_LIVE_AUDIO", "VERIFY_DATABASE", "VERIFY_REMOTE_DESKTOP",
  "VERIFY_HARNESS", "VERIFY_STREAMING", "VERIFY_CAPTURE"
]);
export type SetupActionId = z.infer<typeof setupActionIdSchema>;

export const setupPlanActionSchema = z.object({
  id: idSchema,
  featureId: setupFeatureIdSchema,
  actionId: setupActionIdSchema,
  dependsOn: z.array(idSchema).max(200)
}).strict();
export const setupHumanInputSchema = z.object({
  featureId: setupFeatureIdSchema,
  kind: z.enum(["PROVIDER_LOGIN", "API_CREDENTIAL", "MICROPHONE", "OS_PERMISSION", "RESOURCE_DECISION"]),
  reasonCode: reasonCodeSchema
}).strict();
export const setupResourceConstraintSchema = z.object({
  featureId: setupFeatureIdSchema,
  kind: z.enum(["RAM", "DISK", "CPU", "OS"]),
  minimum: z.number().nonnegative().optional(),
  unit: z.enum(["MiB", "GiB", "cores", "version"]).optional()
}).strict();
export const setupPlanSchema = z.object({
  id: idSchema,
  draftId: idSchema,
  ownerId: idSchema,
  draftRevision: z.number().int().nonnegative(),
  catalogVersion: z.literal(SETUP_CATALOG_VERSION),
  planDigest: hashSchema,
  requestedFeatureIds: uniqueIds,
  effectiveFeatureIds: uniqueIds,
  actions: z.array(setupPlanActionSchema).max(200),
  requiredHumanInputs: z.array(setupHumanInputSchema).max(40),
  costDisclosures: z.array(z.object({
    featureId: setupFeatureIdSchema,
    costClass: z.enum(["FREE", "PROVIDER_BILLED", "LOCAL_RESOURCES", "UNKNOWN"])
  }).strict()).max(100),
  resourceConstraints: z.array(setupResourceConstraintSchema).max(100),
  createdAt: isoDateTimeSchema
}).strict();
export type SetupPlan = z.infer<typeof setupPlanSchema>;

export const setupRunStatusSchema = z.enum([
  "RUNNING", "WAITING_FOR_INPUT", "PAUSED", "FAILED", "READY", "CANCELLED", "SUPERSEDED"
]);
export const setupRunSchema = z.object({
  id: idSchema,
  planId: idSchema,
  ownerId: idSchema,
  status: setupRunStatusSchema,
  revision: z.number().int().positive(),
  eventSequence: z.number().int().nonnegative(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable()
}).strict();
export type SetupRun = z.infer<typeof setupRunSchema>;

export const setupTaskStatusSchema = z.enum([
  "QUEUED", "INSTALLING", "WAITING_FOR_INPUT", "CHECKING", "READY", "NEEDS_ATTENTION", "PAUSED", "CANCELLED"
]);
export const setupTaskSchema = z.object({
  id: idSchema,
  runId: idSchema,
  actionId: setupActionIdSchema,
  featureId: setupFeatureIdSchema,
  dependsOn: z.array(idSchema).max(200),
  status: setupTaskStatusSchema,
  attempt: z.number().int().nonnegative(),
  idempotencyKey: referenceSchema,
  leaseOwner: idSchema.nullable(),
  leaseExpiresAt: isoDateTimeSchema.nullable(),
  errorCode: reasonCodeSchema.nullable(),
  resultRef: referenceSchema.nullable()
}).strict();
export type SetupTask = z.infer<typeof setupTaskSchema>;

export const setupReadinessReceiptSchema = z.object({
  id: idSchema,
  runId: idSchema,
  taskId: idSchema,
  featureId: setupFeatureIdSchema,
  checkVersion: referenceSchema,
  subjectFingerprint: hashSchema,
  completedAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  outcome: z.literal("PASSED"),
  evidenceRef: referenceSchema
}).strict().refine((receipt) => Date.parse(receipt.expiresAt) > Date.parse(receipt.completedAt),
  "Readiness receipt must expire after its completed check.");
export type SetupReadinessReceipt = z.infer<typeof setupReadinessReceiptSchema>;

export const setupCompletionSchema = z.object({
  runId: idSchema,
  draftRevision: z.number().int().nonnegative(),
  planDigest: hashSchema,
  settingsRevision: z.number().int().nonnegative(),
  receiptSetHash: hashSchema,
  starterRoomId: idSchema,
  memoryHandoffRevision: z.number().int().nonnegative(),
  completedAt: isoDateTimeSchema
}).strict();
export type SetupCompletion = z.infer<typeof setupCompletionSchema>;

export const setupExecutionEventSchema = z.object({
  runId: idSchema,
  sequence: z.number().int().positive(),
  taskId: idSchema.nullable(),
  state: setupTaskStatusSchema,
  reasonCode: reasonCodeSchema.nullable(),
  createdAt: isoDateTimeSchema
}).strict();
export type SetupExecutionEvent = z.infer<typeof setupExecutionEventSchema>;

export const setupExecutionStateSchema = z.object({
  ownerId: idSchema,
  revision: z.number().int().nonnegative(),
  draft: setupDraftSchema.nullable(),
  plans: z.array(setupPlanSchema).max(50),
  runs: z.array(setupRunSchema).max(50),
  tasks: z.array(setupTaskSchema).max(500),
  receipts: z.array(setupReadinessReceiptSchema).max(500),
  events: z.array(setupExecutionEventSchema).max(500),
  runIdempotency: z.array(z.object({ key: referenceSchema, runId: idSchema }).strict()).max(50),
  appliedSettingsRevision: z.number().int().nonnegative().nullable().optional(),
  memoryHandoffRevision: z.number().int().nonnegative().nullable().optional(),
  completion: setupCompletionSchema.nullable().optional()
}).strict().superRefine((state, context) => {
  if (state.draft && state.draft.ownerId !== state.ownerId) {
    context.addIssue({ code: "custom", path: ["draft"], message: "Draft owner differs from setup owner." });
  }
  for (const [name, records] of [["plans", state.plans], ["runs", state.runs]] as const) {
    if (records.some((record) => record.ownerId !== state.ownerId)) {
      context.addIssue({ code: "custom", path: [name], message: "Setup record owner differs from setup owner." });
    }
    if (new Set(records.map((record) => record.id)).size !== records.length) {
      context.addIssue({ code: "custom", path: [name], message: "Setup record IDs must be unique." });
    }
  }
  const runIds = new Set(state.runs.map((run) => run.id));
  for (const [index, task] of state.tasks.entries()) {
    if (!runIds.has(task.runId)) {
      context.addIssue({ code: "custom", path: ["tasks", index, "runId"], message: "Task run does not exist." });
    }
  }
  if (new Set(state.tasks.map((task) => task.id)).size !== state.tasks.length) {
    context.addIssue({ code: "custom", path: ["tasks"], message: "Task IDs must be unique." });
  }
  if (new Set(state.runIdempotency.map((record) => record.key)).size !== state.runIdempotency.length) {
    context.addIssue({ code: "custom", path: ["runIdempotency"], message: "Run idempotency keys must be unique." });
  }
  for (const [index, record] of state.runIdempotency.entries()) {
    if (!runIds.has(record.runId)) {
      context.addIssue({ code: "custom", path: ["runIdempotency", index, "runId"], message: "Run idempotency target does not exist." });
    }
  }
});
export type SetupExecutionState = z.infer<typeof setupExecutionStateSchema>;
