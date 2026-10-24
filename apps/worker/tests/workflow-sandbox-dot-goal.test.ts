import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import {
  ActivityRecorder,
  createTimeSkippingEnvironment,
  createSandboxWorker,
  expectContinueAsNew,
  historyEvents,
  stopSandboxWorker
} from "./support/workflow-sandbox-kit.js";

const QUEUE = "test-dot-goal";
const WORKFLOWS_PATH = new URL("../src/workflows.ts", import.meta.url).pathname;
const GOAL = "goal:test-1";

const step = (state: string, goalStatus: string, runId: string | null = null) => ({ state, runId, goalStatus });

describe("real sandbox: dotGoalWorkflow", () => {
  let env: TestWorkflowEnvironment;
  const rec = new ActivityRecorder({
    dotGoalStep: () => step("DONE", "COMPLETED"),
    dotGoalObserve: () => ({ run: "COMPLETED", goalStatus: "COMPLETED" })
  });

  let workerBundle: { worker: unknown; running: Promise<void> } | undefined;

  beforeAll(async () => {
    env = await createTimeSkippingEnvironment();
    workerBundle = await createSandboxWorker(env, { taskQueue: QUEUE, workflowsPath: WORKFLOWS_PATH, activities: rec.acts });
  }, 60_000);

  afterAll(async () => {
    await stopSandboxWorker(workerBundle as never);
    await env?.teardown();
  }, 40_000);

  afterEach(() => {
    rec.restoreDefaults();
  });

  it("a DONE step finishes the goal at once", async () => {
    const result = await env.client.workflow.execute("dotGoalWorkflow", {
      workflowId: "wf:test-goal-done", taskQueue: QUEUE, args: [{ goalId: GOAL }]
    });
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    expect(rec.count("dotGoalStep")).toBe(1);
    expect(rec.count("dotGoalObserve")).toBe(0);
  }, 30_000);

  it("wake-vs-timeout: a wake signal ends the PAUSED hour early (timer cancelled)", async () => {
    let calls = 0;
    rec.impl.dotGoalStep = () => {
      calls += 1;
      return calls === 1 ? step("PAUSED", "ACTIVE") : step("DONE", "COMPLETED");
    };
    const handle = await env.client.workflow.start("dotGoalWorkflow", {
      workflowId: "wf:test-goal-wake", taskQueue: QUEUE, args: [{ goalId: GOAL }], followRuns: false
    });
    await rec.waitFor("dotGoalStep", 1);
    await handle.signal("dotGoalWake");
    const result = await handle.result();
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    const events = await historyEvents(handle);
    const cancelled = events.filter((e) => e.timerCanceledEventAttributes).length;
    const fired = events.filter((e) => e.timerFiredEventAttributes).length;
    expect(cancelled).toBeGreaterThan(0); // the 1-hour wait ended early
    expect(fired).toBe(0);
  }, 30_000);

  it("wake-vs-timeout: without a wake the PAUSED hour times out (timer fired)", async () => {
    let calls = 0;
    rec.impl.dotGoalStep = () => {
      calls += 1;
      return calls === 1 ? step("PAUSED", "ACTIVE") : step("DONE", "COMPLETED");
    };
    const handle = await env.client.workflow.start("dotGoalWorkflow", {
      workflowId: "wf:test-goal-timeout", taskQueue: QUEUE, args: [{ goalId: GOAL }], followRuns: false
    });
    const result = await handle.result(); // time-skipping advances past the 1-hour timer
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    const events = await historyEvents(handle);
    expect(events.filter((e) => e.timerFiredEventAttributes).length).toBeGreaterThan(0);
  }, 30_000);

  it("polls the running step until the run settles (15s observe loop)", async () => {
    let observes = 0;
    let steps = 0;
    rec.impl.dotGoalStep = () => {
      steps += 1;
      return steps === 1 ? step("RUNNING", "ACTIVE", "run:busy-1") : step("DONE", "COMPLETED");
    };
    rec.impl.dotGoalObserve = () => {
      observes += 1;
      return observes < 2 ? { run: "RUNNING", goalStatus: "ACTIVE" } : { run: "COMPLETED", goalStatus: "COMPLETED" };
    };
    const result = await env.client.workflow.execute("dotGoalWorkflow", {
      workflowId: "wf:test-goal-observe", taskQueue: QUEUE, args: [{ goalId: GOAL }]
    });
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    expect(observes).toBeGreaterThanOrEqual(2); // QUEUED/RUNNING keeps the 15s loop going
  }, 30_000);

  it("continues as new after the 300-iteration loop bound (history-bounded)", async () => {
    rec.impl.dotGoalStep = () => step("WAITING", "ACTIVE");
    const handle = await env.client.workflow.start("dotGoalWorkflow", {
      workflowId: "wf:test-goal-can", taskQueue: QUEUE, args: [{ goalId: GOAL }], followRuns: false
    });
    const { args } = await expectContinueAsNew(handle);
    expect(args.goalId).toBe(GOAL);
  }, 90_000);
});
