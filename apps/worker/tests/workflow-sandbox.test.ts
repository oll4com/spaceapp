import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { roomAgentSupervisorInputSchema } from "@space/contracts";
import proto from "@temporalio/proto";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { afterAll, beforeAll, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const workflowsPath = path.resolve(here, "../src/workflows.ts");
const maintenanceWorkflowsPath = path.resolve(here, "../src/memory-maintenance-workflows.ts");
const mutationWorkflowsPath = path.resolve(here, "../src/memory-mutation-workflows.ts");
const workflowSourcePath = workflowsPath;
const historiesDir = path.resolve(here, "fixtures/workflow-histories");
const negativeWorkflowsPath = path.resolve(here, "fixtures/replay-negative-workflow.ts");
const recordHistories = process.env.RECORD_WORKFLOW_HISTORIES === "1";

const ROOM = "room:sandbox";
const PANE = "pane:sandbox";
const MISSION = "mission:sandbox";
const HASH = "a".repeat(64);

let env: TestWorkflowEnvironment;

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
}, 180_000);

afterAll(async () => {
  await env?.teardown();
});

function turn(overrides: Record<string, unknown> = {}) {
  return {
    roomId: ROOM,
    paneId: PANE,
    prompt: "Look at the room.",
    artifactIds: [],
    traceId: "trace:sandbox",
    permissionMode: null,
    collaborationMode: "default",
    ...overrides
  };
}

function completedTurn(traceId: string) {
  return {
    workflowId: `workflow:turn:${traceId}`,
    roomId: ROOM,
    paneId: PANE,
    traceId,
    status: "COMPLETED" as const,
    message: "Recorded."
  };
}

async function withWorker<T>(
  activities: Record<string, (...args: never[]) => unknown>,
  run: (taskQueue: string) => Promise<T>,
  options: {
    workflowsPath?: string;
    taskQueue?: string;
    extras?: Array<{ taskQueue: string; activities: Record<string, (...args: never[]) => unknown> }>;
  } = {}
): Promise<T> {
  const taskQueue = options.taskQueue ?? `sandbox-${Math.random().toString(16).slice(2)}`;
  const workers = [
    await Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue,
      workflowsPath: options.workflowsPath ?? workflowsPath,
      activities
    }),
    ...await Promise.all((options.extras ?? []).map((extra) => Worker.create({
      connection: env.nativeConnection,
      namespace: env.namespace,
      taskQueue: extra.taskQueue,
      activities: extra.activities
    })))
  ];
  const result = workers[0]!.runUntil(() => run(taskQueue));
  await Promise.all(workers.slice(1).map((worker) => worker.runUntil(result.then(() => undefined, () => undefined))));
  return result;
}

async function start(workflowType: string, taskQueue: string, args: unknown[], workflowId = `${workflowType}-${Math.random().toString(16).slice(2)}`) {
  return env.client.workflow.start(workflowType, {
    taskQueue,
    workflowId,
    args,
    followRuns: false
  });
}

function readableHistory(history: unknown) {
  const raw = JSON.stringify(history ?? {});
  const decoded = [...raw.matchAll(/"data":"([A-Za-z0-9+/=]+)"/g)].map((match) => {
    try { return Buffer.from(match[1], "base64").toString("utf8"); } catch { return ""; }
  });
  return `${raw}\n${decoded.join("\n")}`;
}

function scheduledActivityCount(history: { events?: Array<{ activityTaskScheduledEventAttributes?: { activityType?: { name?: string } } }> } | undefined, activity: string) {
  return (history?.events ?? []).filter((event) => event.activityTaskScheduledEventAttributes?.activityType?.name === activity).length;
}

function historyEvents(history: { events?: unknown[] } | { history?: { events?: unknown[] } }) {
  const events = "events" in history && history.events
    ? history.events
    : "history" in history ? history.history?.events : undefined;
  return events ?? [];
}

function savedContinueAsNewInput(history: { events?: Array<{ eventType?: unknown; workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: Array<{ data?: string }> } } }> } | undefined) {
  const event = [...(history?.events ?? [])].reverse().find((item) => String(item.eventType ?? "").includes("CONTINUED_AS_NEW"));
  const data = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0]?.data;
  if (!data) throw new Error("saved history has no continue-as-new input");
  return JSON.parse(Buffer.from(data, "base64").toString("utf8")) as Record<string, unknown>;
}

function continuedAsNewInput(history: Parameters<typeof historyEvents>[0]) {
  const event = [...historyEvents(history)].reverse().find((item) => {
    const type = String((item as { eventType?: unknown }).eventType ?? "");
    return type.includes("CONTINUED_AS_NEW") || type === "28";
  }) as { workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: unknown[] } } } | undefined;
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  if (!payload) {
    const types = historyEvents(history).map((item) => String((item as { eventType?: unknown }).eventType));
    throw new Error(`no continue-as-new input in history (${types.join(", ")})`);
  }
  return defaultPayloadConverter.fromPayload(payload);
}

async function firstHistory(handle: { workflowId: string; firstExecutionRunId?: string; fetchHistory: () => Promise<unknown> }) {
  const pinned = handle.firstExecutionRunId
    ? env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId)
    : handle;
  return pinned.fetchHistory();
}

async function saveHistory(name: string, workflowId: string, history: unknown) {
  await mkdir(historiesDir, { recursive: true });
  await writeFile(path.join(historiesDir, `${name}.json`), JSON.stringify({ workflowId, history }));
}

it("runs a dummy turn and retries its activity", async () => {
  const attempts: number[] = [];
  const result = await withWorker({
    async recordDummyTurnStarted() {
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      if (attempt < 3) throw ApplicationFailure.retryable("not yet");
    },
    async recordDummyTurnCompleted() {
      return completedTurn("trace:dummy01");
    }
  }, async (taskQueue) => {
    const handle = await start("dummyTurnWorkflow", taskQueue, [turn({ traceId: "trace:dummy01" })]);
    return handle.result();
  });
  expect(attempts).toEqual([1, 2, 3]);
  expect(result).toMatchObject({ status: "COMPLETED", traceId: "trace:dummy01" });
}, 60_000);

