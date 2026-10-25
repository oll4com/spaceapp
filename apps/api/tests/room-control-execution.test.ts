import { describe, expect, it, vi } from "vitest";
import { spaceAgentRoomActionBridgeRequestSchema, type ControlOperation } from "@space/contracts";
import { InMemorySpaceStore } from "@space/runtime";
import { createRoomActionExecutor } from "../src/room-actions.js";
import { RetryableRoomControlError } from "../src/room-control-execution.js";

function setup() {
  const store = new InMemorySpaceStore();
  const room = store.createRoom({ name: "Durable control", initialPaneCount: 0 });
  const pane = store.getOrCreateRoomAgentPane(room.id);
  const session = store.createSpaceAgentSession({ paneId: pane.id, roomId: room.id, title: "Room Agent",
    selectedModelId: "gpt-5.6-sol", selectedModelConfigId: "gpt-5.6-sol:high", selectedProviderId: null,
    selectedProviderName: null, selectedModelName: "Test model", selectedReasoningKey: "high", selectedToolIds: ["room:control"] });
  const prompt = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "user", content: "Run the mission." });
  const response = store.createSpaceAgentMessage({ sessionId: session.sessionId, role: "assistant", content: "", status: "RUNNING" });
  const request = store.createRoomAgentRequest({ requestId: "request:control-mission", roomId: room.id,
    sessionId: session.sessionId, clientRequestId: "client:control-mission", promptMessageId: prompt.messageId, responseMessageId: response.messageId });
  const mission = store.createRoomAgentMission({ id: "mission:control-mission", requestId: request.requestId,
    roomId: room.id, sessionId: session.sessionId, workflowId: `supervisor:${room.id}`, status: "RUNNING", statusReason: "Working." });
  const bridge = (actions = [{ toolId: "room:control", action: { type: "control", tool: "space_execute",
    arguments: { roomId: room.id, requestId: "model:reused-key", actions: [{ kind: "layout", operation: "sort" }] } } }]) =>
    spaceAgentRoomActionBridgeRequestSchema.parse({ roomId: room.id, missionId: mission.id, agentPaneId: pane.id,
      agentSessionId: session.sessionId, selectedToolIds: ["room:control"], actions, requestId: "bridge:control-mission" });
  let operation: ControlOperation | undefined;
  const control = vi.fn(async (_roomId: string, tool: string, args: Record<string, unknown>) => {
    if (tool === "space_execute") operation ??= {
      id: "operation:durable-control", actorId: "user:operator", roomId: room.id, requestId: args.requestId as string,
      payloadHash: "test", status: "COMPLETED", results: [{ index: 0, status: "COMPLETED", detail: "Applied.", evidence: {} }],
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextIndex: 1, cancelRequested: false
    };
    return operation;
  });
  const executor = (extra: Partial<Parameters<typeof createRoomActionExecutor>[0]> = {}) => createRoomActionExecutor({
    store, control, cliTerminalManager: {} as never, spaceAgentAdapter: {} as never, browserSessionManager: {} as never,
    pollIntervalMs: 1, actionTimeoutMs: 1000, ...extra
  });
  return { store, room, mission, bridge, control, executor };
}

