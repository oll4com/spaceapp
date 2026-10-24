import { Context } from "@temporalio/activity";
import type { WorkflowHandle } from "@temporalio/client";
import type { HistoryAndWorkflowId } from "@temporalio/common";
import { WorkflowClient, WorkflowContinuedAsNewError } from "@temporalio/client";
export { createTimeSkippingEnvironment, createSandboxWorker, stopSandboxWorker } from "./time-skipping-env.js";
export { WorkflowContinuedAsNewError };

type AnyRecord = Record<string, any>;

/** Records every activity call and serves canned or queued implementations. */
export class ActivityRecorder<T extends Record<string, unknown>> {
  readonly calls: Array<{ name: string; args: unknown[]; at: number }> = [];
  readonly queues = new Map<string, unknown[]>();
  impl: Record<string, any>;
  readonly acts: T;

  constructor(impl: Record<string, any>) {
    this.impl = impl;
    this.defaults = { ...impl };
    const recorder = this;
    const wrapped: Record<string, (...args: never[]) => unknown> = {};
    for (const name of Object.keys(impl)) {
      wrapped[name] = async (...args: never[]) => {
        recorder.calls.push({ name: name as string, args, at: Date.now() });
        const queue = recorder.queues.get(name);
        if (queue?.length) return queue.shift();
        const current = recorder.impl[name];
        if (current === undefined) return undefined;
        return typeof current === "function" ? (current as (...a: never[]) => unknown)(...args) : current;
      };
    }
    this.acts = wrapped as T;
  }

  /** Queue one-shot return values ahead of the default implementation. */
  queueOneShot(name: string, value: unknown): void {
    const q = this.queues.get(name) ?? [];
    q.push(value);
    this.queues.set(name, q);
  }

  count(name: string): number {
    return this.calls.filter((c) => c.name === name).length;
  }

  argsOf(name: string): unknown[][] {
    return this.calls.filter((c) => c.name === name).map((c) => c.args);
  }

  /** Resolve once `name` has been called at least `atLeast` times; throw on timeout. */
  async waitFor(name: string, atLeast: number, timeoutMs = 15_000): Promise<void> {
    const started = Date.now();
    while (this.count(name) < atLeast) {
      if (Date.now() - started > timeoutMs) {
        throw new Error(`waitFor: ${name} not called ${atLeast} time(s) within ${timeoutMs}ms (calls=${this.count(name)})`);
      }
      await sleep(25);
    }
  }

  /** Restore the constructor's default implementations (clears per-test overrides). */
  restoreDefaults(): void {
    for (const [key, value] of Object.entries(this.defaults)) {
      this.impl[key] = value;
    }
    this.calls.length = 0;
    this.queues.clear();
  }

