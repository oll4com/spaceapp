import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CodexAppServerStdioProcess } from "@space/codex-app-server";
import { dummyTurnInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { InMemorySpaceStore, SpaceNotFoundError } from "@space/runtime";
import { executeBrowserActionBridge, parseBrowserActionBlock } from "../src/browser-action-bridge.js";
import { executeMemoryActionBridge } from "../src/memory-action-bridge.js";
import { executeSkillActionBridge } from "../src/skill-action-bridge.js";
import { buildCodexAppServerTurnWorkflowId, buildDummyTurnWorkflowId } from "../src/ids.js";
import {
  markRoomAgentMissionFinished,
  markRoomAgentMissionStarted,
  buildRoomAgentObservationPrompt,
  parseRoomAgentVerificationBlock,
  recordDummyTurnCompleted,
  resolveSpaceArtifactPath,
  runCodexAppServerTurn
} from "../src/activities.js";
import { DEFAULT_TASK_QUEUE, DEFAULT_TEMPORAL_ADDRESS, DEFAULT_TEMPORAL_NAMESPACE } from "../src/constants.js";
import {
  ROOM_AGENT_TURN_ACTIVITY_TIMEOUT,
  ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS,
  ROOM_AGENT_TURN_HEARTBEAT_INTERVAL_MS,
  ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  enqueueRoomAgentMission,
  roomAgentMissionHasContinuation,
  roomAgentMissionCompletion,
  stopRoomAgentMissions
} from "../src/room-supervisor-state.js";
import { executeRoomActionBridge, parseRoomActionBlock } from "../src/room-action-bridge.js";
import { isNativeChatTurn, NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT } from "../src/turn-runtime-policy.js";

const redactionQueryKey = "tok" + "en";
const vscodeRouteFile = "/var/lib/spaceapp-user/.config/codex-lb-vscode-route.json";

class FakeCodexAppServerProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  readonly messages: Array<Record<string, unknown>> = [];

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> } & Record<string, unknown>;
        this.messages.push(message);
        if (message.method === "initialize") {
          this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
        }
        if (message.method === "configRequirements/read") {
          this.emitJson({ id: message.id, result: { requirements: null } });
        }
        if (message.method === "collaborationMode/list") {
          this.emitJson({
            id: message.id,
            result: { data: [{ name: "Plan", mode: "plan", model: "gpt-selected-from-pane", reasoning_effort: "high" }] }
          });
        }
        if (message.method === "thread/start") {
          this.emitJson({ id: message.id, result: { thread: { id: "thread:test-1" } } });
        }
        if (message.method === "thread/resume") {
          this.emitJson({ id: message.id, result: { thread: { id: message.params?.threadId } } });
        }
        if (message.method === "turn/start") {
          this.emitJson({ id: message.id, result: { turn: { id: "turn:test-1", status: "inProgress" } } });
          this.emitJson({
            method: "turn/completed",
            params: {
              threadId: "thread:test-1",
              turn: {
                id: "turn:test-1",
                status: "completed",
                transcript: "do not persist this"
              }
            }
          });
        }
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => {
      this.stdout.emit("data", `${JSON.stringify(message)}\n`);
    });
  }
}

class StaleThreadCodexAppServerProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  readonly messages: Array<Record<string, unknown>> = [];

  constructor(private readonly mode: "stale" | "fresh") {
    super();
  }

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        this.messages.push(message);
        this.respond(message);
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => {
      this.stdout.emit("data", `${JSON.stringify(message)}\n`);
    });
  }

  private respond(message: { id?: number; method?: string; params?: Record<string, unknown> }) {
    if (message.method === "initialize") {
      this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
    }
    if (message.method === "configRequirements/read") {
      this.emitJson({ id: message.id, result: { requirements: null } });
    }
    if (message.method === "thread/start") {
      this.emitJson({ id: message.id, result: { thread: { id: "thread:fresh-1" } } });
    }
    if (message.method === "thread/resume" && this.mode === "stale") {
      this.emitJson({ id: message.id, error: { message: "thread not found: thread:stale-1" } });
    }
    if (message.method === "thread/read" && this.mode === "fresh") {
      this.emitJson({
        id: message.id,
        result: { thread: { id: message.params?.threadId, turns: [] } }
      });
    }
    if (message.method === "turn/start" && this.mode === "fresh") {
      this.emitJson({ id: message.id, result: { turn: { id: "turn:fresh-1", status: "inProgress" } } });
      this.emitJson({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            text: "Recovered on a fresh Codex app-server thread."
          }
        }
      });
      this.emitJson({
        method: "turn/completed",
        params: {
          threadId: "thread:fresh-1",
          turn: { id: "turn:fresh-1", status: "completed" }
        }
      });
    }
    if (message.method === "thread/goal/set" && this.mode === "fresh") {
      const goal = {
        threadId: message.params?.threadId,
        objective: message.params?.objective,
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1
      };
      this.emitJson({ id: message.id, result: { goal } });
      this.emitJson({
        method: "turn/started",
        params: {
          threadId: message.params?.threadId,
          turn: { id: "turn:fresh-goal-1", status: "inProgress" }
        }
      });
      this.emitJson({
        method: "item/completed",
        params: {
          threadId: message.params?.threadId,
          turnId: "turn:fresh-goal-1",
          item: { id: "item:fresh-goal-1", type: "agentMessage", text: "Recovered on a fresh native Chat Goal." }
        }
      });
      this.emitJson({
        method: "thread/goal/updated",
        params: {
          threadId: message.params?.threadId,
          turnId: "turn:fresh-goal-1",
          goal: { ...goal, status: "complete", tokensUsed: 100, timeUsedSeconds: 2, updatedAt: 2 }
        }
      });
      this.emitJson({
        method: "turn/completed",
        params: {
          threadId: message.params?.threadId,
          turn: { id: "turn:fresh-goal-1", status: "completed" }
        }
      });
    }
  }
}

class RecoveredTurnCodexAppServerProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly messages: Array<Record<string, unknown>> = [];
  killed = false;

  constructor(private readonly goalObjective = "Complete the queued room work.") {
    super();
  }

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown> };
        this.messages.push(message);
        if (message.method === "initialize") {
          this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
        }
        if (message.method === "configRequirements/read") {
          this.emitJson({ id: message.id, result: { requirements: null } });
        }
        if (message.method === "thread/resume") {
          this.emitJson({ id: message.id, result: { thread: { id: message.params?.threadId } } });
        }
        if (message.method === "thread/read") {
          this.emitJson({
            id: message.id,
            result: {
              thread: {
                id: message.params?.threadId,
                turns: [{
                  id: "turn:before-worker-restart",
                  status: "completed",
                  items: [{
                    id: "item:recovered-agent-message",
                    type: "agentMessage",
                    text: "Recovered the durable Room Agent turn after worker restart."
                  }]
                }]
              }
            }
          });
        }
        if (message.method === "thread/goal/get") {
          this.emitJson({
            id: message.id,
            result: {
              goal: {
                threadId: message.params?.threadId,
                objective: this.goalObjective,
                status: "complete",
                tokenBudget: null,
                tokensUsed: 1200,
                timeUsedSeconds: 90,
                createdAt: 1,
                updatedAt: 2
              }
            }
          });
        }
        if (message.method === "turn/start") {
          this.emitJson({ id: message.id, result: { turn: { id: "turn:duplicate", status: "inProgress" } } });
          this.emitJson({
            method: "turn/completed",
            params: { threadId: message.params?.threadId, turn: { id: "turn:duplicate", status: "completed" } }
          });
        }
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  private emitJson(message: unknown) {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(message)}\n`));
  }
}

class NativeChatGoalCodexAppServerProcess extends EventEmitter implements CodexAppServerStdioProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly messages: Array<Record<string, unknown>> = [];
  killed = false;
  userInputResponse: unknown = null;
  choiceResolved = false;

  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        const message = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
        };
        this.messages.push(message);
        this.respond(message);
      }
      return true;
    }
  };

  kill(): boolean {
    this.killed = true;
    return true;
  }

  finishGoal(): void {
    this.emitJson({
      method: "item/completed",
      params: {
        threadId: "thread:native-chat-goal",
        turnId: "turn:native-chat-goal-2",
        item: { id: "item:native-final", type: "agentMessage", text: "Native Chat finished the complete task." }
      }
    });
    this.emitJson({
      method: "thread/goal/updated",
      params: {
        threadId: "thread:native-chat-goal",
        turnId: "turn:native-chat-goal-2",
        goal: this.goal("complete")
      }
    });
    this.emitJson({
      method: "turn/completed",
      params: {
        threadId: "thread:native-chat-goal",
        turn: { id: "turn:native-chat-goal-2", status: "completed" }
      }
    });
  }

  private goal(status: "active" | "complete") {
    return {
      threadId: "thread:native-chat-goal",
      objective: "Keep working until everything is finished.",
      status,
      tokenBudget: null,
      tokensUsed: status === "complete" ? 2000 : 0,
      timeUsedSeconds: status === "complete" ? 300 : 0,
      createdAt: 1,
      updatedAt: status === "complete" ? 2 : 1
    };
  }

  private respond(message: {
    id?: number | string;
    method?: string;
    params?: Record<string, unknown>;
    result?: unknown;
  }): void {
    if (message.method === "initialize") {
      this.emitJson({ id: message.id, result: { userAgent: "fake-codex" } });
    }
    if (message.method === "configRequirements/read") {
      this.emitJson({ id: message.id, result: { requirements: null } });
    }
    if (message.method === "thread/start") {
      this.emitJson({ id: message.id, result: { thread: { id: "thread:native-chat-goal" } } });
    }
    if (message.method === "thread/read") {
      const turns: Array<Record<string, unknown>> = [{
        id: "turn:native-chat-goal-1",
        status: this.choiceResolved ? "completed" : "inProgress",
        items: []
      }];
      if (this.choiceResolved) {
        turns.push({ id: "turn:native-chat-goal-2", status: "inProgress", items: [] });
      }
      this.emitJson({
        id: message.id,
        result: { thread: { id: message.params?.threadId ?? "thread:native-chat-goal", turns } }
      });
    }
    if (message.method === "thread/goal/set") {
      this.emitJson({ id: message.id, result: { goal: this.goal("active") } });
      this.emitJson({
        method: "turn/started",
        params: {
          threadId: "thread:native-chat-goal",
          turn: { id: "turn:native-chat-goal-1", status: "inProgress" }
        }
      });
      this.emitJson({
        method: "item/tool/requestUserInput",
        id: "request:native-chat-choice",
        params: {
          threadId: "thread:native-chat-goal",
          turnId: "turn:native-chat-goal-1",
          itemId: "item:native-chat-choice",
          autoResolutionMs: null,
          questions: [{
            id: "continue_choice",
            header: "Continue",
            question: "Should the task continue?",
            isOther: false,
            isSecret: false,
            options: [
              { label: "Continue (Recommended)", description: "Finish the complete task." },
              { label: "Stop", description: "Stop before completion." }
            ]
          }]
        }
      });
    }
    if (message.id === "request:native-chat-choice" && message.result) {
      this.userInputResponse = message.result;
      this.choiceResolved = true;
      this.emitJson({
        method: "turn/completed",
        params: {
          threadId: "thread:native-chat-goal",
          turn: { id: "turn:native-chat-goal-1", status: "completed" }
        }
      });
      this.emitJson({
        method: "turn/started",
        params: {
          threadId: "thread:native-chat-goal",
          turn: { id: "turn:native-chat-goal-2", status: "inProgress" }
        }
      });
    }
  }

  private emitJson(message: unknown): void {
    queueMicrotask(() => this.stdout.emit("data", `${JSON.stringify(message)}\n`));
  }
}

function persistLoopMission(store: InMemorySpaceStore, input: ReturnType<typeof dummyTurnInputSchema.parse>) {
  const request = store.createRoomAgentRequest({
    requestId: `room_agent_request:${input.traceId}`,
    roomId: input.roomId,
    sessionId: input.agentSessionId!,
    clientRequestId: input.traceId,
    promptMessageId: input.agentUserMessageId!,
    responseMessageId: input.agentAssistantMessageId!
  });
  store.createRoomAgentMission({
    id: input.roomAgentMissionId!, requestId: request.requestId,
    roomId: input.roomId, sessionId: input.agentSessionId!,
    workflowId: `room-supervisor:${input.roomId}`, status: "RUNNING",
    currentPaneId: null, statusReason: "Fixture mission is running."
  });
}

function createRoomAgentLoopHarness(
  suffix: string,
  options: { prompt?: string; selectedToolIds?: string[] } = {}
) {
  const prompt = options.prompt ?? "Inspect and verify the room.";
  const selectedToolIds = options.selectedToolIds ?? ["room:inspect"];
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: `Room Agent ${suffix}`, initialPaneCount: 0 });
  const pane = store.getOrCreateRoomAgentPane(room.id);
  const session = store.createSpaceAgentSession({
    paneId: pane.id,
    roomId: room.id,
    title: "Room Agent",
    selectedProviderId: null,
    selectedModelId: "gpt-5.6-sol",
    selectedModelConfigId: "gpt-5.6-sol:high",
    selectedProviderName: null,
    selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high",
    selectedToolIds
  });
  const userMessage = store.createSpaceAgentMessage({
    sessionId: session.sessionId,
    role: "user",
    content: prompt
  });
  const assistantMessage = store.createSpaceAgentMessage({
    sessionId: session.sessionId,
    role: "assistant",
    content: "",
    status: "RUNNING"
  });
  const input = dummyTurnInputSchema.parse({
    roomId: room.id,
    paneId: pane.id,
    prompt,
    modelId: "gpt-5.6-sol",
    reasoningEffort: "high",
    agentSessionId: session.sessionId,
    roomAgentMissionId: `room_agent_mission:${suffix}`,
    agentUserMessageId: userMessage.messageId,
    agentAssistantMessageId: assistantMessage.messageId,
    selectedToolIds,
    traceId: `room-agent-${suffix}-request-0001`
  });
  store.createSpaceAgentRun({
    sessionId: session.sessionId,
    paneId: pane.id,
    roomId: room.id,
    workflowId: buildCodexAppServerTurnWorkflowId(input),
    status: "QUEUED",
    promptMessageId: userMessage.messageId,
    responseMessageId: assistantMessage.messageId
  });
  persistLoopMission(store, input);
  return { store, input };
}

const inspectActionMessage = [
  "I will inspect the live room.",
  "```space-room-actions",
  JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
  "```"
].join("\n");

