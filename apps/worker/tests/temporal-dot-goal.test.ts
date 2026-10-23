import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import {
  ActivityFailure,
  ApplicationFailure,
  defaultPayloadConverter,
  WorkflowFailedError
} from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import type { dotGoalWorkflow } from "../src/workflows.js";
import { history, waitUntil, withSandbox } from "./support/temporal-sandbox.js";

const goalId = "dot_goal:sandbox-test";
const done = { state: "DONE", runId: null, goalStatus: "COMPLETED" };

describe("dotGoalWorkflow in the Temporal sandbox", () => {
  let environment: TestWorkflowEnvironment;

  beforeAll(async () => {
    environment = await TestWorkflowEnvironment.createTimeSkipping();
  }, 60_000);

  afterAll(async () => {
    await environment?.teardown();
  });

  // These cases catch a missing/wrong durable wait and accidental observation of
  // a paused or capacity-limited goal. Only the external API activities are fake.
  it.each([
    { state: "PAUSED", seconds: 3600, runId: null },
    { state: "WAITING", seconds: 30, runId: null },
    { state: "STARTED", seconds: 15, runId: "run:sandbox-1" }
  ])("waits $seconds seconds for $state before advancing", async ({ state, seconds, runId }) => {
    const stepGoals: string[] = [];
    const observations: Array<[string, string]> = [];
    await withSandbox({
      environment,
      activities: {
        async dotGoalStep(id: string) {
          stepGoals.push(id);
          return stepGoals.length === 1 ? { state, runId, goalStatus: "ACTIVE" } : done;
        },
        async dotGoalObserve(id: string, observedRunId: string) {
          observations.push([id, observedRunId]);
          return { run: "COMPLETED", goalStatus: "ACTIVE" };
        }
      }
    }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start<typeof dotGoalWorkflow>("dotGoalWorkflow", {
        workflowId: `dot-goal-timeout-${randomUUID()}`,
        taskQueue,
        args: [{ goalId }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(stepGoals).toEqual([goalId, goalId]);
      expect(observations).toEqual(runId ? [[goalId, runId]] : []);

      const events = (await history(handle)).events!;
      const timers = events.filter((event) => event.timerStartedEventAttributes);
      expect(timers).toHaveLength(1);
      expect(Number(timers[0]!.timerStartedEventAttributes!.startToFireTimeout!.seconds)).toBe(seconds);
      expect(events.filter((event) => event.timerFiredEventAttributes)).toHaveLength(1);
      if (state === "STARTED") await record(handle, "dot-goal");
    });
  }, 60_000);

  // A registered wake signal must cancel the outstanding timer, not merely be
  // accepted by the server while the workflow still waits the full hour.
  it("wakes a paused goal without waiting for its timer to fire", async () => {
    let steps = 0;
    await withSandbox({
      environment,
      activities: {
        async dotGoalStep() {
          return ++steps === 1 ? { state: "PAUSED", runId: null, goalStatus: "PAUSED" } : done;
        }
      }
    }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start<typeof dotGoalWorkflow>("dotGoalWorkflow", {
        workflowId: `dot-goal-wake-${randomUUID()}`,
        taskQueue,
        args: [{ goalId }]
      });
      await waitUntil(async () => (await history(handle)).events!.some((event) => event.timerStartedEventAttributes));
      await handle.signal(DOT_GOAL_SIGNAL);
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(steps).toBe(2);
      const events = (await history(handle)).events!;
      expect(events.filter((event) => event.workflowExecutionSignaledEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.timerCanceledEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.timerFiredEventAttributes)).toHaveLength(0);
    });
  }, 60_000);

  // Resetting woken before condition(), rather than after it, loses signals
  // delivered while dotGoalStep is awaiting its API response.
  it("retains an in-flight wake for the next wait and consumes it only once", async () => {
    let entered = false;
    let steps = 0;
    let release!: () => void;
    const activityGate = new Promise<void>((resolve) => { release = resolve; });
    await withSandbox({
      environment,
      activities: {
        async dotGoalStep() {
          steps += 1;
          if (steps > 2) return done;
          if (steps === 2) return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
          entered = true;
          await activityGate;
          return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
        }
      }
    }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start<typeof dotGoalWorkflow>("dotGoalWorkflow", {
        workflowId: `dot-goal-inflight-wake-${randomUUID()}`,
        taskQueue,
        args: [{ goalId }]
      });
      try {
        await waitUntil(() => entered);
        await handle.signal(DOT_GOAL_SIGNAL);
      } finally {
        release();
      }
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(steps).toBe(3);
      const events = (await history(handle)).events!;
      const signaled = events.findIndex((event) => event.workflowExecutionSignaledEventAttributes);
      const completed = events.findIndex((event) => event.activityTaskCompletedEventAttributes);
      expect(signaled).toBeGreaterThan(-1);
      expect(completed).toBeGreaterThan(signaled);
      const timers = events.filter((event) => event.timerStartedEventAttributes);
      expect(timers).toHaveLength(1);
      expect(Number(timers[0]!.timerStartedEventAttributes!.startToFireTimeout!.seconds)).toBe(30);
      expect(events.filter((event) => event.timerFiredEventAttributes)).toHaveLength(1);
    });
  }, 60_000);

  // Finishing the bounded loop must start another execution with the same goal;
  // returning UNKNOWN or dropping goalId would otherwise appear successful.
  it("continues an unfinished 300-step goal as a new run with the same input", async () => {
    const steps: Array<{ goalId: string; runId: string }> = [];
    await withSandbox({
      environment,
      activities: {
        async dotGoalStep(id: string) {
          steps.push({ goalId: id, runId: Context.current().info.workflowExecution!.runId });
          return steps.length <= 300 ? { state: "WAITING", runId: null, goalStatus: "ACTIVE" } : done;
        }
      }
    }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start<typeof dotGoalWorkflow>("dotGoalWorkflow", {
        workflowId: `dot-goal-continue-${randomUUID()}`,
        taskQueue,
        args: [{ goalId }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(steps).toHaveLength(301);
      expect(new Set(steps.map((step) => step.goalId))).toEqual(new Set([goalId]));
      expect(new Set(steps.slice(0, 300).map((step) => step.runId))).toEqual(new Set([handle.firstExecutionRunId]));
      expect(steps[300]!.runId).not.toBe(handle.firstExecutionRunId);

      const firstRun = client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      const firstEvents = (await history(firstRun)).events!;
      expect(firstEvents.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(300);
      expect(firstEvents.filter((event) => event.timerFiredEventAttributes)).toHaveLength(300);
      const continued = firstEvents.find((event) => event.workflowExecutionContinuedAsNewEventAttributes)
        ?.workflowExecutionContinuedAsNewEventAttributes;
      expect(continued?.newExecutionRunId).toBe(steps[300]!.runId);
      expect(defaultPayloadConverter.fromPayload(continued!.input!.payloads![0]!)).toEqual({ goalId });

      const nextRun = client.workflow.getHandle(handle.workflowId, continued!.newExecutionRunId!);
      const nextEvents = (await history(nextRun)).events!;
      const started = nextEvents.find((event) => event.workflowExecutionStartedEventAttributes)
        ?.workflowExecutionStartedEventAttributes;
      expect(defaultPayloadConverter.fromPayload(started!.input!.payloads![0]!)).toEqual({ goalId });
      expect(nextEvents.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(1);
      expect(nextEvents.filter((event) => event.workflowExecutionCompletedEventAttributes)).toHaveLength(1);
    });
  }, 60_000);

  // Removing retries from the goal proxy would fail the workflow before the
  // transient API outage clears; the real server schedules these attempts.
  it("retries a transient activity failure and returns the completed goal", async () => {
    const attempts: number[] = [];
    await withSandbox({
      environment,
      activities: {
        async dotGoalStep() {
          const attempt = Context.current().info.attempt;
          attempts.push(attempt);
          if (attempt < 3) throw ApplicationFailure.create({ message: "Temporary API outage", type: "GoalApiUnavailable" });
          return done;
        }
      }
    }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start<typeof dotGoalWorkflow>("dotGoalWorkflow", {
        workflowId: `dot-goal-retry-${randomUUID()}`,
        taskQueue,
        args: [{ goalId }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(attempts).toEqual([1, 2, 3]);
      const events = (await history(handle)).events!;
      expect(events.filter((event) => event.activityTaskScheduledEventAttributes)).toHaveLength(1);
      expect(events.find((event) => event.activityTaskStartedEventAttributes)?.activityTaskStartedEventAttributes?.attempt).toBe(3);
      expect(events.filter((event) => event.workflowExecutionFailedEventAttributes)).toHaveLength(0);
    });
  }, 60_000);

  it("fails the workflow when its activity exhausts the retry budget", async () => {
    const attempts: number[] = [];
    await withSandbox({
      environment,
      activities: {
        async dotGoalStep() {
          attempts.push(Context.current().info.attempt);
          throw ApplicationFailure.create({ message: "Persistent API outage", type: "GoalApiUnavailable" });
        }
      }
    }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start<typeof dotGoalWorkflow>("dotGoalWorkflow", {
        workflowId: `dot-goal-failure-${randomUUID()}`,
        taskQueue,
        args: [{ goalId }]
      });
      const failure = await handle.result().catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(WorkflowFailedError);
      const activityFailure = (failure as WorkflowFailedError).cause as ActivityFailure;
      expect(activityFailure).toBeInstanceOf(ActivityFailure);
      expect(activityFailure.retryState).toBe("MAXIMUM_ATTEMPTS_REACHED");
      expect(activityFailure.cause).toMatchObject({ type: "GoalApiUnavailable" });
      expect(attempts).toHaveLength(20);
      expect(attempts[0]).toBe(1);
      expect(attempts.at(-1)).toBe(20);
      const events = (await history(handle)).events!;
      expect(events.filter((event) => event.workflowExecutionFailedEventAttributes)).toHaveLength(1);
      expect(events.filter((event) => event.workflowExecutionCompletedEventAttributes)).toHaveLength(0);
    });
  }, 60_000);
});
