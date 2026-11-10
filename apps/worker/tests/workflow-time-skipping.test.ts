// CORE-006 (2): real workflow code, stub activities, and an owned ephemeral server.
// No live Temporal address or namespace is accepted by this suite.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { temporal } from "@temporalio/proto";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { dotGoalWorkflowId, ROOM_AGENT_ENQUEUE_SIGNAL } from "@space/contracts";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { TemporalDotGoalWorkflowCoordinator } from "../../api/src/dot-goals.js";
import { createActivityObservabilityInterceptors } from "../src/activity-observability.js";
import { captureWorkerLogs } from "../src/worker-log.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const eventType = temporal.api.enums.v1.EventType;
let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let env: TestWorkflowEnvironment | undefined;

beforeAll(async () => {
  workflowBundle = await bundleWorkflowCode({
    workflowsPath: path.join(repoRoot, "apps/worker/src/workflows.ts"),
    webpackConfigHook: (config) => ({ ...config, resolve: { ...config.resolve,
      alias: { ...config.resolve?.alias, "@space/contracts": path.join(repoRoot, "packages/contracts/src") } } })
  });
}, 60_000);

beforeEach(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping();
  expect(env.supportsTimeSkipping).toBe(true);
}, 120_000);

afterEach(async () => {
  await env?.teardown();
  env = undefined;
}, 30_000);