it("routes a codex turn to the opencode, cli, native, and room-agent activities", async () => {
  const timeouts: Record<string, number> = {};
  const activities = {
    async runOpenCodeAgentTurn(input: { traceId: string }) {
      timeouts.opencode = Context.current().info.startToCloseTimeoutMs;
      return completedTurn(input.traceId);
    },
    async runCliAgentTurn(input: { traceId: string }) {
      timeouts.cli = Context.current().info.startToCloseTimeoutMs;
      return completedTurn(input.traceId);
    },
    async runCodexAppServerTurn(input: { traceId: string }) {
      const kind = input.traceId.includes("native") ? "native" : "room";
      timeouts[kind] = Context.current().info.startToCloseTimeoutMs;
      return completedTurn(input.traceId);
    }
  };
  await withWorker(activities, async (taskQueue) => {
    const cases = [
      turn({ providerId: "opencode", traceId: "trace:opencode" }),
      turn({ providerId: "cli:claude", traceId: "trace:cli0001" }),
      turn({ agentSessionId: "agent:session", agentAssistantMessageId: "agent:message", traceId: "trace:native01" }),
      turn({ roomAgentMissionId: MISSION, traceId: "trace:room0001" })
    ];
    for (const input of cases) {
      const handle = await start("codexAppServerTurnWorkflow", taskQueue, [input]);
      const result = await handle.result();
      expect(result).toMatchObject({ status: "COMPLETED", traceId: input.traceId });
    }
  });
  expect(timeouts.opencode).toBe(40 * 60 * 1000);
  expect(timeouts.cli).toBe(30 * 60 * 1000);
  expect(timeouts.room).toBe(24 * 60 * 60 * 1000);
  // The workflow asks for 36500 days. The test server reports a shorter timeout; the native branch is still the long one.
  expect(timeouts.native).toBeGreaterThan(timeouts.room);
}, 60_000);

it("retries a room-agent turn and a native turn, and does not retry OpenCode", async () => {
  const roomAttempts: number[] = [];
  const nativeAttempts: number[] = [];
  const openCodeAttempts: number[] = [];
  await withWorker({
    async runCodexAppServerTurn(input: { traceId: string }) {
      const attempt = Context.current().info.attempt;
      if (input.traceId.includes("native")) {
        nativeAttempts.push(attempt);
        if (attempt < 5) throw ApplicationFailure.retryable("native turn not ready");
        return completedTurn(input.traceId);
      }
      roomAttempts.push(attempt);
      if (attempt < 5) throw ApplicationFailure.retryable("room turn not ready");
      return completedTurn(input.traceId);
    },
    async runOpenCodeAgentTurn() {
      openCodeAttempts.push(Context.current().info.attempt);
      throw ApplicationFailure.retryable("opencode turn not ready");
    }
  }, async (taskQueue) => {
    const room = await start("codexAppServerTurnWorkflow", taskQueue, [turn({
      roomAgentMissionId: MISSION,
      traceId: "trace:roomretr"
    })]);
    await expect(room.result()).resolves.toMatchObject({ status: "COMPLETED", traceId: "trace:roomretr" });
    const native = await start("codexAppServerTurnWorkflow", taskQueue, [turn({
      agentSessionId: "agent:session",
      agentAssistantMessageId: "agent:message",
      traceId: "trace:nativer1"
    })]);
    await expect(native.result()).resolves.toMatchObject({ status: "COMPLETED", traceId: "trace:nativer1" });
    const openCode = await start("codexAppServerTurnWorkflow", taskQueue, [turn({
      providerId: "opencode",
      traceId: "trace:ocretry"
    })]);
    await expect(openCode.result()).rejects.toThrow();
  });
  expect(roomAttempts).toEqual([1, 2, 3, 4, 5]);
  expect(nativeAttempts).toEqual([1, 2, 3, 4, 5]);
  expect(openCodeAttempts).toEqual([1]);
}, 60_000);

it("does not retry a CLI chat turn", async () => {
  const attempts: number[] = [];
  await withWorker({
    async runCliAgentTurn() {
      attempts.push(Context.current().info.attempt);
      throw ApplicationFailure.retryable("cli turn not ready");
    }
  }, async (taskQueue) => {
    const handle = await start("codexAppServerTurnWorkflow", taskQueue, [turn({
      providerId: "cli:claude",
      traceId: "trace:cliretry"
    })]);
    await expect(handle.result()).rejects.toThrow();
  });
  expect(attempts).toEqual([1]);
}, 60_000);

it("wakes a dot goal on signal and on a skipped timeout, then continues an unfinished goal", async () => {
  let steps = 0;
  const activities = {
    async dotGoalStep() {
      steps += 1;
      if (steps === 1) return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
      return { state: "DONE", runId: null, goalStatus: "SUCCEEDED" };
    },
    async dotGoalObserve() {
      return { run: "SUCCEEDED", goalStatus: "SUCCEEDED" };
    }
  };
  const woken = await withWorker(activities, async (taskQueue) => {
    const handle = await start("dotGoalWorkflow", taskQueue, [{ goalId: "goal:sandbox" }]);
    await handle.signal("dotGoalWake");
    return handle.result();
  });
  expect(woken).toEqual({ goalStatus: "SUCCEEDED" });
  expect(steps).toBe(2);

  steps = 0;
  const timedOut = await withWorker({
    async dotGoalStep() {
      steps += 1;
      if (steps === 1) return { state: "PAUSED", runId: null, goalStatus: "ACTIVE" };
      return { state: "DONE", runId: null, goalStatus: "SUCCEEDED" };
    },
    async dotGoalObserve() {
      return { run: "SUCCEEDED", goalStatus: "SUCCEEDED" };
    }
  }, async (taskQueue) => {
    const handle = await start("dotGoalWorkflow", taskQueue, [{ goalId: "goal:timeout" }]);
    return handle.result();
  });
  expect(timedOut).toEqual({ goalStatus: "SUCCEEDED" });
  expect(steps).toBe(2);

  steps = 0;
  let continued: { goalId?: string } | undefined;
  await withWorker({
    async dotGoalStep() {
      steps += 1;
      return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
    },
    async dotGoalObserve() {
      return { run: "RUNNING", goalStatus: "ACTIVE" };
    }
  }, async (taskQueue) => {
    const handle = await start("dotGoalWorkflow", taskQueue, [{ goalId: "goal:sandbox" }]);
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    continued = continuedAsNewInput(await firstHistory(handle)) as { goalId?: string };
  });
  expect(steps).toBe(300);
  expect(continued).toEqual({ goalId: "goal:sandbox" });
}, 120_000);

function timerCount(history: Parameters<typeof historyEvents>[0], seconds: string) {
  return historyEvents(history).filter((item) => {
    const value = (item as { timerStartedEventAttributes?: { startToFireTimeout?: { seconds?: unknown } } })
      .timerStartedEventAttributes?.startToFireTimeout?.seconds;
    const text = typeof value === "object" && value !== null ? String(value) : value;
    return text === seconds || text === Number(seconds);
  }).length;
}

