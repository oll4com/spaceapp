import { describe, expect, it, vi } from "vitest";
import { roomAgentSupervisorInputSchema } from "@space/contracts";
import { continuationEvidence, discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

import { continuationFixture } from "./room-continuation-fixture.js";
import { runCodexAppServerTurn } from "../src/activities.js";

describe("durable background continuation", () => {
  it("includes the actual failure reason when resuming after a parsed background action", () => {
    const c = continuationFixture();
    const evidence = JSON.parse(continuationEvidence([{ ...c.action, status: "FAILED",
      requestPayload: { toolId: "room:open_types", action: { type: "open_types", kinds: ["TERMINAL"], runtimeIds: ["cli:claude"] } },
      evidence: {}, statusReason: "Requested types are unavailable; no panes were created. cli:claude: Authentication is no longer ready."
    }], 2400));
    expect(evidence.recentActions[0]).toMatchObject({ status: "FAILED",
      reason: "Requested types are unavailable; no panes were created. cli:claude: Authentication is no longer ready." });
    expect(evidence.recentActions[0].summary).toContain("claude");
  });
  it("keeps completed layouts and closures when background allocation also exists", async () => {
    const c = continuationFixture();
    for (let index = 0; index < 10; index++) c.store.createRoomAgentAction({
      ...c.action, actionId: `layout:${index}`, idempotencyKey: `layout:${index}`, actionType: "LAYOUT",
      requestPayload: { toolId: "room:layout", action: { type: "layout", paneLayoutColumns: index % 6 } },
      evidence: { paneLayoutColumns: index % 6 }
    });
    c.store.createRoomAgentAction({ ...c.action, actionId: "close:old", idempotencyKey: "close:old", actionType: "CLOSE_PANE",
      requestPayload: { toolId: "room:close_pane", action: { type: "close_pane", paneId: "pane:old" } },
      evidence: { paneId: "pane:old", isClosed: true } });
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    const evidence = JSON.parse(prepared.item.turn.prompt.split("Settled action results (bounded; inspect for details):\n")[1]!);
    expect(evidence.counts).toEqual({ OPEN_TYPES: { COMPLETED: 1 }, LAYOUT: { COMPLETED: 10 }, CLOSE_PANE: { COMPLETED: 1 } });
    expect(evidence.recentActions.some((a: { type: string }) => a.type === "CLOSE_PANE")).toBe(true);
    expect(evidence.recentActions.some((a: { type: string }) => a.type === "LAYOUT")).toBe(true);
    expect(prepared.item.turn.prompt.length).toBeLessThanOrEqual(8000);
  });

  it("retains totals beyond the detail window and emits intact bounded JSON", () => {
    const c = continuationFixture();
    const actions = Array.from({ length: 80 }, (_, index) => ({ ...c.action, actionId: `action:${index}`,
      evidence: { output: '"\\\n'.repeat(3000) } }));
    const text = continuationEvidence(actions, 2400);
    const value = JSON.parse(text);
    expect(text.length).toBeLessThanOrEqual(2400);
    expect(value.counts.OPEN_TYPES.COMPLETED).toBe(80);
    expect(value.omittedDetails + value.recentActions.length).toBe(80);
    expect(value.recentActions.length).toBeGreaterThan(0);
  });
  it.each(["WORKER_SHUTDOWN", "TIMED_OUT", "CANCELLED"].flatMap(reason => [true, false].map(supervisor => ({ reason, supervisor }))))("handles Temporal $reason for supervisor=$supervisor without confusing retry with STOP", async ({ reason, supervisor }) => {
    const c = continuationFixture();
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    const controller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const execution = runCodexAppServerTurn({ ...prepared.item.turn, ...(!supervisor ? { roomAgentMissionId: undefined, roomAgentContinuation: undefined } : {}) }, {
      completionStore: c.store, abortSignal: controller.signal,
      env: { SPACE_ENABLE_CODEX_TURNS: "true", SPACE_CODEX_APP_SERVER_ENABLED: "true", SPACE_CODEX_APP_SERVER_TRANSPORT: "stdio",
        SPACE_CODEX_APP_SERVER_ALLOW_STDIO_SPAWN: "true", SPACE_CODEX_APP_SERVER_ALLOW_TURN_EXECUTION: "true" },
      executeStdioTurn: async () => { started(); return new Promise((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
      }); }
    });
    await entered;
    controller.abort(new Error(reason));
    await expect(execution).rejects.toThrow(reason);
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, prepared.item.turn.agentRunId)?.run.status)
      .toBe(reason === "CANCELLED" ? "INTERRUPTED" : "RUNNING");
    expect(await supervisorTurnState(prepared.item, c.store)).toBe(reason === "CANCELLED" ? "SKIP" : "READY");
  });

  it("recovers the exact committed outcome after the completion activity reply is lost", async () => {
    const c = continuationFixture();
    const prepared = await prepareBackgroundContinuation(c.input, c.store);
    if (prepared.state !== "READY") throw Error("Missing continuation");
    const item = prepared.item;
    const outcome = { status: "VERIFIED" as const, executedActionCount: 1,
      pendingActionIds: [c.action.actionId], statusReason: "Allocation completed; remaining request is pending." };
    c.store.completeSpaceAgentRun({ runId: item.turn.agentRunId!, sessionId: c.session.sessionId,
      responseMessageId: item.turn.agentAssistantMessageId!, responseContent: "Allocated", finalResponse: "Allocated",
      codexThreadId: null, codexTurnId: null, sourceType: "ROOM_AGENT", traceId: item.turn.traceId,
      completedAt: new Date().toISOString(), roomAgentOutcome: outcome });
    const executor = vi.fn();
    const result = await runCodexAppServerTurn(item.turn, { completionStore: c.store, executeStdioTurn: executor });
    expect(result.roomAgentOutcome).toEqual(outcome);
    expect(executor).not.toHaveBeenCalled();
    expect(await supervisorTurnState(item, c.store)).toBe("READY");
  });
  it.each(["OPEN_TYPES", "CONFIGURE_PANE"] as const)("continues %s with the entire request and real results", async (type) => {
    const c = continuationFixture(type);
    const result = await prepareBackgroundContinuation(c.input, c.store);
    expect(result.state).toBe("READY");
    if (result.state !== "READY") throw Error("Missing continuation");
    expect(result.item.turn.prompt).toContain(c.initial.queueItem.turn.roomAgentOperatorRequest);
    expect(result.item.turn.prompt).toContain("Allocated two panes");
    expect(result.item.turn.prompt).toContain("pane:chat");
    expect(result.item.turn.agentRunId).not.toBe(c.initial.run.runId);
    expect(result.item.turn.traceId).not.toBe(c.initial.queueItem.turn.traceId);
    expect(result.item.turn.agentAssistantMessageId).not.toBe(c.initial.responseMessage.messageId);
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("RUNNING");
    expect(c.store.listRoomAgentActions(c.initial.mission.id)).toHaveLength(1);
    expect(c.store.listUnsignaledRoomAgentEnqueues()).toHaveLength(0);
    expect(c.store.listSpaceAgentMessages(c.session.sessionId).filter(m => m.role === "user")).toHaveLength(1);
  });

  it("reuses the committed continuation after a lost activity reply", async () => {
    const c = continuationFixture();
    const enqueue = c.store.enqueueRoomAgentMission.bind(c.store);
    vi.spyOn(c.store, "enqueueRoomAgentMission").mockImplementationOnce((input) => { enqueue(input); throw Error("Worker exited after commit"); });
    await expect(prepareBackgroundContinuation(c.input, c.store)).rejects.toThrow("Worker exited");
    const retried = await prepareBackgroundContinuation(c.input, c.store);
    const repeated = await prepareBackgroundContinuation(c.input, c.store);
    expect(retried).toEqual(repeated);
    expect(c.store.listSpaceAgentMessages(c.session.sessionId)).toHaveLength(4);
  });

  it("persists pending and discarded turns across continueAsNew", async () => {
    const c = continuationFixture();
    const result = await prepareBackgroundContinuation(c.input, c.store);
    if (result.state !== "READY") throw Error("Missing continuation");
    const resumed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify({ roomId: c.room.id,
      pending: [result.item], monitoringMissionIds: [c.initial.mission.id], interrupted: [{ item: c.initial.queueItem, reason: "Stopped" }] })));
    expect(resumed.pending[0]).toEqual(result.item);
    expect(resumed.interrupted).toHaveLength(1);
    expect(await supervisorTurnState(resumed.pending[0]!, c.store)).toBe("READY");
  });

  it.each(["PAUSED", "INTERRUPTED"] as const)("does not prepare after %s while monitoring", async (status) => {
    const c = continuationFixture();
    c.store.updateRoomAgentMission(c.initial.mission.id, { status });
    expect((await prepareBackgroundContinuation(c.input, c.store)).state).toBe(status === "PAUSED" ? "WAITING" : "DONE");
    expect(c.store.listSpaceAgentMessages(c.session.sessionId)).toHaveLength(2);
  });

  it.each(["stop", "follow-up"])("rejects %s racing the preparation transaction", async (kind) => {
    const c = continuationFixture();
    const original = c.store.enqueueRoomAgentMission.bind(c.store);
    vi.spyOn(c.store, "enqueueRoomAgentMission").mockImplementationOnce((input) => {
      if (kind === "stop") c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
      else c.enqueue("newer", "Only maximize the Chat pane.");
      return original(input);
    });
    expect((await prepareBackgroundContinuation(c.input, c.store)).state).toBe("WAITING");
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, "agent_run:bg-test-1")).toBeNull();
  });

  it("retires a prepared stale run without changing older replies or completing newer work", async () => {
    const c = continuationFixture();
    const result = await prepareBackgroundContinuation(c.input, c.store);
    if (result.state !== "READY") throw Error("Missing continuation");
    const before = c.store.listSpaceAgentMessages(c.session.sessionId).find(m => m.messageId === c.initial.responseMessage.messageId);
    const newer = c.enqueue("newer", "Stop the CLI and leave Chat alone.");
    expect(await supervisorTurnState(result.item, c.store)).toBe("SKIP");
    await discardSupervisorTurn(result.item, "Superseded", c.store);
    await discardSupervisorTurn(result.item, "Superseded", c.store);
    await finishSupervisorTurn({ item: result.item, status: "INTERRUPTED", statusReason: "Superseded" }, c.store);
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, result.item.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
    expect(c.store.getRoomAgentTurn(c.initial.mission.id)?.run.runId).toBe(newer.run.runId);
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("RUNNING");
    expect(c.store.listSpaceAgentMessages(c.session.sessionId).find(m => m.messageId === before?.messageId)).toEqual(before);
  });

  it("completes once only after the continuation verifies the remaining work", async () => {
    const c = continuationFixture();
    const result = await prepareBackgroundContinuation(c.input, c.store);
    if (result.state !== "READY") throw Error("Missing continuation");
    c.store.updateSpaceAgentRun(result.item.turn.agentRunId!, { status: "COMPLETED" });
    const finish = { item: result.item, status: "COMPLETED" as const, statusReason: "Both stories verified." };
    await finishSupervisorTurn(finish, c.store);
    const final = c.store.getRoomAgentMission(c.room.id, c.initial.mission.id);
    await finishSupervisorTurn(finish, c.store);
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)).toEqual(final);
    expect(final?.status).toBe("COMPLETED");
  });

  it("guards completion against stop committed between read and write", async () => {
    const c = continuationFixture();
    const original = c.store.updateRoomAgentMission.bind(c.store);
    vi.spyOn(c.store, "updateRoomAgentMission").mockImplementationOnce((id, input, trace, guard) => {
      original(id, { status: "INTERRUPTED", statusReason: "Operator stopped" });
      return original(id, input, trace, guard);
    });
    await finishSupervisorTurn({ item: c.initial.queueItem, status: "COMPLETED", statusReason: "Done" }, c.store);
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("INTERRUPTED");
  });
});
