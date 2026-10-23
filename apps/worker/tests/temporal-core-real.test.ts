import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { DOT_GOAL_SIGNAL, MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";
import { createBountyTestEnv, createBountyWorker, eventually } from "./support/temporal-bounty.js";
import { recordHistory } from "./support/temporal-history.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";

describe("production workflows in the real time-skipping sandbox", () => {
  let env: Awaited<ReturnType<typeof createBountyTestEnv>>;
  beforeAll(async () => { env = await createBountyTestEnv(); }, 60_000);
  afterAll(async () => { await env?.teardown(); });
  const turn = { roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic test", traceId: "trace:synthetic" };
  const startOptions = (taskQueue: string, args: unknown[]) => ({ taskQueue, args, workflowId: `synthetic-${randomUUID()}` });

  it("dot wake interrupts the actual condition timer", async () => {
    let steps = 0;
    const taskQueue = `dot-wake-${randomUUID()}`;
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      dotGoalStep: async () => ++steps === 1 ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" } : { state: "DONE", runId: null, goalStatus: "COMPLETE" },
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", startOptions(taskQueue, [{ goalId: "goal:wake" }]));
      await eventually(() => steps === 1);
      await eventually(async () => Boolean((await handle.fetchHistory()).events?.some((event) => event.timerStartedEventAttributes)));
      await handle.signal(DOT_GOAL_SIGNAL);
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETE" });
      const history = await handle.fetchHistory();
      expect(history.events?.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(true);
      expect(history.events?.some((event) => event.timerCanceledEventAttributes)).toBe(true);
      expect(history.events?.some((event) => event.timerFiredEventAttributes)).toBe(false);
      await recordHistory(handle, "dotGoalWorkflow-wake");
    });
  }, 60_000);

  it("dot timeout fires and an unfinished 300-step run continues as new", async () => {
    let steps = 0;
    const goalIds: string[] = [];
    const taskQueue = `dot-timeout-${randomUUID()}`;
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      dotGoalStep: async (goalId: string) => {
        goalIds.push(goalId);
        return ++steps <= 300 ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" } : { state: "DONE", runId: null, goalStatus: "COMPLETE" };
      },
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", startOptions(taskQueue, [{ goalId: "goal:continue" }]));
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETE" });
      expect(steps).toBe(301);
      expect(goalIds).toHaveLength(301);
      expect(new Set(goalIds)).toEqual(new Set(["goal:continue"]));
      const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await first.fetchHistory();
      expect(history.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(300);
      const continued = history.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes);
      expect(continued?.workflowExecutionContinuedAsNewEventAttributes?.newExecutionRunId).toBeTruthy();
      const continuedPayload = continued?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
      expect(continuedPayload, "The next run must receive the original goalId").toBeDefined();
      if (!continuedPayload) throw new Error("Missing dot continue-as-new input payload");
      expect(defaultPayloadConverter.fromPayload(continuedPayload)).toEqual({ goalId: "goal:continue" });
      await recordHistory(first, "dotGoalWorkflow-timeout-continue");
    });
  }, 90_000);

  it("dummy turn retries its real activity before completing", async () => {
    let attempts = 0;
    const taskQueue = `dummy-${randomUUID()}`;
    const result = { status: "COMPLETED", message: "Synthetic completion" };
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      recordDummyTurnStarted: async () => { if (++attempts < 3) throw new Error("Synthetic transient start failure"); },
      recordDummyTurnCompleted: async () => result,
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("dummyTurnWorkflow", startOptions(taskQueue, [turn]));
      expect(await handle.result()).toEqual(result);
      expect(attempts).toBe(3);
      await recordHistory(handle, "dummyTurnWorkflow-retry");
    });
  }, 60_000);

  it("Codex turn retries its activity before succeeding", async () => {
    let attempts = 0;
    const taskQueue = `codex-${randomUUID()}`;
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      runCodexAppServerTurn: async () => { if (++attempts < 3) throw new Error("Synthetic transient Codex failure"); return { status: "COMPLETED", message: "Synthetic turn" }; },
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", startOptions(taskQueue, [turn]));
      expect(await handle.result()).toEqual({ status: "COMPLETED", message: "Synthetic turn" });
      expect(attempts).toBe(3);
      await recordHistory(handle, "codexAppServerTurnWorkflow-retry");
    });
  }, 60_000);

  it("background action exhausts retries then persists failure using legacy workflow-id fallback", async () => {
    let attempts = 0;
    const persisted: unknown[] = [];
    const taskQueue = `action-${randomUUID()}`;
    const actionId = `synthetic-${randomUUID()}`;
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      runRoomAgentBackgroundAction: async () => { attempts++; throw new Error("Synthetic background failure"); },
      failRoomAgentBackgroundAction: async (input: unknown) => { persisted.push(input); },
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
        ...startOptions(taskQueue, [{ bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:synthetic" }]),
        workflowId: `space-room-action:${actionId}`,
      });
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toBe(5);
      expect(persisted).toEqual([{ roomId: "room:synthetic", missionId: "mission:synthetic", actionId, cancelled: false }]);
      const history = await handle.fetchHistory();
      expect(history.events?.some((event) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(true);
      await recordHistory(handle, "roomAgentActionWorkflow-failure");
    });
  }, 60_000);

  it("maintenance survives both optional failures and executes the real consolidation child across queues", async () => {
    const counts = { months: 0, sessions: 0, prepare: 0, mutation: 0, finalize: 0 };
    const snapshot = { status: "REFRESHED", sourceHash: "synthetic-source" };
    const completedRun = { id: "run:synthetic", status: "COMPLETED" };
    const worker = await createBountyWorker(env, { taskQueue: MEMORY_MAINTENANCE_TASK_QUEUE, activities: {
      refreshMemoryGraphSnapshot: async () => snapshot,
      refreshAllMonthsMemoryGraphSnapshot: async () => { counts.months++; throw new Error("Synthetic optional refresh failure"); },
      reconcileStaleSpaceAgentSessions: async () => { counts.sessions++; throw new Error("Synthetic optional session failure"); },
      createScheduledMemoryAudit: async () => ({ id: "run:synthetic", workflowId: `consolidation-${randomUUID()}` }),
      prepareMemoryConsolidation: async () => { counts.prepare++; return { changeSetId: "change:synthetic", run: { id: "run:synthetic" } }; },
      finalizeMemoryRepair: async () => { counts.finalize++; return completedRun; },
    } });
    const mutationWorker = await createBountyWorker(env, { taskQueue: MEMORY_MUTATION_TASK_QUEUE, activities: {
      executePersistedMemoryChangeSet: async () => { if (++counts.mutation < 3) throw new Error("Synthetic mutation retry"); return { status: "APPLIED" }; },
    } });
    await worker.runUntil(() => mutationWorker.runUntil(async () => {
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", startOptions(MEMORY_MAINTENANCE_TASK_QUEUE, [{ scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:synthetic" }]));
      expect(await handle.result()).toEqual(snapshot);
      expect(counts).toEqual({ months: 3, sessions: 3, prepare: 1, mutation: 3, finalize: 1 });
      const history = await handle.fetchHistory();
      const child = history.events?.find((event) => event.childWorkflowExecutionStartedEventAttributes)?.childWorkflowExecutionStartedEventAttributes;
      expect(child?.workflowType?.name).toBe("memoryConsolidationWorkflow");
      expect(child?.workflowExecution?.workflowId).toBeTruthy();
      await recordHistory(handle, "memoryMaintenanceWorkflow-optional-failures");
      const childHandle = env.client.workflow.getHandle(child!.workflowExecution!.workflowId!, child!.workflowExecution!.runId!);
      expect(await childHandle.result()).toEqual(completedRun);
      await recordHistory(childHandle, "memoryConsolidationWorkflow-child-retry");
    }));
  }, 60_000);

  it("consolidation returns without a mutation when there is no change set", async () => {
    const taskQueue = `consolidation-empty-${randomUUID()}`;
    const run = { id: "run:empty", status: "COMPLETED" };
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      prepareMemoryConsolidation: async () => ({ changeSetId: null, run }),
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("memoryConsolidationWorkflow", startOptions(taskQueue, [{ runId: "run:empty", traceId: "trace:synthetic" }]));
      expect(await handle.result()).toEqual(run);
      const history = await handle.fetchHistory();
      expect(history.events?.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(1);
      await recordHistory(handle, "memoryConsolidationWorkflow-no-change");
    });
  }, 60_000);

  it("memory mutation retries in the sandbox before succeeding", async () => {
    let attempts = 0;
    const taskQueue = `mutation-${randomUUID()}`;
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      executePersistedMemoryChangeSet: async () => { if (++attempts <= 2) throw new Error("Synthetic mutation transient"); return { status: "APPLIED", changeSetId: "change:synthetic" }; },
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("memoryMutationWorkflow", startOptions(taskQueue, [{ changeSetId: "change:synthetic", traceId: "trace:synthetic" }]));
      expect(await handle.result()).toEqual({ status: "APPLIED", changeSetId: "change:synthetic" });
      expect(attempts).toBe(3);
      await recordHistory(handle, "memoryMutationWorkflow-retry");
    });
  }, 60_000);

  it.each([
    ["dummyTurnWorkflow", "recordDummyTurnStarted", 3, turn],
    ["codexAppServerTurnWorkflow", "runCodexAppServerTurn", 5, turn],
    ["memoryMutationWorkflow", "executePersistedMemoryChangeSet", 3, { changeSetId: "change:failure", traceId: "trace:synthetic" }],
    ["memoryConsolidationWorkflow", "prepareMemoryConsolidation", 3, { runId: "run:failure", traceId: "trace:synthetic" }],
  ] as const)("%s propagates exhausted activity failures", async (workflowType, activityName, maximumAttempts, input) => {
    let attempts = 0;
    const taskQueue = `exhaustion-${randomUUID()}`;
    const worker = await createBountyWorker(env, { taskQueue, activities: {
      [activityName]: async () => { attempts++; throw new Error("Synthetic persistent failure"); },
    } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start(workflowType, startOptions(taskQueue, [input]));
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toBe(maximumAttempts);
      const history = await handle.fetchHistory();
      expect(history.events?.some((event) => event.workflowExecutionFailedEventAttributes)).toBe(true);
      await recordHistory(handle, `${workflowType}-exhaustion`);
    });
  }, 60_000);
});
