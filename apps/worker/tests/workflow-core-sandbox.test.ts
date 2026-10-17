import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import type { WorkflowHandle } from "@temporalio/client";
import {
  DOT_GOAL_SIGNAL,
  dummyTurnInputSchema,
  type MemoryConsolidationRun,
  type MemoryMaintenanceResult,
  type MemoryMutationWorkflowResult
} from "@space/contracts";
import { describe, expect, it, vi } from "vitest";
import { createSandbox } from "./support/workflow-sandbox.js";

const timeout = 180_000;
type Sandbox = Awaited<ReturnType<typeof createSandbox>>;
type SandboxOptions = Parameters<typeof createSandbox>[0];

/** Creates an externally released promise for pausing an activity at a known test boundary. */
function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Runs a scenario with real workers and always disposes its isolated Temporal server. */
async function inSandbox<T>(options: SandboxOptions, test: (sandbox: Sandbox) => Promise<T>): Promise<T> {
  const sandbox = await createSandbox(options);
  try {
    return await sandbox.runUntil(() => test(sandbox));
  } finally {
    await sandbox.close();
  }
}

/** Starts a single-input workflow on the sandbox queue, with a unique ID unless explicitly supplied. */
function start(sandbox: Sandbox, workflow: string, input: unknown, workflowId = `sandbox-core-${randomUUID()}`) {
  return sandbox.env.client.workflow.start(workflow, { taskQueue: sandbox.queue, workflowId, args: [input] });
}

/** Waits for workflow completion while retaining its handle for assertions against recorded events. */
async function execute(sandbox: Sandbox, workflow: string, input: unknown) {
  const handle = await start(sandbox, workflow, input);
  return { handle, result: await handle.result() };
}

/** Reads server-recorded activity commands in order, rather than inferring them from stub calls. */
async function scheduled(handle: WorkflowHandle) {
  return (await handle.fetchHistory()).events!.flatMap((event) =>
    event.activityTaskScheduledEventAttributes ? [event.activityTaskScheduledEventAttributes] : []);
}

/** Waits up to 15 real seconds for a durable timer without unlocking automatic time skipping. */
async function waitForTimer(handle: WorkflowHandle) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const history = await handle.fetchHistory();
    const timer = history.events!.find((event) => event.timerStartedEventAttributes);
    if (timer) return timer.timerStartedEventAttributes!;
    if (Date.now() >= deadline) throw new Error("The workflow did not schedule its durable timer.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const turn = dummyTurnInputSchema.parse({
  roomId: "room:sandbox", paneId: "pane:sandbox", prompt: "A bounded test turn", traceId: "trace:sandbox"
});
const turnResult = {
  workflowId: "workflow:sandbox", roomId: turn.roomId, paneId: turn.paneId,
  traceId: turn.traceId, status: "COMPLETED", message: "Finished in the sandbox."
};
const memoryInput = { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:maintenance-sandbox" };
const snapshot: MemoryMaintenanceResult = {
  status: "REFRESHED", generatedAt: memoryInput.scheduledAt, sourceHash: "a".repeat(64), previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 2, nodeCount: 2, edgeCount: 1, issueCount: 0 }, durationMs: 7
};
const mutationInput = { changeSetId: "change_set:sandbox", traceId: "trace:mutation-sandbox" };
const mutationResult: MemoryMutationWorkflowResult = {
  status: "APPLIED", changeSetId: mutationInput.changeSetId, resultingSourceHash: "b".repeat(64), reason: null
};
/** Builds a synthetic consolidation result with a unique child workflow ID to avoid run collisions. */
function consolidationRun(status: MemoryConsolidationRun["status"] = "SUCCEEDED"): MemoryConsolidationRun {
  return {
    id: "memory_run:sandbox", mode: "REPAIR", triggerKind: "SCHEDULED", status,
    workflowId: `memory-child-${randomUUID()}`, dedupeKey: "scheduled:sandbox", sourceHash: snapshot.sourceHash,
    actorUserId: null, progressCompleted: 1, progressTotal: 1, findingCount: 1,
    appliedOperationCount: 1, skippedOperationCount: 0, failedOperationCount: 0,
    metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
    createdAt: memoryInput.scheduledAt, startedAt: memoryInput.scheduledAt,
    completedAt: memoryInput.scheduledAt, updatedAt: memoryInput.scheduledAt
  };
}