function executedRoomActionResponse(init?: RequestInit, extraEvidence: Record<string, unknown> = {}): Response {
  const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
  return new Response(
    JSON.stringify({
      id: "space-agent-room-action-bridge",
      results: body.actions.map((request) => ({
        request,
        status: "EXECUTED",
        statusReason: "Fresh room inspection completed.",
        paneId: null,
        missionId: body.missionId,
        evidence: { inspectedAt: "2026-07-11T20:00:00.000Z", ...extraEvidence }
      }))
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("Space Temporal worker foundation", () => {
  it("gives the room supervisor actionable validation paths for repairing an invalid action", () => {
    const result = parseRoomActionBlock("```space-room-actions\n" + JSON.stringify({ version: 1, actions: [
      { toolId: "room:configure_pane", action: { type: "configure_pane", paneId: "pane:proof", modelId: "default" } }
    ] }) + "\n```");
    expect(result.envelope).toBeNull();
    expect(result.error).toContain("actions.0.action.expectedSessionId");
    expect(result.error).not.toContain('"modelId":"default"');
  });
  it("parses only allowlisted room action blocks and sends mission-scoped internal requests", async () => {
    const assistantContent = [
      "I will inspect the room.",
      "```space-room-actions",
      JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
      "```"
    ].join("\n");
    expect(parseRoomActionBlock(assistantContent)).toMatchObject({
      found: true,
      cleanedContent: "I will inspect the room.",
      error: null
    });
    const requests: Array<{ url: string; body: unknown }> = [];
    const result = await executeRoomActionBridge({
      turnInput: dummyTurnInputSchema.parse({
        roomId: "room:bridge",
        paneId: "pane:agent",
        prompt: "Inspect.",
        agentSessionId: "agent_session:bridge",
        roomAgentMissionId: "room_agent_mission:bridge",
        selectedToolIds: ["room:inspect"],
        traceId: "room-agent-bridge-request-0001"
      }),
      assistantContent,
      config: {
        enableCodexTurns: true,
        codexAppServerEnabled: true,
        command: "codex",
        transport: "stdio",
        allowStdioSpawn: true,
        allowTurnExecution: true,
        cwd: "/etc",
        home: null,
        keyFile: null,
        keyEnv: "OPENAI_API_KEY",
        model: null,
        artifactRoot: "/tmp",
        browserToolBridgeEnabled: false,
        mcpToolBridgeEnabled: false,
        internalApiBaseUrl: "http://127.0.0.1:4910",
        internalApiToken: "test-internal-token"
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return new Response(
          JSON.stringify({
            id: "space-agent-room-action-bridge",
            results: [
              {
                request: { toolId: "room:inspect", action: { type: "inspect" } },
                status: "EXECUTED",
                statusReason: "Room inspected.",
                paneId: null,
                missionId: "room_agent_mission:bridge"
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    expect(result).toMatchObject({ cleanedContent: "I will inspect the room.\n\nCompleted: Inspect room and pane activity", executedActionCount: 1 });
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:4910/api/internal/agent/room-actions",
        body: expect.objectContaining({
          roomId: "room:bridge",
          missionId: "room_agent_mission:bridge",
          selectedToolIds: ["room:inspect"]
        })
      }
    ]);
  });

  it("prioritizes open pane transcripts over closed-pane noise in inspection evidence", async () => {
    const turnInput = dummyTurnInputSchema.parse({
      roomId: "room:inspect-open",
      paneId: "pane:agent",
      prompt: "Inspect pending plans.",
      agentSessionId: "agent_session:inspect-open",
      roomAgentMissionId: "room_agent_mission:inspect-open",
      selectedToolIds: ["room:inspect"],
      traceId: "room-agent-inspect-open-0001"
    });
    const closedPanes = Array.from({ length: 183 }, (_, index) => ({
      id: `pane:closed-${index}`,
      title: `Closed pane ${index}`,
      mode: "TERMINAL",
      status: "CLOSED",
      isClosed: true
    }));
    const result = await executeRoomActionBridge({
      turnInput,
      assistantContent: inspectActionMessage,
      config: {
        enableCodexTurns: true, codexAppServerEnabled: true, command: "codex", transport: "stdio",
        allowStdioSpawn: true, allowTurnExecution: true, cwd: "/etc", home: null, keyFile: null,
        keyEnv: "OPENAI_API_KEY", model: null,
        artifactRoot: "/tmp", browserToolBridgeEnabled: false, mcpToolBridgeEnabled: false,
        internalApiBaseUrl: "http://127.0.0.1:4910", internalApiToken: "test-internal-token"
      },
      fetchImpl: async () => new Response(JSON.stringify({
        id: "space-agent-room-action-bridge",
        results: [{
          request: { toolId: "room:inspect", action: { type: "inspect" } },
          status: "EXECUTED",
          statusReason: "Room inspected.",
          paneId: null,
          missionId: turnInput.roomAgentMissionId,
          evidence: {
            panes: [...closedPanes, {
              id: "pane:open-plan",
              title: "Browser Pane Upgrade Plan",
              mode: "TERMINAL",
              status: "IDLE",
              isClosed: false,
              cli: {
                session: { status: "RUNNING", statusReason: "Attached." },
                transcript: [{ content: "Implement this plan? 1. Yes, implement this plan" }]
              }
            }]
          }
        }]
      }), { status: 200, headers: { "content-type": "application/json" } })
    });

    expect(result.toolMessageContent).toContain("inspect panes=184; open=1; closed=183");
    expect(result.toolMessageContent).toContain("Browser Pane Upgrade Plan");
    expect(result.toolMessageContent).toContain("Implement this plan?");
    expect(result.toolMessageContent).not.toContain("Closed pane 182");
  });

  it("propagates a transient room action bridge outage so Temporal can retry after an API restart", async () => {
    const turnInput = dummyTurnInputSchema.parse({
      roomId: "room:bridge-restart",
      paneId: "pane:agent-restart",
      prompt: "Complete the room work across a service restart.",
      agentSessionId: "agent_session:bridge-restart",
      roomAgentMissionId: "room_agent_mission:bridge-restart",
      selectedToolIds: ["room:inspect"],
      traceId: "room-agent-bridge-restart-request-0001"
    });

    await expect(executeRoomActionBridge({
      turnInput,
      assistantContent: inspectActionMessage,
      config: {
        enableCodexTurns: true,
        codexAppServerEnabled: true,
        command: "codex",
        transport: "stdio",
        allowStdioSpawn: true,
        allowTurnExecution: true,
        cwd: "/etc",
        home: null,
        keyFile: null,
        keyEnv: "OPENAI_API_KEY",
        model: null,
        artifactRoot: "/tmp",
        browserToolBridgeEnabled: false,
        mcpToolBridgeEnabled: false,
        internalApiBaseUrl: "http://127.0.0.1:4910",
        internalApiToken: "test-internal-token"
      },
      fetchImpl: async () => {
        throw new TypeError("fetch failed");
      }
    })).rejects.toThrow("temporarily unavailable");
  });

  it("keeps long-running internal room actions independent from the fetch headers timeout", async () => {
    const turnInput = dummyTurnInputSchema.parse({
      roomId: "room:bridge-long-running",
      paneId: "pane:agent-long-running",
      prompt: "Complete the long-running room plan.",
      agentSessionId: "agent_session:bridge-long-running",
      roomAgentMissionId: "room_agent_mission:bridge-long-running",
      selectedToolIds: ["room:inspect"],
      traceId: "room-agent-bridge-long-running-request-0001"
    });
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "space-agent-room-action-bridge",
          results: [{
            request: { toolId: "room:inspect", action: { type: "inspect" } },
            status: "EXECUTED",
            statusReason: "Long-running room action completed.",
            paneId: null,
            missionId: turnInput.roomAgentMissionId,
            evidence: { inspectedAt: "2026-07-12T06:00:00.000Z" }
          }]
        }));
      }, 25);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: new Error("UND_ERR_HEADERS_TIMEOUT") });
    });

    try {
      const result = await executeRoomActionBridge({
        turnInput,
        assistantContent: inspectActionMessage,
        config: {
          enableCodexTurns: true,
          codexAppServerEnabled: true,
          command: "codex",
          transport: "stdio",
          allowStdioSpawn: true,
          allowTurnExecution: true,
          cwd: "/etc",
          home: null,
          keyFile: null,
          keyEnv: "OPENAI_API_KEY",
          model: null,
          artifactRoot: "/tmp",
          browserToolBridgeEnabled: false,
          mcpToolBridgeEnabled: false,
          internalApiBaseUrl: `http://127.0.0.1:${address.port}`,
          internalApiToken: "test-internal-token"
        }
      });

      expect(result).toMatchObject({ executedActionCount: 1 });
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("uses the durable room-action transport through the production turn boundary", async () => {
    const action = {
      toolId: "room:orchestrate" as const,
      action: {
        type: "orchestrate" as const,
        strategy: "AUTO_PARALLEL" as const,
        analysisSummary: "One isolated transport proof.",
        steps: [{
          stepId: "transport-proof",
          paneId: "pane:transport-proof",
          label: "Transport proof",
          instruction: "Print the proof marker.",
          dependsOn: []
        }]
      }
    };
    const assistantContent = [
      "Starting the transport proof.",
      "```space-room-actions",
      JSON.stringify({ version: 1, actions: [action] }),
      "```"
    ].join("\n");
    const harness = createRoomAgentLoopHarness("durable-production-transport", {
      selectedToolIds: ["room:orchestrate"]
    });
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({
          id: "space-agent-room-action-bridge",
          results: [{
            request: action,
            status: "EXECUTED",
            statusReason: "Room action completed with evidence.",
            paneId: null,
            missionId: harness.input.roomAgentMissionId,
            evidence: {
              strategy: "AUTO_PARALLEL",
              peakConcurrency: 1,
              steps: [{ stepId: "transport-proof", status: "EXECUTED" }]
            }
          }]
        }));
      }, 25);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed", { cause: new Error("UND_ERR_HEADERS_TIMEOUT") });
    });

    try {
      const result = await runCodexAppServerTurn(harness.input, {
        completionStore: harness.store,
        env: {
          SPACE_ENABLE_CODEX_TURNS: "true",
          SPACE_CODEX_APP_SERVER_ENABLED: "true",
          SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
          SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
          SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
          SPACE_INTERNAL_API_BASE_URL: `http://127.0.0.1:${address.port}`,
          SPACE_INTERNAL_API_TOKEN: "test-internal-token"
        },
        executeStdioTurn: async () => ({
          threadId: "thread:durable-production-transport",
          turnId: "turn:durable-production-transport",
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: assistantContent
        })
      });

      expect(result).toMatchObject({
        status: "COMPLETED",
        roomAgentOutcome: {
          status: "VERIFIED",
          executedActionCount: 1
        }
      });
    } finally {
      vi.unstubAllGlobals();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("leaves a room-agent activity retryable when its internal action request is cut by an API restart", async () => {
    const harness = createRoomAgentLoopHarness("api-restart-retry");

    await expect(runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async () => {
        throw new TypeError("fetch failed during API restart");
      },
      executeStdioTurn: async () => ({
        threadId: "thread:api-restart-retry",
        turnId: "turn:api-restart-retry",
        turnStatus: "completed",
        notificationCount: 1,
        completedNotificationSeen: true,
        agentMessageText: inspectActionMessage
      })
    })).rejects.toThrow("temporarily unavailable");

    expect(harness.store.getLatestSpaceAgentRun(harness.input.agentSessionId!)).toMatchObject({ status: "RUNNING" });
  });

  it("formats bounded inspect evidence fairly across all panes and preserves each latest tail", async () => {
    const assistantContent = [
      "Inspect every pane.",
      "```space-room-actions",
      JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
      "```"
    ].join("\n");
    const panes = Array.from({ length: 16 }, (_, index) => {
      const number = index + 1;
      const common = {
        id: `pane:evidence-${number}`,
        title: `Evidence Pane ${number}`,
        mode: index % 2 === 0 ? "TERMINAL" : "CHAT",
        status: number === 16 ? "ERROR" : "RUNNING",
        isClosed: number === 15,
        updatedAt: "2026-07-11T20:00:00.000Z"
      };
      if (common.mode === "TERMINAL") {
        return {
          ...common,
          cli: {
            session: { status: common.status, statusReason: `CLI status for pane ${number}` },
            transcript: [
              { sequence: 1, stream: "stdout", content: `${"x".repeat(6_000)} CLI_LATEST_${number} token=raw-secret-${number}` }
            ]
          }
        };
      }
      return {
        ...common,
        ...(number === 2 ? { observation: { runtimeId: "opencode", sessionId: "agent_session:actual-provider",
          state: "RUNNING", modelId: "provider-default", text: "CHAT_LATEST_2", tasks: [] } } : {}),
        chat: {
          session: { status: common.status },
          runStatus: common.status,
          statusReason: `Chat status for pane ${number}`,
          messages: [
            { role: "assistant", status: common.status, content: `${"y".repeat(6_000)} CHAT_LATEST_${number} password=raw-secret-${number}` }
          ]
        }
      };
    });
    const plans = Array.from({ length: 6 }, (_, index) => ({
      paneId: `pane:plan-${index + 1}`,
      paneTitle: `Plan Pane ${index + 1}`,
      sessionId: `cli_session:plan-${index + 1}`,
      threadId: `019f4434-0000-7000-8000-00000000010${index}`,
      status: "READY",
      title: `Active Plan ${index + 1}`,
      updatedAt: "2026-07-12T08:00:00.000Z"
    }));

    const result = await executeRoomActionBridge({
      turnInput: dummyTurnInputSchema.parse({
        roomId: "room:inspect-evidence",
        paneId: "pane:agent",
        prompt: "Inspect all panes.",
        agentSessionId: "agent_session:inspect-evidence",
        roomAgentMissionId: "room_agent_mission:inspect-evidence",
        selectedToolIds: ["room:inspect"],
        traceId: "room-agent-inspect-evidence-request-0001"
      }),
      assistantContent,
      config: {
        enableCodexTurns: true,
        codexAppServerEnabled: true,
        command: "codex",
        transport: "stdio",
        allowStdioSpawn: true,
        allowTurnExecution: true,
        cwd: "/etc",
        home: null,
        keyFile: null,
        keyEnv: "OPENAI_API_KEY",
        model: null,
        artifactRoot: "/tmp",
        browserToolBridgeEnabled: false,
        mcpToolBridgeEnabled: false,
        internalApiBaseUrl: "http://127.0.0.1:4910",
        internalApiToken: "test-internal-token"
      },
      fetchImpl: async () => new Response(
        JSON.stringify({
          id: "space-agent-room-action-bridge",
          results: [{
            request: { toolId: "room:inspect", action: { type: "inspect" } },
            status: "EXECUTED",
            statusReason: "All panes inspected.",
            paneId: null,
            missionId: "room_agent_mission:inspect-evidence",
            evidence: {
              roomInventory: {
                totalPanes: 16,
                plannedPanes: 6,
                pendingPlans: 6,
                readyPlans: 6,
                pausedPlans: 0,
                runningPlans: 0,
                checkedAt: "2026-07-12T08:00:00.000Z",
                plans
              },
              panes
            }
          }]
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    });

    expect(result.toolMessageContent?.length).toBeLessThanOrEqual(12_000);
    for (let number = 1; number <= 16; number += 1) {
      if (number === 15) continue;
      expect(result.toolMessageContent).toContain(`id=pane:evidence-${number}`);
      expect(result.toolMessageContent).toContain(`title=Evidence Pane ${number}`);
      expect(result.toolMessageContent).toContain(`${number % 2 === 1 ? "CLI" : "CHAT"}_LATEST_${number}`);
    }
    expect(result.toolMessageContent).toContain("status=ERROR");
    expect(result.toolMessageContent).toContain("inspect panes=16; open=15; closed=1");
    expect(result.toolMessageContent).toContain("runtime=opencode");
    expect(result.toolMessageContent).toContain('"runtimeId":"opencode"');
    expect(result.toolMessageContent).not.toContain("id=pane:evidence-15");
    expect(result.toolMessageContent).toContain("CHAT_LATEST_16");
    expect(result.toolMessageContent).toContain("password:[REDACTED]");
    expect(result.toolMessageContent).not.toContain("raw-secret-16");
    expect(result.toolMessageContent).toContain("Structured active plan inventory: pending=6; ready=6; paused=0; running=0");
    expect(result.toolMessageContent).toContain("plan 6/6; paneId=pane:plan-6; paneTitle=Plan Pane 6; status=READY; title=Active Plan 6");
    expect(result.toolMessageContent!.indexOf("Structured active plan inventory")).toBeLessThan(
      result.toolMessageContent!.indexOf("pane 1/15")
    );
    expect(result.roomInventory).toMatchObject({ pendingPlans: 6, plans: expect.any(Array) });
  });

  it("keeps a room-agent turn in a bounded multi-pass action loop until final verification", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Room Agent Loop", initialPaneCount: 0 });
    const pane = store.getOrCreateRoomAgentPane(room.id);
    const session = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      title: "Room Agent",
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high",
      selectedToolIds: ["room:inspect", "room:send"]
    });
    const userMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "user",
      content: "Inspect and finish the CLI pane."
    });
    const assistantMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Inspect and finish the CLI pane.",
      modelId: "gpt-5.6-sol",
      reasoningEffort: "high",
      agentSessionId: session.sessionId,
      roomAgentMissionId: "room_agent_mission:multi-pass",
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["room:inspect", "room:send"],
      traceId: "room-agent-multi-pass-request-0001"
    });
    persistLoopMission(store, input);
    store.createSpaceAgentRun({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input),
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const turnPrompts: string[] = [];
    const roomRequests: Array<Record<string, unknown>> = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
        roomRequests.push(...body.actions);
        return new Response(
          JSON.stringify({
            id: "space-agent-room-action-bridge",
            results: body.actions.map((request) => ({
              request,
              status: "EXECUTED",
              statusReason: "Room action completed with durable evidence.",
              paneId: null,
              missionId: body.missionId,
              evidence: { verified: true }
            }))
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      executeStdioTurn: async (turnInput) => {
        turnPrompts.push(turnInput.prompt);
        const messages = [
          [
            "I will inspect first.",
            "```space-room-actions",
            JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
            "```"
          ].join("\n"),
          [
            "The inspection shows pending work, so I will send it now.",
            "```space-room-actions",
            JSON.stringify({
              version: 1,
              actions: [
                { toolId: "room:send", action: { type: "send", paneId: "pane:cli-target", input: "Finish and verify." } }
              ]
            }),
            "```"
          ].join("\n"),
          [
            "The CLI pane appears complete, so I will inspect the live room state now.",
            "```space-room-actions",
            JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
            "```"
          ].join("\n"),
          [
            "The fresh inspection confirms completion.",
            "```space-room-verification",
            JSON.stringify({ version: 1, status: "VERIFIED", summary: "The requested CLI pane work is complete." }),
            "```"
          ].join("\n")
        ];
        const index = turnPrompts.length - 1;
        return {
          threadId: "thread:room-agent-multi-pass",
          turnId: `turn:room-agent-multi-pass-${index + 1}`,
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: messages[index]!
        };
      }
    });

    expect(turnPrompts).toHaveLength(4);
    expect(turnPrompts[1]).toContain("request another allowlisted room or browser action");
    expect(roomRequests).toHaveLength(3);
    expect(result).toMatchObject({
      status: "COMPLETED",
      roomAgentOutcome: {
        status: "VERIFIED",
        executedActionCount: 3
      }
    });
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexTurnId: "turn:room-agent-multi-pass-4"
    });
  });

  it("treats fully executed orchestration steps as authoritative mission completion", async () => {
    const harness = createRoomAgentLoopHarness("authoritative-orchestration", {
      prompt: "Run the ordered room plan.",
      selectedToolIds: ["room:orchestrate"]
    });
    let turns = 0;
    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
        return new Response(
          JSON.stringify({
            id: "space-agent-room-action-bridge",
            results: body.actions.map((request) => ({
              request,
              status: "EXECUTED",
              statusReason: "Ordered orchestration completed.",
              paneId: null,
              missionId: body.missionId,
              evidence: {
                steps: [
                  { paneId: "pane:first", status: "EXECUTED" },
                  { paneId: "pane:second", status: "EXECUTED" }
                ]
              }
            }))
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      executeStdioTurn: async () => {
        turns += 1;
        if (turns > 1) throw new Error("Authoritative orchestration must not require a model verification pass.");
        return {
          threadId: "thread:authoritative-orchestration",
          turnId: "turn:authoritative-orchestration",
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: [
            "Running the ordered plan.",
            "```space-room-actions",
            JSON.stringify({
              version: 1,
              actions: [{
                toolId: "room:orchestrate",
                action: {
                  type: "orchestrate",
                  steps: [
                    { paneId: "pane:first", instruction: "Finish first." },
                    { paneId: "pane:second", instruction: "Then finish second." }
                  ]
                }
              }]
            }),
            "```"
          ].join("\n")
        };
      }
    });

    expect(turns).toBe(1);
    expect(result).toMatchObject({
      status: "COMPLETED",
      roomAgentOutcome: {
        status: "VERIFIED",
        executedActionCount: 1,
        statusReason: expect.stringContaining("durable evidence")
      }
    });
  });

  it("elicits one constrained repair after prose-only and invalid execution-plan replies", async () => {
    const harness = createRoomAgentLoopHarness("prose-action-recovery", {
      prompt: "τρέξε με την σειρά τα πλανα που ειναι σε εκκρεμοτητα αφου ολοκληρωθει το πρωτο τρέχεις το επομενο",
      selectedToolIds: ["room:inspect", "room:orchestrate"]
    });
    const prompts: string[] = [];
    const roomRequests: Array<{ actions: Array<{ toolId: string }> }> = [];
    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<{ toolId: string }> };
        roomRequests.push(body);
        return new Response(JSON.stringify({
          id: "space-agent-room-action-bridge",
          results: body.actions.map((request) => ({
            request,
            status: "EXECUTED",
            statusReason: request.toolId === "room:inspect" ? "Fresh room inspection completed." : "Ordered orchestration completed.",
            paneId: null,
            missionId: body.missionId,
            evidence: request.toolId === "room:inspect"
              ? { panes: [{ paneId: "pane:first", status: "IDLE" }, { paneId: "pane:second", status: "IDLE" }] }
              : { steps: [{ paneId: "pane:first", status: "EXECUTED" }, { paneId: "pane:second", status: "EXECUTED" }] }
          }))
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      executeStdioTurn: async (turnInput) => {
        prompts.push(turnInput.prompt);
        const index = prompts.length - 1;
        const messages = [
          "Η επιθεώρηση ζητήθηκε. Περιμένω το φρέσκο room evidence πριν ξεκινήσω οποιοδήποτε pane.",
          ["Ξεκίνησα τη σειριακή εκτέλεση.", "```space-room-actions", "{\"version\":1,\"actions\":[", "```"].join("\n"),
          ["Βρήκα τις εκκρεμείς εργασίες και τις εκτελώ αυστηρά με τη σειρά.", "```space-room-actions", JSON.stringify({ version: 1, actions: [{ toolId: "room:orchestrate", action: { type: "orchestrate", steps: [{ paneId: "pane:first", instruction: "Finish first." }, { paneId: "pane:second", instruction: "Then finish second." }] } }] }), "```"].join("\n")
        ];
        return {
          threadId: "thread:prose-action-recovery",
          turnId: `turn:prose-action-recovery-${index + 1}`,
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: messages[index]!
        };
      }
    });

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain("Fresh mediated action evidence");
    expect(prompts[2]).toContain("constrained action repair 1 of 1");
    expect(prompts[2]).toContain("execution plan was invalid");
    expect(roomRequests.map((request) => request.actions[0]?.toolId)).toEqual(["room:inspect", "room:orchestrate"]);
    expect(result).toMatchObject({ status: "COMPLETED", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 2 } });
    const assistantMessages = (await harness.store.listSpaceAgentMessages(harness.input.agentSessionId!))
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
    // The bridge appends the mediated action summary to each progress message.
    expect(assistantMessages).toContainEqual(expect.stringContaining("I’m inspecting the live room now so I can act on fresh evidence and keep you updated here."));
    expect(assistantMessages).toContainEqual(expect.stringContaining("Βρήκα τις εκκρεμείς εργασίες και τις εκτελώ αυστηρά με τη σειρά."));
    expect(assistantMessages).toContain("The ordered room work completed successfully, with durable evidence for every step.");
  });

  it("falls back to safe serial orchestration when the model remains prose-only after fresh active-plan evidence", async () => {
    const harness = createRoomAgentLoopHarness("prose-only-fallback", {
      prompt: "Run every active pending plan without replacing any CLI task.",
      selectedToolIds: ["room:inspect", "room:orchestrate", "room:send", "room:interrupt"]
    });
    const prompts: string[] = [];
    const roomRequests: Array<{ actions: Array<Record<string, unknown>> }> = [];
    const plans = [
      {
        paneId: "pane:active-first",
        paneTitle: "Active first",
        sessionId: "cli_session:active-first",
        threadId: "019f4434-0000-7000-8000-000000000201",
        status: "READY",
        title: "First active plan",
        updatedAt: "2026-07-12T08:10:00.000Z"
      },
      {
        paneId: "pane:active-second",
        paneTitle: "Active second",
        sessionId: "cli_session:active-second",
        threadId: "019f4434-0000-7000-8000-000000000202",
        status: "READY",
        title: "Second active plan",
        updatedAt: "2026-07-12T08:11:00.000Z"
      }
    ];

    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
        roomRequests.push(body);
        return new Response(JSON.stringify({
          id: "space-agent-room-action-bridge",
          results: body.actions.map((request) => {
            const toolId = request.toolId;
            const action = request.action as { steps?: Array<{ stepId?: string; paneId: string }> } | undefined;
            return {
              request,
              status: "EXECUTED",
              statusReason: toolId === "room:inspect" ? "Fresh room inspection completed." : "Ordered orchestration completed.",
              paneId: null,
              missionId: body.missionId,
              evidence: toolId === "room:inspect"
                ? {
                    panes: [],
                    roomInventory: {
                      totalPanes: 2,
                      plannedPanes: 2,
                      pendingPlans: 2,
                      readyPlans: 2,
                      pausedPlans: 0,
                      runningPlans: 0,
                      checkedAt: "2026-07-12T08:12:00.000Z",
                      plans
                    }
                  }
                : {
                    steps: (action?.steps ?? []).map((step) => ({
                      stepId: step.stepId,
                      paneId: step.paneId,
                      status: "EXECUTED"
                    }))
                  }
            };
          })
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      executeStdioTurn: async (turnInput) => {
        prompts.push(turnInput.prompt);
        return {
          threadId: "thread:prose-only-fallback",
          turnId: `turn:prose-only-fallback-${prompts.length}`,
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: prompts.length === 1
            ? "Θα επιθεωρήσω πρώτα το room."
            : "Χρειάζεται action-enabled pass για να ξεκινήσουν τα plans."
        };
      }
    });

    expect(prompts).toHaveLength(2);
    expect(roomRequests.map((request) => request.actions[0]?.toolId)).toEqual(["room:inspect", "room:orchestrate"]);
    expect(roomRequests[1]?.actions[0]).toMatchObject({
      toolId: "room:orchestrate",
      action: {
        strategy: "AUTO_PARALLEL",
        steps: [
          { stepId: "active-plan-1", paneId: "pane:active-first", dependsOn: [] },
          { stepId: "active-plan-2", paneId: "pane:active-second", dependsOn: ["active-plan-1"] }
        ]
      }
    });
    expect(result).toMatchObject({
      status: "COMPLETED",
      roomAgentOutcome: { status: "VERIFIED", executedActionCount: 2 }
    });
  });

  it("falls back to orchestration after an initial model-requested inspection returns active plans", async () => {
    const harness = createRoomAgentLoopHarness("initial-inspect-prose-fallback", {
      prompt: "Inspect active plans and start the next safe plan without replacing any CLI task.",
      selectedToolIds: ["room:inspect", "room:orchestrate", "room:send", "room:interrupt"]
    });
    const prompts: string[] = [];
    const roomRequests: Array<{ actions: Array<Record<string, unknown>> }> = [];
    const plan = {
      paneId: "pane:active-plan",
      paneTitle: "Active plan",
      sessionId: "cli_session:active-plan",
      threadId: "019f4434-0000-7000-8000-000000000301",
      status: "READY",
      title: "Active pending plan",
      updatedAt: "2026-07-12T08:20:00.000Z"
    };

    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
        roomRequests.push(body);
        return new Response(JSON.stringify({
          id: "space-agent-room-action-bridge",
          results: body.actions.map((request) => ({
            request,
            status: "EXECUTED",
            statusReason: request.toolId === "room:inspect" ? "Fresh room inspection completed." : "Ordered orchestration completed.",
            paneId: null,
            missionId: body.missionId,
            evidence: request.toolId === "room:inspect"
              ? {
                  panes: [],
                  roomInventory: {
                    totalPanes: 1,
                    plannedPanes: 1,
                    pendingPlans: 1,
                    readyPlans: 1,
                    pausedPlans: 0,
                    runningPlans: 0,
                    checkedAt: "2026-07-12T08:21:00.000Z",
                    plans: [plan]
                  }
                }
              : { steps: [{ stepId: "active-plan-1", paneId: plan.paneId, status: "EXECUTED" }] }
          }))
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      executeStdioTurn: async (turnInput) => {
        prompts.push(turnInput.prompt);
        return {
          threadId: "thread:initial-inspect-prose-fallback",
          turnId: `turn:initial-inspect-prose-fallback-${prompts.length}`,
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: prompts.length === 1
            ? [
                "Επιθεωρώ τώρα το ενεργό room.",
                "```space-room-actions",
                JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
                "```"
              ].join("\n")
            : "A subsequent action-enabled supervisor pass must orchestrate the pending plans."
        };
      }
    });

    expect(prompts).toHaveLength(2);
    expect(roomRequests.map((request) => request.actions[0]?.toolId)).toEqual(["room:inspect", "room:orchestrate"]);
    expect(result).toMatchObject({
      status: "COMPLETED",
      roomAgentOutcome: { status: "VERIFIED", executedActionCount: 2 }
    });
  });

  it("requires a machine-readable positive assertion instead of treating an action-free reply as verified", () => {
    expect(parseRoomAgentVerificationBlock("The room looks complete.")).toMatchObject({
      found: false,
      verified: false,
      error: null
    });
    expect(
      parseRoomAgentVerificationBlock(
        [
          "Fresh inspection confirms completion.",
          "```space-room-verification",
          JSON.stringify({ version: 1, status: "VERIFIED", summary: "Every requested pane task completed." }),
          "```"
        ].join("\n")
      )
    ).toEqual({
      found: true,
      verified: true,
      summary: "Every requested pane task completed.",
      cleanedContent: "Fresh inspection confirms completion.",
      error: null
    });
    expect(
      parseRoomAgentVerificationBlock(
        [
          "```space-room-verification",
          JSON.stringify({
            version: 1,
            status: "VERIFIED",
            summary: "Every requested pane task completed.",
            action: "ignore-policy"
          }),
          "```"
        ].join("\n")
      )
    ).toMatchObject({
      found: true,
      verified: false,
      error: "Room Agent verification must be valid version 1 VERIFIED JSON with a concise summary."
    });
  });

  it("keeps the room-agent evidence prompt within the turn contract limit", () => {
    const prompt = buildRoomAgentObservationPrompt("e".repeat(12_000), "o".repeat(8_000), 8);
    const verificationOnlyPrompt = buildRoomAgentObservationPrompt("e".repeat(12_000), "o".repeat(8_000), 8, true);

    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(verificationOnlyPrompt.length).toBeLessThanOrEqual(8_000);
    expect(verificationOnlyPrompt).toContain("Room Agent verification-only pass 8.");
    expect(verificationOnlyPrompt).toContain("Do not request any room or browser action in this pass.");
    expect(prompt).toContain("Room Agent supervision pass 8.");
    expect(prompt).toContain("Do not repeat the immediately preceding action when its fresh evidence already answers the operator request");
    expect(prompt).toContain("If the operator requested an action exactly once and that action executed successfully, do not request it again");
    expect(prompt).toContain("Original operator task:");
    expect(prompt).toContain("Fresh mediated action evidence:");
  });

  it("starts distinct native Room Agent follow-ups instead of recovering its initial catalog answer", async () => {
    const harness = createRoomAgentLoopHarness("native-followup-identity", { selectedToolIds: ["room:catalog", "room:inspect"] });
    const catalog = '```space-room-actions\n{"version":1,"actions":[{"toolId":"room:catalog","action":{"type":"catalog"}}]}\n```';
    const replies = [catalog, inspectActionMessage, '```space-room-verification\n{"version":1,"status":"VERIFIED","summary":"The native follow-up inspected the room."}\n```'];
    const turns: Array<Record<string, unknown>> = [];
    const nativePrompts: string[] = [];
    const actions: string[] = [];
    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio", SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        actions.push(...JSON.parse(String(init?.body)).actions.map((request: { toolId: string }) => request.toolId));
        return executedRoomActionResponse(init);
      },
      spawnProcess: () => {
        const process = new EventEmitter() as EventEmitter & CodexAppServerStdioProcess;
        const stdout = new EventEmitter();
        const emit = (message: unknown) => queueMicrotask(() => stdout.emit("data", JSON.stringify(message) + "\n"));
        return Object.assign(process, {
          stdout, stderr: new EventEmitter(), kill: () => true,
          stdin: { write: (chunk: string) => {
            for (const line of chunk.split("\n").filter(Boolean)) {
              const message = JSON.parse(line);
              if (message.method === "initialize") emit({ id: message.id, result: { userAgent: "native-followup-fixture" } });
              if (message.method === "configRequirements/read") emit({ id: message.id, result: { requirements: null } });
              if (["thread/start", "thread/resume"].includes(message.method)) emit({ id: message.id, result: { thread: { id: "thread:native-followup" } } });
              if (message.method === "thread/read") emit({ id: message.id, result: { thread: { id: "thread:native-followup", turns } } });
              if (message.method === "turn/start") {
                const prompt = message.params.input.map((part: { text?: string }) => part.text ?? "").join("\n");
                const text = replies[nativePrompts.length] ?? replies[2];
                nativePrompts.push(prompt);
                const turn = { id: `turn:native-followup-${nativePrompts.length}`, status: "completed", items: [
                  { id: "input", type: "userMessage", content: prompt }, { id: "reply", type: "agentMessage", text }
                ] };
                turns.push(turn);
                emit({ id: message.id, result: { turn: { id: turn.id, status: "inProgress" } } });
                emit({ method: "item/completed", params: { threadId: "thread:native-followup", turnId: turn.id, item: turn.items[1] } });
                emit({ method: "turn/completed", params: { threadId: "thread:native-followup", turn } });
              }
            }
            return true;
          } }
        });
      }
    });
    expect(nativePrompts).toHaveLength(3);
    expect(actions).toEqual(["room:catalog", "room:inspect"]);
    expect(nativePrompts[1]).toContain("Fresh mediated action evidence:");
    expect(result.roomAgentOutcome).toMatchObject({ status: "VERIFIED", executedActionCount: 2 });
  });

  it("retains the complete operator task after long supervisor context on every follow-up", () => {
    const request = "Create CLI and Chat panes using defaults. " + "x".repeat(3900);
    const original = "Supervisor context. ".repeat(200) + "\n\nOperator request:\n" + request;
    for (const verificationOnly of [false, true]) {
      for (const explicitRequest of [undefined, request]) {
        for (const repair of ["", "Validation errors. ".repeat(1000)]) {
          const prompt = buildRoomAgentObservationPrompt("native evidence ".repeat(1000), original, 8, verificationOnly, explicitRequest, repair);
          expect(prompt).toContain(request);
          expect(prompt).toContain("native evidence");
          expect(prompt.length).toBeLessThanOrEqual(8000);
        }
      }
    }
  });

  it("requires a post-evidence turn after an inspect reports RUNNING", async () => {
    const harness = createRoomAgentLoopHarness("post-evidence-running");
    const prompts: string[] = [];
    let inspectCount = 0;
    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        inspectCount += 1;
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
        const paneStatus = inspectCount === 1 ? "RUNNING" : "COMPLETED";
        return new Response(
          JSON.stringify({
            id: "space-agent-room-action-bridge",
            results: body.actions.map((request) => ({
              request,
              status: "EXECUTED",
              statusReason: `Fresh inspection observed pane status ${paneStatus}.`,
              paneId: null,
              missionId: body.missionId,
              evidence: { paneStatus }
            }))
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      executeStdioTurn: async (turnInput) => {
        prompts.push(turnInput.prompt);
        const messages = [
          inspectActionMessage,
          [
            "The prior evidence still says RUNNING, so I must inspect again.",
            "```space-room-actions",
            JSON.stringify({ version: 1, actions: [{ toolId: "room:inspect", action: { type: "inspect" } }] }),
            "```",
            "```space-room-verification",
            JSON.stringify({ version: 1, status: "VERIFIED", summary: "This assertion is premature." }),
            "```"
          ].join("\n"),
          [
            "The immediately preceding evidence now says COMPLETED.",
            "```space-room-verification",
            JSON.stringify({ version: 1, status: "VERIFIED", summary: "The room is now complete." }),
            "```"
          ].join("\n")
        ];
        const index = prompts.length - 1;
        return {
          threadId: "thread:post-evidence-running",
          turnId: `turn:post-evidence-running-${index + 1}`,
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: messages[index]!
        };
      }
    });

    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('paneStatus":"RUNNING');
    expect(prompts[2]).toContain('paneStatus":"COMPLETED');
    expect(inspectCount).toBe(2);
    expect(result).toMatchObject({
      status: "COMPLETED",
      roomAgentOutcome: {
        status: "VERIFIED",
        executedActionCount: 2,
        statusReason: "The room is now complete."
      }
    });
  });

  it("rejects prose-only completion and verifies a repeated completed inspection without re-executing it", async () => {
    const proseHarness = createRoomAgentLoopHarness("prose-only-verification");
    let proseTurns = 0;
    const proseResult = await runCodexAppServerTurn(proseHarness.input, {
      completionStore: proseHarness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      // The inspection shows a running pane, so prose alone cannot complete the
      // turn. (An inspection with no active work is an informational turn and
      // is verified; see activities.ts.)
      browserActionFetch: async (_url, init) => executedRoomActionResponse(init, { panes: [{ id: "pane:busy", status: "RUNNING" }] }),
      executeStdioTurn: async () => {
        proseTurns += 1;
        return {
          threadId: "thread:prose-only",
          turnId: `turn:prose-only-${proseTurns}`,
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: proseTurns === 1 ? inspectActionMessage : "Everything looks complete."
        };
      }
    });

    expect(proseTurns).toBe(3);
    expect(proseResult).toMatchObject({
      status: "FAILED",
      roomAgentOutcome: {
        status: "UNVERIFIED",
        executedActionCount: 1,
        statusReason: expect.stringContaining("after one constrained repair")
      }
    });

    const repeatedHarness = createRoomAgentLoopHarness("repeated-inspection");
    let repeatedTurns = 0;
    let repeatedInspections = 0;
    const repeatedTurnInputs: Array<{ prompt: string; agentThreadId: string | null | undefined; selectedToolIds: string[] | null | undefined }> = [];
    const repeatedResult = await runCodexAppServerTurn(repeatedHarness.input, {
      completionStore: repeatedHarness.store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        repeatedInspections += 1;
        const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
        return new Response(
          JSON.stringify({
            id: "space-agent-room-action-bridge",
            results: body.actions.map((request) => ({
              request,
              status: "EXECUTED",
              statusReason: "Fresh room inspection completed.",
              paneId: null,
              missionId: body.missionId,
              evidence: {
                panes: [
                  {
                    id: "pane:open-idle",
                    mode: "TERMINAL",
                    isClosed: false,
                    status: "IDLE",
                    cli: { session: { status: "RUNNING" } }
                  },
                  {
                    id: "pane:closed-history",
                    isClosed: true,
                    status: "CLOSED",
                    chat: { messages: [{ status: "RUNNING", content: "Historical completed run." }] }
                  }
                ]
              }
            }))
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      executeStdioTurn: async (turnInput) => {
        repeatedTurns += 1;
        repeatedTurnInputs.push({
          prompt: turnInput.prompt,
          agentThreadId: turnInput.agentThreadId,
          selectedToolIds: turnInput.selectedToolIds
        });
        return {
          threadId: "thread:repeated-inspection",
          turnId: `turn:repeated-inspection-${repeatedTurns}`,
          turnStatus: "completed",
          notificationCount: 1,
          completedNotificationSeen: true,
          agentMessageText: repeatedTurns < 3
            ? inspectActionMessage
            : [
                "The fresh inspection proves the requested read-only check completed.",
                "```space-room-verification",
                JSON.stringify({ version: 1, status: "VERIFIED", summary: "The room inspection completed once." }),
                "```"
              ].join("\n")
        };
      }
    });

    expect(repeatedTurns).toBe(3);
    expect(repeatedInspections).toBe(1);
    expect(repeatedTurnInputs[1]).toMatchObject({ agentThreadId: "thread:repeated-inspection" });
    expect(repeatedTurnInputs[2]).toMatchObject({ agentThreadId: null, selectedToolIds: [] });
    expect(repeatedTurnInputs[2]?.prompt).toContain("Room Agent verification-only pass 2.");
    expect(repeatedResult).toMatchObject({
      status: "COMPLETED",
      roomAgentOutcome: {
        status: "VERIFIED",
        executedActionCount: 1,
        statusReason: "The room inspection completed once."
      }
    });
    expect(repeatedHarness.store.getLatestSpaceAgentRun(repeatedHarness.input.agentSessionId!)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:repeated-inspection",
      codexTurnId: "turn:repeated-inspection-2"
    });
  });

  it("reports missing durable state without blaming the CLI executable or exposing private IDs", async () => {
    const harness = createRoomAgentLoopHarness("missing-durable-state");
    vi.spyOn(harness.store, "listRoomAgentActions").mockImplementation(() => {
      throw new SpaceNotFoundError("Room agent mission private-state-id was not found.");
    });
    const result = await runCodexAppServerTurn(harness.input, {
      completionStore: harness.store,
      env: { SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio", SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token" },
      browserActionFetch: async (_url, init) => executedRoomActionResponse(init),
      executeStdioTurn: async () => ({ threadId: "thread:missing-state", turnId: "turn:missing-state", turnStatus: "completed",
        notificationCount: 1, completedNotificationSeen: true, agentMessageText: inspectActionMessage })
    });
    expect(result).toMatchObject({ status: "FAILED", roomAgentOutcome: { status: "UNVERIFIED",
      statusReason: expect.stringContaining("Required Space execution state was not found") } });
    expect(result.message).not.toMatch(/private-state-id|command could not be started/);
  });

  it.each(["WORKER_SHUTDOWN", "TIMED_OUT", "CANCELLED"])("propagates %s during a supervisor verification turn", async reason => {
    const harness = createRoomAgentLoopHarness(`verification-cancel-${reason}`);
    const controller = new AbortController();
    let turns = 0;
    await expect(runCodexAppServerTurn(harness.input, {
      completionStore: harness.store, abortSignal: controller.signal,
      env: { SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio", SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true", SPACE_INTERNAL_API_TOKEN: "test-internal-token" },
      browserActionFetch: async (_url, init) => executedRoomActionResponse(init),
      executeStdioTurn: async () => {
        if (++turns > 1) { controller.abort(new Error(reason)); throw controller.signal.reason; }
        return { threadId: "thread:verification-cancel", turnId: "turn:verification-cancel", turnStatus: "completed",
          notificationCount: 1, completedNotificationSeen: true, agentMessageText: inspectActionMessage };
      }
    })).rejects.toThrow(reason);
    expect(turns).toBe(2);
    expect(harness.store.getLatestSpaceAgentRun(harness.input.agentSessionId!)?.status)
      .toBe(reason === "CANCELLED" ? "INTERRUPTED" : "RUNNING");
  });

  it("deduplicates queued supervisor signals and records queued stops without losing later work", () => {
    const first = roomAgentSupervisorQueueItemSchema.parse({
      missionId: "room_agent_mission:queue-1",
      turn: {
        roomId: "room:queue",
        paneId: "pane:agent",
        prompt: "First",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        traceId: "room-agent-queue-request-0001"
      }
    });
    const second = roomAgentSupervisorQueueItemSchema.parse({
      ...first,
      missionId: "room_agent_mission:queue-2",
      turn: { ...first.turn, prompt: "Second", traceId: "room-agent-queue-request-0002" }
    });

    expect(enqueueRoomAgentMission([first], null, first)).toEqual([first]);
    expect(enqueueRoomAgentMission([first], first.missionId, second)).toEqual([first, second]);
    expect(stopRoomAgentMissions([second], first.missionId, { missionId: first.missionId, reason: "Stop first." })).toEqual({
      pending: [second],
      interrupted: [],
      shouldCancelActive: true
    });
    expect(stopRoomAgentMissions([second], first.missionId, { missionId: second.missionId, reason: "Drop queued." })).toEqual({
      pending: [],
      interrupted: [second],
      shouldCancelActive: false
    });
  });

  it("queues distinct follow-up turns behind the active mission without creating another goal", () => {
    const first = roomAgentSupervisorQueueItemSchema.parse({
      missionId: "room_agent_mission:active-goal",
      turn: {
        roomId: "room:follow-up",
        paneId: "pane:agent",
        prompt: "Run every plan.",
        modelId: "gpt-5.6-sol",
        reasoningEffort: "high",
        agentRunId: "agent_run:initial",
        traceId: "room-agent-follow-up-request-0001"
      }
    });
    const followUp = roomAgentSupervisorQueueItemSchema.parse({
      missionId: first.missionId,
      turn: {
        ...first.turn,
        prompt: "Also verify the mobile pane.",
        agentRunId: "agent_run:follow-up",
        traceId: "room-agent-follow-up-request-0002"
      }
    });

    expect(enqueueRoomAgentMission([], first.missionId, followUp)).toEqual([followUp]);
    expect(enqueueRoomAgentMission([followUp], first.missionId, followUp)).toEqual([followUp]);
    expect(roomAgentMissionHasContinuation([followUp], first.missionId)).toBe(true);
  });

  it("requires verified room-action evidence before a supervisor mission can complete", () => {
    const base = {
      workflowId: "workflow:room-supervisor-evidence",
      roomId: "room:supervisor-evidence",
      paneId: "pane:supervisor-evidence",
      traceId: "room-supervisor-evidence-request-0001",
      message: "Turn finished."
    } as const;

    expect(roomAgentMissionCompletion({ ...base, status: "COMPLETED" })).toMatchObject({
      status: "FAILED",
      statusReason: expect.stringContaining("verified room-action evidence")
    });
    expect(
      roomAgentMissionCompletion({
        ...base,
        status: "COMPLETED",
        roomAgentOutcome: {
          status: "VERIFIED",
          executedActionCount: 2,
          statusReason: "All pane work completed."
        }
      })
    ).toEqual({ status: "COMPLETED", statusReason: "All pane work completed." });
    expect(
      roomAgentMissionCompletion({
        ...base,
        status: "FAILED",
        roomAgentOutcome: {
          status: "UNVERIFIED",
          executedActionCount: 1,
          statusReason: "A pane action failed."
        }
      })
    ).toEqual({ status: "FAILED", statusReason: "A pane action failed." });
    expect(ROOM_AGENT_TURN_ACTIVITY_TIMEOUT).toBe("24 hours");
    expect(NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT).toBe("36500 days");
    expect(ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS).toBeGreaterThan(1);
  });

  it("starts a native turn in the pane workspace without mutating the frozen process environment", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Owned workspace turn", initialPaneCount: 0 });
    const pane = store.createPane({ roomId: room.id, mode: "CHAT", title: "Workspace turn", cwd: "/srv/project with spaces" });
    const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Workspace turn",
      selectedProviderId: null, selectedModelId: null, selectedModelConfigId: null,
      selectedProviderName: null, selectedModelName: null, selectedReasoningKey: null });
    const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: "Verify the workspace turn.", traceId: "trace:workspace-turn",
      agentSessionId: session.sessionId, agentUserMessageId: "agent_msg:workspace-user", agentAssistantMessageId: "agent_msg:workspace-answer" });
    store.createSpaceAgentSubmission({ content: input.prompt, run: { sessionId: session.sessionId, paneId: pane.id, roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input), status: "QUEUED", promptMessageId: input.agentUserMessageId!, responseMessageId: input.agentAssistantMessageId! } });
    const process = new FakeCodexAppServerProcess();
    let spawned = false;
    const result = await runCodexAppServerTurn(input, { completionStore: store, env: {
      SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true",
      SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true", SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
    }, spawnProcess: (_command, _args, options) => {
      spawned = true;
      expect(options.cwd).toBe(pane.cwd);
      expect(options.env.SPACE_CLI_WORKSPACE).toBe(pane.cwd);
      expect(Object.isFrozen(options.env)).toBe(true);
      return process;
    } });
    expect(spawned).toBe(true);
    expect(result.status).toBe("COMPLETED");
  });

  it("keeps Room Agent turns on the bounded non-Goal protocol", async () => {
    const process = new FakeCodexAppServerProcess();
    const input = dummyTurnInputSchema.parse({
      roomId: "room:bounded-room-agent",
      paneId: "pane:bounded-room-agent",
      prompt: "Inspect the room once.",
      agentSessionId: "agent_session:bounded-room-agent",
      roomAgentMissionId: "room_agent_mission:bounded-room-agent",
      agentUserMessageId: "agent_msg:bounded-room-agent-user",
      agentAssistantMessageId: "agent_msg:bounded-room-agent-assistant",
      traceId: "trace:bounded-room-agent"
    });

    expect(isNativeChatTurn(input)).toBe(false);
    await runCodexAppServerTurn(input, {
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      spawnProcess: () => process
    });

    expect(process.messages.some((message) => message.method === "turn/start")).toBe(true);
    expect(process.messages.some((message) => message.method === "thread/goal/set")).toBe(false);
  });

  it("checkpoints room-agent mission start and completion for restart recovery", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Supervisor", initialPaneCount: 0 });
    const pane = store.getOrCreateRoomAgentPane(room.id);
    const session = store.createSpaceAgentSession({
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
    const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Finish the room." });
    const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const request = store.createRoomAgentRequest({
      requestId: "room_agent_request:worker",
      roomId: room.id,
      sessionId: session.sessionId,
      clientRequestId: "room-agent-worker-request-0001",
      promptMessageId: prompt.messageId,
      responseMessageId: response.messageId
    });
    const mission = store.createRoomAgentMission({
      id: "room_agent_mission:worker",
      requestId: request.requestId,
      roomId: room.id,
      sessionId: session.sessionId,
      workflowId: `room-supervisor:${room.id}`,
      status: "QUEUED",
      currentPaneId: null,
      statusReason: "Mission queued."
    });

    await markRoomAgentMissionStarted({ missionId: mission.id, roomId: room.id, paneId: pane.id }, store);
    await markRoomAgentMissionFinished(
      { missionId: mission.id, roomId: room.id, status: "COMPLETED", statusReason: "Mission completed." },
      store
    );

    expect(store.listRoomAgentMissions(room.id)[0]).toMatchObject({
      status: "COMPLETED",
      currentPaneId: null,
      statusReason: "Mission completed.",
      startedAt: expect.any(String),
      completedAt: expect.any(String)
    });
  });

  it("checkpoints child completion without changing a paused goal to failed or interrupted", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Paused supervisor", initialPaneCount: 0 });
    const pane = store.getOrCreateRoomAgentPane(room.id);
    const session = store.createSpaceAgentSession({
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
    const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Finish the room." });
    const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
    const request = store.createRoomAgentRequest({
      requestId: "room_agent_request:worker-paused",
      roomId: room.id,
      sessionId: session.sessionId,
      clientRequestId: "room-agent-worker-paused-0001",
      promptMessageId: prompt.messageId,
      responseMessageId: response.messageId
    });
    const mission = store.createRoomAgentMission({
      id: "room_agent_mission:worker-paused",
      requestId: request.requestId,
      roomId: room.id,
      sessionId: session.sessionId,
      workflowId: `room-supervisor:${room.id}`,
      status: "PAUSED",
      currentPaneId: pane.id,
      pausedAt: new Date().toISOString(),
      statusReason: "Paused by operator."
    });

    await markRoomAgentMissionFinished(
      { missionId: mission.id, roomId: room.id, status: "COMPLETED", statusReason: "Mission completed." },
      store
    );

    expect(store.getRoomAgentMission(room.id, mission.id)).toMatchObject({
      status: "PAUSED",
      completedAt: null,
      executionState: {
        pendingCompletion: { status: "COMPLETED", statusReason: "Mission completed.", completedAt: expect.any(String) }
      }
    });
  });

  it("uses explicit local Temporal defaults", () => {
    expect(DEFAULT_TEMPORAL_ADDRESS).toBe("127.0.0.1:7233");
    expect(DEFAULT_TEMPORAL_NAMESPACE).toBe("default");
    expect(DEFAULT_TASK_QUEUE).toBe("space-agent-turns");
  });

  it("builds deterministic dummy turn workflow ids", async () => {
    const input = dummyTurnInputSchema.parse({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      prompt: "prove the worker path",
      traceId: "trace:test-1"
    });

    expect(buildDummyTurnWorkflowId(input)).toBe("workflow:dummy:room:test-1:pane:test-1:trace:test-1");
    expect(buildCodexAppServerTurnWorkflowId(input)).toBe("workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1");
    await expect(recordDummyTurnCompleted(input)).resolves.toMatchObject({
      workflowId: "workflow:dummy:room:test-1:pane:test-1:trace:test-1",
      status: "COMPLETED",
      traceId: "trace:test-1"
    });
  });

  it("keeps the Codex App Server activity fail-closed until all execution gates are enabled", async () => {
    const input = dummyTurnInputSchema.parse({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      prompt: "prove fail closed",
      traceId: "trace:test-1"
    });

    await expect(
      runCodexAppServerTurn(input, {
        env: {},
        executeStdioTurn: async () => {
          throw new Error("executor must not run while gates are closed");
        }
      })
    ).resolves.toMatchObject({
      workflowId: "workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1",
      status: "FAILED",
      message: expect.stringContaining("SPACE_ENABLE_CODEX_TURNS=true")
    });
  });

  it("propagates activity cancellation instead of converting a stopped turn into a normal failure", async () => {
    const controller = new AbortController();
    let markExecutorStarted: (() => void) | null = null;
    const executorStarted = new Promise<void>((resolve) => {
      markExecutorStarted = resolve;
    });
    const input = dummyTurnInputSchema.parse({
      roomId: "room:cancel-active-turn",
      paneId: "pane:cancel-active-turn",
      prompt: "wait until stopped",
      traceId: "cancel-active-room-agent-request-0001"
    });
    const running = runCodexAppServerTurn(input, {
      abortSignal: controller.signal,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async () => {
        markExecutorStarted?.();
        return new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        });
      }
    });
    await executorStarted;

    controller.abort(new Error("Temporal cancellation requested."));

    await expect(running).rejects.toThrow("Temporal cancellation requested.");
  });

  it("heartbeats throughout a long Codex activity so Temporal can deliver Stop cancellation", async () => {
    vi.useFakeTimers();
    let finishExecutor: (() => void) | null = null;
    const heartbeats: unknown[] = [];
    const input = dummyTurnInputSchema.parse({
      roomId: "room:heartbeat-active-turn",
      paneId: "pane:heartbeat-active-turn",
      prompt: "stay alive until Temporal cancellation arrives",
      traceId: "heartbeat-room-agent-request-0001"
    });

    try {
      const running = runCodexAppServerTurn(input, {
        heartbeat: (details) => heartbeats.push(details),
        heartbeatIntervalMs: ROOM_AGENT_TURN_HEARTBEAT_INTERVAL_MS,
        env: {
          SPACE_ENABLE_CODEX_TURNS: "true",
          SPACE_CODEX_APP_SERVER_ENABLED: "true",
          SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
          SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
          SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
        },
        executeStdioTurn: async () => {
          await new Promise<void>((resolve) => {
            finishExecutor = resolve;
          });
          return {
            threadId: "thread:heartbeat",
            turnId: "turn:heartbeat",
            turnStatus: "completed",
            notificationCount: 1,
            completedNotificationSeen: true
          };
        }
      });
      await vi.advanceTimersByTimeAsync(ROOM_AGENT_TURN_HEARTBEAT_INTERVAL_MS * 2 + 1);

      expect(heartbeats.length).toBeGreaterThanOrEqual(3);
      expect(ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT).toBe("15 seconds");
      finishExecutor?.();
      await expect(running).resolves.toMatchObject({ status: "COMPLETED" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns completed only when explicit Codex App Server execution gates and completion evidence are present", async () => {
    const input = dummyTurnInputSchema.parse({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      prompt: "this prompt must not be persisted in the activity result",
      traceId: "trace:test-1"
    });

    const result = await runCodexAppServerTurn(input, {
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async () => ({
        threadId: "thread:test-1",
        turnId: "turn:test-1",
        turnStatus: "completed",
        notificationCount: 3,
        completedNotificationSeen: true
      })
    });

    expect(result).toMatchObject({
      workflowId: "workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1",
      status: "COMPLETED",
      message: "Codex App Server turn completed."
    });
    expect(JSON.stringify(result)).not.toContain("this prompt must not be persisted");
  });

  it("records specific sanitized Codex executor failures instead of the old placeholder", async () => {
    const input = dummyTurnInputSchema.parse({
      roomId: "room:executor-failure-1",
      paneId: "pane:executor-failure-1",
      prompt: "this prompt must not leak when the executor fails",
      traceId: "trace:executor-failure-1"
    });

    const result = await runCodexAppServerTurn(input, {
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async () => {
        throw new Error("Codex App Server thread and turn session timed out.");
      }
    });

    expect(result).toMatchObject({
      workflowId: "workflow:codex-app-server:room:executor-failure-1:pane:executor-failure-1:trace:executor-failure-1",
      status: "FAILED",
      message: expect.stringContaining("timed out")
    });
    expect(result.message).not.toContain("not available yet");
    expect(JSON.stringify(result)).not.toContain("this prompt must not leak");
  });

  it("retries on a fresh Codex App Server thread when the saved thread id is stale", async () => {
    const input = dummyTurnInputSchema.parse({
      roomId: "room:stale-thread-1",
      paneId: "pane:stale-thread-1",
      prompt: "continue this Space agent session",
      agentThreadId: "thread:stale-1",
      traceId: "trace:stale-thread-1"
    });
    const processes: StaleThreadCodexAppServerProcess[] = [];

    const result = await runCodexAppServerTurn(input, {
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      spawnProcess: () => {
        const process = new StaleThreadCodexAppServerProcess(processes.length === 0 ? "stale" : "fresh");
        processes.push(process);
        return process;
      }
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      message: "Recovered on a fresh Codex app-server thread."
    });
    expect(processes).toHaveLength(2);
    expect(processes[0]?.messages).toContainEqual(
      expect.objectContaining({
        method: "thread/resume",
        params: expect.objectContaining({ threadId: "thread:stale-1" })
      })
    );
    expect(processes[1]?.messages).toContainEqual(expect.objectContaining({ method: "thread/start" }));
  });

  it("clears a stale durable turn id when native Chat falls back to a fresh thread", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Stale native Chat", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      title: "Native Chat",
      threadId: "thread:stale-1",
      selectedProviderId: null,
      selectedModelId: null,
      selectedModelConfigId: null,
      selectedProviderName: null,
      selectedModelName: null,
      selectedReasoningKey: null
    });
    const promptMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "user",
      content: "continue this native Chat task"
    });
    const responseMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "continue this native Chat task",
      agentSessionId: session.sessionId,
      agentUserMessageId: promptMessage.messageId,
      agentAssistantMessageId: responseMessage.messageId,
      agentThreadId: "thread:stale-1",
      traceId: "trace:stale-native-chat"
    });
    store.createSpaceAgentRun({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input),
      status: "RUNNING",
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId,
      codexThreadId: "thread:stale-1",
      codexTurnId: "turn:stale-1"
    });
    const processes: StaleThreadCodexAppServerProcess[] = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      spawnProcess: () => {
        const process = new StaleThreadCodexAppServerProcess(processes.length === 0 ? "stale" : "fresh");
        processes.push(process);
        return process;
      }
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      message: "Recovered on a fresh Codex app-server thread."
    });
    expect(processes).toHaveLength(2);
    expect(processes[1]?.messages.some((message) => message.method === "thread/read")).toBe(false);
    expect(processes[1]?.messages.some((message) => message.method === "thread/goal/set")).toBe(false);
    expect(processes[1]?.messages).toContainEqual(expect.objectContaining({ method: "turn/start" }));
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:fresh-1",
      codexTurnId: "turn:fresh-1"
    });
  });

  it("parses Space browser action blocks and fails closed when the bridge is disabled", async () => {
    const assistantContent = [
      "I will inspect the visible browser.",
      "",
      "```space-browser-actions",
      JSON.stringify({
        version: 1,
        actions: [
          {
            toolId: "browser:extract_text",
            targetPaneId: "pane:browser-1",
            action: { type: "extract_text" }
          }
        ]
      }),
      "```"
    ].join("\n");
    const parsed = parseBrowserActionBlock(assistantContent);
    const bridge = await executeBrowserActionBridge({
      turnInput: dummyTurnInputSchema.parse({
        roomId: "room:test-1",
        paneId: "pane:agent-1",
        prompt: "inspect",
        selectedToolIds: ["browser:extract_text"],
        agentSessionId: "agent_session:test-1",
        roomAgentMissionId: "room_agent_mission:test-1",
        traceId: "trace:test-1"
      }),
      assistantContent,
      config: {
        enableCodexTurns: true,
        codexAppServerEnabled: true,
        command: "codex",
        transport: "stdio",
        allowStdioSpawn: true,
        allowTurnExecution: true,
        cwd: "/opt/spaceapp",
        home: null,
        keyFile: null,
        keyEnv: "OPENAI_API_KEY",
        model: null,
        artifactRoot: "/opt/spaceapp/var/artifacts",
        browserToolBridgeEnabled: false,
        mcpToolBridgeEnabled: false,
        internalApiBaseUrl: "http://127.0.0.1:4910",
        internalApiToken: null
      }
    });
    let postedBody: unknown = null;
    const executed = await executeBrowserActionBridge({
      turnInput: dummyTurnInputSchema.parse({
        roomId: "room:test-1",
        paneId: "pane:agent-1",
        prompt: "inspect",
        selectedToolIds: ["browser:extract_text"],
        agentSessionId: "agent_session:test-1",
        roomAgentMissionId: "room_agent_mission:test-1",
        traceId: "trace:test-1"
      }),
      assistantContent,
      config: {
        enableCodexTurns: true,
        codexAppServerEnabled: true,
        command: "codex",
        transport: "stdio",
        allowStdioSpawn: true,
        allowTurnExecution: true,
        cwd: "/opt/spaceapp",
        home: null,
        keyFile: null,
        keyEnv: "OPENAI_API_KEY",
        model: null,
        artifactRoot: "/opt/spaceapp/var/artifacts",
        browserToolBridgeEnabled: true,
        mcpToolBridgeEnabled: false,
        internalApiBaseUrl: "http://127.0.0.1:4910",
        internalApiToken: "test-internal-token"
      },
      fetchImpl: async (_url, init) => {
        postedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            results: [
              {
                request: {
                  toolId: "browser:extract_text",
                  targetPaneId: "pane:browser-1",
                  action: { type: "extract_text" }
                },
                status: "EXECUTED",
                statusReason: "Browser action executed through Space mediation.",
                observation: {
                  sessionId: "browser_session:test-1",
                  paneId: "pane:browser-1",
                  roomId: "room:test-1",
                  actionType: "extract_text",
                  viewport: "desktop",
                  currentUrl: `https://www.google.com/?${redactionQueryKey}=%5BREDACTED%5D`,
                  title: "Olla",
                  text: "Observed page text",
                  capturedAt: "2026-07-05T00:00:00.000Z"
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
    });

    expect(parsed.found).toBe(true);
    expect(parsed.cleanedContent).toBe("I will inspect the visible browser.");
    expect(bridge.cleanedContent).toBe("I will inspect the visible browser.");
    expect(bridge.toolMessageContent).toContain("BLOCKED");
    expect(bridge.toolMessageContent).toContain("SPACE_BROWSER_TOOL_BRIDGE_ENABLED");
    expect(bridge.toolMessageContent).not.toContain("space-browser-actions");
    expect(postedBody).toMatchObject({
      roomId: "room:test-1",
      agentPaneId: "pane:agent-1",
      agentSessionId: "agent_session:test-1",
      roomAgentMissionId: "room_agent_mission:test-1",
      selectedToolIds: ["browser:extract_text"]
    });
    expect(executed.toolMessageContent).toContain("EXECUTED browser:extract_text");
    expect(executed.toolMessageContent).toContain("Observed page text");
    expect(executed.toolMessageContent).not.toMatch(/screenshotDataUrl|profilePath|cdp|websocket|raw-secret/i);
  });

  it("records a failed Codex App Server terminal notification as failed, not completed", async () => {
    const input = dummyTurnInputSchema.parse({
      roomId: "room:test-1",
      paneId: "pane:test-1",
      prompt: "failed turn prompt must not be persisted",
      traceId: "trace:test-1"
    });

    const result = await runCodexAppServerTurn(input, {
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async () => ({
        threadId: "thread:test-1",
        turnId: "turn:test-1",
        turnStatus: "failed",
        notificationCount: 3,
        completedNotificationSeen: true
      })
    });

    expect(result).toMatchObject({
      workflowId: "workflow:codex-app-server:room:test-1:pane:test-1:trace:test-1",
      status: "FAILED",
      message: "Codex App Server turn did not provide completion evidence."
    });
    expect(JSON.stringify(result)).not.toContain("failed turn prompt must not be persisted");
  });

  it("uses the gated default stdio executor without persisting prompt or transcript content", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "space-codex-app-server-worker-"));
    const keyFile = join(tempDir, "key");
    writeFileSync(keyFile, "space-test-key\n", { mode: 0o600 });
    const store = new InMemorySpaceStore();
    store.createProvider({ id: "headroom-gateway", displayName: "Test headroom gateway", type: "CODEX_LB",
      backingProviderId: "codex-lb", routeProfile: "headroom" });
    const room = store.createRoom({ name: "Codex Worker", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    store.recordProviderValidation({
      providerId: "headroom-gateway",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Codex-LB credential passed /models auth smoke.",
      checkedAt: "2026-07-06T00:00:00.000Z",
      maskedKeyPrefix: "spac...test",
      credentialLabel: "space-test",
      modelCount: 1
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "this prompt should only be sent over stdio",
      providerId: "headroom-gateway",
      modelId: "gpt-selected-from-pane",
      reasoningEffort: "high",
      permissionMode: "full_access",
      collaborationMode: "plan",
      traceId: "trace:test-1"
    });
    const fakeProcess = new FakeCodexAppServerProcess();
    let childEnv: NodeJS.ProcessEnv | null = null;
    const routeBefore = existsSync(vscodeRouteFile) ? readFileSync(vscodeRouteFile, "utf8") : null;
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.recordTurnQueued({
      roomId: input.roomId,
      paneId: input.paneId,
      workflowId,
      runId: "temporal_run:provider-route-1",
      taskQueue: DEFAULT_TASK_QUEUE,
      traceId: input.traceId,
      prompt: input.prompt,
      artifactIds: input.artifactIds,
      runtime: "CODEX_APP_SERVER",
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null
    });

    try {
      const result = await runCodexAppServerTurn(input, {
        completionStore: store,
        env: {
          PATH: "/usr/local/bin:/usr/bin",
          SPACE_ENABLE_CODEX_TURNS: "true",
          SPACE_CODEX_APP_SERVER_ENABLED: "true",
          SPACE_CODEX_APP_SERVER_COMMAND: "codex",
          SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
          SPACE_CODEX_APP_SERVER_HOME: join(tempDir, "home", ".codex"),
          SPACE_CODEX_APP_SERVER_KEY_FILE: keyFile,
          SPACE_CODEX_APP_SERVER_KEY_ENV: "CODEX_LB_API_KEY",
          SPACE_CODEX_APP_SERVER_MODEL: "gpt-env-fallback",
          SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
          SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
          SPACE_SESSION_SECRET: "session-secret-sentinel",
          SPACE_DATABASE_URL: "database-url-sentinel",
          SPACE_INTERNAL_API_TOKEN: "internal-api-token-sentinel",
          OPENAI_API_KEY: "inherited-openai-key-sentinel",
          AWS_SECRET_ACCESS_KEY: "aws-secret-sentinel",
          NODE_OPTIONS: "--require=/tmp/evil.cjs",
          LD_PRELOAD: "/tmp/evil.so",
          HTTPS_PROXY: "http://proxy.invalid",
          INVOCATION_ID: "systemd-invocation-sentinel"
        },
        spawnProcess: (_command, _args, options) => {
          childEnv = options.env;
          return fakeProcess;
        }
      });

      expect(result).toMatchObject({
        workflowId,
        status: "COMPLETED",
        message: "Codex App Server turn completed."
      });
      expect(fakeProcess.killed).toBe(true);
      expect(childEnv).toMatchObject({
        PATH: "/usr/local/bin:/usr/bin",
        HOME: join(tempDir, "home"),
        CODEX_HOME: join(tempDir, "home", ".codex"),
        TMPDIR: join(tempDir, "home", ".codex", "tmp"),
        TMP: join(tempDir, "home", ".codex", "tmp"),
        TEMP: join(tempDir, "home", ".codex", "tmp")
      });
      expect(childEnv?.CODEX_LB_API_KEY).toBeUndefined();
      expect(childEnv?.XDG_CACHE_HOME).toBeUndefined();
      expect(childEnv?.XDG_CONFIG_HOME).toBeUndefined();
      expect(childEnv?.XDG_DATA_HOME).toBeUndefined();
      expect(childEnv?.SPACE_SESSION_SECRET).toBeUndefined();
      expect(childEnv?.SPACE_DATABASE_URL).toBeUndefined();
      expect(childEnv?.SPACE_INTERNAL_API_TOKEN).toBeUndefined();
      expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
      expect(childEnv?.AWS_SECRET_ACCESS_KEY).toBeUndefined();
      expect(childEnv?.NODE_OPTIONS).toBeUndefined();
      expect(childEnv?.LD_PRELOAD).toBeUndefined();
      expect(childEnv?.HTTPS_PROXY).toBeUndefined();
      expect(childEnv?.INVOCATION_ID).toBeUndefined();
      expect(existsSync(join(tempDir, "home", ".codex", "space-provider-homes"))).toBe(false);
      expect(fakeProcess.messages.find((message) => message.method === "thread/start")).toMatchObject({
        params: expect.objectContaining({
          model: "gpt-selected-from-pane",
          modelProvider: "codex-lb",
          sandbox: "danger-full-access",
          approvalPolicy: "never",
          approvalsReviewer: "user"
        })
      });
      expect(fakeProcess.messages.find((message) => message.method === "turn/start")).toMatchObject({
        params: expect.objectContaining({
          model: "gpt-selected-from-pane",
          effort: "high",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "gpt-selected-from-pane",
              reasoning_effort: "high",
              developer_instructions: null
            }
          }
        })
      });
      expect(fakeProcess.messages.map((message) => message.method).filter(Boolean)).toEqual([
        "initialize",
        "initialized",
        "configRequirements/read",
        "collaborationMode/list",
        "thread/start",
        "turn/start"
      ]);
      expect(fakeProcess.messages.find((message) => message.method === "thread/start")).not.toMatchObject({
        params: expect.objectContaining({ providerRoute: expect.anything(), reasoningEffort: expect.anything() })
      });
      expect(fakeProcess.messages.find((message) => message.method === "turn/start")).not.toMatchObject({
        params: expect.objectContaining({
          modelProvider: expect.anything(),
          providerRoute: expect.anything(),
          reasoningEffort: expect.anything()
        })
      });
      const routeAfter = existsSync(vscodeRouteFile) ? readFileSync(vscodeRouteFile, "utf8") : null;
      expect(routeAfter).toBe(routeBefore);
      expect(JSON.stringify(result)).not.toContain("this prompt should only be sent");
      expect(JSON.stringify(result)).not.toContain("do not persist this");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists Space-native agent transcript and reuses the stored thread id", async () => {
    const store = new InMemorySpaceStore();
    store.recordProviderValidation({
      providerId: "codex-lb",
      status: "VERIFIED",
      code: "VERIFIED",
      statusReason: "Codex-LB credential passed /models auth smoke.",
      checkedAt: "2026-07-06T00:00:00.000Z",
      maskedKeyPrefix: "spac...test",
      credentialLabel: "space-test",
      modelCount: 1
    });
    const room = store.createRoom({ name: "Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:test-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Planner",
      threadId: "thread:existing-1",
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["mcp:github"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-1",
      sessionId: session.sessionId,
      role: "user",
      content: "continue"
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "continue",
      providerId: "codex-lb",
      modelId: "gpt-selected-from-pane",
      reasoningEffort: "high",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      traceId: "trace:agent-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:test-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId,
      codexThreadId: session.threadId
    });

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async (turnInput) => {
        expect(turnInput.agentThreadId).toBe("thread:existing-1");
        return {
          threadId: "thread:existing-1",
          turnId: "turn:test-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: "Native Space transcript."
        };
      }
    });

    expect(result.status).toBe("COMPLETED");
    expect(store.getSpaceAgentSession(session.sessionId)).toMatchObject({
      status: "READY",
      threadId: "thread:existing-1"
    });
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:existing-1",
      codexTurnId: "turn:test-1"
    });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)).toMatchObject({
      role: "assistant",
      content: "Native Space transcript.",
      status: "COMPLETED"
    });
  });

  it("runs an ordinary native Chat message as one bounded turn without creating a Goal", async () => {
    const process = new StaleThreadCodexAppServerProcess("fresh");
    const input = dummyTurnInputSchema.parse({
      roomId: "room:native-chat-turn",
      paneId: "pane:native-chat-turn",
      prompt: "Reply once and finish this Chat turn.",
      agentSessionId: "agent_session:native-chat-turn",
      agentUserMessageId: "agent_msg:native-chat-user",
      agentAssistantMessageId: "agent_msg:native-chat-assistant",
      traceId: "trace:native-chat-turn"
    });

    const result = await runCodexAppServerTurn(input, {
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      spawnProcess: () => process
    });

    expect(result).toMatchObject({
      status: "COMPLETED",
      message: "Recovered on a fresh Codex app-server thread."
    });
    expect(process.messages.filter((message) => message.method === "turn/start")).toHaveLength(1);
    expect(process.messages.some((message) => message.method === "thread/goal/set")).toBe(false);
  });

  it("re-enters the same durable agent run after worker restart without sending the initial prompt twice", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Restart-safe agent", initialPaneCount: 1 });
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      paneId: pane.id,
      roomId: room.id,
      title: "Room Agent",
      threadId: "thread:before-worker-restart",
      selectedProviderId: null,
      selectedModelId: "gpt-5.6-sol",
      selectedModelConfigId: "gpt-5.6-sol:high",
      selectedProviderName: null,
      selectedModelName: "GPT-5.6",
      selectedReasoningKey: "high"
    });
    const promptMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "user",
      content: "Complete the queued room work."
    });
    const responseMessage = store.createSpaceAgentMessage({
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Complete the queued room work.",
      agentSessionId: session.sessionId,
      agentUserMessageId: promptMessage.messageId,
      agentAssistantMessageId: responseMessage.messageId,
      traceId: "trace:worker-restart-reentry"
    });
    store.createSpaceAgentRun({
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId: buildCodexAppServerTurnWorkflowId(input),
      status: "RUNNING",
      promptMessageId: promptMessage.messageId,
      responseMessageId: responseMessage.messageId,
      codexThreadId: "thread:before-worker-restart",
      codexTurnId: "turn:before-worker-restart"
    });
    const recoveryMarker = `space-durable-turn:${buildCodexAppServerTurnWorkflowId(input)}`;
    const process = new RecoveredTurnCodexAppServerProcess([
      input.prompt,
      "",
      `<space-durable-turn marker="${recoveryMarker}">Internal recovery marker; do not mention it in your response.</space-durable-turn>`
    ].join("\n"));

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      spawnProcess: () => process
    });

    expect(process.messages.some((message) => message.method === "turn/start")).toBe(false);
    expect(result).toMatchObject({ status: "COMPLETED", message: expect.stringContaining("Recovered the durable") });
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:before-worker-restart",
      codexTurnId: "turn:before-worker-restart"
    });
    expect(store.listSpaceAgentMessages(session.sessionId).at(-1)).toMatchObject({
      role: "assistant",
      content: "Recovered the durable Room Agent turn after worker restart.",
      status: "COMPLETED"
    });
  });

  it("stores browser action bridge output as a separate tool message", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:browser-bridge-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Browser Researcher",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["browser:extract_text"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-browser-1",
      sessionId: session.sessionId,
      role: "user",
      content: "inspect browser"
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-browser-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "inspect browser",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["browser:extract_text"],
      traceId: "trace:browser-bridge-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:browser-bridge-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async () => ({
        threadId: "thread:browser-bridge-1",
        turnId: "turn:browser-bridge-1",
        turnStatus: "completed",
        notificationCount: 3,
        completedNotificationSeen: true,
        agentMessageText: [
          "I will inspect the managed browser.",
          "",
          "```space-browser-actions",
          JSON.stringify({
            version: 1,
            actions: [
              {
                toolId: "browser:extract_text",
                targetPaneId: "pane:browser-1",
                action: { type: "extract_text" }
              }
            ]
          }),
          "```"
        ].join("\n")
      })
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);

    expect(result.status).toBe("COMPLETED");
    expect(messages.at(-2)).toMatchObject({
      role: "assistant",
      content: "I will inspect the managed browser.",
      status: "COMPLETED"
    });
    expect(messages.at(-1)).toMatchObject({
      role: "tool",
      status: "COMPLETED"
    });
    expect(messages.at(-1)?.content).toContain("BLOCKED");
    expect(messages.at(-1)?.content).toContain("SPACE_BROWSER_TOOL_BRIDGE_ENABLED");
    expect(messages.at(-1)?.content).not.toContain("space-browser-actions");
  });

  it("runs one bounded browser observation follow-up turn on the same Codex thread", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Follow Up", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:browser-follow-up-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Browser Researcher",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["browser:extract_text"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-browser-follow-up-1",
      sessionId: session.sessionId,
      role: "user",
      content: "inspect browser and answer " + "u".repeat(4990)
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-browser-follow-up-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "Space private clipboard tools selected:\ninternal-tool-declaration\n\nUser prompt:\ninspect browser and answer",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["browser:extract_text"],
      traceId: "trace:browser-follow-up-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:browser-follow-up-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const turnInputs: Array<{ prompt: string; agentThreadId: string | null | undefined; artifactIds: string[] }> = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                request: {
                  toolId: "browser:extract_text",
                  targetPaneId: "pane:browser-1",
                  action: { type: "extract_text" }
                },
                status: "EXECUTED",
                statusReason: "Browser action executed through Space mediation.",
                observation: {
                  sessionId: "browser_session:follow-up-1",
                  paneId: "pane:browser-1",
                  roomId: room.id,
                  actionType: "extract_text",
                  viewport: "desktop",
                  currentUrl: "https://www.google.com/",
                  title: "Olla",
                  text: "Observed Olla catalog text " + "x".repeat(3000),
                  capturedAt: "2026-07-05T00:00:00.000Z"
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
      executeStdioTurn: async (turnInput) => {
        turnInputs.push({
          prompt: turnInput.prompt,
          agentThreadId: turnInput.agentThreadId,
          artifactIds: turnInput.artifactIds
        });
        if (turnInputs.length === 1) {
          return {
            threadId: "thread:browser-follow-up-1",
            turnId: "turn:browser-follow-up-1",
            turnStatus: "completed",
            notificationCount: 3,
            completedNotificationSeen: true,
            agentMessageText: [
              "I will inspect the managed browser.",
              "",
              "```space-browser-actions",
              JSON.stringify({
                version: 1,
                actions: [
                  {
                    toolId: "browser:extract_text",
                    targetPaneId: "pane:browser-1",
                    action: { type: "extract_text" }
                  }
                ]
              }),
              "```"
            ].join("\n")
          };
        }
        return {
          threadId: "thread:browser-follow-up-1",
          turnId: "turn:browser-follow-up-final-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: [
            "The visible Olla page shows catalog text, so the browser bridge observation is now available to the agent.",
            "",
            "```space-browser-actions",
            JSON.stringify({
              version: 1,
              actions: [
                {
                  toolId: "browser:extract_text",
                  targetPaneId: "pane:browser-1",
                  action: { type: "extract_text" }
                }
              ]
            }),
            "```"
          ].join("\n")
        };
      }
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);

    expect(result.status).toBe("COMPLETED");
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toMatchObject({
      agentThreadId: "thread:browser-follow-up-1",
      artifactIds: []
    });
    expect(turnInputs[1]?.prompt).toContain("Space tool observations are below.");
    expect(turnInputs[1]?.prompt).toContain("Observed Olla catalog text");
    expect(turnInputs[1]?.prompt).toContain("Space task context:\ninspect browser and answer");
    expect(turnInputs[1]?.prompt).not.toContain("Space private clipboard tools selected:");
    expect(turnInputs[1]?.prompt.length).toBeLessThanOrEqual(8000);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "I will inspect the managed browser.",
      status: "COMPLETED"
    });
    expect(messages[2]).toMatchObject({
      role: "tool",
      status: "COMPLETED"
    });
    expect(messages[2]?.content).toContain("EXECUTED browser:extract_text");
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "The visible Olla page shows catalog text, so the browser bridge observation is now available to the agent.",
      status: "COMPLETED"
    });
    expect(messages[3]?.content).not.toContain("space-browser-actions");
    expect(messages[4]).toMatchObject({
      role: "tool",
      status: "COMPLETED"
    });
    expect(messages[4]?.content).toContain("Additional tool action request was deferred");
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:browser-follow-up-1",
      codexTurnId: "turn:browser-follow-up-final-1"
    });
  });

  it("records a sanitized assistant fallback when the tool observation follow-up turn fails", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Browser Follow Up Fallback", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:browser-follow-up-fallback-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Browser Researcher",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["browser:extract_text"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-browser-follow-up-fallback-1",
      sessionId: session.sessionId,
      role: "user",
      content: "inspect browser and answer"
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-browser-follow-up-fallback-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "inspect browser and answer",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["browser:extract_text"],
      traceId: "trace:browser-follow-up-fallback-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:browser-follow-up-fallback-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    let turnCount = 0;

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_BROWSER_TOOL_BRIDGE_ENABLED: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                request: {
                  toolId: "browser:extract_text",
                  targetPaneId: "pane:browser-1",
                  action: { type: "extract_text" }
                },
                status: "EXECUTED",
                statusReason: "Browser action executed through Space mediation.",
                observation: {
                  sessionId: "browser_session:follow-up-fallback-1",
                  paneId: "pane:browser-1",
                  roomId: room.id,
                  actionType: "extract_text",
                  viewport: "desktop",
                  currentUrl: "https://www.google.com/?token=raw-secret-value",
                  title: "Olla token:raw-secret-value",
                  text: "Observed Olla catalog text with token:raw-secret-value",
                  capturedAt: "2026-07-05T00:00:00.000Z"
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        ),
      executeStdioTurn: async () => {
        turnCount += 1;
        if (turnCount > 1) {
          throw new Error("follow-up unavailable");
        }
        return {
          threadId: "thread:browser-follow-up-fallback-1",
          turnId: "turn:browser-follow-up-fallback-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: [
            "I will inspect the managed browser.",
            "",
            "```space-browser-actions",
            JSON.stringify({
              version: 1,
              actions: [
                {
                  toolId: "browser:extract_text",
                  targetPaneId: "pane:browser-1",
                  action: { type: "extract_text" }
                }
              ]
            }),
            "```"
          ].join("\n")
        };
      }
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);

    expect(result.status).toBe("COMPLETED");
    expect(turnCount).toBe(2);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[2]?.content).toContain("EXECUTED browser:extract_text");
    expect(messages[3]).toMatchObject({ role: "assistant", status: "COMPLETED" });
    expect(messages[3]?.content).toContain("follow-up model turn did not return text");
    expect(messages[3]?.content).toContain("Observed Olla catalog text");
    expect(messages[3]?.content).not.toContain("raw-secret-value");
  });

  it("executes Space MCP actions through the internal bridge and continues from the observation", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "MCP Agents", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:mcp-action-1",
      paneId: pane.id,
      roomId: room.id,
      title: "MCP Researcher",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["space-readonly"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-mcp-action-1",
      sessionId: session.sessionId,
      role: "user",
      content: "check mcp status"
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-mcp-action-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "check mcp status",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["space-readonly"],
      traceId: "trace:mcp-action-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:mcp-action-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const turnInputs: Array<{ prompt: string; agentThreadId: string | null | undefined }> = [];
    const fetchBodies: unknown[] = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
        SPACE_MCP_TOOL_BRIDGE_ENABLED: "true",
        SPACE_INTERNAL_API_TOKEN: "test-internal-token"
      },
      browserActionFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        fetchBodies.push(body);
        return new Response(
          JSON.stringify({
            id: "space-agent-mcp-action-bridge",
            results: [
              {
                request: body.actions[0],
                status: "EXECUTED",
                statusReason: "MCP tool execution completed.",
                observation: {
                  executionId: "mcp_exec:agent-1",
                  status: "EXECUTED",
                  code: "TOOL_EXECUTION_OK",
                  message: "MCP tool execution completed.",
                  toolId: "space-readonly:space_status",
                  serverId: "space-readonly",
                  toolName: "space_status",
                  approved: false,
                  policyDecision: "ALLOWED",
                  policyReasonCode: "SCHEMA_HASH_ALLOWLISTED",
                  artifactId: "artifact:mcp-agent-1",
                  artifactKind: "MCP_RESULT",
                  artifactMimeType: "application/json",
                  artifactStorageUri: "space-artifact://mcp-executions/mcp_exec%3Aagent-1/result.json",
                  durationMs: 5
                }
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      },
      executeStdioTurn: async (turnInput) => {
        turnInputs.push({ prompt: turnInput.prompt, agentThreadId: turnInput.agentThreadId });
        if (turnInputs.length === 1) {
          return {
            threadId: "thread:mcp-action-1",
            turnId: "turn:mcp-action-1",
            turnStatus: "completed",
            notificationCount: 3,
            completedNotificationSeen: true,
            agentMessageText: [
              "I will check Space MCP status.",
              "",
              "```space-mcp-actions",
              JSON.stringify({
                version: 1,
                actions: [
                  {
                    toolId: "space-readonly:space_status",
                    action: { type: "execute", arguments: { scope: "summary" } }
                  }
                ]
              }),
              "```"
            ].join("\n")
          };
        }
        return {
          threadId: "thread:mcp-action-1",
          turnId: "turn:mcp-action-final-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: [
            "The MCP status tool executed and produced an artifact.",
            "",
            "```space-mcp-actions",
            JSON.stringify({
              version: 1,
              actions: [{ toolId: "space-readonly:space_status", action: { type: "execute", arguments: { scope: "summary" } } }]
            }),
            "```"
          ].join("\n")
        };
      }
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);

    expect(result.status).toBe("COMPLETED");
    expect(fetchBodies).toHaveLength(1);
    expect(fetchBodies[0]).toMatchObject({
      roomId: room.id,
      agentPaneId: pane.id,
      agentSessionId: session.sessionId,
      selectedToolIds: ["space-readonly"],
      actions: [{ toolId: "space-readonly:space_status", action: { type: "execute", arguments: { scope: "summary" } } }]
    });
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toMatchObject({ agentThreadId: "thread:mcp-action-1" });
    expect(turnInputs[1]?.prompt).toContain("Space MCP action bridge result:");
    expect(turnInputs[1]?.prompt).toContain("EXECUTED space-readonly:space_status");
    expect(turnInputs[1]?.prompt).toContain("artifact=artifact:mcp-agent-1");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant", "tool"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "I will check Space MCP status.",
      status: "COMPLETED"
    });
    expect(messages[2]).toMatchObject({ role: "tool", status: "COMPLETED" });
    expect(messages[2]?.content).toContain("EXECUTED space-readonly:space_status");
    expect(messages[2]?.content).not.toMatch(/test-internal-token|localPath|raw-credential/i);
    expect(messages[3]?.content).toBe("The MCP status tool executed and produced an artifact.");
    expect(messages[4]?.content).toContain("Additional tool action request was deferred");
  });

  it("executes Space memory actions and continues from the observation", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Memory Agent", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:memory-action-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Memory Researcher",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["memory:search", "memory:save"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-memory-action-1",
      sessionId: session.sessionId,
      role: "user",
      content: "remember and search storage"
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-memory-action-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "remember and search storage",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["memory:search", "memory:save"],
      traceId: "trace:memory-action-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:memory-action-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const turnInputs: Array<{ prompt: string; agentThreadId: string | null | undefined }> = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async (turnInput) => {
        turnInputs.push({ prompt: turnInput.prompt, agentThreadId: turnInput.agentThreadId });
        if (turnInputs.length === 1) {
          return {
            threadId: "thread:memory-action-1",
            turnId: "turn:memory-action-1",
            turnStatus: "completed",
            notificationCount: 3,
            completedNotificationSeen: true,
            agentMessageText: [
              "I will save and search Space memory.",
              "",
              "```space-memory-actions",
              JSON.stringify({
                version: 1,
                actions: [
                  {
                    toolId: "memory:save",
                    action: {
                      type: "save",
                      title: "Storage note",
                      body: "Dedicated Space storage is required. token=raw-memory-value",
                      provenance: "operator-confirmed"
                    }
                  },
                  {
                    toolId: "memory:search",
                    action: { type: "search", q: "storage", pageSize: 2 }
                  }
                ]
              }),
              "```"
            ].join("\n")
          };
        }
        return {
          threadId: "thread:memory-action-1",
          turnId: "turn:memory-action-final-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: "I saved the storage note and found it again in Space memory."
        };
      }
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);
    const memories = store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc", roomId: room.id, q: "storage" });

    expect(result.status).toBe("COMPLETED");
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toMatchObject({ agentThreadId: "thread:memory-action-1" });
    expect(turnInputs[1]?.prompt).toContain("Space tool observations are below.");
    expect(turnInputs[1]?.prompt).toContain("EXECUTED memory:save");
    expect(turnInputs[1]?.prompt).toContain("EXECUTED memory:search");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "I will save and search Space memory.",
      status: "COMPLETED"
    });
    expect(messages[2]).toMatchObject({ role: "tool", status: "COMPLETED" });
    expect(messages[2]?.content).toContain("EXECUTED memory:save");
    expect(messages[2]?.content).toContain("EXECUTED memory:search");
    expect(messages[2]?.content).not.toContain("raw-memory-value");
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "I saved the storage note and found it again in Space memory.",
      status: "COMPLETED"
    });
    expect(memories[0]).toMatchObject({
      scope: "ROOM",
      roomId: room.id,
      title: "Storage note"
    });
    expect(memories[0]?.body).not.toContain("raw-memory-value");
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:memory-action-1",
      codexTurnId: "turn:memory-action-final-1"
    });
  });

  it("executes operator-authored Space memory actions when Codex completes without assistant text", async () => {
    const store = new InMemorySpaceStore();
    const room = store.createRoom({ name: "Memory Empty Reply", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:memory-empty-reply-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Memory Empty Reply",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["memory:search", "memory:save"]
    });
    const operatorPrompt = [
      "Please execute this Space memory action.",
      "",
      "```space-memory-actions",
      JSON.stringify({
        version: 1,
        actions: [
          {
            toolId: "memory:save",
            action: {
              type: "save",
              title: "Empty reply note",
              body: "Codex empty replies still need memory persistence.",
              provenance: "operator-authored"
            }
          },
          {
            toolId: "memory:search",
            action: { type: "search", q: "empty replies", pageSize: 2 }
          }
        ]
      }),
      "```"
    ].join("\n");
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-memory-empty-reply-1",
      sessionId: session.sessionId,
      role: "user",
      content: operatorPrompt
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-memory-empty-reply-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: operatorPrompt,
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["memory:search", "memory:save"],
      traceId: "trace:memory-empty-reply-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:memory-empty-reply-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const turnInputs: Array<{ prompt: string; agentThreadId: string | null | undefined }> = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async (turnInput) => {
        turnInputs.push({ prompt: turnInput.prompt, agentThreadId: turnInput.agentThreadId });
        if (turnInputs.length === 1) {
          return {
            threadId: "thread:memory-empty-reply-1",
            turnId: "turn:memory-empty-reply-1",
            turnStatus: "completed",
            notificationCount: 3,
            completedNotificationSeen: true,
            agentMessageText: ""
          };
        }
        return {
          threadId: "thread:memory-empty-reply-1",
          turnId: "turn:memory-empty-reply-final-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: "I saved the note from the operator-authored memory action block."
        };
      }
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);
    const memories = store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc", roomId: room.id, q: "empty replies" });

    expect(result.status).toBe("COMPLETED");
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toMatchObject({ agentThreadId: "thread:memory-empty-reply-1" });
    expect(turnInputs[1]?.prompt).toContain("EXECUTED memory:save");
    expect(turnInputs[1]?.prompt).toContain("EXECUTED memory:search");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "Requested Space memory actions.",
      status: "COMPLETED"
    });
    expect(messages[2]?.content).toContain("EXECUTED memory:save");
    expect(messages[2]?.content).toContain("EXECUTED memory:search");
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "I saved the note from the operator-authored memory action block.",
      status: "COMPLETED"
    });
    expect(memories[0]).toMatchObject({
      scope: "ROOM",
      roomId: room.id,
      title: "Empty reply note"
    });
  });

  it("executes Space skill actions and continues from the observation", async () => {
    const store = new InMemorySpaceStore({ codexSkillRoots: [], codexPluginSkillRoots: [] });
    const room = store.createRoom({ name: "Skill Agent", initialPaneCount: 1 }, "trace:room");
    const pane = store.listPanes(room.id)[0]!;
    const session = store.createSpaceAgentSession({
      sessionId: "agent_session:skill-action-1",
      paneId: pane.id,
      roomId: room.id,
      title: "Skill Researcher",
      threadId: null,
      selectedProviderId: "codex-lb",
      selectedModelId: "gpt-selected-from-pane",
      selectedModelConfigId: "gpt-selected-from-pane",
      selectedProviderName: "Codex-LB",
      selectedModelName: "GPT selected",
      selectedReasoningKey: "high",
      selectedToolIds: ["skills:list", "skills:read"]
    });
    const userMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:user-skill-action-1",
      sessionId: session.sessionId,
      role: "user",
      content: "find the planning skill"
    });
    const assistantMessage = store.createSpaceAgentMessage({
      messageId: "agent_msg:assistant-skill-action-1",
      sessionId: session.sessionId,
      role: "assistant",
      content: "",
      status: "RUNNING"
    });
    const input = dummyTurnInputSchema.parse({
      roomId: room.id,
      paneId: pane.id,
      prompt: "find the planning skill",
      agentSessionId: session.sessionId,
      agentUserMessageId: userMessage.messageId,
      agentAssistantMessageId: assistantMessage.messageId,
      selectedToolIds: ["skills:list", "skills:read"],
      traceId: "trace:skill-action-1"
    });
    const workflowId = buildCodexAppServerTurnWorkflowId(input);
    store.createSpaceAgentRun({
      runId: "agent_run:skill-action-1",
      sessionId: session.sessionId,
      paneId: pane.id,
      roomId: room.id,
      workflowId,
      status: "QUEUED",
      promptMessageId: userMessage.messageId,
      responseMessageId: assistantMessage.messageId
    });
    const turnInputs: Array<{ prompt: string; agentThreadId: string | null | undefined }> = [];

    const result = await runCodexAppServerTurn(input, {
      completionStore: store,
      env: {
        SPACE_ENABLE_CODEX_TURNS: "true",
        SPACE_CODEX_APP_SERVER_ENABLED: "true",
        SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
        SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true"
      },
      executeStdioTurn: async (turnInput) => {
        turnInputs.push({ prompt: turnInput.prompt, agentThreadId: turnInput.agentThreadId });
        if (turnInputs.length === 1) {
          return {
            threadId: "thread:skill-action-1",
            turnId: "turn:skill-action-1",
            turnStatus: "completed",
            notificationCount: 3,
            completedNotificationSeen: true,
            agentMessageText: [
              "I will inspect Space skills.",
              "",
              "```space-skill-actions",
              JSON.stringify({
                version: 1,
                actions: [
                  { toolId: "skills:list", action: { type: "list", q: "plan", pageSize: 5 } },
                  { toolId: "skills:read", action: { type: "read", skillId: "planning" } }
                ]
              }),
              "```"
            ].join("\n")
          };
        }
        return {
          threadId: "thread:skill-action-1",
          turnId: "turn:skill-action-final-1",
          turnStatus: "completed",
          notificationCount: 3,
          completedNotificationSeen: true,
          agentMessageText: "I found the planning skill and can use it for sliced work."
        };
      }
    });
    const messages = store.listSpaceAgentMessages(session.sessionId);

    expect(result.status).toBe("COMPLETED");
    expect(turnInputs).toHaveLength(2);
    expect(turnInputs[1]).toMatchObject({ agentThreadId: "thread:skill-action-1" });
    expect(turnInputs[1]?.prompt).toContain("Space tool observations are below.");
    expect(turnInputs[1]?.prompt).toContain("EXECUTED skills:list");
    expect(turnInputs[1]?.prompt).toContain("EXECUTED skills:read");
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: "I will inspect Space skills.",
      status: "COMPLETED"
    });
    expect(messages[2]?.content).toContain("EXECUTED skills:list");
    expect(messages[2]?.content).toContain("EXECUTED skills:read");
    expect(messages[2]?.content).toContain("Planning");
    expect(messages[2]?.content).not.toMatch(/api[_-]?key|secret|password|localPath|sk-/i);
    expect(messages[3]).toMatchObject({
      role: "assistant",
      content: "I found the planning skill and can use it for sliced work.",
      status: "COMPLETED"
    });
    expect(store.getLatestSpaceAgentRun(session.sessionId)).toMatchObject({
      status: "COMPLETED",
      codexThreadId: "thread:skill-action-1",
      codexTurnId: "turn:skill-action-final-1"
    });
  });

  it("blocks Space skill actions when the matching tool is not selected", async () => {
    const store = new InMemorySpaceStore();
    const input = dummyTurnInputSchema.parse({
      roomId: "room:skill-tool-gate-1",
      paneId: "pane:skill-tool-gate-1",
      prompt: "read planning",
      agentSessionId: "agent_session:skill-tool-gate-1",
      selectedToolIds: ["skills:list"],
      traceId: "trace:skill-tool-gate-1"
    });

    const result = await executeSkillActionBridge({
      turnInput: input,
      store,
      assistantContent: [
        "I will read the skill.",
        "",
        "```space-skill-actions",
        JSON.stringify({
          version: 1,
          actions: [{ toolId: "skills:read", action: { type: "read", skillId: "planning" } }]
        }),
        "```"
      ].join("\n")
    });

    expect(result.cleanedContent).toBe("I will read the skill.");
    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED skills:read");
    expect(result.toolMessageContent).toContain("not selected");
  });

  it("blocks Space memory actions when the matching tool is not selected", async () => {
    const store = new InMemorySpaceStore();
    const input = dummyTurnInputSchema.parse({
      roomId: "room:memory-tool-gate-1",
      paneId: "pane:memory-tool-gate-1",
      prompt: "save this",
      agentSessionId: "agent_session:memory-tool-gate-1",
      selectedToolIds: ["memory:search"],
      traceId: "trace:memory-tool-gate-1"
    });

    const result = await executeMemoryActionBridge({
      turnInput: input,
      store,
      assistantContent: [
        "I will save this note.",
        "",
        "```space-memory-actions",
        JSON.stringify({
          version: 1,
          actions: [{ toolId: "memory:save", action: { type: "save", title: "Blocked note", body: "Should not persist." } }]
        }),
        "```"
      ].join("\n")
    });

    expect(result.cleanedContent).toBe("I will save this note.");
    expect(result.executedActionCount).toBe(0);
    expect(result.toolMessageContent).toContain("BLOCKED memory:save");
    expect(result.toolMessageContent).toContain("not selected");
    expect(store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc" })).toEqual([]);
  });

  it("uses an injected canonical memory bridge instead of standalone Space store memory", async () => {
    const store = new InMemorySpaceStore();
    const saved: Array<{ title: string; body: string; provenance: string }> = [];
    const input = dummyTurnInputSchema.parse({
      roomId: "room:canonical-memory-bridge",
      paneId: "pane:canonical-memory-bridge",
      prompt: "save this canonically",
      agentSessionId: "agent_session:canonical-memory-bridge",
      selectedToolIds: ["memory:search", "memory:save"],
      traceId: "trace:canonical-memory-bridge"
    });

    const result = await executeMemoryActionBridge({
      turnInput: input,
      store,
      canonicalMemory: {
        async list() {
          return [
            {
              id: "gemini_memory:test-match",
              scope: "SYSTEM",
              roomId: null,
              title: "Canonical match",
              body: "Canonical memory contains storage.",
              provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
              createdAt: "2026-07-06T00:00:00.000Z"
            }
          ];
        },
        async save(entry) {
          saved.push(entry);
          return {
            id: "gemini_memory:test-save",
            scope: "SYSTEM",
            roomId: null,
            title: entry.title,
            body: entry.body,
            provenance: "/opt/spaceapp/docs/gemini_history_2026-07.md",
            createdAt: "2026-07-06T00:00:00.000Z"
          };
        }
      },
      assistantContent: [
        "I will save this note canonically.",
        "",
        "```space-memory-actions",
        JSON.stringify({
          version: 1,
          actions: [
            { toolId: "memory:save", action: { type: "save", title: "Canonical note", body: "Shared state marker", provenance: "worker-test" } },
            { toolId: "memory:search", action: { type: "search", q: "storage", pageSize: 1 } }
          ]
        }),
        "```"
      ].join("\n")
    } as Parameters<typeof executeMemoryActionBridge>[0] & {
      canonicalMemory: {
        list: (query: unknown) => Promise<unknown[]>;
        save: (entry: { title: string; body: string; provenance: string }) => Promise<unknown>;
      };
    });

    expect(result.executedActionCount).toBe(2);
    expect(saved).toEqual([
      {
        scope: "ROOM",
        roomId: "room:canonical-memory-bridge",
        title: "Canonical note",
        body: "Shared state marker",
        provenance: "worker-test"
      }
    ]);
    expect(result.toolMessageContent).toContain("EXECUTED memory:save");
    expect(result.toolMessageContent).toContain("gemini_memory:test-match");
    expect(store.listMemoryEntries({ page: 1, pageSize: 10, sortOrder: "desc" })).toEqual([]);
  });

  it("resolves Space artifact URIs to local files under the configured artifact root", () => {
    expect(
      resolveSpaceArtifactPath(
        "/opt/spaceapp/var/artifacts",
        "space-artifact://browser-evidence/browser_capture%3Atest-1/screenshot.png"
      )
    ).toBe("/opt/spaceapp/var/artifacts/browser-evidence/browser_capture_test-1/screenshot.png");

    expect(
      resolveSpaceArtifactPath(
        "/opt/spaceapp/var/artifacts",
        "space-artifact://user-uploads/room%3Atest-1/2026-06-28/upload_test.png"
      )
    ).toBe("/opt/spaceapp/var/artifacts/user-uploads/room_test-1/2026-06-28/upload_test.png");
  });
});
