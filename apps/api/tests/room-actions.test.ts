import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { spaceAgentRoomActionBridgeRequestSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomActionExecutor, roomAgentExecutionScore } from "../src/room-actions.js";

function setupMission() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Room actions", initialPaneCount: 0 });
  const agentPane = store.getOrCreateRoomAgentPane(room.id);
  const agentSession = store.createSpaceAgentSession({
    paneId: agentPane.id,
    roomId: room.id,
    title: "Room Agent",
    selectedProviderId: null,
    selectedModelId: "gpt-5.6-sol",
    selectedModelConfigId: "gpt-5.6-sol:high",
    selectedProviderName: null,
    selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high",
    selectedToolIds: ["room:orchestrate", "room:send", "room:close_pane", "room:reopen_pane"]
  });
  const prompt = store.createSpaceAgentMessage({ sessionId: agentSession.sessionId, role: "user", content: "Run panes." });
  const response = store.createSpaceAgentMessage({ sessionId: agentSession.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const request = store.createRoomAgentRequest({
    requestId: "room_agent_request:actions",
    roomId: room.id,
    sessionId: agentSession.sessionId,
    clientRequestId: "room-agent-actions-client-0001",
    promptMessageId: prompt.messageId,
    responseMessageId: response.messageId
  });
  const mission = store.createRoomAgentMission({
    id: "room_agent_mission:actions",
    requestId: request.requestId,
    roomId: room.id,
    sessionId: agentSession.sessionId,
    workflowId: `room-supervisor:${room.id}`,
    status: "RUNNING",
    currentPaneId: agentPane.id,
    statusReason: "Running."
  });
  return { store, room, agentPane, agentSession, mission };
}

function registerRoomAgentTestModel(store: InMemorySpaceStore, modelId = "gpt-room-agent-test") {
  store.replaceProviderModels("codex-lb", [{
    id: modelId,
    providerId: "codex-lb",
    displayName: "Room Agent test model",
    status: "VERIFIED",
    contextWindow: null,
    supportsTools: true,
    supportsVision: false,
    supportsRealtime: false,
    supportsReasoning: true,
    defaultReasoningEffort: "high"
  }]);
  return modelId;
}

function testChatSession(store: InMemorySpaceStore, pane: { id: string; roomId: string; title: string }) {
  return store.getActiveSpaceAgentSession(pane.id) ?? store.createSpaceAgentSession({
    paneId: pane.id, roomId: pane.roomId, title: pane.title, selectedProviderId: "codex-lb",
    selectedModelId: "chat-test", selectedModelConfigId: "chat-test:high", selectedProviderName: "Codex-LB",
    selectedModelName: "chat-test", selectedReasoningKey: "high", selectedToolIds: []
  });
}
function submittedChatResponse(store: InMemorySpaceStore, pane: { id: string; roomId: string; title: string }, content: string, status: "COMPLETED" | "RUNNING" | "FAILED" | "INTERRUPTED" = "COMPLETED") {
  const session = testChatSession(store, pane);
  const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content });
  const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "Chat completed.", status });
  const run = store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: pane.roomId,
    workflowId: `chat-test:${response.messageId}`, temporalRunId: "temporal:test", status: "QUEUED",
    promptMessageId: prompt.messageId, responseMessageId: response.messageId, codexThreadId: null, codexTurnId: null });
  return { binding: { sessionId: session.sessionId }, session: { statusReason: "Ready.", runStatus: "IDLE" },
    submission: { sessionId: session.sessionId, responseMessageId: response.messageId, runId: run.runId } } as never;
}

