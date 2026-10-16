import { Context } from "@temporalio/activity";
import type { WorkflowHandle } from "@temporalio/client";
import type {
  DummyTurnInput,
  MemoryConsolidationRun,
  MemoryMaintenanceResult,
  MemoryMutationWorkflowInput,
  MemoryMutationWorkflowResult,
  SpaceAgentRoomActionBridgeRequest,
  TurnWorkflowResult
} from "@space/contracts";
import { expect } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { performance } from "node:perf_hooks";
import type { Scenario } from "./temporal-test-harness.js";

type History = Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>;

function syntheticError(message: string): Error {
  const error = new Error(message);
  // Recorded failures should describe the synthetic fault without embedding
  // the contributor's checkout path or host details in the public baseline.
  error.stack = `Error: ${message}`;
  return error;
}

function workflowExecution() {
  const execution = Context.current().info.workflowExecution;
  if (!execution) throw syntheticError("Expected a workflow activity context");
  return execution;
}

function turnInput(suffix: string, overrides: Partial<DummyTurnInput> = {}): DummyTurnInput {
  return {
    roomId: "room:temporal-basic", paneId: "pane:temporal-basic", prompt: "Execute the isolated test turn.",
    artifactIds: [], permissionMode: null, collaborationMode: "default", traceId: `trace:${suffix}`, ...overrides
  };
}

function turnResult(input: DummyTurnInput): TurnWorkflowResult {
  return {
    workflowId: workflowExecution().workflowId,
    roomId: input.roomId, paneId: input.paneId, traceId: input.traceId,
    status: "COMPLETED", message: "The isolated activity completed."
  };
}

function consolidationRun(id: string): MemoryConsolidationRun {
  return {
    id, mode: "AUDIT", triggerKind: "SCHEDULED", status: "SUCCEEDED", workflowId: `workflow:${id}`,
    dedupeKey: `scheduled:${id}`, sourceHash: "a".repeat(64), actorUserId: null,
    progressCompleted: 0, progressTotal: 0, findingCount: 0, appliedOperationCount: 0,
    skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null,
    aiVerified: false, aiEvidence: {}, statusReason: null,
    createdAt: "2026-07-13T00:00:00.000Z", startedAt: "2026-07-13T00:00:00.000Z",
    completedAt: "2026-07-13T00:00:01.000Z", updatedAt: "2026-07-13T00:00:01.000Z"
  };
}

function mutationResult(input: MemoryMutationWorkflowInput): MemoryMutationWorkflowResult {
  return { status: "APPLIED", changeSetId: input.changeSetId, resultingSourceHash: "b".repeat(64), reason: null };
}

async function expectActivityFailure(handle: WorkflowHandle, message: string): Promise<void> {
  await expect(handle.result()).rejects.toMatchObject({
    name: "WorkflowFailedError", cause: { name: "ActivityFailure", cause: { message } }
  });
}

function scheduledActivities(history: History) {
  return (history.events ?? []).flatMap((event) => event.activityTaskScheduledEventAttributes ? [event.activityTaskScheduledEventAttributes] : []);
}

function timerSeconds(history: History): string[] {
  return (history.events ?? []).flatMap((event) => event.timerStartedEventAttributes
    ? [String(event.timerStartedEventAttributes.startToFireTimeout?.seconds)] : []);
}

async function waitForTimer(handle: WorkflowHandle): Promise<History> {
  // Yield real time for the worker activation while the test server clock stays
  // locked. Counting fast RPCs races the worker on low-latency Linux runners.
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    const history = await handle.fetchHistory();
    if (timerSeconds(history).length) return history;
    await delay(20);
  }
  throw new Error("The goal workflow did not schedule its durable pause timer within ten seconds.");
}

