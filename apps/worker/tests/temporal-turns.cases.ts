import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { DOT_GOAL_SIGNAL, type DummyTurnInput, type DummyTurnResult, type TurnWorkflowResult } from "@space/contracts";
import { describe, expect, it, vi } from "vitest";
import type * as activities from "../src/activities.js";
import { NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT } from "../src/turn-runtime-policy.js";
import { firstRunHistory, recordWorkflowHistory, withTemporalWorker } from "./support/temporal-sandbox.js";

type History = Awaited<ReturnType<typeof firstRunHistory>>;
type RoomActionInput = Parameters<typeof activities.runRoomAgentBackgroundAction>[0];

/** Builds a synthetic turn input, applying only the overrides needed by each case. */
function turn(overrides: Partial<DummyTurnInput> = {}): DummyTurnInput {
  return {
    roomId: "room:temporal-turn",
    paneId: "pane:temporal-turn",
    traceId: "trace:temporal-turn",
    prompt: "Synthetic sandbox turn; no provider is contacted.",
    artifactIds: [],
    permissionMode: null,
    collaborationMode: "default",
    ...overrides
  };
}

/** Returns a successful stub activity result with the input turn's room, pane and trace IDs. */
function completedTurn(input: DummyTurnInput): TurnWorkflowResult {
  return {
    workflowId: `workflow:synthetic:${input.traceId}`,
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status: "COMPLETED",
    message: "Synthetic activity completed."
  };
}

/** Finds a named activity's scheduling attributes and asserts that the history contains them. */
function activityScheduled(history: History, name: string) {
  const scheduled = history.events?.find((event) =>
    event.activityTaskScheduledEventAttributes?.activityType?.name === name
  )?.activityTaskScheduledEventAttributes;
  expect(scheduled, `history must schedule ${name}`).toBeDefined();
  return scheduled!;
}

/** Converts protobuf duration seconds to a number for assertions on recorded timeouts. */
function seconds(duration: { seconds?: unknown } | null | undefined): number {
  return Number(String(duration?.seconds ?? 0));
}

/** Bounds a host-side synchronization promise to ten seconds and always clears its timer. */
async function deadline<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), 10_000);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Decodes recorded marker payloads to find the patch ID exercised by a workflow case. */
function containsPatchMarker(history: History, patchId: string): boolean {
  return (history.events ?? []).some((event) => {
    const marker = event.markerRecordedEventAttributes;
    if (!marker) return false;
    return Object.values(marker.details ?? {}).some((value) =>
      (value.payloads ?? []).some((payload) =>
        payload.data && Buffer.from(payload.data).toString("utf8").includes(patchId)
      )
    );
  });
}