describe("Room action executor", () => {
  it("captures the submitted native turn from fresh evidence even when an earlier observation was cached", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const pane = store.createPane({ roomId: room.id, title: "Short CLI", mode: "TERMINAL" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
      modelId: "codex", reasoningEffort: "medium", cwd: "/etc", status: "RUNNING", statusReason: "Ready", isActive: true });
    const start = Date.now() + 1000, at = new Date(start).toISOString(), end = new Date(start + 100).toISOString();
    const task = (id: string) => ({ taskId: id, title: "Native reply", status: "COMPLETED", timing: {
      startedAt: at, completedAt: end, durationMs: 100, source: "NATIVE", observedAt: end
    }, modelsUsed: [{ providerId: "codex", modelId: "codex", reasoningEffort: "medium", turnId: id, startedAt: at, completedAt: end, source: "NATIVE" }] });
    const executor = createRoomActionExecutor({ store,
      cliTerminalManager: { sendInput: async (_id, _text, _trace, marker) => ({ turnMarker: marker, markerAtMs: Date.now() }),
        getTurnActivity: async () => ({ status: "COMPLETED", turnId: "turn:submitted" }), interrupt: async () => true } as never,
      paneController: { inspect: async (_pane: unknown, freshness?: { fresh?: boolean }) => ({ sessionId: session.sessionId,
        tasks: freshness?.fresh ? [task("turn:submitted"), task("turn:unrelated")] : [] }) } as never,
      spaceAgentAdapter: {} as never, browserSessionManager: {} as never, pollIntervalMs: 1, actionTimeoutMs: 100
    });
    const result = await executor.execute(spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id, missionId: mission.id,
      agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId, selectedToolIds: ["room:send"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: pane.id, input: "Reply once" } }]
    }), "trace:short-native-turn");
    expect(result.results[0]).toMatchObject({ status: "EXECUTED", evidence: {
      timing: { source: "NATIVE", startedAt: at, completedAt: end }, modelsUsed: [{ turnId: "turn:submitted" }]
    } });
    expect(result.results[0]?.evidence.modelsUsed).toHaveLength(1);
  });
  it("does not infer prompt completion from a running-to-idle transition without native evidence", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const pane = store.createPane({ roomId: room.id, title: "Unverified CLI", mode: "TERMINAL" });
    const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:gemini", providerId: "gemini", agentId: "gemini",
      modelId: "gemini", reasoningEffort: "none", cwd: "/etc", status: "RUNNING", statusReason: "Ready", isActive: true });
    let inspections = 0;
    const executor = createRoomActionExecutor({ store,
      cliTerminalManager: {
        sendInput: async (_id, _text, _trace, marker) => ({ turnMarker: marker, markerAtMs: Date.now() }),
        getTurnActivity: async () => ({ status: "UNAVAILABLE" as const }), interrupt: async () => true
      } as never,
      paneController: { inspect: async () => ({ sessionId: session.sessionId, runtimeId: "cli:gemini",
        state: ++inspections < 3 ? "RUNNING" : "IDLE", tasks: [] }) } as never,
      spaceAgentAdapter: {} as never, browserSessionManager: {} as never, pollIntervalMs: 1, actionTimeoutMs: 100
    });
    const result = await executor.execute(spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id,
      missionId: mission.id, agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"], actions: [{ toolId: "room:send", action: { type: "send", paneId: pane.id, input: "Reply once" } }]
    }), "trace:unverified-idle");
    expect(inspections).toBeGreaterThan(5);
    expect(result.results[0]?.status).toBe("FAILED");
    expect(store.listRoomAgentActions(mission.id).every(action => action.status !== "COMPLETED")).toBe(true);
  });
  it("calculates a deterministic reliability score independently from execution time", () => {
    expect(roomAgentExecutionScore({ verified: true, retryCount: 1, restartCount: 1, stallCount: 1 })).toEqual({
      score: 65,
      breakdown: { verified: 100, retries: -10, restarts: -15, stalls: -10 }
    });
    expect(roomAgentExecutionScore({ verified: false, retryCount: 0, restartCount: 0, stallCount: 0 }).score).toBe(0);
  });

  it("returns fresh CLI transcripts and chat messages on every inspect pass", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Visible CLI", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Working.",
      isActive: true
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: cliSession.sessionId,
      paneId: cliPane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdout",
      content: "first CLI observation"
    });
    const chatPane = store.createPane({ roomId: room.id, title: "Visible chat", mode: "CHAT" });
    const chatSession = store.createSpaceAgentSession({
      paneId: chatPane.id,
      roomId: room.id,
      title: chatPane.title,
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      selectedToolIds: []
    });
    store.createSpaceAgentMessage({
      sessionId: chatSession.sessionId,
      role: "assistant",
      content: "first chat observation",
      status: "COMPLETED"
    });
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      roomPlanInventoryProvider: {
        inspect: async () => ({
          totalPanes: 1,
          plannedPanes: 1,
          pendingPlans: 1,
          readyPlans: 0,
          pausedPlans: 1,
          runningPlans: 0,
          checkedAt: "2026-07-12T06:55:00.000Z",
          plans: []
        })
      }
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:inspect"],
      actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
    });

    const first = await executor.execute(bridge, "req:inspect-pass-1");
    store.appendPaneCliTranscriptChunk({
      sessionId: cliSession.sessionId,
      paneId: cliPane.id,
      roomId: room.id,
      sequence: 1,
      stream: "stdout",
      content: "second CLI observation"
    });
    store.createSpaceAgentMessage({
      sessionId: chatSession.sessionId,
      role: "assistant",
      content: "second chat observation",
      status: "COMPLETED"
    });
    const second = await executor.execute(bridge, "req:inspect-pass-2");

    expect(first.results[0]?.evidence).toMatchObject({
      roomInventory: { pendingPlans: 1, pausedPlans: 1, totalPanes: 1 },
      panes: expect.arrayContaining([
        expect.objectContaining({
          id: cliPane.id,
          cli: expect.objectContaining({
            session: expect.objectContaining({ sessionId: cliSession.sessionId }),
            transcript: [expect.objectContaining({ content: "first CLI observation" })]
          })
        }),
        expect.objectContaining({
          id: chatPane.id,
          chat: expect.objectContaining({
            runStatus: "IDLE",
            messages: [expect.objectContaining({ content: "first chat observation" })]
          })
        })
      ])
    });
    expect(second.results[0]?.evidence).toMatchObject({
      panes: expect.arrayContaining([
        expect.objectContaining({
          id: cliPane.id,
          cli: expect.objectContaining({
            transcript: expect.arrayContaining([expect.objectContaining({ content: "second CLI observation" })])
          })
        }),
        expect.objectContaining({
          id: chatPane.id,
          chat: expect.objectContaining({
            messages: expect.arrayContaining([expect.objectContaining({ content: "second chat observation" })])
          })
        })
      ])
    });
    expect(store.listRoomAgentActions(mission.id)).toHaveLength(2);
  });

  it("hides LOGIN sessions from inspection and rejects Room Agent input", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const loginPane = store.createPane({
      roomId: room.id,
      title: "Gemini Login",
      mode: "TERMINAL",
      terminalRuntimeId: "cli:gemini",
      cwd: "/etc"
    });
    const loginSession = store.createPaneCliSession({
      paneId: loginPane.id,
      roomId: room.id,
      runtimeId: "cli:gemini",
      providerId: "google",
      agentId: "gemini",
      modelId: null,
      reasoningEffort: "medium",
      purpose: "LOGIN",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Login in progress.",
      isActive: true
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: loginSession.sessionId,
      paneId: loginPane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdin",
      content: "synthetic-private-device-code"
    });
    const sendInput = vi.fn();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput } as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const base = {
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId
    };

    const inspected = await executor.execute(spaceAgentRoomActionBridgeRequestSchema.parse({
      ...base,
      selectedToolIds: ["room:inspect"],
      actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
    }), "req:inspect-login");
    expect(inspected.results[0]?.evidence).toMatchObject({
      panes: expect.arrayContaining([
        expect.objectContaining({ id: loginPane.id, cli: { session: null, transcript: [], totalCount: 0, truncated: false } })
      ])
    });
    expect(JSON.stringify(inspected)).not.toContain("synthetic-private-device-code");

    const sent = await executor.execute(spaceAgentRoomActionBridgeRequestSchema.parse({
      ...base,
      selectedToolIds: ["room:send"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: loginPane.id, input: "Continue login." } }]
    }), "req:send-login");
    expect(sent.results).toMatchObject([{
      status: "FAILED",
      statusReason: expect.stringContaining("reserved for operator-managed CLI login")
    }]);
    expect(sendInput).not.toHaveBeenCalled();
  });

  it("rejects action execution unless the mission is running", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    store.updateRoomAgentMission(mission.id, {
      status: "COMPLETED",
      statusReason: "Already complete.",
      completedAt: new Date().toISOString()
    });
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:inspect"],
      actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
    });

    await expect(executor.execute(bridge, "req:stale-mission")).rejects.toThrow("mission is not running");
    expect(store.listRoomAgentActions(mission.id)).toEqual([]);
  });

  it("bounds inspect evidence to the newest twenty CLI chunks and chat messages", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Long CLI history", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Working.",
      isActive: true
    });
    const chatPane = store.createPane({ roomId: room.id, title: "Long chat history", mode: "CHAT" });
    const chatSession = store.createSpaceAgentSession({
      paneId: chatPane.id,
      roomId: room.id,
      title: chatPane.title,
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      selectedToolIds: []
    });
    for (let index = 0; index < 25; index += 1) {
      store.appendPaneCliTranscriptChunk({
        sessionId: cliSession.sessionId,
        paneId: cliPane.id,
        roomId: room.id,
        sequence: index,
        stream: index === 24 ? "system" : "stdout",
        content: index === 24 ? "cli-latest-completion" : `cli-entry-${index}`
      });
      store.createSpaceAgentMessage({
        sessionId: chatSession.sessionId,
        role: "assistant",
        content: index === 24 ? "chat-latest-error" : `chat-entry-${index}`,
        status: index === 24 ? "FAILED" : "COMPLETED"
      });
    }
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:inspect"],
      actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
    });

    const result = await executor.execute(bridge, "req:bounded-inspect");
    const panes = result.results[0]?.evidence.panes as Array<Record<string, unknown>>;
    const cli = panes.find((pane) => pane.id === cliPane.id)?.cli as {
      transcript: Array<{ content: string }>;
      totalCount: number;
      truncated: boolean;
    };
    const chat = panes.find((pane) => pane.id === chatPane.id)?.chat as {
      messages: Array<{ content: string }>;
      totalCount: number;
      truncated: boolean;
    };

    expect(cli).toMatchObject({ totalCount: 25, truncated: true });
    expect(cli.transcript).toHaveLength(20);
    expect(cli.transcript[0]?.content).toBe("cli-entry-5");
    expect(cli.transcript.at(-1)?.content).toBe("cli-latest-completion");
    expect(cli.transcript.some((entry) => entry.content === "cli-entry-0")).toBe(false);
    expect(chat).toMatchObject({ totalCount: 25, truncated: true });
    expect(chat.messages).toHaveLength(20);
    expect(chat.messages[0]?.content).toBe("chat-entry-5");
    expect(chat.messages.at(-1)?.content).toBe("chat-latest-error");
    expect(chat.messages.some((message) => message.content === "chat-entry-0")).toBe(false);
  });

  it("blocks a queued action when stop wins the race before it starts", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const pane = store.createPane({ roomId: room.id, title: "Race target", mode: "CHAT" });
    const originalCreate = store.createRoomAgentAction.bind(store);
    store.createRoomAgentAction = ((input, traceId) => {
      const action = originalCreate(input, traceId);
      store.updateRoomAgentMission(mission.id, {
        status: "INTERRUPTED",
        statusReason: "Stopped during queue handoff.",
        completedAt: new Date().toISOString()
      });
      return action;
    }) as typeof store.createRoomAgentAction;
    const sendMessage = vi.fn();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: { sendMessage } as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: pane.id, input: "Do not start." } }]
    });

    const result = await executor.execute(bridge, "req:stop-start-race");

    expect(result.results).toMatchObject([{ status: "BLOCKED", statusReason: "Stopped during queue handoff." }]);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.listRoomAgentActions(mission.id)[0]).toMatchObject({ status: "BLOCKED" });
  });

  it("blocks queued actions without interrupting panes whose work was not submitted", async () => {
    const { store, room, agentPane, mission } = setupMission();
    const pane = store.createPane({ roomId: room.id, title: "Queued pane", mode: "CHAT" });
    store.createRoomAgentAction({
      actionId: "room_agent_action:queued-stop",
      missionId: mission.id,
      roomId: room.id,
      paneId: pane.id,
      idempotencyKey: "room-agent:queued-stop",
      actionType: "SEND",
      status: "QUEUED",
      requestPayload: {},
      evidence: {},
      attemptCount: 0,
      statusReason: "Queued."
    });
    const interrupt = vi.fn(async () => ({ binding: {}, session: {} }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: { interrupt } as never,
      browserSessionManager: {} as never
    });

    const stopped = await executor.stopMission(room.id, "Stopped by operator.", "req:stop-queued");

    expect(stopped).toEqual({ missionId: mission.id, interruptedPaneIds: [] });
    expect(store.listRoomAgentMissions(room.id).find((candidate) => candidate.id === mission.id)).toMatchObject({
      status: "INTERRUPTED",
      statusReason: "Stopped by operator."
    });
    expect(store.listRoomAgentActions(mission.id)[0]).toMatchObject({ status: "BLOCKED" });
    expect(interrupt).not.toHaveBeenCalled();
    expect(agentPane.id).not.toBe(pane.id);
  });

  it("applies a completion checkpoint when a paused goal resumes", async () => {
    const { store, room, mission } = setupMission();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    await executor.pauseMission(room.id, "Pause before completion.", "req:pause-checkpoint");
    const paused = store.getRoomAgentMission(room.id, mission.id)!;
    store.updateRoomAgentMission(mission.id, {
      executionState: {
        pendingCompletion: {
          status: "COMPLETED",
          statusReason: "All plans completed while paused.",
          completedAt: "2026-07-12T05:00:00.000Z"
        }
      }
    });

    await executor.resumeMission(room.id, "req:resume-checkpoint");

    expect(store.getRoomAgentMission(room.id, mission.id)).toMatchObject({
      status: "COMPLETED",
      statusReason: "All plans completed while paused.",
      completedAt: "2026-07-12T05:00:00.000Z",
      pausedAt: null,
      totalPausedMs: expect.any(Number),
      executionState: {}
    });
    expect(paused.pausedAt).toEqual(expect.any(String));
  });

  it("creates terminal panes with a control-ready CLI session", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const ensurePaneControlReady = vi.fn(async (pane) => ({
      sessionId: "cli_session:created-ready",
      paneId: pane.id,
      status: "RUNNING"
    }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { ensurePaneControlReady } as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:create_pane"],
      actions: [{
        toolId: "room:create_pane",
        action: { type: "create_pane", title: "Created terminal", mode: "TERMINAL", terminalRuntimeId: "cli:codex" }
      }]
    });

    const result = await executor.execute(bridge, "req:create-ready-terminal");
    const created = store.listPanes(room.id).find((pane) => pane.title === "Created terminal");

    expect(ensurePaneControlReady).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }), "req:create-ready-terminal");
    expect(result.results).toMatchObject([{ status: "EXECUTED", evidence: {
      paneId: created?.id,
      mode: "TERMINAL",
      cliSession: { sessionId: "cli_session:created-ready", status: "RUNNING" }
    } }]);
  });

  it("stops mission monitoring with Escape while preserving the active CLI task", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Stoppable CLI work", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({ turnMarker, markerAtMs: Date.now() }));
    const interrupt = vi.fn(async () => true);
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        sendInput,
        async getTurnActivity(_sessionId, marker) {
          return { marker, status: "RUNNING" as const, turnId: "turn:active-stop" };
        },
        interrupt
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 5_000
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Keep working." } }]
    });

    const activeExecution = executor.execute(bridge, "req:active-stop");
    await vi.waitFor(() => {
      expect(store.listRoomAgentActions(mission.id)[0]).toMatchObject({ status: "RUNNING", paneId: cliPane.id });
    });
    const stopped = await executor.stopMission(room.id, "Stopped by operator.", "req:stop-mission");
    const result = await activeExecution;

    expect(stopped).toMatchObject({ missionId: mission.id, interruptedPaneIds: [cliPane.id] });
    expect(sendInput).toHaveBeenCalledWith(cliSession.sessionId, "\u001b", "req:stop-mission", null, expect.any(String));
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.getActivePaneCliSession(cliPane.id)).toMatchObject({ sessionId: cliSession.sessionId, isActive: true });
    expect(result.results).toMatchObject([{ status: "BLOCKED", statusReason: "Stopped by operator." }]);
    expect(store.listRoomAgentActions(mission.id)[0]).toMatchObject({
      status: "BLOCKED",
      statusReason: "Stopped by operator."
    });
  });

  it("resumes monitoring a checkpointed CLI send without sending the instruction twice", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Recoverable CLI work", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({
      turnMarker,
      markerAtMs: 1_720_000_000_000
    }));
    let releaseFirstPoll: (() => void) | null = null;
    const firstPoll = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Continue once." } }]
    });
    const firstExecutor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        sendInput,
        async getTurnActivity() {
          await firstPoll;
          return { marker: "unused", status: "COMPLETED" as const, turnId: "turn:first" };
        },
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });

    const interruptedExecution = firstExecutor.execute(bridge, "req:first");
    await vi.waitFor(() => {
      expect(store.listRoomAgentActions(mission.id)[0]?.evidence).toMatchObject({
        cliSend: {
          sessionId: cliSession.sessionId,
          markerAtMs: 1_720_000_000_000
        }
      });
    });

    const recoveredGetTurnActivity = vi.fn(async (_sessionId, marker, recovery) => ({
      marker,
      status: "COMPLETED" as const,
      turnId: recovery?.turnId ?? "turn:recovered"
    }));
    const recoveredExecutor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        sendInput,
        getTurnActivity: recoveredGetTurnActivity,
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });

    const recovered = await recoveredExecutor.execute(bridge, "req:recovered");

    expect(recovered.results).toMatchObject([{ status: "EXECUTED" }]);
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput).toHaveBeenCalledWith(
      cliSession.sessionId,
      expect.stringMatching(/^Continue once\.\n\n<space-room-action marker="[^"]+">Internal recovery marker; ignore and do not mention\.<\/space-room-action>$/),
      "req:first",
      expect.any(String),
      store.listRoomAgentActions(mission.id)[0]?.actionId,
      true
    );
    expect(sendInput).toHaveBeenCalledWith(
      cliSession.sessionId,
      "\r",
      "req:first",
      null,
      `${store.listRoomAgentActions(mission.id)[0]?.actionId}:submit`
    );
    expect(recoveredGetTurnActivity).toHaveBeenCalledWith(
      cliSession.sessionId,
      expect.any(String),
      expect.objectContaining({ markerAtMs: 1_720_000_000_000 })
    );
    releaseFirstPoll?.();
    await interruptedExecution;
  });

  it("recovers a durable pre-send intent from marker-matched CLI activity without sending twice", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Ambiguous CLI send", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const request = { toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Continue exactly once." } } as const;
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
    store.createRoomAgentAction({
      actionId: "room_agent_action:ambiguous-send",
      missionId: mission.id,
      roomId: room.id,
      paneId: cliPane.id,
      idempotencyKey: `room-agent:${mission.id}:0:${digest}`,
      actionType: "SEND",
      status: "RUNNING",
      requestPayload: request,
      evidence: {
        cliSend: {
          phase: "INTENT",
          paneId: cliPane.id,
          sessionId: cliSession.sessionId,
          marker: "7b2363fe-8d49-4eca-9ad9-6a56f2f73b9f",
          markerAtMs: Date.now() - 20_000,
          turnId: null
        }
      },
      attemptCount: 1,
      statusReason: "CLI send intent persisted before host acknowledgement."
    });
    const sendInput = vi.fn();
    const getTurnActivity = vi.fn(async (_sessionId, marker, recovery) => ({
      marker,
      status: "COMPLETED" as const,
      turnId: recovery?.turnId ?? "turn:marker-matched"
    }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, interrupt: vi.fn(async () => true) },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100,
      cliSendRecoveryGraceMs: 0
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [request]
    });

    const result = await executor.execute(bridge, "req:recover-ambiguous-send");

    expect(result.results).toMatchObject([{ status: "EXECUTED" }]);
    expect(sendInput).not.toHaveBeenCalled();
    expect(getTurnActivity).toHaveBeenCalledWith(
      cliSession.sessionId,
      "7b2363fe-8d49-4eca-9ad9-6a56f2f73b9f",
      expect.objectContaining({ inputMarker: "7b2363fe-8d49-4eca-9ad9-6a56f2f73b9f" })
    );
  });

  // Claude Code panes kept typed prompts as unsent drafts after their Enter (2026-10-20); missions get the shared re-press.
  it("presses Enter again while a mission prompt stays a draft in an idle CLI's composer", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Claude work", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id, roomId: room.id, runtimeId: "cli:claude", providerId: "claude", agentId: "claude", modelId: "claude-opus-5-5",
      reasoningEffort: "high", cwd: "/etc", status: "RUNNING", statusReason: "Running.", isActive: true
    });
    const rule = "─".repeat(40);
    const screens = [`${rule}\n❯ \n${rule}`, `${rule}\n❯ [Pasted text #1 +2 lines]\n${rule}`, `${rule}\n❯ \n${rule}`];
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({ turnMarker, markerAtMs: Date.now() }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        sendInput,
        observeRoomScreenUndimmed: vi.fn(async () => screens.shift() ?? `${rule}\n❯ \n${rule}`),
        getTurnActivity: vi.fn(async (_sessionId, marker) => ({ marker, status: "COMPLETED" as const, turnId: "turn:mission" })),
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 5_000
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id, missionId: mission.id, agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Run the check once." } }]
    });

    const result = await executor.execute(bridge, "req:mission-draft");

    expect(result.results).toMatchObject([{ status: "EXECUTED" }]);
    const actionId = store.listRoomAgentActions(mission.id)[0]?.actionId;
    expect(sendInput.mock.calls.map((call) => [call[1] === "\r" ? "\r" : "text", call[4]])).toEqual([
      ["text", actionId], ["\r", `${actionId}:submit`], ["\r", `${actionId}:submit:resubmit-0`]
    ]);
    expect(sendInput.mock.calls[0]?.[0]).toBe(cliSession.sessionId);
  });

  it("submits durable CLI content after recovery without writing the instruction twice", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Staged CLI work", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const request = { toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Submit staged work." } } as const;
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
    const actionId = "room_agent_action:staged-content";
    const marker = "8b2363fe-8d49-4eca-9ad9-6a56f2f73b9f";
    store.createRoomAgentAction({
      actionId,
      missionId: mission.id,
      roomId: room.id,
      paneId: cliPane.id,
      idempotencyKey: `room-agent:${mission.id}:0:${digest}`,
      actionType: "SEND",
      status: "RUNNING",
      requestPayload: request,
      evidence: {
        cliSend: {
          phase: "CONTENT",
          paneId: cliPane.id,
          sessionId: cliSession.sessionId,
          marker,
          markerAtMs: Date.now(),
          turnId: null
        }
      },
      attemptCount: 1,
      statusReason: "CLI instruction content accepted; submit is pending."
    });
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({
      turnMarker,
      markerAtMs: Date.now()
    }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        sendInput,
        async getTurnActivity(_sessionId, turnMarker) {
          return { marker: turnMarker, status: "COMPLETED" as const, turnId: "turn:staged-content" };
        },
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [request]
    });

    const result = await executor.execute(bridge, "req:recover-staged-content");

    expect(result.results).toMatchObject([{ status: "EXECUTED" }]);
    expect(sendInput).toHaveBeenCalledTimes(1);
    expect(sendInput).toHaveBeenCalledWith(
      cliSession.sessionId,
      "\r",
      "req:recover-staged-content",
      null,
      `${actionId}:submit`
    );
    expect(store.listRoomAgentActions(mission.id)[0]?.evidence).toMatchObject({
      cliSend: { phase: "SENT", marker, turnId: "turn:staged-content" }
    });
  });

  it("sends an old durable intent once when no marker-matched CLI activity exists", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Unsent CLI intent", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const request = { toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Send after recovery grace." } } as const;
    const digest = createHash("sha256").update(JSON.stringify(request)).digest("hex").slice(0, 32);
    const marker = "9b2363fe-8d49-4eca-9ad9-6a56f2f73b9f";
    store.createRoomAgentAction({
      actionId: "room_agent_action:unsent-intent",
      missionId: mission.id,
      roomId: room.id,
      paneId: cliPane.id,
      idempotencyKey: `room-agent:${mission.id}:0:${digest}`,
      actionType: "SEND",
      status: "RUNNING",
      requestPayload: request,
      evidence: {
        cliSend: {
          phase: "INTENT",
          paneId: cliPane.id,
          sessionId: cliSession.sessionId,
          marker,
          markerAtMs: Date.now() - 20_000,
          turnId: null
        }
      },
      attemptCount: 1,
      statusReason: "CLI send intent persisted before host acknowledgement."
    });
    let sent = false;
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => {
      sent = true;
      return { turnMarker, markerAtMs: Date.now() };
    });
    const getTurnActivity = vi.fn(async (_sessionId, turnMarker) => ({
      marker: turnMarker,
      status: sent ? "COMPLETED" as const : "PENDING" as const,
      turnId: sent ? "turn:sent-after-grace" : null
    }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, interrupt: vi.fn(async () => true) },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100,
      cliSendRecoveryGraceMs: 0
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [request]
    });

    const result = await executor.execute(bridge, "req:send-unsent-intent");

    expect(result.results).toMatchObject([{ status: "EXECUTED" }]);
    expect(sendInput).toHaveBeenCalledTimes(2);
    expect(sendInput).toHaveBeenCalledWith(
      cliSession.sessionId,
      expect.stringContaining(`<space-room-action marker="${marker}">`),
      "req:send-unsent-intent",
      marker,
      "room_agent_action:unsent-intent",
      true
    );
    expect(sendInput).toHaveBeenCalledWith(
      cliSession.sessionId,
      "\r",
      "req:send-unsent-intent",
      null,
      "room_agent_action:unsent-intent:submit"
    );
    expect(store.listRoomAgentActions(mission.id)[0]?.evidence).toMatchObject({
      cliSend: { phase: "SENT", marker, turnId: "turn:sent-after-grace" }
    });
  });

  it.each([
    { hasNativeResult: true, quality: 80, correctness: 80 },
    { hasNativeResult: false, quality: 80, correctness: 80 },
    { hasNativeResult: true, quality: 85, correctness: 30 },
    { hasNativeResult: true, quality: 60, correctness: 80 }
  ])("evaluates exact native output and independently gates quality ($hasNativeResult/$quality/$correctness)", async ({ hasNativeResult, quality, correctness }) => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "CLI work", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const sent: string[] = [];
    const getTurnFinalResult = vi.fn(async () => hasNativeResult ? "Exact native final answer." : null);
    store.appendPaneCliTranscriptChunk({ sessionId: cliSession.sessionId, paneId: cliPane.id, roomId: room.id,
      sequence: 0, stream: "stdout", content: "\u001b[2JOLD TURN ANSWER\u001b[0m\nspinner" });
    const evaluate = vi.fn(async () => ({
      available: true as const, qualityScore: quality,
      rubric: { correctness, completeness: 80, instructionAdherence: 80, evidence: 80, clarity: 80 },
      summary: "Good verified result.", attempts: 1
    }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        async sendInput(_sessionId, data, _traceId, turnMarker) {
          sent.push(data);
          return { turnMarker, markerAtMs: Date.now() };
        },
        async getTurnActivity(_sessionId, marker) {
          return { marker, status: "COMPLETED" as const, turnId: "turn:completed" };
        },
        getTurnFinalResult,
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      taskEvaluator: { evaluate },
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"],
      actions: [
        {
          toolId: "room:orchestrate",
          action: {
            type: "orchestrate",
            steps: [
              { paneId: cliPane.id, instruction: "Finish the implementation." },
              { paneId: cliPane.id, instruction: "Run final verification." }
            ]
          }
        }
      ]
    });

    const result = await executor.execute(bridge, "req:room-actions");

    expect(result.results).toMatchObject([{ status: "EXECUTED", missionId: mission.id }]);
    expect(sent).toHaveLength(4);
    expect(sent[0]).toMatch(/^Finish the implementation\.\n\n<space-room-action marker="[^"]+">/);
    expect(sent[1]).toBe("\r");
    expect(sent[2]).toMatch(/^Run final verification\.\n\n<space-room-action marker="[^"]+">/);
    expect(sent[3]).toBe("\r");
    expect(store.listRoomAgentActions(mission.id)).toHaveLength(3);
    expect(store.listRoomAgentActions(mission.id).every((action) => action.status === "COMPLETED")).toBe(true);
    expect(getTurnFinalResult).toHaveBeenCalledWith(cliSession.sessionId, "turn:completed");
    if (hasNativeResult) {
      expect(evaluate).toHaveBeenCalledWith(expect.objectContaining({ finalResult: "Exact native final answer." }));
      expect(store.listRoomAgentTaskRuns(mission.id)).toMatchObject([
        { stepId: expect.stringMatching(/^step:/), paneId: cliPane.id, status: quality < 70 || correctness < 70 ? "LOW_QUALITY" : "COMPLETED", qualityScore: quality, reliabilityScore: 100, combinedScore: quality * 0.7 + 30 },
        { stepId: expect.stringMatching(/^step:/), paneId: cliPane.id, status: quality < 70 || correctness < 70 ? "LOW_QUALITY" : "COMPLETED", qualityScore: quality, reliabilityScore: 100, combinedScore: quality * 0.7 + 30 }
      ]);
    } else {
      expect(evaluate).not.toHaveBeenCalled();
      expect(store.listRoomAgentTaskRuns(mission.id)).toEqual(expect.arrayContaining([
        expect.objectContaining({ qualityScore: null, qualityUnavailableReason: expect.stringContaining("exact completed native turn") })
      ]));
    }
    expect(store.getActivePaneCliSession(cliPane.id)?.sessionId).toBe(cliSession.sessionId);
  });

  it.each([
    { failure: "aborts", activityStatus: "ABORTED" as const, cliTurnStartGraceMs: 100 },
    { failure: "never starts", activityStatus: "PENDING" as const, cliTurnStartGraceMs: 1 }
  ])("blocks without replacing the CLI task and never resends an unsubmitted prompt when its turn $failure", async ({ activityStatus, cliTurnStartGraceMs }) => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Recover aborted CLI work", mode: "TERMINAL", cwd: "/etc" });
    const firstSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({ turnMarker, markerAtMs: Date.now() }));
    const getTurnActivity = vi.fn(async (sessionId, marker) => ({
      marker,
      status: sessionId === firstSession.sessionId ? activityStatus : "COMPLETED" as const,
      turnId: sessionId === firstSession.sessionId ? "turn:aborted" : "turn:recovered"
    }));
    const interrupt = vi.fn(async () => true);
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, interrupt },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100,
      cliTurnStartGraceMs
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send", "room:interrupt"],
      actions: [{
        toolId: "room:orchestrate",
        action: { type: "orchestrate", steps: [{ paneId: cliPane.id, instruction: "Finish after automatic recovery." }] }
      }]
    });

    const result = await executor.execute(bridge, "req:recover-aborted-orchestration");

    expect(result.results).toMatchObject([{ status: "FAILED", statusReason: expect.stringContaining(activityStatus === "PENDING" ? "it has not been resent" : "CLI turn aborted") }]);
    if (activityStatus === "PENDING") expect(sendInput).toHaveBeenCalledTimes(2);
    else expect(sendInput).toHaveBeenCalledWith(firstSession.sessionId, "\u001b", "req:recover-aborted-orchestration", null, expect.any(String));
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.getActivePaneCliSession(cliPane.id)?.sessionId).toBe(firstSession.sessionId);
    expect(store.listRoomAgentActions(mission.id).some((action) => action.actionType === "RESTART")).toBe(false);
  });

  it("runs independent orchestration steps together and releases a dependent step only after its prerequisites", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const panes = ["Independent A", "Independent B", "Dependent C"].map((title) =>
      store.createPane({ roomId: room.id, title, mode: "TERMINAL", cwd: "/etc" })
    );
    const sessions = panes.map((pane) => store.createPaneCliSession({
      paneId: pane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Ready.",
      isActive: true
    }));
    const started: string[] = [];
    const completed: string[] = [];
    let releaseFirstWave!: () => void;
    const firstWaveStarted = new Promise<void>((resolve) => { releaseFirstWave = resolve; });
    const sendInput = vi.fn(async (sessionId: string, data: string, _traceId: string, turnMarker: string | null) => {
      if (data !== "\r") {
        started.push(sessionId);
        if (started.includes(sessions[0]!.sessionId) && started.includes(sessions[1]!.sessionId)) releaseFirstWave();
        if (sessionId === sessions[2]!.sessionId) {
          expect(completed).toEqual(expect.arrayContaining([sessions[0]!.sessionId, sessions[1]!.sessionId]));
        }
      }
      return { turnMarker, markerAtMs: Date.now() };
    });
    const getTurnActivity = vi.fn(async (sessionId: string, marker: string) => {
      if (sessionId !== sessions[2]!.sessionId) await firstWaveStarted;
      completed.push(sessionId);
      return { marker, status: "COMPLETED" as const, turnId: `turn:${sessionId}` };
    });
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, interrupt: vi.fn(async () => true) },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 500
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send", "room:restart"],
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          strategy: "AUTO_PARALLEL",
          analysisSummary: "A and B are independent; C depends on both.",
          steps: [
            { stepId: "a", paneId: panes[0]!.id, label: panes[0]!.title, instruction: "Finish A.", dependsOn: [] },
            { stepId: "b", paneId: panes[1]!.id, label: panes[1]!.title, instruction: "Finish B.", dependsOn: [] },
            { stepId: "c", paneId: panes[2]!.id, label: panes[2]!.title, instruction: "Finish C.", dependsOn: ["a", "b"] }
          ]
        }
      }]
    });

    const result = await executor.execute(bridge, "req:parallel-room-actions");

    expect(started.slice(0, 2)).toEqual(expect.arrayContaining([sessions[0]!.sessionId, sessions[1]!.sessionId]));
    expect(started[2]).toBe(sessions[2]!.sessionId);
    expect(result.results[0]).toMatchObject({
      status: "EXECUTED",
      evidence: {
        peakConcurrency: 2,
        analysisSummary: "A and B are independent; C depends on both.",
        steps: [
          expect.objectContaining({ stepId: "a", status: "EXECUTED", score: 100, durationMs: expect.any(Number) }),
          expect.objectContaining({ stepId: "b", status: "EXECUTED", score: 100, durationMs: expect.any(Number) }),
          expect.objectContaining({ stepId: "c", status: "EXECUTED", score: 100, durationMs: expect.any(Number) })
        ]
      }
    });
    expect(store.listSpaceAgentMessages(agentSession.sessionId).length).toBeGreaterThan(2);
  });

  it("prepares three CLIs with a runtime model absent from the chat registry before dispatch and reuses them on retry", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const modelId = "gpt-5.6-sol";
    const listModels = vi.spyOn(store, "listModels");
    const existingPane = store.createPane({ roomId: room.id, title: "Existing CLI", mode: "TERMINAL", cwd: "/etc" });
    store.createPaneCliSession({
      paneId: existingPane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
      modelId, reasoningEffort: "high", cwd: "/etc", status: "RUNNING", statusReason: "Ready.", isActive: true
    });
    const prompts: string[] = [];
    const respondedSessions = new Set<string>();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        async listRuntimes() {
          return {
            checkedAt: "2026-07-12T00:00:00.000Z",
            data: [{
              id: "cli:codex", providerId: "codex", providerName: "Codex", agentId: "codex", agentName: "Codex CLI",
              displayName: "Codex CLI", capabilities: ["CLI" as const], adapterStatus: "ENABLED" as const,
              authMode: "NONE" as const, authState: "READY" as const, authReason: "Available for test.",
              canStartLogin: false, status: "ENABLED" as const,
              statusReason: "Available for test.", commandName: "codex", detectedCommandPath: "/usr/bin/codex",
              defaultModelId: modelId, supportedReasoningEfforts: ["high" as const], checkedAt: "2026-07-12T00:00:00.000Z"
            }]
          };
        },
        async ensurePaneControlReady(pane) {
          return store.createPaneCliSession({
            paneId: pane.id, roomId: room.id, runtimeId: pane.terminalRuntimeId ?? "cli:codex", providerId: "codex",
            agentId: "codex", modelId: pane.modelId, reasoningEffort: pane.reasoningEffort, cwd: "/etc",
            status: "RUNNING", statusReason: "Ready.", isActive: true
          });
        },
        async sendInput(_sessionId, data, _traceId, turnMarker) {
          if (data !== "\r") {
            expect(store.listPanes(room.id)).toHaveLength(4);
            prompts.push(data);
          }
          return { turnMarker, markerAtMs: Date.now() };
        },
        async getTurnActivity(sessionId, marker) {
          if (!respondedSessions.has(sessionId)) {
            respondedSessions.add(sessionId);
            const session = store.getPaneCliSession(sessionId)!;
            store.appendPaneCliTranscriptChunk({
              sessionId,
              paneId: session.paneId,
              roomId: room.id,
              sequence: 0,
              stream: "stdout",
              content: `First response for ${session.paneId}`
            });
          }
          return { marker, status: "COMPLETED" as const, turnId: `turn:${marker}` };
        },
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 500
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"],
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          strategy: "AUTO_PARALLEL",
          preparePanes: ["two", "three", "four"].map((paneKey) => ({
            paneKey, title: `Prepared ${paneKey}`, mode: "TERMINAL", terminalRuntimeId: "cli:codex", modelId, reasoningEffort: "high"
          })),
          steps: [
            { stepId: "one", paneId: existingPane.id, instruction: "Task one.", dependsOn: [] },
            { stepId: "two", paneKey: "two", instruction: "Task two.", dependsOn: [] },
            { stepId: "three", paneKey: "three", instruction: "Task three.", dependsOn: [] },
            { stepId: "four", paneKey: "four", instruction: "Task four.", dependsOn: [] }
          ]
        }
      }]
    });

    const first = await executor.execute(bridge, "req:prepare-four");
    const retry = await executor.execute(bridge, "req:prepare-four-retry");

    expect(first.results[0]).toMatchObject({ status: "EXECUTED", evidence: { peakConcurrency: 4 } });
    expect(retry.results[0]).toMatchObject({ status: "EXECUTED", evidence: { peakConcurrency: 4 } });
    expect(prompts).toHaveLength(4);
    expect(listModels).not.toHaveBeenCalled();
    expect(store.listPanes(room.id)).toHaveLength(4);
    expect(store.listRoomAgentTaskRuns(mission.id)).toHaveLength(4);
    expect(store.listRoomAgentTaskRuns(mission.id).every((run) =>
      typeof run.firstResponseMs === "number" && typeof run.firstResponseAt === "string"
    )).toBe(true);
    expect(store.listRoomAgentTaskRuns(mission.id).every((run) =>
      run.modelId === modelId && run.reasoningEffort === "high"
    )).toBe(true);
    expect(store.listPanes(room.id).map((pane) => [pane.modelId, pane.reasoningEffort])).toEqual([
      [null, "medium"],
      [modelId, "high"],
      [modelId, "high"],
      [modelId, "high"]
    ]);
    expect(store.listPanes(room.id).map((pane) => store.getActivePaneCliSession(pane.id)?.modelId)).toEqual([
      modelId, modelId, modelId, modelId
    ]);
  });

  it("keeps independent chat tasks running after CLI readiness fails and reuses durable checkpoints", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const modelId = registerRoomAgentTestModel(store);
    const ensurePaneControlReady = vi.fn(async () => { throw new Error("Codex input-readiness timeout."); });
    const createOrRestoreSession = vi.fn(async ({ pane }) => {
      testChatSession(store, pane);
      return { runStatus: "IDLE", statusReason: "Ready." };
    });
    const sendMessage = vi.fn(async ({ pane, content }) => submittedChatResponse(store, pane, content));
    const options = {
      store,
      cliTerminalManager: {
        listRuntimes: async () => ({ data: [{
          id: "cli:codex", capabilities: ["CLI"], adapterStatus: "ENABLED", authState: "READY",
          status: "ENABLED", detectedCommandPath: "/usr/bin/codex", supportedReasoningEfforts: []
        }] }),
        ensurePaneControlReady
      } as never,
      spaceAgentAdapter: { createOrRestoreSession, sendMessage, loadSession: async () => ({ runStatus: "IDLE" }) } as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1, actionTimeoutMs: 100
    };
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id, missionId: mission.id, agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"], actions: [{ toolId: "room:orchestrate", action: {
        type: "orchestrate", preparePanes: [
          { paneKey: "blocked", title: "Blocked CLI", mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
          ...["one", "two"].map(paneKey => ({ paneKey, title: paneKey, mode: "CHAT", modelId }))
        ], steps: [
          { stepId: "blocked", paneKey: "blocked", instruction: "Must not submit.", dependsOn: [] },
          { stepId: "dependent", paneKey: "blocked", instruction: "Must not submit dependency.", dependsOn: ["blocked"] },
          ...["one", "two"].map(paneKey => ({ stepId: paneKey, paneKey, instruction: `Run ${paneKey}.`, dependsOn: [] }))
        ]
      } }]
    });
    const first = await createRoomActionExecutor(options).execute(bridge, "req:isolated-readiness");
    expect(first.results[0]).toMatchObject({ status: "FAILED", statusReason: expect.stringContaining("Codex input-readiness timeout"),
      evidence: { peakConcurrency: 2, preparedPanes: [
        expect.objectContaining({ paneKey: "blocked", status: "BLOCKED", statusReason: "Codex input-readiness timeout." }),
        expect.objectContaining({ paneKey: "one", status: "READY" }),
        expect.objectContaining({ paneKey: "two", status: "READY" })
      ], steps: [expect.objectContaining({ stepId: "one" }), expect.objectContaining({ stepId: "two" })] } });
    const runs = store.listRoomAgentTaskRuns(mission.id);
    expect(runs.filter(run => run.status === "COMPLETED")).toHaveLength(2);
    expect(runs.filter(run => run.status === "BLOCKED")).toHaveLength(2);
    expect(runs.filter(run => run.status === "BLOCKED").every(run => run.startedAt === null)).toBe(true);
    // Simulate re-entering the durable action after a worker restart. Completed
    // prompts and failed preparation must not be repeated by a new executor.
    const root = store.listRoomAgentActions(mission.id).find(action => action.actionType === "ORCHESTRATE")!;
    store.updateRoomAgentAction(root.actionId, { status: "RUNNING", completedAt: null });
    const retried = await createRoomActionExecutor(options).execute(bridge, "req:isolated-readiness-retry");
    expect(retried.results[0].status).toBe("FAILED");
    expect(ensurePaneControlReady).toHaveBeenCalledTimes(1);
    expect(createOrRestoreSession).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(store.listPanes(room.id)).toHaveLength(3);
    expect(store.listRoomAgentTaskRuns(mission.id)).toHaveLength(4);
  });

  it("checks the room pane cap before creating any prepared pane", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const modelId = registerRoomAgentTestModel(store);
    store.getRoom(room.id).paneCap = 1;
    store.createPane({ roomId: room.id, title: "Existing", mode: "TERMINAL", modelId });
    const ensurePaneControlReady = vi.fn();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { ensurePaneControlReady } as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"],
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          preparePanes: [{
            paneKey: "overflow", title: "Overflow", mode: "TERMINAL", terminalRuntimeId: "cli:codex",
            modelId, reasoningEffort: "high"
          }],
          steps: [{ stepId: "overflow", paneKey: "overflow", instruction: "Should not run.", dependsOn: [] }]
        }
      }]
    });

    const result = await executor.execute(bridge, "req:prepare-cap-preflight");

    expect(result.results[0]).toMatchObject({
      status: "FAILED",
      statusReason: expect.stringContaining("room cap is 1")
    });
    expect(store.listPanes(room.id)).toHaveLength(1);
    expect(ensurePaneControlReady).not.toHaveBeenCalled();
  });

  it("checks every requested CLI runtime before creating any prepared pane", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const modelId = registerRoomAgentTestModel(store);
    const ensurePaneControlReady = vi.fn();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        listRuntimes: async () => ({
          checkedAt: "2026-07-12T00:00:00.000Z",
          data: [{
            id: "cli:codex", providerId: "codex", providerName: "Codex", agentId: "codex", agentName: "Codex CLI",
            displayName: "Codex CLI", capabilities: ["CLI"], status: "DISABLED", statusReason: "Unavailable for test.",
            commandName: "codex", detectedCommandPath: null, defaultModelId: modelId, supportedReasoningEfforts: ["high"],
            checkedAt: "2026-07-12T00:00:00.000Z"
          }]
        }),
        ensurePaneControlReady
      } as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"],
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          preparePanes: [{
            paneKey: "unavailable", title: "Unavailable", mode: "TERMINAL", terminalRuntimeId: "cli:codex",
            modelId, reasoningEffort: "high"
          }],
          steps: [{ stepId: "unavailable", paneKey: "unavailable", instruction: "Should not run.", dependsOn: [] }]
        }
      }]
    });

    const result = await executor.execute(bridge, "req:prepare-runtime-preflight");

    expect(result.results[0]).toMatchObject({ status: "FAILED", statusReason: "CLI runtime cli:codex is not available." });
    expect(store.listPanes(room.id)).toEqual([]);
    expect(ensurePaneControlReady).not.toHaveBeenCalled();
  });

  it("rejects an unavailable chat model before creating any prepared pane", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const createOrRestoreSession = vi.fn();
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: { createOrRestoreSession } as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"],
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          preparePanes: [{
            paneKey: "chat", title: "Unavailable chat", mode: "CHAT",
            modelId: "missing-chat-model", reasoningEffort: "high"
          }],
          steps: [{ stepId: "chat", paneKey: "chat", instruction: "Should not run.", dependsOn: [] }]
        }
      }]
    });

    const result = await executor.execute(bridge, "req:prepare-chat-model-preflight");

    expect(result.results[0]).toMatchObject({
      status: "FAILED",
      statusReason: "Model missing-chat-model is not available."
    });
    expect(store.listPanes(room.id)).toEqual([]);
    expect(createOrRestoreSession).not.toHaveBeenCalled();
  });

  it("prepares and executes mixed CLI and chat orchestration with the selected model", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const modelId = registerRoomAgentTestModel(store);
    const createdCliPane = store.createPane({ roomId: room.id, title: "Existing CLI", mode: "TERMINAL", modelId });
    const cliPane = store.updatePane(createdCliPane.id, { reasoningEffort: "high" });
    store.createPaneCliSession({
      paneId: cliPane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
      modelId, reasoningEffort: "high", cwd: "/etc", status: "RUNNING", statusReason: "Ready.", isActive: true
    });
    const cliPrompts: string[] = [];
    const chatPrompts: string[] = [];
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        async sendInput(_sessionId, data, _traceId, turnMarker) {
          if (data !== "\r") cliPrompts.push(data);
          return { turnMarker, markerAtMs: Date.now() };
        },
        async getTurnActivity(_sessionId, marker) {
          return { marker, status: "COMPLETED" as const, turnId: `turn:${marker}` };
        },
        interrupt: vi.fn(async () => true)
      },
      spaceAgentAdapter: {
        async createOrRestoreSession({ pane, selectedModelConfigId }) {
          store.createSpaceAgentSession({
            paneId: pane.id, roomId: room.id, title: pane.title, selectedProviderId: "codex-lb",
            selectedModelId: modelId, selectedModelConfigId, selectedProviderName: "Codex-LB",
            selectedModelName: modelId, selectedReasoningKey: "high", selectedToolIds: []
          });
          return { runStatus: "IDLE", statusReason: "Ready." } as never;
        },
        async sendMessage({ pane, content }) {
          chatPrompts.push(content);
          return submittedChatResponse(store, pane, content);
        },
        async loadSession() {
          return { runStatus: "IDLE", statusReason: "Complete." } as never;
        }
      } as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send"],
      actions: [{
        toolId: "room:orchestrate",
        action: {
          type: "orchestrate",
          preparePanes: [{ paneKey: "chat", title: "Prepared chat", mode: "CHAT", modelId, reasoningEffort: "high" }],
          steps: [
            { stepId: "cli", paneId: cliPane.id, instruction: "Run CLI task.", dependsOn: [] },
            { stepId: "chat", paneKey: "chat", instruction: "Run chat task.", dependsOn: [] }
          ]
        }
      }]
    });

    const result = await executor.execute(bridge, "req:mixed-orchestration");

    expect(result.results[0]).toMatchObject({ status: "EXECUTED", evidence: { peakConcurrency: 2 } });
    expect(cliPrompts).toHaveLength(1);
    expect(chatPrompts).toEqual(["Run chat task."]);
    const chatPane = store.listPanes(room.id).find((pane) => pane.mode === "CHAT")!;
    expect(store.getActiveSpaceAgentSession(chatPane.id)).toMatchObject({ selectedModelConfigId: `${modelId}:high` });
    expect(store.listRoomAgentTaskRuns(mission.id)).toHaveLength(2);
  });

  it("waits for an existing CLI turn before submitting the next orchestration step", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Busy CLI work", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Existing Codex turn is running.",
      isActive: true
    });
    const activityOrder: string[] = [];
    const getCurrentTurnActivity = vi
      .fn()
      .mockImplementationOnce(async () => {
        activityOrder.push("current:RUNNING");
        return { status: "RUNNING" as const, turnId: "turn:existing" };
      })
      .mockImplementationOnce(async () => {
        activityOrder.push("current:COMPLETED");
        return { status: "COMPLETED" as const, turnId: "turn:existing" };
      });
    const sendInput = vi.fn(async (_sessionId, data, _traceId, turnMarker) => {
      activityOrder.push(data === "\r" ? "send:submit" : "send:content");
      return { turnMarker, markerAtMs: Date.now() };
    });
    const getTurnActivity = vi.fn(async (_sessionId, marker) => ({
      marker,
      status: "COMPLETED" as const,
      turnId: "turn:next"
    }));
    const interrupt = vi.fn(async () => true);
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, getCurrentTurnActivity, interrupt } as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send", "room:restart"],
      actions: [{
        toolId: "room:orchestrate",
        action: { type: "orchestrate", steps: [{ paneId: cliPane.id, instruction: "Continue after current work." }] }
      }]
    });

    const result = await executor.execute(bridge, "req:wait-for-existing-cli-turn");

    expect(result.results).toMatchObject([{ status: "EXECUTED" }]);
    expect(getCurrentTurnActivity).toHaveBeenCalledWith(cliSession.sessionId);
    expect(activityOrder).toEqual(["current:RUNNING", "current:COMPLETED", "send:content", "send:submit"]);
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.listRoomAgentActions(mission.id).some((action) => action.actionType === "RESTART")).toBe(false);
    expect(store.listSpaceAgentMessages(agentSession.sessionId).at(-1)?.content).toContain("final mission check");
  });

  it("interrupts a CLI task only by sending Escape and preserves its session and thread", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "User-controlled CLI", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "019f4434-0000-7000-8000-000000000020",
      status: "RUNNING",
      statusReason: "User task is running.",
      isActive: true
    });
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({ turnMarker, markerAtMs: Date.now() }));
    const hostInterrupt = vi.fn(async () => true);
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity: vi.fn(), interrupt: hostInterrupt },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:interrupt"],
      actions: [{ toolId: "room:interrupt", action: { type: "interrupt", paneId: cliPane.id, reason: "Pause from Room Agent." } }]
    });

    const result = await executor.execute(bridge, "req:escape-only-interrupt");

    expect(result.results).toMatchObject([{ status: "EXECUTED", evidence: { controlMode: "KEYSTROKE", key: "ESC" } }]);
    expect(sendInput).toHaveBeenCalledWith(cliSession.sessionId, "\u001b", "req:escape-only-interrupt", null, expect.any(String));
    expect(hostInterrupt).not.toHaveBeenCalled();
    expect(store.getActivePaneCliSession(cliPane.id)).toMatchObject({
      sessionId: cliSession.sessionId,
      codexThreadId: cliSession.codexThreadId,
      isActive: true
    });
  });

  it("blocks a stalled CLI turn without restarting or replacing its task", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Stalled CLI work", mode: "TERMINAL", cwd: "/etc" });
    const firstSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      status: "RUNNING",
      statusReason: "Existing Codex turn is stalled.",
      isActive: true
    });
    store.appendPaneCliTranscriptChunk({
      sessionId: firstSession.sessionId,
      paneId: cliPane.id,
      roomId: room.id,
      sequence: 0,
      stream: "stdout",
      content: "last output before stall"
    });
    const getCurrentTurnActivity = vi.fn(async () => ({ status: "RUNNING" as const, turnId: "turn:stalled" }));
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({ turnMarker, markerAtMs: Date.now() }));
    const getTurnActivity = vi.fn(async (_sessionId, marker) => ({
      marker,
      status: "COMPLETED" as const,
      turnId: "turn:recovered"
    }));
    const interrupt = vi.fn(async () => true);
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, getCurrentTurnActivity, interrupt } as never,
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100,
      cliExistingTurnStallMs: 2
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:orchestrate", "room:send", "room:restart"],
      actions: [{
        toolId: "room:orchestrate",
        action: { type: "orchestrate", steps: [{ paneId: cliPane.id, instruction: "Recover and continue." }] }
      }]
    });

    const result = await executor.execute(bridge, "req:recover-stalled-existing-cli-turn");

    expect(result.results).toMatchObject([{ status: "FAILED", statusReason: expect.stringContaining("manual operator decision") }]);
    expect(sendInput).toHaveBeenCalledWith(firstSession.sessionId, "\u001b", "req:recover-stalled-existing-cli-turn", null, expect.any(String));
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.getActivePaneCliSession(cliPane.id)?.sessionId).toBe(firstSession.sessionId);
    expect(store.listSpaceAgentMessages(agentSession.sessionId).at(-1)?.content).toContain("BLOCKED");
  });

  it("escapes a submitted turn with stale rollout activity without restarting or replacing it", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const cliPane = store.createPane({ roomId: room.id, title: "Submitted stalled CLI", mode: "TERMINAL", cwd: "/etc" });
    const cliSession = store.createPaneCliSession({
      paneId: cliPane.id,
      roomId: room.id,
      runtimeId: "cli:codex",
      providerId: "codex",
      agentId: "codex",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      cwd: "/etc",
      codexThreadId: "019f4434-0000-7000-8000-000000000099",
      status: "RUNNING",
      statusReason: "Running.",
      isActive: true
    });
    const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => ({ turnMarker, markerAtMs: Date.now() }));
    const getTurnActivity = vi.fn(async (_sessionId, marker) => ({
      marker,
      status: "RUNNING" as const,
      turnId: "turn:submitted-stalled",
      lastActivityAtMs: 1
    }));
    const interrupt = vi.fn(async () => true);
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: { sendInput, getTurnActivity, interrupt },
      spaceAgentAdapter: {} as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100,
      cliSubmittedTurnStallMs: 2,
      cliEscapeRecoveryGraceMs: 2
    });
    const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send", "room:restart"],
      actions: [{ toolId: "room:send", action: { type: "send", paneId: cliPane.id, input: "Finish this work." } }]
    });

    const result = await executor.execute(bridge, "req:submitted-stall");

    expect(result.results).toMatchObject([{ status: "FAILED", statusReason: expect.stringContaining("manual operator decision") }]);
    expect(sendInput.mock.calls.filter((call) => call[1] === "\u001b")).toHaveLength(1);
    expect(interrupt).not.toHaveBeenCalled();
    expect(store.getActivePaneCliSession(cliPane.id)).toMatchObject({
      sessionId: cliSession.sessionId,
      codexThreadId: cliSession.codexThreadId,
      isActive: true
    });
    expect(store.listRoomAgentActions(mission.id).some((action) => action.actionType === "RESTART")).toBe(false);
  });

  it("soft-closes and reopens panes without exposing a permanent delete action", async () => {
    const { store, room, agentPane, agentSession, mission } = setupMission();
    const pane = store.createPane({ roomId: room.id, title: "Temporary", mode: "CHAT" });
    const interrupt = vi.fn(async () => ({ binding: {}, session: {} }));
    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {} as never,
      spaceAgentAdapter: { interrupt } as never,
      browserSessionManager: {} as never,
      pollIntervalMs: 1,
      actionTimeoutMs: 100
    });
    const request = (toolId: "room:close_pane" | "room:reopen_pane", type: "close_pane" | "reopen_pane") =>
      spaceAgentRoomActionBridgeRequestSchema.parse({
        roomId: room.id,
        missionId: mission.id,
        agentPaneId: agentPane.id,
        agentSessionId: agentSession.sessionId,
        selectedToolIds: [toolId],
        actions: [{ toolId, action: { type, paneId: pane.id } }]
      });

    await executor.execute(request("room:close_pane", "close_pane"), "req:close");
    expect(store.listPanes(room.id)).toEqual([]);
    expect(store.listPanes(room.id, true).find((candidate) => candidate.id === pane.id)?.isClosed).toBe(true);
    await executor.execute(request("room:reopen_pane", "reopen_pane"), "req:reopen");
    expect(store.listPanes(room.id).find((candidate) => candidate.id === pane.id)?.isClosed).toBe(false);
  });
});

