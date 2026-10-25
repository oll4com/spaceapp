import { describe, expect, it } from "vitest";
import { spaceAgentRoomActionBridgeRequestSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomActionExecutor } from "../src/room-actions.js";
import { createDecisionsService } from "../src/decisions-service.js";

describe("Room action failure recovery with Jev", () => {
  it("attaches Jev recovery action recommendation to action failure evidence", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Recovery room", initialPaneCount: 0 });
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
      selectedToolIds: ["room:send"]
    });
    const prompt = store.createSpaceAgentMessage({ sessionId: agentSession.sessionId, role: "user", content: "Test." });
    const response = store.createSpaceAgentMessage({ sessionId: agentSession.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const request = store.createRoomAgentRequest({
      requestId: "room_agent_request:recovery",
      roomId: room.id,
      sessionId: agentSession.sessionId,
      clientRequestId: "recovery-client-0001",
      promptMessageId: prompt.messageId,
      responseMessageId: response.messageId
    });
    const mission = store.createRoomAgentMission({
      id: "room_agent_mission:recovery",
      requestId: request.requestId,
      roomId: room.id,
      sessionId: agentSession.sessionId,
      workflowId: `room-supervisor:${room.id}`,
      status: "RUNNING",
      currentPaneId: agentPane.id,
      statusReason: "Running."
    });

    const mockDecisionsService = createDecisionsService({
      tokenFile: "/mock/token",
      readFileImpl: async () => "mock-token",
      fetch: ((async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          model: "typesafe/jev-1.13",
          answers: {
            action: { type: "choice", choice: "switch_agent" },
            urgency: { type: "noul", noul: 0.85 }
          }
        })
      })) as unknown) as typeof fetch
    });

    const executor = createRoomActionExecutor({
      store,
      cliTerminalManager: {
        sendInput: async () => { throw new Error("Connection reset by peer"); },
        getTurnActivity: async () => ({ status: "IDLE" } as any),
        interrupt: async () => {}
      },
      spaceAgentAdapter: {} as any,
      browserSessionManager: {} as any,
      decisionsService: mockDecisionsService
    });

    const pane = store.createPane({ roomId: room.id, title: "Test Pane", mode: "TERMINAL" });
    const bridgeRequest = spaceAgentRoomActionBridgeRequestSchema.parse({
      roomId: room.id,
      missionId: mission.id,
      agentPaneId: agentPane.id,
      agentSessionId: agentSession.sessionId,
      selectedToolIds: ["room:send"],
      actions: [
        {
          toolId: "room:send",
          action: {
            type: "send",
            paneId: pane.id,
            input: "echo test"
          }
        }
      ]
    });

    const bridgeResult = await executor.execute(bridgeRequest, "trace-recovery-test");
    const result = bridgeResult.results[0]!;
    expect(result.status).toBe("FAILED");
    expect(result.evidence).toBeDefined();
    const evidence = result.evidence as Record<string, any>;
    expect(evidence.recovery).toBeDefined();
    expect(evidence.recovery.action).toBe("switch_agent");
    expect(evidence.recovery.confidence).toBe(0.85);
  });
});
