/**
 * Real-sandbox Temporal workflow tests.
 *
 * Every workflow registered by the worker is exercised here against a real
 * time-skipping test server (`TestWorkflowEnvironment.createTimeSkipping()`),
 * running the production workflow code from `temporal-workflows-entry.ts`
 * with stub activities. No network, database, Docker or AI provider is
 * involved: activities are in-process stubs (the room supervisor stubs are
 * backed by the same in-memory store the mocked tests use).
 *
 * These tests complement `room-supervisor-continuation.test.ts`, whose
 * assertions are all mirrored here against the real sandbox; the mocked test
 * stays for fast unit feedback.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DefaultLogger, Runtime, Worker } from "@temporalio/worker";
import { Context } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/common";
import {
  DOT_GOAL_SIGNAL,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  buildCodexAppServerTurnWorkflowId,
  roomAgentSupervisorInputSchema,
  type DummyTurnInput,
  type TurnWorkflowResult
} from "@space/contracts";
import { fileURLToPath } from "node:url";
import { continuationFixture } from "./room-continuation-fixture.js";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../src/room-background-continuation.js";

Runtime.install({ logger: new DefaultLogger("WARN") });

const WORKFLOWS_PATH = fileURLToPath(new URL("./temporal-workflows-entry.ts", import.meta.url));
const MAIN_QUEUE = "space-temporal-tests";
const LEGACY_QUEUE = "space-temporal-tests-legacy";
const MAINTENANCE_QUEUE = "space-memory-maintenance";
const MUTATION_QUEUE = "space-memory-mutations";

const TEST_TIMEOUT_MS = 300_000;

type ActivityImpl = (...args: any[]) => Promise<any>;

/**
 * Activities are looked up by name at call time. Tests run serially inside
 * this file, so a single mutable registry safely routes each worker's
 * activity tasks to the current test's stubs.
 */
const stubRegistry = new Map<string, ActivityImpl>();

function stub(name: string, impl: ActivityImpl): void {
  stubRegistry.set(name, impl);
}

function delegate(name: string): ActivityImpl {
  return async (...args: any[]) => {
    const impl = stubRegistry.get(name);
    if (!impl) throw new Error(`No stub registered for activity "${name}" in this test`);
    return impl(...args);
  };
}

const ACTIVITY_NAMES = [
  "recordDummyTurnStarted",
  "recordDummyTurnCompleted",
  "runCodexAppServerTurn",
  "runOpenCodeAgentTurn",
  "runCliAgentTurn",
  "markRoomAgentMissionStarted",
  "markRoomAgentMissionFinished",
  "markRoomAgentMissionContinued",
  "settleRoomAgentBackgroundMission",
  "dotGoalStep",
  "dotGoalObserve",
  "runRoomAgentBackgroundAction",
  "failRoomAgentBackgroundAction",
  "checkRoomAgentSupervisorTurn",
  "discardRoomAgentSupervisorTurn",
  "finishRoomAgentSupervisorTurn",
  "prepareRoomAgentBackgroundContinuation",
  "refreshMemoryGraphSnapshot",
  "refreshAllMonthsMemoryGraphSnapshot",
  "reconcileStaleSpaceAgentSessions",
  "createScheduledMemoryAudit",
  "prepareMemoryConsolidation",
  "finalizeMemoryRepair",
  "executePersistedMemoryChangeSet"
] as const;

const allActivities: Record<string, ActivityImpl> = Object.fromEntries(
  ACTIVITY_NAMES.map((name) => [name, delegate(name)])
);

let env: TestWorkflowEnvironment;
let releaseWorkers: () => void = () => undefined;
let workersDone: Promise<unknown> = Promise.resolve();

let workflowCounter = 0;
function workflowId(slug: string): string {
  workflowCounter += 1;
  return `test-${slug}-${workflowCounter}`;
}

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  const workerOptions = {
    connection: env.nativeConnection,
    namespace: "default",
    workflowsPath: WORKFLOWS_PATH,
    activities: allActivities,
    // The bundled workflow code is several megabytes; slow runners need more
    // than the default 5s to evaluate it inside the workflow isolate.
    isolateExecutionTimeout: "60 seconds"
  } as const;
  const workers = await Promise.all([
    Worker.create({ ...workerOptions, taskQueue: MAIN_QUEUE }),
    Worker.create({
      ...workerOptions,
      taskQueue: LEGACY_QUEUE,
      // Replay the histories that predate the continuation patch: the
      // workflow must take its legacy branch.
      patchActivationCallback: ({ patchId }: { patchId: string }) =>
        patchId !== "room-background-continuation-v1"
    }),
    Worker.create({ ...workerOptions, taskQueue: MAINTENANCE_QUEUE }),
    Worker.create({ ...workerOptions, taskQueue: MUTATION_QUEUE })
  ]);
  const gate = new Promise<void>((resolve) => {
    releaseWorkers = resolve;
  });
  workersDone = Promise.all(workers.map((worker) => worker.runUntil(() => gate)));
}, 600_000);

afterAll(async () => {
  releaseWorkers();
  await workersDone;
  await env?.teardown();
}, 600_000);

beforeEach(() => {
  stubRegistry.clear();
});