describe("Room pane controls", () => {
  it("finds completed tasks in long histories with bounded summaries and paginated exact details", async () => {
    const c = setupMission();
    const pane = c.store.createPane({ roomId: c.room.id, title: "Renamed Chat", mode: "CHAT" });
    const foreign = c.store.createPane({ roomId: c.store.createRoom({ name: "Other", initialPaneCount: 0 }).id, title: "solar", mode: "CHAT" });
    const tasks = Array.from({ length: 100 }, (_, i) => ({ taskId: `task:${i}`, title: `solar plan ${i}`, status: "COMPLETED", timing: {}, modelsUsed: [{ modelId: "native-model", source: "NATIVE" }] }));
    const inspect = vi.fn(async (p: { id: string }) => ({ paneId: p.id, title: pane.title, sessionId: "session:chat", state: "IDLE", tasks }));
    const executor = createRoomActionExecutor({ store: c.store, paneController: { inspect } as never,
      cliTerminalManager: {} as never, spaceAgentAdapter: {} as never, browserSessionManager: {} as never });
    const bridge = (toolId: string, action: unknown) => spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: c.room.id, missionId: c.mission.id,
      agentPaneId: c.agentPane.id, agentSessionId: c.agentSession.sessionId, selectedToolIds: [toolId], actions: [{ toolId, action }] });
    const found = await executor.execute(bridge("room:find", { type: "find", query: "SOLAR" }), "trace:find");
    const matches = found.results[0]!.evidence.matches as any[];
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ paneId: pane.id, matchedTaskCount: 100 });
    expect(matches[0].tasks).toHaveLength(10);
    expect(matches[0].tasks[0].taskId).toBe("task:99");
    expect(inspect.mock.calls.some(([p]) => p.id === foreign.id)).toBe(false);
    const page = await executor.execute(bridge("room:catalog", { type: "catalog", paneId: pane.id, section: "TASKS", query: "solar", offset: 10, limit: 3 }), "trace:page");
    expect(page.results[0]!.evidence).toMatchObject({ total: 100, offset: 10, entries: [{ taskId: "task:89" }, { taskId: "task:88" }, { taskId: "task:87" }] });
  });
  function controls() {
    const context = setupMission();
    const pane = context.store.createPane({ roomId: context.room.id, title: "Worker", mode: "CHAT" });
    const inspect = vi.fn(async () => ({ paneId: pane.id, sessionId: "session:one", state: "IDLE", tasks: [], title: pane.title }));
    const configure = vi.fn(async () => ({ applied: true }));
    const interrupt = vi.fn(async () => ({ interrupted: true }));
    const controller = { inspect, configure, interrupt, catalog: vi.fn(async () => ({ types: [], unavailable: [] })) };
    const build = (enqueueAction?: any) => createRoomActionExecutor({ store: context.store,
      paneController: controller as never, enqueueAction, cliTerminalManager: {} as never,
      spaceAgentAdapter: {} as never, browserSessionManager: {} as never, pollIntervalMs: 1 });
    const bridge = (actions: unknown[], extra = {}) => spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: context.room.id,
      missionId: context.mission.id, agentPaneId: context.agentPane.id, agentSessionId: context.agentSession.sessionId,
      selectedToolIds: ["room:configure_pane", "room:interrupt", "room:layout", "room:open_types"], actions, requestId: "request:controls", ...extra });
    return { ...context, pane, inspect, configure, interrupt, controller, build, bridge };
  }
  it("queues model changes durably, accepts layout immediately, and blocks stale sessions before mutation", async () => {
    const c = controls(), jobs: any[] = [];
    const executor = c.build(async (_id: string, job: unknown) => { jobs.push(job); });
    const request = c.bridge([{ toolId: "room:configure_pane", action: { type: "configure_pane", paneId: c.pane.id, expectedSessionId: "session:one", nativeMode: "plan" } }]);
    const queued = await executor.execute(request, "trace:queue");
    expect(queued.results[0]!.evidence).toMatchObject({ phase: "QUEUED" });
    expect(c.configure).not.toHaveBeenCalled();
    const layout = await executor.execute(c.bridge([{ toolId: "room:layout", action: { type: "layout", paneId: c.pane.id, isMaximized: true } }]), "trace:layout");
    expect(layout.results[0]!.status).toBe("EXECUTED");
    expect(c.store.getPane(c.pane.id).isMaximized).toBe(true);
    c.inspect.mockResolvedValue({ paneId: c.pane.id, sessionId: "session:changed", state: "IDLE", tasks: [], title: c.pane.title });
    expect((await executor.execute({ ...jobs[0], backgroundExecution: true }, "trace:background")).results[0]!.status).toBe("FAILED");
    expect(c.configure).not.toHaveBeenCalled();
  });
  it("keeps uncertain scheduler acknowledgement retryable with the same durable action", async () => {
    const c = controls();
    const enqueue = vi.fn().mockRejectedValueOnce(new Error("Acknowledgement lost")).mockResolvedValue(undefined);
    const executor = c.build(enqueue);
    const request = c.bridge([{ toolId: "room:configure_pane", action: { type: "configure_pane", paneId: c.pane.id, expectedSessionId: "session:one", nativeMode: "plan" } }]);
    await expect(executor.execute(request, "trace:first")).rejects.toThrow("Acknowledgement lost");
    expect(c.store.listRoomAgentActions(c.mission.id)[0]!.status).toBe("QUEUED");
    await executor.execute(request, "trace:retry");
    expect(enqueue.mock.calls[0]![0]).toBe(enqueue.mock.calls[1]![0]);
    expect(c.store.listRoomAgentActions(c.mission.id)).toHaveLength(1);
  });
  it("cancels deferred settings when the operator interrupts the target pane", async () => {
    const c = controls(), jobs: any[] = [];
    const executor = c.build(async (_id: string, job: unknown) => { jobs.push(job); });
    await executor.execute(c.bridge([{ toolId: "room:configure_pane", action: { type: "configure_pane", paneId: c.pane.id, expectedSessionId: "session:one", nativeMode: "plan" } }]), "trace:queue");
    await executor.execute(c.bridge([{ toolId: "room:interrupt", action: { type: "interrupt", paneId: c.pane.id, reason: "Stop now" } }]), "trace:stop");
    expect(c.interrupt).toHaveBeenCalledOnce();
    expect((await executor.execute({ ...jobs[0], backgroundExecution: true }, "trace:late")).results[0]!.status).toBe("BLOCKED");
    expect(c.configure).not.toHaveBeenCalled();
  });
  it("applies NOW only after native interruption is observed and cancels older deferred settings", async () => {
    const c = controls(), jobs: any[] = [];
    const executor = c.build(async (_id: string, job: unknown) => { jobs.push(job); });
    const action = { type: "configure_pane", paneId: c.pane.id, expectedSessionId: "session:one", nativeMode: "plan" };
    await executor.execute(c.bridge([{ toolId: "room:configure_pane", action }]), "trace:deferred");
    await executor.execute(c.bridge([{ toolId: "room:configure_pane", action: { ...action, when: "NOW" } }]), "trace:now");
    let readbacks = 0;
    c.inspect.mockImplementation(async () => ({ paneId: c.pane.id, sessionId: "session:one", state: ++readbacks < 3 ? "RUNNING" : "IDLE", tasks: [], title: c.pane.title }));
    c.configure.mockImplementation(async () => {
      expect(readbacks).toBeGreaterThanOrEqual(3);
      return { applied: true };
    });
    const result = await executor.execute({ ...jobs[1], backgroundExecution: true }, "trace:now-background");
    expect(result.results[0]!.status).toBe("EXECUTED");
    expect(c.interrupt).toHaveBeenCalledOnce();
    expect(c.configure).toHaveBeenCalledOnce();
    expect((await executor.execute({ ...jobs[0], backgroundExecution: true }, "trace:deferred-background")).results[0]!.status).toBe("BLOCKED");
    expect(c.configure).toHaveBeenCalledOnce();
  });
  it("answers a safe approval prompt bound to the inspected question and refuses operator-only approvals", async () => {
    const c = controls(), jobs: any[] = [];
    const command = vi.fn(async () => ({ answered: true }));
    Object.assign(c.controller, { command });
    const executor = c.build(async (_id: string, job: unknown) => { jobs.push(job); });
    const tools = { selectedToolIds: ["room:cli_command"] };
    const screen = (body: string) => `${body}\nDo you want to proceed?\n❯ 1. Yes\n  2. No`;
    const answer = { type: "cli_command", paneId: c.pane.id, expectedSessionId: "session:one", answer: "1", submit: false };
    c.inspect.mockResolvedValue({ paneId: c.pane.id, sessionId: "session:one", state: "WAITING_FOR_INPUT", tasks: [], title: c.pane.title,
      text: screen("Bash: npm test -w @space/api"), promptFingerprint: "0123456789abcdef" } as never);
    await executor.execute(c.bridge([{ toolId: "room:cli_command", action: answer }], tools), "trace:answer");
    expect((await executor.execute({ ...jobs[0], backgroundExecution: true }, "trace:answer-run")).results[0]!.status).toBe("EXECUTED");
    expect(command).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ answer: "1", submit: false, expectedPromptFingerprint: "0123456789abcdef" }), expect.anything());

    c.inspect.mockResolvedValue({ paneId: c.pane.id, sessionId: "session:one", state: "WAITING_FOR_INPUT", tasks: [], title: c.pane.title,
      text: screen("Bash: space-queue promote"), promptFingerprint: "fedcba9876543210" } as never);
    await executor.execute(c.bridge([{ toolId: "room:cli_command", action: { ...answer, answer: "2" } }], { ...tools, requestId: "request:protected" }), "trace:protected");
    expect((await executor.execute({ ...jobs[1], backgroundExecution: true }, "trace:protected-run")).results[0]!.status).toBe("FAILED");
    const refused = c.store.listRoomAgentActions(c.mission.id).at(-1)!;
    expect(refused.statusReason).toContain("Operator approval required");
    expect(refused.statusReason).toContain("stable promotion and queue control");
    expect(command).toHaveBeenCalledOnce();

    // Enter on a protected approval is an answer too; Escape (decline) is not.
    await executor.execute(c.bridge([{ toolId: "room:cli_command", action: { type: "cli_command", paneId: c.pane.id, expectedSessionId: "session:one", key: "ENTER" } }], { ...tools, requestId: "request:enter" }), "trace:enter");
    expect((await executor.execute({ ...jobs[2], backgroundExecution: true }, "trace:enter-run")).results[0]!.status).toBe("FAILED");
    await executor.execute(c.bridge([{ toolId: "room:cli_command", action: { type: "cli_command", paneId: c.pane.id, expectedSessionId: "session:one", key: "ESCAPE" } }], { ...tools, requestId: "request:escape" }), "trace:escape");
    expect((await executor.execute({ ...jobs[3], backgroundExecution: true }, "trace:escape-run")).results[0]!.status).toBe("EXECUTED");
    expect(command).toHaveBeenCalledTimes(2);
  });
  it("preflights all requested types before allocating any pane at capacity", async () => {
    const c = controls();
    while (c.store.listPanes(c.room.id).length < 16) c.store.createPane({ roomId: c.room.id, title: "Existing", mode: "CHAT" });
    c.controller.catalog.mockResolvedValue({ types: [{ id: "chat:codex", title: "Codex", mode: "CHAT" }] as never, unavailable: [] });
    const before = c.store.listPanes(c.room.id).map((pane) => pane.id);
    const result = await c.build().execute(c.bridge([{ toolId: "room:open_types", action: { type: "open_types", kinds: ["CHAT"], input: "Tell a story" } }]), "trace:capacity");
    expect(result.results[0]!.statusReason).toContain("capacity exceeded");
    expect(c.store.listPanes(c.room.id).map((pane) => pane.id)).toEqual(before);
  });
  it("identifies changed runtime availability before allocating any of the requested panes", async () => {
    const c = controls();
    c.controller.catalog.mockResolvedValue({ types: [{ id: "codex", title: "Codex", mode: "CHAT" }] as never,
      unavailable: [{ id: "cli:claude", reason: "Authentication is no longer ready." }] as never });
    const before = c.store.listPanes(c.room.id).map((pane) => pane.id);
    const result = await c.build().execute(c.bridge([{ toolId: "room:open_types", action: {
      type: "open_types", kinds: ["TERMINAL", "CHAT"], runtimeIds: ["codex", "cli:claude", "cli:missing"], input: "Tell a story"
    } }]), "trace:changed-catalog");
    expect(result.results[0]!.status).toBe("FAILED");
    expect(result.results[0]!.statusReason).toContain("cli:claude: Authentication is no longer ready.");
    expect(result.results[0]!.statusReason).toContain("cli:missing: Not advertised for the requested pane kinds.");
    expect(c.store.listPanes(c.room.id).map((pane) => pane.id)).toEqual(before);
  });
});

