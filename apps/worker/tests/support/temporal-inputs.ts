import { roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";

export const roomId = "room:synthetic";
export const verified = { status: "COMPLETED", message: "Synthetic completion", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verified evidence."
} };

export function queueItem(index: string | number) {
  return roomAgentSupervisorQueueItemSchema.parse({
    missionId: `mission:${index}`,
    turn: { roomId, paneId: "pane:synthetic", prompt: `Synthetic task ${index}`, traceId: `trace:${index}`,
      agentRunId: `agent_run:${index}`, roomAgentMissionId: `mission:${index}` }
  });
}

export function supervisorInput(overrides: Record<string, unknown> = {}) {
  return roomAgentSupervisorInputSchema.parse({ roomId, ...overrides });
}
