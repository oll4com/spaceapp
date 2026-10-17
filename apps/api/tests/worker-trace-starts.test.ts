import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import type { RoomAgentSupervisorQueueItem } from "@space/contracts";
import { scheduleMemoryConsolidation } from "../src/memory-consolidation-coordinator.js";
import { scheduleMemoryMutation } from "../src/memory-mutation-coordinator.js";
import { TemporalRoomAgentWorkflowCoordinator } from "../src/room-agent.js";
import { createDotGoalService, TemporalDotGoalWorkflowCoordinator, type DotGoalServiceDeps } from "../src/dot-goals.js";
import { createRequestTraceContext, requestTraceContexts } from "../src/trace-context.js";

interface CapturedStartOptions {
  workflowId: string;
  args: unknown[];
  memo?: Record<string, string>;
  workflowIdReusePolicy?: string;
  signalArgs?: RoomAgentSupervisorQueueItem[];
}

const temporal = vi.hoisted(() => ({
  start: vi.fn(async (_type: string, options: CapturedStartOptions) => ({ workflowId: options.workflowId, firstExecutionRunId: "run:trace-start" })),
  signalWithStart: vi.fn(async (_type: string, _options: CapturedStartOptions) => ({ signaledRunId: "run:trace-supervisor" })),
  close: vi.fn(async () => undefined)
}));

vi.mock("@temporalio/client", async original => ({
  ...await original<typeof import("@temporalio/client")>(),
  Connection: { connect: async () => ({ close: temporal.close }) },
  Client: class {
    workflow = { start: temporal.start, signalWithStart: temporal.signalWithStart };
  }
}));

const w3cTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
const callerSpanId = "00f067aa0ba902b7";
const apiSpanId = "0123456789abcdef";
const inbound = `00-${w3cTraceId}-${callerSpanId}-01`;
const actualRequestTraceparent = `00-${w3cTraceId}-${apiSpanId}-01`;
const secret = "PRIVATE PROMPT /home/operator/private.txt token=sk-trace-secret";
const options = { address: "unused", namespace: "default", taskQueue: "trace-start-test" };

function rememberRequest(traceId: string) {
  const context = createRequestTraceContext(inbound, () => apiSpanId);
  requestTraceContexts.remember(traceId, context);
  return context;
}

function expectedMemo(traceId: string) {
  return { spaceTraceId: traceId, traceparent: actualRequestTraceparent, w3cTraceId };
}

