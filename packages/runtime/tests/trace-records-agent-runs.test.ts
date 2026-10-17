import { expect, it } from "vitest";
import { InMemorySpaceStore, traceWorkflowIds } from "../src/index.js";

// Agent runs have no trace id: the trace lookup reaches them through the trace's workflow ids.
it("returns the agent runs of the workflows a trace names", () => {
  const store = new InMemorySpaceStore();
  store.appendEvent({ roomId: null, paneId: null, turnId: null, workflowId: "workflow:traced", traceId: "req:agentruns01",
    type: "TURN_QUEUED", message: "queued", payload: {} } as never);
  const runs = (store as unknown as { spaceAgentRuns: Map<string, unknown> }).spaceAgentRuns;
  const run = (runId: string, workflowId: string, status: string) => ({ runId, workflowId, status, errorCode: status === "FAILED" ? "TIMEOUT" : null,
    createdAt: "2026-10-16T09:00:00.000Z", completedAt: null });
  runs.set("agent_run:traced", run("agent_run:traced", "workflow:traced", "FAILED"));
  runs.set("agent_run:other", run("agent_run:other", "workflow:other", "COMPLETED"));
  const records = store.listTraceRecords("req:agentruns01");
  expect(records.agentRuns).toEqual([{ runId: "agent_run:traced", workflowId: "workflow:traced", status: "FAILED", errorCode: "TIMEOUT",
    createdAt: "2026-10-16T09:00:00.000Z", completedAt: null, continuationOf: null }]);
  expect(traceWorkflowIds({ events: [{ workflowId: null, payload: { workflowId: "workflow:payload" } }] as never, workflows: [] })).toEqual(["workflow:payload"]);
});

// Room Agent missions and task runs keep the request trace; background continuations keep their own trace and are
// followed from the run they continue (observability "Not covered", 2026-10-16).
it("returns the trace's Room Agent missions and task runs and follows background continuations", () => {
  const store = new InMemorySpaceStore();
  const traceId = "req:missions0001";
  store.appendEvent({ roomId: null, paneId: null, turnId: null, workflowId: "workflow:mission", traceId,
    type: "TURN_QUEUED", message: "queued", payload: {} } as never);
  const internals = store as unknown as { spaceAgentRuns: Map<string, unknown>; roomAgentEnqueues: Map<string, unknown>;
    roomAgentRequests: Map<string, unknown> };
  const run = (runId: string, workflowId: string, status: string) => ({ runId, workflowId, status, errorCode: null,
    createdAt: "2026-10-16T09:00:00.000Z", completedAt: null });
  internals.spaceAgentRuns.set("agent_run:first", run("agent_run:first", "workflow:mission", "COMPLETED"));
  internals.spaceAgentRuns.set("agent_run:bg-1", run("agent_run:bg-1", "workflow:bg-1", "COMPLETED"));
  internals.spaceAgentRuns.set("agent_run:bg-2", run("agent_run:bg-2", "workflow:bg-2", "RUNNING"));
  const continuation = (runId: string, sourceRunId: string) => ({ run: { runId },
    queueItem: { missionId: "room_agent_mission:mission01", turn: { roomAgentContinuation: { sourceRunId, generation: 1 } } } });
  internals.roomAgentEnqueues.set("enqueue:bg-1", continuation("agent_run:bg-1", "agent_run:first"));
  internals.roomAgentEnqueues.set("enqueue:bg-2", continuation("agent_run:bg-2", "agent_run:bg-1"));
  internals.roomAgentRequests.set("room_agent_request:request01", { requestId: "room_agent_request:request01", roomId: "room:roomtest01",
    sessionId: "space_agent_session:session01" });
  const mission = store.createRoomAgentMission({ id: "room_agent_mission:mission01", requestId: "room_agent_request:request01", roomId: "room:roomtest01",
    sessionId: "space_agent_session:session01", workflowId: "workflow:mission", status: "RUNNING", currentPaneId: null,
    statusReason: "Running.", executionState: {} } as never, traceId);
  store.updateRoomAgentMission(mission.id, { status: "FAILED", errorCode: "ROOM_AGENT_TOKEN_LIMIT", statusReason: "Budget reached." });
  store.updateRoomAgentMission(mission.id, { errorCode: "LATER_CODE" });
  store.upsertRoomAgentTaskRun({ runId: "room_agent_task_run:taskrun01", missionId: mission.id, roomId: "room:roomtest01", stepId: "step-1",
    paneId: "pane:panetest01", label: "Build", instruction: "Build it", status: "QUEUED", state: "RUNNING", modelId: null,
    reasoningEffort: null, qualityScore: null, qualityUnavailableReason: null, reliabilityScore: 0, combinedScore: null, rubric: null,
    queueMs: 0, firstResponseMs: null, executionMs: 0, totalMs: 0, retries: 0, recoveries: 0, stalls: 0, completedAt: null,
    verificationSummary: "Queued.", queuedAt: "2026-10-16T09:00:00.000Z", startedAt: null, firstResponseAt: null } as never, traceId);

  const records = store.listTraceRecords(traceId);
  expect(records.agentRuns?.map((item) => [item.runId, item.continuationOf])).toEqual([
    ["agent_run:first", null], ["agent_run:bg-1", "agent_run:first"], ["agent_run:bg-2", "agent_run:bg-1"]
  ]);
  expect(records.roomAgentMissions).toEqual([{ missionId: mission.id, roomId: "room:roomtest01", status: "FAILED",
    errorCode: "ROOM_AGENT_TOKEN_LIMIT", queuedAt: mission.queuedAt, completedAt: null }]);
  expect(records.roomAgentTaskRuns).toEqual([{ runId: "room_agent_task_run:taskrun01", missionId: mission.id, roomId: "room:roomtest01",
    status: "QUEUED", errorCode: null, queuedAt: "2026-10-16T09:00:00.000Z", completedAt: null }]);
  expect(store.listTraceRecords("req:othertrace01").roomAgentMissions).toEqual([]);
});