function dummyScenario(): Scenario {
  const calls: Array<{ phase: string; traceId: string; attempt: number }> = [];
  return {
    name: "dummy turns retry both writes and propagate exhausted failures",
    activities: {
      recordDummyTurnStarted: async (input: DummyTurnInput) => {
        const attempt = Context.current().info.attempt;
        calls.push({ phase: "start", traceId: input.traceId, attempt });
        if (input.traceId.endsWith("start-failure") || attempt < 3) throw syntheticError("dummy start unavailable");
      },
      recordDummyTurnCompleted: async (input: DummyTurnInput) => {
        const attempt = Context.current().info.attempt;
        calls.push({ phase: "complete", traceId: input.traceId, attempt });
        if (input.traceId.endsWith("complete-failure") || attempt < 2) throw syntheticError("dummy completion unavailable");
        return turnResult(input);
      }
    },
    async run(ctx) {
      for (const suffix of ["success", "start-failure", "complete-failure"]) {
        const input = turnInput(`dummy-${suffix}`);
        const handle = await ctx.start("dummyTurnWorkflow", [input]);
        if (suffix === "success") await expect(handle.result()).resolves.toMatchObject({ status: "COMPLETED", traceId: input.traceId });
        else await expectActivityFailure(handle, suffix === "start-failure" ? "dummy start unavailable" : "dummy completion unavailable");
        const relevant = calls.filter((call) => call.traceId === input.traceId);
        expect(relevant.filter((call) => call.phase === "start").map((call) => call.attempt)).toEqual([1, 2, 3]);
        expect(relevant.filter((call) => call.phase === "complete").map((call) => call.attempt))
          .toEqual(suffix === "start-failure" ? [] : suffix === "success" ? [1, 2] : [1, 2, 3]);
        await ctx.record(handle, `dummy-${suffix}`);
      }
    }
  };
}

