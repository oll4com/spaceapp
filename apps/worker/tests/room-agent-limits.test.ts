import { describe, expect, it } from "vitest";
import { dummyTurnInputSchema } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { runCodexAppServerTurn } from "../src/activities.js";
import { buildCodexAppServerTurnWorkflowId } from "../src/ids.js";
import {
  DEFAULT_ROOM_AGENT_MAX_CONTINUATIONS, DEFAULT_ROOM_AGENT_MAX_MISSION_TOKENS, DEFAULT_ROOM_AGENT_MAX_PASSES,
  ROOM_AGENT_CONTINUATION_LIMIT, ROOM_AGENT_PASS_LIMIT, ROOM_AGENT_TOKEN_LIMIT, roomAgentLimitsFromEnv
} from "../src/room-agent-limits.js";
import { prepareBackgroundContinuation } from "../src/room-background-continuation.js";
import { roomAgentMissionCompletion } from "../src/room-supervisor-state.js";
import { continuationFixture } from "./room-continuation-fixture.js";

const storedErrorCode = (store: unknown, missionId: string) =>
  (store as { roomAgentTraces: Map<string, { errorCode: string | null }> }).roomAgentTraces.get(missionId)?.errorCode ?? null;

/**
 * Runaway-loop budgets for the Room Agent. The model runtime is a
 * deterministic fake executor: no Codex process, provider or model is called.
 */
const operatorRequest = "Send the release checklist to the CLI pane. Constraint: never restart or close any pane.";
const baseEnv = {
  SPACE_ENABLE_CODEX_TURNS: "true",
  SPACE_CODEX_APP_SERVER_ENABLED: "true",
  SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
  SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true",
  SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true",
  SPACE_INTERNAL_API_TOKEN: "test-internal-token"
};

function runawayHarness(suffix: string) {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: `Runaway ${suffix}`, initialPaneCount: 0 });
  const pane = store.getOrCreateRoomAgentPane(room.id);
  const selectedToolIds = ["room:inspect", "room:send"];
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Room Agent", selectedProviderId: null,
    selectedModelId: "gpt-5.6-sol", selectedModelConfigId: "gpt-5.6-sol:high", selectedProviderName: null, selectedModelName: "GPT-5.6",
    selectedReasoningKey: "high", selectedToolIds });
  const userMessage = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: operatorRequest });
  const assistantMessage = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const input = dummyTurnInputSchema.parse({ roomId: room.id, paneId: pane.id, prompt: operatorRequest, roomAgentOperatorRequest: operatorRequest,
    modelId: "gpt-5.6-sol", reasoningEffort: "high", agentSessionId: session.sessionId, roomAgentMissionId: `room_agent_mission:${suffix}`,
    agentUserMessageId: userMessage.messageId, agentAssistantMessageId: assistantMessage.messageId, selectedToolIds,
    traceId: `room-agent-${suffix}-request-0001` });
  store.createSpaceAgentRun({ sessionId: session.sessionId, paneId: pane.id, roomId: room.id, workflowId: buildCodexAppServerTurnWorkflowId(input),
    status: "QUEUED", promptMessageId: userMessage.messageId, responseMessageId: assistantMessage.messageId });
  const request = store.createRoomAgentRequest({ requestId: `room_agent_request:${input.traceId}`, roomId: room.id, sessionId: session.sessionId,
    clientRequestId: input.traceId, promptMessageId: userMessage.messageId, responseMessageId: assistantMessage.messageId });
  store.createRoomAgentMission({ id: input.roomAgentMissionId!, requestId: request.requestId, roomId: room.id, sessionId: session.sessionId,
    workflowId: `room-supervisor:${room.id}`, status: "RUNNING", currentPaneId: null, statusReason: "Fixture mission is running." });
  const prompts: string[] = [];
  const actions: string[] = [];
  const run = (env: Record<string, string> = {}) => runCodexAppServerTurn(input, {
    completionStore: store,
    env: { ...baseEnv, ...env },
    // Every requested action executes and reports evidence, so nothing blocks the loop.
    browserActionFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { missionId: string; actions: Array<Record<string, unknown>> };
      actions.push(...body.actions.map((action) => JSON.stringify(action)));
      return Response.json({ id: "space-agent-room-action-bridge", results: body.actions.map((request) => ({ request, status: "EXECUTED",
        statusReason: "Input delivered.", paneId: "pane:cli-target", missionId: body.missionId, evidence: { delivered: true } })) });
    },
    // A runaway agent: it never verifies and always asks for one more, different action.
    executeStdioTurn: async (turnInput) => {
      prompts.push(turnInput.prompt);
      return { threadId: `thread:${suffix}`, turnId: `turn:${suffix}-${prompts.length}`, turnStatus: "completed", notificationCount: 3,
        completedNotificationSeen: true, agentMessageText: ["Sending the next item; more remains.", "```space-room-actions",
          JSON.stringify({ version: 1, actions: [{ toolId: "room:send", action: { type: "send", paneId: "pane:cli-target", input: `Checklist item ${prompts.length}` } }] }),
          "```"].join("\n") };
    }
  });
  return { store, session, input, prompts, actions, run };
}

