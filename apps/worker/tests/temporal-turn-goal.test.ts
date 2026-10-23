import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Context, type UntypedActivities } from "@temporalio/activity";
import { WorkflowFailedError, type WorkflowHandle } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import type { DummyTurnInput, DummyTurnResult } from "@space/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { recordWorkflowHistory } from "./support/record-workflow-history.js";

const turn: DummyTurnInput = {
  roomId: "room:test-turn", paneId: "pane:test-turn", traceId: "trace:test-turn",
  prompt: "A synthetic turn; no provider is called", artifactIds: [],
  permissionMode: null, collaborationMode: "default"
};
const completed: DummyTurnResult = {
  workflowId: "workflow:test-turn", roomId: turn.roomId, paneId: turn.paneId,
  traceId: turn.traceId, status: "COMPLETED", message: "Synthetic activity completed"
};
const goalId = "dot_goal:temporal-tests";
const done = { state: "DONE", runId: null, goalStatus: "COMPLETED" };

// These tests intentionally use the production workflow module inside Temporal's
// sandbox. Only the activities (the database/provider boundary) are substituted.
describe.sequential("turn and Dot Goal workflows on the time-skipping server", () => {
  let env: TestWorkflowEnvironment;
  let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;

  beforeAll(async () => {
    workflowBundle = await bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("../src/workflows.ts", import.meta.url))
    });
    env = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => { await env?.teardown(); }, 30_000);

  async function withWorker(activities: UntypedActivities, body: (taskQueue: string) => Promise<void>) {
    const taskQueue = `turn-goal-${randomUUID()}`;
    const worker = await Worker.create({
      connection: env.nativeConnection, namespace: env.namespace,
      workflowBundle, taskQueue, activities
    });
    await worker.runUntil(() => body(taskQueue));
  }

  async function history(handle: WorkflowHandle) {
    return (await handle.fetchHistory()).events ?? [];
  }

  it("dummyTurn runs started before completed and retries transient failures of both activities", async () => {
    const calls: Array<{ activity: string; attempt: number; input: DummyTurnInput }> = [];
    await withWorker({
      async recordDummyTurnStarted(input: DummyTurnInput) {
        const attempt = Context.current().info.attempt;
        calls.push({ activity: "started", attempt, input });
        if (attempt === 1) throw new Error("transient start failure");
        return { workflowId: completed.workflowId };
      },
      async recordDummyTurnCompleted(input: DummyTurnInput) {
        const attempt = Context.current().info.attempt;
        calls.push({ activity: "completed", attempt, input });
        if (attempt === 1) throw new Error("transient completion failure");
        return completed;
      }
    }, async (taskQueue) => {
      const handle = await env.client.workflow.start("dummyTurnWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [turn]
      });
      expect(await handle.result()).toEqual(completed);
      expect(calls.map(({ activity, attempt }) => [activity, attempt])).toEqual([
        ["started", 1], ["started", 2], ["completed", 1], ["completed", 2]
      ]);
      expect(calls.every(({ input }) => JSON.stringify(input) === JSON.stringify(turn))).toBe(true);
      await recordWorkflowHistory("dummyTurnWorkflow", handle);
    });
  }, 30_000);

  it("dummyTurn fails after three attempts without recording a completion", async () => {
    const attempts: number[] = [];
    const recordDummyTurnCompleted = vi.fn(async () => completed);
    await withWorker({
      async recordDummyTurnStarted() {
        attempts.push(Context.current().info.attempt);
        throw new Error("persistent start failure");
      },
      recordDummyTurnCompleted
    }, async (taskQueue) => {
      const handle = await env.client.workflow.start("dummyTurnWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [turn]
      });
      const failure = await handle.result().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkflowFailedError);
      expect(failure).toMatchObject({ cause: { name: "ActivityFailure", cause: { message: "persistent start failure" } } });
      expect(attempts).toEqual([1, 2, 3]);
      expect(recordDummyTurnCompleted).not.toHaveBeenCalled();
    });
  }, 30_000);

  it.each([
    { label: "room agent", input: { ...turn, roomAgentMissionId: "mission:test" }, activity: "runCodexAppServerTurn", seconds: 86_400 },
    { label: "native Chat", input: { ...turn, agentSessionId: "session:test", agentAssistantMessageId: "message:test" }, activity: "runCodexAppServerTurn", seconds: 3_153_600_000 },
    { label: "OpenCode", input: { ...turn, providerId: "opencode" }, activity: "runOpenCodeAgentTurn", seconds: 2_400 },
    { label: "CLI", input: { ...turn, providerId: "cli:claude" }, activity: "runCliAgentTurn", seconds: 1_800 }
  ])("codexAppServerTurn routes $label to the expected activity with its timeout", async ({ label, input, activity, seconds }) => {
    const invoke = vi.fn(async () => completed);
    await withWorker({ [activity]: invoke }, async (taskQueue) => {
      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [input]
      });
      expect(await handle.result()).toEqual(completed);
      expect(invoke).toHaveBeenCalledExactlyOnceWith(input);
      const events = await history(handle);
      const scheduled = events.flatMap((event) =>
        event.activityTaskScheduledEventAttributes ? [event.activityTaskScheduledEventAttributes] : []);
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.activityType?.name).toBe(activity);
      // Java's test server normalizes activity timeouts to workflowRunTimeout,
      // including native Chat's 100-year requested duration. Assert the actual
      // history contract against that recorded limit, not a production claim.
      const runTimeout = Number(events[0]!.workflowExecutionStartedEventAttributes!.workflowRunTimeout?.seconds);
      expect(runTimeout).toBeGreaterThan(0);
      expect(Number(scheduled[0]!.startToCloseTimeout?.seconds)).toBe(Math.min(seconds, runTimeout));
      expect(Number(scheduled[0]!.heartbeatTimeout?.seconds)).toBe(15);
      expect(scheduled[0]!.retryPolicy?.maximumAttempts).toBe(label === "OpenCode" || label === "CLI" ? 1 : 5);
      if (label === "room agent") await recordWorkflowHistory("codexAppServerTurnWorkflow", handle);
    });
  }, 30_000);

  it("codexAppServerTurn retries a transient room-agent failure and then returns the activity result", async () => {
    const attempts: number[] = [];
    await withWorker({
      async runCodexAppServerTurn() {
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt < 3) throw new Error("provider temporarily unavailable");
        return completed;
      }
    }, async (taskQueue) => {
      expect(await env.client.workflow.execute("codexAppServerTurnWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [{ ...turn, roomAgentMissionId: "mission:test" }]
      })).toEqual(completed);
      expect(attempts).toEqual([1, 2, 3]);
    });
  }, 30_000);

  it.each([
    { providerId: undefined, activity: "runCodexAppServerTurn", maxAttempts: 5 },
    { providerId: "opencode", activity: "runOpenCodeAgentTurn", maxAttempts: 1 },
    { providerId: "cli:claude", activity: "runCliAgentTurn", maxAttempts: 1 }
  ])("codexAppServerTurn exposes $activity failure after $maxAttempts attempts", async ({ providerId, activity, maxAttempts }) => {
    const attempts: number[] = [];
    await withWorker({
      async [activity]() {
        attempts.push(Context.current().info.attempt);
        throw new Error("persistent synthetic provider failure");
      }
    }, async (taskQueue) => {
      const handle = await env.client.workflow.start("codexAppServerTurnWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [{ ...turn, providerId }]
      });
      const failure = await handle.result().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkflowFailedError);
      expect(failure).toMatchObject({ cause: { name: "ActivityFailure", cause: { message: "persistent synthetic provider failure" } } });
      expect(attempts).toEqual(Array.from({ length: maxAttempts }, (_, index) => index + 1));
    });
  }, 30_000);

  it.each([
    { state: "WAITING", runId: null, seconds: 30 },
    { state: "PAUSED", runId: null, seconds: 3_600 },
    { state: "STARTED", runId: "run:test", seconds: 15 }
  ])("dotGoal resumes after the $state durable timer", async ({ state, runId, seconds }) => {
    const dotGoalStep = vi.fn()
      .mockResolvedValueOnce({ state, runId, goalStatus: "ACTIVE" })
      .mockResolvedValueOnce(done);
    const dotGoalObserve = vi.fn(async () => ({ run: "COMPLETED", goalStatus: "ACTIVE" }));
    await withWorker({ dotGoalStep, dotGoalObserve }, async (taskQueue) => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [{ goalId }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const events = await history(handle);
      const timers = events.flatMap((event) => event.timerStartedEventAttributes ? [event.timerStartedEventAttributes] : []);
      expect(timers).toHaveLength(1);
      expect(Number(timers[0]!.startToFireTimeout?.seconds)).toBe(seconds);
      expect(events.filter((event) => event.timerFiredEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.timerCanceledEventAttributes)).toHaveLength(0);
      expect(dotGoalStep.mock.calls).toEqual([[goalId], [goalId]]);
      if (runId) expect(dotGoalObserve).toHaveBeenCalledExactlyOnceWith(goalId, runId);
      else expect(dotGoalObserve).not.toHaveBeenCalled();
      if (state === "STARTED") await recordWorkflowHistory("dotGoalWorkflow", handle);
    });
  }, 30_000);

  it("dotGoal wake signal cancels its pending hour timer", async () => {
    const dotGoalStep = vi.fn()
      .mockResolvedValueOnce({ state: "PAUSED", runId: null, goalStatus: "PAUSED" })
      .mockResolvedValueOnce(done);
    await withWorker({ dotGoalStep }, async (taskQueue) => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [{ goalId }]
      });
      // Do not await result yet: that unlocks automatic time skipping. Observe
      // the durable timer first, then deliver the signal while time is locked.
      await expect.poll(async () => (await history(handle)).some((event) => event.timerStartedEventAttributes), {
        timeout: 10_000, interval: 10
      }).toBe(true);
      await handle.signal("dotGoalWake");
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const events = await history(handle);
      expect(events.filter((event) => event.workflowExecutionSignaledEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.timerCanceledEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.timerFiredEventAttributes)).toHaveLength(0);
      expect(dotGoalStep.mock.calls).toEqual([[goalId], [goalId]]);
    });
  }, 30_000);

  it("dotGoal keeps a wake received during an activity until the next wait", async () => {
    let releaseActivity!: () => void;
    const release = new Promise<void>((resolve) => { releaseActivity = resolve; });
    let activityStarted!: () => void;
    const started = new Promise<void>((resolve) => { activityStarted = resolve; });
    let calls = 0;
    await withWorker({
      async dotGoalStep(input: string) {
        expect(input).toBe(goalId);
        if (++calls > 1) return done;
        activityStarted();
        await release;
        return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
      }
    }, async (taskQueue) => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [{ goalId }]
      });
      try {
        await started;
        await handle.signal("dotGoalWake");
      } finally {
        releaseActivity();
      }
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const events = await history(handle);
      expect(events.filter((event) => event.workflowExecutionSignaledEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.timerStartedEventAttributes)).toHaveLength(0);
      expect(calls).toBe(2);
    });
  }, 30_000);

  it("dotGoal continues an unfinished 300-step run as new and carries its goalId", async () => {
    const runs = new Map<string, string[]>();
    let firstRunId: string | undefined;
    await withWorker({
      async dotGoalStep(input: string) {
        const runId = Context.current().info.workflowExecution!.runId;
        firstRunId ??= runId;
        const inputs = runs.get(runId) ?? [];
        inputs.push(input);
        runs.set(runId, inputs);
        return runId === firstRunId
          ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
          : done;
      }
    }, async (taskQueue) => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", {
        workflowId: randomUUID(), taskQueue, args: [{ goalId }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(runs.size).toBe(2);
      expect(firstRunId).toBe(handle.firstExecutionRunId);
      expect(runs.get(firstRunId!)).toEqual(Array.from({ length: 300 }, () => goalId));
      const original = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const firstHistory = await history(original);
      const continued = firstHistory.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)
        ?.workflowExecutionContinuedAsNewEventAttributes;
      expect(continued).toBeDefined();
      expect(continued!.newExecutionRunId).not.toBe(firstRunId);
      expect(runs.get(continued!.newExecutionRunId!)).toEqual([goalId]);
      expect(defaultPayloadConverter.fromPayload(continued!.input!.payloads![0]!)).toEqual({ goalId });
      expect(firstHistory.filter((event) => event.timerFiredEventAttributes)).toHaveLength(300);
      const resumed = env.client.workflow.getHandle(handle.workflowId, continued!.newExecutionRunId!);
      const resumedHistory = await history(resumed);
      const started = resumedHistory[0]!.workflowExecutionStartedEventAttributes!;
      expect(started.continuedExecutionRunId).toBe(firstRunId);
      expect(defaultPayloadConverter.fromPayload(started.input!.payloads![0]!)).toEqual({ goalId });
      expect(resumedHistory.some((event) => event.workflowExecutionCompletedEventAttributes)).toBe(true);
    });
  }, 60_000);
});
