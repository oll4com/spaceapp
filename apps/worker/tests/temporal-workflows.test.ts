import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError, WorkflowFailedError, WorkflowNotFoundError } from "@temporalio/client";
import { ActivityFailure, ApplicationFailure, defaultPayloadConverter, TimeoutFailure, TimeoutType } from "@temporalio/common";
import { temporal } from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import {
  DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema, memoryConsolidationRunSchema,
  memoryMaintenanceResultSchema, memoryMutationWorkflowResultSchema, dummyTurnResultSchema,
  MEMORY_MUTATION_TASK_QUEUE,
  type DummyTurnInput, type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";

const workflowsPath = fileURLToPath(new URL("./support/temporal-real-workflows.ts", import.meta.url));
const historiesDir = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));
const recording = process.env.SPACE_TEMPORAL_RECORD_HISTORIES === "1";
const branchPatch = "room-background-continuation-v1";
const historyNames = [
  "dot-goal-wake", "dummy-turn-retry", "codex-turn-retry", "supervisor-current-continuation",
  "supervisor-legacy-continuation", "room-action-failure", "memory-maintenance-child",
  "memory-consolidation-change", "memory-mutation-retry"
] as const;
type Handle = Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>;
type Stub = (...args: any[]) => any;
let env: TestWorkflowEnvironment;
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let stubs: Record<string, Stub> = {};
type ActivityCall = { name: string; args: any[]; attempt: number; workflowId: string; runId: string };
let calls: ActivityCall[] = [];
let serial = 0;
type SandboxCase = {
  env?: TestWorkflowEnvironment;
  workers: Worker[];
  running: Promise<void>[];
  handles: Handle[];
  stubs: Record<string, Stub>;
  calls: ActivityCall[];
  unexpectedActivities: string[];
  releaseGates: Array<() => void>;
  automaticResults: Promise<unknown>[];
  activities: Set<Promise<unknown>>;
  setupPromise: Promise<void>;
  cleanupPromise?: Promise<void>;
  teardownPromise?: Promise<void>;
};
let activeCase: SandboxCase | undefined;
const casesByContext = new WeakMap<object, SandboxCase>();

