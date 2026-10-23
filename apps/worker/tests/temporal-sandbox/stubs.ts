/**
 * Synthetic activity results and workflow inputs for the time-skipping
 * tests. Everything here is synthetic data only - no real rooms, missions
 * or memory state.
 */
import type { MemoryConsolidationRun } from "@space/contracts";

export const HEX64 = "0123456789abcdef".repeat(4);
const NOW = "2026-01-01T00:00:00.000Z";

export function memoryMaintenanceResult(overrides: Record<string, unknown> = {}) {
  return {
    status: "REFRESHED",
    generatedAt: NOW,
    sourceHash: HEX64,
    previousSourceHash: null,
    summary: { sourceCount: 1, recordCount: 2, nodeCount: 3, edgeCount: 4, issueCount: 0 },
    durationMs: 12,
    ...overrides
  };
}

export function consolidationRun(id: string, overrides: Partial<MemoryConsolidationRun> = {}): MemoryConsolidationRun {
  return {
    id,
    mode: "AUDIT",
    triggerKind: "SCHEDULED",
    status: "SUCCEEDED",
    workflowId: "space-memory-consolidation:" + id,
    dedupeKey: "scheduled:" + id,
    sourceHash: null,
    actorUserId: null,
    progressCompleted: 1,
    progressTotal: 1,
    findingCount: 0,
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: null,
    createdAt: NOW,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
    ...overrides
  } as MemoryConsolidationRun;
}

export function turnWorkflowResult(input: { roomId: string; paneId: string; traceId: string }, overrides: Record<string, unknown> = {}) {
  return {
    workflowId: "space-turn:" + input.traceId,
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status: "COMPLETED",
    message: "Synthetic turn completed.",
    ...overrides
  };
}

export function dummyTurnResult(input: { roomId: string; paneId: string; traceId: string }) {
  return {
    workflowId: "workflow:dummy:" + input.roomId + ":" + input.paneId + ":" + input.traceId,
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status: "COMPLETED",
    message: "Synthetic dummy turn completed."
  };
}

/** A DummyTurnInput that routes to the native chat turn activity. */
export function nativeTurnInput(roomId: string, suffix = "native") {
  return {
    roomId,
    paneId: "pane:" + roomId + "-" + suffix,
    prompt: "Synthetic turn prompt.",
    artifactIds: [],
    providerId: null,
    modelId: "gpt-test",
    reasoningEffort: null,
    agentSessionId: "session:" + roomId + "-" + suffix,
    agentRunId: "agent_run:" + roomId + "-" + suffix,
    agentAssistantMessageId: "agent_msg:assistant-" + roomId + "-" + suffix,
    collaborationMode: "default",
    traceId: "trace:" + roomId + "-" + suffix
  };
}

/** A DummyTurnInput that routes to the room-agent turn activity. */
export function roomAgentTurnInput(roomId: string, missionId: string, suffix = "room-agent") {
  return {
    ...nativeTurnInput(roomId, suffix),
    roomAgentMissionId: missionId,
    roomAgentOperatorRequest: "Synthetic operator request.",
    selectedToolIds: ["room:inspect"]
  };
}

/** A valid supervisor queue item for roomId. */
export function supervisorQueueItem(roomId: string, missionId: string, agentRunSuffix: string) {
  const turn = roomAgentTurnInput(roomId, missionId, agentRunSuffix);
  return {
    missionId,
    turn: { ...turn, agentUserMessageId: "agent_msg:user-" + roomId + "-" + agentRunSuffix }
  };
}

/** A valid supervisor workflow input. */
export function supervisorInput(roomId: string, overrides: Record<string, unknown> = {}) {
  return {
    roomId,
    pending: [],
    monitoringMissionIds: [],
    interrupted: [],
    processedCount: 0,
    ...overrides
  };
}

/** A valid room action bridge request for the background action workflow. */
export function roomActionBridgeRequest(roomId: string, missionId: string) {
  return {
    roomId,
    missionId,
    agentPaneId: "pane:" + roomId + "-action",
    agentSessionId: "session:" + roomId + "-action",
    selectedToolIds: ["room:inspect"],
    actions: [{ toolId: "room:inspect", action: { type: "inspect", arguments: {} } }]
  };
}