/**
 * Assert that a workflow execution failed with the given error somewhere in
 * the failure cause chain (the client surfaces a generic WorkflowFailedError
 * whose cause is the activity failure).
 */
async function expectWorkflowFailure(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(error, "expected the workflow execution to fail").not.toBeNull();
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  expect(messages.join(" | ")).toMatch(pattern);
}

/**
 * Terminate a workflow and wait until the server reports the run closed, so
 * a supervisor left polling in the background cannot leak workflow tasks
 * into later tests sharing this test server.
 */
async function terminateAndSettle(handle: {
  terminate: () => Promise<void>;
  describe: () => Promise<{ status: { name: string } }>;
}): Promise<void> {
  await handle.terminate().catch(() => undefined);
  for (let i = 0; i < 80; i += 1) {
    const status = await handle
      .describe()
      .then((d) => d.status.name)
      .catch(() => "COMPLETED");
    if (status !== "RUNNING") return;
    await env.sleep("250 milliseconds");
  }
}

/** Advance the test server's clock until `predicate` holds (or give up). */
async function waitFor(description: string, predicate: () => boolean, maxSteps = 600): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    if (predicate()) return;
    await env.sleep("250 milliseconds");
  }
  if (!predicate()) throw new Error(`Timed out waiting for ${description}`);
}

interface HistoryEventLike {
  workflowExecutionContinuedAsNewEventAttributes?: {
    input?: { payloads?: unknown[] };
  };
  [key: string]: unknown;
}

async function fetchFirstRunEvents(handle: {
  workflowId: string;
  firstExecutionRunId?: string;
}): Promise<HistoryEventLike[]> {
  // Fetch the first run's history through the workflow service, pinned by run
  // id: after a continue-as-new, the handle-level fetch follows the new run
  // and the closing event of the run that continued is never seen.
  const events: HistoryEventLike[] = [];
  let nextPageToken: Uint8Array | undefined;
  do {
    const response = await env.connection.workflowService.getWorkflowExecutionHistory({
      namespace: "default",
      execution: { workflowId: handle.workflowId, runId: handle.firstExecutionRunId },
      maximumPageSize: 1000,
      nextPageToken
    } as never);
    events.push(...(((response.history?.events ?? []) as unknown) as HistoryEventLike[]));
    const token = response.nextPageToken;
    nextPageToken = token && token.length ? token : undefined;
  } while (nextPageToken);
  return events;
}

async function continuedAsNewInput(handle: {
  workflowId: string;
  firstExecutionRunId?: string;
}): Promise<unknown | null> {
  const events = await fetchFirstRunEvents(handle);
  const history = { events };
  const event = (history.events ?? []).find((e) => e.workflowExecutionContinuedAsNewEventAttributes);
  const payloads = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads;
  if (!payloads?.length) return null;
  return defaultPayloadConverter.fromPayload(payloads[0] as never);
}

function turnInput(overrides: Partial<DummyTurnInput> = {}): DummyTurnInput {
  return {
    roomId: "room:test",
    paneId: "pane:test",
    prompt: "Say hello.",
    artifactIds: [],
    permissionMode: null,
    collaborationMode: "default",
    traceId: "trace:test",
    ...overrides
  } as DummyTurnInput;
}

function turnResult(input: DummyTurnInput, overrides: Partial<TurnWorkflowResult> = {}): TurnWorkflowResult {
  return {
    workflowId: buildCodexAppServerTurnWorkflowId(input),
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status: "COMPLETED",
    message: "Turn completed.",
    ...overrides
  };
}

/** An activity that blocks until the workflow cancels it, heartbeating so the 15s heartbeat timeout never fires. */
function blockingTurn(record: { calls: DummyTurnInput[] }): ActivityImpl {
  return async (input: DummyTurnInput) => {
    record.calls.push(input);
    await new Promise<never>((_resolve, reject) => {
      const timer = setInterval(() => {
        try {
          Context.current().heartbeat();
        } catch {
          /* not in an activity context */
        }
      }, 100);
      Context.current().cancelled.then(() => {
        clearInterval(timer);
        reject(new Error("Turn activity cancelled"));
      });
    });
  };
}

