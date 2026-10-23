/** Real Temporal sandbox tests. Only activity boundaries are replaced; no provider or database is contacted. */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { DOT_GOAL_SIGNAL, dummyTurnInputSchema } from "@space/contracts";
import { describe, expect, it, vi } from "vitest";
import { NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT } from "../src/turn-runtime-policy.js";
import { jsonPayload, waitFor, withTemporal } from "./support/temporal-harness.js";

vi.setConfig({ testTimeout: 60_000 });

const turn = dummyTurnInputSchema.parse({
  roomId: "room:temporal-test", paneId: "pane:temporal-test", prompt: "Synthetic offline task",
  traceId: "trace:temporal-test"
});
const turnResult = { status: "COMPLETED", output: "synthetic result" };
const memoryInput = { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:memory-test" };
const mutationInput = { changeSetId: "changeset:test", traceId: memoryInput.traceId };
const mutationResult = { status: "APPLIED", changeSetId: mutationInput.changeSetId, resultingSourceHash: "a".repeat(64), reason: null };
const consolidationInput = { runId: "audit:test", traceId: memoryInput.traceId };
const repairedRun = { id: consolidationInput.runId, status: "COMPLETED" };
const snapshot = { status: "REFRESHED", sourceHash: "a".repeat(64), durationMs: 1 };
const actionInput = { actionId: "action:explicit", bridge: { roomId: turn.roomId, missionId: "mission:test" }, traceId: turn.traceId };
const id = (prefix: string) => `${prefix}:${randomUUID()}`;
const transient = () => ApplicationFailure.create({ message: "Synthetic transient failure", type: "TEST_TRANSIENT" });

// Tests deliberately use workflow names: importing production workflow modules in
// the test process would bypass the isolated workflow bundle under test.
describe("Temporal: Dot Goal workflow", () => {
  it("uses durable pause, waiting and observation timers before terminal completion", async () => {
    const steps = [
      { state: "PAUSED", runId: null, goalStatus: "PAUSED" },
      { state: "WAITING", runId: null, goalStatus: "ACTIVE" },
      { state: "STARTED", runId: "run:test", goalStatus: "ACTIVE" },
      { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    ];
    const dotGoalStep = vi.fn(async () => steps.shift()!);
    const dotGoalObserve = vi.fn().mockResolvedValueOnce({ run: "RUNNING", goalStatus: "ACTIVE" })
      .mockResolvedValueOnce({ run: "COMPLETED", goalStatus: "ACTIVE" });
    await withTemporal({ activities: { dotGoalStep, dotGoalObserve } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("dotGoalWorkflow", { taskQueue, workflowId: id("goal-timers"), args: [{ goalId: "goal:test" }] });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const history = await handle.fetchHistory();
      expect(history.events?.flatMap((e) => e.timerStartedEventAttributes ? [String(e.timerStartedEventAttributes.startToFireTimeout?.seconds)] : [])).toEqual(["3600", "30", "15", "15"]);
      expect(dotGoalStep).toHaveBeenCalledTimes(4);
      expect(dotGoalObserve.mock.calls).toEqual([["goal:test", "run:test"], ["goal:test", "run:test"]]);
    });
  });

  it("retains a wake received during an activity and consumes it without starting a timer", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const dotGoalStep = vi.fn().mockImplementationOnce(async () => {
      await blocked;
      return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
    }).mockResolvedValue({ state: "DONE", runId: null, goalStatus: "CANCELLED" });
    await withTemporal({ activities: { dotGoalStep } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("dotGoalWorkflow", { taskQueue, workflowId: id("goal-wake"), args: [{ goalId: "goal:test" }] });
      try {
        await waitFor(() => dotGoalStep.mock.calls.length === 1);
        await handle.signal(DOT_GOAL_SIGNAL);
      } finally { release(); }
      expect(await handle.result()).toEqual({ goalStatus: "CANCELLED" });
      expect((await handle.fetchHistory()).events?.some((e) => e.timerStartedEventAttributes)).toBe(false);
      expect(dotGoalStep).toHaveBeenCalledTimes(2);
    });
  });

  it("cancels an already-started durable timer when a wake arrives", async () => {
    const dotGoalStep = vi.fn().mockResolvedValueOnce({ state: "PAUSED", runId: null, goalStatus: "PAUSED" })
      .mockResolvedValue({ state: "DONE", runId: null, goalStatus: "COMPLETED" });
    await withTemporal({ activities: { dotGoalStep } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("dotGoalWorkflow", { taskQueue, workflowId: id("goal-wake-timer"), args: [{ goalId: "goal:test" }] });
      // Do not call result() until after signaling: that would unlock virtual
      // time and permit the paused timer to fire before the wake is delivered.
      const deadline = Date.now() + 10_000;
      let history = await handle.fetchHistory();
      while (!history.events?.some((event) => event.timerStartedEventAttributes) && Date.now() < deadline) {
        await delay(10);
        history = await handle.fetchHistory();
      }
      expect(history.events?.some((event) => event.timerStartedEventAttributes)).toBe(true);
      await handle.signal(DOT_GOAL_SIGNAL);
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      history = await handle.fetchHistory();
      expect(history.events?.filter((event) => event.timerCanceledEventAttributes)).toHaveLength(1);
      expect(history.events?.some((event) => event.timerFiredEventAttributes)).toBe(false);
      expect(dotGoalStep).toHaveBeenCalledTimes(2);
    });
  });

  it("continues unfinished work as a new run after 300 iterations, preserving its input", async () => {
    let steps = 0;
    const dotGoalStep = vi.fn(async (_goalId: string) => ++steps <= 300
      ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" });
    await withTemporal({ activities: { dotGoalStep } }, async ({ client, taskQueue }) => {
      const workflowId = id("goal-rollover");
      const handle = await client.workflow.start("dotGoalWorkflow", { taskQueue, workflowId, args: [{ goalId: "goal:rollover" }] });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const history = await client.workflow.getHandle(workflowId, handle.firstExecutionRunId).fetchHistory();
      const continued = history.events?.find((e) => e.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
      expect(continued).toBeDefined();
      expect(jsonPayload(continued!.input!.payloads![0]!)).toEqual({ goalId: "goal:rollover" });
      expect(history.events?.filter((e) => e.activityTaskScheduledEventAttributes)).toHaveLength(300);
      expect(dotGoalStep).toHaveBeenCalledTimes(301);
      expect(dotGoalStep.mock.calls.every(([goalId]) => goalId === "goal:rollover")).toBe(true);
    });
  }, 120_000);
});

describe("Temporal: Dot Goal activity failures", () => {
  it.each([false, true])("retries step failures with the twenty-attempt policy (exhausted=%s)", async (exhausted) => {
    let attempts = 0;
    const dotGoalStep = vi.fn(async () => {
      if (++attempts < 20 || exhausted) throw transient();
      return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    });
    await withTemporal({ activities: { dotGoalStep } }, async ({ client, taskQueue }) => {
      const result = client.workflow.execute("dotGoalWorkflow", { taskQueue, workflowId: id("goal-retry"), args: [{ goalId: "goal:test" }] });
      if (exhausted) await expect(result).rejects.toThrow(); else expect(await result).toEqual({ goalStatus: "COMPLETED" });
      expect(dotGoalStep).toHaveBeenCalledTimes(20);
    });
  });
});

describe("Temporal: turn workflows", () => {
  it("retries both dummy activities in order and returns the completion result", async () => {
    const order: string[] = [];
    let starts = 0; let completions = 0;
    const recordDummyTurnStarted = vi.fn(async () => { order.push("start"); if (++starts < 3) throw transient(); });
    const recordDummyTurnCompleted = vi.fn(async () => { order.push("complete"); if (++completions < 3) throw transient(); return turnResult; });
    await withTemporal({ activities: { recordDummyTurnStarted, recordDummyTurnCompleted } }, async ({ client, taskQueue }) => {
      expect(await client.workflow.execute("dummyTurnWorkflow", { taskQueue, workflowId: id("dummy-retry"), args: [turn] })).toEqual(turnResult);
      expect(order).toEqual(["start", "start", "start", "complete", "complete", "complete"]);
      expect(recordDummyTurnStarted).toHaveBeenLastCalledWith(turn);
      expect(recordDummyTurnCompleted).toHaveBeenLastCalledWith(turn);
    });
  });

  it.each(["recordDummyTurnStarted", "recordDummyTurnCompleted"])("propagates exhausted %s failures", async (failing) => {
    const recordDummyTurnStarted = vi.fn(async () => { if (failing === "recordDummyTurnStarted") throw transient(); });
    const recordDummyTurnCompleted = vi.fn(async () => { throw transient(); });
    await withTemporal({ activities: { recordDummyTurnStarted, recordDummyTurnCompleted } }, async ({ client, taskQueue }) => {
      await expect(client.workflow.execute("dummyTurnWorkflow", { taskQueue, workflowId: id("dummy-fail"), args: [turn] })).rejects.toThrow();
      expect(recordDummyTurnStarted).toHaveBeenCalledTimes(failing === "recordDummyTurnStarted" ? 3 : 1);
      expect(recordDummyTurnCompleted).toHaveBeenCalledTimes(failing === "recordDummyTurnStarted" ? 0 : 3);
    });
  });

  it.each([
    ["opencode", {}, "runOpenCodeAgentTurn", 2400, 1],
    ["cli:claude", {}, "runCliAgentTurn", 1800, 1],
    // The time-skipping server records the native 100-year request as its
    // normalized ten-year activity horizon; assert the actual durable history.
    ["codex", { agentSessionId: "session:test", agentAssistantMessageId: "message:test" }, "runCodexAppServerTurn", 315360000, 5],
    ["codex", { roomAgentMissionId: "mission:test" }, "runCodexAppServerTurn", 86400, 5]
  ] as const)("routes %s turns with %j and records production retry/timeout options", async (providerId, extra, activityName, timeout, attempts) => {
    const activity = vi.fn(async () => turnResult);
    const input = { ...turn, providerId, ...extra };
    if ("agentSessionId" in extra) expect(NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT).toBe("36500 days");
    await withTemporal({ activities: { [activityName]: activity } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("codexAppServerTurnWorkflow", { taskQueue, workflowId: id("turn-route"), args: [input] });
      expect(await handle.result()).toEqual(turnResult);
      expect(activity).toHaveBeenCalledExactlyOnceWith(input);
      const scheduled = (await handle.fetchHistory()).events?.find((e) => e.activityTaskScheduledEventAttributes)?.activityTaskScheduledEventAttributes;
      expect(scheduled?.activityType?.name).toBe(activityName);
      expect(Number(scheduled?.startToCloseTimeout?.seconds)).toBe(timeout);
      expect(scheduled?.retryPolicy?.maximumAttempts).toBe(attempts);
    });
  });

  it.each([false, true])("retries Codex activity up to five attempts (exhausted=%s)", async (exhausted) => {
    let attempts = 0;
    const runCodexAppServerTurn = vi.fn(async () => { if (++attempts < 5 || exhausted) throw transient(); return turnResult; });
    await withTemporal({ activities: { runCodexAppServerTurn } }, async ({ client, taskQueue }) => {
      const result = client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue, workflowId: id("native-retry"), args: [turn] });
      if (exhausted) await expect(result).rejects.toThrow(); else expect(await result).toEqual(turnResult);
      expect(attempts).toBe(5);
    });
  });

  it.each([["opencode", "runOpenCodeAgentTurn"], ["cli:claude", "runCliAgentTurn"]])("does not retry failed %s turns", async (providerId, name) => {
    const activity = vi.fn(async () => { throw transient(); });
    await withTemporal({ activities: { [name!]: activity } }, async ({ client, taskQueue }) => {
      await expect(client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue, workflowId: id("single-attempt"), args: [{ ...turn, providerId }] })).rejects.toThrow();
      expect(activity).toHaveBeenCalledTimes(1);
    });
  });
});

