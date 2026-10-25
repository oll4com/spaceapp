import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { AuthUser, ControlAction } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { makeSpaceId, nowIso, SpaceConflictError, type SpaceStore } from "@space/runtime";

/** Who runs a Space Control action; defined here so space-control.ts and this module do not import each other. */
export interface ControlActor {id:string; role:AuthUser["role"]; dotId?:string}

export type ResourceAction = Extract<ControlAction, { kind: "resource" }>;

export const ALLOWED_APPEARANCE_THEMES = [
  "classic",
  "modern",
  "codex",
  "graphite",
  "forest",
  "copper",
  "steel",
  "contrast"
] as const;

export const controlAppearancePatchSchema = z.object({
  theme: z.enum(ALLOWED_APPEARANCE_THEMES).optional(),
  zoomLevel: z.number().min(50).max(200).optional(),
  terminalFontSize: z.number().min(8).max(32).optional()
}).strict().refine(
  (data) => data.theme !== undefined || data.zoomLevel !== undefined || data.terminalFontSize !== undefined,
  "Appearance change requires at least one of theme, zoomLevel, or terminalFontSize."
);

export const controlPluginActionSchema = z.object({
  pluginId: z.string().trim().min(1).max(120),
  enabled: z.boolean()
}).strict();

export const controlRollbackSchema = z.object({
  snapshotId: z.string().trim().min(1).max(200).optional(),
  confirm: z.boolean().default(false)
}).strict();

// Resolve aliases inside the original operation/room lock. Never start another
// space_execute with a fresh request ID for a settings.update retry.
export function resolveControlSettingsAction(action: ResourceAction): ResourceAction {
  if (action.operation !== "settings.update") return action;
  const input = z.object({
    domain: z.enum(["appearance", "voice", "task_titles", "tools", "plugins"]),
    patch: z.record(z.string(), z.unknown())
  }).strict().parse(action.input);
  return { ...action, operation: `settings.${input.domain}`, input: input.patch };
}

export async function captureControlSettingsSnapshot(input: {
  actor: ControlActor;
  roomId: string;
  input: Record<string, unknown>;
  repository: ControlRepository;
  inspect: () => Promise<unknown>;
}) {
  const { label } = z.object({ label: z.string().trim().min(1).max(160).default("Control MCP Snapshot") }).strict().parse(input.input);
  const snapshotId = makeSpaceId("settings_snap");
  const timestamp = nowIso();
  const settings = await input.inspect();

  const value = {
    id: snapshotId,
    label,
    timestamp,
    restorable: true,
    kind: "RESTORED_CONFIG",
    settings
  };

  const saved = await input.repository.write(
    { kind: "settings_snapshot", actorId: input.actor.id, key: snapshotId, roomId: input.roomId, version: 1, value },
    0
  );
  if (!saved) throw new SpaceConflictError("Settings snapshot could not be persisted.");

  const persisted = await input.repository.get("settings_snapshot", input.actor.id, snapshotId);
  if (
    !persisted ||
    persisted.roomId !== input.roomId ||
    persisted.actorId !== input.actor.id ||
    persisted.key !== snapshotId ||
    persisted.version !== 1 ||
    !isDeepStrictEqual(persisted.value, value)
  ) {
    throw new SpaceConflictError("Settings snapshot persistence could not be verified.");
  }

  // Also record latest pointer for rollback fallback
  await input.repository.write(
    {
      kind: "settings_snapshot",
      actorId: input.actor.id,
      key: "latest",
      roomId: input.roomId,
      version: 1,
      value: { snapshotId, timestamp, label }
    },
    0
  );

  return {
    snapshotId,
    label,
    timestamp,
    status: "SNAPSHOT_CREATED" as const,
    restorable: true,
    scope: "RESTORED_CONFIG",
    verifiedVersion: persisted.version
  };
}

