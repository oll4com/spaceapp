import { z } from "zod";

const identifier = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:*\/-]+$/);
export const capabilityNameSchema = z.enum(["vision", "shell", "filesystem", "browser", "web", "summary", "capture"]);
export const capabilityEvidenceSchema = z.object({
  state: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]),
  source: z.enum(["PROVIDER", "RUNTIME", "PROBE"]),
  evidence: z.string().max(240),
  checkedAt: z.string().datetime()
}).strict();
export const modelCapabilityProfileSchema = z.object({
  version: z.literal(1), runtimeId: identifier, modelId: identifier,
  capabilities: z.partialRecord(capabilityNameSchema, capabilityEvidenceSchema)
}).strict();
export const toolRoutingModeSchema = z.enum(["AUTOMATIC", "NATIVE_ONLY", "ALLOW_FALLBACK", "DISABLED"]);
export const toolRoutingOverrideSchema = z.object({
  toolId: identifier, runtimeId: identifier.default("*"), modelId: identifier.default("*"),
  mode: toolRoutingModeSchema
}).strict();
export const toolRoutingStateSchema = z.object({
  version: z.literal(1), revision: z.number().int().nonnegative(),
  enabledRuntimeIds: z.array(identifier).max(30),
  overrides: z.array(toolRoutingOverrideSchema).max(500),
  profiles: z.array(modelCapabilityProfileSchema).max(500),
  visionExceptions: z.array(z.object({
    runtimeId: identifier, modelId: identifier, sessionId: identifier, turnId: identifier,
    actorId: z.string().min(1).max(160), expiresAt: z.string().datetime()
  }).strict()).max(50).default([])
}).strict();
export const updateToolRoutingSchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  enabledRuntimeIds: z.array(z.literal("cli:codex")).max(1),
  overrides: z.array(toolRoutingOverrideSchema).max(500)
}).strict().superRefine((input, ctx) => {
  const keys = input.overrides.map((entry) => `${entry.toolId}\0${entry.runtimeId}\0${entry.modelId}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate routing override." });
});
export type ModelCapabilityProfileV1 = z.infer<typeof modelCapabilityProfileSchema>;
export type ToolRoutingStateV1 = z.infer<typeof toolRoutingStateSchema>;
export type ToolRoutingOverride = z.infer<typeof toolRoutingOverrideSchema>;
export type CapabilityName = z.infer<typeof capabilityNameSchema>;
export interface ToolRoutingPolicyV1 {
  toolId: string;
  category: "NATIVE_PREFERRED" | "FALLBACK_ONLY" | "SPACE_EXCLUSIVE" | "OPERATOR_OPT_IN";
  capability?: CapabilityName;
}
export const spaceToolPolicies: readonly ToolRoutingPolicyV1[] = [
  { toolId: "mcp:vision", category: "FALLBACK_ONLY", capability: "vision" },
  { toolId: "mcp:devtools", category: "NATIVE_PREFERRED", capability: "browser" },
  { toolId: "mcp:playwright", category: "NATIVE_PREFERRED", capability: "browser" },
  { toolId: "mcp:scrapling", category: "NATIVE_PREFERRED", capability: "web" },
  { toolId: "mcp:summary_tools", category: "OPERATOR_OPT_IN", capability: "summary" },
  { toolId: "mcp:capturelab", category: "NATIVE_PREFERRED", capability: "capture" },
  ...["space-control", "space_ops", "space_browser", "space_services", "olla", "mission_control"].map((id) => ({
    toolId: `mcp:${id}`, category: "SPACE_EXCLUSIVE" as const
  }))
];
export const defaultToolRoutingState = (): ToolRoutingStateV1 => ({
  version: 1, revision: 0, enabledRuntimeIds: ["cli:codex"], overrides: [], profiles: [], visionExceptions: []
});
export interface EffectiveToolRoute {
  toolId: string;
  route: "NATIVE" | "ON_DEMAND" | "UNAVAILABLE" | "DISABLED";
  reason: string;
  mode: ToolRoutingOverride["mode"];
}
export interface EffectiveToolPlanV1 {
  version: 1; runtimeId: string; modelId: string; revision: number;
  managed: boolean; registration: "NONE" | "LAZY_DISPATCHER" | "LEGACY_CONFIG";
  routes: EffectiveToolRoute[];
}

/** Availability never implies invocation. Authorization is enforced by the selected backend. */
export function resolveToolRoute(
  policy: ToolRoutingPolicyV1, profile: ModelCapabilityProfileV1,
  overrides: ToolRoutingOverride[], options: { taskNeedsTool?: boolean; explicitRequest?: boolean } = {}
): EffectiveToolRoute {
  const matches = overrides.filter((entry) => (entry.toolId === policy.toolId || entry.toolId === "*" ||
    (entry.toolId === "mcp:*" && policy.toolId.startsWith("mcp:"))) &&
    (entry.runtimeId === "*" || entry.runtimeId === profile.runtimeId) &&
    (entry.modelId === "*" || entry.modelId === profile.modelId));
  const score = (entry: ToolRoutingOverride) => (entry.modelId !== "*" ? 8 : 0) +
    (entry.runtimeId !== "*" ? 4 : 0) + (entry.toolId === "*" ? 0 : entry.toolId === "mcp:*" ? 1 : 2);
  const mode = matches.sort((a, b) => score(b) - score(a))[0]?.mode ?? "AUTOMATIC";
  const result = (route: EffectiveToolRoute["route"], reason: string): EffectiveToolRoute => ({ toolId: policy.toolId, mode, route, reason });
  if (mode === "DISABLED") return result("DISABLED", "Disabled by operator policy.");
  const native = policy.capability ? profile.capabilities[policy.capability]?.state ?? "UNKNOWN" : "UNKNOWN";
  if (native === "AVAILABLE" && policy.capability === "vision" && options.explicitRequest && mode !== "NATIVE_ONLY")
    return result("ON_DEMAND", "Explicit operator exception for this image-analysis turn.");
  if (native === "AVAILABLE") return result("NATIVE", "Verified native capability; no MCP invocation or duplicate verification.");
  if (mode === "NATIVE_ONLY") return result("UNAVAILABLE", "Native-only policy; no verified native capability.");
  if (policy.capability === "vision" && native !== "UNAVAILABLE") return result("UNAVAILABLE", "Image support is unknown. Verify the active model and input pipeline first.");
  if (!options.taskNeedsTool) return result("ON_DEMAND", "Available only when the task needs this capability; no startup work.");
  if (policy.category === "OPERATOR_OPT_IN" && !options.explicitRequest && mode !== "ALLOW_FALLBACK") return result("UNAVAILABLE", "This workflow requires an explicit operator request.");
  if (policy.category === "SPACE_EXCLUSIVE") return result("ON_DEMAND", "Space-specific access; existing authentication and approval gates apply.");
  if (native === "UNKNOWN" && mode !== "ALLOW_FALLBACK") return result("UNAVAILABLE", "Check active runtime tools first; fallback requires a verified gap or operator policy.");
  return result("ON_DEMAND", "Native capability unavailable; start only the requested backend.");
}

export function buildEffectiveToolPlan(state: ToolRoutingStateV1, profile: ModelCapabilityProfileV1): EffectiveToolPlanV1 {
  return {
    version: 1, runtimeId: profile.runtimeId, modelId: profile.modelId, revision: state.revision,
    managed: state.enabledRuntimeIds.includes(profile.runtimeId),
    registration: !state.enabledRuntimeIds.includes(profile.runtimeId) ? "LEGACY_CONFIG" :
      profile.runtimeId === "cli:codex" ? "NONE" : "LAZY_DISPATCHER",
    routes: spaceToolPolicies.map((policy) => resolveToolRoute(policy, profile, state.overrides))
  };
}
