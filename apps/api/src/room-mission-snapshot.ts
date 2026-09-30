import { roomAgentMissionSnapshotSchema, type RoomAgentActionRecord, type RoomAgentMissionRecord, type RoomAgentTaskRunRecord } from "@space/contracts";

/** Read-only projection. No session/model changes, model calls or new panes. */
export function roomMissionSnapshot(mission: RoomAgentMissionRecord | null, actions: RoomAgentActionRecord[], taskRuns: RoomAgentTaskRunRecord[]) {
  if (!mission) return null;
  return roomAgentMissionSnapshotSchema.parse({
    mission,
    objective: typeof mission.executionState.objective === "string" ? mission.executionState.objective : null,
    source: mission.executionState.source === "LIVE" ? "LIVE" : "ROOM_AGENT",
    completionVerified: mission.status === "COMPLETED" && actions.length > 0 &&
      actions.every(action => action.status === "COMPLETED") && taskRuns.every(run => run.status === "COMPLETED"),
    actionCount: actions.length,
    actionsTruncated: actions.length > 200,
    actions: actions.slice(-200).map(action => ({
      actionId: action.actionId, actionType: action.actionType, status: action.status,
      statusReason: action.statusReason, paneId: action.paneId, attemptCount: action.attemptCount,
      controlOperationId: typeof action.evidence.controlOperationId === "string" ? action.evidence.controlOperationId : null,
      updatedAt: action.updatedAt
    })),
    stepCount: taskRuns.length,
    stepsTruncated: taskRuns.length > 200,
    steps: taskRuns.slice(-200).map(run => ({
      stepId: run.stepId, label: run.label, status: run.status, paneId: run.paneId,
      verificationSummary: run.verificationSummary, updatedAt: run.updatedAt
    }))
  });
}
