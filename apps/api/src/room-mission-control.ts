import type { RoomAgentMissionRecord } from "@space/contracts";
import { SpaceConflictError, type RoomAgentMissionUpdateGuard, type SpaceStore } from "@space/runtime";

export interface RoomMissionControlTarget { expectedMissionId?: string; actorId?: string }
export const activeMissionStatuses: RoomAgentMissionRecord["status"][] = ["QUEUED", "RUNNING", "PAUSED"];

export function assertMissionControlOwner(mission: RoomAgentMissionRecord, actorId?: string) {
  const ownerId = mission.executionState.ownerId;
  if (ownerId != null && ownerId !== actorId) throw new SpaceConflictError("This mission belongs to another operator.");
}

export async function resolveMissionControlTarget(store: SpaceStore, roomId: string, target: RoomMissionControlTarget | undefined,
  statuses: RoomAgentMissionRecord["status"][] = activeMissionStatuses) {
  let mission: RoomAgentMissionRecord | null;
  if (target?.expectedMissionId) {
    mission = await store.getRoomAgentMission(roomId, target.expectedMissionId);
    if (!mission || !statuses.includes(mission.status)) throw new SpaceConflictError("The requested mission is not controllable in this room. Refresh its status.");
  } else {
    const missions = (await store.listRoomAgentMissions(roomId)).filter(item => statuses.includes(item.status));
    if (missions.length > 1) throw new SpaceConflictError("More than one mission is active. Specify the expected mission ID.");
    mission = missions[0] ?? null;
  }
  if (mission) assertMissionControlOwner(mission, target?.actorId);
  return mission;
}

export function missionControlGuard(mission: RoomAgentMissionRecord): RoomAgentMissionUpdateGuard {
  return { expectedStatus: mission.status, expectedUpdatedAt: mission.updatedAt,
    expectedOwnerId: typeof mission.executionState.ownerId === "string" ? mission.executionState.ownerId : null,
    expectedExecutionState: structuredClone(mission.executionState), rejectOnConflict: true };
}
