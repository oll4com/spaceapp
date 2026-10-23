import assert from "node:assert/strict";
import { Context } from "@temporalio/activity";
import { DOT_GOAL_SIGNAL, MEMORY_MUTATION_TASK_QUEUE, dummyTurnInputSchema, memoryMaintenanceResultSchema, memoryConsolidationRunSchema, memoryMutationWorkflowResultSchema } from "@space/contracts";
import { deferred, eventsOf, type WorkflowScenario } from "./temporal-test-harness.js";
import { setImmediate as yieldTransport } from "node:timers/promises";

/**
 * Create a retryable synthetic failure with a fixed stack that omits local environment details.
 */
export function syntheticFailure() {
  const error = new Error("Synthetic transient activity failure");
  error.stack = "Error: Synthetic transient activity failure";
  return error;
}
/**
 * Build schema-checked synthetic turn input, with explicit scenario overrides applied last.
 */
export const turnInput = (extra = {}) => dummyTurnInputSchema.parse({
  roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic workflow test",
  traceId: "trace:synthetic", ...extra
});
/**
 * Create the synthetic completed-turn response expected from an activity stub.
 */
export const turnResult = (input: any) => ({
  workflowId: "workflow:synthetic-result", roomId: input.roomId, paneId: input.paneId,
  traceId: input.traceId, status: "COMPLETED", message: "Synthetic result"
});
const done = { state: "DONE", runId: null, goalStatus: "COMPLETED" };

