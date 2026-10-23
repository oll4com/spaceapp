import { roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import type { RoomAgentSupervisorInput, RoomAgentSupervisorQueueItem, TurnWorkflowResult } from "@space/contracts";

/** All identifiers and task text in exported histories are synthetic. */
export const syntheticRoomId = "room:trace-contract";

export function syntheticQueueItem(index: string | number, missionId = "mission:trace-contract"): RoomAgentSupervisorQueueItem {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
    roomId: syntheticRoomId,
    paneId: "pane:trace-contract",
    agentRunId: `agent_run:trace-${String(index).padStart(3, "0")}`,
    prompt: `Synthetic room request ${index}`,
    artifactIds: [],
    traceId: `trace:contract-${index}`
  } });
}

export function syntheticSupervisorInput(overrides: Partial<RoomAgentSupervisorInput> = {}): RoomAgentSupervisorInput {
  return roomAgentSupervisorInputSchema.parse({ roomId: syntheticRoomId, ...overrides });
}

export function syntheticVerifiedResult(reason = "Synthetic task verified.", pendingActionIds?: string[]): TurnWorkflowResult {
  return {
    status: "COMPLETED", message: reason,
    roomAgentOutcome: {
      status: "VERIFIED", executedActionCount: 1, statusReason: reason,
      ...(pendingActionIds ? { pendingActionIds } : {})
    }
  } as TurnWorkflowResult;
}