it("observes a running dot goal until that run finishes", async () => {
  const steps: string[] = [];
  const observes: string[] = [];
  const result = await withWorker({
    async dotGoalStep() {
      steps.push("step");
      if (steps.length === 1) return { state: "RUNNING", runId: "run:sandbox", goalStatus: "ACTIVE" };
      return { state: "DONE", runId: null, goalStatus: "SUCCEEDED" };
    },
    async dotGoalObserve(_goalId: string, runId: string) {
      observes.push(runId);
      if (observes.length < 3) return { run: "RUNNING", goalStatus: "ACTIVE" };
      return { run: "SUCCEEDED", goalStatus: "SUCCEEDED" };
    }
  }, async (taskQueue) => {
    const handle = await start("dotGoalWorkflow", taskQueue, [{ goalId: "goal:observe" }]);
    return { result: await handle.result(), history: await firstHistory(handle) };
  });
  expect(result.result).toEqual({ goalStatus: "SUCCEEDED" });
  expect(steps).toEqual(["step", "step"]);
  expect(observes).toEqual(["run:sandbox", "run:sandbox", "run:sandbox"]);
  expect(timerCount(result.history, "15")).toBe(3);
}, 60_000);

function errorText(error: unknown) {
  const parts: string[] = [];
  let current = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    parts.push(current instanceof Error ? `${current.name}: ${current.message}` : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join("\n");
}

it("fails a room-agent action through the patched failure path", async () => {
  const failures: unknown[] = [];
  let caught: unknown;
  await withWorker({
    async runRoomAgentBackgroundAction() {
      throw ApplicationFailure.nonRetryable("background action failed");
    },
    async failRoomAgentBackgroundAction(input: unknown) {
      failures.push(input);
    }
  }, async (taskQueue) => {
    const handle = await start("roomAgentActionWorkflow", taskQueue, [{
      bridge: { roomId: ROOM, missionId: MISSION },
      traceId: "trace:action1",
      actionId: "action:sandbox"
    }], "space-room-action:action:sandbox");
    try {
      await handle.result();
    } catch (error) {
      caught = error;
    }
  });
  expect(errorText(caught)).toContain("background action failed");
  expect(failures).toEqual([{
    roomId: ROOM,
    missionId: MISSION,
    actionId: "action:sandbox",
    cancelled: false
  }]);
}, 60_000);

it("records a legacy room-agent action failure under the workflow id", async () => {
  const failures: unknown[] = [];
  let caught: unknown;
  await withWorker({
    async runRoomAgentBackgroundAction() {
      throw ApplicationFailure.nonRetryable("transport failed");
    },
    async failRoomAgentBackgroundAction(input: unknown) {
      failures.push(input);
    }
  }, async (taskQueue) => {
    const handle = await start("roomAgentActionWorkflow", taskQueue, [{
      bridge: { roomId: ROOM, missionId: MISSION },
      traceId: "trace:legacy"
    }], "space-room-action:action:legacy");
    try {
      await handle.result();
    } catch (error) {
      caught = error;
    }
  });
  expect(errorText(caught)).toContain("transport failed");
  expect(failures).toEqual([{
    roomId: ROOM,
    missionId: MISSION,
    actionId: "action:legacy",
    cancelled: false
  }]);
}, 60_000);

it("persists a legacy room-agent action failure after the activity retries are exhausted", async () => {
  const attempts: number[] = [];
  const failures: unknown[] = [];
  let caught: unknown;
  await withWorker({
    async runRoomAgentBackgroundAction() {
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      throw ApplicationFailure.retryable("transport failed");
    },
    async failRoomAgentBackgroundAction(input: unknown) {
      failures.push(input);
    }
  }, async (taskQueue) => {
    const handle = await start("roomAgentActionWorkflow", taskQueue, [{
      bridge: { roomId: ROOM, missionId: MISSION },
      traceId: "trace:retry"
    }], "space-room-action:action:legacy");
    try {
      await handle.result();
    } catch (error) {
      caught = error;
    }
  });
  expect(attempts).toEqual([1, 2, 3, 4, 5]);
  expect(failures).toEqual([{
    roomId: ROOM,
    missionId: MISSION,
    actionId: "action:legacy",
    cancelled: false
  }]);
  expect(errorText(caught)).toContain("transport failed");
}, 60_000);

function supervisorActivities(log: Array<Record<string, unknown>>) {
  return {
    async checkRoomAgentSupervisorTurn(item: unknown) {
      log.push({ activity: "checkRoomAgentSupervisorTurn", item });
      return "RUN";
    },
    async discardRoomAgentSupervisorTurn(input: unknown) {
      log.push({ activity: "discardRoomAgentSupervisorTurn", input });
    },
    async finishRoomAgentSupervisorTurn(input: unknown) {
      log.push({ activity: "finishRoomAgentSupervisorTurn", input });
    },
    async prepareRoomAgentBackgroundContinuation(input: unknown) {
      log.push({ activity: "prepareRoomAgentBackgroundContinuation", input });
      return { state: "LATER" };
    },
    async runCodexAppServerTurn(input: { traceId: string }) {
      log.push({ activity: "runCodexAppServerTurn", traceId: input.traceId });
      return {
        ...completedTurn(input.traceId),
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified." }
      };
    }
  };
}

it("enqueues, stops, and interrupts a room-agent supervisor, then continues as new", async () => {
  const log: Array<Record<string, unknown>> = [];
  let releaseRunning: (() => void) | undefined;
  const running = new Promise<void>((resolve) => { releaseRunning = resolve; });
  const activities = supervisorActivities(log);
  const queued = turn({ traceId: "trace:queued1", prompt: "Operator follow-up", agentRunId: "agent:queued01" });
  await withWorker(activities, async (taskQueue) => {
    const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: ROOM,
      pending: [],
      monitoringMissionIds: [MISSION],
      processedCount: 49
    }]);
    await handle.signal("enqueueRoomAgentMission", { missionId: MISSION, turn: queued });
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    const carried = continuedAsNewInput(await firstHistory(handle)) as {
      processedCount: number;
      roomId: string;
      pending?: unknown[];
      interrupted?: unknown[];
      monitoringMissionIds?: string[];
    };
    expect(carried).toMatchObject({
      roomId: ROOM,
      processedCount: 0,
      pending: [],
      interrupted: [],
      monitoringMissionIds: [MISSION]
    });
  });
  expect(log.some((entry) => entry.activity === "runCodexAppServerTurn" && entry.traceId === "trace:queued1")).toBe(true);

  log.length = 0;
  activities.checkRoomAgentSupervisorTurn = async (item: { turn: { traceId: string } }) => {
    log.push({ activity: "checkRoomAgentSupervisorTurn", traceId: item.turn.traceId });
    if (item.turn.traceId === "trace:running") {
      releaseRunning?.();
      await new Promise((_resolve, reject) => {
        Context.current().cancelled.catch((error: unknown) => reject(error));
      });
    }
    return "RUN";
  };
  await withWorker(activities, async (taskQueue) => {
    const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: ROOM,
      pending: [{ missionId: MISSION, turn: turn({ traceId: "trace:running", agentRunId: "agent:running" }) }],
      processedCount: 49
    }]);
    await running;
    await handle.signal("stopRoomAgentMission", { missionId: null, reason: "Stop the running mission." });
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
  });
  const finished = log.find((entry) => entry.activity === "finishRoomAgentSupervisorTurn");
  expect(finished?.input).toMatchObject({ status: "INTERRUPTED", statusReason: "Stop the running mission." });
}, 60_000);

