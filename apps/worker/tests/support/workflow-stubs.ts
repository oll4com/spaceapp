/**
 * Stub activity factory for Temporal sandbox workflow tests.
 *
 * Every activity the workflows under test can call gets a deterministic stub
 * implementation. Stubs record every call (name + args), return
 * contract-shaped values, and can be overridden per test. No network, no DB,
 * no AI: the workflow code itself runs unmocked inside the real Temporal
 * workflow sandbox.
 *
 * For supervisor tests that need the real store-backed logic, pass
 * `{ supervisorStore }`: the settle/check/discard/finish/prepare activities
 * then delegate to the real lib functions in room-background-continuation.ts
 * (the same pattern as the mocked room-supervisor-continuation.test.ts, but
 * executed as real Temporal activities).
 */
import { CancelledFailure, Context } from "@temporalio/activity";
import type { InMemorySpaceStore } from "@space/runtime";
import {
  discardSupervisorTurn,
  finishSupervisorTurn,
  prepareBackgroundContinuation,
  supervisorTurnState
} from "../../src/room-background-continuation.js";

export interface Deferred<T = void> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/**
 * Waits on a gate promise but rejects with CancelledFailure as soon as the
 * enclosing activity is cancelled. Lets tests hold an activity open and then
 * drive cancellation paths (stop signal -> INTERRUPTED).
 */
export async function cancellableGate(gate: Promise<unknown>): Promise<void> {
  await Promise.race([
    gate,
    Context.current().cancelled.then(() => {
      throw new CancelledFailure("Cancelled by test");
    })
  ]);
}

function turnResult(input: { roomId: string; paneId: string; traceId: string }, status: "COMPLETED" | "FAILED" | "CANCELLED") {
  return {
    workflowId: `turn:${input.traceId}`,
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status,
    message: `stub ${status}`
  };
}

function maintenanceResult(sourceHash = "b".repeat(64)) {
  return {
    status: "REFRESHED" as const,
    generatedAt: new Date().toISOString(),
    sourceHash,
    previousSourceHash: null,
    summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 },
    durationMs: 1
  };
}

function consolidationRun(overrides: { id: string; workflowId?: string; sourceHash?: string | null }) {
  const now = new Date().toISOString();
  return {
    id: overrides.id,
    mode: "AUDIT" as const,
    triggerKind: "SCHEDULED" as const,
    status: "RUNNING" as const,
    workflowId: overrides.workflowId ?? `space-memory-consolidation:${overrides.id}`,
    dedupeKey: `dedupe-${overrides.id}`,
    sourceHash: overrides.sourceHash ?? null,
    actorUserId: null,
    progressCompleted: 0,
    progressTotal: 0,
    findingCount: 0,
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: null,
    createdAt: now,
    startedAt: null,
    completedAt: null,
    updatedAt: now
  };
}

export interface WorkflowStubs {
  /** Activity map passed straight to the test Workers. */
  activities: Record<string, (...args: any[]) => unknown>;
  /** Recorded calls per activity name. */
  calls: Map<string, any[][]>;
  /** Override one activity's implementation for a test. */
  set: (name: string, fn: (...args: any[]) => unknown) => void;
  /** Clear all per-test overrides, restoring default behaviors. */
  reset: () => void;
  /** Clear recorded calls (call this in beforeEach for per-test isolation). */
  clearCalls: () => void;
  callCount: (name: string) => number;
  lastCall: (name: string) => any[] | undefined;
  /** Real-time poll until an activity has been called at least n times. */
  waitForCalls: (name: string, n: number, timeoutMs?: number) => Promise<void>;
  /**
   * Bind (or unbind) the InMemorySpaceStore behind the supervisor
   * store-backed activities (prepare/check/discard/finish). Lets each test
   * use a fresh fixture store while Workers are created once per file.
   */
  setSupervisorStore: (store: InMemorySpaceStore | undefined) => void;
}

export interface CreateWorkflowStubsOptions {
  /**
   * When set, the supervisor store-backed activities
   * (prepare/check/discard/finish) delegate to the real lib functions bound
   * to this InMemorySpaceStore.
   */
  supervisorStore?: InMemorySpaceStore;
}

