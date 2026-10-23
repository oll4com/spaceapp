import { Context } from "@temporalio/activity";
import { expect } from "vitest";
import { NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT } from "../../src/turn-runtime-policy.js";
import { deferred, type Scenario, type TraceContext } from "./harness.js";

// These are behavioral oracles, not alternate implementations of the workflows.
// Every start and signal below goes through a real Temporal test server. Activity
// implementations are deliberately small, deterministic fixtures with no I/O.
type History = Awaited<ReturnType<TraceContext["record"]>>;

const turnInput = {
  roomId: "room:trace-contract",
  paneId: "pane:trace-contract",
  prompt: "Return the fixture result.",
  artifactIds: [],
  permissionMode: null,
  collaborationMode: "default",
  traceId: "trace:basic-contract"
};
const turnResult = {
  workflowId: "workflow:fixture-result",
  roomId: turnInput.roomId,
  paneId: turnInput.paneId,
  traceId: turnInput.traceId,
  status: "COMPLETED",
  message: "Fixture completed."
};
function actionBridge(missionId: string) {
  return {
    roomId: turnInput.roomId,
    missionId,
    agentPaneId: "pane:action-agent",
    agentSessionId: "session:action-agent",
    backgroundExecution: true,
    selectedToolIds: ["room:start"],
    actions: [{ toolId: "room:start", action: { type: "start", paneId: turnInput.paneId } }]
  };
}
const memoryInput = {
  scheduledAt: "2026-01-01T00:00:00.000Z",
  traceId: "trace:memory-contract"
};
const snapshotResult = {
  status: "REFRESHED",
  generatedAt: memoryInput.scheduledAt,
  sourceHash: "a".repeat(64),
  previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 },
  durationMs: 7
};
const mutationResult = {
  status: "APPLIED",
  changeSetId: "change-set:trace-contract",
  resultingSourceHash: "b".repeat(64),
  reason: null
};

function consolidationRun(workflowId: string) {
  return {
    id: "memory-run:trace-contract",
    mode: "REPAIR",
    triggerKind: "SCHEDULED",
    status: "SUCCEEDED",
    workflowId,
    dedupeKey: "fixture:memory-run",
    sourceHash: snapshotResult.sourceHash,
    actorUserId: null,
    progressCompleted: 1,
    progressTotal: 1,
    findingCount: 1,
    appliedOperationCount: 1,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: null,
    createdAt: memoryInput.scheduledAt,
    startedAt: memoryInput.scheduledAt,
    completedAt: memoryInput.scheduledAt,
    updatedAt: memoryInput.scheduledAt
  };
}

function scheduled(history: History) {
  return (history.events ?? []).flatMap((event) =>
    event.activityTaskScheduledEventAttributes ? [event.activityTaskScheduledEventAttributes] : []);
}

function scheduledNames(history: History) {
  return scheduled(history).map((activity) => activity.activityType?.name);
}

function timerSeconds(history: History) {
  return (history.events ?? []).flatMap((event) => event.timerStartedEventAttributes
    ? [Number(event.timerStartedEventAttributes.startToFireTimeout?.seconds ?? 0)] : []);
}

function countEvents(history: History, attribute: keyof NonNullable<History["events"]>[number]) {
  return (history.events ?? []).filter((event) => event[attribute] != null).length;
}

function expectActivityPolicy(
  history: History,
  name: string,
  timeoutSeconds: number,
  attempts: number,
  heartbeatSeconds = 0,
  taskQueue?: string
) {
  const matches = scheduled(history).filter((activity) => activity.activityType?.name === name);
  expect(matches.length, `${name} must be scheduled`).toBeGreaterThan(0);
  for (const activity of matches) {
    expect(Number(activity.startToCloseTimeout?.seconds ?? 0)).toBe(timeoutSeconds);
    expect(activity.retryPolicy?.maximumAttempts).toBe(attempts);
    expect(Number(activity.heartbeatTimeout?.seconds ?? 0)).toBe(heartbeatSeconds);
    if (taskQueue) expect(activity.taskQueue?.name).toBe(taskQueue);
  }
}

function decodeFirstInput(input: { payloads?: Array<{ data?: Uint8Array | null }> | null } | null | undefined) {
  const bytes = input?.payloads?.[0]?.data;
  expect(bytes).toBeTruthy();
  return JSON.parse(new TextDecoder().decode(bytes!)) as unknown;
}