it("carries an interrupted turn into the next run and finishes it before pending work", async () => {
  const log: Array<Record<string, unknown>> = [];
  const activities = supervisorActivities(log);
  const drained = {
    item: { missionId: MISSION, turn: turn({ traceId: "trace:drained", agentRunId: "agent:drained1" }) },
    reason: "Stopped before the next run."
  };
  const kept = {
    item: { missionId: MISSION, turn: turn({ traceId: "trace:kept", agentRunId: "agent:kept0001" }) },
    reason: "Superseded by a newer operator request."
  };
  const pendingTurn = turn({ traceId: "trace:pending", agentRunId: "agent:pending1", prompt: "Operator follow-up" });
  let carried: {
    pending?: Array<{ turn?: { traceId?: string } }>;
    interrupted?: Array<{ reason?: string; item?: { turn?: { traceId?: string } } }>;
    processedCount?: number;
  } | undefined;
  await withWorker(activities, async (taskQueue) => {
    const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: ROOM,
      pending: [{ missionId: MISSION, turn: pendingTurn }],
      interrupted: [drained, kept],
      processedCount: 49
    }]);
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    carried = continuedAsNewInput(await firstHistory(handle)) as typeof carried;
  });
  expect(log.map((entry) => entry.activity)).toEqual([
    "discardRoomAgentSupervisorTurn",
    "finishRoomAgentSupervisorTurn"
  ]);
  expect(log[1]?.input).toMatchObject({
    status: "INTERRUPTED",
    statusReason: "Stopped before the next run.",
    item: { turn: { traceId: "trace:drained" } }
  });
  expect(carried?.processedCount).toBe(0);
  expect(carried?.pending).toHaveLength(1);
  expect(carried?.pending?.[0]?.turn?.traceId).toBe("trace:pending");
  expect(carried?.interrupted).toHaveLength(1);
  expect(carried?.interrupted?.[0]?.item?.turn?.traceId).toBe("trace:kept");
  expect(carried?.interrupted?.[0]?.reason).toBe("Superseded by a newer operator request.");
  expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)))).not.toThrow();

  log.length = 0;
  await withWorker(activities, async (taskQueue) => {
    const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [carried]);
    const started = Date.now();
    try {
      while (!log.some((entry) => entry.activity === "runCodexAppServerTurn" && entry.traceId === "trace:pending")) {
        if (Date.now() - started > 20_000) throw new Error("pending turn did not start after the carried interruption");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await handle.terminate();
    }
  });
  const events = log.map((entry) => entry.activity === "runCodexAppServerTurn"
    ? `run:${String(entry.traceId)}`
    : entry.activity === "finishRoomAgentSupervisorTurn"
      ? `finish:${String((entry.input as { item?: { turn?: { traceId?: string } } }).item?.turn?.traceId)}:${String((entry.input as { status?: string }).status)}`
      : String(entry.activity));
  expect(events.indexOf("finish:trace:kept:INTERRUPTED")).toBeGreaterThanOrEqual(0);
  expect(events.indexOf("finish:trace:kept:INTERRUPTED")).toBeLessThan(events.indexOf("run:trace:pending"));
  expect(log.find((entry) => entry.activity === "finishRoomAgentSupervisorTurn" && (entry.input as { item?: { turn?: { traceId?: string } } }).item?.turn?.traceId === "trace:kept")?.input).toMatchObject({
    status: "INTERRUPTED",
    statusReason: "Superseded by a newer operator request."
  });
}, 60_000);

function maintenanceResult() {
  return {
    status: "REFRESHED",
    generatedAt: "2026-10-20T12:00:00.000Z",
    sourceHash: HASH,
    previousSourceHash: null,
    summary: { nodes: 0, edges: 0 },
    durationMs: 1
  };
}

it("keeps memory maintenance going when refresh or reconciliation fails, and runs consolidation as a child", async () => {
  const calls: string[] = [];
  const result = await withWorker({
    async refreshMemoryGraphSnapshot() {
      calls.push("refresh");
      return maintenanceResult();
    },
    async refreshAllMonthsMemoryGraphSnapshot() {
      calls.push("all-months");
      throw ApplicationFailure.nonRetryable("all-months refresh failed");
    },
    async reconcileStaleSpaceAgentSessions() {
      calls.push("reconcile");
      throw ApplicationFailure.nonRetryable("session reconciliation failed");
    },
    async createScheduledMemoryAudit() {
      calls.push("audit");
      return { id: "audit:sandbox", workflowId: `memory-child-${calls.length}` };
    },
    async prepareMemoryConsolidation() {
      calls.push("prepare");
      return { changeSetId: null, run: { id: "run:sandbox01" } };
    },
    async finalizeMemoryRepair() {
      calls.push("finalize");
      return { id: "run:sandbox01" };
    },
    async executePersistedMemoryChangeSet() {
      calls.push("mutate");
      return { status: "APPLIED" };
    }
  }, async (taskQueue) => {
    const handle = await start("memoryMaintenanceWorkflow", taskQueue, [{
      scheduledAt: "2026-10-20T12:00:00.000Z",
      traceId: "trace:memory1"
    }]);
    const result = await handle.result();
    return { result, history: await handle.fetchHistory() };
  }, { workflowsPath: maintenanceWorkflowsPath, taskQueue: "space-memory-maintenance" });
  expect(result.result).toMatchObject({ status: "REFRESHED", sourceHash: HASH });
  expect(calls).toEqual(["refresh", "all-months", "reconcile", "audit", "prepare"]);
  const children = historyEvents(result.history).flatMap((item) => {
    const attrs = (item as { startChildWorkflowExecutionInitiatedEventAttributes?: { workflowId?: string; workflowType?: { name?: string } } }).startChildWorkflowExecutionInitiatedEventAttributes;
    return attrs ? [{ workflowId: attrs.workflowId, name: attrs.workflowType?.name }] : [];
  });
  expect(children).toEqual([{ workflowId: "memory-child-4", name: "memoryConsolidationWorkflow" }]);
}, 60_000);

