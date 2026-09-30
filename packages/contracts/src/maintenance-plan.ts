import { z } from "zod";
import { cliToggleRuntimeIdSchema, idSchema } from "./schemas.js";

export const maintenancePlanRequestSchema = z.object({ scope: z.enum(["enabled", "all"]).default("enabled") }).strict();
export const maintenanceApplyRequestSchema = z.object({
  selectedActionIds: z.array(cliToggleRuntimeIdSchema).min(1).max(11).refine(ids => new Set(ids).size === ids.length),
  idempotencyKey: z.string().uuid(),
  confirmation: z.literal("APPLY MAINTENANCE")
}).strict();
export const maintenanceActionSchema = z.object({
  id: cliToggleRuntimeIdSchema,
  label: z.string(),
  kind: z.enum(["UPDATE", "REPAIR"]),
  reasons: z.array(z.string()),
  installedVersion: z.string().nullable(),
  targetVersion: z.string().nullable(),
  fingerprint: z.string()
}).strict();
export const maintenancePlanSchema = z.object({
  planId: idSchema,
  scope: z.enum(["enabled", "all"]),
  actions: z.array(maintenanceActionSchema),
  checkedAt: z.string().datetime()
}).strict();
export type MaintenancePlanRequest = z.infer<typeof maintenancePlanRequestSchema>;
export type MaintenanceApplyRequest = z.infer<typeof maintenanceApplyRequestSchema>;
export type MaintenancePlan = z.infer<typeof maintenancePlanSchema>;
export type MaintenanceAction = z.infer<typeof maintenanceActionSchema>;

interface RuntimeCheck {
  runtimeId: string; displayName: string; installedVersion: string | null; availableVersion: string | null;
  checks: Array<{ code: string; status: string; message?: string; summary?: string }>;
}
export function maintenanceFingerprint(runtime: RuntimeCheck): string {
  return JSON.stringify([runtime.runtimeId, runtime.installedVersion, runtime.availableVersion,
    runtime.checks.map(c => `${c.code}:${c.status}`).sort()]);
}
/** Only actionable findings qualify. Login, quota and unavailable registries never imply a repair. */
export function recommendMaintenance(runtime: RuntimeCheck): MaintenanceAction | null {
  const codes = runtime.checks.map(c => c.code);
  if (codes.includes("PATCH_REBASE_REQUIRED") || codes.includes("VERSION_CHECK_UNAVAILABLE")) return null;
  const repairCodes = new Set(["CONFIG_INVALID", "MCP_INVALID", "RUNTIME_UNAVAILABLE", "VERSION_INVALID"]);
  const reasons = runtime.checks.filter(c => repairCodes.has(c.code) || c.code === "UPDATE_AVAILABLE");
  if (!reasons.length || !runtime.availableVersion) return null;
  return maintenanceActionSchema.parse({
    id: runtime.runtimeId, label: runtime.displayName,
    kind: reasons.some(c => repairCodes.has(c.code)) ? "REPAIR" : "UPDATE",
    reasons: reasons.map(c => c.message ?? c.summary ?? c.code),
    installedVersion: runtime.installedVersion, targetVersion: runtime.availableVersion,
    fingerprint: maintenanceFingerprint(runtime)
  });
}