const dummyScenarios: Scenario[] = [
  {
    name: "dummy retries each ordered activity before returning the completion result",
    workflowType: "dummyTurnWorkflow",
    async run(ctx) {
      const calls: Array<{ name: string; attempt: number; input: unknown }> = [];
      ctx.activities.recordDummyTurnStarted = async (input) => {
        const attempt = Context.current().info.attempt;
        calls.push({ name: "start", attempt, input });
        if (attempt < 3) throw new Error("Transient start recording failure.");
        return { workflowId: "workflow:fixture-result" };
      };
      ctx.activities.recordDummyTurnCompleted = async (input) => {
        const attempt = Context.current().info.attempt;
        calls.push({ name: "complete", attempt, input });
        if (attempt < 2) throw new Error("Transient completion recording failure.");
        return turnResult;
      };
      const handle = await ctx.start("dummyTurnWorkflow", turnInput);
      expect(await handle.result()).toEqual(turnResult);
      expect(calls).toEqual([
        { name: "start", attempt: 1, input: turnInput },
        { name: "start", attempt: 2, input: turnInput },
        { name: "start", attempt: 3, input: turnInput },
        { name: "complete", attempt: 1, input: turnInput },
        { name: "complete", attempt: 2, input: turnInput }
      ]);
      const history = await ctx.record(handle, "dummy-retry-success");
      expect(scheduledNames(history)).toEqual(["recordDummyTurnStarted", "recordDummyTurnCompleted"]);
      expectActivityPolicy(history, "recordDummyTurnStarted", 60, 3);
      expectActivityPolicy(history, "recordDummyTurnCompleted", 60, 3);
      expect(countEvents(history, "workflowExecutionCompletedEventAttributes")).toBe(1);
    }
  },
  {
    name: "dummy fails after three start attempts without recording completion",
    workflowType: "dummyTurnWorkflow",
    async run(ctx) {
      const attempts: number[] = [];
      ctx.activities.recordDummyTurnStarted = async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("Start recording unavailable.");
      };
      ctx.activities.recordDummyTurnCompleted = async () => {
        throw new Error("Completion must not run after a failed start.");
      };
      const handle = await ctx.start("dummyTurnWorkflow", turnInput);
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "dummy-exhausted-start");
      expect(scheduledNames(history)).toEqual(["recordDummyTurnStarted"]);
      expect(countEvents(history, "activityTaskFailedEventAttributes")).toBe(1);
      expect(countEvents(history, "workflowExecutionFailedEventAttributes")).toBe(1);
    }
  }
];