  private readonly defaults: Record<string, any>;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * An activity body that heartbeats until cancelled, then rethrows the
 * cancellation. Heartbeating is required in Temporal for the worker to deliver
 * activity cancellation promptly instead of waiting for heartbeatTimeout and
 * leaving a zombie retry in flight (which locks time-skipping).
 */
export async function blockUntilCancelled(): Promise<never> {
  const ctx = Context.current();
  for (;;) {
    ctx.heartbeat();
    await Promise.race([
      ctx.cancelled.catch(() => undefined),
      sleep(40)
    ]);
    // If cancelled settled, awaiting it throws the CancelledFailure.
    let threw = false;
    await Promise.race([
      ctx.cancelled.then(
        () => { threw = true; },
        (err) => { throw err; }
      ),
      sleep(1)
    ]);
    if (threw) throw new Error("cancelled resolved without error");
  }
}

/**
 * Raw history events of the handle's FIRST run (or `runId` when given).
 * handle.fetchHistory() resolves the run id from the handle, which is empty on
 * a start() handle and follows to the latest run - wrong for a continue-as-new'd
 * first run.
 */
export async function historyEvents(handle: WorkflowHandle, runId?: string): Promise<AnyRecord[]> {
  const client = (handle as unknown as { client: AnyRecord }).client;
  const events: AnyRecord[] = [];
  let nextPageToken: unknown = undefined;
  for (;;) {
    const res = await client.workflowService.getWorkflowExecutionHistory({
      nextPageToken,
      namespace: client.options?.namespace ?? "default",
      execution: { workflowId: handle.workflowId, runId: runId ?? handle.firstExecutionRunId }
    });
    for (const e of (res.history?.events ?? []) as Array<AnyRecord & { toJSON?: () => AnyRecord }>) {
      events.push(typeof e.toJSON === "function" ? e.toJSON() : e);
    }
    nextPageToken = res.nextPageToken;
    if (nextPageToken == null || (nextPageToken as { length?: number }).length === 0) break;
  }
  return events;
}

function decodePayloadData(data: unknown): string {
  if (typeof data === "string") return Buffer.from(data, "base64").toString("utf8");
  return Buffer.from(data as Uint8Array).toString("utf8");
}

/**
 * The continue-as-new args of a run (they are the NEXT run's
 * WorkflowExecutionStarted input), plus the new run's id.
 */
export async function continueAsNewArgs(
  handle: WorkflowHandle
): Promise<{ args: Record<string, unknown>; nextRunId: string }> {
  const events = await historyEvents(handle);
  const continued = events.find((e) => e.workflowExecutionContinuedAsNewEventAttributes)
    ?.workflowExecutionContinuedAsNewEventAttributes;
  const nextRunId = String(continued?.newExecutionRunId ?? "");
  if (!nextRunId) throw new Error("no WorkflowExecutionContinuedAsNew event in run");
  const nextEvents = await historyEvents(handle, nextRunId);
  const started = nextEvents.find((e) => e.workflowExecutionStartedEventAttributes)
    ?.workflowExecutionStartedEventAttributes;
  const payloads = (started?.input?.payloads ?? []) as AnyRecord[];
  if (!payloads.length || payloads[0]?.data === undefined) throw new Error("no WorkflowExecutionStarted input payloads in the continued run");
  const args = JSON.parse(decodePayloadData(payloads[0].data)) as Record<string, unknown>;
  return { args, nextRunId };
}

/**
 * Cancel any active run in the workflow chain and wait for it to close cleanly
 * (using base WorkflowClient.prototype.result so cleanup never unlocks the
 * time-skipping clock mid-teardown).
 */
export async function cancelAndWait(handle: {
  workflowId?: string;
  cancel(): Promise<void>;
  terminate?(reason?: string): Promise<void>;
  result(): Promise<unknown>;
}): Promise<void> {
  // Let any activity that just satisfied waitFor finish its RespondActivityTaskCompleted
  // RPC and park the workflow on condition() before sending cancel (avoids ACTIVITY_UNKNOWN).
  await sleep(100);
  const wfClient = (handle as unknown as { client?: AnyRecord }).client;
  if (typeof wfClient?.getHandle === "function" && handle.workflowId) {
    const latest = wfClient.getHandle(handle.workflowId);
    await latest.cancel().catch(() => undefined);
    await WorkflowClient.prototype.result
      .call(wfClient, handle.workflowId, undefined, { followRuns: true })
      .catch(() => undefined);
    return;
  }
  await handle.cancel().catch(() => undefined);
  await handle.result().catch(() => undefined);
}

/** Assert a start() with followRuns:false ended in continue-as-new; return the new run's input. */
export async function expectContinueAsNew(
  handle: WorkflowHandle
): Promise<{ args: Record<string, unknown>; nextRunId: string }> {
  try {
    await handle.result();
  } catch (error) {
    if (!(error instanceof WorkflowContinuedAsNewError)) {
      throw new Error(`expected WorkflowContinuedAsNewError, got: ${(error as Error)?.constructor?.name}: ${(error as Error)?.message}`);
    }
    return continueAsNewArgs(handle);
  }
  throw new Error("expected WorkflowContinuedAsNewError, but the run completed");
}

export interface QueueItemParts {
  missionId: string;
  roomId: string;
  paneId: string;
  agentRunId: string;
  traceId: string;
  prompt?: string;
  roomAgentContinuation?: { sourceRunId: string; generation: number };
}

/** A roomAgentSupervisorQueueItem with schema-valid defaults (ids must be >= 8 chars). */
export function queueItem(parts: QueueItemParts): AnyRecord {
  return {
    missionId: parts.missionId,
    turn: {
      roomId: parts.roomId,
      paneId: parts.paneId,
      prompt: parts.prompt ?? "Run it.",
      artifactIds: [],
      agentRunId: parts.agentRunId,
      ...(parts.roomAgentContinuation ? { roomAgentContinuation: parts.roomAgentContinuation } : {}),
      permissionMode: null,
      collaborationMode: "default",
      traceId: parts.traceId
    }
  };
}

/** A completed TurnWorkflowResult with verified room-action evidence by default. */
export function turnResult(overrides: Record<string, unknown> = {}): AnyRecord {
  return {
    workflowId: "wf:turn",
    roomId: "room:test",
    paneId: "pane:test",
    traceId: "trace-run-1",
    status: "COMPLETED",
    message: "Completed.",
    roomAgentOutcome: {
      status: "VERIFIED",
      pendingActionIds: [],
      executedActionCount: 1,
      statusReason: "Completed."
    },
    ...overrides
  };
}

export interface FixtureRef extends HistoryAndWorkflowId {}