describe("Temporal: background action workflow", () => {
  it("returns successful actions without failure reporting", async () => {
    const runRoomAgentBackgroundAction = vi.fn(async () => ({ status: "COMPLETED" }));
    const failRoomAgentBackgroundAction = vi.fn();
    await withTemporal({ activities: { runRoomAgentBackgroundAction, failRoomAgentBackgroundAction } }, async ({ client, taskQueue }) => {
      expect(await client.workflow.execute("roomAgentActionWorkflow", { taskQueue, workflowId: id("action-success"), args: [actionInput] })).toEqual({ status: "COMPLETED" });
      expect(runRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith(actionInput);
      expect(failRoomAgentBackgroundAction).not.toHaveBeenCalled();
    });
  });

  it.each([true, false])("reports exhausted failures with explicit action ID=%s", async (explicit) => {
    const runRoomAgentBackgroundAction = vi.fn(async () => { throw transient(); });
    const failRoomAgentBackgroundAction = vi.fn(async () => undefined);
    const workflowId = `space-room-action:${id("fallback")}`;
    const { actionId: _actionId, ...withoutId } = actionInput;
    await withTemporal({ activities: { runRoomAgentBackgroundAction, failRoomAgentBackgroundAction } }, async ({ client, taskQueue }) => {
      await expect(client.workflow.execute("roomAgentActionWorkflow", { taskQueue, workflowId, args: [explicit ? actionInput : withoutId] })).rejects.toThrow();
      expect(runRoomAgentBackgroundAction).toHaveBeenCalledTimes(5);
      expect(failRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith({
        roomId: turn.roomId, missionId: actionInput.bridge.missionId,
        actionId: explicit ? actionInput.actionId : workflowId.replace(/^space-room-action:/, ""), cancelled: false
      });
    });
  });

  it("reports cancellation inside a non-cancellable scope", async () => {
    let started = false;
    const runRoomAgentBackgroundAction = vi.fn(async () => {
      const context = Context.current();
      const heartbeat = setInterval(() => context.heartbeat(), 10);
      started = true;
      try { await context.cancelled; } finally { clearInterval(heartbeat); }
    });
    const failRoomAgentBackgroundAction = vi.fn(async () => undefined);
    await withTemporal({ activities: { runRoomAgentBackgroundAction, failRoomAgentBackgroundAction } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("roomAgentActionWorkflow", { taskQueue, workflowId: id("action-cancel"), args: [actionInput] });
      await waitFor(() => started);
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(failRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith({
        roomId: turn.roomId, missionId: actionInput.bridge.missionId, actionId: actionInput.actionId, cancelled: true
      });
    });
  });
});

describe("Temporal: memory workflows", () => {
  it("continues after exhausted optional refresh/reconciliation failures and runs the real consolidation child", async () => {
    const refreshMemoryGraphSnapshot = vi.fn(async () => snapshot);
    const refreshAllMonthsMemoryGraphSnapshot = vi.fn(async () => { throw transient(); });
    const reconcileStaleSpaceAgentSessions = vi.fn(async () => { throw transient(); });
    const workflowId = id("audit-child");
    const createScheduledMemoryAudit = vi.fn(async () => ({ id: consolidationInput.runId, workflowId }));
    const prepareMemoryConsolidation = vi.fn(async () => ({ run: repairedRun, changeSetId: mutationInput.changeSetId }));
    const executePersistedMemoryChangeSet = vi.fn(async () => mutationResult);
    const finalizeMemoryRepair = vi.fn(async () => repairedRun);
    await withTemporal({ activities: { refreshMemoryGraphSnapshot, refreshAllMonthsMemoryGraphSnapshot, reconcileStaleSpaceAgentSessions, createScheduledMemoryAudit, prepareMemoryConsolidation, executePersistedMemoryChangeSet, finalizeMemoryRepair } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("memoryMaintenanceWorkflow", { taskQueue, workflowId: id("maintenance"), args: [memoryInput] });
      expect(await handle.result()).toEqual(snapshot);
      expect(refreshMemoryGraphSnapshot).toHaveBeenCalledExactlyOnceWith(memoryInput);
      expect(refreshAllMonthsMemoryGraphSnapshot).toHaveBeenCalledTimes(3);
      expect(reconcileStaleSpaceAgentSessions).toHaveBeenCalledTimes(3);
      expect(createScheduledMemoryAudit).toHaveBeenCalledExactlyOnceWith({ ...memoryInput, sourceHash: snapshot.sourceHash });
      expect(prepareMemoryConsolidation).toHaveBeenCalledExactlyOnceWith(consolidationInput);
      expect(executePersistedMemoryChangeSet).toHaveBeenCalledExactlyOnceWith(mutationInput);
      expect(finalizeMemoryRepair).toHaveBeenCalledExactlyOnceWith({ runId: consolidationInput.runId, changeSetId: mutationInput.changeSetId, mutationResult });
      const history = await handle.fetchHistory();
      const child = history.events?.find((e) => e.startChildWorkflowExecutionInitiatedEventAttributes)?.startChildWorkflowExecutionInitiatedEventAttributes;
      expect(child?.workflowType?.name).toBe("memoryConsolidationWorkflow");
      expect(child?.workflowId).toBe(workflowId);
      expect(child?.taskQueue?.name).toBe("space-memory-maintenance");
      expect(history.events?.some((e) => e.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
    });
  });

  it("stops maintenance after exhausted required snapshot failures", async () => {
    const refreshMemoryGraphSnapshot = vi.fn(async () => { throw transient(); });
    const createScheduledMemoryAudit = vi.fn();
    await withTemporal({ activities: { refreshMemoryGraphSnapshot, createScheduledMemoryAudit } }, async ({ client, taskQueue }) => {
      await expect(client.workflow.execute("memoryMaintenanceWorkflow", { taskQueue, workflowId: id("maintenance-failed"), args: [memoryInput] })).rejects.toThrow();
      expect(refreshMemoryGraphSnapshot).toHaveBeenCalledTimes(3);
      expect(createScheduledMemoryAudit).not.toHaveBeenCalled();
    });
  });

  it("returns an unchanged consolidation run without mutation or finalization", async () => {
    const prepareMemoryConsolidation = vi.fn(async () => ({ changeSetId: null, run: repairedRun }));
    const executePersistedMemoryChangeSet = vi.fn();
    const finalizeMemoryRepair = vi.fn();
    await withTemporal({ activities: { prepareMemoryConsolidation, executePersistedMemoryChangeSet, finalizeMemoryRepair } }, async ({ client, taskQueue }) => {
      expect(await client.workflow.execute("memoryConsolidationWorkflow", { taskQueue, workflowId: id("consolidation-noop"), args: [consolidationInput] })).toEqual(repairedRun);
      expect(prepareMemoryConsolidation).toHaveBeenCalledExactlyOnceWith(consolidationInput);
      expect(executePersistedMemoryChangeSet).not.toHaveBeenCalled();
      expect(finalizeMemoryRepair).not.toHaveBeenCalled();
    });
  });

  it("retries consolidation preparation, mutation and finalization before returning the repaired run", async () => {
    let preparations = 0; let mutations = 0; let finalizations = 0;
    const prepareMemoryConsolidation = vi.fn(async () => { if (++preparations < 3) throw transient(); return { changeSetId: mutationInput.changeSetId, run: repairedRun }; });
    const executePersistedMemoryChangeSet = vi.fn(async () => { if (++mutations < 3) throw transient(); return mutationResult; });
    const finalizeMemoryRepair = vi.fn(async () => { if (++finalizations < 3) throw transient(); return repairedRun; });
    await withTemporal({ activities: { prepareMemoryConsolidation, executePersistedMemoryChangeSet, finalizeMemoryRepair } }, async ({ client, taskQueue }) => {
      expect(await client.workflow.execute("memoryConsolidationWorkflow", { taskQueue, workflowId: id("consolidation-retry"), args: [consolidationInput] })).toEqual(repairedRun);
      expect([preparations, mutations, finalizations]).toEqual([3, 3, 3]);
      expect(prepareMemoryConsolidation).toHaveBeenLastCalledWith(consolidationInput);
      expect(executePersistedMemoryChangeSet).toHaveBeenLastCalledWith(mutationInput);
      expect(finalizeMemoryRepair).toHaveBeenLastCalledWith({ runId: consolidationInput.runId, changeSetId: mutationInput.changeSetId, mutationResult });
    });
  });

  it.each(["prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"])("propagates exhausted consolidation %s failures", async (failedName) => {
    const prepareMemoryConsolidation = vi.fn(async () => { if (failedName === "prepareMemoryConsolidation") throw transient(); return { changeSetId: mutationInput.changeSetId, run: repairedRun }; });
    const executePersistedMemoryChangeSet = vi.fn(async () => { if (failedName === "executePersistedMemoryChangeSet") throw transient(); return mutationResult; });
    const finalizeMemoryRepair = vi.fn(async () => { throw transient(); });
    await withTemporal({ activities: { prepareMemoryConsolidation, executePersistedMemoryChangeSet, finalizeMemoryRepair } }, async ({ client, taskQueue }) => {
      await expect(client.workflow.execute("memoryConsolidationWorkflow", { taskQueue, workflowId: id("consolidation-fail"), args: [consolidationInput] })).rejects.toThrow();
      expect(prepareMemoryConsolidation).toHaveBeenCalledTimes(failedName === "prepareMemoryConsolidation" ? 3 : 1);
      expect(executePersistedMemoryChangeSet).toHaveBeenCalledTimes(failedName === "prepareMemoryConsolidation" ? 0 : failedName === "executePersistedMemoryChangeSet" ? 3 : 1);
      expect(finalizeMemoryRepair).toHaveBeenCalledTimes(failedName === "finalizeMemoryRepair" ? 3 : 0);
    });
  });

  it.each([false, true])("retries mutation activity with exact input (exhausted=%s)", async (exhausted) => {
    let attempts = 0;
    const executePersistedMemoryChangeSet = vi.fn(async () => { if (++attempts < 3 || exhausted) throw transient(); return mutationResult; });
    await withTemporal({ activities: { executePersistedMemoryChangeSet } }, async ({ client, taskQueue }) => {
      const result = client.workflow.execute("memoryMutationWorkflow", { taskQueue, workflowId: id("mutation"), args: [mutationInput] });
      if (exhausted) await expect(result).rejects.toThrow(); else expect(await result).toEqual(mutationResult);
      expect(executePersistedMemoryChangeSet).toHaveBeenCalledTimes(3);
      expect(executePersistedMemoryChangeSet).toHaveBeenLastCalledWith(mutationInput);
    });
  });
});