it("advances Dot's 15-second polling timer before observing and completing the goal", async () => {
  const testEnv = env!;
  const calls: string[] = [];
  let steps = 0;
  const worker = await Worker.create({ connection: testEnv.nativeConnection,
    taskQueue: "core006-dot-time", workflowBundle,
    activities: {
      dotGoalStep: async ({ goalId }: { goalId: string }) => {
        expect(goalId).toBe("dot_goal:virtual-time");
        calls.push("step");
        return ++steps === 1
          ? { state: "STARTED", runId: "run:virtual-time", goalStatus: "RUNNING" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      },
      dotGoalObserve: async ({ goalId, runId }: { goalId: string; runId: string }) => {
        expect([goalId, runId]).toEqual(["dot_goal:virtual-time", "run:virtual-time"]);
        calls.push("observe");
        return { run: "COMPLETED", goalStatus: "COMPLETED" };
      }
    }
  });
  await worker.runUntil(async () => {
    const before = await testEnv.currentTimeMs();
    const handle = await testEnv.client.workflow.start("dotGoalWorkflow", {
      workflowId: "core006-dot-time", taskQueue: "core006-dot-time",
      args: [{ goalId: "dot_goal:virtual-time" }], workflowExecutionTimeout: "2 minutes"
    });
    // result() unlocks the test server's virtual clock; no real 15-second sleep.
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    expect(await testEnv.currentTimeMs() - before).toBeGreaterThanOrEqual(15_000);
    expect(calls).toEqual(["step", "observe", "step"]);
    const events = (await handle.fetchHistory()).events!;
    const timers = events.filter((e) => e.eventType === eventType.EVENT_TYPE_TIMER_STARTED);
    expect(timers).toHaveLength(1);
    expect(Number(timers[0]!.timerStartedEventAttributes!.startToFireTimeout!.seconds)).toBe(15);
    expect(events.filter((e) => e.eventType === eventType.EVENT_TYPE_TIMER_FIRED)).toHaveLength(1);
    expect(events.at(-1)!.eventType).toBe(eventType.EVENT_TYPE_WORKFLOW_EXECUTION_COMPLETED);
  });
}, 30_000);

it("OBS-006: the request that created a Dot Goal reaches the workflow memo and every step activity's log line", async () => {
  const testEnv = env!;
  const taskQueue = "obs006-dot-trace";
  const goalId = "dot_goal:obs006trace";
  const traceId = "req:obs006trace";
  const inputs: unknown[] = [];
  const lines: Array<Record<string, unknown>> = [];
  const restore = captureWorkerLogs((line) => { lines.push(JSON.parse(line) as Record<string, unknown>); });
  let steps = 0;
  try {
    const worker = await Worker.create({ connection: testEnv.nativeConnection, taskQueue, workflowBundle,
      interceptors: { activity: [createActivityObservabilityInterceptors()] },
      activities: {
        dotGoalStep: async (input: unknown) => { inputs.push(input); return ++steps === 1
          ? { state: "STARTED", runId: "run:obs006trace", goalStatus: "RUNNING" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" }; },
        dotGoalObserve: async (input: unknown) => { inputs.push(input); return { run: "COMPLETED", goalStatus: "COMPLETED" }; }
      }
    });
    await worker.runUntil(async () => {
      // The API's own coordinator, as POST /api/dots/:dotId/goals uses it, against this test server.
      await new TemporalDotGoalWorkflowCoordinator({ address: testEnv.address, namespace: testEnv.namespace ?? "default", taskQueue })
        .start(goalId, traceId);
      const handle = testEnv.client.workflow.getHandle(dotGoalWorkflowId(goalId));
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect((await handle.describe()).memo).toMatchObject({ spaceTraceId: traceId });
    });
  } finally { restore(); }
  expect(inputs).toEqual([{ goalId, traceId }, { goalId, runId: "run:obs006trace", traceId }, { goalId, traceId }]);
  const started = lines.filter((line) => line.event === "activity.started");
  expect(started.map((line) => [line.activityType, line.traceId, line.goalId])).toEqual([
    ["dotGoalStep", traceId, goalId], ["dotGoalObserve", traceId, goalId], ["dotGoalStep", traceId, goalId]
  ]);
}, 30_000);

it("polls background work after the supervisor timer, then wakes from idle on an enqueue signal", async () => {
  const testEnv = env!;
  const roomId = "room:virtual-time";
  const item = { missionId: "mission:signalled", turn: {
    roomId, paneId: "pane:virtual-time", agentRunId: "agent_run:virtual-time",
    prompt: "Synthetic signal test", artifactIds: [], traceId: "req:virtual-time",
    permissionMode: null, collaborationMode: "default"
  } };
  const prepare = vi.fn(async () => ({ state: "DONE" }));
  const check = vi.fn(async () => "SKIP");
  const discard = vi.fn(async () => undefined);
  const worker = await Worker.create({ connection: testEnv.nativeConnection,
    taskQueue: "core006-supervisor-time", workflowBundle,
    activities: { prepareRoomAgentBackgroundContinuation: prepare,
      checkRoomAgentSupervisorTurn: check, discardRoomAgentSupervisorTurn: discard }
  });
  await worker.runUntil(async () => {
    const handle = await testEnv.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: "core006-supervisor-time", taskQueue: "core006-supervisor-time",
      args: [{ roomId, monitoringMissionIds: ["mission:background"] }]
    });
    try {
      // Wait until the timer exists before advancing the manually locked clock.
      await vi.waitFor(async () => {
        expect((await handle.fetchHistory()).events!.some((e) =>
          e.eventType === eventType.EVENT_TYPE_TIMER_STARTED)).toBe(true);
      }, { timeout: 10_000 });
      expect(prepare).not.toHaveBeenCalled();
      await testEnv.sleep("2 seconds");
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
      expect(prepare.mock.calls[0]).toEqual([expect.objectContaining({ roomId, missionId: "mission:background" })]);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
      await vi.waitFor(() => expect(discard).toHaveBeenCalledOnce());
      expect(check).toHaveBeenCalledWith(item);
      expect(discard).toHaveBeenCalledWith({ item, reason: "Turn is no longer active or was superseded." });
      const events = (await handle.fetchHistory()).events!;
      expect(events.filter((e) => e.eventType === eventType.EVENT_TYPE_TIMER_FIRED)).toHaveLength(1);
      expect(events.some((e) => e.workflowExecutionSignaledEventAttributes?.signalName === ROOM_AGENT_ENQUEUE_SIGNAL)).toBe(true);
    } finally {
      // Supervisors intentionally never complete; close our own execution before teardown.
      await handle.cancel();
      await expect(handle.result()).rejects.toMatchObject({ cause: { name: "CancelledFailure" } });
    }
  });
}, 30_000);