const goalScenarios: Scenario[] = [
  {
    name: "goal uses durable waiting paused and running timers",
    workflowType: "dotGoalWorkflow",
    async run(ctx) {
      const goalId = "dot_goal:trace-timers";
      const steps = [
        { state: "WAITING", runId: null, goalStatus: "ACTIVE" },
        { state: "PAUSED", runId: null, goalStatus: "PAUSED" },
        { state: "STARTED", runId: "agent-run:trace-goal", goalStatus: "ACTIVE" },
        { state: "STARTED", runId: null, goalStatus: "ACTIVE" },
        { state: "DONE", runId: null, goalStatus: "COMPLETED" }
      ];
      const runStates = ["QUEUED", "RUNNING", "COMPLETED"];
      const calls: unknown[] = [];
      ctx.activities.dotGoalStep = async (id) => {
        calls.push(["step", id]);
        const next = steps.shift();
        if (!next) throw new Error("Unexpected extra goal iteration.");
        return next;
      };
      ctx.activities.dotGoalObserve = async (id, runId) => {
        calls.push(["observe", id, runId]);
        return { run: runStates.shift(), goalStatus: "ACTIVE" };
      };
      const handle = await ctx.start("dotGoalWorkflow", { goalId });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(calls).toEqual([
        ["step", goalId], ["step", goalId], ["step", goalId],
        ["observe", goalId, "agent-run:trace-goal"],
        ["observe", goalId, "agent-run:trace-goal"],
        ["observe", goalId, "agent-run:trace-goal"],
        ["step", goalId], ["step", goalId]
      ]);
      const history = await ctx.record(handle, "goal-timer-paths");
      expect(timerSeconds(history)).toEqual([30, 3600, 15, 15, 15, 30]);
      expect(countEvents(history, "timerFiredEventAttributes")).toBe(6);
      expect(countEvents(history, "timerCanceledEventAttributes")).toBe(0);
      expectActivityPolicy(history, "dotGoalStep", 120, 20);
      expectActivityPolicy(history, "dotGoalObserve", 120, 20);
    }
  },
  {
    name: "goal retains an activity-time wake and consumes each wake once",
    workflowType: "dotGoalWorkflow",
    async run(ctx) {
      const firstStep = deferred<void>();
      const releaseFirstStep = deferred<void>();
      let stepCount = 0;
      let observed = false;
      ctx.activities.dotGoalStep = async () => {
        stepCount++;
        if (stepCount === 1) {
          firstStep.resolve();
          await releaseFirstStep.promise;
          return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
        }
        if (stepCount === 2) return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
        return { state: "DONE", runId: null, goalStatus: "CANCELLED" };
      };
      ctx.activities.dotGoalObserve = async () => { observed = true; return {}; };
      const handle = await ctx.start("dotGoalWorkflow", { goalId: "dot_goal:trace-wake" });
      await ctx.waitFor(() => stepCount === 1, "first goal activity to start");
      await firstStep.promise;
      await handle.signal("dotGoalWake");
      releaseFirstStep.resolve();
      await ctx.waitFor(async () => timerSeconds(await handle.fetchHistory()).length === 1,
        "the second wait to schedule its timer after consuming the first wake");
      await handle.signal("dotGoalWake");
      expect(await handle.result()).toEqual({ goalStatus: "CANCELLED" });
      expect(stepCount).toBe(3);
      expect(observed).toBe(false);
      const history = await ctx.record(handle, "goal-latched-and-timer-wakes");
      expect(timerSeconds(history)).toEqual([30]);
      expect(countEvents(history, "workflowExecutionSignaledEventAttributes")).toBe(2);
      expect(countEvents(history, "timerCanceledEventAttributes")).toBe(1);
      expect(countEvents(history, "timerFiredEventAttributes")).toBe(0);
    }
  },
  {
    name: "goal retries its API activity with the bounded exponential policy",
    workflowType: "dotGoalWorkflow",
    async run(ctx) {
      const attempts: number[] = [];
      ctx.activities.dotGoalStep = async () => {
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt < 3) throw new Error("Goal API temporarily unavailable.");
        return { state: "DONE", runId: null, goalStatus: "MISSING" };
      };
      const handle = await ctx.start("dotGoalWorkflow", { goalId: "dot_goal:trace-retry" });
      expect(await handle.result()).toEqual({ goalStatus: "MISSING" });
      expect(attempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "goal-retry-policy");
      expectActivityPolicy(history, "dotGoalStep", 120, 20);
      const policy = scheduled(history)[0]!.retryPolicy!;
      expect(Number(policy.initialInterval?.seconds)).toBe(5);
      expect(policy.backoffCoefficient).toBe(2);
      expect(Number(policy.maximumInterval?.seconds)).toBe(120);
      expect(timerSeconds(history)).toEqual([]);
    }
  },
  {
    name: "goal continues as new after exactly 300 iterations and preserves its input",
    workflowType: "dotGoalWorkflow",
    async run(ctx) {
      const input = { goalId: "dot_goal:trace-rollover" };
      let steps = 0;
      ctx.activities.dotGoalStep = async (goalId) => {
        expect(goalId).toBe(input.goalId);
        return ++steps <= 300
          ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      };
      const handle = await ctx.start("dotGoalWorkflow", input);
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(steps).toBe(301);
      const first = ctx.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await ctx.record(first, "goal-300-iteration-first-run");
      expect(scheduledNames(history)).toEqual(Array(300).fill("dotGoalStep"));
      expect(timerSeconds(history)).toEqual(Array(300).fill(30));
      expect(countEvents(history, "timerFiredEventAttributes")).toBe(300);
      const continued = (history.events ?? []).find((event) => event.workflowExecutionContinuedAsNewEventAttributes)
        ?.workflowExecutionContinuedAsNewEventAttributes;
      expect(continued).toBeTruthy();
      expect(decodeFirstInput(continued?.input)).toEqual(input);
      const next = ctx.env.client.workflow.getHandle(handle.workflowId, continued!.newExecutionRunId!);
      const nextHistory = await ctx.record(next, "goal-300-iteration-next-run");
      expect(scheduledNames(nextHistory)).toEqual(["dotGoalStep"]);
      expect(countEvents(nextHistory, "workflowExecutionCompletedEventAttributes")).toBe(1);
    }
  }
];

