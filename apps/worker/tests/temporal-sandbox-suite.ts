import { afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { temporal } from "@temporalio/proto";
import { defaultPayloadConverter } from "@temporalio/common";
import { DOT_GOAL_SIGNAL, MEMORY_MUTATION_TASK_QUEUE, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema } from "@space/contracts";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { Context } from "@temporalio/activity";
import { ApplicationFailure, TimeoutFailure, TimeoutType } from "@temporalio/common";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";

const turn = { roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic test", artifactIds: [],
  agentRunId: "agent_run:synthetic", permissionMode: null, collaborationMode: "default", traceId: "trace:synthetic" };
const completed = { status: "COMPLETED", message: "Synthetic completion" };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 20_000);
  })]); } finally { clearTimeout(timer!); }
}

export function registerTemporalSandboxSuite(group: "core" | "supervisor-rollover" | "supervisor-races") {
describe("real Temporal sandbox", () => {
  let env: TestWorkflowEnvironment;
  let bundle: { codePath: string };
  let sequence = 0;
  let legacyBundle: typeof bundle;
  async function record(handle: any, name: string) {
    if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES !== "1") return;
    const history = await handle.fetchHistory();
    const directory = process.env.SPACE_TEMPORAL_HISTORY_DIRECTORY;
    if (!directory) throw new Error("Use temporal:record-histories to choose a staging directory");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${name}.json`), JSON.stringify({
      workflowId: handle.workflowId,
      history: temporal.api.history.v1.History.toObject(history, { longs: String, enums: String, bytes: String })
    }, (key, value) => key === "stackTrace" ? "" : key === "identity" ? "synthetic-test-worker" : value, 2) + "\n");
  }
  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    const paths = inject("temporalBundles");
    bundle = { codePath: paths.current };
    legacyBundle = { codePath: paths.legacy };
  }, 120_000);
  // Time skipping is server-global. A continued run can briefly have an in-flight
  // task during termination; never let that execution hold another test's clock.
  let serverGeneration = 0;
  let activeEnvironment: TestWorkflowEnvironment | undefined;
  beforeEach(async () => {
    const generation = ++serverGeneration;
    const candidate = await TestWorkflowEnvironment.createTimeSkipping({
      server: { executable: { type: "existing-path", path: inject("temporalTestServerPath") } }
    });
    // A timed-out setup promise cannot install its server into a later test.
    // Dispose late arrivals instead of contaminating that test's global clock.
    if (generation !== serverGeneration) {
      await candidate.teardown();
      throw new Error("Temporal server became ready after its test had already ended");
    }
    activeEnvironment = env = candidate;
  }, 60_000);
  afterEach(async () => {
    ++serverGeneration;
    const candidate = activeEnvironment;
    activeEnvironment = undefined;
    await candidate?.teardown();
  }, 30_000);

  async function run(type: string, input: unknown, activities: Record<string, (...args: any[]) => any>, workflowId?: string) {
    const taskQueue = `sandbox-${++sequence}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities });
    return worker.runUntil(async () => {
      const handle = await env.client.workflow.start(type, { taskQueue, workflowId: workflowId ?? `${type}-${sequence}`, args: [input] });
      try { return await handle.result(); }
      finally { await record(handle, type); }
    });
  }

  async function supervise(input: unknown, activities: Record<string, (...args: any[]) => any>,
    body: (handle: any) => Promise<void>, legacy = false) {
    const taskQueue = `signals-${++sequence}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowBundle: legacy ? legacyBundle : bundle, activities });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: `supervisor-signals-${sequence}`, args: [roomAgentSupervisorInputSchema.parse(input)]
      });
      // Awaiting result enables time skipping while the scenario drives signals.
      // Terminate this otherwise durable supervisor only after the assertions.
      const result = handle.result().then(() => null, error => error);
      try { await bounded(body(handle), "supervisor scenario"); }
      finally {
        await handle.terminate("Synthetic test complete");
        await bounded(result, "supervisor termination");
        const scenario = expect.getState().currentTestName!.replace(/[^a-zA-Z0-9]+/g, "-").slice(-160);
        await record(handle, `roomAgentSupervisorWorkflow-${legacy ? "legacy" : "current"}-${scenario}`);
      }
    });
  }

  function continuationDriver() {
    const c = continuationFixture();
    const finished = deferred<any>();
    const prepared: any[] = [];
    const activities = {
      prepareRoomAgentBackgroundContinuation: vi.fn(async input => {
        const result = await prepareBackgroundContinuation(input, c.store);
        if (result.state === "READY") prepared.push(result.item);
        return result;
      }),
      checkRoomAgentSupervisorTurn: vi.fn(item => supervisorTurnState(item, c.store)),
      discardRoomAgentSupervisorTurn: vi.fn(({ item, reason, errorCode }) => discardSupervisorTurn(item, reason, c.store, errorCode)),
      finishRoomAgentSupervisorTurn: vi.fn(async input => { await finishSupervisorTurn(input, c.store); finished.resolve(input); }),
      runCodexAppServerTurn: vi.fn(async turn => {
        c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
        return { status: "COMPLETED", message: "Verified", roomAgentOutcome: {
          status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." } };
      })
    };
    return { ...c, activities, finished, prepared,
      workflowInput: { roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] } };
  }

  if (group === "core") {
  it("runs the dummy turn and retries a transient activity failure", async () => {
    const attempts: number[] = [];
    let started = false;
    expect(await run("dummyTurnWorkflow", turn, {
      recordDummyTurnStarted: () => { started = true; },
      recordDummyTurnCompleted: () => {
        expect(started).toBe(true);
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt === 1) throw ApplicationFailure.retryable("synthetic", "SYNTHETIC_RETRY");
        return completed;
      }
    })).toEqual(completed);
    expect(attempts).toEqual([1, 2]);
  }, 30_000);

  it("executes the actual turn workflow through its native activity", async () => {
    const attempts: number[] = [];
    expect(await run("codexAppServerTurnWorkflow", turn, {
      runCodexAppServerTurn: () => {
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt < 2) throw ApplicationFailure.retryable("Synthetic transient turn failure", "SYNTHETIC_RETRY");
        return completed;
      }
    })).toEqual(completed);
    expect(attempts).toEqual([1, 2]);
  }, 30_000);

  it("time-skips the goal timeout and observes its child turn before completion", async () => {
    let steps = 0;
    let observations = 0;
    const start = await env.currentTimeMs();
    expect(await run("dotGoalWorkflow", { goalId: "goal:synthetic" }, {
      dotGoalStep: () => ++steps === 1
        ? { state: "RUNNING", runId: "run:synthetic", goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" },
      dotGoalObserve: () => { observations++; return { run: "COMPLETED", goalStatus: "RUNNING" }; }
    })).toEqual({ goalStatus: "COMPLETED" });
    expect(steps).toBe(2);
    expect(observations).toBe(1);
    expect(await env.currentTimeMs() - start).toBeGreaterThanOrEqual(15_000);
  }, 30_000);

  it("persists background action failure after activity retries are exhausted", async () => {
    const failures: unknown[] = [];
    const attempts: number[] = [];
    await expect(run("roomAgentActionWorkflow", {
      bridge: { roomId: turn.roomId, missionId: "mission:synthetic" }, actionId: "action:synthetic", traceId: turn.traceId
    }, {
      runRoomAgentBackgroundAction: () => {
        attempts.push(Context.current().info.attempt);
        throw ApplicationFailure.retryable("synthetic", "SYNTHETIC_FAILURE");
      },
      failRoomAgentBackgroundAction: (input) => { failures.push(input); }
    })).rejects.toThrow();
    expect(failures).toEqual([{ roomId: turn.roomId, missionId: "mission:synthetic", actionId: "action:synthetic", cancelled: false }]);
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
  }, 30_000);

  it("retries persisted memory mutation", async () => {
    const attempts: number[] = [];
    const result = { changeSetId: "change:synthetic", status: "APPLIED" };
    expect(await run("memoryMutationWorkflow", { changeSetId: "change:synthetic", traceId: turn.traceId }, {
      executePersistedMemoryChangeSet: () => {
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt < 3) throw ApplicationFailure.retryable("synthetic", "SYNTHETIC_RETRY");
        return result;
      }
    })).toEqual(result);
    expect(attempts).toEqual([1, 2, 3]);
  }, 30_000);

  it("derives a missing background action ID from the legacy workflow ID", async () => {
    const failed = vi.fn();
    await expect(run("roomAgentActionWorkflow", {
      bridge: { roomId: turn.roomId, missionId: "mission:synthetic" }, traceId: turn.traceId
    }, {
      runRoomAgentBackgroundAction: () => { throw ApplicationFailure.nonRetryable("Synthetic failure"); },
      failRoomAgentBackgroundAction: failed
    }, "space-room-action:action:legacy")).rejects.toThrow();
    expect(failed).toHaveBeenCalledExactlyOnceWith({ roomId: turn.roomId, missionId: "mission:synthetic", actionId: "action:legacy", cancelled: false });
  }, 30_000);

  it("returns a consolidation run with no changes", async () => {
    const result = { id: "audit:synthetic", status: "COMPLETED" };
    expect(await run("memoryConsolidationWorkflow", { runId: result.id }, {
      prepareMemoryConsolidation: () => ({ changeSetId: null, run: result })
    })).toEqual(result);
  }, 30_000);

  it("routes a consolidation change set to the mutation queue, retries and finalizes it", async () => {
    const attempts: number[] = [];
    const mutationResult = { changeSetId: "change:consolidation", status: "APPLIED" };
    const final = { id: "audit:consolidation", status: "COMPLETED" };
    const mutationWorker = await Worker.create({ connection: env.nativeConnection,
      taskQueue: MEMORY_MUTATION_TASK_QUEUE, activities: {
        executePersistedMemoryChangeSet: (input) => {
          expect(input).toEqual({ changeSetId: mutationResult.changeSetId, traceId: turn.traceId });
          const attempt = Context.current().info.attempt;
          attempts.push(attempt);
          if (attempt < 2) throw ApplicationFailure.retryable("Synthetic transient mutation", "SYNTHETIC_RETRY");
          return mutationResult;
        }
      } });
    await mutationWorker.runUntil(async () => {
      expect(await run("memoryConsolidationWorkflow", { runId: final.id, traceId: turn.traceId }, {
        prepareMemoryConsolidation: () => ({ changeSetId: mutationResult.changeSetId, run: final }),
        finalizeMemoryRepair: input => {
          expect(input).toEqual({ runId: final.id, changeSetId: mutationResult.changeSetId, mutationResult });
          return final;
        }
      })).toEqual(final);
    });
    expect(attempts).toEqual([1, 2]);
  }, 30_000);

  it("keeps maintenance running after optional failures and executes a consolidation child", async () => {
    const attempts = { refresh: 0, reconcile: 0, prepare: 0 };
    const result = { sourceHash: "synthetic-hash", status: "COMPLETED" };
    const childWorker = await Worker.create({ connection: env.nativeConnection,
      taskQueue: "space-memory-maintenance", workflowBundle: bundle, activities: {
        prepareMemoryConsolidation: () => { attempts.prepare++; return { changeSetId: null, run: { id: "audit:child" } }; }
      } });
    await childWorker.runUntil(async () => {
      expect(await run("memoryMaintenanceWorkflow", { traceId: turn.traceId }, {
        refreshMemoryGraphSnapshot: () => result,
        refreshAllMonthsMemoryGraphSnapshot: () => { attempts.refresh++; throw new Error("synthetic refresh failure"); },
        reconcileStaleSpaceAgentSessions: () => { attempts.reconcile++; throw new Error("synthetic reconciliation failure"); },
        createScheduledMemoryAudit: () => ({ id: "audit:child", workflowId: "consolidation:child" })
      })).toEqual(result);
    });
    expect(attempts).toEqual({ refresh: 3, reconcile: 3, prepare: 1 });
  }, 30_000);

  it("retains a wake signal arriving during a goal activity instead of waiting an hour", async () => {
    const taskQueue = `wake-${++sequence}`;
    let handle: any;
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    let steps = 0;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
      activities: { dotGoalStep: async () => {
        if (++steps > 1) return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
        await ready;
        await handle.signal(DOT_GOAL_SIGNAL);
        return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
      } } });
    await worker.runUntil(async () => {
      handle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue, workflowId: `goal-wake-${sequence}`, args: [{ goalId: "goal:wake" }]
      });
      release();
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const history = await handle.fetchHistory();
      expect(history.events.some((event: any) => event.timerFiredEventAttributes)).toBe(false);
      await record(handle, "dotGoalWorkflow-wake");
    });
  }, 30_000);

  it("continues an unfinished goal as a new run after 300 iterations", async () => {
    let steps = 0;
    const taskQueue = `goal-continue-${++sequence}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle,
      activities: { dotGoalStep: () => ++steps <= 300
        ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" } } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        taskQueue, workflowId: `goal-continue-${sequence}`, args: [{ goalId: "goal:continue" }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await first.fetchHistory();
      const continued = history.events.find((event: any) => event.workflowExecutionContinuedAsNewEventAttributes);
      expect(continued).toBeDefined();
      expect(defaultPayloadConverter.fromPayload(continued!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!))
        .toEqual({ goalId: "goal:continue" });
      expect(steps).toBe(301);
      await record(first, "dotGoalWorkflow-continue");
    });
  }, 60_000);

  }
  if (group === "supervisor-rollover") {
  it.each([false, true])("supervisor preserves pending and monitored missions at 50 items (legacy=%s)", async legacy => {
    const taskQueue = `supervisor-items-${++sequence}`;
    const item = (index: number) => ({ missionId: `mission:${index}`, turn: { ...turn, agentRunId: `agent_run:${index}` } });
    const input = roomAgentSupervisorInputSchema.parse({ roomId: turn.roomId,
      pending: [item(0), item(1)], monitoringMissionIds: ["mission:monitor"], processedCount: 49 });
    const executedRuns: string[] = [];
    const successorStarted = deferred();
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowBundle: legacy ? legacyBundle : bundle, activities: {
        checkRoomAgentSupervisorTurn: () => "RUN",
        markRoomAgentMissionStarted: () => undefined,
        markRoomAgentMissionFinished: () => undefined,
        finishRoomAgentSupervisorTurn: () => undefined,
        runCodexAppServerTurn: (input) => {
          executedRuns.push(input.agentRunId);
          if (executedRuns.length === 2) successorStarted.resolve();
          return completed;
        },
        prepareRoomAgentBackgroundContinuation: () => ({ state: "WAITING" }),
        settleRoomAgentBackgroundMission: () => false
      } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: `supervisor-items-${sequence}`, args: [input], followRuns: false
      });
      try {
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
        const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        const history = await first.fetchHistory();
        const continued = history.events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)!;
        const carried = defaultPayloadConverter.fromPayload(continued.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!);
        expect(carried).toEqual({ roomId: turn.roomId, pending: [input.pending[1]],
          monitoringMissionIds: ["mission:monitor"], interrupted: [], processedCount: 0 });
        const nextRunId = continued.workflowExecutionContinuedAsNewEventAttributes!.newExecutionRunId!;
        const successor = env.client.workflow.getHandle(handle.workflowId, nextRunId);
        await bounded(successorStarted.promise, "the carried turn starting in the successor run");
        expect(executedRuns).toEqual([input.pending[0].turn.agentRunId, input.pending[1].turn.agentRunId]);
        const successorHistory = await successor.fetchHistory();
        const started = successorHistory.events[0]!.workflowExecutionStartedEventAttributes!;
        expect(started.continuedExecutionRunId).toBe(handle.firstExecutionRunId);
        expect(defaultPayloadConverter.fromPayload(started.input!.payloads![0]!)).toEqual(carried);
        expect(successorHistory.events.filter((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(1);
        await record(first, `roomAgentSupervisorWorkflow-${legacy ? "legacy" : "current"}-items`);
      } finally { await env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test complete"); }
    });
  }, 30_000);

  it.each([false, true])("supervisor continues after 250 one-second polls (legacy=%s)", async legacy => {
    const taskQueue = `supervisor-polls-${++sequence}`;
    const input = roomAgentSupervisorInputSchema.parse({ roomId: turn.roomId, monitoringMissionIds: ["mission:monitor"], processedCount: 7 });
    const counts = new Map<string, number>();
    let firstRunId: string;
    const successorPolled = deferred<{ runId: string; input: unknown }>();
    function count(input: unknown) {
      const id = Context.current().info.workflowExecution.runId;
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (firstRunId && id !== firstRunId) successorPolled.resolve({ runId: id, input });
    }
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue,
      workflowBundle: legacy ? legacyBundle : bundle, activities: {
        prepareRoomAgentBackgroundContinuation: (input) => { count(input); return { state: "WAITING" }; },
        settleRoomAgentBackgroundMission: (input) => { count(input); return false; }
      } });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: `supervisor-polls-${sequence}`, args: [input], followRuns: false
      });
      firstRunId = handle.firstExecutionRunId;
      let successorResult: Promise<unknown> | undefined;
      try {
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
        const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        const history = await first.fetchHistory();
        expect(counts.get(handle.firstExecutionRunId)).toBe(250);
        expect(history.events.filter((e: any) => e.timerFiredEventAttributes)).toHaveLength(250);
        const continued = history.events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)!;
        expect(defaultPayloadConverter.fromPayload(continued.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!))
          .toEqual({ ...input, processedCount: legacy ? 7 : 0 });
        const nextRunId = continued.workflowExecutionContinuedAsNewEventAttributes!.newExecutionRunId!;
        const successor = env.client.workflow.getHandle(handle.workflowId, nextRunId);
        successorResult = successor.result().catch(error => error);
        const observed = await bounded(successorPolled.promise, "the carried monitored mission being polled in the successor run");
        expect(observed.runId).toBe(nextRunId);
        expect(observed.input).toMatchObject({ roomId: input.roomId, missionId: "mission:monitor" });
        const successorHistory = await successor.fetchHistory();
        expect(defaultPayloadConverter.fromPayload(successorHistory.events[0]!.workflowExecutionStartedEventAttributes!.input!.payloads![0]!))
          .toEqual({ ...input, processedCount: legacy ? 7 : 0 });
        await record(first, `roomAgentSupervisorWorkflow-${legacy ? "legacy" : "current"}-polls`);
      } finally {
        await env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test complete");
        if (successorResult) await bounded(successorResult, "successor test cleanup");
      }
    });
  }, 60_000);

  it.each([false, true])("enqueues a mission, ignores invalid signals and interrupts its running child (legacy=%s)", async legacy => {
    const running = deferred();
    const finished = deferred<any>();
    const started: any[] = [];
    const item = { missionId: "mission:signals", turn: { ...turn, agentRunId: "agent_run:signals" } };
    await supervise({ roomId: turn.roomId }, {
      checkRoomAgentSupervisorTurn: (input) => { started.push(input); return "RUN"; },
      markRoomAgentMissionStarted: (input) => { started.push(input); },
      runCodexAppServerTurn: async () => {
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 10);
        running.resolve();
        try { await context.cancelled; }
        finally { clearInterval(heartbeat); }
      },
      discardRoomAgentSupervisorTurn: () => undefined,
      finishRoomAgentSupervisorTurn: (input) => { finished.resolve(input); },
      markRoomAgentMissionFinished: (input) => { finished.resolve(input); }
    }, async handle => {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { invalid: true });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...item, turn: { ...item.turn, roomId: "room:wrong" } });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { invalid: true });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
      await running.promise;
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: item.missionId, reason: "Synthetic operator stop" });
      expect(await finished.promise).toMatchObject({ status: "INTERRUPTED", statusReason: "Synthetic operator stop" });
      expect(started).toHaveLength(1);
    }, legacy);
  }, 40_000);

  it("defers continue-as-new until all 105 enqueued turns fit the carried input bounds", async () => {
    const taskQueue = `bounds-${++sequence}`;
    const item = (index: number) => ({ missionId: "mission:bounds", turn: { ...turn, agentRunId: `agent_run:bounds-${index}` } });
    let handle: any;
    const handleReady = deferred();
    let checks = 0;
    const runCounts = new Map<string, number>();
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities: {
      checkRoomAgentSupervisorTurn: async () => {
        const runId = Context.current().info.workflowExecution.runId;
        runCounts.set(runId, (runCounts.get(runId) ?? 0) + 1);
        if (++checks === 1) {
          await handleReady.promise;
          for (let i = 1; i <= 105; i++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(i));
        }
        return "SKIP";
      },
      discardRoomAgentSupervisorTurn: () => undefined
    } });
    await worker.runUntil(async () => {
      handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue,
        workflowId: `supervisor-bounds-${sequence}`, followRuns: false,
        args: [roomAgentSupervisorInputSchema.parse({ roomId: turn.roomId, pending: [item(0)], processedCount: 49 })] });
      handleReady.resolve();
      try {
        await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
        const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
        const history = await first.fetchHistory();
        const continued = history.events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)!;
        const carried = roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(
          continued.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
        expect(carried.pending.map(item => item.turn.agentRunId)).toEqual(Array.from({ length: 100 }, (_, i) => `agent_run:bounds-${i + 6}`));
        expect(runCounts.get(handle.firstExecutionRunId)).toBe(6);
        await record(first, "roomAgentSupervisorWorkflow-carry-bound");
      } finally { await env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test complete"); }
    });
  }, 40_000);

  }
  if (group === "supervisor-races") {
  it("executes allocation, send and verification in one mission without sending twice", async () => {
    const c = continuationDriver();
    c.activities.runCodexAppServerTurn.mockImplementationOnce(async turn => {
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Synthetic complete", chat: "Synthetic complete" }, statusReason: "Both tasks completed." });
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return { status: "COMPLETED", message: "Sent", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1,
        pendingActionIds: ["action:send"], statusReason: "Queued" } };
    });
    await supervise(c.workflowInput, c.activities, async () => {
      await c.finished.promise;
      expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      expect(c.activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledOnce();
    });
  }, 40_000);

  it.each([
    ["plain failure", () => ApplicationFailure.nonRetryable("Synthetic failure", "Error"), "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["Temporal timeout cause", () => ApplicationFailure.create({ message: "Synthetic activity failure", type: "Error", nonRetryable: true,
      cause: new TimeoutFailure("Synthetic timeout", undefined, TimeoutType.HEARTBEAT) }), "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application failure code", () => ApplicationFailure.nonRetryable("Synthetic failure", "CODEX_APP_SERVER_TURN_TIMEOUT"), "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ] as const)("retains FAILED and the cause code for a %s", async (_, makeFailure, code) => {
    const c = continuationDriver();
    c.activities.runCodexAppServerTurn.mockImplementation(async () => { throw makeFailure(); });
    await supervise(c.workflowInput, c.activities, async () => {
      expect(await c.finished.promise).toMatchObject({ status: "FAILED", errorCode: code });
      expect(c.prepared).toHaveLength(1);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, c.prepared[0].turn.agentRunId)?.run)
        .toMatchObject({ status: "FAILED", errorCode: code });
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
    });
  }, 40_000);

  it.each(["stop", "follow-up"])("retires a prepared continuation when %s arrives before the activity reply", async kind => {
    const c = continuationDriver();
    const preparing = deferred();
    const release = deferred();
    const discarded = deferred<any>();
    c.activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async input => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (result.state === "READY") c.prepared.push(result.item);
      preparing.resolve();
      await release.promise;
      return result;
    });
    c.activities.discardRoomAgentSupervisorTurn.mockImplementation(async ({ item, reason, errorCode }) => {
      await discardSupervisorTurn(item, reason, c.store, errorCode);
      discarded.resolve(item);
    });
    await supervise(c.workflowInput, c.activities, async handle => {
      await preparing.promise;
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      release.resolve();
      const retired = await discarded.promise;
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, retired.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
      if (kind === "stop") expect(c.activities.runCodexAppServerTurn).not.toHaveBeenCalled();
      else {
        await c.finished.promise;
        expect(c.activities.runCodexAppServerTurn.mock.calls[0][0].roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
    });
  }, 40_000);

  it("carries a prepared continuation into the next execution and starts it exactly once", async () => {
    const c = continuationDriver();
    const taskQueue = `prepared-carry-${++sequence}`;
    const worker = await Worker.create({ connection: env.nativeConnection, taskQueue, workflowBundle: bundle, activities: c.activities });
    await worker.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue,
        workflowId: `prepared-carry-${sequence}`, followRuns: false,
        args: [roomAgentSupervisorInputSchema.parse({ ...c.workflowInput, processedCount: 50 })] });
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
      const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const history = await first.fetchHistory();
      const continued = history.events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)!;
      const carried = roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(
        continued.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried.pending).toHaveLength(1);
      expect(history.events.filter((e: any) => e.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(0);
      const latest = env.client.workflow.getHandle(handle.workflowId);
      const result = latest.result().catch(error => error);
      try {
        await bounded(c.finished.promise, "continued mission completion");
        expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledOnce();
        expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
        await record(first, "roomAgentSupervisorWorkflow-prepared-carry");
      } finally { await latest.terminate("Synthetic test complete"); await bounded(result, "continued supervisor termination"); }
    });
  }, 40_000);

  it("uses the legacy boolean settlement contract and removes a finished mission", async () => {
    const settled = deferred();
    const settle = vi.fn(() => { settled.resolve(); return true; });
    const prepare = vi.fn(() => { throw Error("Current activity called by legacy workflow"); });
    await supervise({ roomId: turn.roomId, monitoringMissionIds: ["mission:legacy"] }, {
      settleRoomAgentBackgroundMission: settle, prepareRoomAgentBackgroundContinuation: prepare
    }, async () => {
      await settled.promise;
      await env.sleep("5 seconds");
      expect(settle).toHaveBeenCalledOnce();
      expect(prepare).not.toHaveBeenCalled();
    }, true);
  }, 40_000);

  it("retries a paused turn after the real one-second condition timer", async () => {
    const firstCheck = deferred();
    const finished = deferred<any>();
    let checks = 0;
    const item = { missionId: "mission:paused", turn: { ...turn, agentRunId: "agent_run:paused" } };
    const runTurn = vi.fn(() => ({ ...completed, roomAgentOutcome: { status: "VERIFIED", statusReason: "Synthetic verified", executedActionCount: 1 } }));
    await supervise({ roomId: turn.roomId, pending: [item] }, {
      checkRoomAgentSupervisorTurn: () => { firstCheck.resolve(); return ++checks === 1 ? "PAUSED" : "READY"; },
      runCodexAppServerTurn: runTurn,
      finishRoomAgentSupervisorTurn: input => { finished.resolve(input); }
    }, async handle => {
      await firstCheck.promise;
      expect(await finished.promise).toMatchObject({ status: "COMPLETED" });
      expect(checks).toBe(2);
      expect(runTurn).toHaveBeenCalledOnce();
      const history = await handle.fetchHistory();
      expect(history.events.filter((e: any) => e.timerFiredEventAttributes)).toHaveLength(1);
    });
  }, 40_000);
  }
});
}
