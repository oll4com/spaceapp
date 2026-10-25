import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ACTIVE_PANE_CAP,
  InMemorySpaceStore,
  PANE_CLI_TRANSCRIPT_CHUNK_CAP,
  SpaceConflictError,
  SpaceFeatureDisabledError,
  hashMemorySnapshot,
  redactMemoryText
} from "../src/index.js";

describe("InMemorySpaceStore", () => {
  it("reads panes directly and pages events without changing full-list semantics", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Bounded events", initialPaneCount: 0 }, "trace:events");
    const pane = store.createPane(
      { roomId: room.id, title: "Terminal", mode: "TERMINAL", cwd: "/etc" },
      "trace:events-pane"
    );

    expect(store.getPane(pane.id)).toEqual(pane);
    expect(() => store.getPane("pane:missing")).toThrow("Pane pane:missing was not found.");

    for (let index = 0; index < 27; index += 1) {
      store.updatePane(pane.id, { isClosed: true }, `trace:events-close-${index}`);
      store.updatePane(pane.id, { isClosed: false }, `trace:events-open-${index}`);
    }

    const fullList = store.listEvents(room.id);
    const firstPage = store.listEventsPage({ roomId: room.id, page: 1, pageSize: 50, sortOrder: "desc" });
    const secondPage = store.listEventsPage({ roomId: room.id, page: 2, pageSize: 50, sortOrder: "desc" });

    expect(firstPage.total).toBe(fullList.length);
    expect(firstPage.items).toHaveLength(50);
    expect(secondPage.items).toHaveLength(fullList.length - 50);
    const descendingIds = [...fullList]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
      .map((event) => event.id);
    expect([...firstPage.items, ...secondPage.items].map((event) => event.id)).toEqual(
      descendingIds
    );
    expect(store.getLatestEvent(room.id)).toEqual(firstPage.items[0]);
    expect(store.listEvents(room.id)).toEqual(fullList);
  });

  it("pages turns with deterministic ordering while retaining the full-list reader", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Bounded turns", initialPaneCount: 1 }, "trace:turn-room");
    const pane = store.listPanes(room.id)[0]!;
    for (let index = 0; index < 3; index += 1) {
      store.recordTurnQueued({
        roomId: room.id,
        paneId: pane.id,
        workflowId: `workflow:bounded-${index}`,
        runId: `run:bounded-${index}`,
        taskQueue: "space-agent-turns",
        traceId: `trace:bounded-${index}`,
        prompt: `prompt ${index}`,
        providerId: null,
        modelId: null
      });
    }

    const fullList = store.listTurns(room.id);
    const page = store.listTurnsPage({ roomId: room.id, page: 2, pageSize: 2, sortOrder: "asc" });
    const ascending = [...fullList].sort(
      (left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
    );

    expect(page).toEqual({ items: [ascending[2]], total: 3 });
    expect(store.listTurns(room.id)).toEqual(fullList);
  });

  it("continues durable event sequences beyond five hundred rows", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Event range", initialPaneCount: 0 }, "trace:event-range-room");
    const pane = store.createPane(
      { roomId: room.id, title: "Range terminal", mode: "TERMINAL", cwd: "/etc" },
      "trace:event-range-pane"
    );
    for (let index = 0; index < 501; index += 1) {
      store.updatePane(pane.id, { title: `Range terminal ${index}` }, `trace:event-range-${index}`);
    }
    const first = store.listEventChanges({
      afterSequence: null,
      sortOrder: "asc",
      limit: 500
    });
    const last = first.at(-1)!;
    const second = store.listEventChanges({
      afterSequence: last.sequence,
      sortOrder: "asc",
      limit: 500
    });
    const latest = store.listEventChanges({ afterSequence: null, sortOrder: "desc", limit: 1 });
    const expectedIds = store.listEvents(room.id).slice(500).map((candidate) => candidate.id);

    expect(first).toHaveLength(500);
    expect(second).toHaveLength(3);
    expect(second.map((change) => change.event.id)).toEqual(expectedIds);
    expect(second.at(-1)?.event.id).toBe(latest[0]?.event.id);
    expect(BigInt(second[0]!.sequence)).toBe(BigInt(last.sequence) + 1n);
  });

  it("lists unique Space-managed Codex thread ids across terminal and agent surfaces", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Managed Codex threads", initialPaneCount: 0 });
    const terminalPane = store.createPane({ roomId: room.id, title: "Terminal", mode: "TERMINAL", cwd: "/etc" });
    const chatPane = store.createPane({ roomId: room.id, title: "Chat", mode: "CHAT", cwd: "/etc" });
    const terminalThreadId = "019f0000-0000-7000-8000-000000000011";
    const agentThreadId = "019f0000-0000-7000-8000-000000000012";
    const inactiveTerminalThreadId = "019f0000-0000-7000-8000-000000000013";
    const inactiveAgentThreadId = "019f0000-0000-7000-8000-000000000014";
    const cliSession = store.createPaneCliSession({
      roomId: room.id,
      paneId: terminalPane.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: terminalThreadId,
      status: "RUNNING",
      statusReason: "Running",
      isActive: true
    });
    store.claimPaneCliCodexThread(cliSession.sessionId, terminalThreadId, "AUTO");
    store.createSpaceAgentSession({
      paneId: chatPane.id,
      roomId: room.id,
      title: "Chat",
      threadId: agentThreadId,
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high"
    });
    const inactiveTerminalPane = store.createPane({ roomId: room.id, title: "Old terminal", mode: "TERMINAL", cwd: "/etc" });
    const inactiveCliSession = store.createPaneCliSession({
      roomId: room.id,
      paneId: inactiveTerminalPane.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: inactiveTerminalThreadId,
      status: "RUNNING",
      statusReason: "Running",
      isActive: true
    });
    store.claimPaneCliCodexThread(inactiveCliSession.sessionId, inactiveTerminalThreadId, "AUTO");
    store.updatePaneCliSession(inactiveCliSession.sessionId, {
      status: "EXITED",
      statusReason: "Closed",
      isActive: false
    });
    const inactiveAgentPane = store.createPane({ roomId: room.id, title: "Old chat", mode: "CHAT", cwd: "/etc" });
    store.createSpaceAgentSession({
      paneId: inactiveAgentPane.id,
      roomId: room.id,
      title: "Old chat",
      threadId: inactiveAgentThreadId,
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      isActive: false
    });

    expect(store.listManagedCodexThreadIds()).toEqual([
      terminalThreadId,
      agentThreadId,
      inactiveTerminalThreadId,
      inactiveAgentThreadId
    ]);
    expect(store.listActiveManagedCodexThreadIds()).toEqual([terminalThreadId, agentThreadId]);
  });

  it("hides only inactive shared CLI tasks during purge and can restore them", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Shared history purge", initialPaneCount: 0 });
    const activePane = store.createPane({
      roomId: room.id,
      title: "Active protected task",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:codex",
      cwd: "/etc"
    });
    const inactivePane = store.createPane({
      roomId: room.id,
      title: "Inactive duplicate task",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:gemini",
      cwd: "/etc"
    });
    const active = store.createPaneCliSession({
      paneId: activePane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      status: "RUNNING",
      isActive: true
    });
    const inactive = store.createPaneCliSession({
      paneId: inactivePane.id,
      roomId: room.id,
      runtimeId: "cli:gemini",
      providerId: "gemini",
      agentId: "gemini",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      status: "RUNNING",
      isActive: true
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: active.sessionId,
      paneId: activePane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdin",
      content: "Keep the active task"
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: inactive.sessionId,
      paneId: inactivePane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdin",
      content: "Remove the inactive task"
    });
    store.updatePaneCliSession(inactive.sessionId, {
      status: "EXITED",
      exitCode: 0,
      isActive: false
    });

    expect(store.listInactivePaneCliTaskIds()).toEqual([inactive.cliTaskId]);
    expect(store.hideInactivePaneCliTasks([active.cliTaskId!, inactive.cliTaskId!])).toEqual([inactive.cliTaskId]);
    expect(store.listPaneCliTaskHistory({ page: 1, pageSize: 50 })).toMatchObject({
      total: 1,
      items: [expect.objectContaining({ taskId: active.cliTaskId })]
    });

    store.restorePaneCliTasks([inactive.cliTaskId!]);
    expect(store.listPaneCliTaskHistory({ page: 1, pageSize: 50 }).total).toBe(2);
  });

  it("persists one hidden room-agent pane plus idempotent mission and action checkpoints", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Supervisor", initialPaneCount: 0 }, "trace:room-agent");
    const hiddenPane = store.getOrCreateRoomAgentPane(room.id, "trace:room-agent");
    const samePane = store.getOrCreateRoomAgentPane(room.id, "trace:room-agent-repeat");

    expect(samePane.id).toBe(hiddenPane.id);
    expect(hiddenPane).toMatchObject({ roomId: room.id, mode: "CHAT", isClosed: true, status: "CLOSED" });
    expect(store.listPanes(room.id)).toEqual([]);

    const session = store.createSpaceAgentSession({
      paneId: hiddenPane.id,
      roomId: room.id,
      title: "Room Agent",
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high"
    });
    const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Finish every pane." });
    const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const request = store.createRoomAgentRequest({
      requestId: "room_agent_request:one",
      roomId: room.id,
      sessionId: session.sessionId,
      clientRequestId: "room-agent-client-request-0001",
      promptMessageId: prompt.messageId,
      responseMessageId: response.messageId
    });
    expect(store.getRoomAgentRequest(room.id, request.clientRequestId)?.requestId).toBe(request.requestId);
    expect(() => store.createRoomAgentRequest({ ...request })).toThrow(SpaceConflictError);

    const mission = store.createRoomAgentMission({
      id: "room_agent_mission:one",
      requestId: request.requestId,
      roomId: room.id,
      sessionId: session.sessionId,
      workflowId: "workflow:room-agent:one",
      status: "QUEUED",
      currentPaneId: null,
      statusReason: "Mission queued."
    });
    const action = store.createRoomAgentAction({
      actionId: "room_agent_action:one",
      missionId: mission.id,
      roomId: room.id,
      paneId: null,
      idempotencyKey: "room-agent-action-key-0001",
      actionType: "INSPECT",
      status: "QUEUED",
      requestPayload: {},
      evidence: {},
      attemptCount: 0,
      statusReason: "Inspection queued."
    });
    const taskRun = store.upsertRoomAgentTaskRun({
      runId: "room_agent_task_run:one",
      missionId: mission.id,
      roomId: room.id,
      stepId: "step-one",
      paneId: hiddenPane.id,
      label: "First task",
      instruction: "Finish and verify the first task.",
      status: "RUNNING",
      state: "RUNNING",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      qualityScore: null,
      qualityUnavailableReason: "Evaluation pending.",
      reliabilityScore: 0,
      combinedScore: null,
      rubric: null,
      queueMs: 0,
      firstResponseMs: null,
      executionMs: 0,
      totalMs: 0,
      retries: 0,
      recoveries: 0,
      stalls: 0,
      queuedAt: "2026-07-12T00:00:00.000Z",
      startedAt: "2026-07-12T00:00:01.000Z",
      firstResponseAt: null,
      completedAt: null,
      verificationSummary: "Task is running."
    });
    const completedTaskRun = store.upsertRoomAgentTaskRun({
      ...taskRun,
      status: "COMPLETED",
      state: "COMPLETED",
      reliabilityScore: 100,
      executionMs: 1_000,
      totalMs: 1_000,
      completedAt: "2026-07-12T00:00:02.000Z",
      verificationSummary: "Verified completion evidence recorded."
    });

    expect(store.listRoomAgentMissions(room.id)).toEqual([mission]);
    expect(store.listRoomAgentActions(mission.id)).toEqual([action]);
    expect(store.listRoomAgentTaskRuns(mission.id)).toEqual([completedTaskRun]);
    expect(store.getRoomAgentTaskRun(mission.id, "step-one")).toEqual(completedTaskRun);
    expect(store.getRoomAgentMission(room.id, "room_agent_mission:missing")).toBeNull();
    expect(store.getRoomAgentAction(mission.id, "room_agent_action:missing")).toBeNull();
    expect(store.getRoomAgentAction("room_agent_mission:missing", action.actionId)).toBeNull();
  });

  it("atomically reuses one durable room-agent enqueue for client retries", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Supervisor queue", initialPaneCount: 0 }, "trace:room-agent-enqueue");
    const pane = store.getOrCreateRoomAgentPane(room.id);
    const session = store.createSpaceAgentSession({
      sessionId: pane.id,
      paneId: pane.id,
      roomId: room.id,
      title: "Room Agent",
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high"
    });
    const input = {
      requestId: "room_agent_request:atomic",
      requireNewMission: true,
      initialExecutionState: { source: "LIVE", objective: "Finish the room." },
      clientRequestId: "room-agent-client-atomic",
      content: "Finish the room.",
      supervisorWorkflowId: `room-supervisor:${room.id}`,
      childWorkflowId: `workflow:codex-app-server:${room.id}:${pane.id}:room-agent-client-atomic`,
      promptMessageId: "agent_msg:room-agent-atomic-user",
      responseMessageId: "agent_msg:room-agent-atomic-assistant",
      runId: "agent_run:room-agent-atomic",
      queueItem: {
        missionId: "room_agent_mission:atomic",
        turn: {
          roomId: room.id,
          paneId: pane.id,
          prompt: "Full-room supervisor context. Finish the room.",
          modelId: "gpt-5.6-sol" as const,
          reasoningEffort: "high" as const,
          agentSessionId: session.sessionId,
          agentRunId: "agent_run:room-agent-atomic",
          roomAgentMissionId: "room_agent_mission:atomic",
          agentUserMessageId: "agent_msg:room-agent-atomic-user",
          agentAssistantMessageId: "agent_msg:room-agent-atomic-assistant",
          traceId: "room-agent-client-atomic"
        }
      }
    };

    const first = store.enqueueRoomAgentMission(input);
    expect(first.mission.executionState).toEqual(input.initialExecutionState);
    expect(() => store.enqueueRoomAgentMission({ ...input, clientRequestId: "client:another-mission" })).toThrow(/already active/);
    const retry = store.enqueueRoomAgentMission({
      ...input,
      requestId: "room_agent_request:ignored-retry",
      content: "A changed retry must not replace the original prompt."
    });
    expect(store.listUnsignaledRoomAgentEnqueues()).toEqual([
      expect.objectContaining({ request: first.request, queueItem: first.queueItem })
    ]);
    store.markRoomAgentMissionSignaled(room.id, input.clientRequestId);
    const acknowledgedRetry = store.enqueueRoomAgentMission(input);

    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.queueItem).toEqual(first.queueItem);
    expect(retry.promptMessage.content).toBe("Finish the room.");
    expect(acknowledgedRetry.signaledAt).not.toBeNull();
    expect(store.listUnsignaledRoomAgentEnqueues()).toEqual([]);
    expect(store.listRoomAgentMissions(room.id)).toHaveLength(1);
    expect(store.listSpaceAgentMessages(session.sessionId)).toHaveLength(2);
  });

  it("creates a room with the requested initial panes and events", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Launch", initialPaneCount: 4 }, "trace:test");

    expect(store.listRooms()).toHaveLength(1);
    expect(store.listPanes(room.id)).toHaveLength(4);
    expect(store.listEvents(room.id).map((event) => event.type)).toContain("ROOM_CREATED");
    expect(store.listEvents(room.id).map((event) => event.type)).toContain("PANE_CREATED");
  });

  it("keeps workspace rooms as the default while allowing an internal agent proof classification", () => {
    const store = new InMemorySpaceStore();
    const workspace = store.createRoom({ name: "Workspace", initialPaneCount: 0 }, "trace:workspace");
    const proof = store.createRoom(
      { name: "Agent Proof", initialPaneCount: 0, kind: "AGENT_PROOF" },
      "trace:proof"
    );

    expect(workspace.kind).toBe("WORKSPACE");
    expect(proof.kind).toBe("AGENT_PROOF");
  });

  it("supports a zero-open-pane room state", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Empty", initialPaneCount: 0 }, "trace:empty");

    expect(store.listPanes(room.id)).toEqual([]);
  });

  it("assigns stable room order and supports persistent reordering", () => {
    const store = new InMemorySpaceStore();
    const first = store.createRoom({ name: "First", initialPaneCount: 0 }, "trace:first");
    const second = store.createRoom({ name: "Second", initialPaneCount: 0 }, "trace:second");
    const third = store.createRoom({ name: "Third", initialPaneCount: 0 }, "trace:third");

    expect(store.listRooms().map((room) => [room.name, room.order])).toEqual([
      ["First", 0],
      ["Second", 1],
      ["Third", 2]
    ]);

    const reordered = store.reorderRooms([third.id, first.id, second.id], "trace:reorder");
    expect(reordered.map((room) => [room.name, room.order])).toEqual([
      ["Third", 0],
      ["First", 1],
      ["Second", 2]
    ]);
    expect(store.listRooms().map((room) => room.id)).toEqual([third.id, first.id, second.id]);
  });

  it("compacts room order after deletion", () => {
    const store = new InMemorySpaceStore();
    const first = store.createRoom({ name: "First", initialPaneCount: 0 }, "trace:first");
    const second = store.createRoom({ name: "Second", initialPaneCount: 0 }, "trace:second");
    const third = store.createRoom({ name: "Third", initialPaneCount: 0 }, "trace:third");

    store.reorderRooms([third.id, first.id, second.id], "trace:reorder");
    store.deleteRoom(first.id);

    expect(store.listRooms().map((room) => [room.name, room.order])).toEqual([
      ["Third", 0],
      ["Second", 1]
    ]);
  });

  it("enforces the active pane cap", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Cap", initialPaneCount: ACTIVE_PANE_CAP }, "trace:cap");

    expect(() =>
      store.createPane({ roomId: room.id, title: "Overflow", mode: "CHAT" }, "trace:cap")
    ).toThrow(SpaceConflictError);
  });

  it("keeps new and reopened panes at the active tail order", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Order", initialPaneCount: 0 }, "trace:order");
    const first = store.createPane({ roomId: room.id, title: "First", mode: "CHAT" }, "trace:order");
    const second = store.createPane({ roomId: room.id, title: "Second", mode: "CHAT" }, "trace:order");
    const third = store.createPane({ roomId: room.id, title: "Third", mode: "CHAT" }, "trace:order");

    store.updatePane(second.id, { isClosed: true, status: "CLOSED" }, "trace:order");

    const createdAfterClose = store.createPane({ roomId: room.id, title: "Fourth", mode: "CHAT" }, "trace:order");
    expect(createdAfterClose.order).toBe(3);
    expect(store.listPanes(room.id).map((pane) => [pane.title, pane.order])).toEqual([
      ["First", 0],
      ["Third", 2],
      ["Fourth", 3]
    ]);

    const reopened = store.updatePane(second.id, { isClosed: false, status: "IDLE" }, "trace:order");
    expect(reopened.order).toBe(4);
    expect(store.listPanes(room.id).map((pane) => [pane.title, pane.order])).toEqual([
      ["First", 0],
      ["Third", 2],
      ["Fourth", 3],
      ["Second", 4]
    ]);

    expect(first.order).toBe(0);
    expect(third.order).toBe(2);
  });

  it("persists minimized state and keeps it mutually exclusive with maximize", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Layouts", initialPaneCount: 0 }, "trace:layout");
    const pane = store.createPane({ roomId: room.id, title: "CLI", mode: "TERMINAL" }, "trace:layout");

    expect(pane).toMatchObject({ isMaximized: false, isMinimized: false });
    expect(store.updatePane(pane.id, { isMaximized: true }, "trace:maximize")).toMatchObject({
      isMaximized: true,
      isMinimized: false
    });
    expect(store.updatePane(pane.id, { isMinimized: true }, "trace:minimize")).toMatchObject({
      isMaximized: false,
      isMinimized: true
    });
    expect(store.updatePane(pane.id, { isMaximized: true }, "trace:maximize-again")).toMatchObject({
      isMaximized: true,
      isMinimized: false
    });
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" }, "trace:close");
    expect(store.updatePane(pane.id, { isClosed: false, status: "IDLE" }, "trace:reopen")).toMatchObject({
      isMaximized: false,
      isMinimized: false
    });
  });

  it("applies a room pane layout atomically without changing pane identity, order, minimization, split, or sessions", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Preset layouts", initialPaneCount: 0 }, "trace:layout-room");
    const first = store.createPane({ roomId: room.id, title: "CLI", mode: "TERMINAL" }, "trace:first");
    const second = store.createPane({ roomId: room.id, title: "Review", mode: "REVIEW" }, "trace:second");
    const closed = store.createPane({ roomId: room.id, title: "Closed", mode: "CHAT" }, "trace:closed");
    store.updatePane(first.id, { columnSpan: 3, isMaximized: true }, "trace:first-layout");
    store.updatePane(
      second.id,
      {
        columnSpan: 2,
        isMinimized: true,
        split: { parentId: first.id, direction: "vertical", size: 40 }
      },
      "trace:second-layout"
    );
    store.updatePane(closed.id, { columnSpan: 2, isClosed: true, status: "CLOSED" }, "trace:close");
    const cliSession = store.createPaneCliSession({
      roomId: room.id,
      paneId: first.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/opt/spaceapp",
      status: "RUNNING",
      statusReason: "Running",
      isActive: true
    });

    const beforeIdsAndOrder = store.listPanes(room.id).map((pane) => [pane.id, pane.order]);
    const result = store.updateRoomPaneLayout(room.id, { paneLayoutColumns: 3 }, "trace:preset");

    expect(result.room).toMatchObject({ id: room.id, paneLayoutColumns: 3, traceId: "trace:preset" });
    expect(result.panes.map((pane) => [pane.id, pane.order])).toEqual(beforeIdsAndOrder);
    expect(result.panes).toEqual([
      expect.objectContaining({ id: first.id, columnSpan: 1, isMaximized: false, isMinimized: false }),
      expect.objectContaining({
        id: second.id,
        columnSpan: 1,
        isMaximized: false,
        isMinimized: true,
        split: { parentId: first.id, direction: "vertical", size: 40 }
      })
    ]);
    expect(store.getPaneCliSession(cliSession.sessionId)).toEqual(cliSession);
    expect(store.listPanes(room.id, true).find((pane) => pane.id === closed.id)).toMatchObject({
      columnSpan: 2,
      isClosed: true
    });

    store.updatePane(first.id, { columnSpan: 2, isMaximized: true }, "trace:customize");
    const repeated = store.updateRoomPaneLayout(room.id, { paneLayoutColumns: 3 }, "trace:repeat");
    expect(repeated.panes.find((pane) => pane.id === first.id)).toMatchObject({ columnSpan: 1, isMaximized: false });
  });

  it("moves panes to another room in place and resets their layout", () => {
    const store = new InMemorySpaceStore();
    const sourceRoom = store.createRoom({ name: "Source", initialPaneCount: 0 }, "trace:move-source");
    const targetRoom = store.createRoom({ name: "Target", initialPaneCount: 0 }, "trace:move-target");
    const pane = store.createPane({ roomId: sourceRoom.id, title: "Planner", mode: "CHAT", cwd: "/opt/spaceapp" }, "trace:move");
    store.updatePane(pane.id, { providerId: "codex-lb", modelId: "gpt-5.5", reasoningEffort: "high" }, "trace:move-settings");

    const moved = store.movePane(pane.id, { targetRoomId: targetRoom.id }, "trace:move");

    expect(moved.sourcePane).toMatchObject({
      id: pane.id,
      roomId: sourceRoom.id,
      title: "Planner",
      status: "IDLE",
      isClosed: false
    });
    expect(moved.targetPane).toMatchObject({
      id: pane.id,
      roomId: targetRoom.id,
      title: "Planner",
      mode: "CHAT",
      status: "IDLE",
      providerId: "codex-lb",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      cwd: "/opt/spaceapp",
      columnSpan: 1,
      isMaximized: false,
      isMinimized: false,
      isClosed: false,
      split: { parentId: null, direction: null, size: null }
    });
    expect(store.listPanes(sourceRoom.id)).toEqual([]);
    expect(store.listPanes(targetRoom.id)).toEqual([expect.objectContaining({ id: moved.targetPane.id, title: "Planner" })]);
    expect(store.listEvents(sourceRoom.id).at(-1)).toMatchObject({
      type: "PANE_UPDATED",
      paneId: null,
      payload: { move: expect.objectContaining({ targetPaneId: moved.targetPane.id, targetRoomId: targetRoom.id }) }
    });
    expect(store.listEvents(targetRoom.id).at(-1)).toMatchObject({
      type: "PANE_UPDATED",
      paneId: null,
      payload: { move: expect.objectContaining({ sourcePaneId: pane.id, sourceRoomId: sourceRoom.id }) }
    });
  });

  it("moves panes with active CLI sessions and keeps transcript appends working", () => {
    const store = new InMemorySpaceStore();
    const sourceRoom = store.createRoom({ name: "Source", initialPaneCount: 0 }, "trace:cli-source");
    const targetRoom = store.createRoom({ name: "Target", initialPaneCount: 0 }, "trace:cli-target");
    const pane = store.createPane({ roomId: sourceRoom.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/opt/spaceapp" }, "trace:cli-move");

    const session = store.createPaneCliSession({
      paneId: pane.id,
      roomId: sourceRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp"
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: sourceRoom.id,
      sequence: 0,
      stream: "stdout",
      content: "before move",
      byteLength: 11
    });

    const moved = store.movePane(pane.id, { targetRoomId: targetRoom.id }, "trace:cli-move");
    const appended = store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: sourceRoom.id,
      sequence: 1,
      stream: "stdout",
      content: "after move",
      byteLength: 10
    });

    expect(moved.targetPane).toMatchObject({ id: pane.id, roomId: targetRoom.id });
    expect(store.getActivePaneCliSession(pane.id)).toMatchObject({ sessionId: session.sessionId, roomId: targetRoom.id });
    expect(appended.roomId).toBe(targetRoom.id);
    expect(store.listPaneCliTranscriptChunks(session.sessionId)).toEqual([
      expect.objectContaining({ sequence: 0, roomId: targetRoom.id }),
      expect.objectContaining({ sequence: 1, roomId: targetRoom.id })
    ]);
  });

  it("allocates consecutive CLI transcript sequences without a caller-side history read", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Atomic transcript", initialPaneCount: 0 }, "trace:atomic-room");
    const pane = store.createPane(
      { roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/etc" },
      "trace:atomic-pane"
    );
    const session = store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "medium",
      cwd: "/etc"
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      sequence: 4,
      stream: "stdout",
      content: "existing output"
    });

    const first = store.appendPaneCliTranscriptChunkAtNextSequence({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      stream: "system",
      content: "first marker"
    });
    const second = store.appendPaneCliTranscriptChunkAtNextSequence({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      stream: "system",
      content: "second marker"
    });

    expect([first.sequence, second.sequence]).toEqual([5, 6]);
    expect(store.listPaneCliTranscriptChunks(session.sessionId).map((chunk) => chunk.sequence)).toEqual([4, 5, 6]);
  });

  it("moves panes with active browser and Space agent sessions in place", () => {
    const store = new InMemorySpaceStore();
    const sourceRoom = store.createRoom({ name: "Source", initialPaneCount: 0 }, "trace:active-source");
    const targetRoom = store.createRoom({ name: "Target", initialPaneCount: 0 }, "trace:active-target");
    const browserPane = store.createPane({ roomId: sourceRoom.id, title: "Browser", mode: "BROWSER" }, "trace:browser-pane");
    const chatPane = store.createPane({ roomId: sourceRoom.id, title: "Planner", mode: "CHAT" }, "trace:chat-pane");

    const browserSession = store.createPaneBrowserSession({
      paneId: browserPane.id,
      roomId: sourceRoom.id,
      ownerAgentId: null,
      agentNumber: 1,
      profileId: "browser-profile",
      profilePath: "/tmp/browser-profile",
      viewport: "desktop",
      targetUrl: "https://example.com/"
    });
    const agentSession = store.createSpaceAgentSession({
      paneId: chatPane.id,
      roomId: sourceRoom.id,
      title: "Planner",
      threadId: "thread:planner",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.5",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "Codex LB",
      selectedModelName: "GPT-5.5",
      selectedReasoningKey: "medium",
      selectedToolIds: ["mcp:github"]
    });
    const promptMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:prompt",
      sessionId: agentSession.sessionId,
      role: "user",
      content: "Move me to another room."
    });
    const responseMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:response",
      sessionId: agentSession.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const run = store.createSpaceAgentRun({
      sessionId: agentSession.sessionId,
      paneId: chatPane.id,
      roomId: sourceRoom.id,
      workflowId: "workflow:move-agent",
      temporalRunId: "run:move-agent",
      status: "RUNNING",
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId,
      codexThreadId: "thread:planner",
      codexTurnId: null
    });

    store.movePane(browserPane.id, { targetRoomId: targetRoom.id }, "trace:browser-move");
    store.movePane(chatPane.id, { targetRoomId: targetRoom.id }, "trace:agent-move");

    expect(store.getActivePaneBrowserSession(browserPane.id)).toMatchObject({
      sessionId: browserSession.sessionId,
      roomId: targetRoom.id
    });
    expect(store.listActivePaneBrowserSessions(targetRoom.id)).toEqual([
      expect.objectContaining({ sessionId: browserSession.sessionId, roomId: targetRoom.id })
    ]);
    expect(store.getActiveSpaceAgentSession(chatPane.id)).toMatchObject({
      sessionId: agentSession.sessionId,
      roomId: targetRoom.id
    });
    expect(store.getLatestSpaceAgentRun(agentSession.sessionId)).toMatchObject({ runId: run.runId, roomId: targetRoom.id });
    expect(store.listSpaceAgentHistory(sourceRoom.id)).toEqual([]);
    expect(store.listSpaceAgentHistory(targetRoom.id)).toEqual([
      expect.objectContaining({ sessionId: agentSession.sessionId, roomId: targetRoom.id, paneId: chatPane.id })
    ]);
  });

  it("persists browser v2 sessions, resumable captures, control leases, and handoffs", () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:test-1", email: "operator@example.com", role: "OPERATOR" });
    const room = store.createRoom({ name: "Browser v2", initialPaneCount: 0 }, "trace:browser-v2");
    const pane = store.createPane({ roomId: room.id, title: "Browser", mode: "BROWSER" }, "trace:browser-v2");
    const session = store.createPaneBrowserSession({
      paneId: pane.id,
      roomId: room.id,
      ownerAgentId: "agent:test-1",
      agentNumber: 1,
      profileId: "profile:test-1",
      profilePath: "/tmp/profile-test-1",
      viewport: "desktop",
      targetUrl: "https://example.com/",
      streamMode: "REALTIME",
      resolvedStreamMode: "REALTIME",
      runtimeState: "READY",
      pages: [
        {
          pageId: "page:test-1",
          url: "https://example.com/",
          title: "Example",
          isActive: true
        }
      ],
      activePageId: "page:test-1"
    });
    const lease = store.createBrowserControlLease({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      holderType: "OPERATOR",
      holderId: "user:test-1",
      reason: "CAPTCHA handoff",
      ttlSeconds: 30
    });
    const job = store.createBrowserCaptureJob({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "AGENT",
      requestedById: "agent:test-1",
      options: { kind: "RECORDING", maxDurationMs: 1_800_000 }
    });
    const firstSegment = store.createBrowserCaptureSegment({ jobId: job.jobId, sessionId: session.sessionId });
    const finalizedSegment = store.updateBrowserCaptureSegment(firstSegment.segmentId, {
      status: "FINALIZED",
      artifactId: "artifact:segment-1",
      storageUri: "space-artifact://browser-recordings/segment-1.webm",
      sha256: "a".repeat(64),
      byteSize: 4096,
      durationMs: 10_000,
      frameCount: 100,
      lastFrameSequence: 99
    });
    const resumedSegment = store.createBrowserCaptureSegment({ jobId: job.jobId, sessionId: session.sessionId });
    const handoff = store.createBrowserHandoffRequest({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      requestedByType: "AGENT",
      requestedById: "agent:test-1",
      reason: "CAPTCHA requires operator control."
    });
    const acceptedHandoff = store.updateBrowserHandoffRequest(handoff.handoffRequestId, {
      status: "ACCEPTED",
      operatorUserId: "user:test-1",
      operatorEmail: "operator@example.com",
      operatorRole: "OPERATOR",
      controlLeaseId: lease.leaseId
    });

    expect(session).toMatchObject({ streamMode: "REALTIME", runtimeState: "READY", activePageId: "page:test-1" });
    expect(store.getActiveBrowserControlLease(session.sessionId)).toMatchObject({ leaseId: lease.leaseId, status: "ACTIVE" });
    expect(store.getPaneBrowserSession(session.sessionId)?.controlState).toBe("OPERATOR");
    expect(finalizedSegment).toMatchObject({ status: "FINALIZED", sequence: 0, frameCount: 100 });
    expect(resumedSegment).toMatchObject({ status: "OPEN", sequence: 1, frameCount: 0 });
    expect(store.listBrowserCaptureSegments(job.jobId).map((segment) => segment.sequence)).toEqual([0, 1]);
    expect(acceptedHandoff).toMatchObject({
      status: "ACCEPTED",
      operatorUserId: "user:test-1",
      controlLeaseId: lease.leaseId,
      acceptedAt: expect.any(String)
    });
    const completedHandoff = store.updateBrowserHandoffRequest(handoff.handoffRequestId, { status: "COMPLETED" });
    expect(completedHandoff.completedAt).toEqual(expect.any(String));
    expect(() =>
      store.updateBrowserHandoffRequest(handoff.handoffRequestId, {
        status: "ACCEPTED",
        operatorUserId: "user:test-1",
        operatorEmail: "operator@example.com",
        operatorRole: "OPERATOR"
      })
    ).toThrow("Browser handoff cannot transition from COMPLETED to ACCEPTED.");
    expect(store.updateBrowserControlLease(lease.leaseId, { ttlSeconds: 60 }).heartbeatAt).not.toBeNull();
    expect(store.updateBrowserControlLease(lease.leaseId, { status: "RELEASED" }).releasedAt).not.toBeNull();
    expect(store.getPaneBrowserSession(session.sessionId)?.controlState).toBe("UNCONTROLLED");

    // A request past its TTL is EXPIRED, never reported as active; an accepted one stays while its lease is alive.
    const handoffs = (store as unknown as { browserHandoffRequests: Map<string, { expiresAt: string }> }).browserHandoffRequests;
    const backdate = (id: string) => handoffs.set(id, { ...handoffs.get(id)!, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const untaken = store.createBrowserHandoffRequest({
      sessionId: session.sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "agent:test-1", reason: "CAPTCHA nobody took."
    });
    backdate(untaken.handoffRequestId);
    expect(store.getActiveBrowserHandoffRequest(session.sessionId)).toBeNull();
    expect(store.getBrowserHandoffRequest(untaken.handoffRequestId)?.status).toBe("EXPIRED");
    const heldLease = store.createBrowserControlLease({
      sessionId: session.sessionId, paneId: pane.id, roomId: room.id, holderType: "OPERATOR", holderId: "user:test-1", reason: "Long login", ttlSeconds: 60
    });
    const held = store.createBrowserHandoffRequest({
      sessionId: session.sessionId, paneId: pane.id, roomId: room.id, requestedByType: "AGENT", requestedById: "agent:test-1", reason: "LOGIN on the phone."
    });
    store.updateBrowserHandoffRequest(held.handoffRequestId, {
      status: "ACCEPTED", operatorUserId: "user:test-1", operatorEmail: "operator@example.com", operatorRole: "OPERATOR", controlLeaseId: heldLease.leaseId
    });
    backdate(held.handoffRequestId);
    expect(store.getActiveBrowserHandoffRequest(session.sessionId)).toMatchObject({ handoffRequestId: held.handoffRequestId, status: "ACCEPTED" });
    store.updateBrowserControlLease(heldLease.leaseId, { status: "RELEASED" });
    expect(store.getActiveBrowserHandoffRequest(session.sessionId)).toBeNull();
    expect(store.getBrowserHandoffRequest(held.handoffRequestId)?.status).toBe("EXPIRED");
    expect(store.updateBrowserCaptureJob(job.jobId, { status: "RUNNING", progressPercent: 25 })).toMatchObject({
      status: "RUNNING",
      progressPercent: 25,
      startedAt: expect.any(String)
    });
    expect(store.updateBrowserCaptureJob(job.jobId, { status: "COMPLETED", artifactIds: ["artifact:test-1"] })).toMatchObject({
      status: "COMPLETED",
      progressPercent: 100,
      artifactIds: ["artifact:test-1"],
      completedAt: expect.any(String)
    });
    expect(store.listBrowserCaptureJobs(session.sessionId)).toHaveLength(1);
    expect(store.getBrowserCaptureMetrics()).toEqual({
      jobs: { QUEUED: 0, RUNNING: 0, COMPLETED: 1, FAILED: 0, CANCELLED: 0 },
      segments: { OPEN: 1, FINALIZED: 1, FAILED: 0, DISCARDED: 0 }
    });
  });

  it("persists agent pane bindings independently and cleans them with room deletion", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Agents", initialPaneCount: 2 }, "trace:agents");
    const [firstPane, secondPane] = store.listPanes(room.id);

    const firstBinding = store.upsertAgentPaneBinding({
      paneId: firstPane!.id,
      source: "CODER",
      coderChatId: "chat:first",
      status: "READY",
      title: "Planner",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "OpenAI",
      selectedModelName: "gpt-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      lastSyncedAt: "2026-06-29T00:00:00.000Z"
    });
    const secondBinding = store.upsertAgentPaneBinding({
      paneId: secondPane!.id,
      source: "CODER",
      coderChatId: "chat:second",
      status: "READY",
      title: "Reviewer",
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: null,
      lastSyncedAt: null
    });

    expect(store.getAgentPaneBinding(firstPane!.id)).toEqual(firstBinding);
    expect(store.getAgentPaneBinding(secondPane!.id)).toEqual(secondBinding);
    expect(store.listAgentPaneHistory(room.id)).toHaveLength(2);
    expect(store.updatePane(secondPane!.id, { isClosed: true, status: "CLOSED" }).isClosed).toBe(true);
    expect(store.listAgentPaneHistory(room.id).find((item) => item.paneId === secondPane!.id)?.paneIsClosed).toBe(true);
    expect(
      store.updateAgentPaneBinding(firstPane!.id, {
        status: "RUNNING",
        coderChatId: "chat:first-updated",
        selectedToolIds: ["mcp:linear"]
      })
    ).toMatchObject({
      paneId: firstPane!.id,
      status: "RUNNING",
      coderChatId: "chat:first-updated",
      selectedToolIds: ["mcp:linear"]
    });

    store.deleteRoom(room.id);

    expect(store.getAgentPaneBinding(firstPane!.id)).toBeNull();
    expect(store.getAgentPaneBinding(secondPane!.id)).toBeNull();
  });

  it("persists Space-native agent sessions, transcripts, and runs independent of pane close", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Native Agents", initialPaneCount: 2 }, "trace:agents");
    const [firstPane, secondPane] = store.listPanes(room.id);

    const firstSession = store.createSpaceAgentSession({
      paneId: firstPane!.id,
      roomId: room.id,
      title: "Planner",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-5.5",
      selectedModelConfigId: "gpt-5.5",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT-5.5",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"],
      permissionMode: "ask_for_approval",
      collaborationMode: "plan"
    });
    const secondSession = store.createSpaceAgentSession({
      paneId: secondPane!.id,
      roomId: room.id,
      title: "Builder",
      selectedProviderId: null,
      selectedModelId: null,
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null,
      selectedToolIds: null
    });
    const userMessage = store.createSpaceAgentMessage({
      sessionId: firstSession.sessionId,
      role: "user",
      content: "Keep running after I close the pane."
    });
    const assistantMessage = store.createSpaceAgentMessage({
      sessionId: firstSession.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const run = store.createSpaceAgentRun({
      sessionId: firstSession.sessionId,
      paneId: firstPane!.id,
      roomId: room.id,
      workflowId: "workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1",
      status: "RUNNING",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });

    expect(firstSession.source).toBe("SPACE");
    expect(firstSession).toMatchObject({ permissionMode: "ask_for_approval", collaborationMode: "plan" });
    expect(secondSession).toMatchObject({ permissionMode: null, collaborationMode: null });
    expect(firstSession.sessionId).not.toBe(secondSession.sessionId);
    expect(store.getActiveSpaceAgentSession(firstPane!.id)?.sessionId).toBe(firstSession.sessionId);
    expect(store.getActiveSpaceAgentSession(secondPane!.id)?.sessionId).toBe(secondSession.sessionId);
    expect(store.listSpaceAgentMessages(firstSession.sessionId).map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(store.getLatestSpaceAgentRun(firstSession.sessionId)?.runId).toBe(run.runId);
    expect(store.listEvents(room.id).filter((event) => event.type === "TURN_STARTED")).toContainEqual(
      expect.objectContaining({
        paneId: firstPane!.id,
        payload: expect.objectContaining({ runId: run.runId, sourceType: "CHAT" })
      })
    );

    expect(
      store.updateSpaceAgentSession(firstSession.sessionId, {
        permissionMode: "full_access",
        collaborationMode: "default"
      })
    ).toMatchObject({ permissionMode: "full_access", collaborationMode: "default" });

    store.updateSpaceAgentRun(run.runId, {
      status: "INTERRUPTED",
      errorCode: "INTERRUPTED",
      errorMessage: "Operator interrupted the Space agent run."
    });
    expect(
      store.listEvents(room.id).find(
        (event) => event.type === "TURN_FAILED" && event.payload.runId === run.runId
      )
    ).toMatchObject({ workflowId: null, payload: { status: "INTERRUPTED" } });

    store.updatePane(firstPane!.id, { isClosed: true, status: "CLOSED" });
    expect(store.getSpaceAgentSession(firstSession.sessionId)?.status).toBe("READY");
    expect(store.listSpaceAgentHistory(room.id).find((item) => item.sessionId === firstSession.sessionId)).toMatchObject({
      source: "SPACE",
      coderChatId: null,
      paneIsClosed: true,
      selectedToolIds: ["mcp:github"]
    });

    store.updateSpaceAgentMessage(assistantMessage.messageId, { content: "Still alive.", status: "COMPLETED" });
    store.updateSpaceAgentRun(run.runId, { status: "COMPLETED", codexThreadId: "thread:test-1", codexTurnId: "turn:test-1" });
    expect(store.listSpaceAgentMessages(firstSession.sessionId).at(-1)?.content).toBe("Still alive.");

    store.deleteRoom(room.id);
    expect(store.getSpaceAgentSession(firstSession.sessionId)).toBeNull();
  });

  it("records pane closure for running sessions without rewriting historical failures", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Close reason", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, title: "CLI", mode: "TERMINAL" });
    const identity = {
      paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex",
      agentId: "codex", modelId: null, reasoningEffort: "medium", cwd: "/etc"
    };
    const failed = store.createPaneCliSession({
      ...identity, status: "ERROR", statusReason: "Provider authentication failed.", isActive: false
    });
    const running = store.createPaneCliSession({
      ...identity, status: "RUNNING", statusReason: "CLI running.", isActive: true
    });
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
    expect(store.getPaneCliSession(running.sessionId)).toMatchObject({
      status: "EXITED", statusReason: "Pane closed by operator.", isActive: false,
      endedAt: expect.any(String)
    });
    expect(store.getPaneCliSession(failed.sessionId)).toEqual(failed);
    const exited = store.getPaneCliSession(running.sessionId);
    store.updatePane(pane.id, { isClosed: true, status: "CLOSED" });
    expect(store.getPaneCliSession(running.sessionId)).toEqual(exited);
  });

  it("persists terminal CLI sessions with bounded transcript tails", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI", initialPaneCount: 1 }, "trace:cli");
    const chatPane = store.listPanes(room.id)[0]!;
    const cliPane = store.createPane({ roomId: room.id, title: "Codex CLI", mode: "TERMINAL", cwd: "/opt/spaceapp" }, "trace:cli");
    const codexThreadId = "019f3805-9299-7b92-b70c-cd4d49b02774";
    const updatedCodexThreadId = "019f3806-9299-7b92-b70c-cd4d49b02775";

    expect(() =>
      store.createPaneCliSession({
        paneId: chatPane.id,
        roomId: room.id,
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/opt/spaceapp"
      })
    ).toThrow(SpaceConflictError);

    const firstSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/opt/spaceapp"
    });
    const secondSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.5",
      reasoningEffort: "high",
      cwd: "/opt/spaceapp",
      codexThreadId
    });

    expect(firstSession.codexThreadId).toBeNull();
    expect(secondSession.codexThreadId).toBe(codexThreadId);
    expect(store.getActivePaneCliSession(cliPane.id)?.sessionId).toBe(secondSession.sessionId);
    expect(store.getActivePaneCliSession(cliPane.id)?.codexThreadId).toBe(codexThreadId);
    expect(store.getPaneCliSession(firstSession.sessionId)?.isActive).toBe(false);
    expect(store.listPaneCliSessions(cliPane.id)).toEqual([
      expect.objectContaining({ sessionId: secondSession.sessionId }),
      expect.objectContaining({ sessionId: firstSession.sessionId })
    ]);
    expect(store.listPaneCliSessions(cliPane.id, 1)).toEqual([
      expect.objectContaining({ sessionId: secondSession.sessionId })
    ]);
    expect(store.updatePaneCliSession(secondSession.sessionId, { status: "RUNNING" })).toMatchObject({
      status: "RUNNING",
      codexThreadId
    });
    expect(store.updatePaneCliSession(secondSession.sessionId, { codexThreadId: updatedCodexThreadId })).toMatchObject({
      codexThreadId: updatedCodexThreadId
    });

    for (let index = 0; index < PANE_CLI_TRANSCRIPT_CHUNK_CAP + 5; index += 1) {
      store.appendPaneCliTranscriptChunk({
        sessionId: secondSession.sessionId,
        paneId: cliPane.id,
        roomId: room.id,
        sequence: index,
        stream: "stdout",
        content: `line ${index}`
      });
    }

    const tail = store.listPaneCliTranscriptChunks(secondSession.sessionId);
    expect(tail).toHaveLength(PANE_CLI_TRANSCRIPT_CHUNK_CAP);
    expect(tail[0]?.sequence).toBe(5);
    expect(() =>
      store.appendPaneCliTranscriptChunk({
        sessionId: secondSession.sessionId,
        paneId: cliPane.id,
        roomId: room.id,
        sequence: 999,
        stream: "stderr",
        content: "token=raw-value"
      })
    ).toThrow();
    const redactedContent = redactMemoryText("token=synthetic-proof-value");
    expect(redactedContent).toBe("token:[REDACTED]");
    expect(redactMemoryText(redactedContent)).toBe(redactedContent);
    expect(
      store.appendPaneCliTranscriptChunk({
        sessionId: secondSession.sessionId,
        paneId: cliPane.id,
        roomId: room.id,
        sequence: 999,
        stream: "stderr",
        content: redactedContent
      }).content
    ).toBe(redactedContent);

    store.updatePaneCliSession(secondSession.sessionId, { status: "EXITED", exitCode: 0, isActive: false });
    expect(store.getPaneCliSession(secondSession.sessionId)?.endedAt).toBeTruthy();

    store.deleteRoom(room.id);
    expect(store.getPaneCliSession(secondSession.sessionId)).toBeNull();
  });

  it("counts every RUNNING CLI session by room without exposing session details", () => {
    const store = new InMemorySpaceStore();
    const firstRoom = store.createRoom({ name: "First", initialPaneCount: 0 }, "trace:first");
    const secondRoom = store.createRoom({ name: "Second", initialPaneCount: 0 }, "trace:second");
    const emptyRoom = store.createRoom({ name: "Empty", initialPaneCount: 0 }, "trace:empty");
    const firstPane = store.createPane({ roomId: firstRoom.id, title: "Codex", mode: "TERMINAL" });
    const detachedPane = store.createPane({
      roomId: firstRoom.id,
      title: "OpenCode",
      mode: "TERMINAL",
      isMinimized: true
    });
    const idlePane = store.createPane({ roomId: secondRoom.id, title: "Idle", mode: "TERMINAL" });

    store.createPaneCliSession({
      paneId: firstPane.id,
      roomId: firstRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      status: "RUNNING"
    });
    store.createPaneCliSession({
      paneId: detachedPane.id,
      roomId: firstRoom.id,
      runtimeId: "cli:opencode",
      providerId: "opencode",
      agentId: "opencode",
      status: "RUNNING"
    });
    store.createPaneCliSession({
      paneId: idlePane.id,
      roomId: secondRoom.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      status: "IDLE"
    });

    expect(store.listRunningCliSessionCountsByRoom()).toEqual([
      { roomId: firstRoom.id, runningCliCount: 2, paneCount: 2, runtimeIds: ["cli:codex", "cli:opencode"] },
      { roomId: secondRoom.id, runningCliCount: 0, paneCount: 1, runtimeIds: [] },
      { roomId: emptyRoom.id, runningCliCount: 0, paneCount: 0, runtimeIds: [] }
    ]);
  });

  it("rejects duplicate active Codex thread ownership across different panes", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "CLI Owners", initialPaneCount: 0 }, "trace:cli-owners");
    const firstPane = store.createPane({ roomId: room.id, title: "CLI 1", mode: "TERMINAL", cwd: "/etc" }, "trace:cli-owners");
    const secondPane = store.createPane({ roomId: room.id, title: "CLI 2", mode: "TERMINAL", cwd: "/etc" }, "trace:cli-owners");
    const codexThreadId = "019f467b-ce39-7080-817a-891658a17a0f";

    const owner = store.createPaneCliSession({
      paneId: firstPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      codexThreadId,
      status: "RUNNING",
      isActive: true
    });
    const claimant = store.createPaneCliSession({
      paneId: secondPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: null,
      reasoningEffort: "medium",
      cwd: "/etc",
      status: "RUNNING",
      isActive: true
    });

    expect(store.getActivePaneCliSessionByCodexThreadId(codexThreadId)?.sessionId).toBe(owner.sessionId);
    expect(() =>
      store.updatePaneCliSession(claimant.sessionId, { codexThreadId })
    ).toThrow(SpaceConflictError);
    expect(() =>
      store.createPaneCliSession({
        paneId: secondPane.id,
        roomId: room.id,
        runtimeId: "cli:codex",
        providerId: "codex",
        agentId: "codex",
        modelId: null,
        reasoningEffort: "medium",
        cwd: "/etc",
        codexThreadId,
        status: "RUNNING",
        isActive: true
      })
    ).toThrow(SpaceConflictError);
  });

  it("keeps integrations fail-closed until configured", () => {
    const store = new InMemorySpaceStore();

    expect(store.getProviderSettings()).toMatchObject({ defaultProviderId: "codex-lb" });
    expect(store.listProviders().map((provider) => provider.displayName)).toEqual(
      expect.arrayContaining([
        "Space Gateway",
        "OpenAI",
        "Anthropic",
        "Local Models"
      ])
    );
    expect(store.listProviders().find((provider) => provider.id === "codex-lb")?.status).toBe("DISABLED");
    expect(store.listModels()).toHaveLength(0);
    expect(store.getMcpGatewayStatus()).toMatchObject({
      id: "mcp-gateway",
      status: "DISABLED",
      approvalMode: "DISABLED",
      serverCount: 1,
      toolCount: 0
    });
    expect(store.listMcpServers()).toEqual([
      expect.objectContaining({
        id: "mcp-gateway",
        status: "DISABLED",
        toolCount: 0
      })
    ]);
    expect(store.listMcpTools()).toEqual([]);
    const serialized = JSON.stringify(store.getMcpGatewayStatus()).toLowerCase();
    for (const fragment of ["sec" + "ret", "tok" + "en", "pass" + "word"]) {
      expect(serialized).not.toContain(fragment);
    }
  });

  it("persists global provider settings and custom provider metadata fail-closed", () => {
    const store = new InMemorySpaceStore();

    const provider = store.createProvider({
      id: "custom-route",
      displayName: "Custom Route",
      type: "CUSTOM",
      baseUrl: "https://custom.example/v1",
      routeProfile: "custom",
      backingProviderId: "openai",
      credentialRef: "/run/secrets/custom-route"
    });
    expect(provider).toMatchObject({
      id: "custom-route",
      status: "DISABLED",
      routeProfile: "custom",
      backingProviderId: "openai",
      credentialRef: "/run/secrets/custom-route",
      isBuiltIn: false
    });

    expect(store.updateProviderSettings({ defaultProviderId: "custom-route" })).toMatchObject({
      defaultProviderId: "custom-route"
    });
    store.replaceProviderModels("custom-route", [
      {
        id: "custom-route:gpt-5.4-mini",
        providerId: "custom-route",
        runtimeId: "gpt-5.4-mini",
        displayName: "GPT-5.4 Mini",
        status: "VERIFIED",
        contextWindow: 128000,
        supportsTools: false,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: true,
        defaultReasoningEffort: "low"
      }
    ]);
    expect(
      store.updateProviderSettings({
        titleGenerationModelId: "custom-route:gpt-5.4-mini",
        titleGenerationReasoningEffort: "minimal"
      })
    ).toMatchObject({
      defaultProviderId: "custom-route",
      titleGenerationModelId: "custom-route:gpt-5.4-mini",
      titleGenerationReasoningEffort: "minimal"
    });

    const updated = store.updateProvider("custom-route", {
      displayName: "Custom Route 2",
      baseUrl: "https://custom-2.example/v1"
    });
    expect(updated).toMatchObject({
      displayName: "Custom Route 2",
      baseUrl: "https://custom-2.example/v1",
      status: "DISABLED",
      maskedKeyPrefix: null
    });
    expect(() => store.updateProvider("codex-lb", { displayName: "Nope" })).toThrow("built-in");
    expect(JSON.stringify(store.listProviders())).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/);
  });

  it("surfaces configured MCP servers as disabled until discovery smoke passes", () => {
    const store = new InMemorySpaceStore({
      mcpServerConfigs: [
        {
          id: "filesystem-readonly",
          displayName: "Filesystem Readonly",
          transport: "stdio",
          command: "space-mcp-filesystem",
          args: ["--readonly"],
          enabled: true
        }
      ]
    });

    expect(store.getMcpGatewayStatus()).toMatchObject({
      status: "DISABLED",
      approvalMode: "DISABLED",
      serverCount: 1,
      toolCount: 0
    });
    expect(store.listMcpServers()).toEqual([
      expect.objectContaining({
        id: "filesystem-readonly",
        displayName: "Filesystem Readonly",
        transport: "stdio",
        status: "DISABLED",
        schemaVersion: "2025-11-25",
        toolCount: 0
      })
    ]);
    expect(store.listMcpServers()[0]?.configHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(store.listMcpTools()).toEqual([]);
  });

  it("records latest MCP discovery smoke checks durably in memory", () => {
    const store = new InMemorySpaceStore();

    expect(store.getLatestMcpDiscoverySmoke()).toBeNull();
    const check = store.recordMcpDiscoverySmoke({
      id: "mcp-gateway",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "DISABLED",
      code: "DISCOVERY_SMOKE_DISABLED",
      message: "Discovery smoke is disabled.",
      targetSpecVersion: "2025-11-25",
      discoveryEnabled: false,
      serverCount: 1,
      toolCount: 0,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });

    expect(check.checkId).toMatch(/^mcp_discovery_smoke:/);
    expect(check.checkedAt).toBe("2026-06-26T00:00:00.001Z");
    expect(store.getLatestMcpDiscoverySmoke()).toEqual(check);
    expect(JSON.stringify(check)).not.toContain("space-dev");
  });

  it("records latest memory embedding smoke checks durably in memory", () => {
    const store = new InMemorySpaceStore();

    expect(store.getLatestMemoryEmbeddingSmoke()).toBeNull();
    const check = store.recordMemoryEmbeddingSmoke({
      id: "memory-embedding-smoke",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "DISABLED",
      code: "EMBEDDING_SMOKE_DISABLED",
      message: "Memory embedding smoke is disabled.",
      smokeEnabled: false,
      provider: null,
      model: null,
      dimensions: 1536,
      pgvectorReady: false,
      embeddingProviderReady: false,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1
    });

    expect(check.checkId).toMatch(/^memory_embed_smoke:/);
    expect(check.checkedAt).toBe("2026-06-26T00:00:00.001Z");
    expect(store.getLatestMemoryEmbeddingSmoke()).toEqual(check);
    expect(JSON.stringify(check)).not.toContain("space-dev");
  });

  it("keeps semantic memory search gated unless a query embedding is supplied", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Memory Room", initialPaneCount: 0 });
    const saved = store.createMemoryEntry({
      scope: "ROOM",
      roomId: room.id,
      title: "Storage blocker",
      body: "Dedicated storage is required.",
      provenance: "operator"
    });

    expect(() => store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", searchMode: "semantic", q: "storage" })).toThrow(
      "Semantic memory search is disabled"
    );

    const entries = store.listMemoryEntries(
      { page: 1, pageSize: 25, sortOrder: "desc", searchMode: "semantic", q: "storage" },
      { semanticReady: true, queryEmbedding: [0.1, 0.2, 0.3] }
    );

    expect(entries).toEqual([saved.entry]);
  });

  it("stages explicit import candidates before creating native memory or skills", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Import Room", initialPaneCount: 0 });
    const fakeToken = "to" + "ken=raw-test-value";
    const staged = store.createImportCandidate(
      {
        sourceKind: "CODEX_MEMORY",
        targetKind: "MEMORY",
        sourceRef: `/var/lib/spaceapp-user/.codex/memories/MEMORY.md ${fakeToken}`,
        roomId: room.id,
        memoryScope: "ROOM",
        title: "Imported storage note",
        body: `Dedicated storage is required. ${fakeToken}`,
        provenance: "explicit-import-gate"
      },
      "trace:import"
    );

    expect(staged.candidate.status).toBe("PENDING");
    expect(staged.candidate.sourceRef).toContain("[REDACTED]");
    expect(staged.candidate.body).toContain("[REDACTED]");
    expect(staged.event.type).toBe("IMPORT_CANDIDATE_CREATED");
    expect(store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", roomId: room.id })).toEqual([]);

    const imported = store.decideImportCandidate(staged.candidate.id, { decision: "IMPORT", reason: "Approved" }, "trace:import");
    expect(imported.candidate.status).toBe("IMPORTED");
    expect(imported.memoryEntry?.title).toBe("Imported storage note");
    expect(imported.skill).toBeNull();
    expect(imported.events.map((event) => event.type)).toEqual(["MEMORY_SAVED", "IMPORT_CANDIDATE_DECIDED"]);
    expect(JSON.stringify(imported)).not.toContain("raw-test-value");
    expect(() => store.decideImportCandidate(staged.candidate.id, { decision: "REJECT", reason: "Already imported" })).toThrow(
      "already IMPORTED"
    );

    const skillCandidate = store.createImportCandidate({
      sourceKind: "CODEX_SKILL",
      targetKind: "SKILL",
      sourceRef: "operator-paste",
      memoryScope: "SYSTEM",
      title: "Imported Browser QA",
      body: "Capture browser proof.",
      provenance: "explicit-import-gate",
      skillVersion: "0.1.0",
      skillTriggerDescription: "Use after UI changes.",
      allowedTools: ["browser.captureScreenshot"]
    });
    const rejected = store.decideImportCandidate(skillCandidate.candidate.id, { decision: "REJECT", reason: "Needs review" });
    expect(rejected.candidate.status).toBe("REJECTED");
    expect(rejected.skill).toBeNull();
    expect(rejected.events.map((event) => event.type)).toEqual(["IMPORT_CANDIDATE_DECIDED"]);
  });

  it("records swarm control-plane tasks, locks, mailbox messages and reconciles fail-closed", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Swarm Room", initialPaneCount: 0 }, "trace:swarm-room");
    const fakeToken = "to" + "ken=raw-test-value";

    const planner = store.createSwarmTask(
      {
        roomId: room.id,
        role: "PLANNER",
        title: "Plan swarm rollout",
        goal: `Map tasks without leaking ${fakeToken}.`,
        assignee: "planner-1",
        dependsOnTaskIds: []
      },
      "trace:swarm"
    );
    const worker = store.createSwarmTask(
      {
        roomId: room.id,
        parentTaskId: planner.task.id,
        role: "WORKER",
        title: "Build task graph",
        goal: "Implement control-plane APIs.",
        assignee: "worker-1",
        dependsOnTaskIds: [planner.task.id, planner.task.id]
      },
      "trace:swarm"
    );
    expect(worker.task.dependsOnTaskIds).toEqual([planner.task.id]);
    expect(worker.event.type).toBe("SWARM_TASK_CREATED");
    expect(JSON.stringify(worker)).not.toContain("raw-test-value");

    const lock = store.claimSwarmLock(
      {
        roomId: room.id,
        taskId: worker.task.id,
        resource: "/opt/spaceapp",
        holder: "worker-1",
        reason: "Avoid concurrent writes."
      },
      "trace:swarm"
    );
    expect(lock.lock.status).toBe("ACTIVE");
    expect(lock.event.type).toBe("SWARM_LOCK_CLAIMED");
    expect(() =>
      store.claimSwarmLock({
        roomId: room.id,
        taskId: worker.task.id,
        resource: "/opt/spaceapp",
        holder: "reviewer-1",
        reason: "Conflicting write."
      })
    ).toThrow(SpaceConflictError);

    const updated = store.updateSwarmTask(
      worker.task.id,
      {
        status: "RUNNING",
        lockIds: [lock.lock.id],
        resultSummary: `Work started with ${fakeToken}.`
      },
      "trace:swarm"
    );
    expect(updated.task.lockIds).toEqual([lock.lock.id]);
    expect(updated.task.resultSummary).toContain("[REDACTED]");
    expect(updated.event.type).toBe("SWARM_TASK_UPDATED");

    const message = store.postSwarmMessage(
      {
        roomId: room.id,
        taskId: worker.task.id,
        fromRole: "WORKER",
        toRole: "REVIEWER",
        body: `Ready for review. ${fakeToken}`
      },
      "trace:swarm"
    );
    expect(message.message.body).toContain("[REDACTED]");
    expect(message.event.type).toBe("SWARM_MESSAGE_POSTED");

    const release = store.releaseSwarmLock(lock.lock.id, { reason: `Done ${fakeToken}.` }, "trace:swarm");
    expect(release.lock.status).toBe("RELEASED");
    expect(release.event.type).toBe("SWARM_LOCK_RELEASED");
    expect(JSON.stringify(release)).not.toContain("raw-test-value");

    const done = store.updateSwarmTask(worker.task.id, { status: "DONE", resultSummary: "Task graph complete." }, "trace:swarm");
    expect(done.task.completedAt).toBeTruthy();

    const reconcile = store.createSwarmReconcile(
      {
        roomId: room.id,
        taskIds: [planner.task.id, worker.task.id],
        decision: "MERGED",
        summary: "Planner and worker outputs reconciled.",
        nextSteps: "Move to Review Room."
      },
      "trace:swarm"
    );
    expect(reconcile.reconcile.decision).toBe("MERGED");
    expect(reconcile.event.type).toBe("SWARM_RECONCILED");

    const state = store.getSwarmState(room.id);
    expect(state).toMatchObject({
      executionStatus: "DISABLED",
      statusReason: expect.stringContaining("control-plane only")
    });
    expect(state.tasks).toHaveLength(2);
    expect(state.locks.map((item) => item.status)).toEqual(["RELEASED"]);
    expect(state.messages).toHaveLength(1);
    expect(state.reconciles).toHaveLength(1);
    expect(store.listEvents(room.id).map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "SWARM_TASK_CREATED",
        "SWARM_TASK_UPDATED",
        "SWARM_LOCK_CLAIMED",
        "SWARM_LOCK_RELEASED",
        "SWARM_MESSAGE_POSTED",
        "SWARM_RECONCILED"
      ])
    );
  });

  it("reports vector readiness as disabled for the in-memory store", () => {
    const store = new InMemorySpaceStore();

    const readiness = store.getMemoryVectorReadiness(1536);

    expect(readiness).toMatchObject({
      id: "memory-vector-readiness",
      status: "DISABLED",
      code: "VECTOR_STORE_NOT_POSTGRES",
      runtimeStore: "memory",
      extensionInstalled: false,
      embeddingColumnReady: false,
      embeddingDimensions: null,
      expectedDimensions: 1536,
      vectorIndexReady: false
    });
  });

  it("records discovered MCP metadata while keeping execution approval disabled", () => {
    const store = new InMemorySpaceStore();
    const record = store.recordMcpDiscoveryCatalog({
      discoveredAt: "2026-06-26T00:00:00.000Z",
      servers: [
        {
          id: "filesystem-readonly",
          displayName: "Filesystem Readonly",
          transport: "stdio",
          status: "VERIFIED",
          statusReason: "Discovery metadata captured; execution remains disabled.",
          schemaVersion: "2025-11-25",
          configHash: "sha256:test-config",
          toolCount: 0,
          lastDiscoveredAt: null
        }
      ],
      tools: [
        {
          id: "filesystem-readonly:list",
          serverId: "filesystem-readonly",
          name: "list",
          riskLevel: "R1",
          schemaHash: "sha256:test-schema",
          approvalRequired: true,
          status: "VERIFIED",
          statusReason: "Schema metadata captured; execution remains disabled."
        }
      ]
    });

    expect(record.gatewayStatus).toMatchObject({
      status: "VERIFIED",
      approvalMode: "DISABLED",
      serverCount: 1,
      toolCount: 1,
      lastDiscoveryAt: "2026-06-26T00:00:00.000Z"
    });
    expect(store.listMcpServers()[0]).toMatchObject({ id: "filesystem-readonly", toolCount: 1 });
    expect(store.listMcpTools()).toEqual([
      expect.objectContaining({ id: "filesystem-readonly:list", approvalRequired: true })
    ]);
    expect(store.listCapabilities().filter((capability) => capability.kind === "MCP_TOOL")).toEqual([
      expect.objectContaining({ id: "filesystem-readonly:list", requiresApproval: true })
    ]);
  });

  it("records latest provider validation without enabling the provider", () => {
    const store = new InMemorySpaceStore();

    expect(store.getLatestProviderValidation("codex-lb")).toBeNull();
    const result = store.recordProviderValidation({
      providerId: "codex-lb",
      status: "DISABLED",
      code: "MISSING_CONFIG",
      statusReason: "Missing config.",
      checkedAt: "2026-06-26T00:00:00.000Z",
      maskedKeyPrefix: null,
      credentialLabel: null,
      modelCount: null
    });

    expect(result.code).toBe("MISSING_CONFIG");
    expect(store.getLatestProviderValidation("codex-lb")).toEqual(result);
    expect(store.listProviders().find((provider) => provider.id === "codex-lb")?.status).toBe("DISABLED");
  });

  it("replaces verified provider models without touching other provider catalog rows", () => {
    const store = new InMemorySpaceStore();

    store.recordProviderValidation({
      providerId: "codex-lb",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Credential smoke passed.",
      checkedAt: "2026-06-26T00:00:00.000Z",
      maskedKeyPrefix: "sk-c...207",
      credentialLabel: "space-dev",
      modelCount: 1
    });
    const models = store.replaceProviderModels("codex-lb", [
      {
        id: "gpt-test",
        providerId: "codex-lb",
        displayName: "gpt-test",
        status: "VERIFIED",
        contextWindow: null,
        supportsTools: false,
        supportsVision: false,
        supportsRealtime: false,
        supportsReasoning: false,
        defaultReasoningEffort: null
      }
    ]);

    expect(store.listProviders().find((provider) => provider.id === "codex-lb")).toMatchObject({
      status: "VERIFIED",
      maskedKeyPrefix: "sk-c...207"
    });
    expect(models).toHaveLength(1);
    expect(store.listModels()).toEqual([expect.objectContaining({ id: "gpt-test", providerId: "codex-lb" })]);
  });

  it("saves searchable memory entries with redaction and durable events", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Memory", initialPaneCount: 0 }, "trace:room");

    const saved = store.createMemoryEntry(
      {
        scope: "ROOM",
        roomId: room.id,
        title: "Storage blocker",
        body: "Dedicated storage is required. api_key=raw-test-value must not persist.",
        provenance: "operator note"
      },
      "trace:memory"
    );
    store.createMemoryEntry(
      {
        scope: "PROJECT",
        title: "Provider policy",
        body: "Providers stay fail-closed until smoke passes.",
        provenance: "blueprint"
      },
      "trace:project"
    );

    expect(saved.entry.id).toMatch(/^memory:/);
    expect(saved.entry.body).toContain("[REDACTED]");
    expect(saved.entry.body).not.toContain("raw-test-value");
    expect(saved.event).toMatchObject({
      roomId: room.id,
      type: "MEMORY_SAVED",
      payload: { memoryId: saved.entry.id, scope: "ROOM" }
    });
    expect(store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", q: "storage" })).toEqual([saved.entry]);
    expect(store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", scope: "PROJECT" })).toEqual([
      expect.objectContaining({ title: "Provider policy", roomId: null })
    ]);
    expect(store.listMemoryEntries(
      { page: 1, pageSize: 25, sortOrder: "desc" },
      { limit: 1 }
    )).toHaveLength(1);
    expect(() =>
      store.listMemoryEntries({ page: 1, pageSize: 25, sortOrder: "desc", q: "storage", searchMode: "semantic" })
    ).toThrow(SpaceFeatureDisabledError);
    expect(store.listCapabilities()).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "memory-registry", kind: "MEMORY_SCOPE", status: "VERIFIED" })])
    );
  });

  it("records skill proposals as disabled catalog entries with durable events", () => {
    const store = new InMemorySpaceStore();

    const record = store.createSkillProposal(
      {
        displayName: "Browser QA",
        version: "0.1.0",
        triggerDescription: "Use after UI changes.",
        body: "Capture browser evidence. token=raw-test-value must not persist.",
        allowedTools: ["browser.captureScreenshot", "browser.collectConsole", "browser.captureScreenshot"]
      },
      "trace:skill"
    );

    expect(record.skill.id).toMatch(/^skill:/);
    expect(record.skill.status).toBe("DISABLED");
    expect(record.skill.source).toBe("OPERATOR_PROPOSAL");
    expect(record.skill.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(record.skill.allowedTools).toEqual(["browser.captureScreenshot", "browser.collectConsole"]);
    expect(record.skill.body).toContain("[REDACTED]");
    expect(JSON.stringify(record.skill)).not.toContain("raw-test-value");
    expect(record.event).toMatchObject({
      type: "SKILL_PROPOSED",
      payload: { skillId: record.skill.id, status: "DISABLED", allowedToolCount: 2 }
    });
    expect(store.listSkills()[0]).toEqual(record.skill);
  });

  it("discovers read-only Codex filesystem skills without installing session-local copies", () => {
    const root = mkdtempSync(join(tmpdir(), "space-skill-roots-"));
    const coreDir = join(root, "core", "browser-testing-with-devtools");
    const pluginRoot = join(root, "plugins");
    const pluginDir = join(pluginRoot, "oll4-codex-controls", "0.1.0", "skills", "oll4-codex-controls");
    try {
      mkdirSync(coreDir, { recursive: true });
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(
        join(coreDir, "SKILL.md"),
        [
          "---",
          "name: browser-testing-with-devtools",
          `description: Tests in real browsers via Chrome DevTools on ${"VM"}${"207"}.`,
          "---",
          "",
          "# Browser Testing",
          "",
          "Do browser proof without leaking token=raw-test-value.",
          `Avoid exposing ${"VM"}${"207"} or https://192.0.2.${"207"} in Space skill output.`
        ].join("\n")
      );
      writeFileSync(
        join(pluginDir, "SKILL.md"),
        [
          "---",
          "name: oll4-codex-controls",
          "description: Space Codex app controls.",
          "---",
          "",
          "# OLL4 Codex Controls"
        ].join("\n")
      );

      const store = new InMemorySpaceStore({
        codexSkillRoots: [join(root, "core")],
        codexPluginSkillRoots: [pluginRoot]
      });
      const skills = store.listSkills();
      const browserSkill = skills.find((skill) => skill.id === "browser-testing-with-devtools");
      const pluginSkill = skills.find((skill) => skill.id === "oll4-codex-controls:oll4-codex-controls");

      expect(browserSkill).toMatchObject({
        displayName: "Browser Testing With Devtools",
        source: "CODEX_SKILL",
        status: "VERIFIED",
        triggerDescription: "Tests in real browsers via Chrome DevTools on Space host."
      });
      expect(browserSkill?.body).toContain("[REDACTED]");
      expect(browserSkill?.body).not.toContain("raw-test-value");
      expect(JSON.stringify(browserSkill)).not.toMatch(new RegExp(`${"vm"}${"207"}|10\\.100\\.0\\.${"207"}`, "i"));
      expect(pluginSkill).toMatchObject({
        displayName: "Oll4 Codex Controls",
        source: "CODEX_SKILL",
        status: "VERIFIED"
      });
      expect(skills.find((skill) => skill.id === "planning")).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps Space default MCP servers visible as disabled metadata", () => {
    const store = new InMemorySpaceStore({
      mcpServerConfigs: [
        {
          id: "space-readonly",
          displayName: "Space readonly",
          transport: "stdio",
          command: "/usr/local/bin/node",
          args: ["/opt/spaceapp/scripts/space-readonly-mcp.mjs"],
          enabled: true
        }
      ]
    });

    const servers = store.listMcpServers();
    expect(servers.map((server) => server.id)).toEqual(
      expect.arrayContaining(["space-readonly", "space_capturelab", "devtools", "olla", "space_summary_tools"])
    );
    expect(servers.find((server) => server.id === "devtools")).toMatchObject({
      status: "DISABLED",
      statusReason: expect.stringContaining("metadata")
    });
    expect(store.listMcpTools().some((tool) => tool.serverId === "devtools")).toBe(false);
  });

  it("records latest Codex App Server handshake without enabling Codex execution", () => {
    const store = new InMemorySpaceStore();

    expect(store.getLatestCodexAppServerHandshake()).toBeNull();
    const result = store.recordCodexAppServerHandshake({
      id: "codex-app-server",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "DISABLED",
      code: "ADAPTER_DISABLED",
      message: "Adapter disabled.",
      transport: "stdio",
      schemasGenerated: false,
      schemaManifest: null,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1,
      serverInfo: null
    });

    expect(result.checkId).toMatch(/^codex_handshake:/);
    expect(result.checkedAt).toBe(result.finishedAt);
    expect(store.getLatestCodexAppServerHandshake()).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("space-dev");
  });

  it("records latest Codex App Server turn smoke without storing prompt content", () => {
    const store = new InMemorySpaceStore();

    expect(store.getLatestCodexAppServerTurnSmoke()).toBeNull();
    const result = store.recordCodexAppServerTurnSmoke({
      id: "codex-app-server",
      actorUserId: "user:test-1",
      traceId: "req:test-1",
      status: "ERROR",
      code: "TURN_SMOKE_NOT_ENABLED",
      message: "Real turn smoke is not enabled.",
      transport: "stdio",
      schemasGenerated: true,
      schemaManifest: null,
      model: null,
      startedAt: "2026-06-26T00:00:00.000Z",
      finishedAt: "2026-06-26T00:00:00.001Z",
      durationMs: 1,
      threadId: null,
      turnId: null,
      turnStatus: null,
      notificationCount: 0,
      completedNotificationSeen: false
    });

    expect(result.checkId).toMatch(/^codex_turn_smoke:/);
    expect(result.checkedAt).toBe(result.finishedAt);
    expect(store.getLatestCodexAppServerTurnSmoke()).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("Reply with exactly");
  });

  it("persists queued turns, workflows, pane status, and replayable events", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Turns", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;

    const queued = store.recordTurnQueued({
      roomId: room.id,
      paneId: pane.id,
      workflowId: "workflow:dummy:test-1",
      runId: "run:test-1",
      taskQueue: "space-agent-turns",
      traceId: "trace:turn-1",
      prompt: "hello durable world",
      providerId: null,
      modelId: null
    });

    expect(queued.turn.status).toBe("QUEUED");
    expect(queued.workflow.status).toBe("PENDING");
    const startedWorkflow = store.recordWorkflowRunId(queued.workflow.workflowId, "run:test-1b");
    expect(startedWorkflow.runId).toBe("run:test-1b");
    expect(queued.event.type).toBe("TURN_STARTED");
    expect(store.listTurns(room.id)).toEqual([queued.turn]);
    expect(store.listPanes(room.id)[0]?.status).toBe("QUEUED");
    expect(store.listEvents(room.id).at(-1)).toMatchObject({
      turnId: queued.turn.id,
      workflowId: queued.workflow.workflowId,
      type: "TURN_STARTED"
    });

    const completed = store.recordTurnCompleted({
      workflowId: queued.workflow.workflowId,
      traceId: "trace:turn-1",
      message: "Dummy Temporal turn completed.",
      metadata: {
        codexAppServer: {
          threadId: "thread:test-1",
          turnId: "turn:test-1"
        }
      }
    });

    expect(completed.turn.status).toBe("COMPLETED");
    expect(completed.workflow.status).toBe("COMPLETED");
    expect(completed.workflow.closedAt).toBeTruthy();
    expect(completed.event.type).toBe("TURN_COMPLETED");
    expect(completed.event.payload).toMatchObject({
      metadata: {
        codexAppServer: {
          threadId: "thread:test-1",
          turnId: "turn:test-1"
        }
      }
    });
    expect(store.listTurns(room.id)[0]).toMatchObject({ id: queued.turn.id, status: "COMPLETED" });
    expect(store.listPanes(room.id)[0]?.status).toBe("COMPLETE");

    const failedQueued = store.recordTurnQueued({
      roomId: room.id,
      paneId: pane.id,
      workflowId: "workflow:codex-app-server:test-2",
      runId: "run:test-2",
      taskQueue: "space-agent-turns",
      traceId: "trace:turn-2",
      prompt: "hello fail closed",
      runtime: "CODEX_APP_SERVER",
      providerId: null,
      modelId: null
    });
    const failed = store.recordTurnFailed({
      workflowId: failedQueued.workflow.workflowId,
      traceId: "trace:turn-2",
      message: "Codex App Server real turn workflow is not implemented yet.",
      reasonCode: "CODEX_APP_SERVER_NOT_IMPLEMENTED",
      metadata: {
        codexAppServer: {
          threadId: null,
          turnId: null,
          notificationCount: 0
        }
      }
    });

    expect(failed.turn.status).toBe("FAILED");
    expect(failed.workflow.status).toBe("FAILED");
    expect(failed.workflow.closedAt).toBeTruthy();
    expect(failed.event.type).toBe("TURN_FAILED");
    expect(failed.event.payload).toMatchObject({
      status: "FAILED",
      reasonCode: "CODEX_APP_SERVER_NOT_IMPLEMENTED",
      metadata: {
        codexAppServer: {
          threadId: null,
          turnId: null,
          notificationCount: 0
        }
      }
    });
    expect(store.listTurns(room.id).find((turn) => turn.id === failedQueued.turn.id)).toMatchObject({
      id: failedQueued.turn.id,
      status: "FAILED"
    });
    expect(store.listPanes(room.id)[0]?.status).toBe("ERROR");
  });

  it("records review decisions with redaction and durable room events", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Review", initialPaneCount: 0 }, "trace:room");
    const fakeToken = "to" + "ken=raw-test-value";
    const fakeApiKey = "api" + "_key=raw-test-value";
    const record = store.createReviewDecision(
      {
        roomId: room.id,
        workflowId: "workflow:test-1",
        decision: "BLOCK",
        summary: `Tests failed. ${fakeToken} must not persist.`,
        evidenceArtifactIds: ["artifact:test-1", "artifact:test-1"],
        rollbackNote: `Revert commit ${fakeApiKey}.`
      },
      "trace:review"
    );

    expect(record.decision.id).toMatch(/^review:/);
    expect(record.decision.summary).toContain("[REDACTED]");
    expect(record.decision.rollbackNote).toContain("[REDACTED]");
    expect(record.decision.evidenceArtifactIds).toEqual(["artifact:test-1"]);
    expect(record.event).toMatchObject({
      roomId: room.id,
      workflowId: "workflow:test-1",
      type: "REVIEW_DECISION_CREATED",
      payload: { reviewDecisionId: record.decision.id, decision: "BLOCK", evidenceArtifactCount: 1 }
    });
    expect(store.listReviewDecisions({ page: 1, pageSize: 25, sortOrder: "desc", roomId: room.id })).toEqual([record.decision]);
    expect(store.listReviewDecisions({ page: 1, pageSize: 25, sortOrder: "asc", roomId: room.id })).toEqual([record.decision]);
  });

  it("persists immutable memory change sets with guarded transitions and rollback linkage", () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const baseInput = {
      kind: "EDIT" as const,
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      recordIds: ["memory_graph_record:first"],
      resolvesIssueIds: ["memory_graph_issue:stale"],
      expectedSourceHash: "a".repeat(64),
      beforeContentHash: hashMemorySnapshot("before\n"),
      afterContentHash: hashMemorySnapshot("after\n"),
      beforeSnapshot: "before\n",
      afterSnapshot: "after\n",
      reason: "Remove stale wording. token=raw-test-value",
      actorUserId: "user:operator"
    };

    const proposed = store.createMemoryChangeSet(baseInput, "trace:memory-change");
    expect(proposed).toMatchObject({
      kind: "EDIT",
      status: "PROPOSED",
      resultingSourceHash: null,
      rollbackOfChangeSetId: null,
      rolledBackByChangeSetId: null,
      traceId: "trace:memory-change"
    });
    expect(proposed.reason).toContain("[REDACTED]");
    expect(proposed.beforeSnapshot).toBe("before\n");
    const stableStore = new InMemorySpaceStore();
    stableStore.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const stable = stableStore.createMemoryChangeSet(baseInput, "trace:stable", { id: "memory_change:stable-create" });
    expect(stable.id).toBe("memory_change:stable-create");
    expect(stableStore.createMemoryChangeSet(baseInput, "trace:retry", { id: stable.id })).toEqual(stable);
    expect(() => stableStore.createMemoryChangeSet(
      { ...baseInput, reason: "A different request." },
      "trace:collision",
      { id: stable.id }
    )).toThrow(SpaceConflictError);
    expect(() => store.createMemoryChangeSet({ ...baseInput, afterSnapshot: "tampered\n" })).toThrow(SpaceConflictError);
    expect(() => store.updateMemoryChangeSet(proposed.id, { status: "APPLIED", resultingSourceHash: "d".repeat(64) })).toThrow(
      SpaceConflictError
    );
    expect(() =>
      store.updateMemoryChangeSet(proposed.id, {
        status: "APPROVED",
        expectedSourceHash: "e".repeat(64)
      } as never)
    ).toThrow();
    expect(() =>
      store.createMemoryChangeSet({
        ...baseInput,
        kind: "ROLLBACK",
        rollbackOfChangeSetId: proposed.id,
        expectedSourceHash: "d".repeat(64),
        beforeContentHash: baseInput.afterContentHash,
        afterContentHash: baseInput.beforeContentHash,
        beforeSnapshot: baseInput.afterSnapshot,
        afterSnapshot: baseInput.beforeSnapshot,
        reason: "A proposed operation must not be rollback-eligible."
      })
    ).toThrow(SpaceConflictError);

    store.updateMemoryChangeSet(proposed.id, { status: "APPROVED" });
    store.updateMemoryChangeSet(proposed.id, { status: "APPLYING" });
    const applied = store.updateMemoryChangeSet(proposed.id, { status: "APPLIED", resultingSourceHash: "d".repeat(64) });
    expect(applied).toMatchObject({ status: "APPLIED", resultingSourceHash: "d".repeat(64) });

    expect(() =>
      store.createMemoryChangeSet({
        ...baseInput,
        kind: "ROLLBACK",
        rollbackOfChangeSetId: proposed.id,
        expectedSourceHash: "d".repeat(64),
        beforeContentHash: baseInput.afterContentHash,
        afterContentHash: hashMemorySnapshot("different before\n"),
        beforeSnapshot: baseInput.afterSnapshot,
        afterSnapshot: "different before\n",
        reason: "A rollback must exactly mirror the target snapshots."
      })
    ).toThrow(SpaceConflictError);

    expect(() =>
      store.createMemoryChangeSet({
        ...baseInput,
        kind: "ROLLBACK",
        rollbackOfChangeSetId: "memory_change:missing",
        beforeContentHash: baseInput.afterContentHash,
        afterContentHash: baseInput.beforeContentHash,
        beforeSnapshot: baseInput.afterSnapshot,
        afterSnapshot: baseInput.beforeSnapshot,
        reason: "Rollback a missing operation."
      })
    ).toThrow();

    const rollback = store.createMemoryChangeSet({
      ...baseInput,
      kind: "ROLLBACK",
      rollbackOfChangeSetId: proposed.id,
      expectedSourceHash: "d".repeat(64),
      beforeContentHash: baseInput.afterContentHash,
      afterContentHash: baseInput.beforeContentHash,
      beforeSnapshot: baseInput.afterSnapshot,
      afterSnapshot: baseInput.beforeSnapshot,
      reason: "Restore the audited before snapshot."
    });
    store.updateMemoryChangeSet(rollback.id, { status: "APPROVED" });
    store.updateMemoryChangeSet(rollback.id, { status: "APPLYING" });
    const appliedRollback = store.updateMemoryChangeSet(rollback.id, {
      status: "APPLIED",
      resultingSourceHash: proposed.expectedSourceHash
    });

    expect(appliedRollback.status).toBe("APPLIED");
    expect(store.listMemoryChangeSets({ status: "ROLLED_BACK", page: 1, pageSize: 25, sortOrder: "desc" })).toEqual([
      expect.objectContaining({ id: proposed.id, rolledBackByChangeSetId: rollback.id })
    ]);
    expect(
      store.listMemoryChangeSets({ issueId: "memory_graph_issue:stale", page: 1, pageSize: 25, sortOrder: "desc" })
    ).toHaveLength(2);
    expect(
      store.listMemoryChangeSets({ rollbackOfChangeSetId: proposed.id, page: 1, pageSize: 25, sortOrder: "desc" })
    ).toEqual([expect.objectContaining({ id: rollback.id })]);
    expect(store.listMemoryChangeSets()[0]).not.toHaveProperty("beforeSnapshot");
  });

  it("links cache records to one canonical memory idempotently and rejects silent relinking", () => {
    const store = new InMemorySpaceStore();
    const cached = store.createMemoryEntry({
      scope: "SYSTEM",
      title: "Canonical cache row",
      body: "Cached body",
      provenance: "memory-graph-test"
    }).entry;
    const input = {
      memoryRecordId: cached.id,
      canonicalMemoryId: "memory:canonical-record",
      linkSource: "EXACT_BACKFILL" as const
    };

    const linked = store.linkMemoryCacheRecord(input);
    expect(store.linkMemoryCacheRecord(input)).toEqual(linked);
    expect(store.getMemoryCacheLink(cached.id)).toEqual(linked);
    expect(store.listMemoryCacheLinks({ memoryRecordIds: [cached.id], limit: 1 })).toEqual([linked]);
    expect(store.listMemoryCacheLinks({ memoryRecordIds: ["memory:not-selected"], limit: 1 })).toEqual([]);
    expect(() => store.linkMemoryCacheRecord({
      ...input,
      canonicalMemoryId: "memory:different-record",
      linkSource: "REPAIR"
    })).toThrow(SpaceConflictError);
  });

  it("persists issue status overlays with optimistic version guards", () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const base = {
      issueId: "memory_issue:duplicate",
      issueType: "EXACT_DUPLICATE" as const,
      recordId: "memory:canonical-record",
      sourceHash: "a".repeat(64),
      status: "IGNORED" as const,
      reason: "Reviewed duplicate.",
      actorUserId: "user:operator"
    };

    const ignored = store.upsertMemoryIssueState(base);
    expect(ignored).toMatchObject({ status: "IGNORED", version: 1 });
    const resolved = store.upsertMemoryIssueState({ ...base, status: "RESOLVED", expectedVersion: 1 });
    expect(resolved).toMatchObject({ status: "RESOLVED", version: 2 });
    expect(() => store.upsertMemoryIssueState({ ...base, status: "OPEN", expectedVersion: 1 })).toThrow(SpaceConflictError);
    expect(store.listMemoryIssueStates({ status: "RESOLVED", page: 1, pageSize: 25, sortOrder: "desc" })).toEqual([resolved]);
    expect(store.listMemoryIssueStates({
      issueIds: [resolved.issueId],
      page: 1,
      pageSize: 500,
      sortOrder: "desc"
    })).toEqual([resolved]);
    expect(store.listMemoryIssueStates({
      issueIds: ["memory_issue:not-selected"],
      page: 1,
      pageSize: 500,
      sortOrder: "desc"
    })).toEqual([]);
  });

  it("guards consolidation run, finding and operation state transitions", () => {
    const store = new InMemorySpaceStore();
    store.upsertUser({ id: "user:operator", email: "operator@example.com", role: "OPERATOR" });
    const run = store.createMemoryConsolidationRun({
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      workflowId: "workflow:memory-consolidation-1",
      dedupeKey: "operator:memory-consolidation-1",
      actorUserId: "user:operator",
      sourceHash: "a".repeat(64)
    });
    expect(store.createMemoryConsolidationRun({
      mode: "AUDIT",
      triggerKind: "OPERATOR",
      workflowId: "workflow:memory-consolidation-1",
      dedupeKey: "operator:memory-consolidation-1",
      actorUserId: "user:operator",
      sourceHash: "a".repeat(64)
    })).toEqual(run);
    expect(() => store.updateMemoryConsolidationRun(run.id, { status: "SUCCEEDED" })).toThrow(SpaceConflictError);

    store.updateMemoryConsolidationRun(run.id, { status: "RUNNING", progressCompleted: 0, progressTotal: 1 });
    const finding = store.createMemoryConsolidationFinding({
      runId: run.id,
      issueId: "memory_issue:duplicate",
      findingType: "EXACT_DUPLICATE",
      severity: "WARN",
      confidence: 1,
      recordIds: ["memory:canonical-record"],
      sourcePath: "/opt/spaceapp/docs/gemini_history_2026-07.md",
      evidence: "Exact content hashes match."
    });
    const operation = store.createMemoryConsolidationOperation({
      runId: run.id,
      findingId: finding.id,
      operationKind: "REPORT_ISSUE",
      recordIds: ["memory:canonical-record"],
      reason: "Retain the finding for operator review."
    });
    expect(() => store.updateMemoryConsolidationOperation(operation.id, { status: "APPLIED" })).toThrow(SpaceConflictError);
    store.updateMemoryConsolidationOperation(operation.id, { status: "APPLYING" });
    const applied = store.updateMemoryConsolidationOperation(operation.id, { status: "APPLIED" });
    store.updateMemoryConsolidationFinding(finding.id, { status: "APPLIED" });
    const succeeded = store.updateMemoryConsolidationRun(run.id, {
      status: "SUCCEEDED",
      progressCompleted: 1,
      progressTotal: 1,
      findingCount: 1,
      appliedOperationCount: 1
    });

    expect(applied.status).toBe("APPLIED");
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(store.listMemoryConsolidationFindings(run.id)).toHaveLength(1);
    expect(store.listMemoryConsolidationOperations(run.id)).toHaveLength(1);
  });

  it("returns the original resource for an identical command retry and rejects payload drift", () => {
    const store = new InMemorySpaceStore();
    const input = {
      commandScope: "memory.consolidation.create",
      actorKey: "user:operator",
      idempotencyKeyHash: "a".repeat(64),
      requestHash: "b".repeat(64),
      resourceType: "memory_consolidation",
      resourceId: "memory_consolidation:run-1",
      workflowId: "workflow:memory-consolidation-1"
    };

    const claimed = store.claimMemoryCommand(input);
    expect(claimed.created).toBe(true);
    expect(store.claimMemoryCommand(input)).toEqual({ record: claimed.record, created: false });
    expect(() => store.claimMemoryCommand({ ...input, requestHash: "c".repeat(64) })).toThrow(SpaceConflictError);
  });

  it("records review checks and diff summaries as durable aggregation inputs", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Review aggregation", initialPaneCount: 0 }, "trace:room");
    const fakeToken = "to" + "ken=raw-test-value";
    const fakeSecret = "sec" + "ret=raw-test-value";
    const decision = store.createReviewDecision({
      roomId: room.id,
      decision: "NEEDS_HUMAN",
      summary: "Review pending.",
      evidenceArtifactIds: [],
      rollbackNote: ""
    });

    const check = store.createReviewCheck(
      {
        roomId: room.id,
        reviewDecisionId: decision.decision.id,
        name: "npm test",
        status: "PASS",
        command: `npm test ${fakeToken}`,
        summary: `All tests passed. ${fakeSecret}`,
        artifactIds: ["artifact:test-1", "artifact:test-1"],
        metadata: { suite: "unit", token: fakeToken }
      },
      "trace:review"
    );
    expect(check.check.id).toMatch(/^review_check:/);
    expect(check.check.command).toContain("[REDACTED]");
    expect(check.check.summary).toContain("[REDACTED]");
    expect(JSON.stringify(check.check.metadata)).not.toContain("raw-test-value");
    expect(check.check.artifactIds).toEqual(["artifact:test-1"]);
    expect(check.event).toMatchObject({
      roomId: room.id,
      type: "REVIEW_CHECK_RECORDED",
      payload: { reviewCheckId: check.check.id, status: "PASS", artifactCount: 1 }
    });

    const diff = store.createReviewDiffSummary(
      {
        roomId: room.id,
        reviewDecisionId: decision.decision.id,
        title: `Review UI ${fakeSecret}`,
        filePath: "apps/web/src/App.tsx",
        status: "MODIFIED",
        additions: 42,
        deletions: 7,
        patchArtifactId: "artifact:test-1",
        summary: `Adds aggregation ${fakeToken}.`
      },
      "trace:review"
    );
    expect(diff.diff.id).toMatch(/^review_diff:/);
    expect(diff.diff.title).toContain("[REDACTED]");
    expect(diff.diff.summary).toContain("[REDACTED]");
    expect(diff.event).toMatchObject({
      roomId: room.id,
      type: "REVIEW_DIFF_RECORDED",
      payload: { reviewDiffId: diff.diff.id, status: "MODIFIED", additions: 42, deletions: 7 }
    });
    expect(store.listReviewChecks({ roomId: room.id, status: "PASS", page: 1, pageSize: 25, sortOrder: "desc" })).toEqual([
      check.check
    ]);
    expect(store.listReviewDiffSummaries({ roomId: room.id, status: "MODIFIED", page: 1, pageSize: 25, sortOrder: "desc" })).toEqual([
      diff.diff
    ]);
  });

  it("registers artifact metadata with redaction and durable room events", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Evidence", initialPaneCount: 0 }, "trace:room");
    const fakeSensitive = "to" + "ken=raw-test-value";
    const record = store.createArtifact(
      {
        roomId: room.id,
        paneId: null,
        turnId: null,
        workflowId: "workflow:test-1",
        kind: "SCREENSHOT",
        mimeType: "image/png",
        storageUri: `cas://sha256/${"a".repeat(64)}?${fakeSensitive}`,
        sha256: "a".repeat(64),
        byteSize: 2048,
        metadata: { viewport: "1440x900", ["sec" + "ret"]: fakeSensitive, nested: { ["to" + "ken"]: fakeSensitive } }
      },
      "trace:artifact"
    );

    expect(record.artifact.id).toMatch(/^artifact:/);
    expect(record.artifact.storageUri).toContain("[REDACTED]");
    expect(JSON.stringify(record.artifact.metadata)).toContain("[REDACTED]");
    expect(JSON.stringify(record.artifact)).not.toContain("raw-test-value");
    expect(record.event).toMatchObject({
      roomId: room.id,
      workflowId: "workflow:test-1",
      type: "ARTIFACT_CREATED",
      payload: { artifactId: record.artifact.id, kind: "SCREENSHOT", byteSize: 2048 }
    });
    expect(store.listArtifacts({ page: 1, pageSize: 25, sortOrder: "desc", roomId: room.id })).toEqual([record.artifact]);
    expect(store.listArtifacts({ page: 1, pageSize: 25, sortOrder: "asc", kind: "SCREENSHOT" })).toEqual([record.artifact]);
    expect(store.getArtifact(record.artifact.id)).toEqual(record.artifact);
    expect(store.deleteArtifact(record.artifact.id)).toEqual(record.artifact);
    expect(store.listArtifacts({ page: 1, pageSize: 25, sortOrder: "desc", roomId: room.id })).toEqual([]);
    expect(() => store.getArtifact(record.artifact.id)).toThrow(`Artifact ${record.artifact.id} was not found.`);
  });

  it("isolates room media and Agent Files artifact collections", () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Artifact collections", initialPaneCount: 0 });
    const media = store.createArtifact({
      roomId: room.id,
      kind: "EXPORT",
      mimeType: "application/pdf",
      storageUri: "space-artifact://cli-uploads/room/pane/session/2026-07-29/input.pdf",
      sha256: "c".repeat(64),
      byteSize: 2,
      metadata: { source: "USER_UPLOAD" }
    }).artifact;
    const agentFile = store.createArtifact({
      roomId: room.id,
      kind: "EXPORT",
      mimeType: "application/pdf",
      storageUri: "space-artifact://agent-files/room/pane/session/2026-07-29/final.pdf",
      sha256: "d".repeat(64),
      byteSize: 3,
      metadata: { source: "AGENT_OUTPUT" }
    }).artifact;

    expect(store.listArtifacts({
      roomId: room.id,
      collection: "ROOM_MEDIA",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toEqual([media]);
    expect(store.listArtifacts({
      roomId: room.id,
      collection: "AGENT_FILES",
      page: 1,
      pageSize: 25,
      sortOrder: "desc"
    })).toEqual([agentFile]);
  });

  it("pins and soft-deletes expired browser artifacts", () => {
    const store = new InMemorySpaceStore();
    const artifact = store.createArtifact({
      kind: "VIDEO",
      mimeType: "video/webm",
      storageUri: `cas://sha256/${"b".repeat(64)}`,
      sha256: "b".repeat(64),
      byteSize: 4096,
      metadata: {},
      expiresAt: "2026-07-18T00:00:00.000Z"
    }).artifact;

    const pinned = store.updateArtifactRetention(artifact.id, { pinnedAt: "2026-07-12T00:00:00.000Z" });
    expect(store.deleteExpiredBrowserArtifacts("2026-07-19T00:00:00.000Z")).toEqual([]);
    store.updateArtifactRetention(artifact.id, { pinnedAt: null });
    expect(store.deleteExpiredBrowserArtifacts("2026-07-19T00:00:00.000Z")).toEqual([
      expect.objectContaining({ id: pinned.id, deletedAt: "2026-07-19T00:00:00.000Z" })
    ]);
    expect(store.listArtifacts({ page: 1, pageSize: 25, sortOrder: "desc" })).toEqual([]);
    expect(store.getArtifact(artifact.id)).toEqual(expect.objectContaining({ deletedAt: "2026-07-19T00:00:00.000Z" }));
  });

  it("only creates starter room once on first visit and does not recreate after deletion", () => {
    const store = new InMemorySpaceStore();
    const userId = "user:test-starter";
    const email = "starter@test.com";

    // First visit: starter room is created
    const starterRoom = store.ensureUserStarterRoom(userId, email);
    expect(starterRoom).not.toBeNull();
    expect(starterRoom?.name).toBe("Getting Started");
    expect(starterRoom?.ownerUserId).toBe(userId);
    expect(store.listRooms(userId)).toHaveLength(1);

    // User deletes their starter room (now has 0 rooms)
    store.deleteRoom(starterRoom!.id);
    expect(store.listRooms(userId)).toHaveLength(0);

    // Subsequent check/visit: must NOT recreate the starter room!
    const secondCall = store.ensureUserStarterRoom(userId, email);
    expect(secondCall).toBeNull();
    expect(store.listRooms(userId)).toHaveLength(0);
  });
});