it("retries a failed all-months refresh and still finishes maintenance", async () => {
  const attempts: number[] = [];
  const calls: string[] = [];
  const result = await withWorker({
    async refreshMemoryGraphSnapshot() {
      calls.push("refresh");
      return maintenanceResult();
    },
    async refreshAllMonthsMemoryGraphSnapshot() {
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      throw ApplicationFailure.retryable("all-months refresh failed");
    },
    async reconcileStaleSpaceAgentSessions() {
      calls.push("reconcile");
    },
    async createScheduledMemoryAudit() {
      calls.push("audit");
      return { id: "audit:sandbox", workflowId: "memory-child-retry" };
    },
    async prepareMemoryConsolidation() {
      calls.push("prepare");
      return { changeSetId: null, run: { id: "run:sandbox01" } };
    }
  }, async (taskQueue) => {
    const handle = await start("memoryMaintenanceWorkflow", taskQueue, [{
      scheduledAt: "2026-10-20T12:00:00.000Z",
      traceId: "trace:memory-retry"
    }]);
    return handle.result();
  }, { workflowsPath: maintenanceWorkflowsPath, taskQueue: "space-memory-maintenance" });
  expect(attempts).toEqual([1, 2, 3]);
  expect(result).toMatchObject({ status: "REFRESHED", sourceHash: HASH });
  expect(calls).toEqual(["refresh", "reconcile", "audit", "prepare"]);
}, 60_000);

it("retries the live memory snapshot and then finishes maintenance", async () => {
  const attempts: number[] = [];
  const calls: string[] = [];
  const result = await withWorker({
    async refreshMemoryGraphSnapshot() {
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      if (attempt < 3) throw ApplicationFailure.retryable("snapshot not ready");
      calls.push("refresh");
      return maintenanceResult();
    },
    async refreshAllMonthsMemoryGraphSnapshot() {
      calls.push("all-months");
    },
    async reconcileStaleSpaceAgentSessions() {
      calls.push("reconcile");
    },
    async createScheduledMemoryAudit() {
      calls.push("audit");
      return { id: "audit:sandbox", workflowId: "memory-child-snapshot" };
    },
    async prepareMemoryConsolidation() {
      calls.push("prepare");
      return { changeSetId: null, run: { id: "run:sandbox01" } };
    }
  }, async (taskQueue) => {
    const handle = await start("memoryMaintenanceWorkflow", taskQueue, [{
      scheduledAt: "2026-10-20T12:00:00.000Z",
      traceId: "trace:memory-snapshot"
    }]);
    return handle.result();
  }, { workflowsPath: maintenanceWorkflowsPath, taskQueue: "space-memory-maintenance" });
  expect(attempts).toEqual([1, 2, 3]);
  expect(result).toMatchObject({ status: "REFRESHED", sourceHash: HASH });
  expect(calls).toEqual(["refresh", "all-months", "reconcile", "audit", "prepare"]);
}, 60_000);

it("runs the maintenance consolidation child through the mutation queue", async () => {
  const calls: string[] = [];
  const result = await withWorker({
    async refreshMemoryGraphSnapshot() {
      calls.push("refresh");
      return maintenanceResult();
    },
    async refreshAllMonthsMemoryGraphSnapshot() {
      calls.push("all-months");
    },
    async reconcileStaleSpaceAgentSessions() {
      calls.push("reconcile");
    },
    async createScheduledMemoryAudit() {
      calls.push("audit");
      return { id: "audit:sandbox", workflowId: "memory-child-from-maintenance" };
    },
    async prepareMemoryConsolidation() {
      calls.push("prepare");
      return { changeSetId: "change:sandbox", run: { id: "run:sandbox01" } };
    },
    async finalizeMemoryRepair(input: unknown) {
      calls.push("finalize");
      return input;
    }
  }, async (taskQueue) => {
    const handle = await start("memoryMaintenanceWorkflow", taskQueue, [{
      scheduledAt: "2026-10-20T12:00:00.000Z",
      traceId: "trace:memory-mutate"
    }]);
    return handle.result();
  }, {
    workflowsPath: maintenanceWorkflowsPath,
    taskQueue: "space-memory-maintenance",
    extras: [{
      taskQueue: "space-memory-mutations",
      activities: {
        async executePersistedMemoryChangeSet(input: unknown) {
          calls.push("mutate");
          return input;
        }
      }
    }]
  });
  expect(calls).toEqual(["refresh", "all-months", "reconcile", "audit", "prepare", "mutate", "finalize"]);
  expect(result).toMatchObject({ status: "REFRESHED", sourceHash: HASH });
}, 60_000);

it("retries a memory mutation and runs consolidation through the mutation queue", async () => {
  const attempts: number[] = [];
  const mutation = await withWorker({
    async executePersistedMemoryChangeSet() {
      const attempt = Context.current().info.attempt;
      attempts.push(attempt);
      if (attempt < 3) throw ApplicationFailure.retryable("mutation not ready");
      return { status: "APPLIED", changeSetId: "change:sandbox", resultingSourceHash: HASH, reason: null };
    }
  }, async (taskQueue) => {
    const handle = await start("memoryMutationWorkflow", taskQueue, [{
      changeSetId: "change:sandbox",
      traceId: "trace:mutation"
    }]);
    return handle.result();
  }, { workflowsPath: mutationWorkflowsPath });
  expect(attempts).toEqual([1, 2, 3]);
  expect(mutation).toMatchObject({ status: "APPLIED", resultingSourceHash: HASH });

  const childCalls: string[] = [];
  const consolidated = await withWorker({
    async prepareMemoryConsolidation() {
      childCalls.push("prepare");
      return { changeSetId: "change:sandbox", run: { id: "run:sandbox01" } };
    },
    async finalizeMemoryRepair(input: unknown) {
      childCalls.push("finalize");
      return input;
    }
  }, async (taskQueue) => {
    const handle = await start("memoryConsolidationWorkflow", taskQueue, [{
      runId: "run:sandbox01",
      traceId: "trace:consolidate"
    }]);
    return handle.result();
  }, {
    workflowsPath: maintenanceWorkflowsPath,
    extras: [{
      taskQueue: "space-memory-mutations",
      activities: {
        async executePersistedMemoryChangeSet(input: unknown) {
          childCalls.push("mutate");
          return input;
        }
      }
    }]
  });
  expect(childCalls).toEqual(["prepare", "mutate", "finalize"]);
  expect(consolidated).toMatchObject({ runId: "run:sandbox01", changeSetId: "change:sandbox" });
}, 60_000);

