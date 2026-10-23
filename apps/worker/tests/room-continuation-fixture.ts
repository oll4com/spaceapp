import { buildCodexAppServerTurnWorkflowId, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";

/**
 * An in-memory store with a running Room Agent mission whose first turn has
 * completed after one settled action. `initialTurn` overrides fields of that
 * first turn (for example its traceparent).
 */
export function continuationFixture(actionType: "OPEN_TYPES" | "CONFIGURE_PANE" = "OPEN_TYPES", initialTurn: Record<string, unknown> = {}) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Continuation regression", initialPaneCount: 0 });
  const pane = store.getOrCreateRoomAgentPane(room.id);
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Room Agent",
    selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
    selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
  /** Queues one mission turn; `turn` overrides fields of the queued turn. */
  function enqueue(suffix: string, prompt = "Open CLI and Chat, then send a story to both.", turn: Record<string, unknown> = {}) {
    const item = roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:continuation", turn: {
      roomId: room.id, paneId: pane.id, prompt, roomAgentOperatorRequest: prompt,
      modelId: "gpt-5.6-sol", reasoningEffort: "high", agentSessionId: session.sessionId,
      agentRunId: `agent_run:${suffix}`, agentUserMessageId: `agent_msg:user-${suffix}`,
      agentAssistantMessageId: `agent_msg:assistant-${suffix}`, roomAgentMissionId: "mission:continuation",
      traceId: `trace:continuation-${suffix}`, selectedToolIds: ["room:inspect", "room:open_types", "room:send"], ...turn
    } });
    return store.enqueueRoomAgentMission({ requestId: `request:${suffix}`, clientRequestId: `client-${suffix}`, content: prompt,
      supervisorWorkflowId: `room-supervisor:${room.id}`, childWorkflowId: buildCodexAppServerTurnWorkflowId(item.turn),
      promptMessageId: item.turn.agentUserMessageId!, responseMessageId: item.turn.agentAssistantMessageId!,
      runId: item.turn.agentRunId!, queueItem: item });
  }
  const initial = enqueue("initial", undefined, initialTurn);
  store.updateRoomAgentMission(initial.mission.id, { status: "RUNNING" });
  store.updateSpaceAgentRun(initial.run.runId, { status: "COMPLETED" });
  store.markRoomAgentMissionSignaled(room.id, "client-initial");
  const action = store.createRoomAgentAction({ actionId: "action:allocation", missionId: initial.mission.id, roomId: room.id,
    paneId: null, actionType, status: "COMPLETED", idempotencyKey: "allocation-once",
    requestPayload: { _roomBackgroundRoot: true }, evidence: { panes: [{ paneId: "pane:cli" }, { paneId: "pane:chat" }], input: null },
    attemptCount: 1, statusReason: "Allocated two panes without submitting a task." });
  const input = { roomId: room.id, missionId: initial.mission.id, continuationId: "test-1" };
  return { store, room, pane, session, initial, action, input, enqueue };
}