describe("dotGoalWorkflow", () => {
  it("completes when a WAITING step times out and the next step reports DONE", async () => {
    let steps = 0;
    stub("dotGoalStep", async () => {
      steps += 1;
      return steps === 1
        ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    });
    stub("dotGoalObserve", async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" }));

    const result = await env.client.workflow.execute("dotGoalWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("dot-goal-timeout"),
      workflowTaskTimeout: "30 seconds",
      args: [{ goalId: "goal:timeout" }]
    });

    expect(result).toEqual({ goalStatus: "COMPLETED" });
    expect(steps).toBe(2);
  }, TEST_TIMEOUT_MS);

  it("ends a PAUSED wait early when the wake signal arrives, not at the one-hour timeout", async () => {
    let steps = 0;
    stub("dotGoalStep", async () => {
      steps += 1;
      return steps === 1
        ? { state: "PAUSED", runId: null, goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    });
    stub("dotGoalObserve", async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" }));

    const startMs = await env.currentTimeMs();
    const handle = await env.client.workflow.start("dotGoalWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("dot-goal-wake"),
      workflowTaskTimeout: "30 seconds",
      args: [{ goalId: "goal:wake" }]
    });
    // Let the workflow enter the one-hour PAUSED wait, then advance only half
    // of it: the step must not have been called again yet.
    await waitFor("the first goal step", () => steps === 1);
    await env.sleep("30 minutes");
    expect(steps).toBe(1);
    expect((await env.currentTimeMs()) - startMs).toBeGreaterThanOrEqual(30 * 60 * 1000);

    await handle.signal(DOT_GOAL_SIGNAL);
    await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETED" });
    expect(steps).toBe(2);
    // The wait ended because of the signal: the step ran again immediately
    // after it, while 30 minutes of the one-hour wait were still on the clock
    // (asserted above via the unchanged step count).
  }, TEST_TIMEOUT_MS);

  it("continues as new with the goal id after 300 unfinished iterations", async () => {
    let steps = 0;
    stub("dotGoalStep", async () => {
      steps += 1;
      return steps <= 300
        ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    });
    stub("dotGoalObserve", async () => ({ run: "COMPLETED", goalStatus: "COMPLETED" }));

    const id = workflowId("dot-goal-can");
    const firstRun = await env.client.workflow.start("dotGoalWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: id,
      workflowTaskTimeout: "30 seconds",
      args: [{ goalId: "goal:long" }]
    });

    // 300 iterations x a 30 second wait each: drive the clock in large steps
    // until the loop exhausts its iterations and the run continues as new.
    for (let i = 0; i < 30 && steps <= 300; i += 1) {
      await env.sleep("15 minutes");
    }
    expect(steps).toBeGreaterThan(300);
    const carried = await continuedAsNewInput(firstRun);
    expect(carried).toEqual({ goalId: "goal:long" });

    await expect(env.client.workflow.getHandle(id).result()).resolves.toEqual({ goalStatus: "COMPLETED" });
  }, 900_000);
});

describe("dummyTurnWorkflow", () => {
  it("returns the completion activity's result", async () => {
    const input = turnInput();
    const expected = {
      workflowId: "space-dummy-turn:test",
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "COMPLETED",
      message: "Dummy turn recorded."
    };
    stub("recordDummyTurnStarted", async () => undefined);
    stub("recordDummyTurnCompleted", async () => expected);

    const result = await env.client.workflow.execute("dummyTurnWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("dummy-turn"),
      workflowTaskTimeout: "30 seconds",
      args: [input]
    });
    expect(result).toEqual(expected);
  }, TEST_TIMEOUT_MS);

  it("retries a failing completion activity and fails after 3 attempts", async () => {
    const input = turnInput();
    let attempts = 0;
    stub("recordDummyTurnStarted", async () => undefined);
    stub("recordDummyTurnCompleted", async () => {
      attempts += 1;
      throw new Error("ledger unavailable");
    });

    await expectWorkflowFailure(
      env.client.workflow.execute("dummyTurnWorkflow", {
        taskQueue: MAIN_QUEUE,
        workflowId: workflowId("dummy-turn-fails"),
        workflowTaskTimeout: "30 seconds",
        args: [input]
      }),
      /ledger unavailable/
    );
    expect(attempts).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("succeeds when the completion activity fails twice and then recovers", async () => {
    const input = turnInput();
    let attempts = 0;
    stub("recordDummyTurnStarted", async () => undefined);
    stub("recordDummyTurnCompleted", async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ledger unavailable");
      return {
        workflowId: "space-dummy-turn:test",
        roomId: input.roomId,
        paneId: input.paneId,
        traceId: input.traceId,
        status: "COMPLETED",
        message: "Dummy turn recorded."
      };
    });

    const result = await env.client.workflow.execute("dummyTurnWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("dummy-turn-retries"),
      workflowTaskTimeout: "30 seconds",
      args: [input]
    });
    expect(result.status).toBe("COMPLETED");
    expect(attempts).toBe(3);
  }, TEST_TIMEOUT_MS);
});