const turnScenarios: Scenario[] = [
  {
    name: "turn routes providers and native sessions with exact timeout retry and heartbeat policies",
    workflowType: "codexAppServerTurnWorkflow",
    async run(ctx) {
      const calls: Array<{ name: string; input: unknown }> = [];
      for (const name of ["runOpenCodeAgentTurn", "runCliAgentTurn", "runCodexAppServerTurn"]) {
        ctx.activities[name] = async (input) => { calls.push({ name, input }); return turnResult; };
      }
      const cases = [
        { label: "opencode", extra: { providerId: "opencode", agentSessionId: "session:opencode", agentAssistantMessageId: "message:opencode" }, activity: "runOpenCodeAgentTurn", timeout: 2400, attempts: 1 },
        { label: "cli", extra: { providerId: "cli:claude", agentSessionId: "session:cli", agentAssistantMessageId: "message:cli" }, activity: "runCliAgentTurn", timeout: 1800, attempts: 1 },
        { label: "native", extra: { providerId: "codex", agentSessionId: "session:native", agentAssistantMessageId: "message:native" }, activity: "runCodexAppServerTurn", timeout: 3_153_600_000, attempts: 5 },
        { label: "room", extra: { providerId: "codex", agentSessionId: "session:room", agentAssistantMessageId: "message:room", roomAgentMissionId: "mission:room" }, activity: "runCodexAppServerTurn", timeout: 86400, attempts: 5 },
        { label: "missing-native-message", extra: { agentSessionId: "session:incomplete" }, activity: "runCodexAppServerTurn", timeout: 86400, attempts: 5 },
        { label: "missing-native-session", extra: { agentAssistantMessageId: "message:incomplete" }, activity: "runCodexAppServerTurn", timeout: 86400, attempts: 5 }
      ];
      for (const fixture of cases) {
        const input = { ...turnInput, ...fixture.extra };
        const handle = await ctx.start("codexAppServerTurnWorkflow", input);
        expect(await handle.result()).toEqual(turnResult);
        const history = await ctx.record(handle, `turn-route-${fixture.label}`);
        expect(scheduledNames(history)).toEqual([fixture.activity]);
        let effectiveTimeout = fixture.timeout;
        if (fixture.label === "native") {
          // The Java time-skipping server caps run/execution timeouts at ten
          // years, then clips an activity's start-to-close to that run timeout:
          // temporalio/sdk-java, StateMachines.DEFAULT_WORKFLOW_EXECUTION_TIMEOUT_MILLISECONDS
          // and TestWorkflowMutableStateImpl.validateActivityScheduleAttributes.
          // https://github.com/temporalio/sdk-java/blob/master/temporal-test-server/src/main/java/io/temporal/internal/testservice/TestWorkflowMutableStateImpl.java
          // A history therefore cannot distinguish requested horizons above ten
          // years. Assert the 100-year policy separately, not as a ten-year rule.
          expect(NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT).toBe("36500 days");
          const started = history.events?.find((event) => event.workflowExecutionStartedEventAttributes)
            ?.workflowExecutionStartedEventAttributes;
          const runTimeout = Number(started?.workflowRunTimeout?.seconds ?? 0);
          expect(runTimeout, "time-skipping server's documented ten-year run cap").toBe(315_360_000);
          expect(Number(started?.workflowExecutionTimeout?.seconds ?? 0)).toBe(runTimeout);
          effectiveTimeout = Math.min(fixture.timeout, runTimeout);
        }
        expectActivityPolicy(history, fixture.activity, effectiveTimeout, fixture.attempts, 15);
        expect(calls.at(-1)).toEqual({ name: fixture.activity, input });
      }
      expect(calls).toHaveLength(cases.length);
    }
  },
  {
    name: "turn never retries CLI or OpenCode failures but retries the room activity five times",
    workflowType: "codexAppServerTurnWorkflow",
    async run(ctx) {
      for (const fixture of [
        { label: "opencode", providerId: "opencode", activity: "runOpenCodeAgentTurn", attempts: 1 },
        { label: "cli", providerId: "cli:gemini", activity: "runCliAgentTurn", attempts: 1 },
        { label: "room", providerId: "codex", activity: "runCodexAppServerTurn", attempts: 5 }
      ]) {
        const attempts: number[] = [];
        ctx.activities[fixture.activity] = async () => {
          attempts.push(Context.current().info.attempt);
          throw new Error("Fixture turn failed.");
        };
        const handle = await ctx.start("codexAppServerTurnWorkflow", { ...turnInput, providerId: fixture.providerId });
        await expect(handle.result()).rejects.toThrow();
        expect(attempts).toEqual(Array.from({ length: fixture.attempts }, (_, index) => index + 1));
        const history = await ctx.record(handle, `turn-failure-${fixture.label}`);
        expect(scheduledNames(history)).toEqual([fixture.activity]);
        expect(countEvents(history, "workflowExecutionFailedEventAttributes")).toBe(1);
      }
    }
  }
];

