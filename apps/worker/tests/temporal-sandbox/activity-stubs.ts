/**
 * Configurable, recording activity stubs for the real time-skipping
 * tests. Activities run in-process with the worker, so the same
 * ActivityStubs instance is shared between the test process and the
 * activity implementations.
 */
import { Context } from "@temporalio/activity";
import { consolidationRun, dummyTurnResult, memoryMaintenanceResult, turnWorkflowResult } from "./stubs.js";

type Behavior = (input: any, callIndex: number) => unknown;

export class ActivityStubs {
  private readonly callsByKey = new Map<string, unknown[]>();
  private readonly overrides = new Map<string, Behavior>();

  reset(): void {
    this.callsByKey.clear();
    this.overrides.clear();
  }

  override(name: string, behavior: Behavior): void {
    this.overrides.set(name, behavior);
  }

  callsOf(name: string): any[] {
    return (this.callsByKey.get(name) ?? []) as any[];
  }

  count(name: string): number {
    return this.callsOf(name).length;
  }

  /** Wraps a default behavior into an activity implementation bound to this instance. */
  bind(name: string, defaults: Behavior): (input: any) => unknown {
    return async (input: any) => {
      const callIndex = this.count(name);
      const list = this.callsByKey.get(name) ?? [];
      list.push(input);
      this.callsByKey.set(name, list);
      const behavior = this.overrides.get(name) ?? defaults;
      return await behavior(input, callIndex);
    };
  }

  /** Waits (real time) until at least minCount calls of the activity were made. */
  async waitForCall(name: string, minCount = 1, timeoutMs = 20000): Promise<any[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const calls = this.callsOf(name);
      if (calls.length >= minCount) return calls;
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for " + minCount + " call(s) of activity " + name + " (seen " + calls.length + ")");
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

/** Never resolves; rejects when the enclosing activity is cancelled. */
export function blockUntilCancelled(): Promise<never> {
  // Cancellation is delivered through heartbeats on SDK 1.24, so keep
  // heartbeating while the activity waits for the workflow cancel request.
  const ctx = Context.current();
  const timer = setInterval(() => ctx.heartbeat(), 100);
  return ctx.cancelled.finally(() => clearInterval(timer));
}

/** A promise that stays pending until open() is called from the test. */
export function makeGate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Turn result with a verified room-agent outcome (used by supervisor children). */
function verifiedTurnResult(input: any) {
  return turnWorkflowResult(input, {
    roomAgentOutcome: {
      status: "VERIFIED",
      executedActionCount: 1,
      statusReason: "Synthetic room-agent turn verified."
    }
  });
}

/**
 * The full set of synthetic activity implementations for all workflows from
 * issue #60. Register the result on every task queue worker.
 */
export function buildActivities(stubs: ActivityStubs): Record<string, (input: any) => unknown> {
  return {
    // dotGoalWorkflow
    dotGoalStep: stubs.bind("dotGoalStep", () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" })),
    dotGoalObserve: stubs.bind("dotGoalObserve", () => ({ run: "IDLE", goalStatus: "COMPLETED" })),
    // dummyTurnWorkflow / codexAppServerTurnWorkflow
    recordDummyTurnStarted: stubs.bind("recordDummyTurnStarted", (input) => dummyTurnResult(input)),
    recordDummyTurnCompleted: stubs.bind("recordDummyTurnCompleted", (input) => dummyTurnResult(input)),
    runCodexAppServerTurn: stubs.bind("runCodexAppServerTurn", (input) => verifiedTurnResult(input)),
    runOpenCodeAgentTurn: stubs.bind("runOpenCodeAgentTurn", (input) => turnWorkflowResult(input)),
    runCliAgentTurn: stubs.bind("runCliAgentTurn", (input) => turnWorkflowResult(input)),
    // roomAgentSupervisorWorkflow (legacy + continuing branches)
    markRoomAgentMissionStarted: stubs.bind("markRoomAgentMissionStarted", () => null),
    markRoomAgentMissionFinished: stubs.bind("markRoomAgentMissionFinished", () => null),
    markRoomAgentMissionContinued: stubs.bind("markRoomAgentMissionContinued", () => null),
    settleRoomAgentBackgroundMission: stubs.bind("settleRoomAgentBackgroundMission", () => true),
    discardRoomAgentSupervisorTurn: stubs.bind("discardRoomAgentSupervisorTurn", () => null),
    finishRoomAgentSupervisorTurn: stubs.bind("finishRoomAgentSupervisorTurn", () => null),
    checkRoomAgentSupervisorTurn: stubs.bind("checkRoomAgentSupervisorTurn", () => "READY"),
    prepareRoomAgentBackgroundContinuation: stubs.bind("prepareRoomAgentBackgroundContinuation", () => ({ state: "WAITING" })),
    // roomAgentActionWorkflow
    runRoomAgentBackgroundAction: stubs.bind("runRoomAgentBackgroundAction", () => ({
      status: "EXECUTED",
      statusReason: "Synthetic background action executed.",
      paneId: null,
      missionId: null,
      evidence: {}
    })),
    failRoomAgentBackgroundAction: stubs.bind("failRoomAgentBackgroundAction", () => null),
    // memoryMaintenanceWorkflow / memoryConsolidationWorkflow / memoryMutationWorkflow
    createScheduledMemoryAudit: stubs.bind("createScheduledMemoryAudit", (input) => consolidationRun("run-" + input.traceId)),
    finalizeMemoryRepair: stubs.bind("finalizeMemoryRepair", (input) => consolidationRun(input.runId)),
    prepareMemoryConsolidation: stubs.bind("prepareMemoryConsolidation", (input) => ({
      run: consolidationRun(input.runId),
      changeSetId: "changeset-0001"
    })),
    reconcileStaleSpaceAgentSessions: stubs.bind("reconcileStaleSpaceAgentSessions", () => 0),
    refreshMemoryGraphSnapshot: stubs.bind("refreshMemoryGraphSnapshot", () => memoryMaintenanceResult()),
    refreshAllMonthsMemoryGraphSnapshot: stubs.bind("refreshAllMonthsMemoryGraphSnapshot", () =>
      memoryMaintenanceResult({ generatedAt: "2026-01-01T01:00:00.000Z" })
    ),
    executePersistedMemoryChangeSet: stubs.bind("executePersistedMemoryChangeSet", (input) => ({
      status: "APPLIED",
      changeSetId: input.changeSetId,
      resultingSourceHash: "0123456789abcdef".repeat(4),
      reason: null
    }))
  };
}