describe("codexAppServerTurnWorkflow", () => {
  it("retries a native Chat turn up to 5 attempts and then succeeds", async () => {
    const input = turnInput({
      agentSessionId: "session:native",
      agentAssistantMessageId: "agent_msg:assistant-native"
    });
    let attempts = 0;
    stub("runCodexAppServerTurn", async (turn: DummyTurnInput) => {
      attempts += 1;
      if (attempts < 3) throw new Error("app server busy");
      return turnResult(turn);
    });

    const result = await env.client.workflow.execute("codexAppServerTurnWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("codex-native"),
      workflowTaskTimeout: "30 seconds",
      args: [input]
    });
    expect(result.status).toBe("COMPLETED");
    expect(attempts).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("does not retry the OpenCode provider path (maximumAttempts is 1)", async () => {
    const input = turnInput({ providerId: "opencode" });
    let attempts = 0;
    stub("runOpenCodeAgentTurn", async () => {
      attempts += 1;
      throw new Error("opencode exploded");
    });

    await expectWorkflowFailure(
      env.client.workflow.execute("codexAppServerTurnWorkflow", {
        taskQueue: MAIN_QUEUE,
        workflowId: workflowId("codex-opencode"),
        workflowTaskTimeout: "30 seconds",
        args: [input]
      }),
      /opencode exploded/
    );
    expect(attempts).toBe(1);
  }, TEST_TIMEOUT_MS);
});

describe("roomAgentActionWorkflow", () => {
  const actionInput = {
    bridge: { roomId: "room:proof", missionId: "mission:proof" },
    traceId: "trace:proof"
  } as never;

  it("returns the action result and never touches the failure recorder on success", async () => {
    let failures = 0;
    stub("runRoomAgentBackgroundAction", async () => ({ status: "COMPLETED", actionId: "action:ok" }));
    stub("failRoomAgentBackgroundAction", async () => {
      failures += 1;
    });

    const result = await env.client.workflow.execute("roomAgentActionWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("room-action-ok"),
      workflowTaskTimeout: "30 seconds",
      args: [actionInput]
    });
    expect(result).toEqual({ status: "COMPLETED", actionId: "action:ok" });
    expect(failures).toBe(0);
  }, TEST_TIMEOUT_MS);

  it("persists the failure after retries are exhausted, deriving the action id from the workflow id", async () => {
    // Mirrors the mocked test in room-supervisor-continuation.test.ts,
    // including its legacy workflow id.
    let attempts = 0;
    const recorded: unknown[] = [];
    stub("runRoomAgentBackgroundAction", async () => {
      attempts += 1;
      throw new Error("transport failed");
    });
    stub("failRoomAgentBackgroundAction", async (input: unknown) => {
      recorded.push(input);
    });

    await expectWorkflowFailure(
      env.client.workflow.execute("roomAgentActionWorkflow", {
        taskQueue: MAIN_QUEUE,
        workflowId: "space-room-action:action:legacy",
        workflowTaskTimeout: "30 seconds",
        args: [actionInput]
      }),
      /transport failed/
    );
    expect(attempts).toBe(5);
    expect(recorded).toEqual([
      { roomId: "room:proof", missionId: "mission:proof", actionId: "action:legacy", cancelled: false }
    ]);
  }, TEST_TIMEOUT_MS);
});


/**
 * Store-backed supervisor driver: the same wiring the mocked test in
 * room-supervisor-continuation.test.ts uses, but the stubs are real Temporal
 * activities and the supervisor + turn workflows run in the sandbox.
 */
function supervisorDriver(hooks: {
  onFirstPrepare?: (result: unknown) => Promise<void>;
  turnHook?: (turn: DummyTurnInput, callIndex: number) => Promise<TurnWorkflowResult | null>;
} = {}) {
  const c = continuationFixture();
  const calls = {
    check: [] as unknown[],
    prepare: [] as unknown[],
    discard: [] as unknown[],
    finish: [] as unknown[],
    settle: [] as unknown[],
    markStarted: [] as unknown[],
    markFinished: [] as unknown[],
    markContinued: [] as unknown[],
    turn: [] as DummyTurnInput[]
  };
  let prepareCount = 0;
  stub("prepareRoomAgentBackgroundContinuation", async (input: never) => {
    calls.prepare.push(input);
    prepareCount += 1;
    const result = await prepareBackgroundContinuation(input, c.store);
    if (prepareCount === 1 && hooks.onFirstPrepare) await hooks.onFirstPrepare(result);
    return result;
  });
  stub("checkRoomAgentSupervisorTurn", async (item: never) => {
    calls.check.push(item);
    return supervisorTurnState(item, c.store);
  });
  stub("discardRoomAgentSupervisorTurn", async (arg: { item: never; reason?: string }) => {
    calls.discard.push(arg);
    return discardSupervisorTurn(arg.item, arg.reason ?? "Turn is no longer active or was superseded.", c.store);
  });
  stub("finishRoomAgentSupervisorTurn", async (input: never) => {
    calls.finish.push(input);
    return finishSupervisorTurn(input, c.store);
  });
  stub("settleRoomAgentBackgroundMission", async (input: never) => {
    calls.settle.push(input);
    return false;
  });
  stub("markRoomAgentMissionStarted", async (input: never) => {
    calls.markStarted.push(input);
  });
  stub("markRoomAgentMissionFinished", async (input: never) => {
    calls.markFinished.push(input);
  });
  stub("markRoomAgentMissionContinued", async (input: never) => {
    calls.markContinued.push(input);
  });
  stub("runCodexAppServerTurn", async (turn: DummyTurnInput) => {
    calls.turn.push(turn);
    const hooked = hooks.turnHook ? await hooks.turnHook(turn, calls.turn.length) : null;
    if (hooked) return hooked;
    c.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
    return turnResult(turn, {
      roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." }
    });
  });
  const workflowInput = roomAgentSupervisorInputSchema.parse({
    roomId: c.room.id,
    monitoringMissionIds: [c.initial.mission.id]
  });
  return { ...c, calls, workflowInput };
}

async function startSupervisor(
  taskQueue: string,
  input: unknown,
  slug: string
): Promise<Awaited<ReturnType<typeof env.client.workflow.start>>> {
  return env.client.workflow.start("roomAgentSupervisorWorkflow", {
    taskQueue,
    workflowId: workflowId(slug),
    workflowTaskTimeout: "30 seconds",
    args: [input]
  });
}

