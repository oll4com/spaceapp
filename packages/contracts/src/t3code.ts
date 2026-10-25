import { z } from "zod";

// T3 Code runs as the managed upstream application (space-t3code.service) and
// is embedded through the authenticated pane namespace. The former in-memory
// supervision contracts were retired with their simulator.

// Genuine upstream selection. A draft is a local composer identity; it must
// never masquerade as a server thread or a provider result.
// T3 0.1.0's own threads carry colons (thread:project:<id>:<id>, <command>:fork); user threads are UUIDs.
const upstreamId = z.string().regex(/^[A-Za-z0-9_:-]{1,200}$/);
export const t3CodeSelectionSchema = z.object({
  environmentId: upstreamId,
  projectId: upstreamId,
  threadId: upstreamId.nullable(),
  draftId: upstreamId.nullable()
}).strict().refine(value => (value.threadId === null) !== (value.draftId === null),
  "Select a server thread or a local draft.");
export type T3CodeSelection = z.infer<typeof t3CodeSelectionSchema>;

export const t3CodePaneMetadataSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  generation: z.string().uuid(),
  lastSequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  selection: t3CodeSelectionSchema
}).strict();
export type T3CodePaneMetadata = z.infer<typeof t3CodePaneMetadataSchema>;

export const t3CodeCapabilitiesSchema = z.object({
  paneBindings: z.boolean(), selectionMessages: z.boolean(), draftIsolation: z.boolean(),
  orchestration: z.boolean(), serviceControl: z.literal(false)
}).strict();
export const t3CodeRuntimeVersionSchema = z.object({
  tag: z.string().max(64), commit: z.string().regex(/^[a-f0-9]{40}$/), packageVersion: z.string().max(64),
  integrationRevision: z.number().int().positive(), runtimeId: z.string().max(128)
}).strict();
export const t3CodeServiceStatusSchema = z.object({
  version: z.literal(1), enabled: z.boolean(), state: z.enum(["ready", "unavailable", "disabled"]),
  runtime: t3CodeRuntimeVersionSchema.nullable(), environmentId: upstreamId.nullable(),
  // False when an unbound pane's folder (pane cwd or room project) lies outside
  // the T3 workspace, so the pane can explain it instead of booting the app.
  workspaceAllowed: z.boolean(),
  capabilities: t3CodeCapabilitiesSchema, checkedAt: z.string().datetime()
}).strict();
export type T3CodeServiceStatus = z.infer<typeof t3CodeServiceStatusSchema>;

export const t3CodeBindingBootstrapSchema = z.object({
  version: z.literal(1), paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/),
  basePath: z.string().regex(/^\/api\/t3code\/panes\/pane:[A-Za-z0-9_-]{6,80}\/app\/$/),
  metadata: t3CodePaneMetadataSchema, service: t3CodeServiceStatusSchema
}).strict();
export type T3CodeBindingBootstrap = z.infer<typeof t3CodeBindingBootstrapSchema>;

const messageBase = {
  version: z.literal(1), paneId: z.string().regex(/^pane:[A-Za-z0-9_-]{6,80}$/),
  generation: z.string().uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), requestId: z.string().uuid()
};
export const t3CodeSelectionMessageSchema = z.discriminatedUnion("type", [
  z.object({ ...messageBase, type: z.literal("ready"), payload: t3CodeSelectionSchema }).strict(),
  z.object({ ...messageBase, type: z.literal("selection.request"), payload: t3CodeSelectionSchema }).strict(),
  z.object({ ...messageBase, type: z.literal("selection.applied"), payload: t3CodeSelectionSchema }).strict(),
  z.object({ ...messageBase, type: z.literal("selection.changed"), payload: t3CodeSelectionSchema }).strict(),
  z.object({ ...messageBase, type: z.literal("error"), payload: z.object({ code: z.string().regex(/^T3_[A-Z_]{1,80}$/) }).strict() }).strict()
]);
export type T3CodeSelectionMessage = z.infer<typeof t3CodeSelectionMessageSchema>;
export const t3CodeBindingUpdateSchema = z.object({
  version: z.literal(1), generation: z.string().uuid(), sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestId: z.string().uuid(), selection: t3CodeSelectionSchema
}).strict();
export type T3CodeBindingUpdate = z.infer<typeof t3CodeBindingUpdateSchema>;

// ADMIN service management. Counts only; no thread content leaves T3.
export const t3CodeAdminStatusSchema = z.object({
  version: z.literal(1),
  featureEnabled: z.boolean(),
  serviceEnabled: z.boolean(),
  serviceActive: z.boolean(),
  socketActive: z.boolean(),
  pid: z.number().int().positive().nullable(),
  ready: z.boolean(),
  serverVersion: z.string().max(64).nullable(),
  runtime: t3CodeRuntimeVersionSchema.nullable(),
  activeRuns: z.number().int().nonnegative().nullable(),
  checkedAt: z.string().datetime()
}).strict();
export type T3CodeAdminStatus = z.infer<typeof t3CodeAdminStatusSchema>;
export const updateT3CodeEnabledInputSchema = z.object({
  enabled: z.boolean(),
  confirmActiveRuns: z.boolean().optional()
}).strict();
export type UpdateT3CodeEnabledInput = z.infer<typeof updateT3CodeEnabledInputSchema>;
export const restartT3CodeInputSchema = z.object({
  confirmActiveRuns: z.boolean().optional()
}).strict();
export type RestartT3CodeInput = z.infer<typeof restartT3CodeInputSchema>;
export const t3CodeAdminResultSchema = z.object({ status: t3CodeAdminStatusSchema }).strict();
export type T3CodeAdminResult = z.infer<typeof t3CodeAdminResultSchema>;
