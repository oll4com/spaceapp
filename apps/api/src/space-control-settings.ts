import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { ControlAction } from "@space/contracts";
import type { ControlRepository } from "@space/db";
import { makeSpaceId, nowIso, SpaceConflictError } from "@space/runtime";
import type { ControlActor } from "./space-control.js";

export type ResourceAction = Extract<ControlAction, { kind: "resource" }>;

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
  // SETTINGS is a sanitized observation (including unavailable fields), not a
  // complete backup of browser preferences or credentials.
  const value = { id: snapshotId, label, timestamp, restorable: false, kind: "SANITIZED_OBSERVATION", settings };
  const saved = await input.repository.write({ kind: "settings_snapshot", actorId: input.actor.id,
    key: snapshotId, roomId: input.roomId, version: 1, value }, 0);
  if (!saved) throw new SpaceConflictError("Settings snapshot could not be persisted.");
  const persisted = await input.repository.get("settings_snapshot", input.actor.id, snapshotId);
  if (!persisted || persisted.roomId !== input.roomId || persisted.actorId !== input.actor.id ||
    persisted.key !== snapshotId || persisted.version !== 1 || !isDeepStrictEqual(persisted.value, value)) {
    throw new SpaceConflictError("Settings snapshot persistence could not be verified.");
  }
  return { snapshotId, label, timestamp, status: "SNAPSHOT_CREATED", restorable: false,
    scope: "SANITIZED_OBSERVATION", verifiedVersion: persisted.version };
}