it("opens fresh CLI and Chat types with their own defaults, broadcasts input, and retains separate runs for repeated requests", async () => {
  const { store, room, agentPane, agentSession, mission } = setupMission();
  const cliPrompts: string[] = [], chatPrompts: string[] = [];
  const createChat = vi.fn(async ({ pane, selectedModelConfigId }: any) => {
    expect(selectedModelConfigId).toBe("opencode:provider/default|medium");
    return { binding: { sessionId: testChatSession(store, pane).sessionId }, runStatus: "IDLE" };
  });
  const executor = createRoomActionExecutor({ store, pollIntervalMs: 1,
    paneController: {
      catalog: async () => ({ types: [
        { id: "cli:codex", title: "Codex", mode: "TERMINAL", terminalRuntimeId: "cli:codex" },
        { id: "chat:opencode", title: "OpenCode Chat", mode: "CHAT", selectedModelConfigId: "opencode:provider/default|medium" }
      ], unavailable: [] }),
      inspect: async () => ({ tasks: [] })
    } as never,
    cliTerminalManager: {
      listRuntimes: async () => ({ data: [{ id: "cli:codex", capabilities: ["CLI"], adapterStatus: "ENABLED", authState: "READY",
        status: "ENABLED", statusReason: "Ready", detectedCommandPath: "/usr/bin/codex", supportedReasoningEfforts: ["high"] }] }),
      ensurePaneControlReady: async (pane: any) => {
        expect(pane.modelId).toBeNull();
        return store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:codex", providerId: "codex", agentId: "codex",
          modelId: "actual-cli-default", reasoningEffort: "high", cwd: "/etc", status: "RUNNING", statusReason: "Ready", isActive: true });
      },
      sendInput: async (_sessionId: string, data: string, _trace: string, marker: string) => {
        if (data !== "\r") cliPrompts.push(data);
        return { turnMarker: marker, markerAtMs: Date.now() };
      },
      getTurnActivity: async () => ({ status: "COMPLETED", turnId: "turn:story" })
    } as never,
    spaceAgentAdapter: { createOrRestoreSession: createChat,
      sendMessage: async ({ pane, content }: any) => { chatPrompts.push(content); return submittedChatResponse(store, pane, content); }, loadSession: async () => ({ runStatus: "IDLE" }) } as never,
    browserSessionManager: {} as never
  });
  const request = spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id, missionId: mission.id, agentPaneId: agentPane.id,
    agentSessionId: agentSession.sessionId, requestId: "request:story-1", selectedToolIds: ["room:open_types"],
    actions: [{ toolId: "room:open_types", action: { type: "open_types", input: "Tell us a story" } }] });
  const first = (await executor.execute(request, "trace:story-1")).results[0]!;
  expect(first.status, first.statusReason).toBe("EXECUTED");
  expect((await executor.execute({ ...request, requestId: "request:story-2" }, "trace:story-2")).results[0]!.status).toBe("EXECUTED");
  expect(store.listPanes(room.id)).toHaveLength(4);
  expect(cliPrompts).toHaveLength(2);
  expect(cliPrompts.every((prompt) => prompt.includes("Tell us a story"))).toBe(true);
  expect(chatPrompts).toEqual(["Tell us a story", "Tell us a story"]);
  expect(store.listRoomAgentTaskRuns(mission.id)).toHaveLength(4);
  expect(new Set(store.listRoomAgentTaskRuns(mission.id).map((run) => run.stepId)).size).toBe(4);
});

