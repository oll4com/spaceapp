import type { RoomAgentSupervisorQueueItem, RoomAgentSupervisorStopSignal, TurnWorkflowResult } from "@space/contracts";

export const ROOM_AGENT_TURN_ACTIVITY_TIMEOUT = "24 hours" as const;
export const ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS = 5;
export const ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT = "15 seconds" as const;
export const ROOM_AGENT_TURN_HEARTBEAT_INTERVAL_MS = 5_000;

export function roomAgentMissionCompletion(result: TurnWorkflowResult): {
  status: "COMPLETED" | "FAILED" | "INTERRUPTED";
  statusReason: string;
} {
  if (result.status === "CANCELLED") {
    return { status: "INTERRUPTED", statusReason: result.message };
  }
  if (result.status === "COMPLETED" && result.roomAgentOutcome?.status === "VERIFIED") {
    return { status: "COMPLETED", statusReason: result.roomAgentOutcome.statusReason };
  }
  if (result.roomAgentOutcome?.status === "UNVERIFIED") {
    return { status: "FAILED", statusReason: result.roomAgentOutcome.statusReason };
  }
  return {
    status: "FAILED",
    statusReason:
      result.status === "FAILED"
        ? result.message
        : "Room Agent turn ended without verified room-action evidence."
  };
}

export function enqueueRoomAgentMission(
  pending: RoomAgentSupervisorQueueItem[],
  _activeMissionId: string | null,
  item: RoomAgentSupervisorQueueItem
): RoomAgentSupervisorQueueItem[] {
  const itemKey = item.turn.agentRunId ?? item.turn.traceId;
  if (pending.some((queued) => (queued.turn.agentRunId ?? queued.turn.traceId) === itemKey)) {
    return pending;
  }
  return [...pending, item];
}

export function roomAgentMissionHasContinuation(
  pending: RoomAgentSupervisorQueueItem[],
  missionId: string
): boolean {
  return pending.some((item) => item.missionId === missionId);
}

export function stopRoomAgentMissions(
  pending: RoomAgentSupervisorQueueItem[],
  activeMissionId: string | null,
  signal: RoomAgentSupervisorStopSignal
): {
  pending: RoomAgentSupervisorQueueItem[];
  interrupted: RoomAgentSupervisorQueueItem[];
  shouldCancelActive: boolean;
} {
  const matches = (missionId: string) => signal.missionId === null || signal.missionId === missionId;
  return {
    pending: pending.filter((item) => !matches(item.missionId)),
    interrupted: pending.filter((item) => matches(item.missionId)),
    shouldCancelActive: activeMissionId !== null && matches(activeMissionId)
  };
}