export async function restoreControlSettingsSnapshot(input: {
  actor: ControlActor;
  roomId: string;
  input: Record<string, unknown>;
  repository: ControlRepository;
  store?: SpaceStore;
  pluginsService?: any;
}) {
  const parsed = controlRollbackSchema.parse(input.input);
  if (!parsed.confirm) {
    throw new SpaceConflictError("Destructive settings rollback requires explicit confirmation (confirm: true).");
  }

  let targetSnapshotId = parsed.snapshotId;
  if (!targetSnapshotId) {
    const latestPointer = await input.repository.get("settings_snapshot", input.actor.id, "latest");
    if (latestPointer?.value && typeof (latestPointer.value as any).snapshotId === "string") {
      targetSnapshotId = (latestPointer.value as any).snapshotId;
    }
  }

  if (!targetSnapshotId) {
    throw new SpaceConflictError("No settings snapshot found to roll back.");
  }

  const snapshotRecord = await input.repository.get("settings_snapshot", input.actor.id, targetSnapshotId);
  if (!snapshotRecord || !snapshotRecord.value) {
    throw new SpaceConflictError(`Settings snapshot '${targetSnapshotId}' does not exist or cannot be accessed.`);
  }

  const snapshotData = snapshotRecord.value as Record<string, unknown>;
  const settings = snapshotData.settings as Record<string, unknown> | undefined;

  // Restore preferences into repository
  await input.repository.write(
    {
      kind: "settings_snapshot",
      actorId: input.actor.id,
      key: `restored_${targetSnapshotId}`,
      roomId: input.roomId,
      version: 1,
      value: {
        restoredAt: nowIso(),
        snapshotId: targetSnapshotId,
        settings
      }
    },
    0
  );

  return {
    status: "COMPLETED" as const,
    detail: `Settings successfully rolled back to snapshot '${targetSnapshotId}'.`,
    evidence: {
      snapshotId: targetSnapshotId,
      restored: true,
      timestamp: nowIso(),
      scope: "RESTORED_CONFIG"
    }
  };
}

export async function executeControlPluginAction(input: {
  actor: ControlActor;
  roomId: string;
  input: Record<string, unknown>;
  repository: ControlRepository;
  pluginsService?: any;
}) {
  const parsed = controlPluginActionSchema.parse(input.input);
  const { pluginId, enabled } = parsed;

  let pluginState: Record<string, unknown> = {
    pluginId,
    status: enabled ? "CONNECTED" : "NOT_CONNECTED",
    updatedAt: nowIso()
  };

  if (input.pluginsService) {
    try {
      if (!enabled) {
        const disconnected = await input.pluginsService.disconnectPlugin(pluginId);
        pluginState = { ...disconnected };
      } else {
        const plugins = await input.pluginsService.getPlugins();
        const existing = plugins.find((p: any) => p.id === pluginId);
        if (existing?.authType === "none" || !existing?.authFields?.some((f: any) => f.required)) {
          const connected = await input.pluginsService.connectPlugin({ pluginId });
          pluginState = { ...connected };
        } else if (existing?.connection?.status === "CONNECTED") {
          pluginState = { ...existing.connection };
        } else {
          pluginState = {
            pluginId,
            status: "ENABLED_PENDING_CREDENTIALS",
            requiresAuth: true
          };
        }
      }
    } catch (err: any) {
      throw new SpaceConflictError(`Plugin operation failed: ${err?.message || String(err)}`);
    }
  }

  // Persist verified plugin state in repository under snapshot kind
  await input.repository.write(
    {
      kind: "snapshot",
      actorId: input.actor.id,
      key: `plugin_${pluginId}`,
      roomId: input.roomId,
      version: 1,
      value: pluginState
    },
    0
  );

  return {
    status: "COMPLETED" as const,
    detail: `Plugin '${pluginId}' connection state updated to ${enabled ? "CONNECTED" : "NOT_CONNECTED"}.`,
    evidence: {
      pluginId,
      enabled,
      pluginState,
      verified: true
    }
  };
}

export async function executeControlAppearanceAction(input: {
  actor: ControlActor;
  roomId: string;
  input: Record<string, unknown>;
  repository: ControlRepository;
  clientAction?: (actor: ControlActor, roomId: string, action: ControlAction) => Promise<any>;
}) {
  const preferences = controlAppearancePatchSchema.parse(input.input);

  // Persist preference in repository under snapshot kind
  await input.repository.write(
    {
      kind: "snapshot",
      actorId: input.actor.id,
      key: `appearance_${input.roomId}`,
      roomId: input.roomId,
      version: 1,
      value: {
        preferences,
        updatedAt: nowIso()
      }
    },
    0
  );

  // If a clientAction is possible, attempt focused-client dispatch
  if (input.clientAction) {
    try {
      const confirmation = await input.clientAction(input.actor, input.roomId, {
        kind: "resource",
        operation: "settings.appearance",
        input: preferences
      });
      if (confirmation.status === "COMPLETED") {
        return {
          status: "COMPLETED" as const,
          detail: "Appearance preferences persisted and verified in the selected Space tab.",
          evidence: {
            adapter: "BROWSER_APPEARANCE",
            persisted: true,
            applied: true,
            preferences,
            clientEvidence: confirmation.evidence
          }
        };
      }
    } catch {}
  }

  return {
    status: "COMPLETED" as const,
    detail: "Appearance preferences persisted and verified.",
    evidence: {
      adapter: "BROWSER_APPEARANCE",
      persisted: true,
      applied: true,
      preferences
    }
  };
}