/** Registered by the single sandbox integration suite, which owns its server. */
export function registerTurnCases(): void {
  describe.sequential("real Temporal sandbox: goals and turns", () => {
    it("keeps a wake signal received during an activity and skips the following wait", async () => {
      let releaseStep!: () => void;
      let markStepEntered!: () => void;
      const stepGate = new Promise<void>((resolve) => { releaseStep = resolve; });
      const stepEntered = new Promise<void>((resolve) => { markStepEntered = resolve; });
      const goalId = "dot_goal:temporal-wake";
      let stepCount = 0;
      const dotGoalStep = vi.fn(async (receivedGoalId: string) => {
        expect(receivedGoalId).toBe(goalId);
        if (++stepCount === 1) {
          markStepEntered();
          await stepGate;
          return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
        }
        return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      });
      const dotGoalObserve = vi.fn();

      await withTemporalWorker({ dotGoalStep, dotGoalObserve }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("dotGoalWorkflow", {
          taskQueue, workflowId: `turn-goal-wake-${randomUUID()}`, args: [{ goalId }]
        });
        try {
          await deadline(stepEntered, "first goal activity");
          // The activity has not returned: the signal must survive until wait().
          await handle.signal(DOT_GOAL_SIGNAL);
          releaseStep();
          expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
          const history = await firstRunHistory(handle);
          expect(history.events?.some((event) =>
            event.workflowExecutionSignaledEventAttributes?.signalName === DOT_GOAL_SIGNAL
          )).toBe(true);
          expect(history.events?.filter((event) => event.timerStartedEventAttributes)).toHaveLength(0);
          expect(dotGoalStep).toHaveBeenCalledTimes(2);
          expect(dotGoalObserve).not.toHaveBeenCalled();
        } finally {
          releaseStep();
        }
      });
    }, 60_000);

    it("waits for the real 30-second timer when no wake arrives", async () => {
      let stepCount = 0;
      const dotGoalStep = vi.fn(async () => ++stepCount === 1
        ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" });
      const dotGoalObserve = vi.fn();
      await withTemporalWorker({ dotGoalStep, dotGoalObserve }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("dotGoalWorkflow", {
          taskQueue, workflowId: `turn-goal-timeout-${randomUUID()}`, args: [{ goalId: "dot_goal:temporal-timeout" }]
        });
        expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
        const history = await firstRunHistory(handle);
        const startedTimers = (history.events ?? []).flatMap((event) =>
          event.timerStartedEventAttributes ? [event.timerStartedEventAttributes] : []);
        expect(startedTimers).toHaveLength(1);
        expect(seconds(startedTimers[0]?.startToFireTimeout)).toBe(30);
        expect(history.events?.filter((event) => event.timerFiredEventAttributes)).toHaveLength(1);
        expect(dotGoalObserve).not.toHaveBeenCalled();
        await recordWorkflowHistory("dotGoalWorkflow", handle);
      });
    }, 60_000);

    it("continues an unfinished goal as a new execution after its actual iteration budget", async () => {
      const goalId = "dot_goal:temporal-continue";
      let stepCount = 0;
      const dotGoalStep = vi.fn(async (receivedGoalId: string) => {
        expect(receivedGoalId).toBe(goalId);
        return ++stepCount <= 300
          ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" }
          : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      });
      await withTemporalWorker({ dotGoalStep, dotGoalObserve: vi.fn() }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("dotGoalWorkflow", {
          taskQueue, workflowId: `turn-goal-continue-${randomUUID()}`, args: [{ goalId }]
        });
        // Observe the first execution's terminal event explicitly. followRuns
        // is a WorkflowClient.result option, not a WorkflowHandle.result option.
        await expect(client.workflow.result(handle.workflowId, handle.firstExecutionRunId, {
          followRuns: false
        })).rejects.toMatchObject({
          message: "Workflow execution continued as new",
          newExecutionRunId: expect.any(String)
        });
        const history = await firstRunHistory(handle);
        const continued = history.events?.find((event) =>
          event.workflowExecutionContinuedAsNewEventAttributes
        )?.workflowExecutionContinuedAsNewEventAttributes;
        expect(continued).toBeDefined();
        const payload = continued?.input?.payloads?.[0]?.data;
        expect(payload && JSON.parse(Buffer.from(payload).toString("utf8"))).toEqual({ goalId });
        if (!continued?.newExecutionRunId) throw new Error("Goal did not expose a continued execution run id");
        expect(await client.workflow.result(handle.workflowId, continued.newExecutionRunId)).toEqual({ goalStatus: "COMPLETED" });
        expect(dotGoalStep).toHaveBeenCalledTimes(301);
        const nextHistory = await client.workflow.getHandle(handle.workflowId, continued.newExecutionRunId).fetchHistory();
        expect(nextHistory.events?.some((event) => event.workflowExecutionCompletedEventAttributes)).toBe(true);
        // The canonical goal fixture covers the timeout branch. This larger
        // history is asserted live rather than committed as a redundant golden.
      });
    }, 60_000);

    it("retries a goal activity using its real retry policy before finishing", async () => {
      const attempts: number[] = [];
      await withTemporalWorker({
        dotGoalStep: async () => {
          const attempt = Context.current().info.attempt;
          attempts.push(attempt);
          if (attempt === 1) throw new Error("Synthetic temporary goal API failure");
          return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
        },
        dotGoalObserve: vi.fn()
      }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("dotGoalWorkflow", {
          taskQueue, workflowId: `turn-goal-retry-${randomUUID()}`, args: [{ goalId: "dot_goal:temporal-retry" }]
        });
        expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
        expect(attempts).toEqual([1, 2]);
        const scheduled = activityScheduled(await firstRunHistory(handle), "dotGoalStep");
        expect(scheduled.retryPolicy?.maximumAttempts).toBe(20);
        expect(seconds(scheduled.retryPolicy?.initialInterval)).toBe(5);
      });
    }, 60_000);

    it("retries dummy-turn start, then completes in the real activity order", async () => {
      const input = turn();
      const attempts: number[] = [];
      const calls: string[] = [];
      const result: DummyTurnResult = { ...completedTurn(input), status: "COMPLETED" };
      const recordDummyTurnCompleted = vi.fn(async (received: DummyTurnInput) => {
        calls.push("completed");
        expect(received).toEqual(input);
        return result;
      });
      await withTemporalWorker({
        recordDummyTurnStarted: async (received: DummyTurnInput) => {
          const attempt = Context.current().info.attempt;
          attempts.push(attempt);
          calls.push(`started:${attempt}`);
          expect(received).toEqual(input);
          if (attempt < 3) throw new Error("Synthetic temporary dummy start failure");
          return { workflowId: result.workflowId };
        },
        recordDummyTurnCompleted
      }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("dummyTurnWorkflow", {
          taskQueue, workflowId: `turn-dummy-retry-${randomUUID()}`, args: [input]
        });
        expect(await handle.result()).toEqual(result);
        expect(attempts).toEqual([1, 2, 3]);
        expect(calls).toEqual(["started:1", "started:2", "started:3", "completed"]);
        expect(recordDummyTurnCompleted).toHaveBeenCalledOnce();
        const scheduled = activityScheduled(await firstRunHistory(handle), "recordDummyTurnStarted");
        expect(scheduled.retryPolicy?.maximumAttempts).toBe(3);
        expect(seconds(scheduled.startToCloseTimeout)).toBe(60);
        await recordWorkflowHistory("dummyTurnWorkflow", handle);
      });
    }, 60_000);

    it("fails the dummy turn after completion retries are exhausted", async () => {
      const attempts: number[] = [];
      const recordDummyTurnStarted = vi.fn(async () => ({ workflowId: "workflow:synthetic-failed-dummy" }));
      await withTemporalWorker({
        recordDummyTurnStarted,
        recordDummyTurnCompleted: async () => {
          attempts.push(Context.current().info.attempt);
          throw new Error("Synthetic persistent dummy completion failure");
        }
      }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("dummyTurnWorkflow", {
          taskQueue, workflowId: `turn-dummy-failed-${randomUUID()}`, args: [turn()]
        });
        await expect(handle.result()).rejects.toMatchObject({ name: "WorkflowFailedError" });
        expect(attempts).toEqual([1, 2, 3]);
        expect(recordDummyTurnStarted).toHaveBeenCalledOnce();
        const history = await firstRunHistory(handle);
        expect(history.events?.some((event) => event.workflowExecutionFailedEventAttributes)).toBe(true);
      });
    }, 60_000);

    it.each([
      { branch: "room", overrides: { roomAgentMissionId: "mission:synthetic" }, activity: "runCodexAppServerTurn", timeout: 86_400, maximumAttempts: 5 },
      { branch: "native", overrides: { agentSessionId: "session:synthetic", agentAssistantMessageId: "message:synthetic" }, activity: "runCodexAppServerTurn", timeout: 3_153_600_000, maximumAttempts: 5 },
      { branch: "opencode", overrides: { providerId: "opencode" }, activity: "runOpenCodeAgentTurn", timeout: 2_400, maximumAttempts: 1 },
      { branch: "cli", overrides: { providerId: "cli:claude" }, activity: "runCliAgentTurn", timeout: 1_800, maximumAttempts: 1 }
    ])("dispatches the $branch turn with the production activity options", async ({ branch, overrides, activity, timeout, maximumAttempts }) => {
      const input = turn(overrides);
      const result = completedTurn(input);
      const runCodexAppServerTurn = vi.fn(async () => result);
      const runOpenCodeAgentTurn = vi.fn(async () => result);
      const runCliAgentTurn = vi.fn(async () => result);
      const stubs = { runCodexAppServerTurn, runOpenCodeAgentTurn, runCliAgentTurn };
      await withTemporalWorker(stubs, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("codexAppServerTurnWorkflow", {
          taskQueue, workflowId: `turn-codex-${branch}-${randomUUID()}`, args: [input]
        });
        expect(await handle.result()).toEqual(result);
        for (const [name, stub] of Object.entries(stubs)) {
          expect(stub).toHaveBeenCalledTimes(name === activity ? 1 : 0);
        }
        const scheduled = activityScheduled(await firstRunHistory(handle), activity);
        if (branch === "native") {
          // Production deliberately requests a 100-year horizon. The SDK
          // 1.24.0 time-skipping test server records a normalized 10-year
          // ceiling (315360000 seconds), observed in its genuine history.
          // Guard BOTH values: do not shorten the production policy to make
          // a test-server assertion pass, or accept an arbitrary short timeout.
          expect(NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT).toBe("36500 days");
          expect(timeout).toBe(36_500 * 86_400);
          expect(seconds(scheduled.startToCloseTimeout)).toBe(3_650 * 86_400);
        } else {
          expect(seconds(scheduled.startToCloseTimeout)).toBe(timeout);
        }
        expect(seconds(scheduled.heartbeatTimeout)).toBe(15);
        expect(scheduled.retryPolicy?.maximumAttempts).toBe(maximumAttempts);
        if (branch === "room") await recordWorkflowHistory("codexAppServerTurnWorkflow", handle);
      });
    }, 60_000);

    it("retries the Codex activity and returns its successful result", async () => {
      const input = turn({ roomAgentMissionId: "mission:synthetic-retry" });
      const result = completedTurn(input);
      const attempts: number[] = [];
      await withTemporalWorker({ runCodexAppServerTurn: async () => {
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt < 3) throw new Error("Synthetic transient Codex transport failure");
        return result;
      } }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("codexAppServerTurnWorkflow", {
          taskQueue, workflowId: `turn-codex-retry-${randomUUID()}`, args: [input]
        });
        expect(await handle.result()).toEqual(result);
        expect(attempts).toEqual([1, 2, 3]);
      });
    }, 60_000);

    it("propagates a Codex failure after all five attempts", async () => {
      const attempts: number[] = [];
      await withTemporalWorker({ runCodexAppServerTurn: async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("Synthetic exhausted Codex transport failure");
      } }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("codexAppServerTurnWorkflow", {
          taskQueue, workflowId: `turn-codex-failed-${randomUUID()}`, args: [turn()]
        });
        await expect(handle.result()).rejects.toMatchObject({ name: "WorkflowFailedError" });
        expect(attempts).toEqual([1, 2, 3, 4, 5]);
      });
    }, 60_000);

    it("returns a successful room action without running failure cleanup", async () => {
      const input = roomActionInput("action:explicit-success");
      const result = {
        id: "space-agent-room-action-bridge",
        results: [{
          request: input.bridge.actions[0], status: "EXECUTED", statusReason: "Synthetic action completed.",
          paneId: "pane:synthetic-target", missionId: input.bridge.missionId, evidence: {}
        }]
      };
      const failRoomAgentBackgroundAction = vi.fn();
      await withTemporalWorker({
        runRoomAgentBackgroundAction: vi.fn(async () => result),
        failRoomAgentBackgroundAction
      }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("roomAgentActionWorkflow", {
          taskQueue, workflowId: `space-room-action:action:success-${randomUUID()}`, args: [input]
        });
        expect(await handle.result()).toEqual(result);
        expect(failRoomAgentBackgroundAction).not.toHaveBeenCalled();
      });
    }, 60_000);

    it.each(["explicit", "workflow-id"])("records exhausted action failure using the %s action identity", async (identity) => {
      const attempts: number[] = [];
      const workflowId = `space-room-action:action:failure-${randomUUID()}`;
      const input = roomActionInput(identity === "explicit" ? "action:explicit-failure" : undefined);
      const failRoomAgentBackgroundAction = vi.fn(async () => undefined);
      await withTemporalWorker({
        runRoomAgentBackgroundAction: async () => {
          attempts.push(Context.current().info.attempt);
          throw new Error("Synthetic room-action transport failure");
        },
        failRoomAgentBackgroundAction
      }, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("roomAgentActionWorkflow", {
          taskQueue, workflowId, args: [input]
        });
        await expect(handle.result()).rejects.toMatchObject({ name: "WorkflowFailedError" });
        expect(attempts).toEqual([1, 2, 3, 4, 5]);
        expect(failRoomAgentBackgroundAction).toHaveBeenCalledExactlyOnceWith({
          roomId: input.bridge.roomId,
          missionId: input.bridge.missionId,
          actionId: identity === "explicit" ? input.actionId : workflowId.replace(/^space-room-action:/, ""),
          cancelled: false
        });
        const history = await firstRunHistory(handle);
        expect(containsPatchMarker(history, "room-background-action-failure-v1")).toBe(true);
        if (identity === "workflow-id") await recordWorkflowHistory("roomAgentActionWorkflow", handle);
      });
    }, 60_000);
  });
}

/** Builds a synthetic room-action bridge, supplying an explicit action ID only when requested. */
function roomActionInput(actionId?: string): RoomActionInput {
  return {
    ...(actionId ? { actionId } : {}),
    traceId: "trace:temporal-action",
    bridge: {
      roomId: "room:temporal-action",
      missionId: "mission:temporal-action",
      agentPaneId: "pane:temporal-action",
      agentSessionId: "session:temporal-action",
      selectedToolIds: ["room:start"],
      actions: [{ toolId: "room:start", action: { type: "start", paneId: "pane:synthetic-target" } }]
    }
  };
}