it.each(["COMPLETED", "RUNNING", "FAILED", "INTERRUPTED", "REPLACED"] as const)("checks the submitted Chat response even when the pane reports IDLE (%s)", async status => {
  const { store, room, agentPane, agentSession, mission } = setupMission();
  const pane = store.createPane({ roomId: room.id, title: "Chat identity", mode: "CHAT" });
  testChatSession(store, pane);
  const executor = createRoomActionExecutor({ store, pollIntervalMs: 1, actionTimeoutMs: 30,
    cliTerminalManager: {} as never, browserSessionManager: {} as never,
    spaceAgentAdapter: {
      async sendMessage() {
        const result = submittedChatResponse(store, pane, "Tell a story", status === "REPLACED" ? "RUNNING" : status);
        if (status === "REPLACED") {
          // The store refuses to replace a session while its run is busy (fbb80dfed8),
          // so settle the run first; the executor must still notice the new session.
          const runId = (result as { submission: { runId: string } }).submission.runId;
          store.updateSpaceAgentRun(runId, { status: "INTERRUPTED" });
          const original = store.getActiveSpaceAgentSession(pane.id)!;
          store.createSpaceAgentSession({ ...original, sessionId: "agent_session:replacement", collaborationMode: "default" });
        }
        return result;
      },
      loadSession: async () => ({ runStatus: "IDLE", statusReason: "Ready." })
    } as never
  });
  const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id, missionId: mission.id,
    agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId, selectedToolIds: ["room:send"],
    actions: [{ toolId: "room:send", action: { type: "send", paneId: pane.id, input: "Tell a story" } }] });
  const result = (await executor.execute(bridge, "trace:chat-identity")).results[0]!;
  expect(result.status).toBe(status === "COMPLETED" ? "EXECUTED" : "FAILED");
  if (status === "REPLACED") expect(result.statusReason).toContain("session changed");
});


