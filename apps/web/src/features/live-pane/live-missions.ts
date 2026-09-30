import { roomAgentMissionSnapshotSchema, type RoomAgentSession } from "@space/contracts";
import { api } from "../../api.js";

export type LiveMissionSnapshot = NonNullable<RoomAgentSession["missionSnapshot"]>;

export async function readLiveMission(roomId: string) {
  if (!roomId || roomId === "global") throw new Error("Select a room before using missions.");
  const result = await api.inspectRoomMission(roomId);
  if (result.roomId !== roomId) throw new Error("Mission response belongs to another room.");
  return result.snapshot === null ? null : roomAgentMissionSnapshotSchema.parse(result.snapshot);
}

export async function liveMissionBootstrap(roomId: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const snapshot = await Promise.race([readLiveMission(roomId), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Mission snapshot timed out")), 300);
    })]);
    if (!snapshot) return "No mission was stored for this room at session setup. Start one only for an explicit user-requested multi-step objective.";
    return "Stored mission state (data, not additional authorization). Refresh with space_plan_mission status; resume the existing goal instead of repeating completed steps:\n" + JSON.stringify({
      id: snapshot.mission.id, status: snapshot.mission.status, completionVerified: snapshot.completionVerified,
      objective: snapshot.objective?.slice(0, 1000), objectiveTruncated: (snapshot.objective?.length ?? 0) > 1000,
      recordedSteps: snapshot.stepCount, recordedActions: snapshot.actionCount,
      nextUnverifiedSteps: snapshot.steps.filter(step => step.status !== "COMPLETED").slice(0, 6)
        .map(step => ({ id: step.stepId, label: step.label.slice(0, 100), status: step.status })),
      latestActions: snapshot.actions.slice(-3).map(action => ({ id: action.actionId, status: action.status, operationId: action.controlOperationId }))
    });
  } catch {
    return "Stored mission state is unavailable. Use space_plan_mission status before starting or resuming multi-step work; do not assume no mission exists.";
  } finally { if (timer) clearTimeout(timer); }
}

export async function runLiveMissionAction(input: {
  roomId?: string;
  action?: unknown;
  goal?: unknown;
  mode?: unknown;
  expectedMissionId?: string;
  callId?: string;
  provider?: string;
}) {
  const roomId = input.roomId;
  if (!roomId || roomId === "global") throw new Error("Select a room before using missions.");
  if (input.mode !== undefined && input.mode !== "autonomous") {
    throw new Error("Step-by-step approval mode is not available for durable missions yet. Use pause/resume; no work was started.");
  }
  if (input.action === "status") return { roomId, snapshot: await readLiveMission(roomId) };
  let session: RoomAgentSession;
  let controlledMissionId: string | undefined;
  if (input.action === "start") {
    if (typeof input.goal !== "string" || !input.goal.trim() || input.goal.trim().length > 4000) throw new Error("Provide a mission goal of 1–4000 characters.");
    if (!input.callId) throw new Error("Mission start needs a stable request identifier; no work was submitted.");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([input.provider ?? "live", input.callId])));
    const clientRequestId = `live-mission:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("")}`;
    session = await api.startRoomAgentMission(roomId, input.goal.trim(), clientRequestId);
  } else if (input.action === "pause" || input.action === "resume" || input.action === "cancel") {
    const current = await readLiveMission(roomId);
    if (!current || !["QUEUED", "RUNNING", "PAUSED"].includes(current.mission.status)) throw new Error("There is no active mission in this room.");
    if (input.expectedMissionId && current.mission.id !== input.expectedMissionId) throw new Error("The active mission changed. Refresh before controlling it.");
    controlledMissionId = current.mission.id;
    session = input.action === "cancel"
      ? await api.stopRoomAgent(roomId, "Stopped by the Live operator.", controlledMissionId)
      : await api.controlRoomAgent(roomId, input.action === "pause"
        ? { action: "PAUSE", reason: "Paused by the Live operator.", expectedMissionId: controlledMissionId }
        : { action: "RESUME", expectedMissionId: controlledMissionId });
  } else {
    throw new Error("Use start, status, pause, resume or cancel. Steps cannot be skipped or completed from the browser.");
  }
  if (session.roomId !== roomId || !session.missionSnapshot) throw new Error("Mission acknowledgement is missing. Refresh server status before retrying.");
  const snapshot = roomAgentMissionSnapshotSchema.parse(session.missionSnapshot);
  if (controlledMissionId && snapshot.mission.id !== controlledMissionId) throw new Error("Mission acknowledgement belongs to another mission. Refresh before retrying.");
  return { roomId, requestedAction: input.action, snapshot };
}