function beginCase(context: object): SandboxCase {
  // A timed-out hook is not cancellation. Do not replace the aliases while an
  // earlier environment, worker or tracked activity body remains owned. This
  // does not cancel arbitrary asynchronous code in a timed-out test body.
  if (activeCase) throw new Error("Previous sandbox case has not finished closing");
  const state: SandboxCase = {
    workers: [], running: [], handles: [], stubs: {}, calls: [], unexpectedActivities: [],
    releaseGates: [], automaticResults: [], activities: new Set(), setupPromise: Promise.resolve()
  };
  activeCase = state;
  casesByContext.set(context, state);
  return state;
}
function currentCase(): SandboxCase {
  if (!activeCase) throw new Error("No sandbox case owns the test environment");
  return activeCase;
}
function caseEnvironment(state: SandboxCase): TestWorkflowEnvironment {
  if (!state.env) throw new Error("Sandbox setup has not created its environment");
  return state.env;
}
async function within<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out closing ${label}`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function releaseCaseGates(state: SandboxCase) {
  for (const release of state.releaseGates.splice(0)) release();
}
function caseActivity(state: SandboxCase, name: string): Stub {
  return (...args) => {
    // Reject a queued callback after shutdown, before touching Context or a
    // stub body that may use the current test's count()/calls aliases.
    if (activeCase !== state || state.teardownPromise) {
      return Promise.reject(ApplicationFailure.nonRetryable("Activity belongs to a closing sandbox case"));
    }
    const result = (async () => {
      const info = Context.current().info;
      if (!info.workflowExecution) throw new Error("Test activity requires a workflow execution");
      state.calls.push({ name, args, attempt: info.attempt, workflowId: info.workflowExecution.workflowId, runId: info.workflowExecution.runId });
      const stub = state.stubs[name];
      if (!stub) {
        state.unexpectedActivities.push(name);
        throw ApplicationFailure.nonRetryable(`Unexpected test activity: ${name}`);
      }
      return stub(...args);
    })();
    state.activities.add(result);
    void result.finally(() => state.activities.delete(result)).catch(() => undefined);
    return result;
  };
}

const activityNames = [
  "recordDummyTurnStarted", "recordDummyTurnCompleted", "runOpenCodeAgentTurn", "runCliAgentTurn", "runCodexAppServerTurn",
  "markRoomAgentMissionStarted", "markRoomAgentMissionFinished", "markRoomAgentMissionContinued", "dotGoalStep", "dotGoalObserve",
  "settleRoomAgentBackgroundMission", "checkRoomAgentSupervisorTurn", "discardRoomAgentSupervisorTurn", "finishRoomAgentSupervisorTurn",
  "prepareRoomAgentBackgroundContinuation", "runRoomAgentBackgroundAction", "failRoomAgentBackgroundAction",
  "refreshMemoryGraphSnapshot", "refreshAllMonthsMemoryGraphSnapshot", "reconcileStaleSpaceAgentSessions", "createScheduledMemoryAudit",
  "prepareMemoryConsolidation", "finalizeMemoryRepair", "executePersistedMemoryChangeSet"
];

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  currentCase().releaseGates.push(() => resolve(undefined as T));
  return { promise, resolve };
}
async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 15_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}
const count = (name: string) => calls.filter((call) => call.name === name).length;
const turnResult = { status: "COMPLETED", message: "Synthetic verified turn", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic evidence checked."
} };
function turn(suffix: string): DummyTurnInput {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:synthetic", turn: {
    roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic request", artifactIds: [],
    agentRunId: `run:synthetic-${suffix}`, traceId: `trace:synthetic-${suffix}`, permissionMode: null, collaborationMode: "default"
  } }).turn;
}
function item(suffix: string): RoomAgentSupervisorQueueItem { return { missionId: "mission:synthetic", turn: turn(suffix) }; }
function consolidationRun(id: string) {
  const at = "2026-01-01T00:00:00.000Z";
  return memoryConsolidationRunSchema.parse({
    id, mode: "AUDIT", triggerKind: "SCHEDULED", status: "SUCCEEDED", workflowId: `workflow:${id}`,
    dedupeKey: `synthetic:${id}`, sourceHash: null, actorUserId: null, progressCompleted: 0, progressTotal: 0,
    findingCount: 0, appliedOperationCount: 0, skippedOperationCount: 0, failedOperationCount: 0,
    metrics: {}, modelId: null, aiVerified: false, aiEvidence: {}, statusReason: null,
    createdAt: at, startedAt: at, completedAt: at, updatedAt: at
  });
}
async function start(type: string, input: unknown, suffix = type) {
  const state = currentCase();
  serial++;
  const handle = await caseEnvironment(state).client.workflow.start(type, {
    workflowId: suffix.startsWith("space-room-action:") ? suffix : `sandbox-${serial}-${suffix}`, taskQueue: "space-sandbox-tests", args: [input]
  });
  state.handles.push(handle);
  return handle;
}
function autoResult(handle: Handle) {
  const result = handle.result();
  currentCase().automaticResults.push(result);
  void result.catch(() => undefined);
  return result;
}
async function remember(name: typeof historyNames[number], handle: Handle) {
  if (!recording) return;
  const history = await handle.fetchHistory();
  expect(history.events?.length, `${name} must contain real server history`).toBeGreaterThan(2);
  await mkdir(historiesDir, { recursive: true });
  // Error stacks contain checkout paths, which are neither synthetic data nor
  // needed by replay. Keep all event/command payloads; sanitize metadata only.
  const artifact = { workflowId: handle.workflowId, history };
  await writeFile(`${historiesDir}/${name}.json`, `${JSON.stringify(artifact, (key, value) =>
    key === "stackTrace" ? "Synthetic test failure (local stack omitted)" : value, 2)}\n`, "utf8");
}
function supervisorContinuationInput(raw: unknown) {
  roomAgentSupervisorInputSchema.parse(raw);
  // Validate the payload, but inspect its original fields: returning the
  // parsed output would let schema defaults hide missing carried state.
  return raw as Partial<ReturnType<typeof roomAgentSupervisorInputSchema.parse>>;
}
async function continued<T>(handle: Handle, parseInput: (input: unknown) => T) {
  const state = currentCase();
  const env = caseEnvironment(state);
  const pinned = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
  let event: any;
  const startTime = await env.currentTimeMs();
  try {
    await until(async () => {
      const history = await pinned.fetchHistory();
      event = history.events?.find((value) => value.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
      return Boolean(event);
    }, "continue-as-new history event");
  } catch (error) {
    const history = await pinned.fetchHistory();
    const events = history.events ?? [];
    const counts: Record<string, number> = {};
    for (const value of events) for (const key of Object.keys(value)) {
      if (key.endsWith("EventAttributes")) counts[key] = (counts[key] ?? 0) + 1;
    }
    const activityCounts: Record<string, number> = {};
    for (const call of state.calls.filter((value) => value.runId === handle.firstExecutionRunId)) activityCounts[call.name] = (activityCounts[call.name] ?? 0) + 1;
    console.error("Temporal continuation diagnostic", JSON.stringify({
      workflowId: handle.workflowId, firstRunId: handle.firstExecutionRunId,
      elapsedVirtualMs: (await env.currentTimeMs()) - startTime, eventCounts: counts, activityCounts,
      lastEventId: events.at(-1)?.eventId?.toString(), lastEventType: events.at(-1)?.eventType,
      inFlightActivities: state.workers.map((worker) => ({ taskQueue: worker.options.taskQueue, count: worker.getStatus().numInFlightActivities }))
    }));
    throw error;
  }
  return { pinned, input: parseInput(defaultPayloadConverter.fromPayload(event.input.payloads[0])), runId: event.newExecutionRunId };
}
async function closedContinuation(handle: Handle) {
  const state = currentCase();
  const env = caseEnvironment(state);
  // A single close-event long poll lets the test server skip time without a
  // growing stream of full-history reads. Do not follow the infinite next run.
  const result = env.client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
  state.automaticResults.push(result);
  void result.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let continuation: WorkflowContinuedAsNewError;
  try {
    await Promise.race([result, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out waiting for first-run close event")), 15_000);
    })]);
    throw new Error("Expected continue-as-new, but the supervisor completed normally");
  } catch (error) {
    if (!(error instanceof WorkflowContinuedAsNewError)) throw error;
    continuation = error;
  } finally { clearTimeout(timer); }
  const pinned = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
  const history = await pinned.fetchHistory();
  const event = history.events?.find((value) => value.workflowExecutionContinuedAsNewEventAttributes)?.workflowExecutionContinuedAsNewEventAttributes;
  expect(event, "The closed run must contain a real continue-as-new event").toBeDefined();
  expect(event!.newExecutionRunId).toBe(continuation.newExecutionRunId);
  return { pinned, history, input: supervisorContinuationInput(defaultPayloadConverter.fromPayload(event!.input!.payloads![0]!)), runId: event!.newExecutionRunId };
}
async function stop(handle: Handle, state = currentCase()) {
  const env = caseEnvironment(state);
  try { await env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test cleanup"); }
  catch (error) { if (!(error instanceof WorkflowNotFoundError)) throw error; }
}
function teardownEnvironment(state = activeCase): Promise<void> {
  if (!state) return Promise.resolve();
  if (!state.teardownPromise) {
    const close = (async () => {
      // Setup may still complete after its hook timed out. Keep ownership until
      // its exact environment/workers have been acquired and then closed.
      await state.setupPromise.catch(() => undefined);
      releaseCaseGates(state);
      const failures: unknown[] = [];
      try {
        for (const worker of state.workers) {
          try { if (worker.getState() === "RUNNING") worker.shutdown(); }
          catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Sandbox worker shutdown failed");
        const outcomes = await Promise.allSettled(state.running);
        for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
      } finally { await state.env?.teardown(); }
      // SDK shutdown can abandon an uncooperative activity body. Its promise
      // must settle before another case may replace count()/calls/stubs aliases.
      while (state.activities.size) await Promise.allSettled([...state.activities]);
      if (failures.length) throw new AggregateError(failures, "Sandbox worker shutdown failed");
    })();
    // Do not clear the owner in finally. A failed/timed-out close stays closed
    // to new cases, even if its underlying asynchronous operation finishes later.
    state.teardownPromise = within(close, 10_000, "sandbox teardown").then(() => {
      if (activeCase === state) activeCase = undefined;
    });
  }
  return state.teardownPromise;
}
function cleanupCase(state: SandboxCase): Promise<void> {
  if (!state.cleanupPromise) {
    const cleanup = (async () => {
      await state.setupPromise;
      try {
        const outcomes = await Promise.allSettled(state.handles.map((handle) => stop(handle, state)));
        const failures = outcomes.filter((outcome) => outcome.status === "rejected");
        if (failures.length) throw new AggregateError(failures.map((outcome) => outcome.reason), "Sandbox workflow cleanup failed");
      } finally { releaseCaseGates(state); }
      await Promise.allSettled(state.automaticResults);
      await until(() => state.workers.every((worker) => worker.getStatus().numInFlightActivities === 0), "activity cleanup before server teardown");
      expect(state.unexpectedActivities, "A missing activity stub must not be swallowed by a production catch block").toEqual([]);
    })();
    state.cleanupPromise = (async () => {
      try { await within(cleanup, 15_000, "sandbox activity cleanup"); }
      finally { await teardownEnvironment(state); }
    })();
  }
  return state.cleanupPromise;
}

// Reuse the compiled bundle, but give each case its own real server and clock.
// Terminated continue-as-new chains must not leave time-skipping locks that
// affect a later case. Only activity bodies are stubbed.
describe.sequential("real Temporal sandbox and recorded replay compatibility", () => {
  beforeAll(async () => {
    bundle = await bundleWorkflowCode({ workflowsPath });
  }, 60_000);
  beforeEach(async (context) => {
    const state = beginCase(context);
    // The guard runs synchronously before replacing these convenience aliases.
    calls = state.calls; stubs = state.stubs;
    state.setupPromise = (async () => {
      state.env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "space-synthetic-test-client" } });
      env = state.env;
      const activities = Object.fromEntries(activityNames.map((name) => [name, caseActivity(state, name)]));
      // Register each worker immediately so partial setup remains owned.
      for (const taskQueue of ["space-sandbox-tests", MEMORY_MAINTENANCE_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE]) {
        const worker = await Worker.create({
          connection: state.env.nativeConnection, taskQueue, workflowBundle: bundle, activities,
          identity: "space-synthetic-test-worker",
          patchActivationCallback: ({ workflowInfo, patchId }) => !(patchId === branchPatch && workflowInfo.workflowId.includes("legacy")),
          maxHeartbeatThrottleInterval: "100 milliseconds",
          defaultHeartbeatThrottleInterval: "100 milliseconds",
          shutdownGraceTime: "1 second"
        });
        state.workers.push(worker);
        const run = worker.run();
        state.running.push(run);
        void run.catch(() => undefined);
      }
    })();
    await state.setupPromise;
  }, 60_000);
  afterEach(async (context) => {
    // A beforeEach rejected by the ownership guard did not create this case.
    const state = casesByContext.get(context);
    if (state) await cleanupCase(state);
  }, 30_000);
  afterAll(async () => {
    await teardownEnvironment(activeCase);
  }, 15_000);

  it("dot goal keeps a wake arriving during activity, and separately exercises the real timeout", async () => {
    const release = deferred();
    stubs.dotGoalStep = async () => {
      if (count("dotGoalStep") === 1) { await release.promise; return { state: "WAITING", runId: null, goalStatus: "ACTIVE" }; }
      return { state: "DONE", runId: null, goalStatus: "COMPLETE" };
    };
    const handle = await start("dotGoalWorkflow", { goalId: "goal:synthetic" });
    await until(() => count("dotGoalStep") === 1, "first goal step");
    const before = await env.currentTimeMs();
    await handle.signal(DOT_GOAL_SIGNAL);
    release.resolve();
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETE" });
    expect((await env.currentTimeMs()) - before).toBeLessThan(30_000);
    await remember("dot-goal-wake", handle);

    let steps = 0;
    stubs.dotGoalStep = () => ++steps === 1
      ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETE" };
    const timeout = await start("dotGoalWorkflow", { goalId: "goal:timeout" });
    const timeoutStart = await env.currentTimeMs();
    expect(await timeout.result()).toEqual({ goalStatus: "COMPLETE" });
    expect((await env.currentTimeMs()) - timeoutStart).toBeGreaterThanOrEqual(30_000);
    expect((await timeout.fetchHistory()).events?.some((event) => event.timerFiredEventAttributes)).toBe(true);
  });

  it("dot goal continues as new after unfinished iterations instead of inventing completion", async () => {
    let firstRun: string | undefined;
    const resumed = deferred();
    stubs.dotGoalStep = async () => {
      const runId = calls.at(-1)!.runId;
      firstRun ??= runId;
      if (runId !== firstRun) { await resumed.promise; return { state: "DONE", runId: null, goalStatus: "COMPLETE" }; }
      return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
    };
    const handle = await start("dotGoalWorkflow", { goalId: "goal:unfinished" });
    // result() enables automatic time skipping; attach its rejection handler immediately.
    const result = autoResult(handle);
    const next = await continued(handle, (input) => input);
    expect(next.input).toEqual({ goalId: "goal:unfinished" });
    expect(calls.filter((call) => call.name === "dotGoalStep" && call.runId === firstRun)).toHaveLength(300);
    resumed.resolve();
    expect(await result).toEqual({ goalStatus: "COMPLETE" });
  }, 25_000);

  it("dummy turn retries a failed start activity and records actual scheduled activity results", async () => {
    const input = turn("dummy");
    const expected = dummyTurnResultSchema.parse({ workflowId: "workflow:dummy", roomId: input.roomId, paneId: input.paneId, traceId: input.traceId, status: "COMPLETED", message: "Synthetic output" });
    stubs.recordDummyTurnStarted = () => { if (count("recordDummyTurnStarted") === 1) throw new Error("Synthetic transient start"); };
    stubs.recordDummyTurnCompleted = () => expected;
    const handle = await start("dummyTurnWorkflow", input);
    expect(await handle.result()).toEqual(expected);
    expect(calls.filter((call) => call.name === "recordDummyTurnStarted").map((call) => call.attempt)).toEqual([1, 2]);
    expect(count("recordDummyTurnCompleted")).toBe(1);
    await remember("dummy-turn-retry", handle);
  });

  it.each([
    ["codex", null, false, "runCodexAppServerTurn"],
    ["native", null, true, "runCodexAppServerTurn"],
    ["opencode", "opencode", false, "runOpenCodeAgentTurn"],
    ["cli", "cli:claude", false, "runCliAgentTurn"]
  ] as const)("turn workflow dispatches %s in the sandbox", async (name, providerId, native, activity) => {
    const input = { ...turn(name), providerId, ...(native ? { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic" } : {}) };
    stubs[activity] = () => {
      if (name === "codex" && count(activity) === 1) throw new Error("Synthetic transient turn");
      return turnResult;
    };
    const handle = await start("codexAppServerTurnWorkflow", input);
    expect(await handle.result()).toEqual(turnResult);
    expect(count(activity)).toBe(name === "codex" ? 2 : 1);
    if (name === "codex") await remember("codex-turn-retry", handle);
  });

  it("background action persists exhausted failure, including the legacy action-id fallback", async () => {
    stubs.runRoomAgentBackgroundAction = () => { throw new Error("Synthetic exhausted action"); };
    stubs.failRoomAgentBackgroundAction = () => undefined;
    const handle = await start("roomAgentActionWorkflow", { bridge: { roomId: "room:action", missionId: "mission:action" }, traceId: "trace:action" }, "space-room-action:action:legacy");
    const failure = await handle.result().catch((error: unknown) => error) as WorkflowFailedError;
    expect(failure).toBeInstanceOf(WorkflowFailedError);
    expect(failure.cause).toBeInstanceOf(ActivityFailure);
    const activityFailure = failure.cause as ActivityFailure;
    expect(activityFailure.activityType).toBe("runRoomAgentBackgroundAction");
    expect(activityFailure.cause).toBeInstanceOf(ApplicationFailure);
    expect(activityFailure.cause).toMatchObject({ message: "Synthetic exhausted action", type: "Error" });
    expect(calls.filter((call) => call.name === "runRoomAgentBackgroundAction").map((call) => call.attempt)).toEqual([1, 2, 3, 4, 5]);
    expect(calls.find((call) => call.name === "failRoomAgentBackgroundAction")?.args[0]).toEqual({
      roomId: "room:action", missionId: "mission:action", actionId: "action:legacy", cancelled: false
    });
    await remember("room-action-failure", handle);
  });

  it("memory maintenance survives both optional failures and executes real consolidation as a child", async () => {
    const snapshot = memoryMaintenanceResultSchema.parse({ status: "REFRESHED", generatedAt: "2026-01-01T00:00:00.000Z", sourceHash: "a".repeat(64), previousSourceHash: null,
      summary: { sourceCount: 0, recordCount: 0, nodeCount: 0, edgeCount: 0, issueCount: 0 }, durationMs: 1 });
    stubs.refreshMemoryGraphSnapshot = () => snapshot;
    stubs.refreshAllMonthsMemoryGraphSnapshot = () => { throw new Error("Synthetic all-months failure"); };
    stubs.reconcileStaleSpaceAgentSessions = () => { throw new Error("Synthetic reconciliation failure"); };
    stubs.createScheduledMemoryAudit = () => ({ ...consolidationRun("run:maintenance"), workflowId: `consolidation-${serial}` });
    stubs.prepareMemoryConsolidation = () => ({ changeSetId: null, run: consolidationRun("run:maintenance") });
    const handle = await start("memoryMaintenanceWorkflow", { scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:maintenance" });
    expect(await handle.result()).toEqual(snapshot);
    expect(count("refreshAllMonthsMemoryGraphSnapshot")).toBe(3);
    expect(count("reconcileStaleSpaceAgentSessions")).toBe(3);
    expect(count("prepareMemoryConsolidation")).toBe(1);
    const history = await handle.fetchHistory();
    expect(history.events?.some((event) => event.startChildWorkflowExecutionInitiatedEventAttributes?.workflowType?.name === "memoryConsolidationWorkflow")).toBe(true);
    expect(history.events?.some((event) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
    await remember("memory-maintenance-child", handle);
  });

  it("memory consolidation retries mutation on its dedicated queue and finalizes its result", async () => {
    const mutation = memoryMutationWorkflowResultSchema.parse({ status: "APPLIED", changeSetId: "change:synthetic", resultingSourceHash: "b".repeat(64), reason: null });
    stubs.prepareMemoryConsolidation = () => ({ changeSetId: "change:synthetic", run: consolidationRun("run:synthetic") });
    stubs.executePersistedMemoryChangeSet = () => { if (count("executePersistedMemoryChangeSet") === 1) throw new Error("Synthetic transient mutation"); return mutation; };
    stubs.finalizeMemoryRepair = (input) => consolidationRun(input.runId);
    const handle = await start("memoryConsolidationWorkflow", { runId: "run:synthetic", traceId: "trace:consolidation" });
    expect(await handle.result()).toEqual(consolidationRun("run:synthetic"));
    expect(calls.filter((call) => call.name === "executePersistedMemoryChangeSet").map((call) => call.attempt)).toEqual([1, 2]);
    expect(calls.find((call) => call.name === "finalizeMemoryRepair")?.args[0].mutationResult).toEqual(mutation);
    await remember("memory-consolidation-change", handle);
  });

  it("memory mutation retries transient failure but propagates an exhausted failure", async () => {
    const mutation = memoryMutationWorkflowResultSchema.parse({ status: "APPLIED", changeSetId: "change:mutation", resultingSourceHash: "c".repeat(64), reason: null });
    stubs.executePersistedMemoryChangeSet = () => { if (count("executePersistedMemoryChangeSet") === 1) throw new Error("Synthetic mutation retry"); return mutation; };
    const handle = await start("memoryMutationWorkflow", { changeSetId: "change:mutation", traceId: "trace:mutation" });
    expect(await handle.result()).toEqual(mutation);
    expect(count("executePersistedMemoryChangeSet")).toBe(2);
    await remember("memory-mutation-retry", handle);
    stubs.executePersistedMemoryChangeSet = () => { throw new Error("Synthetic permanent mutation"); };
    const failed = await start("memoryMutationWorkflow", { changeSetId: "change:failed", traceId: "trace:failed" });
    await expect(failed.result()).rejects.toThrow();
    expect(calls.filter((call) => call.name === "executePersistedMemoryChangeSet" && call.workflowId === failed.workflowId).map((call) => call.attempt)).toEqual([1, 2, 3]);
  });

  // This driver retains the same synthetic in-memory store and activity logic
  // as the earlier regression tests, but signals/children/timers now run in Core.
  function continuationDriver() {
    const c = continuationFixture();
    stubs.prepareRoomAgentBackgroundContinuation = (input) => prepareBackgroundContinuation(input, c.store);
    stubs.checkRoomAgentSupervisorTurn = (queued) => supervisorTurnState(queued, c.store);
    stubs.discardRoomAgentSupervisorTurn = ({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, c.store, errorCode);
    stubs.finishRoomAgentSupervisorTurn = (input) => finishSupervisorTurn(input, c.store);
    stubs.runCodexAppServerTurn = (input) => { c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" }); return turnResult; };
    return c;
  }

  it("current supervisor runs allocation, send and verification in one mission", async () => {
    const c = continuationDriver();
    let children = 0;
    stubs.runCodexAppServerTurn = (input) => {
      children++;
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      if (children !== 1) return turnResult;
      expect(input.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      return { ...turnResult, roomAgentOutcome: { ...turnResult.roomAgentOutcome, pendingActionIds: ["action:send"] } };
    };
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }));
    await env.sleep("3 seconds");
    await until(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED", "verified mission completion");
    expect(children).toBe(2);
    expect(c.store.listRoomAgentActions(c.initial.mission.id).filter((action) => action.actionType === "SEND")).toHaveLength(1);
    expect(count("finishRoomAgentSupervisorTurn")).toBe(1);
    await stop(handle);
  });

  it.each([
    ["a serialized plain error", () => new Error("Synthetic supervisor child failure"), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["a serialized SDK timeout cause", () => ApplicationFailure.create({
      message: "Synthetic activity failure with timeout cause", type: "Error", nonRetryable: true,
      cause: new TimeoutFailure("Synthetic timeout cause", undefined, TimeoutType.START_TO_CLOSE)
    }), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["a serialized application failure type", () => ApplicationFailure.nonRetryable("Synthetic typed child failure", "CODEX_APP_SERVER_TURN_TIMEOUT"), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ] as const)("current supervisor records %s as FAILED with its cause code", async (_, makeError, code) => {
    const c = continuationDriver();
    stubs.runCodexAppServerTurn = () => { throw makeError(); };
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id]
    }));
    // Keep the real server's automatic time skipping active across activity
    // retry backoffs. The idle supervisor is terminated after the assertions.
    autoResult(handle);
    await until(() => calls.some((call) => call.name === "finishRoomAgentSupervisorTurn" && call.args[0].status === "FAILED"), "failed supervisor turn persistence");
    const childCall = calls.find((call) => call.name === "runCodexAppServerTurn")!;
    const runId = childCall.args[0].agentRunId;
    expect(c.store.getRoomAgentTurn(c.initial.mission.id, runId)?.run).toMatchObject({ status: "FAILED", errorCode: code });
    expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
    expect(calls.find((call) => call.name === "finishRoomAgentSupervisorTurn")?.args[0]).toMatchObject({ status: "FAILED", errorCode: code });
    // Only the activity body is stubbed. Its SDK failure travels through the
    // real activity -> child -> supervisor boundary; it is not a fabricated
    // ChildWorkflowFailure object. An ApplicationFailure preserves the injected
    // TimeoutFailure cause (an activity throwing TimeoutFailure directly is
    // converted to an ApplicationFailure by the SDK). This tests classification
    // of the transported cause, not the expiry of a server deadline.
    const history = await handle.fetchHistory();
    const childFailure = history.events?.find((event) => event.childWorkflowExecutionFailedEventAttributes)?.childWorkflowExecutionFailedEventAttributes?.failure;
    expect(childFailure?.activityFailureInfo).toBeDefined();
    if (code === "ROOM_AGENT_SUPERVISOR_TIMEOUT") {
      expect(childFailure?.cause?.cause?.timeoutFailureInfo?.timeoutType).toBe(temporal.api.enums.v1.TimeoutType.TIMEOUT_TYPE_START_TO_CLOSE);
    } else {
      expect(childFailure?.cause?.applicationFailureInfo?.type).toBe(code === "ROOM_AGENT_SUPERVISOR_FAILED" ? "Error" : code);
    }
    await stop(handle);
  }, 25_000);

  it.each(["stop", "follow-up"])("current supervisor retires a prepared continuation when %s wins the race", async (kind) => {
    const c = continuationDriver();
    let handle!: Handle;
    let preparedRunId = "";
    stubs.prepareRoomAgentBackgroundContinuation = async (input) => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY" && !preparedRunId) {
        preparedRunId = result.item.turn.agentRunId!;
        if (kind === "stop") {
          c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
          await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic operator stop" });
        } else {
          const followUp = c.enqueue("follow-up", "Only inspect the room.");
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
        }
      }
      return result;
    };
    handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }));
    await env.sleep("2 seconds");
    await until(() => Boolean(preparedRunId) && c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status === "INTERRUPTED", "retirement of stale prepared run");
    if (kind === "stop") expect(count("runCodexAppServerTurn")).toBe(0);
    else {
      await until(() => count("runCodexAppServerTurn") === 1, "operator follow-up child");
      expect(calls.find((call) => call.name === "runCodexAppServerTurn")?.args[0].roomAgentOperatorRequest).toBe("Only inspect the room.");
    }
    await stop(handle);
  });

  it("current supervisor carries a prepared continuation across continue-as-new and starts it once", async () => {
    const c = continuationDriver();
    const release = deferred();
    stubs.checkRoomAgentSupervisorTurn = async (queued) => { await release.promise; return supervisorTurnState(queued, c.store); };
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id], processedCount: 50 }));
    await env.sleep("1 second");
    const next = await continued(handle, supervisorContinuationInput);
    expect(next.input.pending).toHaveLength(1);
    expect(next.input.monitoringMissionIds).toEqual([c.initial.mission.id]);
    expect(next.input.processedCount).toBe(0);
    expect(count("runCodexAppServerTurn")).toBe(0);
    await remember("supervisor-current-continuation", next.pinned as Handle);
    release.resolve();
    await until(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED", "continued mission completion");
    expect(count("runCodexAppServerTurn")).toBe(1);
    await stop(handle);
  });

  it("current supervisor drains an overfull carried queue to 100 without dropping turns", async () => {
    const firstCheck = deferred();
    const nextRun = deferred();
    let originalRun: string | undefined;
    stubs.checkRoomAgentSupervisorTurn = async () => {
      const run = calls.at(-1)!.runId;
      originalRun ??= run;
      if (run !== originalRun) await nextRun.promise;
      else if (count("checkRoomAgentSupervisorTurn") === 1) await firstCheck.promise;
      return "SKIP";
    };
    stubs.discardRoomAgentSupervisorTurn = () => undefined;
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", pending: [item("flood-0")], processedCount: 49 }));
    await until(() => count("checkRoomAgentSupervisorTurn") === 1, "first gated turn");
    for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(`flood-${index}`));
    firstCheck.resolve();
    const next = await continued(handle, supervisorContinuationInput);
    expect(next.input.pending).toHaveLength(100);
    expect(() => roomAgentSupervisorInputSchema.parse(next.input)).not.toThrow();
    expect(calls.filter((call) => call.name === "checkRoomAgentSupervisorTurn" && call.runId === originalRun)).toHaveLength(6);
    const drained = calls.filter((call) => call.name === "discardRoomAgentSupervisorTurn").map((call) => call.args[0].item.turn.agentRunId);
    expect(new Set([...drained, ...next.input.pending!.map((queued) => queued.turn.agentRunId)]).size).toBe(106);
    nextRun.resolve();
    await stop(handle);
  }, 25_000);

  it.each(["current", "legacy"])("%s supervisor accepts enqueue and stop, and interrupts a running child", async (branch) => {
    const entered = deferred();
    const activityExited = deferred();
    let cancellationObserved = false;
    stubs.checkRoomAgentSupervisorTurn = () => "READY";
    stubs.markRoomAgentMissionStarted = () => undefined;
    stubs.discardRoomAgentSupervisorTurn = () => undefined;
    stubs.finishRoomAgentSupervisorTurn = () => undefined;
    stubs.markRoomAgentMissionFinished = () => undefined;
    stubs.runCodexAppServerTurn = async () => {
      entered.resolve();
      const context = Context.current();
      const cleanup = deferred();
      const heartbeat = setInterval(() => context.heartbeat(), 5);
      // A failed assertion or terminated parent must also release the stub;
      // termination alone does not guarantee a cancellation acknowledgement.
      try {
        await Promise.race([context.cancelled.catch((error) => {
          cancellationObserved = true;
          throw error;
        }), cleanup.promise]);
      } finally {
        clearInterval(heartbeat);
        activityExited.resolve();
      }
    };
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic" }), `${branch}-signals`);
    const queued = item(`interrupt-${branch}`);
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued);
    await entered.promise;
    // Activity observes cancellation through a heartbeat; the production timeout
    // is left untouched. The real child cancellation then unblocks its parent.
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: queued.missionId, reason: "Synthetic stop" });
    const finished = branch === "legacy" ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn";
    await until(() => calls.some((call) => call.name === finished && call.args[0].status === "INTERRUPTED"), "recorded child interruption");
    expect(calls.find((call) => call.name === finished)?.args[0].statusReason).toBe("Synthetic stop");
    // Before afterEach may release any cleanup gate, prove that the SDK really
    // delivered cancellation and that the local stub left its finally block.
    await activityExited.promise;
    expect(cancellationObserved).toBe(true);
    await stop(handle);
  }, 25_000);

  it.each(["current", "legacy"])("%s supervisor continues after 250 real one-second polls and preserves monitoring", async (branch) => {
    let originalRun: string | undefined;
    const nextRun = deferred();
    const poll = async () => {
      const run = calls.at(-1)!.runId;
      originalRun ??= run;
      if (run !== originalRun) await nextRun.promise;
      return branch === "legacy" ? false : { state: "WAITING" };
    };
    stubs.prepareRoomAgentBackgroundContinuation = poll;
    stubs.settleRoomAgentBackgroundMission = poll;
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", monitoringMissionIds: ["mission:poll"], processedCount: 7 }), `${branch}-polls`);
    const name = branch === "legacy" ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
    const next = await closedContinuation(handle);
    expect(next.input.monitoringMissionIds).toEqual(["mission:poll"]);
    expect(next.input.pending).toEqual([]);
    expect(next.input.processedCount).toBe(branch === "legacy" ? 7 : 0);
    expect(calls.filter((call) => call.name === name && call.runId === handle.firstExecutionRunId)).toHaveLength(250);
    const timerEvents = next.history.events?.flatMap((event) =>
      event.timerStartedEventAttributes ? [event.timerStartedEventAttributes] : []) ?? [];
    expect(timerEvents).toHaveLength(250);
    for (const timer of timerEvents) {
      expect(timer.startToFireTimeout?.seconds?.toString()).toBe("1");
      expect(timer.startToFireTimeout?.nanos ?? 0).toBe(0);
    }
    if (branch === "legacy") {
      expect(count("prepareRoomAgentBackgroundContinuation")).toBe(0);
      await remember("supervisor-legacy-continuation", next.pinned as Handle);
    }
    await stop(handle);
    nextRun.resolve();
  }, 30_000);

  it("legacy supervisor removes a mission when the real boolean settle activity returns true", async () => {
    stubs.settleRoomAgentBackgroundMission = () => true;
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({
      roomId: "room:synthetic", monitoringMissionIds: ["mission:settled"]
    }), "legacy-settle-true");
    await until(async () => (await handle.fetchHistory()).events?.some((event) => Boolean(event.timerStartedEventAttributes)) ?? false, "first legacy polling timer");
    await env.sleep("1 second");
    await until(() => count("settleRoomAgentBackgroundMission") === 1, "settle true activity");
    await env.sleep("3 seconds");
    expect(count("settleRoomAgentBackgroundMission")).toBe(1);
    expect(count("prepareRoomAgentBackgroundContinuation")).toBe(0);
    expect((await handle.fetchHistory()).events?.some((event) => event.workflowExecutionContinuedAsNewEventAttributes)).toBe(false);
    await stop(handle);
  });

  it("current supervisor uses a real one-second pause before retrying a paused turn", async () => {
    stubs.checkRoomAgentSupervisorTurn = () => count("checkRoomAgentSupervisorTurn") === 1 ? "PAUSED" : "SKIP";
    stubs.discardRoomAgentSupervisorTurn = () => undefined;
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", pending: [item("paused")] }));
    let timer: any;
    await until(async () => {
      timer = (await handle.fetchHistory()).events?.find((event) => event.timerStartedEventAttributes)?.timerStartedEventAttributes;
      return Boolean(timer);
    }, "paused condition timer");
    expect(count("checkRoomAgentSupervisorTurn")).toBe(1);
    expect(timer.startToFireTimeout.seconds.toString()).toBe("1");
    expect(timer.startToFireTimeout.nanos ?? 0).toBe(0);
    await env.sleep("1 second");
    await until(() => count("discardRoomAgentSupervisorTurn") === 1, "paused turn retry");
    expect(count("checkRoomAgentSupervisorTurn")).toBe(2);
    expect(count("runCodexAppServerTurn")).toBe(0);
    await stop(handle);
  });

  it("legacy supervisor carries pending work and monitoring after 50 processed items", async () => {
    const pauseNewRun = deferred();
    let firstRun: string | undefined;
    stubs.markRoomAgentMissionStarted = () => undefined;
    stubs.markRoomAgentMissionFinished = () => undefined;
    stubs.markRoomAgentMissionContinued = () => undefined;
    stubs.runCodexAppServerTurn = async () => {
      const run = calls.at(-1)!.runId;
      firstRun ??= run;
      if (count("runCodexAppServerTurn") > 1) await pauseNewRun.promise;
      return turnResult;
    };
    const a = item("legacy-first"), b = item("legacy-second");
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", pending: [a, b], monitoringMissionIds: ["mission:other"], processedCount: 49 }), "legacy-50");
    const next = await continued(handle, supervisorContinuationInput);
    expect(next.input.pending).toEqual([b]);
    expect(next.input.monitoringMissionIds).toEqual(["mission:other"]);
    expect(next.input.processedCount).toBe(0);
    pauseNewRun.resolve();
    await stop(handle);
  });

  it("current supervisor preserves interrupted work in the next run instead of dropping it", async () => {
    const gate = deferred();
    let originalRun: string | undefined;
    stubs.discardRoomAgentSupervisorTurn = async () => {
      const run = calls.at(-1)!.runId;
      originalRun ??= run;
      if (run !== originalRun) await gate.promise;
    };
    stubs.finishRoomAgentSupervisorTurn = () => undefined;
    const a = { item: item("interrupted-a"), reason: "Synthetic interrupted A" };
    const b = { item: item("interrupted-b"), reason: "Synthetic interrupted B" };
    const handle = await start("roomAgentSupervisorWorkflow", roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", interrupted: [a, b], processedCount: 49 }));
    const next = await continued(handle, supervisorContinuationInput);
    expect(next.input.interrupted).toEqual([b]);
    expect(next.input.processedCount).toBe(0);
    gate.resolve();
    await stop(handle);
  });

  it("all committed synthetic histories replay against the current production workflow bundle", async () => {
    const present = (await readdir(historiesDir)).filter((name) => name.endsWith(".json")).sort();
    expect(present).toEqual(historyNames.map((name) => `${name}.json`).sort());
    const histories = await Promise.all(present.map(async (name) => {
      const artifact = JSON.parse(await readFile(`${historiesDir}/${name}`, "utf8"));
      // Public protobuf construction avoids protojson Type-identity coupling
      // when npm resolves multiple protobufjs copies. Command bytes are intact.
      return { ...artifact, history: temporal.api.history.v1.History.fromObject(artifact.history), file: name };
    }));
    const byId = new Map(histories.map((artifact) => [artifact.workflowId, artifact.file]));
    let results = 0;
    for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) {
      results++;
      expect(result.error, `${byId.get(result.workflowId)} (${result.workflowId}): recorded history is not replay-compatible`).toBeUndefined();
    }
    expect(results).toBe(historyNames.length);
  }, 30_000);

  it("an extra test-only timer produces a determinism error naming the workflow and fixture", async () => {
    const name = "dot-goal-wake.json";
    const { history, workflowId } = JSON.parse(await readFile(`${historiesDir}/${name}`, "utf8"));
    const results = [];
    for await (const result of Worker.runReplayHistories({
      workflowsPath: fileURLToPath(new URL("./support/temporal-nondeterministic-workflows.ts", import.meta.url))
    }, [{ workflowId, history: temporal.api.history.v1.History.fromObject(history) }])) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]!.workflowId).toBe(workflowId);
    expect(results[0]!.error, `${name} (dotGoalWorkflow, ${workflowId})`).toBeInstanceOf(DeterminismViolationError);
  }, 30_000);
});
