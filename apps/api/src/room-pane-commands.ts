import { createHash } from "node:crypto";
import {
  PANE_TYPES, PANE_CATALOG_VERSION, roomPaneCommandSchema, isAgentRuntimeReady,
  type AgentRuntimeRegistry, type CreatePaneInput, type PaneBatchClaim,
  type PaneType, type RoomPaneBatchItem, type RoomPaneCommand
} from "@space/contracts";
import { SpaceConflictError, type SpaceStore } from "@space/runtime";

export interface RoomPaneCatalogEntry {
  definition: PaneType;
  available: boolean;
  reason: string | null;
  // Zero until the adapter supplies measured, account/configuration-bound reservations.
  preparedCount: number;
}
export function createRoomPaneCommands(options: {
  store: SpaceStore;
  discover(): Promise<AgentRuntimeRegistry>;
  enabledRuntimeIds(): Promise<string[]>;
  harnessAvailable(): Promise<boolean>;
}) {
  async function catalog(): Promise<RoomPaneCatalogEntry[]> {
    const [registry, enabledIds, harness] = await Promise.all([
      options.discover(), options.enabledRuntimeIds(), options.harnessAvailable()
    ]);
    const runtimes = new Map(registry.data.map(runtime => [runtime.id, runtime]));
    const enabled = new Set(enabledIds);
    return PANE_TYPES.map(definition => {
      let reason: string | null = null;
      if (definition.runtimeId) {
        const runtime = runtimes.get(definition.runtimeId);
        if (!enabled.has(definition.runtimeId)) reason = "Runtime is disabled.";
        else if (!runtime?.capabilities.includes("CLI") || !isAgentRuntimeReady(runtime))
          reason = runtime?.statusReason || "Runtime is not available.";
      } else if (definition.mode === "CHAT" && !enabled.has("cli:codex")) reason = "Chat runtime is disabled.";
      else if (definition.mode === "HARNESS" && !harness) reason = "DeepSeek Harness is unavailable.";
      return { definition, available: reason === null, reason, preparedCount: 0 };
    });
  }

  async function resolve(roomId: string, items: RoomPaneBatchItem[]): Promise<CreatePaneInput[]> {
    const entries = await catalog();
    return items.map(item => {
      const entry = entries.find(({ definition }) => definition.mode === item.mode &&
        (item.mode !== "TERMINAL" || definition.runtimeId === item.terminalRuntimeId));
      if (!entry) throw new SpaceConflictError("Pane type is not in the room command catalog.");
      if (!entry.available) throw new SpaceConflictError(`${entry.definition.label}: ${entry.reason}`);
      // Leave account, model and reasoning unset so the normal launcher resolves current defaults.
      return { roomId, title: item.mode === "TERMINAL"
        ? `${entry.definition.label} CLI` : item.mode === "HARNESS" ? "Harness" : entry.definition.label,
        mode: item.mode,
        ...(item.mode === "TERMINAL" ? { terminalRuntimeId: item.terminalRuntimeId, cwd: "/etc" } : {}),
        ...(item.mode === "VNC" && item.vncTarget ? { vncTarget: item.vncTarget } : {}) };
    });
  }

  async function execute(roomId: string, actorId: string, raw: RoomPaneCommand, traceId: string) {
    const command = roomPaneCommandSchema.parse(raw);
    if (!actorId) throw new SpaceConflictError("Authenticated command actor is required.");
    // Canonicalize counts; property order, trace IDs and mutable defaults are not the intent.
    const canonical = JSON.stringify({ catalogVersion: command.catalogVersion, type: command.action.type,
      counts: Object.entries(command.action.counts).sort(([left], [right]) => left.localeCompare(right)) });
    const claim: PaneBatchClaim = { actorId, requestId: command.requestId,
      payloadHash: createHash("sha256").update(canonical).digest("hex") };
    const previous = await options.store.getPaneBatchResult(roomId, claim);
    if (previous) return { roomId, requestId: command.requestId, data: previous };
    const items = PANE_TYPES.flatMap(definition => Array.from({ length: command.action.counts[definition.typeId] ?? 0 },
      (): RoomPaneBatchItem => definition.mode === "TERMINAL"
        ? { mode: "TERMINAL", terminalRuntimeId: definition.runtimeId }
        : { mode: definition.mode }));
    const inputs = await resolve(roomId, items);
    const panes = await options.store.createPanes(inputs, traceId, claim);
    return { roomId, requestId: command.requestId, data: panes };
  }
  return { catalog, resolve, execute, version: PANE_CATALOG_VERSION };
}
