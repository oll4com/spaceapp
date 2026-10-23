/**
 * dotGoalWorkflow on the real time-skipping test server (issue #60).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import { ActivityStubs, buildActivities } from "./activity-stubs.js";
import { createSandboxEnv, MAIN_TASK_QUEUE, type SandboxEnv } from "./sandbox.js";

const stubs = new ActivityStubs();
let env: SandboxEnv;

beforeAll(async () => {
  env = await createSandboxEnv();
  await env.startWorker(MAIN_TASK_QUEUE, buildActivities(stubs));
}, 120000);

beforeEach(() => stubs.reset());

afterAll(async () => {
  await env.teardown();
}, 60000);

function startDotGoal(workflowId: string, goalId: string) {
  return env.testEnv.client.workflow.start("dotGoalWorkflow", {
    taskQueue: MAIN_TASK_QUEUE,
    workflowId,
    args: [{ goalId }]
  });
}

describe("dotGoalWorkflow on the time-skipping test server", () => {
  it("returns the goal status when the first step reports DONE", async () => {
    stubs.override("dotGoalStep", () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }));

    const handle = await startDotGoal("dot-goal-test-done", "goal-0001");

    const result = await handle.result();
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    expect(stubs.count("dotGoalStep")).toBe(1);
    expect(stubs.count("dotGoalObserve")).toBe(0);
  }, 60000);

  it("keeps a wake-up that arrives during a step and ends the next wait at once", async () => {
    const steps = [
      { state: "WAITING", runId: null, goalStatus: "UNKNOWN" },
      { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    ];
    stubs.override("dotGoalStep", (_input, index) => steps[index]);

    const handle = await startDotGoal("dot-goal-test-wake", "goal-0002");
    // The signal handler is registered before the first step; wait for the
    // first step so the wake-up is guaranteed to land inside the wait.
    await stubs.waitForCall("dotGoalStep", 1);
    await handle.signal(DOT_GOAL_SIGNAL);

    const result = await handle.result();
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    expect(stubs.count("dotGoalStep")).toBe(2);
  }, 60000);

  it("waits for the full timeout when no wake-up arrives and steps again", async () => {
    const steps = [
      { state: "WAITING", runId: null, goalStatus: "UNKNOWN" },
      { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    ];
    stubs.override("dotGoalStep", (_input, index) => steps[index]);

    const handle = await startDotGoal("dot-goal-test-timeout", "goal-0003");

    const result = await handle.result();
    expect(result).toEqual({ goalStatus: "COMPLETED" });
    expect(stubs.count("dotGoalStep")).toBe(2);
  }, 60000);

  it("continues as a new run when the goal is still unfinished after the iteration budget", async () => {
    stubs.override("dotGoalStep", () => ({ state: "WAITING", runId: null, goalStatus: "UNKNOWN" }));

    const handle = await startDotGoal("dot-goal-test-continue-as-new", "goal-0004");
    const firstRunId = (await handle.describe()).runId;

    // Every WAITING step waits 30 seconds of server time and the iteration
    // budget is 300, so drive the clock forward until the workflow continues
    // as a new run. Waiting in real time would take hours; time is only
    // skipped automatically while a result is awaited.
    for (let i = 0; i < 320; i++) {
      await env.testEnv.sleep("30 seconds");
      if ((await handle.describe()).runId !== firstRunId) break;
    }
    expect(stubs.count("dotGoalStep")).toBeGreaterThanOrEqual(300);

    await handle.cancel();
    await expect(handle.result()).rejects.toThrow();
  }, 180000);
});