export const basicScenarios: WorkflowScenario[] = [
  {
    name: "dummy ordering, forwarded input and transient retries", workflowType: "dummyTurnWorkflow",
    async run(ctx) {
      const calls: string[] = []; const attempts = { start: 0, complete: 0 }; const input = turnInput();
      ctx.activities.recordDummyTurnStarted = (value) => {
        assert.deepEqual(value, input); calls.push("start");
        if (++attempts.start < 2) throw syntheticFailure();
      };
      ctx.activities.recordDummyTurnCompleted = (value) => {
        assert.deepEqual(value, input); calls.push("complete");
        if (++attempts.complete < 2) throw syntheticFailure();
        return turnResult(value);
      };
      const handle = await ctx.start("dummyTurnWorkflow", input);
      assert.deepEqual(await handle.result(), turnResult(input));
      assert.deepEqual(calls, ["start", "start", "complete", "complete"]);
      await ctx.capture(handle, "dummy-retries");
    }
  },
  {
    name: "dummy exhausted start retries never completes", workflowType: "dummyTurnWorkflow",
    async run(ctx) {
      let attempts = 0; let completed = 0;
      ctx.activities.recordDummyTurnStarted = () => { attempts++; throw syntheticFailure(); };
      ctx.activities.recordDummyTurnCompleted = () => { completed++; };
      const handle = await ctx.start("dummyTurnWorkflow", turnInput());
      await assert.rejects(handle.result(), /Workflow execution failed/);
      assert.equal(attempts, 3); assert.equal(completed, 0);
    }
  },
  ...[
    { name: "room", extra: {}, route: "runCodexAppServerTurn", attempts: 5 },
    { name: "native", extra: { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic" }, route: "runCodexAppServerTurn", attempts: 5 },
    { name: "opencode", extra: { providerId: "opencode" }, route: "runOpenCodeAgentTurn", attempts: 1 },
    { name: "cli", extra: { providerId: "cli:claude" }, route: "runCliAgentTurn", attempts: 1 }
  ].flatMap(({ name, extra, route, attempts }) => [
    {
      name: `turn ${name} routes and forwards result`, workflowType: "codexAppServerTurnWorkflow",
      async run(ctx) {
        const input = turnInput(extra); const calls: string[] = [];
        for (const activity of ["runCodexAppServerTurn", "runOpenCodeAgentTurn", "runCliAgentTurn"]) {
          ctx.activities[activity] = (value) => { assert.deepEqual(value, input); calls.push(activity); return turnResult(value); };
        }
        const handle = await ctx.start("codexAppServerTurnWorkflow", input);
        assert.deepEqual(await handle.result(), turnResult(input)); assert.deepEqual(calls, [route]);
        if (name === "native") await ctx.capture(handle, "native-turn");
      }
    },
    {
      name: `turn ${name} exhausts unchanged retry policy`, workflowType: "codexAppServerTurnWorkflow",
      async run(ctx) {
        let count = 0;
        ctx.activities[route] = () => { count++; throw syntheticFailure(); };
        const handle = await ctx.start("codexAppServerTurnWorkflow", turnInput(extra));
        await assert.rejects(handle.result(), /Workflow execution failed/); assert.equal(count, attempts);
      }
    }
  ] satisfies WorkflowScenario[]),
  {
    name: "dot durable paused, waiting and observation timers with retries", workflowType: "dotGoalWorkflow",
    async run(ctx) {
      const steps = [
        { state: "PAUSED", runId: null, goalStatus: "PAUSED" },
        { state: "WAITING", runId: null, goalStatus: "ACTIVE" },
        { state: "RUNNING", runId: "run:synthetic", goalStatus: "ACTIVE" }, done
      ];
      let stepAttempts = 0; let observeAttempts = 0;
      ctx.activities.dotGoalStep = (goalId) => {
        assert.equal(goalId, "goal:synthetic");
        if (++stepAttempts === 1) throw syntheticFailure();
        return steps.shift();
      };
      ctx.activities.dotGoalObserve = (goalId, runId) => {
        assert.equal(goalId, "goal:synthetic"); assert.equal(runId, "run:synthetic");
        if (++observeAttempts === 1) throw syntheticFailure();
        return { run: observeAttempts === 2 ? "RUNNING" : "COMPLETED", goalStatus: "ACTIVE" };
      };
      const handle = await ctx.start("dotGoalWorkflow", { goalId: "goal:synthetic" });
      assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
      assert.equal(stepAttempts, 5); assert.equal(observeAttempts, 3);
      const history = await ctx.capture(handle, "dot-durable-timers");
      assert.deepEqual(eventsOf(history, "TIMER_STARTED").map((event: any) => Number(event.timerStartedEventAttributes.startToFireTimeout.seconds)), [3600, 30, 15, 15]);
      assert.equal(eventsOf(history, "TIMER_FIRED").length, 4);
    }
  },
  {
    name: "dot wake during activity is retained without a timer", workflowType: "dotGoalWorkflow",
    async run(ctx) {
      const ready = deferred<any>(); let calls = 0;
      ctx.activities.dotGoalStep = async () => {
        if (++calls > 1) return done;
        const handle = await ready.promise;
        await handle.signal(DOT_GOAL_SIGNAL);
        return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
      };
      const handle = await ctx.start("dotGoalWorkflow", { goalId: "goal:synthetic" }); ready.resolve(handle);
      assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
      const history = await ctx.capture(handle, "dot-wake-during-activity");
      assert.equal(eventsOf(history, "WORKFLOW_EXECUTION_SIGNALED").length, 1);
      assert.equal(eventsOf(history, "TIMER_STARTED").length, 0);
    }
  },
  {
    name: "dot continues after 300 unfinished iterations with the same goal", workflowType: "dotGoalWorkflow",
    async run(ctx) {
      let calls = 0; const ids: string[] = [];
      ctx.activities.dotGoalStep = (id) => { ids.push(id); return ++calls <= 300 ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" } : done; };
      const handle = await ctx.start("dotGoalWorkflow", { goalId: "goal:synthetic" });
      assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
      assert.equal(calls, 301); assert.deepEqual([...new Set(ids)], ["goal:synthetic"]);
      const history = await ctx.capture(handle, "dot-continue-as-new");
      assert.equal(eventsOf(history, "WORKFLOW_EXECUTION_CONTINUED_AS_NEW").length, 1);
      assert.equal(eventsOf(history, "TIMER_FIRED").length, 300);
    }
  }
];

const maintenanceInput = { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:synthetic-memory" };
const snapshot = memoryMaintenanceResultSchema.parse({ status: "UNCHANGED", sourceHash: "a".repeat(64), generatedAt: maintenanceInput.scheduledAt,
  previousSourceHash: "a".repeat(64), summary: { sourceCount: 0, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 }, durationMs: 0 });
const mutationResult = memoryMutationWorkflowResultSchema.parse({ status: "APPLIED", changeSetId: "change:synthetic", resultingSourceHash: "b".repeat(64), reason: null });
const run = memoryConsolidationRunSchema.parse({ id: "audit:synthetic", workflowId: "workflow:synthetic-consolidation", status: "SUCCEEDED",
  mode: "REPAIR", triggerKind: "SCHEDULED", dedupeKey: "synthetic-audit", sourceHash: null, actorUserId: null,
  progressCompleted: 0, progressTotal: 0, findingCount: 0, appliedOperationCount: 0, skippedOperationCount: 0, failedOperationCount: 0,
  metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null, createdAt: maintenanceInput.scheduledAt,
  startedAt: maintenanceInput.scheduledAt, completedAt: maintenanceInput.scheduledAt, updatedAt: maintenanceInput.scheduledAt });

export const memoryScenarios: WorkflowScenario[] = [
  {
    name: "maintenance continues after secondary failures and runs real consolidation child", workflowType: "memoryMaintenanceWorkflow", memoryQueues: true,
    async run(ctx) {
      const calls: string[] = []; let refreshAttempts = 0; let reconcileAttempts = 0;
      ctx.activities.refreshMemoryGraphSnapshot = input => { assert.deepEqual(input, maintenanceInput); calls.push("snapshot"); return snapshot; };
      ctx.activities.refreshAllMonthsMemoryGraphSnapshot = () => { refreshAttempts++; throw syntheticFailure(); };
      ctx.activities.reconcileStaleSpaceAgentSessions = () => { reconcileAttempts++; throw syntheticFailure(); };
      ctx.activities.createScheduledMemoryAudit = input => { assert.deepEqual(input, { ...maintenanceInput, sourceHash: snapshot.sourceHash }); calls.push("audit"); return run; };
      ctx.activities.prepareMemoryConsolidation = input => { assert.deepEqual(input, { runId: run.id, traceId: maintenanceInput.traceId }); calls.push("prepare"); return { run, changeSetId: null }; };
      const handle = await ctx.start("memoryMaintenanceWorkflow", maintenanceInput);
      assert.deepEqual(await handle.result(), snapshot);
      assert.equal(refreshAttempts, 3); assert.equal(reconcileAttempts, 3); assert.deepEqual(calls, ["snapshot", "audit", "prepare"]);
      const history = await ctx.capture(handle, "memory-maintenance-child");
      assert.equal(eventsOf(history, "CHILD_WORKFLOW_EXECUTION_COMPLETED").length, 1);
      const child = ctx.client.workflow.getHandle(run.workflowId);
      // Capture the real child with its correct workflow type separately in the recorder's parent fixture coverage.
      assert.deepEqual(await child.result(), run);
    }
  },
  ...[false, true].map<WorkflowScenario>(change => ({
    name: `consolidation ${change ? "mutation and finalize with retry" : "without change set"}`, workflowType: "memoryConsolidationWorkflow", memoryQueues: true,
    async run(ctx) {
      let preparations = 0; let mutations = 0; let finalizations = 0;
      ctx.activities.prepareMemoryConsolidation = () => { if (++preparations === 1) throw syntheticFailure(); return { run, changeSetId: change ? mutationResult.changeSetId : null }; };
      ctx.activities.executePersistedMemoryChangeSet = input => {
        assert.deepEqual(input, { changeSetId: mutationResult.changeSetId, traceId: maintenanceInput.traceId });
        assert.equal(Context.current().info.taskQueue, MEMORY_MUTATION_TASK_QUEUE);
        if (++mutations === 1) throw syntheticFailure(); return mutationResult;
      };
      ctx.activities.finalizeMemoryRepair = input => { finalizations++; assert.deepEqual(input, { runId: run.id, changeSetId: mutationResult.changeSetId, mutationResult }); return run; };
      const handle = await ctx.start("memoryConsolidationWorkflow", { runId: run.id, traceId: maintenanceInput.traceId });
      assert.deepEqual(await handle.result(), run); assert.equal(preparations, 2);
      assert.equal(mutations, change ? 2 : 0); assert.equal(finalizations, change ? 1 : 0);
      await ctx.capture(handle, change ? "memory-consolidation-mutation" : "memory-consolidation-noop");
    }
  })),
  ...[false, true].map<WorkflowScenario>(exhaust => ({
    name: `mutation ${exhaust ? "exhausts retries" : "retries and forwards"}`, workflowType: "memoryMutationWorkflow",
    async run(ctx) {
      let attempts = 0; const input = { changeSetId: mutationResult.changeSetId, traceId: maintenanceInput.traceId };
      ctx.activities.executePersistedMemoryChangeSet = value => { assert.deepEqual(value, input); if (++attempts < 2 || exhaust) throw syntheticFailure(); return mutationResult; };
      const handle = await ctx.start("memoryMutationWorkflow", input);
      if (exhaust) { await assert.rejects(handle.result(), /Workflow execution failed/); assert.equal(attempts, 3); }
      else { assert.deepEqual(await handle.result(), mutationResult); assert.equal(attempts, 2); await ctx.capture(handle, "memory-mutation-retry"); }
    }
  }))
];

export const additionalScenarios: WorkflowScenario[] = [
  {
    name: "dot wake cancels an already scheduled durable wait", workflowType: "dotGoalWorkflow",
    async run(ctx) {
      let calls = 0;
      ctx.activities.dotGoalStep = () => ++calls === 1 ? { state: "PAUSED", runId: null, goalStatus: "PAUSED" } : done;
      const handle = await ctx.start("dotGoalWorkflow", { goalId: "goal:synthetic" });
      const pinned = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const expires = Date.now() + 10_000;
      while (!eventsOf(await pinned.fetchHistory(), "TIMER_STARTED").length) {
        assert.ok(Date.now() < expires, "No durable timer observed before wake");
        await yieldTransport();
      }
      await handle.signal(DOT_GOAL_SIGNAL);
      assert.deepEqual(await handle.result(), { goalStatus: "COMPLETED" });
      const history = await ctx.capture(handle, "dot-wake-pending-timer");
      assert.equal(eventsOf(history, "TIMER_CANCELED").length, 1);
      assert.equal(eventsOf(history, "TIMER_FIRED").length, 0);
    }
  },
  {
    name: "background action forwards success without compensation", workflowType: "roomAgentActionWorkflow",
    async run(ctx) {
      const input = { actionId: "action:synthetic", bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:synthetic" };
      let compensation = 0;
      ctx.activities.runRoomAgentBackgroundAction = value => { assert.deepEqual(value, input); return { status: "COMPLETED" }; };
      ctx.activities.failRoomAgentBackgroundAction = () => { compensation++; };
      const handle = await ctx.start("roomAgentActionWorkflow", input);
      assert.deepEqual(await handle.result(), { status: "COMPLETED" }); assert.equal(compensation, 0);
    }
  },
  {
    name: "cancelled action persists cancellation in a noncancellable scope", workflowType: "roomAgentActionWorkflow",
    async run(ctx) {
      const entered = deferred(); const stopped = deferred(); const compensations: unknown[] = [];
      ctx.activities.runRoomAgentBackgroundAction = async () => {
        const activity = Context.current(); const beat = setInterval(() => activity.heartbeat("synthetic"), 50);
        activity.heartbeat("synthetic"); entered.resolve();
        try { return await activity.cancelled; }
        finally { clearInterval(beat); stopped.resolve(); }
      };
      ctx.activities.failRoomAgentBackgroundAction = value => { compensations.push(value); };
      const handle = await ctx.start("roomAgentActionWorkflow", {
        actionId: "action:synthetic", bridge: { roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:synthetic"
      });
      await entered.promise; await handle.cancel();
      await assert.rejects(handle.result(), /Workflow execution/); await stopped.promise;
      assert.deepEqual(compensations, [{ roomId: "room:synthetic", missionId: "mission:synthetic", actionId: "action:synthetic", cancelled: true }]);
    }
  },
  {
    name: "paused supervisor waits durably before checking the same turn again", workflowType: "roomAgentSupervisorWorkflow",
    async run(ctx) {
      const checked = deferred(); let checks = 0;
      ctx.activities.checkRoomAgentSupervisorTurn = () => { if (++checks === 2) checked.resolve(); return "PAUSED"; };
      const handle = await ctx.start("roomAgentSupervisorWorkflow", { roomId: "room:synthetic", pending: [{ missionId: "mission:synthetic", turn: turnInput() }] });
      // Advancing server time allows the real one-second condition to fire.
      for (let i = 0; i < 10 && checks < 2; i++) await ctx.env.sleep("1 second");
      assert.ok(checks >= 2, "Paused turn was not checked after its durable timeout"); await checked.promise;
      const history = await ctx.capture(handle, "supervisor-paused");
      assert.ok(eventsOf(history, "TIMER_FIRED").length >= 1);
      assert.equal(eventsOf(history, "START_CHILD_WORKFLOW_EXECUTION_INITIATED").length, 0);
    }
  },
  ...["prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"].map<WorkflowScenario>(failureAt => ({
    name: `consolidation exhausts ${failureAt} retries`, workflowType: "memoryConsolidationWorkflow", memoryQueues: true,
    async run(ctx) {
      const counts: Record<string, number> = { prepareMemoryConsolidation: 0, executePersistedMemoryChangeSet: 0, finalizeMemoryRepair: 0 };
      const values: Record<string, unknown> = { prepareMemoryConsolidation: { run, changeSetId: mutationResult.changeSetId }, executePersistedMemoryChangeSet: mutationResult, finalizeMemoryRepair: run };
      for (const name of Object.keys(counts)) ctx.activities[name] = () => { counts[name]!++; if (name === failureAt) throw syntheticFailure(); return values[name]; };
      const handle = await ctx.start("memoryConsolidationWorkflow", { runId: run.id, traceId: maintenanceInput.traceId });
      await assert.rejects(handle.result(), /Workflow execution failed/); assert.equal(counts[failureAt], 3);
      if (failureAt === "prepareMemoryConsolidation") assert.equal(counts.executePersistedMemoryChangeSet, 0);
      if (failureAt !== "finalizeMemoryRepair") assert.equal(counts.finalizeMemoryRepair, 0);
    }
  }))
];