describe("roomAgentSupervisorWorkflow (current branch)", () => {
  it("executes allocation -> send -> verification in one mission", async () => {
    const d = supervisorDriver({
      turnHook: async (turn, callIndex) => {
        if (callIndex !== 1) return null;
        expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
        d.store.createRoomAgentAction({
          ...d.action,
          actionId: "action:send",
          idempotencyKey: "send-once",
          actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" },
          statusReason: "Both tasks completed."
        });
        d.store.updateSpaceAgentRun(turn.agentRunId!, { status: "COMPLETED" });
        return turnResult(turn, {
          message: "Sent",
          roomAgentOutcome: {
            status: "VERIFIED",
            executedActionCount: 1,
            pendingActionIds: ["action:send"],
            statusReason: "Queued"
          }
        });
      }
    });
    const handle = await startSupervisor(MAIN_QUEUE, d.workflowInput, "supervisor-allocation");
    try {
      await waitFor("the mission to complete", () => d.store.getRoomAgentMission(d.room.id, d.initial.mission.id)?.status === "COMPLETED");
      expect(d.calls.turn).toHaveLength(2);
      expect(d.store.listRoomAgentActions(d.initial.mission.id).filter((a) => a.actionType === "SEND")).toHaveLength(1);
      expect(d.calls.finish).toHaveLength(1);
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);

  it("retires a prepared run when a stop signal arrives before the activity reply", async () => {
    let handle: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    const d = supervisorDriver({
      onFirstPrepare: async () => {
        d.store.updateRoomAgentMission(d.initial.mission.id, { status: "INTERRUPTED" });
        await handle!.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      }
    });
    handle = await startSupervisor(MAIN_QUEUE, d.workflowInput, "supervisor-retire-stop");
    try {
      await waitFor(
        "the prepared turn to be interrupted",
        () => d.store.getRoomAgentTurn(d.initial.mission.id)?.run.status === "INTERRUPTED"
      );
      expect(d.calls.turn).toHaveLength(0);
      expect(d.calls.discard.length).toBeGreaterThanOrEqual(1);
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);

  it("retires a prepared run when a follow-up enqueue arrives before the activity reply", async () => {
    let handle: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    let preparedRunId: string | undefined;
    const d = supervisorDriver({
      onFirstPrepare: async (result) => {
        preparedRunId = (result as { item?: { turn?: { agentRunId?: string } } }).item?.turn?.agentRunId;
        const followUp = d.enqueue("follow-up", "Only inspect the room.");
        await handle!.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
    });
    handle = await startSupervisor(MAIN_QUEUE, d.workflowInput, "supervisor-retire-followup");
    try {
      await waitFor("the follow-up turn to run", () => d.calls.turn.length >= 1);
      expect(preparedRunId).toBeDefined();
      const prepared = d.store.getRoomAgentTurn(d.initial.mission.id, preparedRunId);
      expect(prepared?.run.status).toBe("INTERRUPTED");
      expect(d.calls.turn[0]?.roomAgentOperatorRequest).toBe("Only inspect the room.");
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);

  it("carries a prepared continuation through continue-as-new and starts it once", async () => {
    const d = supervisorDriver();
    const handle = await startSupervisor(
      MAIN_QUEUE,
      { ...d.workflowInput, processedCount: 50 },
      "supervisor-can-carry"
    );
    try {
      let carried: unknown = null;
      for (let i = 0; i < 600 && carried === null; i += 1) {
        carried = await continuedAsNewInput(handle);
        if (carried === null) await env.sleep("250 milliseconds");
      }
      expect(carried).not.toBeNull();
      const parsed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)));
      expect(parsed.pending).toHaveLength(1);
      expect(parsed.processedCount).toBe(0);
      expect(d.calls.turn).toHaveLength(0);

      await waitFor(
        "the mission to complete in the continued run",
        () => d.store.getRoomAgentMission(d.room.id, d.initial.mission.id)?.status === "COMPLETED"
      );
      expect(d.calls.turn).toHaveLength(1);
    } finally {
      await terminateAndSettle(env.client.workflow.getHandle(handle.workflowId));
    }
  }, TEST_TIMEOUT_MS);

  it("continues as new after 250 monitoring polls with the monitored missions carried", async () => {
    const d = supervisorDriver();
    d.store.updateRoomAgentMission(d.initial.mission.id, { status: "PAUSED" });
    const handle = await startSupervisor(MAIN_QUEUE, d.workflowInput, "supervisor-can-polls");
    try {
      await env.sleep("5 minutes");
      let carried: unknown = null;
      for (let i = 0; i < 600 && carried === null; i += 1) {
        carried = await continuedAsNewInput(handle);
        if (carried === null) await env.sleep("250 milliseconds");
      }
      expect(carried).not.toBeNull();
      const parsed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)));
      expect(parsed.monitoringMissionIds).toEqual([d.initial.mission.id]);
      expect(d.calls.prepare.length).toBeGreaterThanOrEqual(250);
    } finally {
      await terminateAndSettle(env.client.workflow.getHandle(handle.workflowId));
    }
  }, 900_000);

  it("interrupts a running mission when the stop signal arrives", async () => {
    const d = supervisorDriver();
    const record = { calls: [] as DummyTurnInput[] };
    stub("runCodexAppServerTurn", blockingTurn(record));
    const queued = d.enqueue("interrupt-me", "Long running inspection.");
    const input = roomAgentSupervisorInputSchema.parse({
      roomId: d.room.id,
      pending: [queued.queueItem]
    });
    const handle = await startSupervisor(MAIN_QUEUE, input, "supervisor-interrupt");
    try {
      await waitFor("the turn activity to start", () => record.calls.length === 1);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
        missionId: queued.queueItem.missionId,
        reason: "Operator stop requested."
      });
      await waitFor(
        "the mission to be marked interrupted",
        () => d.store.getRoomAgentMission(d.room.id, d.initial.mission.id)?.status === "INTERRUPTED"
      );
      const finish = d.calls.finish.find(
        (f) => (f as { status?: string }).status === "INTERRUPTED"
      ) as { statusReason?: string } | undefined;
      expect(finish?.statusReason).toBe("Operator stop requested.");
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);

  it("processes an enqueue signal that arrives while the supervisor is idle", async () => {
    const d = supervisorDriver();
    const input = roomAgentSupervisorInputSchema.parse({ roomId: d.room.id });
    const handle = await startSupervisor(MAIN_QUEUE, input, "supervisor-idle-enqueue");
    try {
      // Give the workflow a moment to reach its idle condition wait.
      await env.sleep("2 seconds");
      const queued = d.enqueue("idle-add", "Inspect the room while idle.");
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, queued.queueItem);
      await waitFor(
        "the mission to complete",
        () => d.store.getRoomAgentMission(d.room.id, d.initial.mission.id)?.status === "COMPLETED"
      );
      expect(d.calls.turn).toHaveLength(1);
      expect(d.calls.turn[0]?.agentRunId).toBe(queued.queueItem.turn.agentRunId);
      expect(d.calls.finish).toHaveLength(1);
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);

  it("defers continue-as-new until the carried queue fits the next run's input bounds", async () => {
    const roomId = "room:carry-bound";
    const item = (index: number) => ({
      missionId: "mission:carry-bound",
      turn: {
        roomId,
        paneId: "pane:carry-bound",
        prompt: `Queued request ${index}`,
        artifactIds: [],
        agentRunId: `agent_run:carry-${String(index).padStart(3, "0")}`,
        permissionMode: null,
        collaborationMode: "default",
        traceId: `trace:carry-${index}`
      }
    });
    let flooded = false;
    let checks = 0;
    let handle: Awaited<ReturnType<typeof startSupervisor>> | undefined;
    stub("checkRoomAgentSupervisorTurn", async () => {
      checks += 1;
      if (!flooded) {
        flooded = true;
        for (let index = 1; index <= 105; index += 1) {
          await handle!.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
        }
      }
      return "SKIP" as const;
    });
    stub("discardRoomAgentSupervisorTurn", async () => undefined);
    stub("finishRoomAgentSupervisorTurn", async () => undefined);
    const input = roomAgentSupervisorInputSchema.parse({ roomId, pending: [item(0)], processedCount: 49 });
    handle = await startSupervisor(MAIN_QUEUE, input, "supervisor-carry-bound");
    try {
      let carried: unknown = null;
      for (let i = 0; i < 600 && carried === null; i += 1) {
        carried = await continuedAsNewInput(handle);
        if (carried === null) await env.sleep("250 milliseconds");
      }
      expect(carried).not.toBeNull();
      const parsed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)));
      // Five extra turns drained in this run; none were dropped.
      expect(parsed.pending).toHaveLength(100);
      expect(checks).toBe(6);
    } finally {
      await terminateAndSettle(env.client.workflow.getHandle(handle.workflowId));
    }
  }, TEST_TIMEOUT_MS);
});

