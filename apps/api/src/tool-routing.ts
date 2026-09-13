import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  buildEffectiveToolPlan, modelCapabilityProfileSchema, type ModelCapabilityProfileV1,
  type ToolRoutingStateV1, type ToolRoutingOverride
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";
import { rootWriteBackedUpFileAtomic, type AgentToolsOptions } from "./agent-tools.js";

export async function discoverRoutingProfiles(options: AgentToolsOptions = {}): Promise<ModelCapabilityProfileV1[]> {
  const path = join(options.baseRoot ?? "/var/lib/spaceapp-user", ".codex/models_cache.json");
  let cache: { fetched_at?: string; models?: Array<{ slug?: string; input_modalities?: string[]; shell_type?: string }> };
  try { cache = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "EACCES") return [];
    throw error;
  }
  const checkedAt = cache.fetched_at && Number.isFinite(Date.parse(cache.fetched_at))
    ? new Date(cache.fetched_at).toISOString() : new Date().toISOString();
  return (cache.models ?? []).flatMap((model) => {
    if (!model.slug) return [];
    const capabilities: ModelCapabilityProfileV1["capabilities"] = {};
    if (Array.isArray(model.input_modalities)) capabilities.vision = {
      state: model.input_modalities.includes("image") ? "AVAILABLE" : "UNAVAILABLE",
      source: "PROVIDER", evidence: "Codex model catalog input_modalities", checkedAt
    };
    if (model.shell_type === "unified_exec") {
      capabilities.shell = { state: "AVAILABLE", source: "RUNTIME", evidence: "Codex unified_exec", checkedAt };
      capabilities.filesystem = { ...capabilities.shell };
    }
    return [modelCapabilityProfileSchema.parse({ version: 1, runtimeId: "cli:codex", modelId: model.slug, capabilities })];
  });
}

export async function routingStateWithLegacy(store: SpaceStore): Promise<ToolRoutingStateV1> {
  const state = await store.getToolRoutingState();
  const legacy = await store.listAgentToolAssignments();
  const overrides: ToolRoutingOverride[] = legacy.flatMap((entry) => {
    const base = { toolId: entry.toolId === "mcp:mcp_dispatcher" ? "mcp:*" : entry.toolId, modelId: "*" };
    if (entry.scope === "NONE") return [{ ...base, runtimeId: "*", mode: "DISABLED" as const }];
    if (entry.scope === "COMMON") return [{ ...base, runtimeId: "*", mode: "AUTOMATIC" as const }];
    return [
      { ...base, runtimeId: "*", mode: "DISABLED" as const },
      ...entry.runtimeIds.map((runtimeId) => ({ ...base, runtimeId, mode: "AUTOMATIC" as const }))
    ];
  });
  const key = (entry: ToolRoutingOverride) => [entry.toolId, entry.runtimeId, entry.modelId].join("\0");
  const explicit = new Set(state.overrides.map(key));
  return { ...state, overrides: [...state.overrides, ...overrides.filter((entry) => !explicit.has(key(entry)))] };
}

export async function effectiveRouting(store: SpaceStore, runtimeId: string, modelId: string, options?: AgentToolsOptions) {
  const [state, discovered] = await Promise.all([routingStateWithLegacy(store), discoverRoutingProfiles(options)]);
  const profile = discovered.find((entry) => entry.runtimeId === runtimeId && entry.modelId === modelId) ??
    state.profiles.find((entry) => entry.runtimeId === runtimeId && entry.modelId === modelId) ??
    { version: 1 as const, runtimeId, modelId, capabilities: {} };
  if (runtimeId === "cli:codex") profile.capabilities.shell = {
    state: "AVAILABLE", source: "RUNTIME", evidence: "Space Codex CLI unified exec", checkedAt: new Date().toISOString()
  };
  return { ...buildEffectiveToolPlan(state, profile), profile };
}

export async function projectRoutingState(store: SpaceStore, options: AgentToolsOptions = {}): Promise<void> {
  if (!options.rootWriterCommand && !options.canonicalRoot) return;
  const state = await routingStateWithLegacy(store);
  const discovered = await discoverRoutingProfiles(options);
  const profileKeys = new Set(discovered.map((entry) => entry.runtimeId + ":" + entry.modelId));
  state.profiles = [...discovered, ...state.profiles.filter((entry) => !profileKeys.has(entry.runtimeId + ":" + entry.modelId))];
  await rootWriteBackedUpFileAtomic(
    options.rootWriterCommand ?? null,
    join(options.canonicalRoot ?? "/opt/spaceapp/bin", "tool-routing-state.json"),
    JSON.stringify(state, null, 2) + "\n"
  );
}

let updateQueue: Promise<unknown> = Promise.resolve();
export function serializeRoutingUpdate<T>(update: () => Promise<T>): Promise<T> {
  const next = updateQueue.then(update);
  updateQueue = next.catch(() => undefined);
  return next;
}

/** Called under serializeRoutingUpdate, including legacy assignment writers. */
export async function saveProjectedRouting(
  store: SpaceStore, next: ToolRoutingStateV1, expectedRevision: number, actorId: string,
  options?: AgentToolsOptions
): Promise<ToolRoutingStateV1> {
  const previous = await store.getToolRoutingState();
  if (previous.revision !== expectedRevision) throw new SpaceConflictError("Routing policy changed; reload before saving.");
  const saved = await store.updateToolRoutingState(next, expectedRevision, actorId);
  try { await projectRoutingState(store, options); }
  catch (error) {
    await store.updateToolRoutingState(previous, saved.revision, actorId);
    // Restore content AND the new rollback revision when the writer recovers.
    // If the writer stays unavailable, its atomic old file remains authoritative
    // for CLI consumers; startup or the next save retries projection.
    await projectRoutingState(store, options).catch(() => undefined);
    throw error;
  }
  return saved;
}