describe("Room Agent supervision pass budget", () => {
  it("stops a runaway agent at the configured pass limit with a terminal code on the run ledger", async () => {
    const h = runawayHarness("pass-limit");
    const result = await h.run({ SPACE_ROOM_AGENT_MAX_PASSES: "3" });
    // One initial turn plus exactly three supervision passes; every requested action ran once.
    expect(h.prompts).toHaveLength(4);
    expect(h.actions).toHaveLength(4);
    expect(result).toMatchObject({ roomAgentOutcome: { status: "UNVERIFIED",
      statusReason: "The Room Agent reached its 3-pass supervision limit before final verification." } });
    expect(roomAgentMissionCompletion(result)).toEqual({ status: "FAILED",
      statusReason: "The Room Agent reached its 3-pass supervision limit before final verification." });
    expect(h.store.getLatestSpaceAgentRun(h.session.sessionId)).toMatchObject({ status: "FAILED", errorCode: ROOM_AGENT_PASS_LIMIT,
      errorMessage: "The Room Agent reached its 3-pass supervision limit before final verification." });
    // Every follow-up restates the complete operator request, including its constraint.
    for (const prompt of h.prompts.slice(1)) expect(prompt).toContain(operatorRequest);
  });

  it("defaults to eight passes and ignores invalid settings", async () => {
    expect(DEFAULT_ROOM_AGENT_MAX_PASSES).toBe(8);
    expect(roomAgentLimitsFromEnv({})).toEqual({ maxPasses: 8, maxContinuations: 16, maxMissionTokens: 10_000_000 });
    expect(roomAgentLimitsFromEnv({ SPACE_ROOM_AGENT_MAX_PASSES: "0", SPACE_ROOM_AGENT_MAX_CONTINUATIONS: "17" })).toEqual({ maxPasses: 8, maxContinuations: 16, maxMissionTokens: 10_000_000 });
    expect(roomAgentLimitsFromEnv({ SPACE_ROOM_AGENT_MAX_PASSES: "2.5", SPACE_ROOM_AGENT_MAX_CONTINUATIONS: "-1" })).toEqual({ maxPasses: 8, maxContinuations: 16, maxMissionTokens: 10_000_000 });
    expect(roomAgentLimitsFromEnv({ SPACE_ROOM_AGENT_MAX_PASSES: "16", SPACE_ROOM_AGENT_MAX_CONTINUATIONS: "1" })).toEqual({ maxPasses: 16, maxContinuations: 1, maxMissionTokens: 10_000_000 });
    const h = runawayHarness("pass-default");
    const result = await h.run({ SPACE_ROOM_AGENT_MAX_PASSES: "invalid" });
    expect(h.prompts).toHaveLength(9);
    expect(roomAgentMissionCompletion(result).statusReason).toBe("The Room Agent reached its 8-pass supervision limit before final verification.");
  });
});

describe("Room Agent background continuation budget", () => {
  it("fails the mission at the configured continuation limit, keeping the request and every settled result", async () => {
    const c = continuationFixture();
    // A long mission: more settled actions than the detail window retains.
    for (let index = 0; index < 60; index++) c.store.createRoomAgentAction({ ...c.action, actionId: `action:send-${index}`,
      idempotencyKey: `budget-send-${index}`, actionType: "SEND", statusReason: `Delivered item ${index}.`,
      requestPayload: { toolId: "room:send", action: { type: "send", paneId: "pane:cli", input: `Item ${index}` } }, evidence: { delivered: true } });
    const prompts: string[] = [];
    let state = "READY";
    for (let generation = 1; generation <= 5 && state === "READY"; generation++) {
      const prepared = await prepareBackgroundContinuation({ ...c.input, continuationId: `budget-${generation}` }, c.store, 3);
      state = prepared.state;
      if (prepared.state !== "READY") break;
      expect(prepared.item.turn.roomAgentContinuation?.generation).toBe(generation);
      prompts.push(prepared.item.turn.prompt);
      // The automatic turn runs and completes without verification, so the agent keeps continuing.
      c.store.updateSpaceAgentRun(prepared.item.turn.agentRunId!, { status: "COMPLETED", completedAt: new Date().toISOString() });
    }
    expect(state).toBe("DONE");
    expect(prompts).toHaveLength(3);
    const mission = c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)!;
    expect(mission).toMatchObject({ status: "FAILED",
      statusReason: "Room Agent reached its limit of 3 automatic continuations without verified completion.",
      executionState: { limit: { code: ROOM_AGENT_CONTINUATION_LIMIT, limit: 3, continuationsUsed: 3 } } });
    expect(mission.completedAt).not.toBeNull();
    // The mission's error code reaches the trace lookup.
    expect(storedErrorCode(c.store, mission.id)).toBe(ROOM_AGENT_CONTINUATION_LIMIT);
    for (const prompt of prompts) {
      expect(prompt).toContain("Operator request:\nOpen CLI and Chat, then send a story to both.");
      const evidence = JSON.parse(prompt.split("Settled action results (bounded; inspect for details):\n")[1]!);
      expect(evidence.counts).toEqual({ OPEN_TYPES: { COMPLETED: 1 }, SEND: { COMPLETED: 60 } });
      expect(prompt.length).toBeLessThanOrEqual(8000);
    }
    // A finished mission never starts another automatic turn.
    expect(await prepareBackgroundContinuation({ ...c.input, continuationId: "budget-after" }, c.store, 3)).toEqual({ state: "DONE" });
  });

  it("keeps the default of sixteen continuations", () => {
    expect(DEFAULT_ROOM_AGENT_MAX_CONTINUATIONS).toBe(16);
  });
});