function turnScenario(): Scenario {
  const calls: Array<{ activity: string; traceId: string; attempt: number }> = [];
  const activity = (name: string, retries: boolean) => async (input: DummyTurnInput) => {
    const attempt = Context.current().info.attempt;
    calls.push({ activity: name, traceId: input.traceId, attempt });
    if (input.traceId.endsWith("failure") || (retries && attempt < 3)) throw syntheticError(`${name} unavailable`);
    return turnResult(input);
  };
  return {
    name: "turn routing preserves native room OpenCode and CLI retry policies",
    activities: {
      runCodexAppServerTurn: activity("runCodexAppServerTurn", true),
      runOpenCodeAgentTurn: activity("runOpenCodeAgentTurn", false),
      runCliAgentTurn: activity("runCliAgentTurn", false)
    },
    async run(ctx) {
      const routes = [
        { name: "room", overrides: { providerId: "codex", roomAgentMissionId: "mission:test" }, activity: "runCodexAppServerTurn", attempts: 5, timeout: "86400" },
        { name: "native", overrides: { providerId: "codex", agentSessionId: "session:test", agentAssistantMessageId: "message:test" }, activity: "runCodexAppServerTurn", attempts: 5, timeout: "3153600000" },
        { name: "opencode", overrides: { providerId: "opencode" }, activity: "runOpenCodeAgentTurn", attempts: 1, timeout: "2400" },
        { name: "cli", overrides: { providerId: "cli:claude" }, activity: "runCliAgentTurn", attempts: 1, timeout: "1800" }
      ];
      for (const route of routes) for (const outcome of ["success", "failure"]) {
        const input = turnInput(`${route.name}-${outcome}`, route.overrides);
        const handle = await ctx.start("codexAppServerTurnWorkflow", [input]);
        if (outcome === "success") await expect(handle.result()).resolves.toMatchObject({ status: "COMPLETED", traceId: input.traceId });
        else await expectActivityFailure(handle, `${route.activity} unavailable`);
        const expectedAttempts = outcome === "failure" ? route.attempts : Math.min(route.attempts, 3);
        expect(calls.filter((call) => call.traceId === input.traceId)).toEqual(
          Array.from({ length: expectedAttempts }, (_, index) => ({ activity: route.activity, traceId: input.traceId, attempt: index + 1 }))
        );
        const history = await handle.fetchHistory();
        const scheduled = scheduledActivities(history);
        expect(scheduled).toHaveLength(1);
        expect(scheduled[0]?.activityType?.name).toBe(route.activity);
        expect(scheduled[0]?.retryPolicy?.maximumAttempts).toBe(route.attempts);
        // The test server caps its workflow run timeout (currently ten years),
        // then clamps activity timeouts to it. Native Chat requests 36500 days.
        const started = history.events?.find((event) => event.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes;
        const runTimeoutSeconds = Number(started?.workflowRunTimeout?.seconds);
        expect(runTimeoutSeconds).toBeGreaterThan(0);
        expect(Number(scheduled[0]?.startToCloseTimeout?.seconds)).toBe(Math.min(Number(route.timeout), runTimeoutSeconds));
        await ctx.record(handle, `turn-${route.name}-${outcome}`);
      }
    }
  };
}

function mutationScenario(): Scenario {
  const calls: Array<{ input: MemoryMutationWorkflowInput; attempt: number }> = [];
  return {
    name: "memory mutation retries transient failures and stops after three attempts",
    activities: {
      executePersistedMemoryChangeSet: async (input: MemoryMutationWorkflowInput) => {
        const attempt = Context.current().info.attempt;
        calls.push({ input, attempt });
        if (input.changeSetId.endsWith("failure") || attempt < 3) throw syntheticError("mutation storage unavailable");
        return mutationResult(input);
      }
    },
    async run(ctx) {
      for (const outcome of ["success", "failure"]) {
        const input = { changeSetId: `change-set:${outcome}`, traceId: `trace:mutation-${outcome}` };
        const handle = await ctx.start("memoryMutationWorkflow", [input]);
        if (outcome === "success") await expect(handle.result()).resolves.toEqual(mutationResult(input));
        else await expectActivityFailure(handle, "mutation storage unavailable");
        expect(calls.filter((call) => call.input.changeSetId === input.changeSetId)).toEqual([1, 2, 3].map((attempt) => ({ input, attempt })));
        await ctx.record(handle, `mutation-${outcome}`);
      }
    }
  };
}

function maintenanceScenario(): Scenario {
  const calls: string[] = [];
  let audit: MemoryConsolidationRun;
  const refreshed: MemoryMaintenanceResult = {
    status: "REFRESHED", generatedAt: "2026-07-13T00:00:00.000Z", sourceHash: "a".repeat(64), previousSourceHash: null,
    summary: { sourceCount: 2, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 }, durationMs: 1
  };
  const input = { scheduledAt: "2026-07-13T00:00:00.000Z", traceId: "trace:maintenance" };
  return {
    name: "maintenance continues after best effort failures and awaits its consolidation child",
    activities: {
      refreshMemoryGraphSnapshot: async (received: unknown) => { expect(received).toEqual(input); calls.push("snapshot"); return refreshed; },
      refreshAllMonthsMemoryGraphSnapshot: async () => { calls.push(`all-months:${Context.current().info.attempt}`); throw syntheticError("all months unavailable"); },
      reconcileStaleSpaceAgentSessions: async () => { calls.push(`reconcile:${Context.current().info.attempt}`); throw syntheticError("reconciliation unavailable"); },
      createScheduledMemoryAudit: async (received: unknown) => {
        expect(received).toEqual({ ...input, sourceHash: refreshed.sourceHash });
        calls.push("audit");
        audit = consolidationRun(`audit:${workflowExecution().workflowId}`);
        return audit;
      },
      prepareMemoryConsolidation: async (received: unknown) => {
        expect(received).toEqual({ runId: audit.id, traceId: input.traceId });
        calls.push("consolidate");
        return { changeSetId: null, run: audit };
      },
      executePersistedMemoryChangeSet: async () => { calls.push("unexpected-mutation"); },
      finalizeMemoryRepair: async () => { calls.push("unexpected-finalize"); }
    },
    async run(ctx) {
      const handle = await ctx.start("memoryMaintenanceWorkflow", [input]);
      await expect(handle.result()).resolves.toEqual(refreshed);
      expect(calls).toEqual(["snapshot", "all-months:1", "all-months:2", "all-months:3", "reconcile:1", "reconcile:2", "reconcile:3", "audit", "consolidate"]);
      const history = await handle.fetchHistory();
      const children = (history.events ?? []).flatMap((event) => event.startChildWorkflowExecutionInitiatedEventAttributes ? [event.startChildWorkflowExecutionInitiatedEventAttributes] : []);
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ workflowId: audit.workflowId, workflowType: { name: "memoryConsolidationWorkflow" }, taskQueue: { name: "space-memory-maintenance" } });
      expect(history.events?.some((event) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
      await ctx.record(handle, "maintenance-best-effort-failures");
      await ctx.record(ctx.env.client.workflow.getHandle(audit.workflowId), "maintenance-audit-child");
    }
  };
}

function consolidationScenario(): Scenario {
  const calls: Array<{ activity: string; input: unknown; attempt: number }> = [];
  const run = { ...consolidationRun("run:repair"), mode: "REPAIR" as const, findingCount: 1, appliedOperationCount: 1 };
  const changeSetId = "change-set:repair";
  return {
    name: "consolidation retries mutation on its dedicated queue then finalizes the repair",
    activities: {
      prepareMemoryConsolidation: async (input: unknown) => { calls.push({ activity: "prepare", input, attempt: Context.current().info.attempt }); return { run, changeSetId }; },
      executePersistedMemoryChangeSet: async (input: MemoryMutationWorkflowInput) => {
        const attempt = Context.current().info.attempt;
        calls.push({ activity: "mutate", input, attempt });
        if (attempt < 3) throw syntheticError("repair storage unavailable");
        return mutationResult(input);
      },
      finalizeMemoryRepair: async (input: unknown) => { calls.push({ activity: "finalize", input, attempt: Context.current().info.attempt }); return run; }
    },
    async run(ctx) {
      const input = { runId: run.id, traceId: "trace:repair" };
      const mutationInput = { changeSetId, traceId: input.traceId };
      const handle = await ctx.start("memoryConsolidationWorkflow", [input]);
      await expect(handle.result()).resolves.toEqual(run);
      expect(calls).toEqual([
        { activity: "prepare", input, attempt: 1 },
        ...[1, 2, 3].map((attempt) => ({ activity: "mutate", input: mutationInput, attempt })),
        { activity: "finalize", input: { runId: run.id, changeSetId, mutationResult: mutationResult(mutationInput) }, attempt: 1 }
      ]);
      expect(scheduledActivities(await handle.fetchHistory()).find((activity) => activity.activityType?.name === "executePersistedMemoryChangeSet"))
        .toMatchObject({ taskQueue: { name: "space-memory-mutations" }, retryPolicy: { maximumAttempts: 3 } });
      await ctx.record(handle, "consolidation-repair");
    }
  };
}

function actionScenario(legacy: boolean): Scenario {
  const attempts: number[] = [];
  const failures: Array<{ input: unknown; attempt: number }> = [];
  return {
    name: legacy ? "legacy background action history rethrows without failure persistence" : "patched background action persists exhausted failure before rethrowing",
    legacy,
    activities: {
      runRoomAgentBackgroundAction: async () => { attempts.push(Context.current().info.attempt); throw syntheticError("background transport exhausted"); },
      failRoomAgentBackgroundAction: async (input: unknown) => {
        const attempt = Context.current().info.attempt;
        failures.push({ input, attempt });
        if (attempt < 3) throw syntheticError("failure persistence temporarily unavailable");
      }
    },
    async run(ctx) {
      const bridge: SpaceAgentRoomActionBridgeRequest = {
        roomId: "room:action", missionId: "mission:action", agentPaneId: "pane:action", agentSessionId: "session:action",
        selectedToolIds: ["room:inspect"], actions: [{ toolId: "room:inspect", action: { type: "inspect" } }]
      };
      const input = { traceId: "trace:action-failure", bridge };
      const actionId = legacy ? "synthetic-action-legacy" : "synthetic-action-current";
      const handle = await ctx.start("roomAgentActionWorkflow", [input], `space-room-action:${actionId}`);
      await expectActivityFailure(handle, "background transport exhausted");
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      const persisted = { roomId: input.bridge.roomId, missionId: input.bridge.missionId, actionId, cancelled: false };
      expect(failures).toEqual(legacy ? [] : [1, 2, 3].map((attempt) => ({ input: persisted, attempt })));
      const history = await handle.fetchHistory();
      const names = scheduledActivities(history).map((activity) => activity.activityType?.name);
      expect(names).toEqual(legacy ? ["runRoomAgentBackgroundAction"] : ["runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction"]);
      expect(history.events?.some((event) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(!legacy);
      await ctx.record(handle, legacy ? "action-legacy-failure" : "action-patched-failure");
    }
  };
}

function goalWakeScenario(): Scenario {
  let releaseStep!: () => void;
  let enteredStep!: () => void;
  const firstStepEntered = new Promise<void>((resolve) => { enteredStep = resolve; });
  const stepGate = new Promise<void>((resolve) => { releaseStep = resolve; });
  let steps = 0;
  let observes = 0;
  return {
    name: "goal wake signals survive an activity and cancel a durable pause timer",
    activities: {
      dotGoalStep: async () => {
        steps++;
        if (steps === 1) { enteredStep(); await stepGate; }
        return steps < 3 ? { state: "PAUSED", runId: null, goalStatus: "PAUSED" } : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      },
      dotGoalObserve: async () => { observes++; return { run: "COMPLETED", goalStatus: "ACTIVE" }; }
    },
    async run(ctx) {
      const handle = await ctx.start("dotGoalWorkflow", [{ goalId: "dot_goal:wake-test" }]);
      try {
        await firstStepEntered;
        await handle.signal("dotGoalWake");
        releaseStep();
        const paused = await waitForTimer(handle);
        expect(steps).toBe(2); // First wake was retained while the first activity was still running.
        expect(timerSeconds(paused)).toEqual(["3600"]);
        await handle.signal("dotGoalWake");
        await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETED" });
        const history = await handle.fetchHistory();
        expect(timerSeconds(history)).toEqual(["3600"]);
        expect(history.events?.filter((event) => event.timerCanceledEventAttributes)).toHaveLength(1);
        expect(history.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(0);
        expect(history.events?.filter((event) => event.workflowExecutionSignaledEventAttributes)).toHaveLength(2);
        expect(steps).toBe(3);
        expect(observes).toBe(0);
        await ctx.record(handle, "dot-wake-signals");
      } finally { releaseStep(); }
    }
  };
}

function goalTimeoutScenario(): Scenario {
  let steps = 0;
  const observed: unknown[][] = [];
  return {
    name: "goal timeout waits thirty seconds for capacity and polls a run every fifteen seconds",
    activities: {
      dotGoalStep: async () => {
        steps++;
        if (steps === 1) return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
        if (steps === 2) return { state: "STARTED", runId: "run:goal-test", goalStatus: "ACTIVE" };
        return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      },
      dotGoalObserve: async (...args: unknown[]) => {
        observed.push(args);
        return { run: observed.length === 1 ? "RUNNING" : "COMPLETED", goalStatus: "ACTIVE" };
      }
    },
    async run(ctx) {
      const input = { goalId: "dot_goal:timeout-test" };
      const handle = await ctx.start("dotGoalWorkflow", [input]);
      await waitForTimer(handle);
      await ctx.env.sleep("30 seconds");
      await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETED" });
      const history = await handle.fetchHistory();
      expect(timerSeconds(history)).toEqual(["30", "15", "15"]);
      expect(history.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(3);
      expect(history.events?.filter((event) => event.workflowExecutionSignaledEventAttributes)).toHaveLength(0);
      expect(observed).toEqual([[input.goalId, "run:goal-test"], [input.goalId, "run:goal-test"]]);
      expect(steps).toBe(3);
      await ctx.record(handle, "dot-timeouts");
    }
  };
}

function goalContinuationScenario(): Scenario {
  const calls: Array<{ goalId: string; runId: string }> = [];
  let observes = 0;
  return {
    name: "unfinished goal continues as new after the real three hundred iteration budget",
    activities: {
      dotGoalStep: async (goalId: string) => {
        calls.push({ goalId, runId: workflowExecution().runId });
        return calls.length <= 300
          ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      },
      dotGoalObserve: async () => { observes++; return { run: "COMPLETED", goalStatus: "ACTIVE" }; }
    },
    async run(ctx) {
      const input = { goalId: "dot_goal:continue-test" };
      const handle = await ctx.start("dotGoalWorkflow", [input]);
      // Pin the first execution: an unpinned handle resolves to the latest run after continuation.
      const firstRunId = (await handle.describe()).runId;
      const first = ctx.env.client.workflow.getHandle(handle.workflowId, firstRunId);
      const chain = ctx.env.client.workflow.getHandle(handle.workflowId, firstRunId, { followRuns: true });
      await expect(chain.result()).resolves.toEqual({ goalStatus: "COMPLETED" });
      expect(calls).toHaveLength(301);
      expect(calls.filter((call) => call.runId === firstRunId)).toHaveLength(300);
      expect(new Set(calls.map((call) => call.goalId))).toEqual(new Set([input.goalId]));
      const history = await first.fetchHistory();
      expect(timerSeconds(history)).toEqual(Array.from({ length: 300 }, () => "30"));
      const continued = history.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
      expect(continued?.newExecutionRunId).toBeTruthy();
      expect(calls[300]?.runId).toBe(continued?.newExecutionRunId);
      expect(scheduledActivities(history)).toHaveLength(300);
      expect(observes).toBe(0);
      await ctx.record(first, "dot-continued-first-run");
      await ctx.record(ctx.env.client.workflow.getHandle(handle.workflowId, continued!.newExecutionRunId!), "dot-continued-completed-run");
    }
  };
}

/** Real workflow execution; only activity side effects are replaced by deterministic fixtures. */
export function basicScenarios(): Scenario[] {
  return [dummyScenario(), turnScenario(), mutationScenario(), maintenanceScenario(), consolidationScenario(),
    actionScenario(false), actionScenario(true), goalWakeScenario(), goalTimeoutScenario(), goalContinuationScenario()];
}