export function createWorkflowStubs(options: CreateWorkflowStubsOptions = {}): WorkflowStubs {
  const calls = new Map<string, any[][]>();
  const behaviors = new Map<string, (...args: any[]) => unknown>();
  let supervisorStore = options.supervisorStore;

  const defaults: Record<string, (...args: any[]) => unknown> = {
    recordDummyTurnStarted: (input: { traceId: string }) => ({ workflowId: `dummy-turn:${input.traceId}` }),
    recordDummyTurnCompleted: (input: { roomId: string; paneId: string; traceId: string }) => ({
      workflowId: `dummy-turn:${input.traceId}`,
      roomId: input.roomId,
      paneId: input.paneId,
      traceId: input.traceId,
      status: "COMPLETED" as const,
      message: "Dummy Temporal turn completed (stub)."
    }),
    runOpenCodeAgentTurn: (input: { roomId: string; paneId: string; traceId: string }) => turnResult(input, "COMPLETED"),
    runCliAgentTurn: (input: { roomId: string; paneId: string; traceId: string }) => turnResult(input, "COMPLETED"),
    runCodexAppServerTurn: (input: { roomId: string; paneId: string; traceId: string }) => turnResult(input, "COMPLETED"),
    runRoomAgentBackgroundAction: () => ({ ok: true }),
    markRoomAgentMissionStarted: () => undefined,
    markRoomAgentMissionFinished: () => undefined,
    markRoomAgentMissionContinued: () => undefined,
    dotGoalStep: () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
    dotGoalObserve: () => ({ run: "COMPLETED", goalStatus: "COMPLETED" }),
    settleRoomAgentBackgroundMission: () => true,
    checkRoomAgentSupervisorTurn: (item: Parameters<typeof supervisorTurnState>[0]) =>
      supervisorStore ? supervisorTurnState(item, supervisorStore) : "READY",
    discardRoomAgentSupervisorTurn: (input: { item: Parameters<typeof discardSupervisorTurn>[0]; reason: string }) =>
      supervisorStore ? discardSupervisorTurn(input.item, input.reason, supervisorStore) : undefined,
    finishRoomAgentSupervisorTurn: (input: Parameters<typeof finishSupervisorTurn>[0]) =>
      supervisorStore ? finishSupervisorTurn(input, supervisorStore) : undefined,
    prepareRoomAgentBackgroundContinuation: (input: { roomId: string; missionId: string; continuationId: string }) =>
      supervisorStore ? prepareBackgroundContinuation(input, supervisorStore) : { state: "WAITING" as const },
    failRoomAgentBackgroundAction: () => undefined,
    createScheduledMemoryAudit: (input: { sourceHash: string }) =>
      consolidationRun({ id: "run:stub-audit", sourceHash: input.sourceHash }),
    finalizeMemoryRepair: (input: { runId: string }) => consolidationRun({ id: input.runId }),
    prepareMemoryConsolidation: (input: { runId: string }) => ({
      run: consolidationRun({ id: input.runId }),
      changeSetId: null
    }),
    reconcileStaleSpaceAgentSessions: () => 0,
    refreshMemoryGraphSnapshot: () => maintenanceResult(),
    refreshAllMonthsMemoryGraphSnapshot: () => maintenanceResult(),
    executePersistedMemoryChangeSet: (input: { changeSetId: string }) => ({
      status: "APPLIED" as const,
      changeSetId: input.changeSetId,
      resultingSourceHash: "a".repeat(64),
      reason: null
    })
  };

  const activities: Record<string, (...args: any[]) => unknown> = {};
  for (const name of Object.keys(defaults)) {
    activities[name] = async (...args: any[]) => {
      const list = calls.get(name) ?? [];
      list.push(args);
      calls.set(name, list);
      const behavior = behaviors.get(name) ?? defaults[name]!;
      return behavior(...args);
    };
  }

  async function waitForCalls(name: string, n: number, timeoutMs = 30_000): Promise<void> {
    const startedAt = Date.now();
    for (;;) {
      if ((calls.get(name)?.length ?? 0) >= n) return;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(`Timed out waiting for ${n} calls to activity ${name} (got ${calls.get(name)?.length ?? 0}).`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  return {
    activities,
    calls,
    set: (name, fn) => {
      if (!(name in defaults)) throw new Error(`Unknown stub activity: ${name}`);
      behaviors.set(name, fn);
    },
    reset: () => behaviors.clear(),
    clearCalls: () => calls.clear(),
    setSupervisorStore: (store) => {
      supervisorStore = store;
    },
    callCount: (name) => calls.get(name)?.length ?? 0,
    lastCall: (name) => calls.get(name)?.at(-1),
    waitForCalls
  };
}