const actionScenarios: Scenario[] = [
  {
    name: "action returns a successful background result without failure cleanup",
    workflowType: "roomAgentActionWorkflow",
    async run(ctx) {
      const input = { actionId: "action:successful", bridge: actionBridge("mission:action"), traceId: turnInput.traceId };
      const result = {
        id: "space-agent-room-action-bridge",
        results: [{ request: input.bridge.actions[0], status: "EXECUTED", statusReason: "Fixture action completed.", paneId: turnInput.paneId, missionId: input.bridge.missionId, evidence: {} }]
      };
      ctx.activities.runRoomAgentBackgroundAction = async (received) => {
        expect(received).toEqual(input);
        return result;
      };
      const handle = await ctx.start("roomAgentActionWorkflow", input);
      expect(await handle.result()).toEqual(result);
      const history = await ctx.record(handle, "action-success");
      expect(scheduledNames(history)).toEqual(["runRoomAgentBackgroundAction"]);
      expectActivityPolicy(history, "runRoomAgentBackgroundAction", 86400, 5, 15);
    }
  },
  {
    name: "action exhausts execution retries then retries failure cleanup before failing",
    workflowType: "roomAgentActionWorkflow",
    async run(ctx) {
      const input = { bridge: actionBridge("mission:action"), traceId: turnInput.traceId };
      const executionAttempts: number[] = [];
      const cleanupAttempts: number[] = [];
      ctx.activities.runRoomAgentBackgroundAction = async () => {
        executionAttempts.push(Context.current().info.attempt);
        throw new Error("Background execution unavailable.");
      };
      ctx.activities.failRoomAgentBackgroundAction = async (received) => {
        const attempt = Context.current().info.attempt;
        cleanupAttempts.push(attempt);
        expect(received).toEqual({ roomId: input.bridge.roomId, missionId: input.bridge.missionId, actionId: "action:failed", cancelled: false });
        if (attempt < 3) throw new Error("Failure recording temporarily unavailable.");
      };
      const handle = await ctx.start("roomAgentActionWorkflow", input, { workflowId: "space-room-action:action:failed" });
      await expect(handle.result()).rejects.toMatchObject({
        cause: { name: "ActivityFailure", cause: { message: "Background execution unavailable." } }
      });
      expect(executionAttempts).toEqual([1, 2, 3, 4, 5]);
      expect(cleanupAttempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "action-failure-cleanup");
      expect(scheduledNames(history)).toEqual(["runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction"]);
      expectActivityPolicy(history, "failRoomAgentBackgroundAction", 60, 5);
      expect(countEvents(history, "workflowExecutionFailedEventAttributes")).toBe(1);
      expect(countEvents(history, "markerRecordedEventAttributes")).toBeGreaterThan(0);
    }
  },
  {
    name: "action cancellation waits for non-cancellable cleanup and preserves an explicit action id",
    workflowType: "roomAgentActionWorkflow",
    async run(ctx) {
      const input = { actionId: "action:explicit-cancellation", bridge: actionBridge("mission:cancelled-action"), traceId: turnInput.traceId };
      const releaseCleanup = deferred<void>();
      let running = false;
      let cancelled = false;
      let cleanupStarted = false;
      let cleanupCompleted = false;
      ctx.activities.runRoomAgentBackgroundAction = async () => {
        const activity = Context.current();
        running = true;
        activity.heartbeat();
        const heartbeat = setInterval(() => activity.heartbeat(), 25);
        try {
          return await activity.cancelled;
        } finally {
          clearInterval(heartbeat);
          cancelled = true;
        }
      };
      ctx.activities.failRoomAgentBackgroundAction = async (received) => {
        expect(received).toEqual({ roomId: input.bridge.roomId, missionId: input.bridge.missionId, actionId: input.actionId, cancelled: true });
        expect(Context.current().cancellationSignal.aborted).toBe(false);
        cleanupStarted = true;
        await releaseCleanup.promise;
        cleanupCompleted = true;
      };
      const handle = await ctx.start("roomAgentActionWorkflow", input, { workflowId: "space-room-action:derived-trace-action" });
      await ctx.waitFor(() => running, "background action to start before cancellation");
      await handle.cancel();
      await ctx.waitFor(() => cleanupStarted, "non-cancellable failure cleanup to start");
      const inCleanup = await handle.fetchHistory();
      expect(countEvents(inCleanup, "workflowExecutionCanceledEventAttributes")).toBe(0);
      expect(cleanupCompleted).toBe(false);
      releaseCleanup.resolve();
      await expect(handle.result()).rejects.toMatchObject({ cause: { name: "CancelledFailure" } });
      await ctx.waitFor(() => cancelled, "the original activity to acknowledge cancellation");
      expect(cleanupCompleted).toBe(true);
      const history = await ctx.record(handle, "action-cancellation-cleanup");
      expect(scheduledNames(history)).toEqual(["runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction"]);
      expect(countEvents(history, "workflowExecutionCancelRequestedEventAttributes")).toBe(1);
      expect(countEvents(history, "activityTaskCancelRequestedEventAttributes")).toBe(1);
      expect(countEvents(history, "workflowExecutionCanceledEventAttributes")).toBe(1);
      const cleanupSchedule = (history.events ?? []).find((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === "failRoomAgentBackgroundAction")!;
      const completedCleanup = (history.events ?? []).find((event) => event.activityTaskCompletedEventAttributes?.scheduledEventId?.toString() === cleanupSchedule.eventId?.toString());
      expect(completedCleanup).toBeTruthy();
    }
  }
];

const memoryScenarios: Scenario[] = [
  ...[false, true].map((bestEffortFails): Scenario => ({
    name: bestEffortFails
      ? "maintenance survives exhausted best-effort errors and waits for its consolidation child"
      : "maintenance passes its snapshot hash to the audit and awaits consolidation",
    workflowType: "memoryMaintenanceWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const label = bestEffortFails ? "best-effort" : "success";
      const run = consolidationRun(`memory-child:${label}`);
      const calls: string[] = [];
      const releaseChild = deferred<void>();
      let childPrepared = false;
      ctx.activities.refreshMemoryGraphSnapshot = async (input) => {
        calls.push("snapshot");
        expect(input).toEqual(memoryInput);
        return snapshotResult;
      };
      ctx.activities.refreshAllMonthsMemoryGraphSnapshot = async (input) => {
        calls.push(`all-months:${Context.current().info.attempt}`);
        expect(input).toEqual(memoryInput);
        if (bestEffortFails) throw new Error("All-months refresh fixture failure.");
        return snapshotResult;
      };
      ctx.activities.reconcileStaleSpaceAgentSessions = async (...args) => {
        calls.push(`reconcile:${Context.current().info.attempt}`);
        expect(args).toEqual([]);
        if (bestEffortFails) throw new Error("Reconciliation fixture failure.");
        return { reconciled: 0 };
      };
      ctx.activities.createScheduledMemoryAudit = async (input) => {
        calls.push("audit");
        expect(input).toEqual({ ...memoryInput, sourceHash: snapshotResult.sourceHash });
        return run;
      };
      ctx.activities.prepareMemoryConsolidation = async (input) => {
        calls.push("prepare");
        expect(input).toEqual({ runId: run.id, traceId: memoryInput.traceId });
        childPrepared = true;
        await releaseChild.promise;
        return { run: { ...run, status: "RUNNING", completedAt: null, progressCompleted: 0 }, changeSetId: mutationResult.changeSetId };
      };
      ctx.activities.executePersistedMemoryChangeSet = async (input) => {
        calls.push("mutate");
        expect(input).toEqual({ changeSetId: mutationResult.changeSetId, traceId: memoryInput.traceId });
        return mutationResult;
      };
      ctx.activities.finalizeMemoryRepair = async (input) => {
        calls.push("finalize");
        expect(input).toEqual({ runId: run.id, changeSetId: mutationResult.changeSetId, mutationResult });
        return run;
      };
      const handle = await ctx.start("memoryMaintenanceWorkflow", memoryInput);
      // Start result() so the server may skip the retry delays. Suppress an early
      // unhandled rejection without hiding the eventual assertion below.
      const result = handle.result();
      void result.catch(() => undefined);
      await ctx.waitFor(() => childPrepared, "maintenance consolidation child to prepare");
      expect(countEvents(await handle.fetchHistory(), "workflowExecutionCompletedEventAttributes")).toBe(0);
      releaseChild.resolve();
      expect(await result).toEqual(snapshotResult);
      expect(calls).toEqual([
        "snapshot",
        ...(bestEffortFails ? ["all-months:1", "all-months:2", "all-months:3"] : ["all-months:1"]),
        ...(bestEffortFails ? ["reconcile:1", "reconcile:2", "reconcile:3"] : ["reconcile:1"]),
        "audit", "prepare", "mutate", "finalize"
      ]);
      const history = await ctx.record(handle, `maintenance-${label}`);
      expect(scheduledNames(history)).toEqual([
        "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions", "createScheduledMemoryAudit"
      ]);
      for (const name of scheduledNames(history)) expectActivityPolicy(history, name!, 600, 3);
      const started = (history.events ?? []).find((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)
        ?.startChildWorkflowExecutionInitiatedEventAttributes;
      expect(started?.workflowType?.name).toBe("memoryConsolidationWorkflow");
      expect(started?.workflowId).toBe(run.workflowId);
      expect(started?.taskQueue?.name).toBe("space-memory-maintenance");
      expect(decodeFirstInput(started?.input)).toEqual({ runId: run.id, traceId: memoryInput.traceId });
      expect(countEvents(history, "childWorkflowExecutionCompletedEventAttributes")).toBe(1);
      const child = ctx.env.client.workflow.getHandle(run.workflowId);
      expect(await child.result()).toEqual(run);
      const childHistory = await ctx.record(child, `maintenance-${label}-child`);
      expect(scheduledNames(childHistory)).toEqual(["prepareMemoryConsolidation", "executePersistedMemoryChangeSet", "finalizeMemoryRepair"]);
      expectActivityPolicy(childHistory, "executePersistedMemoryChangeSet", 900, 3, 0, "space-memory-mutations");
    }
  })),
  {
    name: "maintenance fails fast when its required live snapshot fails",
    workflowType: "memoryMaintenanceWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const attempts: number[] = [];
      ctx.activities.refreshMemoryGraphSnapshot = async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("Live snapshot fixture failure.");
      };
      const handle = await ctx.start("memoryMaintenanceWorkflow", memoryInput);
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "maintenance-required-snapshot-failure");
      expect(scheduledNames(history)).toEqual(["refreshMemoryGraphSnapshot"]);
      expect(countEvents(history, "startChildWorkflowExecutionInitiatedEventAttributes")).toBe(0);
      expect(countEvents(history, "workflowExecutionFailedEventAttributes")).toBe(1);
    }
  },
  {
    name: "maintenance propagates a consolidation child failure",
    workflowType: "memoryMaintenanceWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const run = consolidationRun("memory-child:failed");
      ctx.activities.refreshMemoryGraphSnapshot = async () => snapshotResult;
      ctx.activities.refreshAllMonthsMemoryGraphSnapshot = async () => snapshotResult;
      ctx.activities.reconcileStaleSpaceAgentSessions = async () => ({});
      ctx.activities.createScheduledMemoryAudit = async () => run;
      const attempts: number[] = [];
      ctx.activities.prepareMemoryConsolidation = async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("Consolidation preparation fixture failure.");
      };
      const handle = await ctx.start("memoryMaintenanceWorkflow", memoryInput);
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "maintenance-child-failure");
      expect(countEvents(history, "childWorkflowExecutionFailedEventAttributes")).toBe(1);
      expect(countEvents(history, "workflowExecutionFailedEventAttributes")).toBe(1);
      const childHistory = await ctx.record(ctx.env.client.workflow.getHandle(run.workflowId), "maintenance-failed-child");
      expect(scheduledNames(childHistory)).toEqual(["prepareMemoryConsolidation"]);
    }
  },
  {
    name: "consolidation returns the prepared run when no change set exists",
    workflowType: "memoryConsolidationWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const run = consolidationRun("memory-consolidation:no-op");
      const input = { runId: run.id, traceId: memoryInput.traceId };
      ctx.activities.prepareMemoryConsolidation = async (received) => {
        expect(received).toEqual(input);
        return { run, changeSetId: null };
      };
      const handle = await ctx.start("memoryConsolidationWorkflow", input);
      expect(await handle.result()).toEqual(run);
      const history = await ctx.record(handle, "consolidation-no-change-set");
      expect(scheduledNames(history)).toEqual(["prepareMemoryConsolidation"]);
      expectActivityPolicy(history, "prepareMemoryConsolidation", 600, 3);
    }
  },
  {
    name: "consolidation does not finalize a repair after mutation retries are exhausted",
    workflowType: "memoryConsolidationWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const run = consolidationRun("memory-consolidation:mutation-failure");
      ctx.activities.prepareMemoryConsolidation = async () => ({ run, changeSetId: mutationResult.changeSetId });
      const attempts: number[] = [];
      ctx.activities.executePersistedMemoryChangeSet = async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("Mutation fixture failure.");
      };
      const handle = await ctx.start("memoryConsolidationWorkflow", { runId: run.id, traceId: memoryInput.traceId });
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "consolidation-mutation-exhausted");
      expect(scheduledNames(history)).toEqual(["prepareMemoryConsolidation", "executePersistedMemoryChangeSet"]);
      expectActivityPolicy(history, "executePersistedMemoryChangeSet", 900, 3, 0, "space-memory-mutations");
    }
  },
  {
    name: "mutation retries and preserves applied and operator-required results",
    workflowType: "memoryMutationWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const input = { changeSetId: mutationResult.changeSetId, traceId: memoryInput.traceId };
      for (const fixture of [
        { label: "applied", result: mutationResult, retries: true },
        { label: "operator-required", result: { status: "OPERATOR_REQUIRED", changeSetId: input.changeSetId, resultingSourceHash: null, reason: "Source changed since preparation." }, retries: false }
      ]) {
        const attempts: number[] = [];
        ctx.activities.executePersistedMemoryChangeSet = async (received) => {
          expect(received).toEqual(input);
          const attempt = Context.current().info.attempt;
          attempts.push(attempt);
          if (fixture.retries && attempt < 3) throw new Error("Mutation activity temporarily unavailable.");
          return fixture.result;
        };
        const handle = await ctx.start("memoryMutationWorkflow", input);
        expect(await handle.result()).toEqual(fixture.result);
        expect(attempts).toEqual(fixture.retries ? [1, 2, 3] : [1]);
        const history = await ctx.record(handle, `mutation-${fixture.label}`);
        expect(scheduledNames(history)).toEqual(["executePersistedMemoryChangeSet"]);
        expectActivityPolicy(history, "executePersistedMemoryChangeSet", 900, 3);
      }
    }
  },
  {
    name: "mutation propagates exhausted activity failure",
    workflowType: "memoryMutationWorkflow",
    memoryQueues: true,
    async run(ctx) {
      const attempts: number[] = [];
      ctx.activities.executePersistedMemoryChangeSet = async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("Mutation execution fixture failure.");
      };
      const handle = await ctx.start("memoryMutationWorkflow", { changeSetId: mutationResult.changeSetId, traceId: memoryInput.traceId });
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3]);
      const history = await ctx.record(handle, "mutation-exhausted");
      expect(scheduledNames(history)).toEqual(["executePersistedMemoryChangeSet"]);
      expect(countEvents(history, "workflowExecutionFailedEventAttributes")).toBe(1);
    }
  }
];

export const basicScenarios: Scenario[] = [
  ...dummyScenarios,
  ...goalScenarios,
  ...turnScenarios,
  ...actionScenarios,
  ...memoryScenarios
];
