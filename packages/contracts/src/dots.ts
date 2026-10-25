import { z } from "zod";

export const dotIdSchema = z.string().regex(/^dot:[a-f0-9]{32}$/);
export const dotAppearanceSchema = z.object({
  character: z.enum(["astronaut", "star", "robot", "comet", "moon", "planet"]),
  accent: z.enum(["slate", "amber", "cyan", "coral", "silver", "violet"])
}).strict();
/** Chat permission modes a Dot can run with; the Chat transport has no interactive "Ask for approval". */
export const dotPermissionModeSchema = z.enum(["approve_for_me", "full_access"]);
/** Model and permissions set in SpaceApp Settings → Dots; null keeps the user's Dots default. */
export const dotRuntimeSchema = z.object({
  modelConfigId: z.string().trim().min(1).max(260).nullable().optional(),
  permissionMode: dotPermissionModeSchema.nullable().optional()
}).strict();
export const dotPreferencesSchema = z.object({
  communicationStyle: z.string().trim().max(2000).optional(),
  // An empty value clears the preference (profile patches merge preferences).
  language: z.string().trim().max(80).refine(value => value.length === 0 || value.length >= 2, "Use at least two characters.").optional(),
  runtime: dotRuntimeSchema.optional()
}).strict();
// A profile is never an authorization grant. Existing user/tool gates remain authoritative.
export const dotPermissionsSchema = z.object({ mode: z.literal("INHERIT_USER") }).strict();
export const dotWorkLimitsSchema = z.object({
  maxConcurrentTasks: z.number().int().min(1).max(6),
  dailyBudgetUsd: z.number().positive().max(10000).nullable()
}).strict();
export const dotProfileSchema = z.object({
  dotId: dotIdSchema, ownerUserId: z.string().min(1).max(200), slot: z.number().int().min(1).max(6),
  name: z.string().trim().min(1).max(80), appearance: dotAppearanceSchema,
  preferences: dotPreferencesSchema, permissions: dotPermissionsSchema, workLimits: dotWorkLimitsSchema,
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime()
}).strict();
export const updateDotProfileSchema = dotProfileSchema.pick({ name: true, appearance: true, preferences: true, workLimits: true })
  .partial().strict().refine(input => Object.keys(input).length > 0, "Provide a profile change.");
export const dotResourceSchema = z.enum(["sessions", "tasks", "goals", "memory", "schedules", "receipts", "activity"]);
export type DotProfile = z.infer<typeof dotProfileSchema>;
export type DotPermissionMode = z.infer<typeof dotPermissionModeSchema>;
export type DotRuntime = z.infer<typeof dotRuntimeSchema>;
export type UpdateDotProfile = z.infer<typeof updateDotProfileSchema>;
export type DotResource = z.infer<typeof dotResourceSchema>;

// Read-only Stage2 collections. Raw receipt results, schedules, personal-memory
// objects and internal metadata must never cross this boundary.
export interface DotCollectionItem {
  dotId: string;
  id?: string;
  kind?: string;
  sessionId?: string;
  paneId?: string;
  roomId?: string;
  threadId?: string | null;
  runId?: string;
  missionId?: string;
  title?: string;
  objective?: string;
  status?: string;
  statusReason?: string;
  isActive?: boolean;
  scope?: string;
  body?: string;
  source?: string;
  revision?: number;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string | null;
}
export interface DotCollection {
  dotId: string;
  items: DotCollectionItem[];
  limit: number;
  offset: number;
}
