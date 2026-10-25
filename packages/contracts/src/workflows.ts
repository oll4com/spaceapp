import type { DummyTurnInput } from "./schemas.js";

export const DUMMY_TURN_WORKFLOW_TYPE = "dummyTurnWorkflow";
export const CODEX_APP_SERVER_TURN_WORKFLOW_TYPE = "codexAppServerTurnWorkflow";
export const ROOM_AGENT_SUPERVISOR_WORKFLOW_TYPE = "roomAgentSupervisorWorkflow";
export const MEMORY_MUTATION_WORKFLOW_TYPE = "memoryMutationWorkflow";
export const MEMORY_MUTATION_TASK_QUEUE = "space-memory-mutations";
export const MEMORY_CONSOLIDATION_WORKFLOW_TYPE = "memoryConsolidationWorkflow";
export const MEMORY_CONSOLIDATION_TASK_QUEUE = "space-memory-maintenance";
export const ROOM_AGENT_ENQUEUE_SIGNAL = "enqueueRoomAgentMission";
export const ROOM_AGENT_STOP_SIGNAL = "stopRoomAgentMission";

export function buildDummyTurnWorkflowId(input: Pick<DummyTurnInput, "roomId" | "paneId" | "traceId">): string {
  return `workflow:dummy:${input.roomId}:${input.paneId}:${input.traceId}`;
}

export function buildCodexAppServerTurnWorkflowId(input: Pick<DummyTurnInput, "roomId" | "paneId" | "traceId">): string {
  return `workflow:codex-app-server:${input.roomId}:${input.paneId}:${input.traceId}`;
}

export function buildRoomAgentSupervisorWorkflowId(roomId: string): string {
  return `room-supervisor:${roomId}`;
}

export function buildMemoryMutationWorkflowId(changeSetId: string, commandHash?: string): string {
  return commandHash
    ? `space-memory-mutation:command:${commandHash}`
    : `space-memory-mutation:${changeSetId}`;
}

export function buildMemoryConsolidationWorkflowId(commandHash: string): string {
  return `space-memory-consolidation:${commandHash}`;
}
