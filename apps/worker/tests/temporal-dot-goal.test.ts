/**
 * Sandbox tests for dotGoalWorkflow on a real time-skipping test server.
 *
 * The workflow code runs unmocked inside the Temporal workflow sandbox;
 * only the dotGoalStep/dotGoalObserve activities are stubs. Time skipping
 * makes the 30s waits and the 300-iteration continue-as-new loop instant.
 */
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import {
  createTemporalTestEnv,
  testWorkflowsPath,
  TEST_MAIN_TASK_QUEUE,
  type TemporalTestEnv
} from "./support/temporal-test-env.js";
import { createWorkflowStubs, type WorkflowStubs } from "./support/workflow-stubs.js";

let tenv: TemporalTestEnv;
let stubs: WorkflowStubs;

beforeAll(async () => {
  stubs = createWorkflowStubs();
  tenv = await createTemporalTestEnv(testWorkflowsPath(), stubs.activities);
}, 240_000);

afterAll(async () => {
  await tenv.teardown();
}, 120_000);

beforeEach(() => {
  stubs.reset();
  stubs.clearCalls();
});

const waitingThenDone = (waitingCalls: number) => {
  let calls = 0;
  stubs.set("dotGoalStep", () => {
    calls += 1;
    return calls <= waitingCalls
      ? { state: "WAITING", runId: null, goalStatus: "UNKNOWN" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  });
};

// NOTE: the timeout test runs first on purpose. handle.result() unlocks time
// skipping internally, but the test server grants only one effective unlock:
// once a workflow execution closes, later unlocks stop taking effect. The
// 30s wait below needs skipping, so it must run before any workflow closes.
it("waits out the full 30s timeout when no signal arrives", async () => {
  waitingThenDone(1);
  const handle = await tenv.client.workflow.start("dotGoalWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId: "dot-goal-timeout-test",
    args: [{ goalId: "goal:timeout" }]
  });
  const result = await handle.result();
  expect(result).toEqual({ goalStatus: "COMPLETED" });
  // One WAITING step, one 30s (time-skipped) wait, then the DONE step.
  expect(stubs.callCount("dotGoalStep")).toBe(2);
}, 120_000);

it("wakes early on the dotGoalWake signal instead of waiting out the timeout", async () => {
  waitingThenDone(1);
  const handle = await tenv.client.workflow.start("dotGoalWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId: "dot-goal-wake-test",
    args: [{ goalId: "goal:wake" }]
  });
  // The signal is kept even if it lands during the step activity, and ends
  // the next 30s wait immediately.
  await handle.signal(DOT_GOAL_SIGNAL);
  const result = await handle.result();
  expect(result).toEqual({ goalStatus: "COMPLETED" });
  expect(stubs.callCount("dotGoalStep")).toBe(2);
}, 120_000);

it("continues as new after 300 WAITING iterations and finishes in the new run", async () => {
  waitingThenDone(300);
  const handle = await tenv.client.workflow.start("dotGoalWorkflow", {
    taskQueue: TEST_MAIN_TASK_QUEUE,
    workflowId: "dot-goal-continue-as-new-test",
    args: [{ goalId: "goal:long" }]
  });
  const result = await handle.result();
  expect(result).toEqual({ goalStatus: "COMPLETED" });
  // 300 WAITING steps in the first run, then the DONE step in the continued run.
  expect(stubs.callCount("dotGoalStep")).toBe(301);
}, 240_000);
