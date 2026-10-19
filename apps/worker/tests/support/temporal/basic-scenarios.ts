import assert from "node:assert/strict";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import { activityTypes, currentHistory, events, Harness, waitFor, type History } from "./harness.js";

export type Captured = { name: string; workflowId: string; history: History };
export type Capture = (name: string, workflowId: string, history: History) => void;
export const turn = (suffix = "turn") => ({ roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic arithmetic: 2 + 2", artifactIds: [], traceId: `trace:${suffix}`, agentRunId: `agent_run:${suffix}`, permissionMode: null, collaborationMode: "default" });
const done = { status: "COMPLETED", message: "Synthetic four", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic result verified." } };
const snapshot = { status: "REFRESHED", generatedAt: "2026-01-01T00:00:00.000Z", sourceHash: "a".repeat(64), previousSourceHash: null, summary: {}, durationMs: 1 };
const mutation = { status: "APPLIED", changeSetId: "change:synthetic", resultingSourceHash: "b".repeat(64), reason: null };

export async function basicScenarios(h: Harness, queue: string, capture: Capture) {
  // Retries are decided by the actual server's activity retry policy.
  h.reset({ recordDummyTurnStarted: () => { if (Context.current().info.attempt < 3) throw new Error("Synthetic transient"); }, recordDummyTurnCompleted: () => done });
  let handle = await h.start("dummyTurnWorkflow", turn(), queue);
  assert.deepEqual(await handle.result(), done);
  assert.deepEqual(h.countCalls("recordDummyTurnStarted").map(c => c.attempt), [1, 2, 3]);
  capture("dummyTurnWorkflow", handle.workflowId, await handle.fetchHistory());

  for (const [providerId, activity] of [[undefined, "runCodexAppServerTurn"], ["opencode", "runOpenCodeAgentTurn"], ["cli:claude", "runCliAgentTurn"]] as const) {
    h.reset({ [activity]: () => done });
    handle = await h.start("codexAppServerTurnWorkflow", { ...turn(String(providerId)), providerId }, queue);
    assert.deepEqual(await handle.result(), done);
    assert.equal(h.countCalls(activity).length, 1);
    if (!providerId) capture("codexAppServerTurnWorkflow", handle.workflowId, await handle.fetchHistory());
  }
  h.reset({ runCodexAppServerTurn: () => { if (Context.current().info.attempt < 2) throw new Error("Synthetic transport retry"); return done; } });
  handle = await h.start("codexAppServerTurnWorkflow", turn("retry"), queue);
  assert.deepEqual(await handle.result(), done);
  assert.deepEqual(h.countCalls("runCodexAppServerTurn").map(c => c.attempt), [1, 2]);
  h.reset({ runCodexAppServerTurn: () => { throw ApplicationFailure.nonRetryable("Synthetic permanent failure", "SYNTHETIC_FAILURE"); } });
  handle = await h.start("codexAppServerTurnWorkflow", turn("failure"), queue);
  await assert.rejects(handle.result(), /Workflow execution failed/);
  assert.equal(h.countCalls("runCodexAppServerTurn").length, 1);

  // Timeout finishes a real durable timer; a signal during an activity is retained.
  for (const signal of [false, true]) {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let steps = 0;
    h.reset({ dotGoalStep: async () => { if (++steps > 1) return { state: "DONE", runId: null, goalStatus: "COMPLETE" }; if (signal) await gate; return { state: "WAITING", runId: null, goalStatus: "ACTIVE" }; } });
    handle = await h.start("dotGoalWorkflow", { goalId: `goal:wait-${signal}` }, queue);
    if (signal) { await waitFor(() => steps === 1, "goal activity entered"); await handle.signal(DOT_GOAL_SIGNAL); release(); }
    assert.deepEqual(await handle.result(), { goalStatus: "COMPLETE" });
    const hist = await handle.fetchHistory();
    assert.equal(events(hist, "EVENT_TYPE_TIMER_FIRED").length, signal ? 0 : 1);
    if (!signal) capture("dotGoalWorkflow", handle.workflowId, hist);
  }
  let timerSteps = 0;
  h.reset({ dotGoalStep: () => ++timerSteps === 1 ? { state: "PAUSED", runId: null, goalStatus: "ACTIVE" } : { state: "DONE", runId: null, goalStatus: "COMPLETE" } });
  handle = await h.start("dotGoalWorkflow", { goalId: "goal:timer-wake" }, queue);
  await waitFor(async () => events(await handle.fetchHistory(), "EVENT_TYPE_TIMER_STARTED").length === 1, "goal condition timer starts");
  await handle.signal(DOT_GOAL_SIGNAL);
  assert.deepEqual(await handle.result(), { goalStatus: "COMPLETE" });
  const wakeHistory = await handle.fetchHistory();
  assert.equal(events(wakeHistory, "EVENT_TYPE_TIMER_FIRED").length, 0);
  assert.equal(events(wakeHistory, "EVENT_TYPE_TIMER_CANCELED").length, 1);
  capture("dotGoalWorkflow-wake", handle.workflowId, wakeHistory);
  let steps = 0;
  h.reset({ dotGoalStep: () => ++steps > 300 ? { state: "DONE", runId: null, goalStatus: "COMPLETE" } : { state: "WAITING", runId: null, goalStatus: "ACTIVE" } });
  handle = await h.start("dotGoalWorkflow", { goalId: "goal:continue" }, queue);
  assert.deepEqual(await handle.result(), { goalStatus: "COMPLETE" });
  assert.equal(steps, 301);
  const goalHistory = await currentHistory(handle, h);
  const goalContinuation = events(goalHistory, "EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW")[0]!.workflowExecutionContinuedAsNewEventAttributes!;
  assert.deepEqual(defaultPayloadConverter.fromPayload(goalContinuation.input!.payloads![0]!), { goalId: "goal:continue" });
  assert.ok(h.countCalls("dotGoalStep").every(c => c.args[0] === "goal:continue"));
  assert.equal(h.countCalls("dotGoalStep").at(-1)!.runId, goalContinuation.newExecutionRunId);
  capture("dotGoalWorkflow-rollover", handle.workflowId, goalHistory);

  h.reset({ runRoomAgentBackgroundAction: () => { throw new Error("Synthetic action failure"); }, failRoomAgentBackgroundAction: () => undefined });
  handle = await h.start("roomAgentActionWorkflow", { bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:action" }, queue, "space-room-action:synthetic-fallback");
  await assert.rejects(handle.result());
  assert.deepEqual(h.countCalls("runRoomAgentBackgroundAction").map(c => c.attempt), [1, 2, 3, 4, 5]);
  assert.deepEqual(h.countCalls("failRoomAgentBackgroundAction")[0]!.args[0], { roomId: "room:synthetic", missionId: "mission:synthetic", actionId: "synthetic-fallback", cancelled: false });
  capture("roomAgentActionWorkflow", handle.workflowId, await handle.fetchHistory());

  const run = { id: "audit:synthetic", workflowId: "synthetic-consolidation-child", status: "COMPLETED" };
  h.reset({ refreshMemoryGraphSnapshot: () => snapshot,
    refreshAllMonthsMemoryGraphSnapshot: () => { throw new Error("Synthetic all-month failure"); },
    reconcileStaleSpaceAgentSessions: () => { throw new Error("Synthetic reconciliation failure"); },
    createScheduledMemoryAudit: input => { assert.equal(input.sourceHash, snapshot.sourceHash); return run; },
    prepareMemoryConsolidation: () => ({ run, changeSetId: "change:synthetic" }),
    executePersistedMemoryChangeSet: () => { if (Context.current().info.attempt === 1) throw new Error("Synthetic mutation retry"); return mutation; },
    finalizeMemoryRepair: input => { assert.deepEqual(input.mutationResult, mutation); return run; }
  });
  handle = await h.start("memoryMaintenanceWorkflow", { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:memory" }, queue);
  assert.deepEqual(await handle.result(), snapshot);
  for (const name of ["refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions"]) assert.deepEqual(h.countCalls(name).map(c => c.attempt), [1, 2, 3]);
  assert.equal(events(await handle.fetchHistory(), "EVENT_TYPE_CHILD_WORKFLOW_EXECUTION_COMPLETED").length, 1);
  assert.deepEqual(h.countCalls("executePersistedMemoryChangeSet").map(c => c.attempt), [1, 2]);
  capture("memoryMaintenanceWorkflow", handle.workflowId, await handle.fetchHistory());
  capture("memoryConsolidationWorkflow", run.workflowId, await h.env.client.workflow.getHandle(run.workflowId).fetchHistory());

  h.reset({ prepareMemoryConsolidation: () => ({ run, changeSetId: null }) });
  handle = await h.start("memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:no-change" }, queue);
  assert.deepEqual(await handle.result(), run);
  assert.deepEqual(activityTypes(await handle.fetchHistory()), ["prepareMemoryConsolidation"]);

  h.reset({ executePersistedMemoryChangeSet: () => { if (Context.current().info.attempt < 3) throw new Error("Synthetic mutation retry"); return mutation; } });
  handle = await h.start("memoryMutationWorkflow", { changeSetId: "change:synthetic", traceId: "trace:mutation" }, queue);
  assert.deepEqual(await handle.result(), mutation);
  assert.deepEqual(h.countCalls("executePersistedMemoryChangeSet").map(c => c.attempt), [1, 2, 3]);
  capture("memoryMutationWorkflow", handle.workflowId, await handle.fetchHistory());
  h.reset({ executePersistedMemoryChangeSet: () => { throw new Error("Synthetic permanent mutation failure"); } });
  handle = await h.start("memoryMutationWorkflow", { changeSetId: "change:synthetic", traceId: "trace:mutation-failure" }, queue);
  await assert.rejects(handle.result());
  assert.equal(h.countCalls("executePersistedMemoryChangeSet").length, 3);
}
export { done };
