import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dummyTurnInputSchema, DOT_GOAL_SIGNAL } from "@space/contracts";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";

describe("turns and Dot goals in the real Temporal sandbox", () => {
  let env: TestWorkflowEnvironment;
  let worker: Worker;
  let running: Promise<void>;
  const taskQueue = `turns-sandbox-${randomUUID()}`;
  const handles: Array<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["getHandle"]>> = [];
  const activities = {
    recordDummyTurnStarted: vi.fn(async (_input: unknown) => undefined),
    recordDummyTurnCompleted: vi.fn(async (_input: unknown) => ({ message: "synthetic turn", status: "COMPLETED" })),
    runCodexAppServerTurn: vi.fn(async (_input: unknown) => ({ status: "COMPLETED", message: "codex synthetic result" })),
    runOpenCodeAgentTurn: vi.fn(async (_input: unknown) => ({ status: "COMPLETED", message: "opencode synthetic result" })),
    runCliAgentTurn: vi.fn(async (_input: unknown) => ({ status: "COMPLETED", message: "cli synthetic result" })),
    runRoomAgentBackgroundAction: vi.fn(async (_input: unknown) => ({ status: "COMPLETED" })),
    failRoomAgentBackgroundAction: vi.fn(async (_input: unknown) => undefined),
    dotGoalStep: vi.fn(async (_goalId: string) => ({ state: "DONE", runId: null as string | null, goalStatus: "COMPLETE" })),
    dotGoalObserve: vi.fn(async (_goalId: string, _runId: string) => ({ run: "COMPLETED", goalStatus: "ACTIVE" }))
  };

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
    worker = await Worker.create({
      connection: env.nativeConnection, taskQueue,
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url)),
      activities
    });
    running = worker.run();
    void running.catch(() => undefined);
  }, 120_000);

  beforeEach(() => {
    for (const activity of Object.values(activities)) activity.mockReset();
    activities.recordDummyTurnStarted.mockResolvedValue(undefined);
    activities.recordDummyTurnCompleted.mockResolvedValue({ message: "synthetic turn", status: "COMPLETED" });
    activities.runCodexAppServerTurn.mockResolvedValue({ status: "COMPLETED", message: "codex synthetic result" });
    activities.runOpenCodeAgentTurn.mockResolvedValue({ status: "COMPLETED", message: "opencode synthetic result" });
    activities.runCliAgentTurn.mockResolvedValue({ status: "COMPLETED", message: "cli synthetic result" });
    activities.runRoomAgentBackgroundAction.mockResolvedValue({ status: "COMPLETED" });
    activities.failRoomAgentBackgroundAction.mockResolvedValue(undefined);
    activities.dotGoalStep.mockResolvedValue({ state: "DONE", runId: null, goalStatus: "COMPLETE" });
    activities.dotGoalObserve.mockResolvedValue({ run: "COMPLETED", goalStatus: "ACTIVE" });
  });

  afterEach(async () => {
    for (const handle of handles.splice(0)) await handle.terminate("Sandbox test complete").catch(() => undefined);
  });

  afterAll(async () => {
    try {
      if (worker) worker.shutdown();
      if (running) await running;
    } finally {
      if (env) await env.teardown();
    }
  }, 30_000);

  async function start(workflowType: string, input: unknown, workflowId = `${workflowType}-${randomUUID()}`) {
    const handle = await env.client.workflow.start(workflowType, { workflowId, taskQueue, args: [input] });
    handles.push(handle);
    return handle;
  }

  it("retries a failed dummy activity, preserves ordering and returns the completed activity result", async () => {
    activities.recordDummyTurnStarted.mockRejectedValueOnce(new Error("transient synthetic failure"));
    const input = dummyTurnInputSchema.parse({ roomId: "room:turn", paneId: "pane:turn", prompt: "synthetic", traceId: "trace:turn" });
    const handle = await start("dummyTurnWorkflow", input);
    await expect(handle.result()).resolves.toEqual({ message: "synthetic turn", status: "COMPLETED" });
    expect(activities.recordDummyTurnStarted).toHaveBeenCalledTimes(2);
    expect(activities.recordDummyTurnCompleted).toHaveBeenCalledOnce();
    expect(activities.recordDummyTurnStarted).toHaveBeenCalledWith(input);
    expect(activities.recordDummyTurnCompleted).toHaveBeenCalledWith(input);
    expect(activities.recordDummyTurnStarted.mock.invocationCallOrder.at(-1)).toBeLessThan(activities.recordDummyTurnCompleted.mock.invocationCallOrder[0]);
    await recordWorkflowHistory(handle, "dummy-turn-retry");
  }, 30_000);

  it("retries a transient Codex activity failure through the production turn workflow", async () => {
    activities.runCodexAppServerTurn.mockRejectedValueOnce(new Error("transient Codex transport failure"));
    const input = dummyTurnInputSchema.parse({
      roomId: "room:turn", paneId: "pane:turn", prompt: "synthetic", traceId: "trace:codex-retry", providerId: "codex"
    });
    const handle = await start("codexAppServerTurnWorkflow", input);
    await expect(handle.result()).resolves.toEqual({ status: "COMPLETED", message: "codex synthetic result" });
    expect(activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
    expect(activities.runCodexAppServerTurn).toHaveBeenNthCalledWith(1, input);
    expect(activities.runCodexAppServerTurn).toHaveBeenNthCalledWith(2, input);
    expect(activities.runOpenCodeAgentTurn).not.toHaveBeenCalled();
    expect(activities.runCliAgentTurn).not.toHaveBeenCalled();
    const history = await handle.fetchHistory();
    const scheduled = history.events?.find(event => event.activityTaskScheduledEventAttributes)?.activityTaskScheduledEventAttributes;
    expect(scheduled?.activityType?.name).toBe("runCodexAppServerTurn");
    expect(scheduled?.retryPolicy?.maximumAttempts).toBe(5);
    await recordWorkflowHistory(handle, "codex-app-server-turn-retry");
  }, 30_000);

  it.each([
    ["opencode", {}, "runOpenCodeAgentTurn", 40 * 60],
    ["cli:claude", {}, "runCliAgentTurn", 30 * 60],
    ["codex", {}, "runCodexAppServerTurn", 24 * 60 * 60],
    ["codex", { agentSessionId: "agent:session", agentAssistantMessageId: "message:assistant" }, "runCodexAppServerTurn", 36_500 * 24 * 60 * 60]
  ] as const)("dispatches %s turns through a real scheduled activity", async (providerId, extra, activityName, timeoutSeconds) => {
    const input = dummyTurnInputSchema.parse({ roomId: "room:turn", paneId: "pane:turn", prompt: "synthetic", traceId: "trace:turn", providerId, ...extra });
    const handle = await start("codexAppServerTurnWorkflow", input);
    await expect(handle.result()).resolves.toHaveProperty("status", "COMPLETED");
    for (const name of ["runOpenCodeAgentTurn", "runCliAgentTurn", "runCodexAppServerTurn"] as const) {
      expect(activities[name]).toHaveBeenCalledTimes(name === activityName ? 1 : 0);
    }
    expect(activities[activityName]).toHaveBeenCalledWith(input);
    const history = await handle.fetchHistory();
    const scheduled = history.events?.find(event => event.activityTaskScheduledEventAttributes)?.activityTaskScheduledEventAttributes;
    expect(scheduled?.activityType?.name).toBe(activityName);
    const started = history.events?.find(event => event.workflowExecutionStartedEventAttributes)?.workflowExecutionStartedEventAttributes;
    const runTimeoutSeconds = Number(started?.workflowRunTimeout?.seconds);
    expect(runTimeoutSeconds).toBeGreaterThan(0);
    // The Java test server caps its default workflow run at ten years, then
    // clamps activity timeouts to that run timeout. Native Chat requests 100
    // years; verify the persisted server contract rather than assuming it keeps
    // the requested value unchanged. See validateScheduleActivityTask:
    // https://github.com/temporalio/sdk-java/blob/master/temporal-test-server/src/main/java/io/temporal/internal/testservice/TestWorkflowMutableStateImpl.java
    expect(Number(scheduled?.startToCloseTimeout?.seconds)).toBe(Math.min(timeoutSeconds, runTimeoutSeconds));
    if (providerId === "opencode") await recordWorkflowHistory(handle, "codex-app-server-turn");
  }, 30_000);

  it("returns a completed background action without recording a failure", async () => {
    const input = { actionId: "action:success", bridge: { roomId: "room:action", missionId: "mission:action" }, traceId: "trace:action" };
    const handle = await start("roomAgentActionWorkflow", input);
    await expect(handle.result()).resolves.toEqual({ status: "COMPLETED" });
    expect(activities.runRoomAgentBackgroundAction).toHaveBeenCalledWith(input);
    expect(activities.failRoomAgentBackgroundAction).not.toHaveBeenCalled();
  }, 30_000);

  it("records the patched background failure path after all five attempts", async () => {
    activities.runRoomAgentBackgroundAction.mockRejectedValue(ApplicationFailure.retryable("synthetic failure", "SYNTHETIC"));
    const handle = await start("roomAgentActionWorkflow", { bridge: { roomId: "room:action", missionId: "mission:action" }, traceId: "trace:action" }, "space-room-action:action:synthetic");
    await expect(handle.result()).rejects.toMatchObject({
      name: "WorkflowFailedError", cause: { name: "ActivityFailure", cause: { type: "SYNTHETIC" } }
    });
    expect(activities.runRoomAgentBackgroundAction).toHaveBeenCalledTimes(5);
    expect(activities.failRoomAgentBackgroundAction).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room:action", missionId: "mission:action", actionId: "action:synthetic", cancelled: false
    }));
    await recordWorkflowHistory(handle, "room-agent-action-failure");
  }, 30_000);

  it("lets the real 30-second condition timeout expire before checking the goal again", async () => {
    activities.dotGoalStep.mockResolvedValueOnce({ state: "WAITING", runId: null, goalStatus: "ACTIVE" });
    const handle = await start("dotGoalWorkflow", { goalId: "goal:timeout" });
    await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETE" });
    expect(activities.dotGoalStep).toHaveBeenCalledTimes(2);
    const history = await handle.fetchHistory();
    const timers = history.events?.flatMap((event) => event.timerStartedEventAttributes ? [event.timerStartedEventAttributes] : []) ?? [];
    expect(timers).toHaveLength(1);
    expect(String(timers[0].startToFireTimeout?.seconds)).toBe("30");
    await recordWorkflowHistory(handle, "dot-goal-timeout");
  }, 30_000);

  it("retains a wake signal received during the step activity and avoids starting the waiting timer", async () => {
    const workflowId = `dot-wake-${randomUUID()}`;
    activities.dotGoalStep.mockImplementationOnce(async () => {
      await env.client.workflow.getHandle(workflowId).signal(DOT_GOAL_SIGNAL);
      return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
    });
    const handle = await start("dotGoalWorkflow", { goalId: "goal:wake" }, workflowId);
    await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETE" });
    const history = await handle.fetchHistory();
    expect(history.events?.some((event) => event.workflowExecutionSignaledEventAttributes)).toBe(true);
    expect(history.events?.some((event) => event.timerStartedEventAttributes)).toBe(false);
  }, 30_000);

  it("observes a running goal turn after the durable polling timer", async () => {
    activities.dotGoalStep.mockResolvedValueOnce({ state: "RUNNING", runId: "run:goal", goalStatus: "ACTIVE" });
    const handle = await start("dotGoalWorkflow", { goalId: "goal:observe" });
    await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETE" });
    expect(activities.dotGoalObserve).toHaveBeenCalledWith("goal:observe", "run:goal");
    const history = await handle.fetchHistory();
    expect(history.events?.some((event) => String(event.timerStartedEventAttributes?.startToFireTimeout?.seconds) === "15")).toBe(true);
  }, 30_000);

  it("continues an unfinished goal as a new execution after 300 real iterations", async () => {
    let steps = 0;
    activities.dotGoalStep.mockImplementation(async () => ++steps <= 300
      ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETE" });
    const handle = await start("dotGoalWorkflow", { goalId: "goal:continue" });
    await expect(handle.result()).resolves.toEqual({ goalStatus: "COMPLETE" });
    expect(steps).toBe(301);
    const firstRun = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
    const history = await firstRun.fetchHistory();
    const continuation = history.events?.find((event) => event.workflowExecutionContinuedAsNewEventAttributes);
    expect(continuation).toBeDefined();
    const carried = continuation!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
    expect(defaultPayloadConverter.fromPayload(carried)).toEqual({ goalId: "goal:continue" });
    expect(history.events?.filter(event => event.timerStartedEventAttributes)).toHaveLength(300);
    expect(history.events?.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === "dotGoalStep")).toHaveLength(300);
    await expect(env.client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false })).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    await recordWorkflowHistory(firstRun, "dot-goal-continue-as-new");
  }, 60_000);
});