function roomItem(traceId: string): RoomAgentSupervisorQueueItem {
  return {
    missionId: "room_agent_mission:trace-start",
    turn: {
      roomId: "room:trace-start", paneId: "pane:trace-start", traceId,
      prompt: secret, artifactIds: [], permissionMode: null, collaborationMode: "default"
    }
  };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("API origins for worker traces", () => {
  it("parents memory consolidation to the actual API span without changing its strict input", async () => {
    const input = { runId: "memory_consolidation:trace-start", traceId: "req:trace-consolidation" };
    rememberRequest(input.traceId);
    const workflowId = `space-memory-consolidation:${"a".repeat(64)}`;
    await scheduleMemoryConsolidation(input, workflowId, temporal.start);
    expect(temporal.start.mock.calls[0]![1]).toMatchObject({
      workflowId, args: [input], memo: expectedMemo(input.traceId),
      workflowIdReusePolicy: "REJECT_DUPLICATE", workflowIdConflictPolicy: "USE_EXISTING"
    });
    expect(temporal.start.mock.calls[0]![1].memo).toEqual(expectedMemo(input.traceId));
  });

  it("parents memory mutation to the actual API span and preserves its command identity", async () => {
    const input = { changeSetId: "memory_change:trace-start", traceId: "req:trace-mutation" };
    rememberRequest(input.traceId);
    const command = `reconcile:${"b".repeat(64)}`;
    await scheduleMemoryMutation(input, temporal.start, command);
    expect(temporal.start.mock.calls[0]![1]).toMatchObject({
      workflowId: `space-memory-mutation:command:${command}`, args: [input], memo: expectedMemo(input.traceId),
      workflowIdReusePolicy: "REJECT_DUPLICATE", workflowIdConflictPolicy: "USE_EXISTING"
    });
    expect(temporal.start.mock.calls[0]![1].memo).toEqual(expectedMemo(input.traceId));
  });

  it("parents a newly started supervisor to its queued turn's API span without putting its prompt in memo", async () => {
    const item = roomItem("req:trace-supervisor");
    rememberRequest(item.turn.traceId);
    await new TemporalRoomAgentWorkflowCoordinator(options).enqueue(item);
    const started = temporal.signalWithStart.mock.calls[0]![1];
    expect(started.memo).toEqual({ ...expectedMemo(item.turn.traceId), missionId: item.missionId });
    expect(started.signalArgs![0]!.turn.traceparent).toBe(actualRequestTraceparent);
    expect(started.signalArgs![0]!.turn.prompt).toBe(secret);
    expect(JSON.stringify(started.memo)).not.toMatch(/PRIVATE PROMPT|operator|sk-trace-secret|prompt|authorization/);
    expect(started.args).toEqual([{ roomId: item.turn.roomId, pending: [], processedCount: 0 }]);
  });

  it("uses a queued turn's valid durable context when its request has left the registry", async () => {
    const item = roomItem("req:trace-durable-supervisor");
    item.turn.traceparent = actualRequestTraceparent;
    await new TemporalRoomAgentWorkflowCoordinator(options).enqueue(item);
    expect(temporal.signalWithStart.mock.calls[0]![1].memo).toEqual({ ...expectedMemo(item.turn.traceId), missionId: item.missionId });
  });

  it("carries the request span through both Dot Goal start and ensure", async () => {
    const traceId = "req:trace-goal-start";
    rememberRequest(traceId);
    const coordinator = new TemporalDotGoalWorkflowCoordinator(options);
    await coordinator.start("dot_goal:trace-start", traceId);
    await expect(coordinator.ensure("dot_goal:trace-ensure", traceId)).resolves.toBe(true);
    expect(temporal.start.mock.calls.map(([, start]) => start.memo)).toEqual([expectedMemo(traceId), expectedMemo(traceId)]);
    expect(temporal.start.mock.calls.map(([, start]) => start.args)).toEqual([
      [{ goalId: "dot_goal:trace-start" }], [{ goalId: "dot_goal:trace-ensure" }]
    ]);
    expect(temporal.start.mock.calls.map(([, start]) => start.workflowIdReusePolicy)).toEqual(["REJECT_DUPLICATE", "ALLOW_DUPLICATE"]);
    expect(temporal.close).toHaveBeenCalledTimes(2);
  });

  it("threads the creating HTTP request through the Dot Goal service while keeping the objective private", async () => {
    const traceId = "req:trace-goal-create";
    rememberRequest(traceId);
    const dotId = `dot:${"a".repeat(32)}`;
    const session = { sessionId: "agent_session:trace-start", roomId: "room:trace-start", dotId, isActive: true };
    const goal = { goalId: "dot_goal:trace-create", roomId: session.roomId, status: "ACTIVE" };
    const deps: DotGoalServiceDeps = {
      store: {
        getSpaceAgentSession: vi.fn(async () => session),
        getRoom: vi.fn(async () => ({ ownerUserId: "user:trace-owner" }))
      } as never,
      dots: { get: vi.fn(async () => ({ dotId })) } as never,
      goals: { create: vi.fn(async () => goal) } as never,
      workflow: new TemporalDotGoalWorkflowCoordinator(options),
      supportsGoalTools: () => true,
      sendStep: vi.fn(), interrupt: vi.fn(), submission: vi.fn(), atCapacity: vi.fn(), audit: vi.fn(async () => undefined)
    };
    await createDotGoalService(deps).create("user:trace-owner", dotId, {
      sessionId: session.sessionId, objective: secret, milestones: ["Prepare"], criteria: ["Ready"]
    }, { id: traceId, body: { prompt: secret }, headers: { authorization: secret } } as unknown as FastifyRequest);
    const started = temporal.start.mock.calls[0]![1];
    expect(started.memo).toEqual(expectedMemo(traceId));
    expect(started.args).toEqual([{ goalId: goal.goalId }]);
    expect(JSON.stringify(started)).not.toMatch(/PRIVATE PROMPT|operator|sk-trace-secret|objective|authorization/);
  });

  it("keeps unknown-origin and reconciliation starts unchanged instead of fabricating parents", async () => {
    await scheduleMemoryConsolidation({ runId: "memory_consolidation:unknown", traceId: "req:trace-unknown-consolidation" },
      `space-memory-consolidation:${"c".repeat(64)}`, temporal.start);
    await scheduleMemoryMutation({ changeSetId: "memory_change:unknown", traceId: "req:trace-unknown-mutation" }, temporal.start);
    const goal = new TemporalDotGoalWorkflowCoordinator(options);
    await goal.start("dot_goal:unknown", "req:trace-unknown-goal");
    await goal.ensure("dot_goal:reconcile");
    await new TemporalRoomAgentWorkflowCoordinator(options).enqueue(roomItem("req:trace-unknown-supervisor"));
    for (const [, start] of [...temporal.start.mock.calls, ...temporal.signalWithStart.mock.calls]) expect(start).not.toHaveProperty("memo");
  });
});