describe("Room Agent measured-token budget", () => {
  const measured = (totalTokens: number) => ({ status: "MEASURED" as const, inputTokens: totalTokens - 100, cachedInputTokens: 0,
    outputTokens: 100, reasoningOutputTokens: 0, totalTokens, source: "codex-app-server:thread/tokenUsage/updated",
    observedAt: new Date().toISOString(), model: "gpt-5.6-sol" });

  it("reads the budget from the worker environment; 0 turns it off and invalid values keep the default", () => {
    expect(DEFAULT_ROOM_AGENT_MAX_MISSION_TOKENS).toBe(10_000_000);
    expect(roomAgentLimitsFromEnv({ SPACE_ROOM_AGENT_MAX_MISSION_TOKENS: "250000" }).maxMissionTokens).toBe(250_000);
    expect(roomAgentLimitsFromEnv({ SPACE_ROOM_AGENT_MAX_MISSION_TOKENS: "0" }).maxMissionTokens).toBeNull();
    for (const value of ["999", "1000000001", "-5", "1e6", "lots", ""]) {
      expect(roomAgentLimitsFromEnv({ SPACE_ROOM_AGENT_MAX_MISSION_TOKENS: value }).maxMissionTokens).toBe(10_000_000);
    }
  });

  it("counts each turn's measured tokens once and fails the mission when the budget is reached", async () => {
    const c = continuationFixture();
    c.store.updateSpaceAgentRun(c.initial.run.runId, { usage: measured(40_000) });
    const first = await prepareBackgroundContinuation({ ...c.input, continuationId: "tokens-1" }, c.store, 16, 100_000);
    expect(first.state).toBe("READY");
    // A retried preparation of the same continuation never counts the source turn again.
    await prepareBackgroundContinuation({ ...c.input, continuationId: "tokens-1" }, c.store, 16, 100_000);
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)!.executionState.tokenUsage)
      .toEqual({ usedTokens: 40_000, countedThroughRunId: c.initial.run.runId });
    if (first.state !== "READY") throw new Error("unreachable");

    c.store.updateSpaceAgentRun(first.item.turn.agentRunId!, { status: "COMPLETED", completedAt: new Date().toISOString(), usage: measured(70_000) });
    expect(await prepareBackgroundContinuation({ ...c.input, continuationId: "tokens-2" }, c.store, 16, 100_000)).toEqual({ state: "DONE" });
    const mission = c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)!;
    expect(mission).toMatchObject({ status: "FAILED",
      statusReason: "Room Agent used 110,000 measured tokens, reaching its budget of 100,000, without verified completion.",
      executionState: { limit: { code: ROOM_AGENT_TOKEN_LIMIT, limit: 100_000, usedTokens: 110_000 } } });
    expect(mission.completedAt).not.toBeNull();
    expect(storedErrorCode(c.store, mission.id)).toBe(ROOM_AGENT_TOKEN_LIMIT);
  });

  it("starts a new budget for an operator request and never stops when the budget is off", async () => {
    const fresh = continuationFixture();
    // A stale total from an earlier operator request does not carry into this one.
    fresh.store.updateRoomAgentMission(fresh.initial.mission.id, { executionState: { tokenUsage: { usedTokens: 9_000_000, countedThroughRunId: "agent_run:older" } } });
    fresh.store.updateSpaceAgentRun(fresh.initial.run.runId, { usage: measured(5_000) });
    expect((await prepareBackgroundContinuation(fresh.input, fresh.store, 16, 100_000)).state).toBe("READY");
    expect(fresh.store.getRoomAgentMission(fresh.room.id, fresh.initial.mission.id)!.executionState.tokenUsage)
      .toEqual({ usedTokens: 5_000, countedThroughRunId: fresh.initial.run.runId });

    const off = continuationFixture();
    off.store.updateSpaceAgentRun(off.initial.run.runId, { usage: measured(500_000_000) });
    expect((await prepareBackgroundContinuation(off.input, off.store, 16, null)).state).toBe("READY");
  });

  it("adds no mission write when no turn reported usage", async () => {
    const c = continuationFixture();
    expect((await prepareBackgroundContinuation(c.input, c.store, 16, 1_000)).state).toBe("READY");
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)!.executionState.tokenUsage).toBeUndefined();
  });
});