function carryItem(index: number) {
  const roomId = "room:carry01";
  return {
    missionId: "mission:carry01",
    turn: turn({
      roomId,
      paneId: "pane:carry01",
      prompt: `Queued request ${index}`,
      agentRunId: `agent:carry${String(index).padStart(3, "0")}`,
      traceId: `trace:carry${String(index).padStart(3, "0")}`
    })
  };
}

it("drains a flooded supervisor queue until the next run can parse it", async () => {
  let flooded = false;
  let checks = 0;
  let handle: { signal: (name: string, payload: unknown) => Promise<void> } | undefined;
  let carried: { pending?: unknown[]; processedCount?: number } | undefined;
  await withWorker({
    async checkRoomAgentSupervisorTurn() {
      checks += 1;
      if (!flooded) {
        flooded = true;
        for (let index = 1; index <= 105; index += 1) {
          await handle!.signal("enqueueRoomAgentMission", carryItem(index));
        }
      }
      return "SKIP";
    },
    async discardRoomAgentSupervisorTurn() {}
  }, async (taskQueue) => {
    handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: "room:carry01",
      pending: [carryItem(0)],
      processedCount: 49
    }]);
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    carried = continuedAsNewInput(await firstHistory(handle)) as typeof carried;
  });
  expect(checks).toBe(6);
  expect(carried?.pending).toHaveLength(100);
  expect(carried?.processedCount).toBe(0);
  expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)))).not.toThrow();
}, 60_000);

it("settles one legacy monitoring mission when the boolean activity returns true", async () => {
  const original = await readFile(workflowSourcePath, "utf8");
  const needle = 'if (!patched("room-background-continuation-v1")) return legacyRoomAgentSupervisorWorkflow(rawInput);';
  expect(original).toContain(needle);
  const legacyPath = path.join(path.dirname(workflowSourcePath), "workflows.legacy-settle.ts");
  const settled: boolean[] = [];
  const prepared: string[] = [];
  try {
    // A copy, not workflows.ts. The pre-patch poll file reads that source at the same time.
    await writeFile(legacyPath, original.replace(needle, "return legacyRoomAgentSupervisorWorkflow(rawInput);"));
    let notifySettled = () => {};
    const once = new Promise<void>((resolve) => {
      notifySettled = resolve;
    });
    const history = await withWorker({
      async settleRoomAgentBackgroundMission() {
        settled.push(true);
        notifySettled();
        return true;
      },
      async prepareRoomAgentBackgroundContinuation() {
        prepared.push("prepare");
        return { state: "LATER" };
      }
    }, async (taskQueue) => {
      const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
        roomId: ROOM,
        pending: [],
        monitoringMissionIds: [MISSION],
        processedCount: 0
      }], "workflow:legacy-settle-true");
      await once;
      const fetched = await firstHistory(handle);
      await handle.terminate();
      return fetched;
    }, { workflowsPath: legacyPath });
    const text = readableHistory(history);
    expect(settled).toEqual([true]);
    expect(prepared).toEqual([]);
    expect(scheduledActivityCount(history as { events?: Array<{ activityTaskScheduledEventAttributes?: { activityType?: { name?: string } } }> }, "settleRoomAgentBackgroundMission")).toBe(1);
    expect(text).not.toContain("prepareRoomAgentBackgroundContinuation");
    expect(text).not.toContain("room-background-continuation-v1");
    expect(() => continuedAsNewInput(history)).toThrow(/no continue-as-new/);
  } finally {
    await rm(legacyPath, { force: true });
    expect(await readFile(workflowSourcePath, "utf8")).toBe(original);
  }
}, 60_000);

it("records a child failure code and discards a continuation stopped while it is prepared", async () => {
  const finished: Array<Record<string, unknown>> = [];
  await withWorker({
    async checkRoomAgentSupervisorTurn() {
      return "RUN";
    },
    async runCodexAppServerTurn() {
      throw ApplicationFailure.nonRetryable("timed out", "CODEX_APP_SERVER_TURN_TIMEOUT");
    },
    async discardRoomAgentSupervisorTurn() {},
    async finishRoomAgentSupervisorTurn(input: Record<string, unknown>) {
      finished.push(input);
    }
  }, async (taskQueue) => {
    const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: ROOM,
      pending: [{ missionId: MISSION, turn: turn({ traceId: "trace:failcode", agentRunId: "agent:failcode" }) }],
      processedCount: 49
    }]);
    await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
  });
  expect(finished).toEqual([expect.objectContaining({
    status: "FAILED",
    errorCode: "CODEX_APP_SERVER_TURN_TIMEOUT"
  })]);

  let releasePrepare: (() => void) | undefined;
  const prepareHeld = new Promise<void>((resolve) => { releasePrepare = resolve; });
  let sawPrepare: (() => void) | undefined;
  const prepareStarted = new Promise<void>((resolve) => { sawPrepare = resolve; });
  const discarded: unknown[] = [];
  let supervisor: { signal: (name: string, payload: unknown) => Promise<void>; terminate: () => Promise<void> } | undefined;
  await withWorker({
    async prepareRoomAgentBackgroundContinuation() {
      sawPrepare?.();
      await prepareHeld;
      return {
        state: "READY",
        item: {
          missionId: MISSION,
          turn: turn({
            traceId: "trace:auto001",
            agentRunId: "agent:auto0001",
            roomAgentContinuation: { sourceRunId: "agent:source1", generation: 1 }
          })
        }
      };
    },
    async discardRoomAgentSupervisorTurn(input: unknown) {
      discarded.push(input);
    },
    async finishRoomAgentSupervisorTurn() {}
  }, async (taskQueue) => {
    supervisor = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: ROOM,
      pending: [],
      monitoringMissionIds: [MISSION]
    }]);
    await prepareStarted;
    await supervisor.signal("stopRoomAgentMission", { missionId: null, reason: "Stop" });
    releasePrepare?.();
    const started = Date.now();
    try {
      while (discarded.length === 0) {
        if (Date.now() - started > 20_000) throw new Error("discard did not run after the stop signal");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(discarded).toEqual([expect.objectContaining({
        reason: "Superseded while preparing the automatic continuation."
      })]);
    } finally {
      await supervisor.terminate();
    }
  });
}, 60_000);