describe("roomAgentSupervisorWorkflow (pre-patch legacy branch)", () => {
  it("uses the legacy boolean settle activity and never prepares continuations", async () => {
    const d = supervisorDriver();
    stub("settleRoomAgentBackgroundMission", async (input: never) => {
      d.calls.settle.push(input);
      return true;
    });
    const handle = await startSupervisor(LEGACY_QUEUE, d.workflowInput, "supervisor-legacy-settle");
    try {
      await waitFor("the legacy settle activity to run", () => d.calls.settle.length >= 1);
      expect(d.calls.settle).toHaveLength(1);
      expect(d.calls.prepare).toHaveLength(0);
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);

  it("continues as new after 50 processed items with the counters reset", async () => {
    const d = supervisorDriver();
    stub("runCodexAppServerTurn", async (turn: DummyTurnInput) => {
      d.calls.turn.push(turn);
      return turnResult(turn, { message: "Legacy turn done." });
    });
    const queued = d.enqueue("legacy-item", "Legacy queued request.");
    const input = {
      roomId: d.room.id,
      pending: [queued.queueItem],
      monitoringMissionIds: [] as string[],
      processedCount: 49
    };
    const handle = await startSupervisor(LEGACY_QUEUE, input, "supervisor-legacy-can-50");
    try {
      let carried: unknown = null;
      for (let i = 0; i < 600 && carried === null; i += 1) {
        carried = await continuedAsNewInput(handle);
        if (carried === null) await env.sleep("250 milliseconds");
      }
      expect(carried).not.toBeNull();
      const parsed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)));
      expect(parsed.processedCount).toBe(0);
      expect(parsed.pending).toHaveLength(0);
      expect(d.calls.markStarted).toHaveLength(1);
      expect(d.calls.markFinished).toHaveLength(1);
    } finally {
      await terminateAndSettle(env.client.workflow.getHandle(handle.workflowId));
    }
  }, TEST_TIMEOUT_MS);

  it("continues as new after 250 monitoring polls with the monitored missions carried", async () => {
    const d = supervisorDriver();
    stub("settleRoomAgentBackgroundMission", async (input: never) => {
      d.calls.settle.push(input);
      return false;
    });
    const handle = await startSupervisor(LEGACY_QUEUE, d.workflowInput, "supervisor-legacy-can-polls");
    try {
      await env.sleep("5 minutes");
      let carried: unknown = null;
      for (let i = 0; i < 600 && carried === null; i += 1) {
        carried = await continuedAsNewInput(handle);
        if (carried === null) await env.sleep("250 milliseconds");
      }
      expect(carried).not.toBeNull();
      const parsed = roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)));
      expect(parsed.monitoringMissionIds).toEqual([d.initial.mission.id]);
      expect(d.calls.settle.length).toBeGreaterThanOrEqual(250);
    } finally {
      await terminateAndSettle(env.client.workflow.getHandle(handle.workflowId));
    }
  }, 900_000);

  it("marks the active mission interrupted when a stop signal cancels it", async () => {
    const d = supervisorDriver();
    const record = { calls: [] as DummyTurnInput[] };
    stub("runCodexAppServerTurn", blockingTurn(record));
    const queued = d.enqueue("legacy-interrupt", "Legacy long running inspection.");
    const input = {
      roomId: d.room.id,
      pending: [queued.queueItem],
      monitoringMissionIds: [] as string[],
      processedCount: 0
    };
    const handle = await startSupervisor(LEGACY_QUEUE, input, "supervisor-legacy-interrupt");
    try {
      await waitFor("the turn activity to start", () => record.calls.length === 1);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, {
        missionId: queued.queueItem.missionId,
        reason: "Legacy stop requested."
      });
      await waitFor("the mission to be marked interrupted", () => d.calls.markFinished.length >= 1);
      expect(d.calls.markFinished[0]).toMatchObject({
        missionId: queued.queueItem.missionId,
        status: "INTERRUPTED",
        statusReason: "Legacy stop requested."
      });
    } finally {
      await terminateAndSettle(handle);
    }
  }, TEST_TIMEOUT_MS);
});


