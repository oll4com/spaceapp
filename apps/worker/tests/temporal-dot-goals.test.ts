import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultPayloadConverter } from "@temporalio/common";
import { DOT_GOAL_SIGNAL } from "@space/contracts";
import { Sandbox, deferred } from "./support/temporal-sandbox.js";

let sandbox: Sandbox;
beforeAll(async () => { sandbox = await Sandbox.create(); }, 60_000);
afterAll(async () => { await sandbox?.close(); });

it("keeps a wake signal received during a paused step and avoids the one-hour timer", async () => {
  const entered = deferred();
  const release = deferred();
  const steps: string[] = [];
  await sandbox.run({
    dotGoalStep: async (goalId) => {
      steps.push(goalId);
      if (steps.length === 1) {
        entered.resolve();
        await release.promise;
        return { state: "PAUSED", runId: null, goalStatus: "PAUSED" };
      }
      return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    }
  }, async () => {
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:wake" });
    await entered.promise;
    await handle.signal(DOT_GOAL_SIGNAL);
    release.resolve();
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const history = await handle.fetchHistory();
    expect(history.events!.filter(event => event.workflowExecutionSignaledEventAttributes)).toHaveLength(1);
    expect(history.events!.filter(event => event.timerStartedEventAttributes)).toHaveLength(0);
    expect(steps).toEqual(["goal:wake", "goal:wake"]);
  });
}, 30_000);

it("uses a durable thirty-second timeout when waiting without a signal", async () => {
  let calls = 0;
  await sandbox.run({
    dotGoalStep: () => ++calls === 1
      ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" }
  }, async () => {
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:timeout" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const timers = (await handle.fetchHistory()).events!.flatMap(event => event.timerStartedEventAttributes ?? []);
    expect(timers).toHaveLength(1);
    expect(Number(timers[0]!.startToFireTimeout!.seconds)).toBe(30);
    expect(calls).toBe(2);
  });
}, 30_000);

it("observes running turns and continues an unfinished goal as a new run", async () => {
  let steps = 0;
  let observations = 0;
  await sandbox.run({
    dotGoalStep: (goalId) => {
      expect(goalId).toBe("goal:unfinished");
      steps++;
      return steps <= 300
        ? { state: "RUNNING", runId: "run:synthetic", goalStatus: "RUNNING" }
        : { state: "DONE", runId: null, goalStatus: "COMPLETED" };
    },
    dotGoalObserve: (goalId, runId) => {
      expect([goalId, runId]).toEqual(["goal:unfinished", "run:synthetic"]);
      observations++;
      return { run: "COMPLETED", goalStatus: "RUNNING" };
    }
  }, async () => {
    const handle = await sandbox.start("dotGoalWorkflow", { goalId: "goal:unfinished" });
    expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
    const history = await handle.fetchHistory();
    const event = history.events!.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
    expect(event, "unfinished goal must continue, rather than report UNKNOWN").toBeDefined();
    const carried = event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!;
    expect(defaultPayloadConverter.fromPayload(carried)).toEqual({ goalId: "goal:unfinished" });
    expect(steps).toBe(301);
    expect(observations).toBe(300);
    // Either the history-size guard or the 300-iteration guard can cause the first CAN.
    const firstRunTimers = history.events!.filter(event => event.timerFiredEventAttributes).length;
    expect(firstRunTimers).toBeGreaterThan(0);
    expect(firstRunTimers).toBeLessThanOrEqual(300);
  });
}, 60_000);