it("carries a prepared continuation into the next run and starts it once", async () => {
  const children: string[] = [];
  const prepared = {
    missionId: MISSION,
    turn: turn({
      traceId: "trace:prepared",
      agentRunId: "agent:prepared",
      roomAgentContinuation: { sourceRunId: "agent:source1", generation: 1 }
    })
  };
  let carried: { pending?: Array<{ turn?: { traceId?: string } }>; processedCount?: number } | undefined;
  await withWorker({
    async prepareRoomAgentBackgroundContinuation() {
      return { state: "READY", item: prepared };
    },
    async checkRoomAgentSupervisorTurn() {
      return "RUN";
    },
    async runCodexAppServerTurn(input: { traceId: string }) {
      children.push(input.traceId);
      return {
        ...completedTurn(input.traceId),
        roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified." }
      };
    },
    async finishRoomAgentSupervisorTurn() {}
  }, async (taskQueue) => {
    const first = await start("roomAgentSupervisorWorkflow", taskQueue, [{
      roomId: ROOM,
      pending: [],
      monitoringMissionIds: [MISSION],
      processedCount: 50
    }]);
    await expect(first.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    carried = continuedAsNewInput(await firstHistory(first)) as typeof carried;
    expect(children).toEqual([]);
    const started = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (children.length) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    const second = await start("roomAgentSupervisorWorkflow", taskQueue, [carried]);
    await started;
    await second.terminate();
  });
  expect(carried?.pending).toHaveLength(1);
  expect(carried?.processedCount).toBe(0);
  expect(children).toEqual(["trace:prepared"]);
}, 60_000);

it("replays recorded histories and rejects an extra timer", async () => {
  const files = (await readdir(historiesDir)).filter((name) => name.endsWith(".json")).sort();
  expect(files.length).toBeGreaterThanOrEqual(8);
  const loaded = await Promise.all(files.map(async (name) => {
    const parsed = JSON.parse(await readFile(path.join(historiesDir, name), "utf8")) as {
      workflowId: string;
      history: Record<string, unknown>;
    };
    const history = proto.temporal.api.history.v1.History.fromObject(parsed.history);
    return { name, workflowId: parsed.workflowId, history, raw: parsed.history };
  }));
  const prePatch = loaded.find((item) => item.name === "supervisor-pre-patch.json");
  expect(prePatch, "run temporal:record-histories to write the pre-patch supervisor history").toBeTruthy();
  const prePatchText = readableHistory(prePatch?.raw);
  expect(prePatchText).toContain("markRoomAgentMissionStarted");
  expect(prePatchText).not.toContain("room-background-continuation-v1");
  expect(scheduledActivityCount(prePatch?.raw, "markRoomAgentMissionStarted")).toBe(1);
  expect(savedContinueAsNewInput(prePatch?.raw)).toMatchObject({
    roomId: ROOM,
    pending: [],
    processedCount: 0
  });
  const prePatchPolls = loaded.find((item) => item.name === "supervisor-pre-patch-polls.json");
  expect(prePatchPolls, "run temporal:record-histories to write the pre-patch 250-poll history").toBeTruthy();
  const prePatchPollsText = readableHistory(prePatchPolls?.raw);
  expect(prePatchPollsText).toContain("settleRoomAgentBackgroundMission");
  expect(prePatchPollsText).not.toContain("room-background-continuation-v1");
  expect(scheduledActivityCount(prePatchPolls?.raw, "settleRoomAgentBackgroundMission")).toBe(250);
  expect(savedContinueAsNewInput(prePatchPolls?.raw)).toMatchObject({
    roomId: ROOM,
    pending: [],
    monitoringMissionIds: [MISSION],
    processedCount: 0
  });
  const currentSupervisor = loaded.find((item) => item.name === "supervisor-current.json");
  expect(readableHistory(currentSupervisor?.raw)).toContain("room-background-continuation-v1");

  const groups = [
    { workflowsPath, names: loaded.filter((item) => !item.name.startsWith("memory-")) },
    { workflowsPath: maintenanceWorkflowsPath, names: loaded.filter((item) => item.name === "memory-maintenance.json" || item.name === "memory-consolidation.json") },
    { workflowsPath: mutationWorkflowsPath, names: loaded.filter((item) => item.name === "memory-mutation.json") }
  ];
  for (const group of groups) {
    const byId = new Map(group.names.map((item) => [item.workflowId, item]));
    const results = Worker.runReplayHistories({ workflowsPath: group.workflowsPath }, group.names.map((item) => ({
      workflowId: item.workflowId,
      history: item.history
    })));
    for await (const result of results) {
      const item = byId.get(result.workflowId);
      const file = item?.name ?? "unknown-history.json";
      const workflowId = result.workflowId || item?.workflowId || "";
      expect(result.error, `${file} ${workflowId} ${result.error?.message ?? ""}`).toBeUndefined();
    }
  }

  const dummy = loaded.find((item) => item.name === "dummy-turn.json");
  const negativeLabel = `dummy-turn.json ${dummy?.workflowId ?? ""} dummyTurnWorkflow`;
  await expect(
    Worker.runReplayHistory(
      { workflowsPath: negativeWorkflowsPath },
      dummy?.history,
      dummy?.workflowId
    ),
    negativeLabel
  ).rejects.toBeInstanceOf(DeterminismViolationError);
}, 120_000);

it.skipIf(!recordHistories)("records the workflow histories", async () => {
  const original = await readFile(workflowSourcePath, "utf8");
  const needle = 'if (!patched("room-background-continuation-v1")) return legacyRoomAgentSupervisorWorkflow(rawInput);';
  expect(original).toContain(needle);
  const legacyRecordPath = path.join(path.dirname(workflowSourcePath), "workflows.legacy-record.ts");
  try {
    const dummy = await withWorker({
      async recordDummyTurnStarted() {},
      async recordDummyTurnCompleted(input: { traceId: string }) {
        return completedTurn(input.traceId);
      }
    }, async (taskQueue) => {
      const handle = await start("dummyTurnWorkflow", taskQueue, [turn({ traceId: "trace:dummy01" })], "workflow:dummy:record");
      await handle.result();
      return handle;
    });
    await saveHistory("dummy-turn", dummy.workflowId, await firstHistory(dummy));

    const codexActivities = {
      async runOpenCodeAgentTurn(input: { traceId: string }) { return completedTurn(input.traceId); },
      async runCliAgentTurn(input: { traceId: string }) { return completedTurn(input.traceId); },
      async runCodexAppServerTurn(input: { traceId: string }) { return completedTurn(input.traceId); }
    };
    const codexCases = [
      ["codex-opencode", turn({ providerId: "opencode", traceId: "trace:opencode" })],
      ["codex-cli", turn({ providerId: "cli:claude", traceId: "trace:cli0001" })],
      ["codex-native", turn({ agentSessionId: "agent:session", agentAssistantMessageId: "agent:message", traceId: "trace:native01" })],
      ["codex-room", turn({ roomAgentMissionId: MISSION, traceId: "trace:room0001" })]
    ] as const;
    for (const [name, input] of codexCases) {
      const handle = await withWorker(codexActivities, async (taskQueue) => {
        const started = await start("codexAppServerTurnWorkflow", taskQueue, [input], `workflow:${name}`);
        await started.result();
        return started;
      });
      await saveHistory(name, handle.workflowId, await firstHistory(handle));
    }

    const dot = await withWorker({
      async dotGoalStep() { return { state: "DONE", runId: null, goalStatus: "SUCCEEDED" }; },
      async dotGoalObserve() { return { run: "SUCCEEDED", goalStatus: "SUCCEEDED" }; }
    }, async (taskQueue) => {
      const handle = await start("dotGoalWorkflow", taskQueue, [{ goalId: "goal:sandbox" }], "workflow:dot-goal");
      await handle.result();
      return handle;
    });
    await saveHistory("dot-goal", dot.workflowId, await firstHistory(dot));

    const action = await withWorker({
      async runRoomAgentBackgroundAction() { throw ApplicationFailure.nonRetryable("background action failed"); },
      async failRoomAgentBackgroundAction() {}
    }, async (taskQueue) => {
      const handle = await start("roomAgentActionWorkflow", taskQueue, [{
        bridge: { roomId: ROOM, missionId: MISSION },
        traceId: "trace:action1",
        actionId: "action:sandbox"
      }], "space-room-action:action:sandbox");
      await handle.result().catch(() => undefined);
      return handle;
    });
    await saveHistory("room-action-failure", action.workflowId, await firstHistory(action));

    const current = await withWorker(supervisorActivities([]), async (taskQueue) => {
      const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
        roomId: ROOM,
        pending: [{ missionId: MISSION, turn: turn({ traceId: "trace:current", agentRunId: "agent:current" }) }],
        processedCount: 49
      }], "workflow:supervisor-current");
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
      return handle;
    });
    await saveHistory("supervisor-current", current.workflowId, await firstHistory(current));

    const maintenance = await withWorker({
      async refreshMemoryGraphSnapshot() { return maintenanceResult(); },
      async refreshAllMonthsMemoryGraphSnapshot() { throw ApplicationFailure.nonRetryable("all-months refresh failed"); },
      async reconcileStaleSpaceAgentSessions() { throw ApplicationFailure.nonRetryable("session reconciliation failed"); },
      async createScheduledMemoryAudit() { return { id: "audit:sandbox", workflowId: "memory-child-record" }; },
      async prepareMemoryConsolidation() { return { changeSetId: null, run: { id: "run:sandbox01" } }; }
    }, async (taskQueue) => {
      const handle = await start("memoryMaintenanceWorkflow", taskQueue, [{
        scheduledAt: "2026-10-20T12:00:00.000Z",
        traceId: "trace:memory1"
      }], "workflow:memory-maintenance");
      await handle.result();
      return handle;
    }, { workflowsPath: maintenanceWorkflowsPath, taskQueue: "space-memory-maintenance" });
    await saveHistory("memory-maintenance", maintenance.workflowId, await firstHistory(maintenance));

    const consolidation = await withWorker({
      async prepareMemoryConsolidation() { return { changeSetId: "change:sandbox", run: { id: "run:sandbox01" } }; },
      async finalizeMemoryRepair(input: unknown) { return input; }
    }, async (taskQueue) => {
      const handle = await start("memoryConsolidationWorkflow", taskQueue, [{
        runId: "run:sandbox01",
        traceId: "trace:consolidate"
      }], "workflow:memory-consolidation");
      await handle.result();
      return handle;
    }, {
      workflowsPath: maintenanceWorkflowsPath,
      extras: [{
        taskQueue: "space-memory-mutations",
        activities: { async executePersistedMemoryChangeSet(input: unknown) { return input; } }
      }]
    });
    await saveHistory("memory-consolidation", consolidation.workflowId, await firstHistory(consolidation));

    const mutationAttempts: number[] = [];
    const mutation = await withWorker({
      async executePersistedMemoryChangeSet() {
        const attempt = Context.current().info.attempt;
        mutationAttempts.push(attempt);
        if (attempt < 3) throw ApplicationFailure.retryable("mutation not ready");
        return { status: "APPLIED", changeSetId: "change:sandbox", resultingSourceHash: HASH, reason: null };
      }
    }, async (taskQueue) => {
      const handle = await start("memoryMutationWorkflow", taskQueue, [{
        changeSetId: "change:sandbox",
        traceId: "trace:mutation"
      }], "workflow:memory-mutation");
      await handle.result();
      return handle;
    }, { workflowsPath: mutationWorkflowsPath });
    expect(mutationAttempts).toEqual([1, 2, 3]);
    await saveHistory("memory-mutation", mutation.workflowId, await firstHistory(mutation));

    // A copy, not workflows.ts. Killing this recorder must not leave the production source on the legacy branch.
    await writeFile(legacyRecordPath, original.replace(needle, "return legacyRoomAgentSupervisorWorkflow(rawInput);"));
    const legacyCalls: string[] = [];
    const legacy = await withWorker({
      async markRoomAgentMissionStarted() { legacyCalls.push("started"); },
      async markRoomAgentMissionFinished() { legacyCalls.push("finished"); },
      async markRoomAgentMissionContinued() { legacyCalls.push("continued"); },
      async runCodexAppServerTurn(input: { traceId: string }) {
        legacyCalls.push("turn");
        return {
          ...completedTurn(input.traceId),
          roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified." }
        };
      }
    }, async (taskQueue) => {
      const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
        roomId: ROOM,
        pending: [{ missionId: MISSION, turn: turn({ traceId: "trace:legacy1", agentRunId: "agent:legacy01" }) }],
        processedCount: 49
      }], "workflow:supervisor-pre-patch");
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
      return handle;
    }, { workflowsPath: legacyRecordPath });
    expect(legacyCalls).toEqual(["started", "turn", "finished"]);
    await saveHistory("supervisor-pre-patch", legacy.workflowId, await firstHistory(legacy));

    let legacyPolls = 0;
    const legacyPollsRun = await withWorker({
      async settleRoomAgentBackgroundMission() {
        legacyPolls += 1;
        return false;
      }
    }, async (taskQueue) => {
      const handle = await start("roomAgentSupervisorWorkflow", taskQueue, [{
        roomId: ROOM,
        pending: [],
        monitoringMissionIds: [MISSION],
        processedCount: 0
      }], "workflow:supervisor-pre-patch-polls");
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
      return handle;
    }, { workflowsPath: legacyRecordPath });
    expect(legacyPolls).toBe(250);
    await saveHistory("supervisor-pre-patch-polls", legacyPollsRun.workflowId, await firstHistory(legacyPollsRun));
  } finally {
    await rm(legacyRecordPath, { force: true });
  }
  expect(await readFile(workflowSourcePath, "utf8")).toBe(original);
}, 180_000);