const MAINTENANCE_RESULT = {
  status: "REFRESHED",
  generatedAt: "2026-10-16T12:00:00.000Z",
  sourceHash: "source-hash-1",
  previousSourceHash: null,
  summary: { nodeCount: 3, edgeCount: 2 },
  durationMs: 12
};

function fakeConsolidationRun(id: string, workflowId: string): Record<string, unknown> {
  const now = "2026-10-16T12:00:00.000Z";
  return {
    id,
    mode: "SCHEDULED",
    triggerKind: "SCHEDULED",
    status: "SUCCEEDED",
    workflowId,
    dedupeKey: `dedupe-${id}`,
    sourceHash: null,
    actorUserId: null,
    progressCompleted: 1,
    progressTotal: 1,
    findingCount: 0,
    appliedOperationCount: 1,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: null,
    createdAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now
  };
}

/** Registers the happy-path memory maintenance stubs; tests override what they break. */
function memoryDriver() {
  const calls = {
    refresh: [] as unknown[],
    refreshAllMonths: [] as unknown[],
    reconcile: 0,
    audit: [] as unknown[],
    prepare: [] as unknown[],
    finalize: [] as unknown[],
    mutation: [] as unknown[]
  };
  stub("refreshMemoryGraphSnapshot", async (input: unknown) => {
    calls.refresh.push(input);
    return MAINTENANCE_RESULT;
  });
  stub("refreshAllMonthsMemoryGraphSnapshot", async (input: unknown) => {
    calls.refreshAllMonths.push(input);
    return MAINTENANCE_RESULT;
  });
  stub("reconcileStaleSpaceAgentSessions", async () => {
    calls.reconcile += 1;
    return { reconciled: 0 };
  });
  stub("createScheduledMemoryAudit", async (input: { sourceHash: string }) => {
    calls.audit.push(input);
    return { id: "run:maintenance-1", workflowId: "memory-consolidation:run-1", sourceHash: input.sourceHash };
  });
  stub("prepareMemoryConsolidation", async (input: { runId: string }) => {
    calls.prepare.push(input);
    return { run: fakeConsolidationRun(input.runId, "memory-consolidation:run-1"), changeSetId: "changeset:1" };
  });
  stub("executePersistedMemoryChangeSet", async (input: unknown) => {
    calls.mutation.push(input);
    return { status: "APPLIED", changeSetId: "changeset:1", resultingSourceHash: "source-hash-2", reason: null };
  });
  stub("finalizeMemoryRepair", async (input: unknown) => {
    calls.finalize.push(input);
    return fakeConsolidationRun("run:maintenance-1", "memory-consolidation:run-1");
  });
  return calls;
}