it.each(["READY", "TIMEOUT", "SESSION_CHANGED", "WAITING_FOR_INPUT"] as const)("waits for the newly attached native composer without sending prematurely (%s)", async outcome => {
  const { store, room, agentPane, agentSession, mission } = setupMission();
  const pane = store.createPane({ roomId: room.id, title: "OpenCode startup", mode: "TERMINAL", cwd: "/etc" });
  const session = store.createPaneCliSession({ paneId: pane.id, roomId: room.id, runtimeId: "cli:opencode",
    providerId: "opencode", agentId: "opencode", modelId: "native-default", cwd: "/etc", status: "RUNNING",
    statusReason: "Host attached; native composer is starting.", isActive: true });
  let observations = 0;
  const sendInput = vi.fn(async (_sessionId, _data, _traceId, turnMarker) => {
    expect(observations).toBeGreaterThanOrEqual(3);
    return { turnMarker, markerAtMs: Date.now() };
  });
  const executor = createRoomActionExecutor({ store, pollIntervalMs: 1, actionTimeoutMs: 1000, cliTurnStartGraceMs: 15,
    cliTerminalManager: { sendInput, getTurnActivity: async () => ({ status: "COMPLETED", turnId: "native-task" }) } as never,
    browserSessionManager: {} as never, spaceAgentAdapter: {} as never,
    paneController: { inspect: async () => {
      observations++;
      return { sessionId: outcome === "SESSION_CHANGED" && observations >= 2 ? "replacement-session" : session.sessionId,
        state: observations < 3 || outcome === "TIMEOUT" ? "UNKNOWN" : outcome === "WAITING_FOR_INPUT" ? "WAITING_FOR_INPUT" : "IDLE", tasks: [] };
    } } as never
  });
  const request = spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id, missionId: mission.id,
    agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId, selectedToolIds: ["room:send"],
    actions: [{ toolId: "room:send", action: { type: "send", paneId: pane.id, input: "Write one sentence." } }] });
  const result = (await executor.execute(request, "req:native-startup")).results[0]!;
  if (outcome === "READY") {
    expect(result.status, result.statusReason).toBe("EXECUTED");
    expect(sendInput.mock.calls.map(call => call[1])).toEqual([expect.stringContaining("Write one sentence."), "\r"]);
  } else {
    expect(result.status).toBe("FAILED");
    expect(sendInput).not.toHaveBeenCalled();
    expect(result.statusReason).toContain(outcome === "TIMEOUT" ? "no input was sent" : outcome === "SESSION_CHANGED" ? "session changed" : "WAITING_FOR_INPUT");
  }
});