describe("production workflows in the Temporal time-skipping sandbox", () => {
  it("executes dummy activities in order and retries transient starts on the server", async () => {
    const attempts: number[] = [];
    const calls: string[] = [];
    const recordDummyTurnStarted = vi.fn(async (input: unknown) => {
      attempts.push(Context.current().info.attempt);
      expect(input).toEqual(turn);
      if (attempts.length < 3) throw new Error("Temporary store outage");
      calls.push("started");
      return { workflowId: turnResult.workflowId };
    });
    const recordDummyTurnCompleted = vi.fn(async (input: unknown) => {
      expect(input).toEqual(turn);
      calls.push("completed");
      return turnResult;
    });
    await inSandbox({ activities: { recordDummyTurnStarted, recordDummyTurnCompleted } }, async (sandbox) => {
      const { handle, result } = await execute(sandbox, "dummyTurnWorkflow", turn);
      expect(result).toEqual(turnResult);
      expect(calls).toEqual(["started", "completed"]);
      expect(attempts).toEqual([1, 2, 3]);
      const activities = await scheduled(handle);
      expect(activities.map((event) => event.activityType?.name)).toEqual(["recordDummyTurnStarted", "recordDummyTurnCompleted"]);
      expect(activities[0]!.retryPolicy?.maximumAttempts).toBe(3);
    });
  }, timeout);

  it("fails the dummy workflow after exactly three attempts without completing the turn", async () => {
    const recordDummyTurnStarted = vi.fn(async () => { throw new Error("Store stays unavailable"); });
    const recordDummyTurnCompleted = vi.fn(async () => turnResult);
    await inSandbox({ activities: { recordDummyTurnStarted, recordDummyTurnCompleted } }, async (sandbox) => {
      const handle = await start(sandbox, "dummyTurnWorkflow", turn);
      await expect(handle.result()).rejects.toThrow();
      expect(recordDummyTurnStarted).toHaveBeenCalledTimes(3);
      expect(recordDummyTurnCompleted).not.toHaveBeenCalled();
      expect((await handle.fetchHistory()).events!.some((event) => event.workflowExecutionFailedEventAttributes)).toBe(true);
    });
  }, timeout);

  it.each([
    ["OpenCode", { providerId: "opencode" }, "runOpenCodeAgentTurn", 2_400, 1],
    ["CLI chat", { providerId: "cli:claude" }, "runCliAgentTurn", 1_800, 1],
    // The test server caps the requested 100-year activity duration at ten years in stored history.
    ["native chat", { agentSessionId: "session:sandbox", agentAssistantMessageId: "message:sandbox" }, "runCodexAppServerTurn", 315_360_000, 5],
    ["room agent", { agentSessionId: "session:sandbox", agentAssistantMessageId: "message:sandbox", roomAgentMissionId: "mission:sandbox" }, "runCodexAppServerTurn", 86_400, 5]
  ] as const)("dispatches %s using the production activity name, timeout and retry policy", async (_label, patch, selected, seconds, attempts) => {
    const input = { ...turn, ...patch };
    const activities = {
      runOpenCodeAgentTurn: vi.fn(async () => turnResult),
      runCliAgentTurn: vi.fn(async () => turnResult),
      runCodexAppServerTurn: vi.fn(async () => turnResult)
    };
    await inSandbox({ activities }, async (sandbox) => {
      const { handle, result } = await execute(sandbox, "codexAppServerTurnWorkflow", input);
      expect(result).toEqual(turnResult);
      for (const [name, activity] of Object.entries(activities)) expect(activity).toHaveBeenCalledTimes(name === selected ? 1 : 0);
      expect(activities[selected]).toHaveBeenCalledWith(input);
      const [activity] = await scheduled(handle);
      expect(activity!.activityType?.name).toBe(selected);
      expect(Number(activity!.startToCloseTimeout?.seconds)).toBe(seconds);
      expect(Number(activity!.heartbeatTimeout?.seconds)).toBe(15);
      expect(activity!.retryPolicy?.maximumAttempts).toBe(attempts);
    });
  }, timeout);

  it.each(["opencode", "cli:claude"])("does not retry a failed %s provider turn", async (providerId) => {
    const activity = vi.fn(async () => { throw new Error("Provider execution failed"); });
    await inSandbox({ activities: { runOpenCodeAgentTurn: activity, runCliAgentTurn: activity } }, async (sandbox) => {
      const handle = await start(sandbox, "codexAppServerTurnWorkflow", { ...turn, providerId });
      await expect(handle.result()).rejects.toThrow();
      expect(activity).toHaveBeenCalledTimes(1);
    });
  }, timeout);

  it("uses real durable timers for paused, waiting and active Dot goal polling", async () => {
    const steps = [
      { state: "PAUSED", runId: null, goalStatus: "PAUSED" },
      { state: "WAITING", runId: null, goalStatus: "ACTIVE" },
      { state: "STARTED", runId: "run:dot-sandbox", goalStatus: "ACTIVE" },
      { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    ];
    const runs = ["QUEUED", "RUNNING", "COMPLETED"];
    const dotGoalStep = vi.fn(async () => steps.shift()!);
    const dotGoalObserve = vi.fn(async () => ({ run: runs.shift()!, goalStatus: "ACTIVE" }));
    await inSandbox({ activities: { dotGoalStep, dotGoalObserve } }, async (sandbox) => {
      const { handle, result } = await execute(sandbox, "dotGoalWorkflow", { goalId: "goal:sandbox" });
      expect(result).toEqual({ goalStatus: "COMPLETED" });
      expect(dotGoalStep).toHaveBeenCalledTimes(4);
      expect(dotGoalObserve).toHaveBeenCalledTimes(3);
      expect(dotGoalObserve).toHaveBeenCalledWith("goal:sandbox", "run:dot-sandbox");
      const events = (await handle.fetchHistory()).events!;
      expect(events.flatMap((event) => event.timerStartedEventAttributes ? [Number(event.timerStartedEventAttributes.startToFireTimeout?.seconds)] : []))
        .toEqual([3_600, 30, 15, 15, 15]);
      expect(events.filter((event) => event.timerFiredEventAttributes)).toHaveLength(5);
    });
  }, timeout);

  it("retains a Dot wake signal received while its activity is still running", async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const dotGoalStep = async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
        return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
      }
      return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    };
    await inSandbox({ activities: { dotGoalStep } }, async (sandbox) => {
      const handle = await start(sandbox, "dotGoalWorkflow", { goalId: "goal:buffered-wake" });
      await entered.promise;
      await handle.signal(DOT_GOAL_SIGNAL);
      release.resolve();
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(calls).toBe(2);
      expect((await handle.fetchHistory()).events!.filter((event) => event.timerStartedEventAttributes)).toHaveLength(0);
    });
  }, timeout);

  it("wakes a paused Dot before its hour-long timer fires", async () => {
    let calls = 0;
    await inSandbox({ activities: { dotGoalStep: async () => ++calls === 1
      ? { state: "PAUSED", runId: null, goalStatus: "PAUSED" }
      : { state: "DONE", runId: null, goalStatus: "CANCELLED" } } }, async (sandbox) => {
      const handle = await start(sandbox, "dotGoalWorkflow", { goalId: "goal:timer-wake" });
      const timer = await waitForTimer(handle);
      expect(Number(timer.startToFireTimeout?.seconds)).toBe(3_600);
      await handle.signal(DOT_GOAL_SIGNAL);
      expect(await handle.result()).toEqual({ goalStatus: "CANCELLED" });
      const events = (await handle.fetchHistory()).events!;
      expect(events.some((event) => event.timerCanceledEventAttributes?.timerId === timer.timerId)).toBe(true);
      expect(events.some((event) => event.timerFiredEventAttributes?.timerId === timer.timerId)).toBe(false);
    });
  }, timeout);

  it("retries transient Dot API failures using its five-second exponential backoff", async () => {
    const attempts: number[] = [];
    const dotGoalStep = async () => {
      attempts.push(Context.current().info.attempt);
      if (attempts.length < 3) throw new Error("Temporary internal API failure");
      return { state: "DONE", runId: null, goalStatus: "MISSING" };
    };
    await inSandbox({ activities: { dotGoalStep } }, async (sandbox) => {
      const before = await sandbox.env.currentTimeMs();
      const { handle, result } = await execute(sandbox, "dotGoalWorkflow", { goalId: "goal:retry" });
      expect(result).toEqual({ goalStatus: "MISSING" });
      expect(attempts).toEqual([1, 2, 3]);
      expect(await sandbox.env.currentTimeMs() - before).toBeGreaterThanOrEqual(15_000);
      const [activity] = await scheduled(handle);
      expect(activity!.retryPolicy?.maximumAttempts).toBe(20);
      expect(Number(activity!.retryPolicy?.initialInterval?.seconds)).toBe(5);
    });
  }, timeout);

  it("continues a Dot as a fresh run after 300 iterations and carries its goal id", async () => {
    let calls = 0;
    const dotGoalStep = vi.fn(async (goalId: string) => {
      expect(goalId).toBe("goal:continue");
      return ++calls <= 300
        ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    });
    await inSandbox({ activities: { dotGoalStep } }, async (sandbox) => {
      const handle = await start(sandbox, "dotGoalWorkflow", { goalId: "goal:continue" });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const first = sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const firstEvents = (await first.fetchHistory()).events!;
      const continuation = firstEvents.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)!.workflowExecutionContinuedAsNewEventAttributes!;
      expect(firstEvents.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(300);
      expect(firstEvents.filter((event) => event.timerFiredEventAttributes)).toHaveLength(300);
      expect(JSON.parse(Buffer.from(continuation.input!.payloads![0]!.data!).toString("utf8"))).toEqual({ goalId: "goal:continue" });
      const next = sandbox.env.client.workflow.getHandle(handle.workflowId, continuation.newExecutionRunId!);
      expect((await next.fetchHistory()).events!.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(1);
      expect(dotGoalStep).toHaveBeenCalledTimes(301);
    });
  }, timeout);

  it("returns a successful background action without compensation", async () => {
    const result = { status: "EXECUTED", actionId: "action:sandbox" };
    const runRoomAgentBackgroundAction = vi.fn(async () => result);
    const failRoomAgentBackgroundAction = vi.fn();
    await inSandbox({ activities: { runRoomAgentBackgroundAction, failRoomAgentBackgroundAction } }, async (sandbox) => {
      const input = { actionId: "action:sandbox", bridge: { roomId: "room:sandbox", missionId: "mission:sandbox" }, traceId: "trace:action" };
      expect((await execute(sandbox, "roomAgentActionWorkflow", input)).result).toEqual(result);
      expect(runRoomAgentBackgroundAction).toHaveBeenCalledWith(input);
      expect(failRoomAgentBackgroundAction).not.toHaveBeenCalled();
    });
  }, timeout);

  it("exhausts five action attempts, compensates once, then preserves workflow failure", async () => {
    const attempts: number[] = [];
    const runRoomAgentBackgroundAction = async () => {
      attempts.push(Context.current().info.attempt);
      throw new Error("Background action failed");
    };
    const failRoomAgentBackgroundAction = vi.fn(async () => undefined);
    await inSandbox({ activities: { runRoomAgentBackgroundAction, failRoomAgentBackgroundAction } }, async (sandbox) => {
      const input = { bridge: { roomId: "room:sandbox", missionId: "mission:sandbox" }, traceId: "trace:action" };
      const handle = await start(sandbox, "roomAgentActionWorkflow", input, "space-room-action:derived-sandbox-id");
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      expect(failRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith({
        roomId: "room:sandbox", missionId: "mission:sandbox", actionId: "derived-sandbox-id", cancelled: false
      });
      expect((await scheduled(handle)).map((event) => event.activityType?.name)).toEqual(["runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction"]);
    });
  }, timeout);

  it("completes non-cancellable compensation after a real workflow cancellation", async () => {
    const entered = deferred();
    const runRoomAgentBackgroundAction = async () => {
      const context = Context.current();
      context.heartbeat();
      entered.resolve();
      const heartbeats = setInterval(() => context.heartbeat(), 10);
      try { await context.cancelled; } finally { clearInterval(heartbeats); }
    };
    const failRoomAgentBackgroundAction = vi.fn(async () => undefined);
    await inSandbox({ activities: { runRoomAgentBackgroundAction, failRoomAgentBackgroundAction } }, async (sandbox) => {
      const input = { actionId: "action:cancelled", bridge: { roomId: "room:sandbox", missionId: "mission:sandbox" }, traceId: "trace:action" };
      const handle = await start(sandbox, "roomAgentActionWorkflow", input);
      await entered.promise;
      await handle.cancel();
      await expect(handle.result()).rejects.toThrow();
      expect(failRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith({
        roomId: "room:sandbox", missionId: "mission:sandbox", actionId: "action:cancelled", cancelled: true
      });
      const events = (await handle.fetchHistory()).events!;
      expect(events.some((event) => event.workflowExecutionCancelRequestedEventAttributes)).toBe(true);
      expect(events.some((event) => event.workflowExecutionCanceledEventAttributes)).toBe(true);
      expect(events.filter((event) => event.activityTaskCompletedEventAttributes)).toHaveLength(1);
    });
  }, timeout);

  it("continues maintenance after optional activity retries fail and runs the consolidation child", async () => {
    const run = consolidationRun();
    const calls: string[] = [];
    const refreshAllMonthsMemoryGraphSnapshot = vi.fn(async () => { throw new Error("Archive snapshot unavailable"); });
    const reconcileStaleSpaceAgentSessions = vi.fn(async () => { throw new Error("Session reconciliation unavailable"); });
    const createScheduledMemoryAudit = vi.fn(async () => { calls.push("audit"); return run; });
    const prepareMemoryConsolidation = vi.fn(async () => { calls.push("consolidation"); return { run, changeSetId: null }; });
    await inSandbox({ memoryQueues: true, activities: {
      refreshMemoryGraphSnapshot: async () => { calls.push("snapshot"); return snapshot; },
      refreshAllMonthsMemoryGraphSnapshot, reconcileStaleSpaceAgentSessions, createScheduledMemoryAudit, prepareMemoryConsolidation
    } }, async (sandbox) => {
      const { handle, result } = await execute(sandbox, "memoryMaintenanceWorkflow", memoryInput);
      expect(result).toEqual(snapshot);
      expect(calls).toEqual(["snapshot", "audit", "consolidation"]);
      expect(refreshAllMonthsMemoryGraphSnapshot).toHaveBeenCalledTimes(3);
      expect(reconcileStaleSpaceAgentSessions).toHaveBeenCalledTimes(3);
      expect(createScheduledMemoryAudit).toHaveBeenCalledWith({ ...memoryInput, sourceHash: snapshot.sourceHash });
      expect(prepareMemoryConsolidation).toHaveBeenCalledWith({ runId: run.id, traceId: memoryInput.traceId });
      const events = (await handle.fetchHistory()).events!;
      const child = events.find((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)!.startChildWorkflowExecutionInitiatedEventAttributes!;
      expect(child.workflowType?.name).toBe("memoryConsolidationWorkflow");
      expect(child.workflowId).toBe(run.workflowId);
      expect(child.taskQueue?.name).toBe("space-memory-maintenance");
      expect(events.some((event) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
    });
  }, timeout);

  it("propagates a consolidation child failure to maintenance instead of returning a snapshot", async () => {
    const run = consolidationRun();
    const prepareMemoryConsolidation = vi.fn(async () => { throw ApplicationFailure.nonRetryable("Audit cannot be prepared", "InvalidAudit"); });
    await inSandbox({ memoryQueues: true, activities: {
      refreshMemoryGraphSnapshot: async () => snapshot,
      refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
      reconcileStaleSpaceAgentSessions: async () => undefined,
      createScheduledMemoryAudit: async () => run,
      prepareMemoryConsolidation
    } }, async (sandbox) => {
      const handle = await start(sandbox, "memoryMaintenanceWorkflow", memoryInput);
      await expect(handle.result()).rejects.toThrow();
      expect(prepareMemoryConsolidation).toHaveBeenCalledTimes(1);
      expect((await handle.fetchHistory()).events!.some((event) => event.childWorkflowExecutionFailedEventAttributes)).toBe(true);
    });
  }, timeout);

  it("does not create an audit when the required live snapshot fails after three attempts", async () => {
    const refreshMemoryGraphSnapshot = vi.fn(async () => { throw new Error("Live snapshot unavailable"); });
    const createScheduledMemoryAudit = vi.fn();
    await inSandbox({ memoryQueues: true, activities: { refreshMemoryGraphSnapshot, createScheduledMemoryAudit } }, async (sandbox) => {
      const handle = await start(sandbox, "memoryMaintenanceWorkflow", memoryInput);
      await expect(handle.result()).rejects.toThrow();
      expect(refreshMemoryGraphSnapshot).toHaveBeenCalledTimes(3);
      expect(createScheduledMemoryAudit).not.toHaveBeenCalled();
      expect((await handle.fetchHistory()).events!.some((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
    });
  }, timeout);

  it("returns a consolidation without a change set and never mutates or finalizes", async () => {
    const run = consolidationRun();
    const executePersistedMemoryChangeSet = vi.fn();
    const finalizeMemoryRepair = vi.fn();
    await inSandbox({ memoryQueues: true, activities: {
      prepareMemoryConsolidation: async () => ({ run, changeSetId: null }), executePersistedMemoryChangeSet, finalizeMemoryRepair
    } }, async (sandbox) => {
      expect((await execute(sandbox, "memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:consolidation" })).result).toEqual(run);
      expect(executePersistedMemoryChangeSet).not.toHaveBeenCalled();
      expect(finalizeMemoryRepair).not.toHaveBeenCalled();
    });
  }, timeout);

  it("sends a consolidation change set to the mutation queue and finalizes its actual result", async () => {
    const run = consolidationRun();
    const calls: string[] = [];
    const executePersistedMemoryChangeSet = vi.fn(async () => { calls.push("mutate"); return mutationResult; });
    const finalizeMemoryRepair = vi.fn(async () => { calls.push("finalize"); return run; });
    await inSandbox({ memoryQueues: true, activities: {
      prepareMemoryConsolidation: async () => { calls.push("prepare"); return { run, changeSetId: mutationInput.changeSetId }; },
      executePersistedMemoryChangeSet, finalizeMemoryRepair
    } }, async (sandbox) => {
      const input = { runId: run.id, traceId: "trace:consolidation" };
      const { handle, result } = await execute(sandbox, "memoryConsolidationWorkflow", input);
      expect(result).toEqual(run);
      expect(calls).toEqual(["prepare", "mutate", "finalize"]);
      expect(executePersistedMemoryChangeSet).toHaveBeenCalledExactlyOnceWith({ changeSetId: mutationInput.changeSetId, traceId: input.traceId });
      expect(finalizeMemoryRepair).toHaveBeenCalledExactlyOnceWith({ runId: run.id, changeSetId: mutationInput.changeSetId, mutationResult });
      const activity = (await scheduled(handle)).find((event) => event.activityType?.name === "executePersistedMemoryChangeSet")!;
      expect(activity.taskQueue?.name).toBe("space-memory-mutations");
      expect(Number(activity.startToCloseTimeout?.seconds)).toBe(900);
    });
  }, timeout);

  it("does not finalize a consolidation if mutation exhausts its retries", async () => {
    const run = consolidationRun();
    const executePersistedMemoryChangeSet = vi.fn(async () => { throw new Error("Mutation journal unavailable"); });
    const finalizeMemoryRepair = vi.fn();
    await inSandbox({ memoryQueues: true, activities: {
      prepareMemoryConsolidation: async () => ({ run, changeSetId: mutationInput.changeSetId }),
      executePersistedMemoryChangeSet, finalizeMemoryRepair
    } }, async (sandbox) => {
      const handle = await start(sandbox, "memoryConsolidationWorkflow", { runId: run.id, traceId: "trace:consolidation" });
      await expect(handle.result()).rejects.toThrow();
      expect(executePersistedMemoryChangeSet).toHaveBeenCalledTimes(3);
      expect(finalizeMemoryRepair).not.toHaveBeenCalled();
    });
  }, timeout);

  it("retries a mutation twice and returns its applied result without changing the input", async () => {
    const attempts: number[] = [];
    const executePersistedMemoryChangeSet = vi.fn(async (input: unknown) => {
      expect(input).toEqual(mutationInput);
      attempts.push(Context.current().info.attempt);
      if (attempts.length < 3) throw new Error("Mutation temporarily locked");
      return mutationResult;
    });
    await inSandbox({ activities: { executePersistedMemoryChangeSet } }, async (sandbox) => {
      const { handle, result } = await execute(sandbox, "memoryMutationWorkflow", mutationInput);
      expect(result).toEqual(mutationResult);
      expect(attempts).toEqual([1, 2, 3]);
      const [activity] = await scheduled(handle);
      expect(activity!.retryPolicy?.maximumAttempts).toBe(3);
      expect(Number(activity!.startToCloseTimeout?.seconds)).toBe(900);
    });
  }, timeout);

  it("fails mutation after the configured three attempts", async () => {
    const executePersistedMemoryChangeSet = vi.fn(async () => { throw new Error("Mutation cannot be persisted"); });
    await inSandbox({ activities: { executePersistedMemoryChangeSet } }, async (sandbox) => {
      const handle = await start(sandbox, "memoryMutationWorkflow", mutationInput);
      await expect(handle.result()).rejects.toThrow();
      expect(executePersistedMemoryChangeSet).toHaveBeenCalledTimes(3);
    });
  }, timeout);
});