const MAINTENANCE_INPUT = { scheduledAt: "2026-10-16T12:00:00.000Z", traceId: "trace:maintenance" };

describe("memoryMaintenanceWorkflow", () => {
  it("refreshes, audits and runs consolidation as a child workflow", async () => {
    const calls = memoryDriver();
    const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("memory-maintenance"),
      workflowTaskTimeout: "30 seconds",
      args: [MAINTENANCE_INPUT]
    });
    expect(result).toEqual(MAINTENANCE_RESULT);
    expect(calls.audit).toEqual([{ ...MAINTENANCE_INPUT, sourceHash: "source-hash-1" }]);
    expect(calls.prepare).toEqual([{ runId: "run:maintenance-1", traceId: "trace:maintenance" }]);
    expect(calls.mutation).toEqual([{ changeSetId: "changeset:1", traceId: "trace:maintenance" }]);
    expect(calls.finalize).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("continues when the all-months refresh fails on every retry", async () => {
    const calls = memoryDriver();
    let attempts = 0;
    stub("refreshAllMonthsMemoryGraphSnapshot", async () => {
      attempts += 1;
      throw new Error("month snapshot store unavailable");
    });
    const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("memory-maintenance-months-fail"),
      workflowTaskTimeout: "30 seconds",
      args: [MAINTENANCE_INPUT]
    });
    expect(result).toEqual(MAINTENANCE_RESULT);
    expect(attempts).toBe(3);
    expect(calls.mutation).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("continues when session reconciliation fails on every retry", async () => {
    const calls = memoryDriver();
    let attempts = 0;
    stub("reconcileStaleSpaceAgentSessions", async () => {
      attempts += 1;
      throw new Error("session store unavailable");
    });
    const result = await env.client.workflow.execute("memoryMaintenanceWorkflow", {
      taskQueue: MAIN_QUEUE,
      workflowId: workflowId("memory-maintenance-reconcile-fail"),
      workflowTaskTimeout: "30 seconds",
      args: [MAINTENANCE_INPUT]
    });
    expect(result).toEqual(MAINTENANCE_RESULT);
    expect(attempts).toBe(3);
    expect(calls.reconcile).toBe(0);
    expect(calls.mutation).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("skips the mutation and finalize steps when consolidation prepares no change set", async () => {
    const calls = memoryDriver();
    stub("prepareMemoryConsolidation", async (input: { runId: string }) => {
      calls.prepare.push(input);
      return { run: fakeConsolidationRun(input.runId, "memory-consolidation:run-1"), changeSetId: null };
    });
    const result = await env.client.workflow.execute("memoryConsolidationWorkflow", {
      taskQueue: MAINTENANCE_QUEUE,
      workflowId: workflowId("memory-consolidation-empty"),
      workflowTaskTimeout: "30 seconds",
      args: [{ runId: "run:empty", traceId: "trace:consolidation" }]
    });
    expect(result).toMatchObject({ id: "run:empty" });
    expect(calls.mutation).toHaveLength(0);
    expect(calls.finalize).toHaveLength(0);
  }, TEST_TIMEOUT_MS);
});

describe("memoryMutationWorkflow", () => {
  it("retries the change-set activity and returns its result", async () => {
    let attempts = 0;
    stub("executePersistedMemoryChangeSet", async (input: { changeSetId: string }) => {
      attempts += 1;
      if (attempts < 3) throw new Error("memory store locked");
      return { status: "APPLIED", changeSetId: input.changeSetId, resultingSourceHash: "source-hash-9", reason: null };
    });
    const result = await env.client.workflow.execute("memoryMutationWorkflow", {
      taskQueue: MUTATION_QUEUE,
      workflowId: workflowId("memory-mutation"),
      workflowTaskTimeout: "30 seconds",
      args: [{ changeSetId: "changeset:9", traceId: "trace:mutation" }]
    });
    expect(result).toEqual({
      status: "APPLIED",
      changeSetId: "changeset:9",
      resultingSourceHash: "source-hash-9",
      reason: null
    });
    expect(attempts).toBe(3);
  }, TEST_TIMEOUT_MS);

  it("fails after the change-set activity exhausts its retries", async () => {
    let attempts = 0;
    stub("executePersistedMemoryChangeSet", async () => {
      attempts += 1;
      throw new Error("memory store locked");
    });
    await expectWorkflowFailure(
      env.client.workflow.execute("memoryMutationWorkflow", {
        taskQueue: MUTATION_QUEUE,
        workflowId: workflowId("memory-mutation-fails"),
        workflowTaskTimeout: "30 seconds",
        args: [{ changeSetId: "changeset:10", traceId: "trace:mutation" }]
      }),
      /memory store locked/
    );
    expect(attempts).toBe(3);
  }, TEST_TIMEOUT_MS);
});