describe("Durable Room Agent MCP execution", () => {
  it("binds execute to the persisted action and replays completion without another mutation", async () => {
    const c = setup();
    expect((await c.executor().execute(c.bridge(), "trace:first")).results[0]!.status).toBe("EXECUTED");
    const action = c.store.listRoomAgentActions(c.mission.id)[0]!;
    expect(c.control).toHaveBeenCalledWith(c.room.id, "space_execute", expect.objectContaining({ requestId: `room-control:${action.actionId}` }), c.mission.id);
    expect(action).toMatchObject({ status: "COMPLETED", evidence: { phase: "COMPLETED", controlOperationId: "operation:durable-control" } });
    await c.executor().execute(c.bridge(), "trace:after-restart");
    expect(c.control).toHaveBeenCalledTimes(1);
  });

  it.each(["FAILED", "PARTIAL", "UNKNOWN", "CANCELLED"] as const)("blocks %s receipts and never submits the dependent action", async status => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    c.control.mockImplementation(async (...args) => ({ ...await normal(...args), status } as ControlOperation));
    const first = c.bridge().actions[0]!;
    const bridge = c.bridge([first, first] as never);
    const result = await c.executor().execute(bridge, "trace:failed");
    expect(result.results.map(item => item.status)).toEqual(["BLOCKED", "BLOCKED"]);
    expect(result.results[1]!.evidence.phase).toBe("NOT_SUBMITTED");
    expect(c.control).toHaveBeenCalledTimes(1);
    expect(c.store.listRoomAgentActions(c.mission.id)).toMatchObject([{ status: "BLOCKED", evidence: { control: { status } } }]);
  });

  it("persists RUNNING, then polls rather than submitting another execute", async () => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    let poll = 0;
    c.control.mockImplementation(async (...args) => {
      const value = await normal(...args);
      if (args[1] === "space_execute") return { ...value, status: "RUNNING", results: [] } as ControlOperation;
      expect(c.store.listRoomAgentActions(c.mission.id)[0]).toMatchObject({ status: "RUNNING", evidence: { phase: "RUNNING" } });
      return ++poll === 1 ? { ...value, status: "RUNNING", results: [] } as ControlOperation : value;
    });
    expect((await c.executor().execute(c.bridge(), "trace:poll")).results[0]!.status).toBe("EXECUTED");
    expect(c.control.mock.calls.map(call => call[1])).toEqual(["space_execute", "space_operations", "space_operations"]);
  });

  it("recovers a lost submit reply with the same key on a new executor", async () => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    c.control.mockImplementationOnce(async (...args) => { await normal(...args); throw new Error("Lost reply"); });
    await expect(c.executor().execute(c.bridge(), "trace:lost")).rejects.toBeInstanceOf(RetryableRoomControlError);
    expect(c.store.listRoomAgentActions(c.mission.id)[0]).toMatchObject({ status: "RUNNING", evidence: { phase: "SUBMITTING" } });
    await c.executor().execute(c.bridge(), "trace:restart");
    expect(c.control.mock.calls[0]![2]).toEqual(c.control.mock.calls[1]![2]);
    expect(c.store.listRoomAgentActions(c.mission.id)).toHaveLength(1);
  });

  it("recovers a lost poll with only operation lookup", async () => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    c.control.mockImplementationOnce(async (...args) => ({ ...await normal(...args), status: "RUNNING", results: [] } as ControlOperation));
    c.control.mockRejectedValueOnce(new Error("Lost poll"));
    await expect(c.executor().execute(c.bridge(), "trace:lost")).rejects.toBeInstanceOf(RetryableRoomControlError);
    await c.executor().execute(c.bridge(), "trace:restart");
    expect(c.control.mock.calls.map(call => call[1])).toEqual(["space_execute", "space_operations", "space_operations"]);
  });

  it("never crosses the API boundary if the intent checkpoint cannot be stored", async () => {
    const c = setup();
    const update = c.store.updateRoomAgentAction.bind(c.store);
    vi.spyOn(c.store, "updateRoomAgentAction").mockImplementation((id, value, trace) => {
      if (value.evidence) throw new Error("Persistence unavailable");
      return update(id, value, trace);
    });
    await expect(c.executor().execute(c.bridge(), "trace:checkpoint")).rejects.toBeInstanceOf(RetryableRoomControlError);
    expect(c.control).not.toHaveBeenCalled();
  });

  it.each(["invalid", "foreign", "empty", "contradictory"])("fails closed for a %s receipt", async kind => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    c.control.mockImplementation(async (...args) => {
      const value = await normal(...args);
      return (kind === "invalid" ? { ok: true } : kind === "foreign" ? { ...value, roomId: "room:foreign" }
        : { ...value, results: kind === "empty" ? [] : [{ index: 0, status: "PENDING", detail: "Waiting", evidence: {} }] }) as ControlOperation;
    });
    expect((await c.executor().execute(c.bridge(), "trace:invalid")).results[0]!.status).toBe("BLOCKED");
    await c.executor().execute(c.bridge(), "trace:retry");
    expect(c.control).toHaveBeenCalledTimes(1);
  });

  it("queues durable control without submitting dependent actions in the foreground", async () => {
    const c = setup();
    const enqueueAction = vi.fn(async () => {});
    const first = c.bridge().actions[0]!;
    const result = await c.executor({ enqueueAction }).execute(c.bridge([first, first] as never), "trace:queue");
    expect(result.results.map(item => [item.status, item.evidence.phase])).toEqual([["EXECUTED", "QUEUED"], ["BLOCKED", "NOT_SUBMITTED"]]);
    expect(c.control).not.toHaveBeenCalled();
    expect(enqueueAction).toHaveBeenCalledTimes(1);
    expect(c.store.listRoomAgentActions(c.mission.id)[0]!.requestPayload._roomBackgroundRoot).toBe(true);
  });

  it("blocks exhausted transport recovery instead of leaving a RUNNING action forever", async () => {
    const c = setup();
    c.control.mockRejectedValue(new Error("Unavailable"));
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(c.executor().execute(c.bridge(), `trace:${attempt}`)).rejects.toBeInstanceOf(RetryableRoomControlError);
    }
    expect((await c.executor().execute(c.bridge(), "trace:last")).results[0]).toMatchObject({ status: "BLOCKED" });
    expect(c.store.listRoomAgentActions(c.mission.id)[0]).toMatchObject({ status: "BLOCKED", attemptCount: 3 });
    await c.executor().execute(c.bridge(), "trace:no-retry");
    expect(c.control).toHaveBeenCalledTimes(3);
  });

  it("does not advance after mission interruption during a running operation", async () => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    c.control.mockImplementation(async (...args) => {
      const value = await normal(...args);
      c.store.updateRoomAgentMission(c.mission.id, { status: "INTERRUPTED", statusReason: "Stopped by operator." });
      return { ...value, status: "RUNNING", results: [] } as ControlOperation;
    });
    expect((await c.executor().execute(c.bridge(), "trace:stop")).results[0]!.status).toBe("BLOCKED");
    expect(c.control).toHaveBeenCalledTimes(2);
    expect(c.control.mock.calls[1]![1]).toBe("space_operations");
    expect(c.control.mock.calls[1]![2]).toMatchObject({ operation: "cancel", id: "operation:durable-control" });
    expect(c.store.listRoomAgentActions(c.mission.id)[0]).toMatchObject({ status: "BLOCKED", evidence: { control: { status: "RUNNING" } } });
  });

  it("reports an observation timeout as unconfirmed, never completed", async () => {
    const c = setup();
    const normal = c.control.getMockImplementation()!;
    c.control.mockImplementation(async (...args) => ({ ...await normal(...args), status: "RUNNING", results: [] } as ControlOperation));
    expect((await c.executor({ actionTimeoutMs: 0 }).execute(c.bridge(), "trace:timeout")).results[0]).toMatchObject({ status: "BLOCKED", evidence: { phase: "UNKNOWN" } });
  });

  it("recovers twenty ordered control steps across executor replacement without duplicate effects", async () => {
    const c = setup();
    const operations = new Map<string, ControlOperation>();
    let effects = 0;
    let loseReply = false;
    c.control.mockImplementation(async (_room, tool, args) => {
      if (tool !== "space_execute") return [...operations.values()].find(value => value.id === args.id);
      const key = args.requestId as string;
      if (!operations.has(key)) {
        effects++;
        operations.set(key, { id: `operation:step-${effects}`, actorId: "user:operator", roomId: c.room.id, requestId: key,
          payloadHash: "test", status: "COMPLETED", results: [{ index: 0, status: "COMPLETED", detail: "Applied.", evidence: {} }],
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), nextIndex: 1, cancelRequested: false });
      }
      if (loseReply) { loseReply = false; throw new Error("Connection dropped after applying control"); }
      return operations.get(key);
    });
    for (let step = 0; step < 20; step++) {
      const bridge = { ...c.bridge(), requestId: `bridge:step-${step}` };
      loseReply = step % 3 === 0;
      if (loseReply) await expect(c.executor().execute(bridge, "trace:lost")).rejects.toBeInstanceOf(RetryableRoomControlError);
      expect((await c.executor().execute(bridge, "trace:recover")).results[0]!.status).toBe("EXECUTED");
      expect(effects).toBe(step + 1);
    }
    expect(c.store.listRoomAgentActions(c.mission.id)).toHaveLength(20);
    expect(c.store.listRoomAgentActions(c.mission.id).every(action => action.status === "COMPLETED")).toBe(true);
    expect(operations.size).toBe(20);
  });
});