it.each(["immediate", "late", "missing", "replaced"])("retains interrupted native task timing and model changes (%s)", async phase => {
  const replaced = phase === "replaced";
  const { store, room, agentPane, agentSession, mission } = setupMission();
  const pane = store.createPane({ roomId: room.id, title: "Interrupted task", mode: "CHAT" });
  const initial = submittedChatResponse(store, pane, "Earlier task") as any;
  let tasks: any[] = [];
  let nativeReads = 0;
  const executor = createRoomActionExecutor({ store, pollIntervalMs: 1, nativeFinalEvidenceGraceMs: 15,
    cliTerminalManager: {} as never, browserSessionManager: {} as never,
    paneController: { inspect: async () => {
      if (tasks.length && ++nativeReads >= 2 && phase === "late") {
        const end = new Date().toISOString();
        tasks[0].status = "INTERRUPTED";
        tasks[0].timing.completedAt = end;
        tasks[0].timing.durationMs = Date.parse(end) - Date.parse(tasks[0].timing.startedAt);
        tasks[0].modelsUsed.forEach((usage: any) => { usage.completedAt = end; });
      }
      return { sessionId: replaced ? "session:replacement" : initial.submission.sessionId, tasks };
    } } as never,
    spaceAgentAdapter: { sendMessage: async () => {
      const start = new Date().toISOString();
      tasks = [{ taskId: "native:cancelled", status: "INTERRUPTED", timing: { startedAt: start, completedAt: start, durationMs: 0, source: "NATIVE", observedAt: start },
        modelsUsed: ["first-model", "second-model"].map(modelId => ({ modelId, providerId: "codex", reasoningEffort: "high", turnId: "native:cancelled", startedAt: start, completedAt: start, source: "NATIVE" })) }];
      if (["late", "missing"].includes(phase)) {
        tasks[0].status = "RUNNING";
        tasks[0].timing.completedAt = null;
        tasks[0].timing.durationMs = null;
        tasks[0].modelsUsed.forEach((usage: any) => { usage.completedAt = null; });
      }
      return submittedChatResponse(store, pane, "Wait", "INTERRUPTED");
    } } as never
  });
  const request = spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id, missionId: mission.id,
    agentPaneId: agentPane.id, agentSessionId: agentSession.sessionId, selectedToolIds: ["room:orchestrate"],
    actions: [{ toolId: "room:orchestrate", action: { type: "orchestrate", steps: [{ stepId: "wait", paneId: pane.id, instruction: "Wait", dependsOn: [] }] } }] });
  const result = await executor.execute(request, "trace:interrupted-timeline");
  expect(result.results[0]!.status).toBe("FAILED");
  const run = store.listRoomAgentTaskRuns(mission.id)[0]!;
  expect(run).toMatchObject({ state: "INTERRUPTED", status: "BLOCKED", retries: 0, recoveries: 0 });
  expect(run.timing?.source).toBe(replaced ? "UNKNOWN" : "NATIVE");
  expect(run.modelsUsed?.map(usage => usage.modelId)).toEqual(replaced ? [] : ["first-model", "second-model"]);
  if (["immediate", "late"].includes(phase)) {
    expect(run.timing?.completedAt).toBe(tasks[0].timing.completedAt);
    expect(run.timing?.durationMs).toBe(Date.parse(run.timing!.completedAt!) - Date.parse(run.timing!.startedAt!));
  } else expect(run.timing?.completedAt).toBeNull();
  if (phase === "late") expect(nativeReads).toBeGreaterThanOrEqual(2);
});

it.each(["SENT", "INTENT", "UNCERTAIN", "REPLACED"])("recovers a durable Chat checkpoint without duplicate submission (%s)", async phase => {
  const c = setupMission();
  const pane = c.store.createPane({ roomId: c.room.id, title: "Chat replay", mode: "CHAT" });
  const session = testChatSession(c.store, pane);
  const jobs: any[] = [];
  const sendMessage = vi.fn();
  const options = { store: c.store, pollIntervalMs: 1, actionTimeoutMs: 1000, cliTerminalManager: {} as never,
    browserSessionManager: {} as never, spaceAgentAdapter: { sendMessage } as never };
  const queued = createRoomActionExecutor({ ...options, enqueueAction: async (_id, job) => { jobs.push(job); } });
  const bridge = spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: c.room.id, missionId: c.mission.id,
    agentPaneId: c.agentPane.id, agentSessionId: c.agentSession.sessionId, selectedToolIds: ["room:send"],
    actions: [{ toolId: "room:send", action: { type: "send", paneId: pane.id, input: "Do it once" } }] });
  await queued.execute(bridge, "trace:queued-chat");
  const action = c.store.listRoomAgentActions(c.mission.id)[0]!;
  const workflowId = `workflow:codex-app-server:${c.room.id}:${pane.id}:${action.actionId}:chat`;
  const response = c.store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", status: "COMPLETED", content: "Done" });
  const prompt = c.store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Do it once" });
  const run = c.store.createSpaceAgentRun({ sessionId: session.sessionId, roomId: c.room.id, paneId: pane.id,
    workflowId: phase === "UNCERTAIN" ? "workflow:unrelated" : workflowId, temporalRunId: "temporal:chat", status: "COMPLETED",
    responseMessageId: response.messageId, promptMessageId: prompt.messageId, codexThreadId: null, codexTurnId: null });
  c.store.updateRoomAgentAction(action.actionId, { status: "RUNNING", evidence: { chatSend: { phase: phase === "SENT" ? "SENT" : "INTENT",
    sessionId: phase === "REPLACED" ? "session:previous" : session.sessionId, workflowId, startedAtMs: Date.now(),
    ...(phase === "SENT" ? { runId: run.runId, responseMessageId: response.messageId } : {}) } } });
  const recovered = await createRoomActionExecutor(options).execute({ ...jobs[0], backgroundExecution: true }, "trace:recovered-chat");
  expect(recovered.results[0]!.status).toBe(["SENT", "INTENT"].includes(phase) ? "EXECUTED" : "FAILED");
  expect(sendMessage).not.toHaveBeenCalled();
  expect(c.store.listSpaceAgentMessages(session.sessionId)).toHaveLength(2);
});
